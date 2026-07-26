import moment, { type Moment } from 'moment';
import { type HTTPResponse, type Page } from 'puppeteer';
import { DOLLAR_CURRENCY, SHEKEL_CURRENCY } from '../constants';
import { getDebug } from '../helpers/debug';
import { clickButton, fillInput, pageEvalAll, waitUntilElementFound } from '../helpers/elements-interactions';
import { fetchGetWithinPage } from '../helpers/fetch';
import { getRawTransaction } from '../helpers/transactions';
import { generateTransactionUniqueId } from '../helpers/unique-id';
import { waitForNavigation } from '../helpers/navigation';
import {
  TransactionStatuses,
  TransactionTypes,
  type Transaction,
  type TransactionsAccount,
  type TransactionsForeignAccount,
} from '../transactions';
import { type InvestmentTransaction, type Investment, type Portfolio } from '../investments';
import { BaseScraperWithBrowser, LoginResults, type LoginOptions } from './base-scraper-with-browser';
import {
  type ForeignCurrencyAccountsScrapingResult,
  type PortfolioScrapingResult,
  type ScraperOptions,
  type ScraperScrapingResult,
} from './interface';

const debug = getDebug('leumi');
const BASE_URL = 'https://hb2.bankleumi.co.il';
const LOGIN_URL = 'https://www.leumi.co.il/he';
const TRANSACTIONS_URL = `${BASE_URL}/eBanking/SO/SPA.aspx#/ts/BusinessAccountTrx?WidgetPar=1`;
const FILTERED_TRANSACTIONS_URL = `${BASE_URL}/ChannelWCF/Broker.svc/ProcessRequest?moduleName=UC_SO_27_GetBusinessAccountTrx`;
const LEUMI_TRADING_URL = `${BASE_URL}/lti/lti-app/trade/portfolio`;
const LEUMI_TRADING_HISTORY_URL = `${BASE_URL}/lti/lti-app/trade/orders/history`;
const LEUMI_FOREIGN_TRANSACTIONS_URL = `${BASE_URL}/eBanking/ForeignCurrency/DisplayForeignAccountsActivity.aspx`;
const SAVINGS_URL = `${BASE_URL}/uiapiproxy/v1/digital-retails/mobile/accounts/1/Deposits?operationList=true`;

const DATE_FORMAT = 'DD.MM.YY';
const ACCOUNT_BLOCKED_MSG = 'המנוי חסום';
const INVALID_PASSWORD_MSG = 'אחד או יותר מפרטי ההזדהות שמסרת שגויים. ניתן לנסות שוב';
const CHANGE_PASSWORD_MODAL_SELECTOR = 'form input[name="newPwd"]';

interface SavingsDepositItem {
  index: string;
  depositId: string;
  depositIndex: number;
  depositSourceId: string;
  type: number;
  displayName: string;
  productName: string;
  friendlyAccountName: string;
  deepLink: string;
  isForeclosed: boolean;
  asOfDate: string;
  createDate: string;
  exitPointDate: string;
  currentBalance: number;
  initialAmount: number | null;
  installmentsSavingFlag: boolean;
  marginRate: string;
  productInterestType: string | null;
  productLinkageType: string | null;
  sourceSystem: string;
  depositNumber: string;
  relatedAccountNumber: string;
  withdrawalRequestText: string | null;
  WithdrawalAvailableFrequency: string | null;
  depositOperationsItems: any[];
}

interface SavingsAccountData {
  totalDepositsAndSavingsBalance: number;
  previousBusinessDayDate: string;
  depositsAndSavingsItems: SavingsDepositItem[];
  operationsItemsTotal: string;
  operationsListItems: any[];
}

