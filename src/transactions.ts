export type BankLoanDetails =
  | { status: 'unavailable'; source: 'leumi-loan-detail' }
  | {
      status: 'reported';
      source: 'leumi-loan-detail';
      detailSourceId: string;
      bankAsOf: string;
      principalBalance: number | null;
      remainingPayments: number | null;
      nextPaymentAmount: number | null;
      nextPaymentDate: string | null;
      interestRatePercent: number | null;
      interestRateText: string | null;
      indexation: string | null;
      bankStartDate: string | null;
      bankEndDate: string | null;
    };

export interface BankLoanSnapshot {
  status: 'reported' | 'unavailable';
  source: 'leumi-loan-summary';
  loans: Array<{
    sourceId: string;
    referenceLast4: string;
    originalAmount: number;
    revaluedBalance: number;
    bankAsOf: string;
    bankEndDate: string | null;
    sourceAccountRaw?: string;
    sourceAccountNumber?: string | null;
    details?: BankLoanDetails;
  }>;
}

// One track (מסלול) of a mortgage, as the bank's mortgage page reports it.
export interface BankMortgageTrack {
  trackId: string;
  name: string;
  originalAmount: number | null;
  // What it would take to repay the track today, early-repayment fees included.
  payoffBalance: number | null;
  // What is owed on the track without fees: principal, CPI linkage and the interest
  // accrued since the last payment. The tracks' add up to the mortgage's payoff
  // balance less its early-repayment fee.
  balanceWithoutFees: number | null;
  // Principal still owed, before CPI linkage and fees.
  principalBalance: number | null;
  // How much CPI linkage has added to the principal (0 for an unlinked track).
  linkageBalance: number | null;
  annualInterestPercent: number | null;
  interestType: 'fixed' | 'variable' | null;
  // The rate's anchor and spread as the bank words it, e.g. "פריים - % 0.55".
  rateAnchorText: string | null;
  nextRateChangeDate: string | null;
  cpiLinked: boolean | null;
  amortization: string | null;
  lastPaymentAmount: number | null;
  startDate: string | null;
  firstPaymentDate: string | null;
  endDate: string | null;
}

export interface BankMortgage {
  // The bank's mortgage number, e.g. "10-2137718-01-60".
  mortgageNumber: string;
  originalAmount: number | null;
  payoffBalance: number;
  principalBalance: number | null;
  linkageBalance: number | null;
  earlyRepaymentFee: number | null;
  balanceAsOf: string | null;
  startDate: string | null;
  endDate: string | null;
  paymentDayOfMonth: number | null;
  lastPaymentAmount: number | null;
  arrears: number | null;
  // Accounts the mortgage is paid from, digits only (e.g. "106804914641").
  paidFromAccounts: string[];
  tracksStatus: 'reported' | 'unavailable';
  tracks: BankMortgageTrack[];
  // What was paid for the whole mortgage each month, latest first ("YYYY-MM").
  recentPayments: Array<{ month: string; amount: number }>;
}

export interface BankMortgageSnapshot {
  // 'reported' with no mortgages means the bank answered that there are none.
  status: 'reported' | 'unavailable';
  source: 'leumi-mortgage-api';
  mortgages: BankMortgage[];
}

export interface BankCreditFacility {
  status: 'reported' | 'unavailable';
  limit: number | null;
  temporaryLimit: number | null;
  used: number | null;
  remainingCredit: number | null;
  asOf: string | null;
  source: 'mizrahi-credit-modal' | 'leumi-credit-table';
}

export interface TransactionsAccount {
  bankLoans?: BankLoanSnapshot;
  bankMortgages?: BankMortgageSnapshot;
  bankCreditFacility?: BankCreditFacility;
  accountNumber: string;
  balance?: number;
  balanceDate?: string;
  cardFrame?: number;
  cardType?: CardType;
  currency?: string;
  savingsAccount?: boolean;
  txns: Transaction[];
  securities?: Security[];
}

export enum CardType {
  BankIssued = 'bankIssued',
  CompanyIssued = 'companyIssued',
}

export enum TransactionTypes {
  Normal = 'normal',
  Installments = 'installments',
}

export enum TransactionStatuses {
  Completed = 'completed',
  Pending = 'pending',
}

export interface TransactionInstallments {
  /**
   * the current installment number
   */
  number: number;

  /**
   * the total number of installments
   */
  total: number;
}

export interface Transaction {
  type: TransactionTypes;
  /**
   * sometimes called Asmachta
   */
  identifier?: string | number;
  /**
   * ISO date string
   */
  date: string;
  /**
   * ISO date string
   */
  processedDate: string;
  originalAmount: number;
  originalCurrency: string;
  chargedAmount: number;
  chargedCurrency?: string;
  description: string;
  memo?: string;
  status: TransactionStatuses;
  installments?: TransactionInstallments;
  category?: string;
  rawTransaction?: unknown;
}

/**
 * A single security holding within an investment account.
 */
export interface Security {
  name?: string;
  symbol: string;
  volume: number;
  value: number;
  currency?: string;
  changePercentage?: number;
  profitLoss?: number;
}
