import { type Page } from 'puppeteer';
import { parseLeumiLoans } from './leumi-loans';
import { parseLeumiLoanDetails, readLeumiLoanDetails } from './leumi-loan-details';

// Real label structure; all account IDs, amounts, dates, rates and counts synthetic.
const summary = () =>
  parseLeumiLoans([
    ['הלוואה', 'חשבון', 'סכום הלוואה מקורי', 'תאריך סיום', 'נכון לתאריך', 'יתרה משוערכת'],
    ['בדיקה 8765-4/3', '876-12345/67', '54,321.00', '12/07/32', '03/04/28', '32,456.78'],
  ]);
const binding = { sourceAccountRaw: '876-12345/67', linkIndex: '7', currentIndex: '7' };
const rows = [
  ['חשבון:', '876-12345/67'],
  ['מספר הלוואה:', '12345678'],
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
  const result = parseLeumiLoanDetails(rows, binding);
  expect(result).toEqual({
    status: 'reported',
    source: 'leumi-loan-detail',
    detailSourceId: expect.stringMatching(/^[a-f0-9]{64}$/),
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
  expect(parseLeumiLoanDetails(rows, { ...binding, currentIndex: '8' }).status).toBe('unavailable');
  expect(parseLeumiLoanDetails([...rows, rows[0]], binding).status).toBe('unavailable');
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
  const result = parseLeumiLoanDetails(data, binding);
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
      binding,
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

test('unique explicit row links bind distinct detail numbers; duplicate indexes, reused identities and redirected indexes fail closed', async () => {
  for (const scenario of ['valid', 'duplicate-index', 'duplicate-detail', 'redirect', 'wrong-account']) {
    const header = ['הלוואה', 'חשבון', 'סכום הלוואה מקורי', 'תאריך סיום', 'נכון לתאריך', 'יתרה משוערכת'];
    const first = ['בדיקה 8765-4/3', '876-12345/67', '54,321.00', '12/07/32', '03/04/28', '32,456.78'];
    const second = ['בדיקה 8766-5/4', '876-12345/67', '23,456.00', '12/07/32', '03/04/28', '12,345.00'];
    const data = parseLeumiLoans([header, first, second]);
    let current = 'https://bank.example/summary';
    const page = {
      url: () => current,
      $eval: jest.fn().mockResolvedValue([
        { cells: header, links: [] },
        { cells: first, links: ['https://bank.example/eBanking/LoanAndMortgages/DisplayLoanActivity.aspx?index=7'] },
        {
          cells: second,
          links: [
            `https://bank.example/eBanking/LoanAndMortgages/DisplayLoanActivity.aspx?index=${scenario === 'duplicate-index' ? '7' : '8'}`,
          ],
        },
      ]),
      goto: jest.fn((url: string) => {
        current = scenario === 'redirect' ? url.replace(/index=\d+/, 'index=99') : url;
        return Promise.resolve();
      }),
      waitForFunction: jest.fn().mockResolvedValue(undefined),
      evaluate: jest.fn(() =>
        Promise.resolve(
          rows.map(([label, value]) => [
            label,
            label === 'מספר הלוואה:'
              ? current.endsWith('index=7') || scenario === 'duplicate-detail'
                ? '12345678'
                : '87654321'
              : label === 'חשבון:' && scenario === 'wrong-account'
                ? '875-12345/67'
                : value,
          ]),
        ),
      ),
    };
    await readLeumiLoanDetails(page as unknown as Page, data);
    expect(data.loans.map(l => l.details?.status)).toEqual(
      scenario === 'valid' ? ['reported', 'reported'] : ['unavailable', 'unavailable'],
    );
    if (scenario === 'duplicate-index') expect(page.goto).not.toHaveBeenCalled();
    expect(data.status).toBe('reported');
  }
});