function getPossibleLoginResults() {
  const urls: LoginOptions['possibleResults'] = {
    [LoginResults.Success]: [/ebanking\/SO\/SPA.aspx/i],
    [LoginResults.InvalidPassword]: [
      async options => {
        if (!options || !options.page) {
          throw new Error('missing page options argument');
        }
        const errorMessage = await pageEvalAll(options.page, 'svg#Capa_1', '', element => {
          return (element[0]?.parentElement?.children[1] as HTMLDivElement)?.innerText;
        });

        return errorMessage?.startsWith(INVALID_PASSWORD_MSG);
      },
    ],
    [LoginResults.AccountBlocked]: [
      // NOTICE - might not be relevant starting the Leumi re-design during 2022 Sep
      async options => {
        if (!options || !options.page) {
          throw new Error('missing page options argument');
        }
        const errorMessage = await pageEvalAll(options.page, '.errHeader', '', label => {
          return (label[0] as HTMLElement)?.innerText;
        });

        return errorMessage?.startsWith(ACCOUNT_BLOCKED_MSG);
      },
    ],
    [LoginResults.ChangePassword]: [
      async options => {
        if (!options || !options.page) {
          throw new Error('missing page options argument');
        }
        return !!(await options.page.$(CHANGE_PASSWORD_MODAL_SELECTOR));
      },
    ],
  };
  return urls;
}

function createLoginFields(credentials: ScraperSpecificCredentials) {
  return [
    { selector: 'input[placeholder="שם משתמש"]', value: credentials.username },
    { selector: 'input[placeholder="סיסמה"]', value: credentials.password },
  ];
}

function extractTransactionsFromPage(
  transactions: any[],
  status: TransactionStatuses,
  options?: ScraperOptions,
): Transaction[] {
  if (transactions === null || transactions.length === 0) {
    return [];
  }

  const result: Transaction[] = transactions.map(rawTransaction => {
    const date = moment(rawTransaction.DateUTC).milliseconds(0).toISOString();
    const newTransaction: Transaction = {
      status,
      type: TransactionTypes.Normal,
      date,
      processedDate: date,
      description: rawTransaction.Description || '',
      identifier: rawTransaction.ReferenceNumberLong,
      uniqueId: generateTransactionUniqueId(
        date,
        rawTransaction.Amount,
        rawTransaction.Description,
        rawTransaction.ReferenceNumberLong,
        rawTransaction.FITID,
        rawTransaction.RunningBalance,
        rawTransaction.AdditionalData,
      ),
      memo: rawTransaction.AdditionalData || '',
      bankFields: {
        FITID: rawTransaction.FITID,
        RunningBalance: rawTransaction.RunningBalance,
        ReferenceNumberLong: rawTransaction.ReferenceNumberLong,
        AdditionalData: rawTransaction.AdditionalData,
      },
      originalCurrency: SHEKEL_CURRENCY,
      chargedAmount: rawTransaction.Amount,
      originalAmount: rawTransaction.Amount,
    };

    if (options?.includeRawTransaction) {
      newTransaction.rawTransaction = getRawTransaction(rawTransaction);
    }

    return newTransaction;
  });

  return result;
}

function hangProcess(timeout: number) {
  return new Promise<void>(resolve => {
    setTimeout(() => {
      resolve();
    }, timeout);
  });
}

async function clickByXPath(page: Page, xpath: string): Promise<void> {
  await page.waitForSelector(xpath, { timeout: 30000, visible: true });
  const elm = await page.$$(xpath);
  await elm[0].click();
}

function removeSpecialCharacters(str: string): string {
  return str.replace(/[^0-9/-]/g, '');
}

async function fetchTransactionsForAccount(
  page: Page,
  startDate: Moment,
  accountId: string,
  options: ScraperOptions,
): Promise<TransactionsAccount> {
  // DEVELOPER NOTICE the account number received from the server is being altered at
  // runtime for some accounts after 1-2 seconds so we need to hang the process for a short while.
  await hangProcess(4000);

  await waitUntilElementFound(page, 'button[title="חיפוש מתקדם"]', true);
  await clickButton(page, 'button[title="חיפוש מתקדם"]');
  await waitUntilElementFound(page, 'bll-radio-button', true);
  await clickButton(page, 'bll-radio-button:not([checked])');

  await waitUntilElementFound(page, 'input[formcontrolname="txtInputFrom"]', true);

  await fillInput(page, 'input[formcontrolname="txtInputFrom"]', startDate.format(DATE_FORMAT));

  // we must blur the from control otherwise the search will use the previous value
  await page.focus("button[aria-label='סנן']");

  await clickButton(page, "button[aria-label='סנן']");
  const finalResponse = await page.waitForResponse(response => {
    return response.url() === FILTERED_TRANSACTIONS_URL && response.request().method() === 'POST';
  });

  const responseJson: any = await finalResponse.json();

  const accountNumber = accountId.replace('/', '_').replace(/[^\d-_]/g, '');

  const response = JSON.parse(responseJson.jsonResp);

  const pendingTransactions = response.TodayTransactionsItems;
  const transactions = response.HistoryTransactionsItems;
  const balance = response.BalanceDisplay ? parseFloat(response.BalanceDisplay) : undefined;

  const pendingTxns = extractTransactionsFromPage(pendingTransactions, TransactionStatuses.Pending, options);
  const completedTxns = extractTransactionsFromPage(transactions, TransactionStatuses.Completed, options);
  const txns = [...pendingTxns, ...completedTxns];

  return {
    accountNumber,
    balance,
    txns,
  };
}

