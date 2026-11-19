import { type Page } from 'puppeteer';
import { getDebug } from '../../helpers/debug';
import { fetchGetWithinPage } from '../../helpers/fetch';
import { type BankMortgage, type BankMortgageSnapshot, type BankMortgageTrack } from '../../transactions';

const debug = getDebug('leumi-mortgages');
const BASE_URL = 'https://hb2.bankleumi.co.il';
// The same API the "ריכוז משכנתאות" page (a React app in a frame) reads.
const MORTGAGE_API = `${BASE_URL}/uiapiproxy/v1/digital-retails/mobile`;
const MORTGAGE_PAGE_URL = `${BASE_URL}/eBanking/SO/SPA.aspx#/ts/reactFrame?action=mortgages`;
const SOURCE = 'leumi-mortgage-api' as const;

export interface LeumiMortgageDetailsResponse {
  clearingBalanceAll?: number;
  loanMortgageItems?: Array<{
    MortgageDetail?: {
      mortgageKey?: string;
      mortgageKeyFormatted?: string;
      dayOfPayment?: number | null;
      clearingBalance?: number | null;
      clearingCommission?: number | null;
      arrearsTotalAmount?: number | null;
      mortgageAmount?: number | null;
      bookingDate?: string | null;
      lastPaymentAmount?: number | null;
      mortgageEndDate?: string | null;
      portfolioAccountsItems?: Array<{ portfolioAccountNum?: string }> | null;
      balanceItems?: Array<{
        clearingBalance?: number | null;
        validityDate?: string | null;
        fundBalance?: number | null;
        linkageEstimatedBalance?: number | null;
      }> | null;
    };
  }>;
}

export interface LeumiLoanInfoResponse {
  MortgageDetails?: {
    mortgageKey?: string;
    loansItems?: Array<{
      productName?: string | null;
      loanId?: string | null;
      annualInterestPercent?: number | null;
      lastPaymentAmount?: number | null;
      clearingTableDescription?: string | null;
      loanCreditDate?: string | null;
      calculateEndDate?: string | null;
      clearingBalance?: number | null;
      commissionFreeBalance?: number | null;
      fundBalance?: number | null;
      linkageEstimatedBalance?: number | null;
      loanAmount?: number | null;
      anchorSpreadRate?: string | null;
      percentChgDate?: string | null;
      linkageBase?: string | null;
      interestType?: string | null;
      loanFirstPayDate?: string | null;
      paymentItems?: Array<{ paymentDate?: string | null; paymentAmount?: number | null }> | null;
    }> | null;
  };
}

export const unavailableLeumiMortgages = (): BankMortgageSnapshot => ({
  status: 'unavailable',
  source: SOURCE,
  mortgages: [],
});

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);
const digits = (value: string) => value.replace(/\D/g, '');

// "15.04.50" -> "2050-04-15". The two-digit year is read as 20YY: Leumi's mortgages
// all start after 2000, and their end dates run as far as the 2050s and beyond.
export function parseShortDate(value: unknown): string | null {
  const match = /^(\d{2})\.(\d{2})\.(\d{2})$/.exec(text(value) ?? '');
  if (!match) return null;
  const [, day, month, year] = match;
  return `20${year}-${month}-${day}`;
}

// "2026-11-17T00:00:00" or "2020-05-15" -> "2026-11-17".
export function parseIsoDate(value: unknown): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})(?:T|$)/.exec(text(value) ?? '');
  return match ? match[1] : null;
}

// "11.2026" -> "2026-11".
function parseMonth(value: unknown): string | null {
  const match = /^(\d{2})\.(\d{4})$/.exec(text(value) ?? '');
  return match ? `${match[2]}-${match[1]}` : null;
}

function parseInterestType(value: unknown): BankMortgageTrack['interestType'] {
  if (value === 'FIXED') return 'fixed';
  if (value === 'VARIABLE') return 'variable';
  return null;
}

// "לא" means the track is not linked; anything else names the linkage ("100% הצמדה למדד").
function parseCpiLinked(value: unknown): boolean | null {
  const linkage = text(value);
  if (!linkage) return null;
  if (linkage === 'לא') return false;
  return /מדד/.test(linkage) ? true : null;
}

type LoanItem = NonNullable<NonNullable<LeumiLoanInfoResponse['MortgageDetails']>['loansItems']>[number];

export function parseLeumiMortgageTrack(item: LoanItem): BankMortgageTrack | null {
  const trackId = text(item.loanId);
  if (!trackId) return null;
  return {
    trackId,
    name: text(item.productName) ?? trackId,
    originalAmount: num(item.loanAmount),
    payoffBalance: num(item.clearingBalance),
    balanceWithoutFees: num(item.commissionFreeBalance),
    principalBalance: num(item.fundBalance),
    linkageBalance: num(item.linkageEstimatedBalance),
    annualInterestPercent: num(item.annualInterestPercent),
    interestType: parseInterestType(item.interestType),
    rateAnchorText: text(item.anchorSpreadRate),
    nextRateChangeDate: parseIsoDate(item.percentChgDate),
    cpiLinked: parseCpiLinked(item.linkageBase),
    amortization: text(item.clearingTableDescription),
    lastPaymentAmount: num(item.lastPaymentAmount),
    startDate: parseShortDate(item.loanCreditDate),
    firstPaymentDate: parseIsoDate(item.loanFirstPayDate),
    endDate: parseShortDate(item.calculateEndDate),
  };
}

