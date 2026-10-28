import moment, { type Moment } from 'moment';
import { type Page } from 'puppeteer';
import { ScraperProgressTypes } from '../../definitions';
import { interceptionPriorities, maskBrowserAutomation } from '../../helpers/browser';
import getAllMonthMoments from '../../helpers/dates';
import { getDebug } from '../../helpers/debug';
import { fetchPostWithinPage } from '../../helpers/fetch';
import { filterOldTransactions, fixInstallments } from '../../helpers/transactions';
import { randomDelay } from '../../helpers/waiting';
import { TransactionStatuses, type Transaction, type TransactionsAccount } from '../../transactions';
import { BaseScraperWithBrowser } from '../base-scraper-with-browser';
import { ScraperErrorTypes } from '../errors';
import { type ScraperOptions, type ScraperScrapingResult } from '../interface';
import {
  applyTransactionDetails,
  BILLING_MONTH_FORMAT,
  convertApprovedTransaction,
  convertVoucher,
  DATE_FORMAT,
  getCardBalance,
  getCardBalanceDate,
  getCardFrame,
  guessIsIsraelDeal,
  isApprovedTransactionSettled,
  isTransferDetails,
  type ScrapedCard,
  type ScrapedCardListResponse,
  type ScrapedLoginValidation,
  type ScrapedMonthlyBillingResponse,
  type ScrapedTransactionDetails,
  type ScrapedTransactionDetailsResponse,
  type ScrapedTransactionsResponse,
} from './base-isracard-utils';

const GET_CARD_LIST_COMPANY_CODE = '99';
const CARD_SUFFIX_LENGTH = 4;
const COUNTRY_CODE = '212';
const ID_TYPE = '1';

const RATE_LIMIT = {
  SLEEP_BETWEEN: 2500,
  DETAILS_BATCH_SIZE: 5,
  DETAILS_SLEEP_BETWEEN: 1000,
} as const;

const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };

const debug = getDebug('isracard-group');

async function fetchGroupCards(page: Page, cardListUrl: string, loginCompanyCode: string): Promise<ScrapedCard[]> {
  debug('fetching card list');
  const response = await fetchPostWithinPage<ScrapedCardListResponse>(
    page,
    cardListUrl,
    { companyCode: GET_CARD_LIST_COMPANY_CODE, cardSuffixLength: CARD_SUFFIX_LENGTH },
    JSON_HEADERS,
  );

  if (!response || !response.isSuccess || !response.data) {
    throw new Error(`failed to fetch card list: ${response?.errorDescription ?? 'unknown error'}`);
  }

  return response.data.cardsList.filter(
    card => card.companyCode === loginCompanyCode && card.isActive && !card.isBlock,
  );
}

async function fetchEffectiveBillingDate(
  page: Page,
  monthlyBillingUrl: string,
  transactionsCompanyCode: number,
  card: ScrapedCard,
  monthMoment: Moment,
): Promise<string | undefined> {
  const billingDate = monthMoment.format(BILLING_MONTH_FORMAT);

  debug(`fetching effective billing date for card ${card.cardSuffix}, ${billingDate}`);
  await randomDelay(RATE_LIMIT.SLEEP_BETWEEN, RATE_LIMIT.SLEEP_BETWEEN + 500);

  const response = await fetchPostWithinPage<ScrapedMonthlyBillingResponse>(
    page,
    monthlyBillingUrl,
    {
      cards: [
        {
          cardStatus: Number(card.cardStatus),
          cardSuffix: card.cardSuffix,
          companyCode: transactionsCompanyCode,
          serviceType: Number(card.serviceType),
          isPartner: card.isPartner,
        },
      ],
      billingDate,
    },
    JSON_HEADERS,
  );

  if (!response || !response.isSuccess || !response.data) {
    throw new Error(
      `failed to fetch monthly billing date for card ${card.cardSuffix}, ${billingDate}: ${response?.errorDescription ?? 'unknown error'}`,
    );
  }

  const billing = response.data.cards[card.cardSuffix];
  return billing ? moment(billing.billingDate, DATE_FORMAT).toISOString() : undefined;
}