async function fetchRegularAccounts(
  scraper: LeumiScraper,
  page: Page,
  startDate: Moment,
  options: ScraperOptions,
): Promise<TransactionsAccount[]> {
  await scraper.navigateTo(TRANSACTIONS_URL);
  return fetchTransactions(page, startDate, options);
}

async function getSavingsAccounts(page: Page, accountId: string): Promise<TransactionsAccount[]> {
  debug('========== FETCHING SAVINGS ACCOUNTS ==========');
  debug('Account: %s', accountId);

  const accounts: TransactionsAccount[] = [];

  try {
    debug('Trying savings URL: %s', SAVINGS_URL);

    const savingsData = await fetchGetWithinPage<SavingsAccountData>(page, SAVINGS_URL);
    if (!savingsData || !savingsData.depositsAndSavingsItems || savingsData.depositsAndSavingsItems.length === 0) {
      debug('No savings accounts found for account %s', accountId);
      return [];
    }
    debug('✓ Found %d savings deposits', savingsData.depositsAndSavingsItems.length);

    // Create a separate account for each individual deposit
    for (const deposit of savingsData.depositsAndSavingsItems) {
      const balance = deposit.currentBalance;
      const savingsAccountNumber = `${accountId}-${deposit.depositId}`;

      accounts.push({
        accountNumber: savingsAccountNumber,
        savingsAccount: true,
        balance,
        txns: [],
      });

      debug(
        'Added savings account %s with balance %s (product: %s)',
        savingsAccountNumber,
        balance,
        deposit.productName,
      );
    }
  } catch (error) {
    debug('  - Error fetching savings accounts: %s', error);
  }

  debug('Returning %d savings accounts', accounts.length);
  return accounts;
}

async function fetchTransactions(
  page: Page,
  startDate: Moment,
  options: ScraperOptions,
): Promise<TransactionsAccount[]> {
  const accounts: TransactionsAccount[] = [];

  // DEVELOPER NOTICE the account number received from the server is being altered at
  // runtime for some accounts after 1-2 seconds so we need to hang the process for a short while.
  await hangProcess(4000);

  const accountsIds = (await page.evaluate(() =>
    Array.from(document.querySelectorAll('app-masked-number-combo span.display-number-li'), e => e.textContent),
  )) as string[];

  // due to a bug, the altered value might include undesired signs like & that should be removed

  if (!accountsIds.length) {
    throw new Error('Failed to extract or parse the account number');
  }

  for (const accountId of accountsIds) {
    if (accountsIds.length > 1) {
      // get list of accounts and check accountId
      await clickByXPath(page, 'xpath///*[contains(@class, "number") and contains(@class, "combo-inner")]');
      await clickByXPath(page, `xpath///span[contains(text(), '${accountId}')]`);
    }

    accounts.push(await fetchTransactionsForAccount(page, startDate, removeSpecialCharacters(accountId), options));
  }

  return accounts;
}

async function fetchSavingsAccounts(
  page: Page,
  regularAccounts: TransactionsAccount[],
): Promise<TransactionsAccount[]> {
  const allSavingsAccounts: TransactionsAccount[] = [];
  const regularAccountCount = regularAccounts.length;

  for (let i = 0; i < regularAccountCount; i++) {
    try {
      const savingsAccounts = await getSavingsAccounts(page, regularAccounts[i].accountNumber);
      allSavingsAccounts.push(...savingsAccounts);
      debug('Added %d savings accounts to results', savingsAccounts.length);
    } catch (error) {
      debug('Error fetching savings accounts for %s: %s', regularAccounts[i].accountNumber, error);
    }
  }

  return allSavingsAccounts;
}

