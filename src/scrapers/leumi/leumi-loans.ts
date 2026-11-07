import { createHash } from 'crypto';
import moment from 'moment';
import { type Page } from 'puppeteer';
import { type BankLoanSnapshot } from '../../transactions';

const SOURCE = 'leumi-loan-summary' as const;
export const unavailableLeumiLoans = (): BankLoanSnapshot => ({ status: 'unavailable', source: SOURCE, loans: [] });
const clean = (s: string) =>
  s
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim()
    .replace(/\s+/g, ' ');

// Existing loan information only. The bank calls this balance "יתרה משוערכת";
// it is not principal, a payoff quote or input for an amortization calculation.
export function parseLeumiLoans(rows: string[][]): BankLoanSnapshot {
  const table = rows.map(r => r.map(clean));
  const labels = ['הלוואה', 'חשבון', 'סכום הלוואה מקורי', 'תאריך סיום', 'נכון לתאריך', 'יתרה משוערכת'];
  const headers = table.filter(r => labels.every(label => r.filter(c => c === label).length === 1));
  if (headers.length !== 1) return unavailableLeumiLoans();
  const header = headers[0];
  const loans: BankLoanSnapshot['loans'] = [];
  const identities = new Set<string>();
  const money = (s: string): number | null =>
    /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(s) && Number.isFinite(Number(s.replace(/,/g, '')))
      ? Number(s.replace(/,/g, ''))
      : null;
  const date = (s: string): string | null => {
    if (!s || s === '-') return null;
    const parsed = moment(s, ['DD/MM/YYYY', 'DD/MM/YY'], true);
    return parsed.isValid() ? parsed.format('YYYY-MM-DD') : null;
  };
  for (const row of table) {
    if (row === header || row.every(c => !c)) continue;
    const value = (label: string) => row[header.indexOf(label)] || '';
    const name = value('הלוואה');
    if (/^סה["״']*כ/.test(name) || /^סה["״']*כ/.test(row[0] || '')) continue;
    const reference = /(?:^|\s)(\d+-\d+\/\d+)$/.exec(name)?.[1];
    const account = value('חשבון');
    if (!reference || !/^\d+-\d+\/\d+$/.test(account)) return unavailableLeumiLoans();
    const sourceId = createHash('sha256')
      .update(JSON.stringify([SOURCE, account, reference]))
      .digest('hex');
    const originalAmount = money(value('סכום הלוואה מקורי'));
    const revaluedBalance = money(value('יתרה משוערכת'));
    const bankAsOf = date(value('נכון לתאריך'));
    const bankEndDate = date(value('תאריך סיום'));
    if (
      identities.has(sourceId) ||
      originalAmount === null ||
      revaluedBalance === null ||
      !bankAsOf ||
      (value('תאריך סיום') && value('תאריך סיום') !== '-' && !bankEndDate)
    )
      return unavailableLeumiLoans();
    identities.add(sourceId);
    loans.push({
      sourceId,
      referenceLast4: reference.replace(/\D/g, '').slice(-4),
      originalAmount,
      revaluedBalance,
      bankAsOf,
      bankEndDate,
    });
  }
  // An empty table alone is not affirmative evidence of no debt.
  return loans.length ? { status: 'reported', source: SOURCE, loans } : unavailableLeumiLoans();
}

export async function readLeumiLoans(page: Page): Promise<BankLoanSnapshot> {
  try {
    const links = [];
    for (const handle of await page.$$('a')) {
      if (await handle.evaluate(e => (e.textContent || '').trim() === 'ריכוז הלוואות')) links.push(handle);
    }
    if (links.length !== 1) return unavailableLeumiLoans();
    await links[0].evaluate(e => (e as HTMLElement).click());
    await page.waitForSelector('#TableNIS1', { visible: true, timeout: 15000 });
    const rows = await page.$eval('#TableNIS1', table =>
      Array.from((table as HTMLTableElement).rows, row =>
        Array.from(row.cells, cell => (cell.textContent || '').trim()),
      ),
    );
    return parseLeumiLoans(rows);
  } catch {
    return unavailableLeumiLoans();
  }
}
