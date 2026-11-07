import { type Page } from 'puppeteer';
import { parseLeumiLoans } from './leumi-loans';
import { parseLeumiLoanDetails, readLeumiLoanDetails } from './leumi-loan-details';

// Real label structure; all account IDs, amounts, dates, rates and counts synthetic.
const summary = () =>
  parseLeumiLoans([
    ['הלוואה', 'חשבון', 'סכום הלוואה מקורי', 'תאריך סיום', 'נכון לתאריך', 'יתרה משוערכת'],
    ['בדיקה 8765-4/3', '876-12345/67', '54,321.00', '12/07/32', '03/04/28', '32,456.78'],
  ]);
const rows = [
  ['חשבון:', '876-12345/67'],
  ['מספר הלוואה:', '8765-4/3'],
  ['נכון לתאריך:', '03/04/28'],
  ['תשלומים שנותרו:', '17'],
  ['יתרת קרן:', '32,100.05'],
  ['סכום התשלום הבא:', '876.54'],
  ['תאריך התשלום הבא:', '12/05/28'],
  ['שיעור ריבית:', '4.875%'],
  ['סוג הצמדה:', 'לא צמוד'],
  ['תאריך העמדת הלוואה', '12/07/26'],
  ['תאריך סיום:', '12/07/32'],
];

test('detail identity is checked and exact labels preserve remaining count, principal, rate precision and dates', () => {
  const result = parseLeumiLoanDetails(rows, summary().loans[0].sourceId);
  expect(result).toEqual({
    status: 'reported',
    source: 'leumi-loan-detail',
    bankAsOf: '2028-04-03',
    principalBalance: 32100.05,
    remainingPayments: 17,
    nextPaymentAmount: 876.54,
    nextPaymentDate: '2028-05-12',
    interestRatePercent: 4.875,
    interestRateText: '4.875%',
    indexation: 'לא צמוד',
    bankStartDate: '2026-07-12',
    bankEndDate: '2032-07-12',
  });
  expect(result).not.toHaveProperty('paidPayments');
  expect(result).not.toHaveProperty('totalPayments');
  expect(parseLeumiLoanDetails(rows, 'a'.repeat(64)).status).toBe('unavailable');
  expect(parseLeumiLoanDetails([...rows, rows[0]], summary().loans[0].sourceId).status).toBe('unavailable');
});

test('zero is explicit, malformed/missing detail values and epoch placeholder remain unknown', () => {
  const data = rows.map(([k, v]) => [
    k,
    k === 'תשלומים שנותרו:'
      ? '0'
      : k === 'יתרת קרן:'
        ? '0.00'
        : k === 'תאריך התשלום הבא:'
          ? '01/01/70'
          : k === 'שיעור ריבית:'
            ? 'פריים + מרווח'
            : v,
  ]);
  const result = parseLeumiLoanDetails(data, summary().loans[0].sourceId);
  expect(result).toMatchObject({
    principalBalance: 0,
    remainingPayments: 0,
    nextPaymentDate: null,
    interestRatePercent: null,
    interestRateText: 'פריים + מרווח',
  });
  expect(
    parseLeumiLoanDetails(
      rows.filter(r => r[0] !== 'נכון לתאריך:'),
      summary().loans[0].sourceId,
    ).status,
  ).toBe('unavailable');
});

test('optional acquisition failures preserve summary and unsafe or cross-origin links are never followed', async () => {
  const data = summary();
  const header = ['הלוואה', 'חשבון', 'סכום הלוואה מקורי', 'תאריך סיום', 'נכון לתאריך', 'יתרה משוערכת'];
  const cells = ['בדיקה 8765-4/3', '876-12345/67', '54,321.00', '12/07/32', '03/04/28', '32,456.78'];
  const page = {
    url: () => 'https://bank.example/summary',
    $eval: jest.fn().mockResolvedValue([
      { cells: header, links: [] },
      {
        cells,
        links: [
          'https://other.example/eBanking/LoanAndMortgages/DisplayLoanActivity.aspx',
          'https://bank.example/apply/new-loan',
        ],
      },
    ]),
    goto: jest.fn(),
  };
  await readLeumiLoanDetails(page as unknown as Page, data);
  expect(page.goto).not.toHaveBeenCalled();
  expect(data.status).toBe('reported');
  expect(data.loans[0].details?.status).toBe('unavailable');
  page.$eval.mockRejectedValueOnce(new Error('synthetic acquisition failure'));
  await expect(readLeumiLoanDetails(page as unknown as Page, data)).resolves.toBeUndefined();
  expect(data.loans[0].revaluedBalance).toBe(32456.78);
});