async function navigateToLogin(page: Page): Promise<void> {
  debug('navigating directly to login page');
  await page.goto('https://hb2.bankleumi.co.il/authenticate/logon');
  debug('waiting for page to be loaded (networkidle2)');
  await waitForNavigation(page, { waitUntil: 'networkidle2' });
  debug('waiting for components of login to enter credentials');
  await Promise.all([
    waitUntilElementFound(page, 'input[placeholder="שם משתמש"]', true),
    waitUntilElementFound(page, 'input[placeholder="סיסמה"]', true),
    waitUntilElementFound(page, 'button[type="submit"]', true),
  ]);
}

async function waitForPostLogin(page: Page): Promise<void> {
  await Promise.race([
    waitUntilElementFound(page, 'a[title="דלג לחשבון"]', true, 60000),
    waitUntilElementFound(page, 'div.main-content', false, 60000),
    page.waitForSelector(`xpath//div[contains(string(),"${INVALID_PASSWORD_MSG}")]`),
    waitUntilElementFound(page, CHANGE_PASSWORD_MODAL_SELECTOR, true, 60000),
  ]);
}

type ScraperSpecificCredentials = { username: string; password: string };

function extractPortfolios(response: HTTPResponse, portfolios: Portfolio[]) {
  response
    .json()
    .then(data => {
      debug('Portfolio data received:', data);

      const portfoliosData = data?.data.user?.Portfolios;
      debug('Portfolios:', portfoliosData);

      for (const item of portfoliosData) {
        const portfolio: Portfolio = {
          portfolioId: item.PortfolioId,
          portfolioName: item.PortfolioName,
          investments: [],
          transactions: [],
        };

        portfolios.push(portfolio);
      }
    })
    .catch(error => {
      debug('Error parsing response JSON:', error);
    });
}

function convertInvestmentCurrency(currencyCode: any): string {
  debug('Converting currency code:', currencyCode, 'type:', typeof currencyCode);

  if (currencyCode === 1 || currencyCode === 'NIS' || currencyCode === 'ILS') {
    return SHEKEL_CURRENCY;
  }

  // Default to shekel currency, but ensure we always return a valid string
  return SHEKEL_CURRENCY;
}

function extractPortfolioInvestments(response: HTTPResponse, investments: Investment[]) {
  response
    .json()
    .then(data => {
      debug('Investment data received:', data);

      const userStatement = data?.data.UserStatement?.DataSource;
      if (!userStatement) {
        debug('No user statement data found in response');
        return;
      }

      debug('User statement:', userStatement);
      for (const item of userStatement) {
        const investment: Investment = {
          paperId: item.PaperId,
          paperName: item.PaperName,
          symbol: item.Symbol,
          amount: parseFloat(item.Amount),
          value: parseFloat(item.Value),
          currency: convertInvestmentCurrency(item.CurrencyRate),
        };

        investments.push(investment);
      }
    })
    .catch(error => {
      debug('Error parsing response JSON:', error);
    });
}

function extractPortfolioTransactionsFromResponse(response: HTTPResponse, transactions: InvestmentTransaction[]) {
  response
    .json()
    .then(data => {
      debug('Portfolio data received:', data);

      const records = data?.data.GetOrdersHistory?.ordersHistory?.records;
      debug('User statement:', records);

      if (records && records.length > 0) {
        for (const item of records) {
          const transaction: InvestmentTransaction = {
            paperId: item.PaperId,
            paperName: item.PaperName,
            symbol: item.Symbol,
            amount: parseFloat(item.Amount),
            value: parseFloat(item.ExecutableTotal),
            currency: convertInvestmentCurrency(item.CurrencyCode),
            taxSum: parseFloat(item.TaxSum),
            executionDate: new Date(item.ExecutionDate),
            executablePrice: parseFloat(item.ExecutablePrice),
          };

          transactions.push(transaction);
        }
      }
    })
    .catch(error => {
      debug('Error parsing response JSON:', error);
    });
}

