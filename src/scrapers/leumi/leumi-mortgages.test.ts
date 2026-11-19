import { type Page } from 'puppeteer';
import { fetchGetWithinPage } from '../../helpers/fetch';
import {
  fetchLeumiMortgages,
  type LeumiLoanInfoResponse,
  type LeumiMortgageDetailsResponse,
  parseLeumiLoanInfo,
  parseLeumiMortgageDetails,
  parseShortDate,
} from './leumi-mortgages';

jest.mock('../../helpers/fetch');
const mockFetch = fetchGetWithinPage as jest.MockedFunction<typeof fetchGetWithinPage>;

// The shape of the live responses (2026-11), with made-up figures and numbers.
const mortgageDetails = (): LeumiMortgageDetailsResponse => ({
  clearingBalanceAll: 900000.5,
  loanMortgageItems: [
    {
      MortgageDetail: {
        mortgageKey: '1012345670160',
        mortgageKeyFormatted: '10-1234567-01-60',
        dayOfPayment: 15,
        clearingBalance: 900000.5,
        clearingCommission: 700.25,
        arrearsTotalAmount: 0,
        mortgageAmount: 1500000,
        bookingDate: '22.03.20',
        lastPaymentAmount: 6500.4,
        mortgageEndDate: '15.04.50',
        portfolioAccountsItems: [{ portfolioAccountNum: '10-123-4567890' }],
        balanceItems: [
          {
            clearingBalance: 900000.5,
            validityDate: '2026-11-17T00:00:00',
            fundBalance: 870000.1,
            linkageEstimatedBalance: 29000.15,
          },
        ],
      },
    },
  ],
});

const track = (overrides: object) => ({
  productName: 'ריבית קבועה לא צמודה',
  loanId: '01',
  annualInterestPercent: 2.46,
  lastPaymentAmount: 3000.1,
  clearingTableDescription: 'שפיצר',
  loanCreditDate: '22.03.20',
  calculateEndDate: '15.04.37',
  clearingBalance: 300000,
  commissionFreeBalance: 300000,
  fundBalance: 299950,
  linkageEstimatedBalance: 0,
  loanAmount: 500000,
  anchorSpreadRate: null,
  percentChgDate: null,
  linkageBase: 'לא',
  interestType: 'FIXED',
  loanFirstPayDate: '2020-05-15',
  paymentItems: [
    { paymentDate: '11.2026', paymentAmount: 6500.4 },
    { paymentDate: '10.2026', paymentAmount: 6480.2 },
  ],
  ...overrides,
});

const loanInfo = (): LeumiLoanInfoResponse => ({
  MortgageDetails: {
    mortgageKey: '1012345670160',
    loansItems: [
      track({}),
      track({
        productName: 'ריבית עוגן אג"ח צמוד משתנה כל 5 שנים שפיצר',
        loanId: '02',
        annualInterestPercent: 4.2,
        calculateEndDate: '15.04.50',
        clearingBalance: 200304.13,
        commissionFreeBalance: 200000,
        linkageEstimatedBalance: 29000.15,
        anchorSpreadRate: 'עוגן + % 2.30',
        percentChgDate: '2030-04-15T00:00:00',
        linkageBase: '100% הצמדה למדד',
        interestType: 'VARIABLE',
      }),
      track({
        productName: 'ריבית פריים',
        loanId: '03',
        anchorSpreadRate: 'פריים - % 0.55',
        interestType: 'VARIABLE',
        calculateEndDate: '15.04.50',
      }),
    ],
  },
});

describe('parseShortDate', () => {
  test('reads a two-digit year as 20YY', () => {
    expect(parseShortDate('15.04.50')).toBe('2050-04-15');
    expect(parseShortDate('22.03.20')).toBe('2020-03-22');
    expect(parseShortDate('01.01.75')).toBe('2075-01-01');
  });

  test('rejects anything else', () => {
    expect(parseShortDate('2050-04-15')).toBeNull();
    expect(parseShortDate(null)).toBeNull();
  });
});

describe('parseLeumiMortgageDetails', () => {
  test('reads a mortgage and its balances', () => {
    const snapshot = parseLeumiMortgageDetails(mortgageDetails());
    expect(snapshot.status).toBe('reported');
    expect(snapshot.mortgages).toHaveLength(1);
    expect(snapshot.mortgages[0]).toEqual({
      mortgageNumber: '10-1234567-01-60',
      originalAmount: 1500000,
      payoffBalance: 900000.5,
      principalBalance: 870000.1,
      linkageBalance: 29000.15,
      earlyRepaymentFee: 700.25,
      balanceAsOf: '2026-11-17',
      startDate: '2020-03-22',
      endDate: '2050-04-15',
      paymentDayOfMonth: 15,
      lastPaymentAmount: 6500.4,
      arrears: 0,
      paidFromAccounts: ['101234567890'],
      tracksStatus: 'unavailable',
      tracks: [],
      recentPayments: [],
    });
  });

  test('an empty list is the bank saying there is no mortgage', () => {
    expect(parseLeumiMortgageDetails({ loanMortgageItems: [] })).toEqual({
      status: 'reported',
      source: 'leumi-mortgage-api',
      mortgages: [],
    });
  });

  test('a missing list, an error body or an unreadable mortgage is unavailable', () => {
    expect(parseLeumiMortgageDetails(null).status).toBe('unavailable');
    expect(parseLeumiMortgageDetails({} as LeumiMortgageDetailsResponse).status).toBe('unavailable');
    const broken = mortgageDetails();
    broken.loanMortgageItems![0].MortgageDetail!.clearingBalance = null;
    broken.loanMortgageItems![0].MortgageDetail!.balanceItems = [];
    expect(parseLeumiMortgageDetails(broken).status).toBe('unavailable');
  });
});

