import moment from 'moment';
import {
  applyTransactionDetails,
  convertApprovedTransaction,
  convertVoucher,
  getCardBalance,
  getCardBalanceDate,
  getCardFrame,
  getDetailsCategory,
  getDetailsMemo,
  getVoucherInstallments,
  guessIsIsraelDeal,
  isApprovedTransactionSettled,
  isTransferDetails,
  type ScrapedApprovedTransaction,
  type ScrapedCard,
  type ScrapedTransactionDetails,
  type ScrapedVoucher,
} from './base-isracard-utils';
import { type ScraperOptions } from '../interface';
import { type Transaction } from '../../transactions';

describe('getCardBalance', () => {
  test('negates limitUsed (a positive "amount used" becomes a negative balance)', () => {
    const card = { limitData: { limitUsed: '9564.99', creditLimitAmount: '15500' } } as ScrapedCard;

    expect(getCardBalance(card)).toBe(-9564.99);
  });

  test('returns undefined when the card has no limit data', () => {
    expect(getCardBalance({} as ScrapedCard)).toBeUndefined();
  });

  test('returns undefined when limitUsed is not a number', () => {
    const card = { limitData: { limitUsed: 'n/a', creditLimitAmount: '15500' } } as ScrapedCard;

    expect(getCardBalance(card)).toBeUndefined();
  });
});

describe('getCardFrame', () => {
  test('reads the credit limit as a number', () => {
    const card = { limitData: { limitUsed: '9564.99', creditLimitAmount: '15500' } } as ScrapedCard;

    expect(getCardFrame(card)).toBe(15500);
  });

  test('returns undefined when the card has no limit data', () => {
    expect(getCardFrame({} as ScrapedCard)).toBeUndefined();
  });

  test('returns undefined when creditLimitAmount is not a number', () => {
    const card = { limitData: { limitUsed: '9564.99', creditLimitAmount: 'n/a' } } as ScrapedCard;

    expect(getCardFrame(card)).toBeUndefined();
  });
});

describe('getCardBalanceDate', () => {
  test('parses the next billing date', () => {
    const card = { cardChargeNext: { billingDate: '10/08/2026' } } as ScrapedCard;

    expect(getCardBalanceDate(card)).toBe(moment('10/08/2026', 'DD/MM/YYYY').toISOString());
  });

  test('returns undefined when there is no next billing date', () => {
    expect(getCardBalanceDate({} as ScrapedCard)).toBeUndefined();
  });
});

describe('convertApprovedTransaction', () => {
  const txn: ScrapedApprovedTransaction = {
    purchaseDate: '10/08/2026',
    israelTransactionTime: '14:30',
    businessName: '  שופרסל  ',
    originalAmount: 120,
    currencyIso: 'ILS',
    ilsBillingAmount: 120,
    extraDetails: 'פרטים',
    seqConfirmationNumber: 'REF123',
    branchCodeDescription: '  מזון  ',
  };

  test('negates the amount (approvals report a positive charge, not a signed one)', () => {
    const transaction = convertApprovedTransaction(txn);

    expect(transaction.originalAmount).toBe(-120);
    expect(transaction.chargedAmount).toBe(-120);
  });

  test('combines the purchase date and time into one ISO date, used for both date and processedDate', () => {
    const transaction = convertApprovedTransaction(txn);

    const expected = moment('10/08/2026 14:30', 'DD/MM/YYYY HH:mm').toISOString();
    expect(transaction.date).toBe(expected);
    expect(transaction.processedDate).toBe(expected);
  });

  test('trims the business name and category, and is always pending', () => {
    const transaction = convertApprovedTransaction(txn);

    expect(transaction.description).toBe('שופרסל');
    expect(transaction.category).toBe('מזון');
    expect(transaction.status).toBe('pending');
  });

  test('omits category when branchCodeDescription is missing', () => {
    const transaction = convertApprovedTransaction({ ...txn, branchCodeDescription: null });

    expect(transaction.category).toBeUndefined();
  });

  test('includes the raw transaction only when requested', () => {
    const withRaw = convertApprovedTransaction(txn, { includeRawTransaction: true } as ScraperOptions);
    const withoutRaw = convertApprovedTransaction(txn, { includeRawTransaction: false } as ScraperOptions);

    expect(withRaw.rawTransaction).toBeDefined();
    expect(withoutRaw.rawTransaction).toBeUndefined();
  });
});