async function setStartingDateForPortfolioTransactions(page: Page, startDate: moment.Moment) {
  await page.waitForSelector('div.select-period-block', { visible: true });

  // Material UI dropdowns need to be clicked on the mat-select trigger, not the mat-form-field
  // Using evaluate to click directly on the element works better than XPath for Material UI
  await page.evaluate(() => {
    const formField = document.querySelector(
      'div.select-period-block mat-form-field[data-combo-id="periodSelectInline"]',
    );
    const matSelect = formField?.querySelector('mat-select');
    if (matSelect) {
      (matSelect as HTMLElement).click();
    }
  });

  await page.waitForSelector('div.mat-select-panel', { visible: true, timeout: 10000 });
  await clickByXPath(page, 'xpath///mat-option[last()]');

  const selectedPeriod = await page.$eval('div.select-period-block .mat-select-value', div =>
    (div as HTMLElement).innerText.trim(),
  );

  debug('waiting before entering dates for transactions history.');
  await hangProcess(1000);

  debug('Selected period:', selectedPeriod);
  if (selectedPeriod !== 'לפי תאריכים') {
    debug('Selected period is not "לפי תאריכים", selecting "לפי תאריכים" option to enter custom dates');
    await page.waitForSelector('div.select-period-block');
    await clickByXPath(page, 'xpath///div[contains(@class, "select-period-block")]');

    debug('Waiting for period options to be visible');
    await page.waitForSelector('div.mat-select-panel-wrap');
    await clickByXPath(page, 'xpath///mat-option[last()]');
  }

  debug('Waiting for date inputs to be visible');
  await page.waitForSelector('div#chooseByDatesBlock');
  await clickByXPath(page, 'xpath///div[@id="chooseByDatesBlock"]//input[@id="mat-input-0"]');

  debug('Waiting for calendar to be visible');
  await page.waitForSelector('mat-calendar');
  await clickByXPath(page, 'xpath///mat-calendar//button[contains(@class, "mat-calendar-period-button")]');

  const year = startDate.get('year');
  debug('selecting year:', year);
  await page.waitForSelector(`mat-calendar td[aria-label="${year}"]`);
  await clickByXPath(page, `xpath///mat-calendar//td[contains(@aria-label, "${year}")]`);

  const month = `01/${startDate.format('MM/YY')}`;
  debug('selecting month:', month);
  await page.waitForSelector(`mat-calendar td[aria-label="${month}"]`);
  await clickByXPath(page, `xpath///mat-calendar//td[contains(@aria-label, "${month}")]`);

  const day = startDate.format('DD/MM/YY');
  debug('selecting day:', day);
  await page.waitForSelector(`mat-calendar td[aria-label="${day}"]`);
  await clickByXPath(page, `xpath///mat-calendar//td[contains(@aria-label, "${day}")]`);
}

function mapCurrency(raw: string): string {
  if (raw === "דולר ארה''ב") {
    return DOLLAR_CURRENCY;
  }

  return SHEKEL_CURRENCY;
}

function cellTextToISODate(cellText: string): string {
  try {
    const parts = cellText.split('/');
    const day = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1; // Month is 0-indexed
    let year = parseInt(parts[2], 10);

    // Handle two-digit year (yy)
    // This assumes years like '25' are 2025 and '98' are 1998
    if (year < 100) {
      year += year > 70 ? 1900 : 2000;
    }

    const date = new Date(year, month, day);
    return date.toISOString();
  } catch (error) {
    debug('Error parsing date %s: %s', cellText, error);
    return '';
  }
}

function cellTextToNumber(cellText: string): number {
  return parseFloat(cellText?.replace(/,/g, '') || '0');
}

function getForeignTransactionAmount(debitCellText: string, creditCellText: string): number {
  const debit = cellTextToNumber(debitCellText);
  const credit = cellTextToNumber(creditCellText);

  if (credit > 0) {
    return credit;
  }

  return -debit;
}

function mapForeignTransaction(raw: any, currency: string): Transaction {
  const date = cellTextToISODate(raw[0]);
  const description = raw[1];
  const referenceNumber = raw[2];
  const amount = getForeignTransactionAmount(raw[3], raw[4]);
  const balance = cellTextToNumber(raw[5]);

  return {
    type: TransactionTypes.Normal,
    date: date,
    processedDate: date,
    identifier: referenceNumber,
    uniqueId: generateTransactionUniqueId(date, amount, description, referenceNumber, balance),
    bankFields: {
      referenceNumber,
      balance,
    },
    originalAmount: amount,
    chargedAmount: amount,
    description,
    originalCurrency: currency,
    status: TransactionStatuses.Completed,
  };
}

