import { parseLeumiFacility } from './leumi-credit-facility';

// Synthetic identifiers/amounts/rates/dates only; bank-shaped headings and rows.
const fixture = [
  ['אשראי בעו"ש', 'מסגרת אשראי', 'ניצול מהמסגרת', 'יתרה לניצול', 'תוקף*', '% ריבית תעריפית (מתואמת)'],
  ['מדרג 1', '3,800.00', '250.00', '3,550.00', '15/01/2029', '2.35 (2.41)'],
  ['מדרג 2', '8,200.00', '0.00', '8,200.00', '15/01/2029', '3.65 (3.71)'],
  ['סה"כ בש"ח', '12,000.00', '250.00', '11,750.00', '', ''],
];

test('reads reported checking total/usage/remaining and never treats expiry as as-of', () => {
  expect(parseLeumiFacility(fixture)).toEqual({
    status: 'reported',
    limit: 12000,
    temporaryLimit: null,
    used: 250,
    remainingCredit: 11750,
    asOf: null,
    source: 'leumi-credit-table',
  });
});
test('bank-reported remaining may differ from limit minus used; no inferred value replaces it', () => {
  const rows = fixture.map(r => [...r]);
  rows[3][3] = '10,500.00';
  expect(parseLeumiFacility(rows).remainingCredit).toBe(10500);
  rows[3][3] = '-25.00';
  expect(parseLeumiFacility(rows).remainingCredit).toBe(-25);
});
test('explicit zero is valid, but absent/malformed/ambiguous checking totals and card tables are unavailable', () => {
  const rows = fixture.map(r => [...r]);
  rows[3] = ['סה"כ בש"ח', '0.00', '0.00', '0.00', '', ''];
  expect(parseLeumiFacility(rows).limit).toBe(0);
  expect(parseLeumiFacility(fixture.slice(0, 3)).status).toBe('unavailable');
  expect(parseLeumiFacility([...fixture, fixture[3]]).status).toBe('unavailable');
  rows[3][1] = '12,00.00';
  expect(parseLeumiFacility(rows).status).toBe('unavailable');
  expect(
    parseLeumiFacility([
      ['', 'מסגרת אשראי', 'יתרה לניצול'],
      ['סה"כ בש"ח', '99,000.00', '88,000.00'],
    ]).status,
  ).toBe('unavailable');
});

import { readLeumiFacility } from './leumi-credit-facility';
import { type Page } from 'puppeteer';

test('missing or failed optional facility navigation cannot abort collection', async () => {
  const page = { $$: jest.fn().mockRejectedValue(new Error('fixture unavailable')) };
  await expect(readLeumiFacility(page as unknown as Page)).resolves.toMatchObject({ status: 'unavailable' });
});
