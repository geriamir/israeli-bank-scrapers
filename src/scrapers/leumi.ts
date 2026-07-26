import moment, { type Moment } from 'moment';
import { type Page } from 'puppeteer';
import { DOLLAR_CURRENCY, EURO_CURRENCY, SHEKEL_CURRENCY } from '../constants';
import { getDebug } from '../helpers/debug';
import { clickButton, fillInput, pageEvalAll, waitUntilElementFound } from '../helpers/elements-interactions';
import { fetchGetWithinPage } from '../helpers/fetch';
import { getRawTransaction } from '../helpers/transactions';
import { waitForNavigation } from '../helpers/navigation';
import { TransactionStatuses, TransactionTypes, type Transaction, type TransactionsAccount } from '../transactions';
import { BaseScraperWithBrowser, LoginResults, type LoginOptions } from './base-scraper-with-browser';
import { type ScraperOptions, type ScraperScrapingResult } from './interface';

const debug = getDebug('leumi');
const BASE_URL = 'https://hb2.bankleumi.co.il';
const LOGIN_URL = 'https://www.leumi.co.il/he';
const TRANSACTIONS_URL = `${BASE_URL}/eBanking/SO/SPA.aspx#/ts/BusinessAccountTrx?WidgetPar=1`;
const FILTERED_TRANSACTIONS_URL = `${BASE_URL}/ChannelWCF/Broker.svc/ProcessRequest?moduleName=UC_SO_27_GetBusinessAccountTrx`;
const SAVINGS_URL = `${BASE_URL}/uiapiproxy/v1/digital-retails/mobile/accounts/1/Deposits?operationList=true`;
const FOREIGN_CURRENCY_URL = `${BASE_URL}/eBanking/ForeignCurrency/DisplayForeignAccountsActivity.aspx`;

const FOREIGN_ACCOUNTS_SELECTOR = '#ddlAccounts_m_ddl';
const FOREIGN_PERIOD_SELECTOR = '#ddlTransactionPeriod';
const FOREIGN_FROM_DATE_SELECTOR = '#dtFromDate_textBox';
const FOREIGN_SUBMIT_SELECTOR = '#btnDisplayDates';
const FOREIGN_ACTIVITY_TABLE_SELECTOR = '#ctlActivityTable';
const FOREIGN_CURRENCY_LABEL_SELECTOR = '#lblCurrencyVal';
const FOREIGN_OPENING_BALANCE_SELECTOR = '#lblOpeningBalanceVal';
const FOREIGN_NO_DATA_SELECTOR = '#NOINFORMATIONREGIONSERVERSIDEERROR';

// value of the "by dates" option in the transaction period dropdown
const FOREIGN_PERIOD_BY_DATES = '3';
const FOREIGN_NO_DATA_MSG = 'לא קיימות תנועות מתאימות על פי הסינון שהוגדר';
const FOREIGN_DATE_FORMAT = 'DD/MM/YY';

// Both the activity table and the "no transactions" notice are waited on together, so once
// one of them is visible a second, very short wait is enough to tell which one it was.
const FOREIGN_SETTLED_TIMEOUT = 1000;

// column layout of the foreign currency activity table
const FOREIGN_COLUMN_DATE = 0;
const FOREIGN_COLUMN_DESCRIPTION = 1;
const FOREIGN_COLUMN_REFERENCE = 2;
const FOREIGN_COLUMN_DEBIT = 3;
const FOREIGN_COLUMN_CREDIT = 4;
const FOREIGN_COLUMN_BALANCE = 5;
const FOREIGN_COLUMN_COUNT = 6;

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
      memo: rawTransaction.AdditionalData || '',
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

const FOREIGN_CURRENCY_BY_LABEL: Record<string, string> = {
  דולר: DOLLAR_CURRENCY,
  'דולר ארהב': DOLLAR_CURRENCY,
  אירו: EURO_CURRENCY,
  יורו: EURO_CURRENCY,
  'לירה שטרלינג': 'GBP',
  'פרנק שוויצרי': 'CHF',
  'יין יפני': 'JPY',
  'דולר קנדי': 'CAD',
  'דולר אוסטרלי': 'AUD',
  'כתר שוודי': 'SEK',
  'כתר נורווגי': 'NOK',
  'כתר דני': 'DKK',
  רנד: 'ZAR',
  שקל: SHEKEL_CURRENCY,
  שח: SHEKEL_CURRENCY,
};

/**
 * Leumi renders the currency as a Hebrew label rather than an ISO code, and the exact
 * punctuation varies (for example `דולר ארה"ב` vs `דולר ארה''ב`), so quotes and
 * whitespace are stripped before matching.
 */