async function fetchMonthTransactions(
  page: Page,
  transactionsUrl: string,
  transactionsCompanyCode: number,
  card: ScrapedCard,
  monthMoment: Moment,
  isNextBillingDate: boolean,
  processedDateIso: string,
  options: ScraperOptions,
): Promise<Transaction[]> {
  const billingMonth = monthMoment.format(DATE_FORMAT);

  debug(`fetching transactions for card ${card.cardSuffix}, ${billingMonth} (isNextBillingDate=${isNextBillingDate})`);
  await randomDelay(RATE_LIMIT.SLEEP_BETWEEN, RATE_LIMIT.SLEEP_BETWEEN + 500);

  const response = await fetchPostWithinPage<ScrapedTransactionsResponse>(
    page,
    transactionsUrl,
    {
      card4Number: card.cardSuffix,
      isNextBillingDate,
      cardStatus: Number(card.cardStatus),
      billingMonth,
      companyCode: transactionsCompanyCode,
      isPartner: card.isPartner,
    },
    JSON_HEADERS,
  );

  if (!response || !response.isSuccess || !response.data) {
    throw new Error(
      `failed to fetch transactions for card ${card.cardSuffix}, billing month ${billingMonth}: ${response?.errorDescription ?? 'unknown error'}`,
    );
  }

  const txns: Transaction[] = [];

  const voucherList = response.data.israelAbroadVouchers?.vouchers?.israelAbroadVouchersList ?? [];
  const outOfStatementGroups = response.data.israelAbroadVouchers?.outOfStatementChargeDateVouchers ?? [];
  const allVouchers = [
    ...voucherList,
    ...outOfStatementGroups.flatMap(group => group.immediateVouchersCurrencyDate ?? []),
  ];

  // The same response can list a charge in both `approvals` (pending) and the voucher lists
  // (settled) at once, so drop the approval entry in favor of the richer, settled voucher.
  const approvedTxns = (response.data.approvals?.approvedTransactions ?? []).filter(
    txn => !isApprovedTransactionSettled(txn, allVouchers),
  );
  txns.push(...approvedTxns.map(txn => convertApprovedTransaction(txn, options)));

  txns.push(...voucherList.map(voucher => convertVoucher(voucher, processedDateIso, options)));

  outOfStatementGroups.forEach(group => {
    const groupDateStr = group.totalVouchersCurrencyDate?.dateImmediateVouchers;
    const groupIso = groupDateStr ? moment(groupDateStr, DATE_FORMAT).toISOString() : processedDateIso;
    txns.push(
      ...(group.immediateVouchersCurrencyDate ?? []).map(voucher => convertVoucher(voucher, groupIso, options)),
    );
  });

  return txns;
}

async function fetchTransactionDetails(
  page: Page,
  transactionDetailsUrl: string,
  transactionsCompanyCode: number,
  card: ScrapedCard,
  txn: Transaction,
  isIsraelDeal: boolean,
): Promise<ScrapedTransactionDetails | null> {
  const response = await fetchPostWithinPage<ScrapedTransactionDetailsResponse>(
    page,
    transactionDetailsUrl,
    {
      cardSuffix: card.cardSuffix,
      companyCode: transactionsCompanyCode,
      isIsraelDeal,
      isPartner: card.isPartner,
      seqVoucherNumber: String(txn.identifier),
    },
    JSON_HEADERS,
  );
  return response?.isSuccess && response.data ? response.data : null;
}