describe('parseLeumiLoanInfo', () => {
  test('reads every track and the mortgage payments once', () => {
    const result = parseLeumiLoanInfo(loanInfo(), '1012345670160');
    expect(result.tracksStatus).toBe('reported');
    expect(result.tracks.map(t => t.trackId)).toEqual(['01', '02', '03']);
    expect(result.tracks[0]).toEqual({
      trackId: '01',
      name: 'ריבית קבועה לא צמודה',
      originalAmount: 500000,
      payoffBalance: 300000,
      balanceWithoutFees: 300000,
      principalBalance: 299950,
      linkageBalance: 0,
      annualInterestPercent: 2.46,
      interestType: 'fixed',
      rateAnchorText: null,
      nextRateChangeDate: null,
      cpiLinked: false,
      amortization: 'שפיצר',
      lastPaymentAmount: 3000.1,
      startDate: '2020-03-22',
      firstPaymentDate: '2020-05-15',
      endDate: '2037-04-15',
    });
    expect(result.tracks[1]).toMatchObject({
      interestType: 'variable',
      cpiLinked: true,
      rateAnchorText: 'עוגן + % 2.30',
      nextRateChangeDate: '2030-04-15',
      linkageBalance: 29000.15,
      payoffBalance: 200304.13,
      balanceWithoutFees: 200000,
    });
    expect(result.tracks[2]).toMatchObject({ interestType: 'variable', cpiLinked: false });
    expect(result.recentPayments).toEqual([
      { month: '2026-11', amount: 6500.4 },
      { month: '2026-10', amount: 6480.2 },
    ]);
  });

  test('another mortgage, no tracks or a track without an id is unavailable', () => {
    expect(parseLeumiLoanInfo(loanInfo(), '999').tracksStatus).toBe('unavailable');
    expect(parseLeumiLoanInfo({ MortgageDetails: { loansItems: [] } }, '1012345670160').tracksStatus).toBe(
      'unavailable',
    );
    const noId = loanInfo();
    noId.MortgageDetails!.loansItems![1].loanId = null;
    expect(parseLeumiLoanInfo(noId, '1012345670160').tracksStatus).toBe('unavailable');
    expect(parseLeumiLoanInfo(null, '1012345670160').tracksStatus).toBe('unavailable');
  });
});

describe('fetchLeumiMortgages', () => {
  const goto = jest.fn().mockResolvedValue(undefined);
  const page = { goto, waitForNetworkIdle: jest.fn().mockResolvedValue(undefined) } as unknown as Page;

  beforeEach(() => {
    mockFetch.mockReset();
    goto.mockClear();
  });

  test('reads the mortgages and then each one by its number without dashes', async () => {
    mockFetch.mockResolvedValueOnce(mortgageDetails()).mockResolvedValueOnce(loanInfo());
    const snapshot = await fetchLeumiMortgages(page);
    expect(mockFetch.mock.calls.map(call => call[1])).toEqual([
      'https://hb2.bankleumi.co.il/uiapiproxy/v1/digital-retails/mobile/mortgageDetails',
      'https://hb2.bankleumi.co.il/uiapiproxy/v1/digital-retails/mobile/1012345670160/loanInfo',
    ]);
    expect(goto).not.toHaveBeenCalled();
    expect(snapshot.status).toBe('reported');
    expect(snapshot.mortgages[0].tracks).toHaveLength(3);
  });

  test('opens the mortgage page and tries again when the API does not answer at first', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('500'))
      .mockResolvedValueOnce(mortgageDetails())
      .mockResolvedValueOnce(loanInfo());
    const snapshot = await fetchLeumiMortgages(page);
    expect(goto).toHaveBeenCalledWith(
      'https://hb2.bankleumi.co.il/eBanking/SO/SPA.aspx#/ts/reactFrame?action=mortgages',
    );
    expect(snapshot.status).toBe('reported');
  });

  test('keeps the mortgage when its tracks cannot be read', async () => {
    mockFetch.mockResolvedValueOnce(mortgageDetails()).mockRejectedValueOnce(new Error('500'));
    const snapshot = await fetchLeumiMortgages(page);
    expect(snapshot.status).toBe('reported');
    expect(snapshot.mortgages[0]).toMatchObject({ payoffBalance: 900000.5, tracksStatus: 'unavailable' });
  });

  test('is unavailable when the API never answers', async () => {
    mockFetch.mockRejectedValue(new Error('500'));
    expect((await fetchLeumiMortgages(page)).status).toBe('unavailable');
  });
});
