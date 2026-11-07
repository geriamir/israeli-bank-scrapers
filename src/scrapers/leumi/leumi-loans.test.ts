import { type Page } from 'puppeteer';
import { parseLeumiLoans, readLeumiLoans } from './leumi-loans';

// Source-shaped but synthetic IDs, amounts and dates only.
const header = ['הלוואה', 'חשבון', 'סכום הלוואה מקורי', 'תאריך סיום', 'נכון לתאריך', 'יתרה משוערכת'];
const row = [
  '\u200fמסלול בדיקה 9876-1/7\u200e',
  '\u200f999-54321/76\u200f',
  '72,345.00',
  '12/08/33',
  '03/04/28',
  '61,234.56',
];
const rows = [
  header,
  row,
  ['מסלול בדיקה 9877-2/8', '999-54321/76', '23,456.00', '09/09/29', '03/04/28', '0.00'],
  ['סה"כ בש"ח:', '61,234.56'],
];

test('preserves exact bank balance semantics and dates, including zero rows without inferred terms', () => {
  const result = parseLeumiLoans(rows);
  expect(result.status).toBe('reported');
  expect(result.loans).toHaveLength(2);
  expect(result.loans[0]).toMatchObject({
    originalAmount: 72345,
    revaluedBalance: 61234.56,
    bankAsOf: '2028-04-03',
    bankEndDate: '2033-08-12',
  });
  expect(result.loans[1].revaluedBalance).toBe(0);
  expect(Object.keys(result.loans[0]).sort()).toEqual(
    [
      'bankAsOf',
      'bankEndDate',
      'originalAmount',
      'referenceLast4',
      'revaluedBalance',
      'sourceId',
      'sourceAccountRaw',
    ].sort(),
  );
});
test('identity survives row reordering, label and amount/date changes, but differs by bank account and loan reference', () => {
  const id = parseLeumiLoans(rows).loans[0].sourceId;
  expect(id).toMatch(/^[a-f0-9]{64}$/);
  expect(parseLeumiLoans([header, rows[2], row, rows[3]]).loans[1].sourceId).toBe(id);
  expect(
    parseLeumiLoans([header, ['תיאור אחר 9876-1/7', row[1], '80,000.00', '13/08/33', '04/04/28', '60,000.00']]).loans[0]
      .sourceId,
  ).toBe(id);
  expect(parseLeumiLoans([header, [row[0], '998-54321/76', ...row.slice(2)]]).loans[0].sourceId).not.toBe(id);
  expect(parseLeumiLoans(rows).loans[1].sourceId).not.toBe(id);
});
test('ambiguous identity, missing rows, malformed numbers/dates and changed headers are unavailable, not zero debt', () => {
  for (const data of [
    [header],
    [header, row, row],
    [header, [...row.slice(0, 5), '61,23.00']],
    [header, [row[0], row[1], row[2], row[3], '31/02/28', row[5]]],
    [header, ['מסלול ללא מזהה', ...row.slice(1)]],
    [['הלוואה', 'חשבון', 'סכום אחר', ...header.slice(3)], row],
  ])
    expect(parseLeumiLoans(data).status).toBe('unavailable');
});
test('optional loan page failure does not reject transaction collection', async () => {
  const page = { $$: jest.fn().mockRejectedValue(new Error('synthetic optional page failure')) };
  await expect(readLeumiLoans(page as unknown as Page)).resolves.toMatchObject({ status: 'unavailable', loans: [] });
});

function navigationPage(labels: Array<{ text: string; visible?: boolean }>) {
  const clicked: string[] = [];
  const page = {
    waitForFunction: jest.fn().mockResolvedValue(undefined),
    $$: jest.fn().mockResolvedValue(
      labels.map(({ text, visible = true }) => ({
        evaluate: (fn: (e: unknown) => unknown) =>
          Promise.resolve(
            fn({
              textContent: text,
              getBoundingClientRect: () => ({ width: visible ? 20 : 0, height: visible ? 10 : 0 }),
              click: () => clicked.push(text),
            }),
          ),
      })),
    ),
    waitForSelector: jest.fn().mockResolvedValue(undefined),
    $eval: jest.fn().mockResolvedValue(rows),
  };
  return { page, clicked };
}

test('normal-flow Loans menu opens summary even when summary exists only as a page heading', async () => {
  const { page, clicked } = navigationPage([
    { text: 'הלוואות' },
    { text: 'הלוואות', visible: false },
    { text: 'הלוואה חדשה' },
    { text: 'בקשת הלוואה' },
    { text: 'פירעון הלוואה' },
  ]);
  expect((await readLeumiLoans(page as unknown as Page)).status).toBe('reported');
  expect(clicked).toEqual(['הלוואות']);
  expect(page.waitForSelector).toHaveBeenCalledWith('#TableNIS1', { visible: true, timeout: 15000 });
});

test('exact visible summary link remains supported and ambiguous menus never click', async () => {
  const summary = navigationPage([{ text: 'ריכוז הלוואות' }, { text: 'הלוואות' }]);
  expect((await readLeumiLoans(summary.page as unknown as Page)).status).toBe('reported');
  expect(summary.clicked).toEqual(['ריכוז הלוואות']);
  for (const labels of [
    [{ text: 'הלוואות' }, { text: 'הלוואות' }],
    [{ text: 'הלוואה חדשה' }, { text: 'הקמת הלוואה' }, { text: 'הלוואות וערבויות' }],
  ]) {
    const { page, clicked } = navigationPage(labels);
    expect((await readLeumiLoans(page as unknown as Page)).status).toBe('unavailable');
    expect(clicked).toEqual([]);
  }
});

test('table readiness rejects the visible shell and partial rows, accepts any populated loan count', async () => {
  const { page } = navigationPage([{ text: 'הלוואות' }]);
  await readLeumiLoans(page as unknown as Page);
  const ready = page.waitForFunction.mock.calls[1][0] as () => boolean;
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const check = (data: string[][]) => {
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        querySelector: () => ({ rows: data.map(cells => ({ cells: cells.map(textContent => ({ textContent })) })) }),
      },
    });
    return ready();
  };
  try {
    expect(check([])).toBe(false);
    expect(check([header])).toBe(false);
    expect(check([header, row, ['סה"כ בש"ח:', '']])).toBe(false);
    expect(check([header, [...row.slice(0, 5), ''], rows[3]])).toBe(false);
    expect(check([header, row, rows[3]])).toBe(true);
    expect(check(rows)).toBe(true);
  } finally {
    if (original) Object.defineProperty(globalThis, 'document', original);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('readiness timeout remains unavailable and never reads partial balances', async () => {
  const { page } = navigationPage([{ text: 'הלוואות' }]);
  page.waitForFunction.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('synthetic timeout'));
  expect((await readLeumiLoans(page as unknown as Page)).status).toBe('unavailable');
  expect(page.$eval).not.toHaveBeenCalled();
});

test('source binding requires actual source-column equality with selected checking identity', async () => {
  for (const [account, expected] of [
    ['9995432176', '9995432176'],
    ['9985432176', null],
  ]) {
    const { page } = navigationPage([{ text: 'הלוואות' }]);
    const result = await readLeumiLoans(page as unknown as Page, account || undefined);
    expect(result.loans[0].sourceAccountRaw).toBe('999-54321/76');
    expect(result.loans[0].sourceAccountNumber).toBe(expected);
  }
});