async function fetchForeignTransactionsForAccount(
  page: Page,
  startDate: Moment,
  account: any,
): Promise<TransactionsForeignAccount> {
  const currencyText = (await page.$eval('#lblCurrencyVal', node => (node as HTMLElement).innerText.trim())) || '';
  const currency = mapCurrency(currencyText);

  const balance =
    parseFloat(
      (await page.$eval('#lblOpeningBalanceVal', node => (node as HTMLElement).innerText.trim())).replace(
        /[^\d\.\-]/g,
        '',
      ),
    ) || 0;

  await page.select('#ddlAccounts_m_ddl', account.value);
  debug(`Selected foreign account: ${account.text}`);

  await page.select('#ddlTransactionPeriod', '3');
  debug('Selected transaction period: dates');

  await fillInput(page, '#dtFromDate_textBox', startDate.format(DATE_FORMAT));
  debug(`Filled from date: ${startDate.format(DATE_FORMAT)}`);

  await clickButton(page, '#btnDisplayDates');
  debug('Submitted date selection');

  try {
    await waitUntilElementFound(page, '#ctlActivityTable', true);
  } catch (error) {
    debug('No activity table found, checking for "no data error"');
    await waitUntilElementFound(page, '#NOINFORMATIONREGIONSERVERSIDEERROR', true);
    const warnMessage =
      (await page.$eval('#NOINFORMATIONREGIONSERVERSIDEERROR', node => (node as HTMLElement).innerText.trim())) || '';
    if (warnMessage.includes('לא קיימות תנועות מתאימות על פי הסינון שהוגדר')) {
      return {
        accountNumber: removeSpecialCharacters(account.text),
        balance: balance,
        currency: currency,
        txns: [],
      };
    }
  }
  await hangProcess(5000);

  const rows = await page.$$eval('#ctlActivityTable tr:not(.header)', trs =>
    Array.from(trs, tr => {
      const columns = tr.querySelectorAll('td');
      return Array.from(columns, column => column?.innerText.trim() || '');
    }),
  );

  return {
    accountNumber: removeSpecialCharacters(account.text),
    balance: balance,
    currency: currency,
    txns: rows.map(raw => mapForeignTransaction(raw, currency)),
  };
}

async function fetchForeignTransactions(page: Page, startDate: Moment): Promise<TransactionsForeignAccount[]> {
  const accounts: TransactionsForeignAccount[] = [];

  await page.goto(LEUMI_FOREIGN_TRANSACTIONS_URL, { waitUntil: 'networkidle2' });

  // DEVELOPER NOTICE the account number received from the server is being altered at
  // runtime for some accounts after 1-2 seconds so we need to hang the process for a short while.
  await hangProcess(4000);

  await waitUntilElementFound(page, '#ddlAccounts_m_ddl', true);
  // const accountIds = await page.evaluate(() =>
  //   Array.from(document.querySelectorAll('#ddlAccounts_m_ddl option'), e => ({ value: e.value, text: e.text })),
  // );

  const accountIds = await page.$$eval('#ddlAccounts_m_ddl option', options =>
    Array.from(options, option => ({ value: option.value, text: option.text })),
  );

  await hangProcess(6000);

  debug('Foreign accounts:', accountIds);

  await Promise.all(
    accountIds.map(async account => {
      accounts.push(await fetchForeignTransactionsForAccount(page, startDate, account));
    }),
  );

  debug('Foreign accounts fetched:', JSON.stringify(accounts, null, 2));

  return accounts;
}

async function fetchPortfolioTransactions(page: Page, startDate: Moment): Promise<InvestmentTransaction[]> {
  // Request interception is already enabled by fetchPortfoliosForTime,
  // so we don't need to enable it again here

  await setStartingDateForPortfolioTransactions(page, startDate);

  const transactions: InvestmentTransaction[] = [];

  const handleOrderHistoryResponse = (response: HTTPResponse) => {
    // You can filter responses based on criteria like URL, method, or resource type.
    // For XHR requests, check if the resource type is 'xhr' or 'fetch'.
    if (response.request().resourceType() !== 'xhr' && response.request().resourceType() !== 'fetch') {
      return;
    }

    if (response.url().includes('GetOrdersHistory')) {
      extractPortfolioTransactionsFromResponse(response, transactions);
      return;
    }
  };

  page.on('response', handleOrderHistoryResponse);

  debug('Submitting request to fetch portfolio transactions');
  await clickByXPath(page, 'xpath///div[@id="chooseByDatesBlock"]//button[contains(@class, "btn-primary")]');

  await hangProcess(5000); // Wait for the transactions to be fetched and processed

  page.off('response', handleOrderHistoryResponse);

  return transactions;
}