// Settled vouchers carry no merchant category, so each one needs its own GetTransactionDetails
// call, unless the merchant's category is already in the category cache. Best effort: a
// transaction whose details can't be read is kept as-is.
export async function addTransactionDetails(
  page: Page,
  transactionDetailsUrl: string,
  transactionsCompanyCode: number,
  card: ScrapedCard,
  txns: Transaction[],
  options: ScraperOptions,
): Promise<Transaction[]> {
  const shouldFetch = options.shouldFetchAdditionalTransactionInformation ?? (() => true);
  // Filled only from details, which say whether a transaction is a transfer: a pending
  // transaction's category doesn't, and a cached transfer would lose its beneficiary.
  const cache = options.additionalTransactionInformationCategoryCache ?? new Map<string, string>();

  let queue = txns.filter(
    txn => txn.status === TransactionStatuses.Completed && !!txn.identifier && shouldFetch(txn, card.cardSuffix),
  );
  debug(`getting details for ${queue.length} of ${txns.length} transactions on card ${card.cardSuffix}`);

  const detailed = new Map<Transaction, Transaction>();
  let calls = 0;
  while (queue.length) {
    // One transaction per merchant in a batch, so the next of its transactions can use the cache
    const batch: Transaction[] = [];
    const rest: Transaction[] = [];
    queue.forEach(txn => {
      const cachedCategory = cache.get(txn.description);
      if (cachedCategory) {
        detailed.set(txn, { ...txn, category: cachedCategory });
      } else if (batch.length < RATE_LIMIT.DETAILS_BATCH_SIZE && !batch.some(b => b.description === txn.description)) {
        batch.push(txn);
      } else {
        rest.push(txn);
      }
    });
    queue = rest;
    if (!batch.length) {
      break;
    }

    if (calls > 0) {
      await randomDelay(RATE_LIMIT.DETAILS_SLEEP_BETWEEN, RATE_LIMIT.DETAILS_SLEEP_BETWEEN + 500);
    }
    calls += batch.length;
    await Promise.all(
      batch.map(async txn => {
        try {
          const isIsraelDeal = guessIsIsraelDeal(txn);
          const details =
            (await fetchTransactionDetails(page, transactionDetailsUrl, transactionsCompanyCode, card, txn, isIsraelDeal)) ??
            (await fetchTransactionDetails(page, transactionDetailsUrl, transactionsCompanyCode, card, txn, !isIsraelDeal));
          if (!details) {
            debug(`no details for transaction ${txn.identifier} on card ${card.cardSuffix}`);
            return;
          }
          const result = applyTransactionDetails(txn, details, options);
          detailed.set(txn, result);
          // A transfer's memo names its own beneficiary, so its details are never reused
          if (result.category && !isTransferDetails(details)) {
            cache.set(txn.description, result.category);
          }
        } catch (e) {
          debug(`failed to fetch details for transaction ${txn.identifier} on card ${card.cardSuffix}`, e);
        }
      }),
    );
  }
  debug(`made ${calls} details calls for card ${card.cardSuffix}`);

  return txns.map(txn => detailed.get(txn) ?? txn);
}

type ScraperSpecificCredentials = { id: string; password: string; card6Digits: string };

class IsracardGroupScraper extends BaseScraperWithBrowser<ScraperSpecificCredentials> {
  constructor(
    options: ScraperOptions,
    private loginBaseUrl: string,
    private webBaseUrl: string,
    private loginCompanyCode: string,
    private transactionsCompanyCode: number,
  ) {
    super(options);
  }

  private get servicesUrl(): string {
    return `${this.loginBaseUrl}/services/ProxyRequestHandler.ashx`;
  }

  private get cardListUrl(): string {
    return `${this.webBaseUrl}/ocp/transactions/DigitalV3.Transactions/GetCardList`;
  }

  private get monthlyBillingUrl(): string {
    return `${this.webBaseUrl}/ocp/transactions/DigitalV3.Transactions/GetMonthlyBilling`;
  }

  private get transactionsUrl(): string {
    return `${this.webBaseUrl}/ocp/transactions/DigitalV3.Transactions/GetTransactionsList`;
  }

  private get transactionDetailsUrl(): string {
    return `${this.webBaseUrl}/ocp/transactiondetails/DigitalV3.TransactionDetails/GetTransactionDetails`;
  }

  private get shouldFetchTransactionDetails(): boolean {
    return (
      !!this.options.additionalTransactionInformation &&
      !this.options.optInFeatures?.includes('isracard-amex:skipAdditionalTransactionInformation')
    );
  }

