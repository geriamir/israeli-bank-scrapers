import moment from 'moment';
import { SHEKEL_CURRENCY } from '../../constants';
import { getRawTransaction } from '../../helpers/transactions';
import {
  TransactionStatuses,
  TransactionTypes,
  type Transaction,
  type TransactionInstallments,
} from '../../transactions';
import { type ScraperOptions } from '../interface';

export const DATE_FORMAT = 'DD/MM/YYYY';
export const BILLING_MONTH_FORMAT = 'MM/YYYY';

export interface ScrapedLoginValidation {
  Header: {
    Status: string;
  };
  ValidateIdDataBean?: {
    userName?: string;
    returnCode: string;
  };
}

const MAX_LOGGED_STATUS_LENGTH = 20;

/**
 * Says what was wrong with a login validation response, for the error message.
 * The response can carry the user's details, so of its values only the status
 * code is included; of the rest, only the field names.
 */
export function describeLoginValidationFailure(result: ScrapedLoginValidation | null): string {
  if (!result) {
    return 'empty response';
  }
  const status = JSON.stringify(result.Header?.Status);
  return [
    `Header.Status=${status === undefined ? 'missing' : status.slice(0, MAX_LOGGED_STATUS_LENGTH)}`,
    `ValidateIdDataBean ${result.ValidateIdDataBean ? 'present' : 'missing'}`,
    `fields: ${Object.keys(result).join(',')}`,
    `Header fields: ${Object.keys(result.Header ?? {}).join(',')}`,
  ].join('; ');
}

export interface ScrapedCard {
  companyCode: string;
  cardStatus: string;
  cardSuffix: string;
  serviceType: string;
  isActive: boolean;
  isBlock: boolean;
  isPartner: boolean;
  limitData?: {
    creditLimitAmount: string;
    limitUsed: string;
  };
  cardChargeNext?: {
    billingDate: string;
  };
}

export interface ScrapedCardListResponse {
  data: {
    cardsList: ScrapedCard[];
  } | null;
  errorCode: string;
  errorDescription: string | null;
  isSuccess: boolean;
}

export interface ScrapedMonthlyBillingResponse {
  data: {
    cards: Record<string, { billingDate: string }>;
  } | null;
  errorCode: string;
  errorDescription: string | null;
  isSuccess: boolean;
}

export interface ScrapedApprovedTransaction {
  purchaseDate: string;
  israelTransactionTime: string;
  businessName: string;
  originalAmount: number;
  currencyIso: string;
  ilsBillingAmount: number;
  extraDetails: string | null;
  seqConfirmationNumber: string;
  branchCodeDescription: string | null;
}

export interface ScrapedVoucher {
  purchaseDate: string;
  purchaseTime: string | null;
  businessName: string;
  originalAmount: number;
  originalCurrencyIso: string;
  billingAmount: number;
  moreInfo: string | null;
  seqVoucherNumber: string;
  currentInstallmentNum: number | null;
  numberOfInstallment: number | null;
  transactionDescription: string | null;
  /** Which kind of deal GetTransactionDetails must be asked about. */
  isIsraelDeal?: boolean | null;
  businessNumber?: number | null;
  isdirectDebit?: boolean | null;
  /** How the deal was made, e.g. "עסקת אנטרנט" (online). */
  tranzacCodeDescription?: string | null;
  presentCard?: boolean | null;
  cityDescription?: string | null;
  countryDescription?: string | null;
}

export interface ScrapedOutOfStatementGroup {
  immediateVouchersCurrencyDate: ScrapedVoucher[];
  totalVouchersCurrencyDate: {
    dateImmediateVouchers?: string;
  };
}

export interface ScrapedTransactionsResponse {
  data: {
    approvals: { approvedTransactions: ScrapedApprovedTransaction[] } | null;
    israelAbroadVouchers: {
      vouchers: {
        israelAbroadVouchersList: ScrapedVoucher[];
      };
      outOfStatementChargeDateVouchers: ScrapedOutOfStatementGroup[];
    } | null;
  } | null;
  errorCode: string;
  errorDescription: string | null;
  isSuccess: boolean;
}

export interface ScrapedTransactionDetails {
  parentBranchDescription: string | null;
  branchDescription: string | null;
  secondBranchDescription: string | null;
  transferBeneficiary: string | null;
  transferReason: string | null;
  moneyTransferType?: string | number | null;
  businessNumber?: number | null;
  directDebit?: boolean | null;
  /** How the deal was made, e.g. "טלפוני" (by phone). */
  tranzakDescription?: string | null;
  cardPresent?: boolean | null;
  israelAdressCity?: string | null;
  country?: string | null;
}

export interface ScrapedTransactionDetailsResponse {
  data: ScrapedTransactionDetails | null;
  errorCode: string;
  errorDescription: string | null;
  isSuccess: boolean;
}