// The tracks of one mortgage, and its monthly payments. Each track's paymentItems holds
// the payment of the whole mortgage, the same list on every track, so it is read once.
export function parseLeumiLoanInfo(
  response: LeumiLoanInfoResponse | null,
  mortgageKey: string,
): Pick<BankMortgage, 'tracksStatus' | 'tracks' | 'recentPayments'> {
  const unavailable = { tracksStatus: 'unavailable' as const, tracks: [], recentPayments: [] };
  const details = response?.MortgageDetails;
  if (!details || !Array.isArray(details.loansItems) || !details.loansItems.length) return unavailable;
  if (details.mortgageKey && digits(details.mortgageKey) !== digits(mortgageKey)) return unavailable;
  const tracks = details.loansItems.map(parseLeumiMortgageTrack);
  if (tracks.some(track => track === null)) return unavailable;
  const recentPayments = (details.loansItems[0].paymentItems ?? [])
    .map(payment => ({ month: parseMonth(payment.paymentDate), amount: num(payment.paymentAmount) }))
    .filter((payment): payment is { month: string; amount: number } => !!payment.month && payment.amount !== null);
  return { tracksStatus: 'reported', tracks: tracks as BankMortgageTrack[], recentPayments };
}

type MortgageDetail = NonNullable<
  NonNullable<LeumiMortgageDetailsResponse['loanMortgageItems']>[number]['MortgageDetail']
>;

export function parseLeumiMortgage(detail: MortgageDetail): BankMortgage | null {
  const mortgageNumber = text(detail.mortgageKeyFormatted) ?? text(detail.mortgageKey);
  const balance = detail.balanceItems?.[0];
  const payoffBalance = num(detail.clearingBalance) ?? num(balance?.clearingBalance);
  if (!mortgageNumber || payoffBalance === null) return null;
  return {
    mortgageNumber,
    originalAmount: num(detail.mortgageAmount),
    payoffBalance,
    principalBalance: num(balance?.fundBalance),
    linkageBalance: num(balance?.linkageEstimatedBalance),
    earlyRepaymentFee: num(detail.clearingCommission),
    balanceAsOf: parseIsoDate(balance?.validityDate),
    startDate: parseShortDate(detail.bookingDate),
    endDate: parseShortDate(detail.mortgageEndDate),
    paymentDayOfMonth: num(detail.dayOfPayment),
    lastPaymentAmount: num(detail.lastPaymentAmount),
    arrears: num(detail.arrearsTotalAmount),
    paidFromAccounts: (detail.portfolioAccountsItems ?? [])
      .map(item => digits(item.portfolioAccountNum ?? ''))
      .filter(Boolean),
    tracksStatus: 'unavailable',
    tracks: [],
    recentPayments: [],
  };
}

// The mortgages, without their tracks. A response that lists its mortgages as an empty
// list is the bank saying there are none; one that does not list them at all, or lists
// one that cannot be read, is unavailable, never "no mortgage".
export function parseLeumiMortgageDetails(response: LeumiMortgageDetailsResponse | null): BankMortgageSnapshot {
  if (!response || !Array.isArray(response.loanMortgageItems)) return unavailableLeumiMortgages();
  const mortgages: BankMortgage[] = [];
  for (const item of response.loanMortgageItems) {
    const mortgage = item.MortgageDetail ? parseLeumiMortgage(item.MortgageDetail) : null;
    if (!mortgage) return unavailableLeumiMortgages();
    mortgages.push(mortgage);
  }
  return { status: 'reported', source: SOURCE, mortgages };
}

async function fetchMortgageDetails(page: Page): Promise<LeumiMortgageDetailsResponse | null> {
  try {
    return await fetchGetWithinPage<LeumiMortgageDetailsResponse>(page, `${MORTGAGE_API}/mortgageDetails`);
  } catch (e) {
    debug('mortgageDetails failed: %s', e instanceof Error ? e.message : String(e));
    return null;
  }
}

export async function fetchLeumiMortgages(page: Page): Promise<BankMortgageSnapshot> {
  let response = await fetchMortgageDetails(page);
  if (!Array.isArray(response?.loanMortgageItems)) {
    // The API may want the mortgage page to have been opened in this session first.
    debug('mortgageDetails not answered directly, opening the mortgage page and trying again');
    try {
      await page.goto(MORTGAGE_PAGE_URL);
      await page.waitForNetworkIdle({ idleTime: 1000, timeout: 20000 });
    } catch (e) {
      debug('opening the mortgage page failed: %s', e instanceof Error ? e.message : String(e));
    }
    response = await fetchMortgageDetails(page);
  }

  const snapshot = parseLeumiMortgageDetails(response);
  for (const mortgage of snapshot.mortgages) {
    const key = digits(mortgage.mortgageNumber);
    try {
      const info = await fetchGetWithinPage<LeumiLoanInfoResponse>(page, `${MORTGAGE_API}/${key}/loanInfo`);
      Object.assign(mortgage, parseLeumiLoanInfo(info, key));
    } catch (e) {
      debug('loanInfo failed for a mortgage: %s', e instanceof Error ? e.message : String(e));
    }
  }
  debug('mortgages: %s, %d found', snapshot.status, snapshot.mortgages.length);
  return snapshot;
}
