import { type Page } from 'puppeteer';
import { type BankCreditFacility } from '../../transactions';

export const unavailableLeumiFacility = (): BankCreditFacility => ({
  status: 'unavailable',
  limit: null,
  temporaryLimit: null,
  used: null,
  remainingCredit: null,
  asOf: null,
  source: 'leumi-credit-table',
});

// Only the checking facility table, never the separate credit-card table.
// Read the bank's total row instead of summing tiers or balance + limit.
export function parseLeumiFacility(rows: string[][]): BankCreditFacility {
  const clean = rows.map(r =>
    r.map(c =>
      c
        .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
        .trim()
        .replace(/\s+/g, ' '),
    ),
  );
  const headers = clean.filter(r => r[0] === 'אשראי בעו"ש' && r.includes('ניצול מהמסגרת') && r.includes('יתרה לניצול'));
  const totals = clean.filter(r => r[0] === 'סה"כ בש"ח');
  if (headers.length !== 1 || totals.length !== 1) return unavailableLeumiFacility();
  const numberAt = (label: string): number | null => {
    const i = headers[0].indexOf(label);
    if (i < 0 || headers[0].lastIndexOf(label) !== i) return null;
    const text = totals[0][i] || '';
    if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(text)) return null;
    const n = Number(text.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  const limit = numberAt('מסגרת אשראי');
  const used = numberAt('ניצול מהמסגרת');
  const remainingCredit = numberAt('יתרה לניצול');
  if (limit === null || limit < 0 || used === null || used < 0 || remainingCredit === null)
    return unavailableLeumiFacility();
  // The page supplies expiry dates, NOT an observation/as-of date. Leave asOf null.
  return {
    status: 'reported',
    limit,
    temporaryLimit: null,
    used,
    remainingCredit,
    asOf: null,
    source: 'leumi-credit-table',
  };
}

export async function readLeumiFacility(page: Page): Promise<BankCreditFacility> {
  try {
    const links = [];
    for (const h of await page.$$('a')) {
      // Exact existing-information link. Never "הקצאת מסגרת אשראי" or an application.
      if (await h.evaluate(e => (e.textContent || '').trim() === 'פירוט מסגרות אשראי')) links.push(h);
    }
    if (links.length !== 1) return unavailableLeumiFacility();
    await links[0].evaluate(e => (e as HTMLElement).click());
    await page.waitForSelector('#tblChecking1', { visible: true, timeout: 15000 });
    const rows = await page.$eval('#tblChecking1', table =>
      Array.from((table as HTMLTableElement).rows, row =>
        Array.from(row.cells, cell => (cell.textContent || '').trim()),
      ),
    );
    return parseLeumiFacility(rows);
  } catch {
    // Optional metadata cannot abort transaction collection. No page/errors logged.
    return unavailableLeumiFacility();
  }
}