describe('isApprovedTransactionSettled', () => {
  const approved: ScrapedApprovedTransaction = {
    purchaseDate: '10/08/2026',
    israelTransactionTime: '14:30',
    businessName: '  שופרסל  ',
    originalAmount: 120,
    currencyIso: 'ILS',
    ilsBillingAmount: 120,
    extraDetails: null,
    seqConfirmationNumber: 'REF123',
    branchCodeDescription: null,
  };
  const matchingVoucher: ScrapedVoucher = {
    purchaseDate: '10/08/2026',
    purchaseTime: null,
    businessName: 'שופרסל',
    originalAmount: 120,
    originalCurrencyIso: 'ILS',
    billingAmount: 120,
    moreInfo: null,
    seqVoucherNumber: 'V999',
    currentInstallmentNum: null,
    numberOfInstallment: null,
    transactionDescription: 'מזון',
  };

  test('matches a voucher for the same date/amount/currency/business name, ignoring surrounding whitespace', () => {
    expect(isApprovedTransactionSettled(approved, [matchingVoucher])).toBe(true);
  });

  test('does not match when the amount differs', () => {
    expect(isApprovedTransactionSettled(approved, [{ ...matchingVoucher, originalAmount: 121 }])).toBe(false);
  });

  test('does not match when the purchase date differs', () => {
    expect(isApprovedTransactionSettled(approved, [{ ...matchingVoucher, purchaseDate: '11/08/2026' }])).toBe(false);
  });

  test('does not match when the currency differs', () => {
    expect(isApprovedTransactionSettled(approved, [{ ...matchingVoucher, originalCurrencyIso: 'USD' }])).toBe(false);
  });

  test('does not match when the business name differs', () => {
    expect(isApprovedTransactionSettled(approved, [{ ...matchingVoucher, businessName: 'Other' }])).toBe(false);
  });

  test('returns false when there are no vouchers', () => {
    expect(isApprovedTransactionSettled(approved, [])).toBe(false);
  });
});

describe('getVoucherInstallments', () => {
  test('returns the current/total pair when both are set', () => {
    const voucher = { currentInstallmentNum: 2, numberOfInstallment: 4 } as ScrapedVoucher;

    expect(getVoucherInstallments(voucher)).toEqual({ number: 2, total: 4 });
  });

  test('returns undefined when numberOfInstallment is missing', () => {
    const voucher = { currentInstallmentNum: 2, numberOfInstallment: null } as ScrapedVoucher;

    expect(getVoucherInstallments(voucher)).toBeUndefined();
  });

  test('returns undefined when currentInstallmentNum is missing', () => {
    const voucher = { currentInstallmentNum: null, numberOfInstallment: 4 } as ScrapedVoucher;

    expect(getVoucherInstallments(voucher)).toBeUndefined();
  });
});

describe('convertVoucher', () => {
  const voucher: ScrapedVoucher = {
    purchaseDate: '10/08/2026',
    purchaseTime: '09:15:00',
    businessName: '  Amazon  ',
    originalAmount: 300,
    originalCurrencyIso: 'USD',
    billingAmount: 1100,
    moreInfo: '  memo  ',
    seqVoucherNumber: 'V123',
    currentInstallmentNum: null,
    numberOfInstallment: null,
    transactionDescription: '  קניות  ',
  };
  const processedDateIso = moment('15/09/2026', 'DD/MM/YYYY').toISOString();

  test('negates the amount, and is always completed', () => {
    const transaction = convertVoucher(voucher, processedDateIso);

    expect(transaction.originalAmount).toBe(-300);
    expect(transaction.chargedAmount).toBe(-1100);
    expect(transaction.status).toBe('completed');
  });

  test('uses the given processedDate as-is, independent of the purchase date', () => {
    const transaction = convertVoucher(voucher, processedDateIso);

    expect(transaction.date).toBe(moment('10/08/2026 09:15:00', 'DD/MM/YYYY HH:mm:ss').toISOString());
    expect(transaction.processedDate).toBe(processedDateIso);
  });

  test('defaults the purchase time to midnight when missing', () => {
    const transaction = convertVoucher({ ...voucher, purchaseTime: null }, processedDateIso);

    expect(transaction.date).toBe(moment('10/08/2026 00:00:00', 'DD/MM/YYYY HH:mm:ss').toISOString());
  });

  test('trims the business name and memo', () => {
    const transaction = convertVoucher(voucher, processedDateIso);

    expect(transaction.description).toBe('Amazon');
    expect(transaction.memo).toBe('memo');
  });

  test('leaves the category unset, since transactionDescription is the deal kind', () => {
    const transaction = convertVoucher({ ...voucher, transactionDescription: 'עסקאות רגילות' }, processedDateIso);

    expect(transaction.category).toBeUndefined();
  });

  test('is an installment transaction only when both installment fields are set', () => {
    const single = convertVoucher(voucher, processedDateIso);
    const installment = convertVoucher(
      { ...voucher, currentInstallmentNum: 2, numberOfInstallment: 4 },
      processedDateIso,
    );

    expect(single.type).toBe('normal');
    expect(single.installments).toBeUndefined();
    expect(installment.type).toBe('installments');
    expect(installment.installments).toEqual({ number: 2, total: 4 });
  });

  test('includes the raw transaction only when requested', () => {
    const withRaw = convertVoucher(voucher, processedDateIso, { includeRawTransaction: true } as ScraperOptions);
    const withoutRaw = convertVoucher(voucher, processedDateIso, { includeRawTransaction: false } as ScraperOptions);

    expect(withRaw.rawTransaction).toBeDefined();
    expect(withoutRaw.rawTransaction).toBeUndefined();
  });
});