function mapForeignCurrency(label: string): string | undefined {
  const normalized = label
    .replace(/["'`׳״]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) {
    return undefined;
  }

  if (FOREIGN_CURRENCY_BY_LABEL[normalized]) {
    return FOREIGN_CURRENCY_BY_LABEL[normalized];
  }

  // Longest label first, otherwise `דולר קנדי` would match the `דולר` entry.
  const match = Object.keys(FOREIGN_CURRENCY_BY_LABEL)
    .sort((a, b) => b.length - a.length)
    .find(key => normalized.includes(key));
  return match ? FOREIGN_CURRENCY_BY_LABEL[match] : undefined;
}

function parseForeignAmount(cellText: string): number {
  const parsed = parseFloat((cellText || '').replace(/,/g, '').replace(/[^\d.-]/g, ''));
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * A row carries the amount in either the debit or the credit column, never both.
 */
function getForeignTransactionAmount(debitCellText: string, creditCellText: string): number {
  const credit = parseForeignAmount(creditCellText);
  if (credit > 0) {
    return credit;
  }

  return -parseForeignAmount(debitCellText);
}

function mapForeignTransaction(cells: string[], currency: string, options?: ScraperOptions): Transaction {
  const date = moment(cells[FOREIGN_COLUMN_DATE], FOREIGN_DATE_FORMAT).milliseconds(0).toISOString();
  const amount = getForeignTransactionAmount(cells[FOREIGN_COLUMN_DEBIT], cells[FOREIGN_COLUMN_CREDIT]);

  const transaction: Transaction = {
    type: TransactionTypes.Normal,
    identifier: cells[FOREIGN_COLUMN_REFERENCE] || undefined,
    date,
    processedDate: date,
    originalAmount: amount,
    originalCurrency: currency,
    chargedAmount: amount,
    chargedCurrency: currency,
    description: cells[FOREIGN_COLUMN_DESCRIPTION] || '',
    status: TransactionStatuses.Completed,
  };

  if (options?.includeRawTransaction) {
    transaction.rawTransaction = getRawTransaction(cells);
  }

  return transaction;
}

async function readTrimmedText(page: Page, selector: string): Promise<string> {
  try {
    return await page.$eval(selector, node => (node as HTMLElement).innerText.trim());
  } catch (error) {
    debug('could not read %s: %s', selector, error);
    return '';
  }
}

/**
 * Resolves to true when the activity table rendered, false when Leumi reported that the
 * account has no transactions in the requested range. Both outcomes render their own
 * element, so waiting on either avoids paying the full timeout for empty accounts.
 */
async function waitForForeignActivityTable(page: Page): Promise<boolean> {
  try {
    await waitUntilElementFound(page, `${FOREIGN_ACTIVITY_TABLE_SELECTOR}, ${FOREIGN_NO_DATA_SELECTOR}`, true);
    await waitUntilElementFound(page, FOREIGN_ACTIVITY_TABLE_SELECTOR, true, FOREIGN_SETTLED_TIMEOUT);
    return true;
  } catch (error) {
    debug('no activity table found, looking for the "no matching transactions" notice');
  }

  const message = await readTrimmedText(page, FOREIGN_NO_DATA_SELECTOR);
  if (!message.includes(FOREIGN_NO_DATA_MSG)) {
    debug('unexpected foreign currency page state, message: "%s"', message);
  }

  return false;
}

async function fetchForeignCurrencyAccount(
  page: Page,
  startDate: Moment,
  account: { value: string; text: string },
  options: ScraperOptions,
): Promise<TransactionsAccount | null> {
  debug('fetching foreign currency account %s', account.text);

  await page.select(FOREIGN_ACCOUNTS_SELECTOR, account.value);
  await page.select(FOREIGN_PERIOD_SELECTOR, FOREIGN_PERIOD_BY_DATES);
  await fillInput(page, FOREIGN_FROM_DATE_SELECTOR, startDate.format(DATE_FORMAT));
  await clickButton(page, FOREIGN_SUBMIT_SELECTOR);

  const hasActivityTable = await waitForForeignActivityTable(page);

  // The currency and balance labels describe the account that is currently displayed,
  // so they must be read only after the selection above has been submitted.
  const currencyLabel = await readTrimmedText(page, FOREIGN_CURRENCY_LABEL_SELECTOR);
  const currency = mapForeignCurrency(currencyLabel);
  if (!currency) {
    debug('skipping account %s, unrecognised currency "%s"', account.text, currencyLabel);
    return null;
  }

  const openingBalance = parseForeignAmount(await readTrimmedText(page, FOREIGN_OPENING_BALANCE_SELECTOR));
  const accountId = removeSpecialCharacters(account.text);
  if (!accountId) {
    debug('skipping account option "%s", it does not contain an account number', account.text);
    return null;
  }

  const accountNumber = `${accountId}-${currency}`;

  if (!hasActivityTable) {
    debug('account %s has no transactions in the requested range', accountNumber);
    return openingBalance === 0 ? null : { accountNumber, balance: openingBalance, currency, txns: [] };
  }

  const rows = await page.$$eval(`${FOREIGN_ACTIVITY_TABLE_SELECTOR} tr:not(.header)`, trs =>
    Array.from(trs, tr => Array.from(tr.querySelectorAll('td'), column => column.innerText.trim() || '')),
  );

  const parsedRows = rows
    .filter(cells => cells.length >= FOREIGN_COLUMN_COUNT)
    .map(cells => ({
      transaction: mapForeignTransaction(cells, currency, options),
      runningBalance: parseForeignAmount(cells[FOREIGN_COLUMN_BALANCE]),
    }));

  // Leumi reports a running balance per row; the row holding the current balance is
  // therefore whichever end of the table is the most recent. Comparing the two ends
  // detects the sort direction without assuming one, and keeps DOM order as the
  // tie-breaker for several transactions sharing a date.
  const firstRow = parsedRows[0];
  const lastRow = parsedRows[parsedRows.length - 1];
  const latestRow = firstRow && lastRow && firstRow.transaction.date > lastRow.transaction.date ? firstRow : lastRow;

  const balance = latestRow ? latestRow.runningBalance : openingBalance;
  if (balance === 0 && parsedRows.length === 0) {
    debug('skipping account %s, it is empty', accountNumber);
    return null;
  }

  debug('found %d transactions for account %s', parsedRows.length, accountNumber);

  return {
    accountNumber,
    balance,
    currency,
    txns: parsedRows.map(row => row.transaction),
  };
}

async function fetchForeignCurrencyAccounts(
  page: Page,
  startDate: Moment,
  options: ScraperOptions,
): Promise<TransactionsAccount[]> {
  debug('========== FETCHING FOREIGN CURRENCY ACCOUNTS ==========');
  const accounts: TransactionsAccount[] = [];

  try {
    await page.goto(FOREIGN_CURRENCY_URL, { waitUntil: 'networkidle2' });

    // DEVELOPER NOTICE the account number received from the server is being altered at
    // runtime for some accounts after 1-2 seconds so we need to hang the process for a short while.
    await hangProcess(4000);

    await waitUntilElementFound(page, FOREIGN_ACCOUNTS_SELECTOR, true);

    const accountOptions = await page.$$eval(`${FOREIGN_ACCOUNTS_SELECTOR} option`, elements =>
      Array.from(elements, element => ({ value: element.value, text: element.text })).filter(option => !!option.value),
    );

    debug('found %d foreign currency accounts', accountOptions.length);

    // Each iteration drives the same page, so the accounts must be fetched sequentially.
    for (const accountOption of accountOptions) {
      try {
        const account = await fetchForeignCurrencyAccount(page, startDate, accountOption, options);
        if (account) {
          accounts.push(account);
        }
      } catch (error) {
        debug('error fetching foreign currency account %s: %s', accountOption.text, error);
      }
    }
  } catch (error) {
    debug('error fetching foreign currency accounts: %s', error);
  }

  debug('returning %d foreign currency accounts', accounts.length);
  return accounts;
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

class LeumiScraper extends BaseScraperWithBrowser<ScraperSpecificCredentials> {
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

  async fetchData(): Promise<ScraperScrapingResult> {
    const minimumStartMoment = moment().subtract(3, 'years').add(1, 'day');
    const defaultStartMoment = moment().subtract(1, 'years').add(1, 'day');
    const startDate = this.options.startDate || defaultStartMoment.toDate();
    const startMoment = moment.max(minimumStartMoment, moment(startDate));

    const accounts = await fetchRegularAccounts(this, this.page, startMoment, this.options);
    const savingsAccounts = await fetchSavingsAccounts(this.page, accounts);
    accounts.push(...savingsAccounts);

    const foreignCurrencyAccounts = await fetchForeignCurrencyAccounts(this.page, startMoment, this.options);
    accounts.push(...foreignCurrencyAccounts);

    return {
      success: true,
      accounts,
    };
  }
}

export default LeumiScraper;