  async login(credentials: ScraperSpecificCredentials): Promise<ScraperScrapingResult> {
    const loginStartTime = performance.now();

    await this.page.setRequestInterception(true);
    this.page.on('request', request => {
      if (request.url().includes('detector-dom.min.js')) {
        debug('force abort for request do download detector-dom.min.js resource');
        void request.abort(undefined, interceptionPriorities.abort);
      } else {
        void request.continue(undefined, interceptionPriorities.continue);
      }
    });

    await maskBrowserAutomation(this.page);
    await this.page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    await this.navigateTo(`${this.loginBaseUrl}/personalarea/Login`);
    await randomDelay(RATE_LIMIT.SLEEP_BETWEEN, RATE_LIMIT.SLEEP_BETWEEN + 500);

    this.emitProgress(ScraperProgressTypes.LoggingIn);

    const validateUrl = `${this.servicesUrl}?reqName=ValidateIdData`;
    const validateRequest = {
      id: credentials.id,
      cardSuffix: credentials.card6Digits,
      countryCode: COUNTRY_CODE,
      idType: ID_TYPE,
      checkLevel: '1',
      companyCode: this.loginCompanyCode,
    };
    debug('logging in with validate request');
    const validateResult = await fetchPostWithinPage<ScrapedLoginValidation>(this.page, validateUrl, validateRequest);
    if (
      !validateResult ||
      !validateResult.Header ||
      validateResult.Header.Status !== '1' ||
      !validateResult.ValidateIdDataBean
    ) {
      throw new Error('unknown error during login');
    }

    const validateReturnCode = validateResult.ValidateIdDataBean.returnCode;
    debug(`user validate with return code '${validateReturnCode}'`);
    if (validateReturnCode === '1') {
      const { userName } = validateResult.ValidateIdDataBean;

      const loginUrl = `${this.servicesUrl}?reqName=performLogonI`;
      const request = {
        KodMishtamesh: userName,
        MisparZihuy: credentials.id,
        Sisma: credentials.password,
        cardSuffix: credentials.card6Digits,
        countryCode: COUNTRY_CODE,
        idType: ID_TYPE,
      };
      debug('user login started');
      const loginResult = await fetchPostWithinPage<{ status: string }>(this.page, loginUrl, request);
      debug(`user login with status '${loginResult?.status}'`, loginResult);

      if (loginResult && loginResult.status === '1') {
        this.emitProgress(ScraperProgressTypes.LoginSuccess);
        debug(`Login completed in ${performance.now() - loginStartTime}ms`);

        await this.navigateTo(`${this.webBaseUrl}/transactions`);

        return { success: true };
      }

      if (loginResult && loginResult.status === '3') {
        this.emitProgress(ScraperProgressTypes.ChangePassword);
        return {
          success: false,
          errorType: ScraperErrorTypes.ChangePassword,
        };
      }

      this.emitProgress(ScraperProgressTypes.LoginFailed);
      return {
        success: false,
        errorType: ScraperErrorTypes.InvalidPassword,
      };
    }

    if (validateReturnCode === '4') {
      this.emitProgress(ScraperProgressTypes.ChangePassword);
      return {
        success: false,
        errorType: ScraperErrorTypes.ChangePassword,
      };
    }

    this.emitProgress(ScraperProgressTypes.LoginFailed);
    return {
      success: false,
      errorType: ScraperErrorTypes.InvalidPassword,
    };
  }

  async fetchData(): Promise<ScraperScrapingResult> {
    const fetchStartTime = performance.now();
    const defaultStartMoment = moment().subtract(1, 'years');
    const startDate = this.options.startDate || defaultStartMoment.toDate();
    const startMoment = moment.max(defaultStartMoment, moment(startDate));
    const futureMonthsToScrape = this.options.futureMonthsToScrape ?? 1;
    const allMonths = getAllMonthMoments(startMoment, futureMonthsToScrape);
    const currentMonthStart = moment().startOf('month');

    const cards = await fetchGroupCards(this.page, this.cardListUrl, this.loginCompanyCode);
    debug(`found ${cards.length} cards, fetching transactions for ${allMonths.length} months each`);

    const txnsByCard: Record<string, Transaction[]> = {};
    cards.forEach(card => {
      txnsByCard[card.cardSuffix] = [];
    });

    for (const monthMoment of allMonths) {
      const isNextBillingDate = monthMoment.isAfter(currentMonthStart);

      for (const card of cards) {
        const effectiveDateIso = await fetchEffectiveBillingDate(
          this.page,
          this.monthlyBillingUrl,
          this.transactionsCompanyCode,
          card,
          monthMoment,
        );
        const processedDateIso = effectiveDateIso ?? monthMoment.toISOString();
        const monthTxns = await fetchMonthTransactions(
          this.page,
          this.transactionsUrl,
          this.transactionsCompanyCode,
          card,
          monthMoment,
          isNextBillingDate,
          processedDateIso,
          this.options,
        );
        txnsByCard[card.cardSuffix].push(...monthTxns);
      }
    }

    const accounts: TransactionsAccount[] = [];
    for (const card of cards) {
      let txns = txnsByCard[card.cardSuffix];
      if (!this.options.combineInstallments) {
        txns = fixInstallments(txns);
      }
      if (this.options.outputData?.enableTransactionsFilterByDate ?? true) {
        txns = filterOldTransactions(txns, startMoment, this.options.combineInstallments || false);
      }
      if (this.shouldFetchTransactionDetails) {
        txns = await addTransactionDetails(
          this.page,
          this.transactionDetailsUrl,
          this.transactionsCompanyCode,
          card,
          txns,
          this.options,
        );
      }
      accounts.push({
        accountNumber: card.cardSuffix,
        balance: getCardBalance(card),
        balanceDate: getCardBalanceDate(card),
        cardFrame: getCardFrame(card),
        txns,
      });
    }

    debug(`fetchData completed in ${performance.now() - fetchStartTime}ms`);

    return {
      success: true,
      accounts,
    };
  }
}

export default IsracardGroupScraper;