describe('guessIsIsraelDeal', () => {
  test('treats a shekel deal as Israeli and any other currency as abroad', () => {
    expect(guessIsIsraelDeal({ originalCurrency: 'ILS' } as Transaction)).toBe(true);
    expect(guessIsIsraelDeal({ originalCurrency: 'USD' } as Transaction)).toBe(false);
  });
});

describe('transaction details', () => {
  const details: ScrapedTransactionDetails = {
    parentBranchDescription: 'רכב ותחבורה',
    branchDescription: ' חניוני רכב ',
    secondBranchDescription: 'רכב - שירותים ואביזרים',
    transferBeneficiary: null,
    transferReason: null,
  };
  const txn = {
    identifier: '383707770',
    description: 'פנגו חשבונית חודשית',
    memo: '',
    status: 'completed',
  } as Transaction;

  test('takes the category from the branch, falling back to the second and parent branches', () => {
    expect(getDetailsCategory(details)).toBe('חניוני רכב');
    expect(getDetailsCategory({ ...details, branchDescription: '  ' })).toBe('רכב - שירותים ואביזרים');
    expect(getDetailsCategory({ ...details, branchDescription: null, secondBranchDescription: null })).toBe(
      'רכב ותחבורה',
    );
    expect(
      getDetailsCategory({
        ...details,
        branchDescription: null,
        secondBranchDescription: null,
        parentBranchDescription: null,
      }),
    ).toBeUndefined();
  });

  test('adds the transfer beneficiary and reason to the memo, without repeating it', () => {
    const transfer = { ...details, transferBeneficiary: 'ישראל ישראלי', transferReason: 'שכר דירה' };

    expect(getDetailsMemo('', transfer)).toBe('ישראל ישראלי שכר דירה');
    expect(getDetailsMemo('שכר דירה', transfer)).toBe('שכר דירה ישראל ישראלי');
    expect(getDetailsMemo('memo', details)).toBe('memo');
  });

  test('is a transfer when it names a beneficiary or a reason', () => {
    expect(isTransferDetails(details)).toBe(false);
    expect(isTransferDetails({ ...details, transferBeneficiary: ' ' })).toBe(false);
    expect(isTransferDetails({ ...details, transferBeneficiary: 'ישראל ישראלי' })).toBe(true);
    expect(isTransferDetails({ ...details, transferReason: 'שכר דירה' })).toBe(true);
  });

  test('applies the category and memo, keeping the existing category when details have none', () => {
    const noCategory = { ...details, branchDescription: null, secondBranchDescription: null, parentBranchDescription: null };

    expect(applyTransactionDetails(txn, details)).toEqual({ ...txn, category: 'חניוני רכב', memo: '' });
    expect(applyTransactionDetails({ ...txn, category: 'x' }, noCategory).category).toBe('x');
  });

  test('appends the details to the raw transaction only when requested', () => {
    const withRaw = applyTransactionDetails(
      { ...txn, rawTransaction: { seqVoucherNumber: '383707770' } },
      details,
      { includeRawTransaction: true } as ScraperOptions,
    );

    expect(Array.isArray(withRaw.rawTransaction)).toBe(true);
    expect(applyTransactionDetails(txn, details).rawTransaction).toBeUndefined();
  });
});