class LeumiScraper extends BaseScraperWithBrowser<ScraperSpecificCredentials> {
  doesSupportTransactions(): boolean {
    return true;
  }

  doesSupportPortfolios(): boolean {
    return true;
  }

  doesSupportForeignCurrencyAccounts(): boolean {
    return true;
  }

  private getStartMoment() {
    const minimumStartMoment = moment().subtract(3, 'years').add(1, 'day');
    const defaultStartMoment = moment().subtract(1, 'years').add(1, 'day');
    const startDate = this.options.startDate || defaultStartMoment.toDate();
    const startMoment = moment.max(minimumStartMoment, moment(startDate));
    return startMoment;
  }

  getLoginOptions(credentials: ScraperSpecificCredentials) {
    return {
      loginUrl: LOGIN_URL,
      fields: createLoginFields(credentials),
      submitButtonSelector: "button[type='submit']",
      checkReadiness: async () => navigateToLogin(this.page),
      postAction: async () => waitForPostLogin(this.page),
      possibleResults: getPossibleLoginResults(),
    };
  }

  async fetchPortfoliosForTime(startDate: Moment): Promise<Portfolio[]> {
    debug(
      'waiting 3 seconds before navigating to portfolio page to ensure all listeners are set up and any initial requests are captured',
    );
    await hangProcess(3000);

    const investments: Investment[] = [];
    const portfolios: Portfolio[] = [];

    debug('Listening for responses to extract portfolio and investment data');
    const handlePortfoliosPageResponse = (response: HTTPResponse) => {
      // You can filter responses based on criteria like URL, method, or resource type.
      // For XHR requests, check if the resource type is 'xhr' or 'fetch'.
      if (response.request().resourceType() !== 'xhr' && response.request().resourceType() !== 'fetch') {
        return;
      }

      if (response.url().includes('Statement')) {
        extractPortfolioInvestments(response, investments);
        return;
      }

      if (response.url().includes('lti-app/api/config')) {
        extractPortfolios(response, portfolios);
        return;
      }
    };

    this.page.on('response', handlePortfoliosPageResponse);

    debug(`Navigating to portfolio page: ${LEUMI_TRADING_URL}`);
    await this.navigateTo(LEUMI_TRADING_URL);

    await this.page.waitForSelector('.screener', { visible: true });
    await hangProcess(5000); // Wait for the investments data to load

    if (portfolios.length > 0) {
      portfolios[0].investments = investments;
      debug('Final portfolio with investments:', JSON.stringify(portfolios[0], null, 2));
    }

    this.page.off('response', handlePortfoliosPageResponse);
    // this.page.off('request', requestHandler);

    // await this.page.setRequestInterception(false);

    await this.navigateTo(LEUMI_TRADING_HISTORY_URL);

    if (portfolios.length > 0) {
      portfolios[0].transactions = await fetchPortfolioTransactions(this.page, startDate);
    }

    debug('Fetched portfolio transactions:', JSON.stringify(portfolios));

    return portfolios;
  }

  async fetchData(): Promise<ScraperScrapingResult> {
    const startMoment = this.getStartMoment();

    const accounts = await fetchRegularAccounts(this, this.page, startMoment, this.options);
    const savingsAccounts = await fetchSavingsAccounts(this.page, accounts);
    accounts.push(...savingsAccounts);

    return {
      success: true,
      accounts,
    };
  }

  async fetchPortfolios(): Promise<PortfolioScrapingResult> {
    const startMoment = this.getStartMoment();

    debug('Fetching portfolios with start date:', startMoment.format(DATE_FORMAT));

    const investments = await this.fetchPortfoliosForTime(startMoment);

    return {
      success: true,
      portfolios: investments,
    };
  }

  async fetchForeignCurrencyAccounts(): Promise<ForeignCurrencyAccountsScrapingResult> {
    const startMoment = this.getStartMoment();

    const foreignTransactions = await fetchForeignTransactions(this.page, startMoment);

    return {
      success: true,
      foreignCurrencyAccounts: foreignTransactions,
    };
  }
}

export default LeumiScraper;