/** What a charge carries beyond the standard Transaction fields, from the list and the details call. */
export interface IsracardAdditionalInformation {
  isIsraelDeal?: boolean;
  parentBranchDescription?: string;
  branchDescription?: string;
  secondBranchDescription?: string;
  transferBeneficiary?: string;
  transferReason?: string;
  moneyTransferType?: string;
  businessNumber?: number;
  directDebit?: boolean;
  transactionChannel?: string;
  cardPresent?: boolean;
  city?: string;
  country?: string;
}

export type IsracardTransaction = Transaction & {
  additionalInformation?: IsracardAdditionalInformation;
};

const trimmedOrUndefined = (value: string | null | undefined): string | undefined => value?.trim() || undefined;

const numberOrUndefined = (value: number | null | undefined): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const booleanOrUndefined = (value: boolean | null | undefined): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

const definedOnly = <T extends object>(values: T): Partial<T> =>
  Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as Partial<T>;

export function getCardBalance(card: ScrapedCard): number | undefined {
  if (!card.limitData) {
    return undefined;
  }
  const limitUsed = Number(card.limitData.limitUsed);
  return Number.isNaN(limitUsed) ? undefined : -limitUsed;
}

export function getCardFrame(card: ScrapedCard): number | undefined {
  if (!card.limitData) {
    return undefined;
  }
  const creditLimit = Number(card.limitData.creditLimitAmount);
  return Number.isNaN(creditLimit) ? undefined : creditLimit;
}

export function getCardBalanceDate(card: ScrapedCard): string | undefined {
  if (!card.cardChargeNext?.billingDate) {
    return undefined;
  }
  return moment(card.cardChargeNext.billingDate, DATE_FORMAT).toISOString();
}

export function isApprovedTransactionSettled(
  approved: ScrapedApprovedTransaction,
  vouchers: ScrapedVoucher[],
): boolean {
  return vouchers.some(
    voucher =>
      voucher.purchaseDate === approved.purchaseDate &&
      voucher.originalAmount === approved.originalAmount &&
      voucher.originalCurrencyIso === approved.currencyIso &&
      (voucher.businessName || '').trim() === (approved.businessName || '').trim(),
  );
}

export function convertApprovedTransaction(txn: ScrapedApprovedTransaction, options?: ScraperOptions): Transaction {
  const isoDate = moment(`${txn.purchaseDate} ${txn.israelTransactionTime}`, `${DATE_FORMAT} HH:mm`).toISOString();

  const result: Transaction = {
    type: TransactionTypes.Normal,
    identifier: txn.seqConfirmationNumber,
    date: isoDate,
    processedDate: isoDate,
    originalAmount: -txn.originalAmount,
    originalCurrency: txn.currencyIso,
    chargedAmount: -txn.ilsBillingAmount,
    chargedCurrency: SHEKEL_CURRENCY,
    description: (txn.businessName || '').trim(),
    memo: txn.extraDetails || '',
    category: txn.branchCodeDescription?.trim() || undefined,
    status: TransactionStatuses.Pending,
  };

  if (options?.includeRawTransaction) {
    result.rawTransaction = getRawTransaction(txn);
  }

  return result;
}

export function getVoucherInstallments(voucher: ScrapedVoucher): TransactionInstallments | undefined {
  if (!voucher.numberOfInstallment || !voucher.currentInstallmentNum) {
    return undefined;
  }
  return {
    number: voucher.currentInstallmentNum,
    total: voucher.numberOfInstallment,
  };
}

export function convertVoucher(
  voucher: ScrapedVoucher,
  processedDateIso: string,
  options?: ScraperOptions,
): IsracardTransaction {
  const dateMoment = moment(`${voucher.purchaseDate} ${voucher.purchaseTime || '00:00:00'}`, `${DATE_FORMAT} HH:mm:ss`);
  const installments = getVoucherInstallments(voucher);
  const additionalInformation = definedOnly({
    isIsraelDeal: booleanOrUndefined(voucher.isIsraelDeal),
    businessNumber: numberOrUndefined(voucher.businessNumber),
    directDebit: booleanOrUndefined(voucher.isdirectDebit),
    transactionChannel: trimmedOrUndefined(voucher.tranzacCodeDescription),
    cardPresent: booleanOrUndefined(voucher.presentCard),
    city: trimmedOrUndefined(voucher.cityDescription),
    country: trimmedOrUndefined(voucher.countryDescription),
  });

  const result: IsracardTransaction = {
    type: installments ? TransactionTypes.Installments : TransactionTypes.Normal,
    identifier: voucher.seqVoucherNumber,
    date: dateMoment.toISOString(),
    processedDate: processedDateIso,
    originalAmount: -voucher.originalAmount,
    originalCurrency: voucher.originalCurrencyIso,
    chargedAmount: -voucher.billingAmount,
    chargedCurrency: SHEKEL_CURRENCY,
    description: (voucher.businessName || '').trim(),
    memo: (voucher.moreInfo || '').trim(),
    // `transactionDescription` is the deal kind ("עסקאות רגילות"), not a merchant category -
    // the category only comes from GetTransactionDetails (see applyTransactionDetails).
    installments,
    status: TransactionStatuses.Completed,
  };

  if (Object.keys(additionalInformation).length) {
    result.additionalInformation = additionalInformation;
  }

  if (options?.includeRawTransaction) {
    result.rawTransaction = getRawTransaction(voucher);
  }

  return result;
}

// GetTransactionDetails needs to know whether the deal was Israeli. The voucher says so;
// only when it doesn't is a shekel deal taken as the likely Israeli one.
export function getIsIsraelDeal(txn: IsracardTransaction): { isIsraelDeal: boolean; known: boolean } {
  const known = txn.additionalInformation?.isIsraelDeal;
  return typeof known === 'boolean'
    ? { isIsraelDeal: known, known: true }
    : { isIsraelDeal: txn.originalCurrency === SHEKEL_CURRENCY, known: false };
}

export function getDetailsCategory(details: ScrapedTransactionDetails): string | undefined {
  const category = [details.branchDescription, details.secondBranchDescription, details.parentBranchDescription]
    .map(value => value?.trim())
    .find(value => !!value);
  return category || undefined;
}

export function getDetailsMemo(memo: string | undefined, details: ScrapedTransactionDetails): string {
  const beneficiary = trimmedOrUndefined(details.transferBeneficiary);
  const parts = [beneficiary && `העברה ל: ${beneficiary}`, details.transferReason, memo]
    .map(value => (value || '').trim())
    .filter(value => !!value);
  return [...new Set(parts)].join(', ');
}

// Money-transfer apps as they appear as a merchant: "PAYBOX", "העברה ב BIT בנה"פ", "הפועלים-ביט",
// "PEPPER PAY", "העברת כספים". Word-bounded (by hand for Hebrew, which \b doesn't handle) so that
// e.g. "ביטוח" (insurance), "טאביט" or "BITCOIN" stays a merchant like any other.
const TRANSFER_SERVICE_PATTERN = /PAY\s?BOX|\bBIT\b|\bPEPPER\b|פייבוקס|(^|[\s\-])ביט($|[\s\-])|^העבר(ה|ת)(\s|$)/i;

export function isTransferService(description: string | undefined): boolean {
  return TRANSFER_SERVICE_PATTERN.test((description || '').trim());
}

export function isTransferDetails(details: ScrapedTransactionDetails): boolean {
  return !!(details.transferBeneficiary?.trim() || details.transferReason?.trim());
}

/**
 * Folds a voucher's GetTransactionDetails into it. A transfer (PayBox, Bit) carries the
 * business type of the transfer service itself - PayBox is "computers and software" - so
 * it takes no category from the details; who it went to goes into the memo instead.
 * The extra fields go into additionalInformation, where the list's values, already
 * there, win over the details'.
 */
export function applyTransactionDetails(
  txn: IsracardTransaction,
  details: ScrapedTransactionDetails,
  options?: ScraperOptions,
): IsracardTransaction {
  const isTransfer = isTransferDetails(details);
  const moneyTransferType =
    details.moneyTransferType === null || details.moneyTransferType === undefined
      ? undefined
      : trimmedOrUndefined(String(details.moneyTransferType));

  const result: IsracardTransaction = {
    ...txn,
    category: isTransfer ? txn.category : (getDetailsCategory(details) ?? txn.category),
    memo: getDetailsMemo(txn.memo, details),
    additionalInformation: {
      ...definedOnly({
        parentBranchDescription: trimmedOrUndefined(details.parentBranchDescription),
        branchDescription: trimmedOrUndefined(details.branchDescription),
        secondBranchDescription: trimmedOrUndefined(details.secondBranchDescription),
        transferBeneficiary: trimmedOrUndefined(details.transferBeneficiary),
        transferReason: trimmedOrUndefined(details.transferReason),
        moneyTransferType,
        businessNumber: numberOrUndefined(details.businessNumber),
        directDebit: booleanOrUndefined(details.directDebit),
        transactionChannel: trimmedOrUndefined(details.tranzakDescription),
        cardPresent: booleanOrUndefined(details.cardPresent),
        city: trimmedOrUndefined(details.israelAdressCity),
        country: trimmedOrUndefined(details.country),
      }),
      ...txn.additionalInformation,
    },
  };

  if (options?.includeRawTransaction) {
    result.rawTransaction = getRawTransaction(details, txn);
  }

  return result;
}
