import { createHash } from 'crypto';
import moment from 'moment';
import { type Page } from 'puppeteer';
import { type BankLoanDetails, type BankLoanSnapshot } from '../../transactions';
import { parseLeumiLoans } from './leumi-loans';

export const unavailableLoanDetails = (): BankLoanDetails => ({ status: 'unavailable', source: 'leumi-loan-detail' });
const clean = (text: string) =>
  text
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim()
    .replace(/\s+/g, ' ');

// Exact observed source labels. Payment counts mean REMAINING, never already paid.
export function parseLeumiLoanDetails(rows: string[][], expectedSourceId: string): BankLoanDetails {
  const fields = new Map<string, string>();
  for (const row of rows) {
    if (row.length !== 2) continue;
    const label = clean(row[0]);
    if (fields.has(label)) return unavailableLoanDetails();
    fields.set(label, clean(row[1]));
  }
  const value = (label: string) => fields.get(label) || '';
  const account = value('חשבון:');
  const reference = value('מספר הלוואה:');
  if (!/^\d+-\d+\/\d+$/.test(account) || !/^\d+-\d+\/\d+$/.test(reference)) return unavailableLoanDetails();
  const identity = createHash('sha256')
    .update(JSON.stringify(['leumi-loan-summary', account, reference]))
    .digest('hex');
  if (identity !== expectedSourceId) return unavailableLoanDetails();
  const date = (label: string): string | null => {
    const raw = value(label);
    // Observed placeholder on an inactive loan. This is not an actual payment date.
    if (!raw || raw === '-' || raw === '01/01/70' || raw === '01/01/1970') return null;
    const d = moment(raw, ['DD/MM/YYYY', 'DD/MM/YY'], true);
    return d.isValid() ? d.format('YYYY-MM-DD') : null;
  };
  const amount = (label: string) => {
    const raw = value(label);
    return /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(raw) && Number.isFinite(Number(raw.replace(/,/g, '')))
      ? Number(raw.replace(/,/g, ''))
      : null;
  };
  const bankAsOf = date('נכון לתאריך:');
  if (!bankAsOf) return unavailableLoanDetails();
  const count = value('תשלומים שנותרו:');
  const rate = value('שיעור ריבית:');
  const rateNumber = /^(?:\d+)(?:\.\d+)?%$/.test(rate) ? Number(rate.slice(0, -1)) : null;
  return {
    status: 'reported',
    source: 'leumi-loan-detail',
    bankAsOf,
    principalBalance: amount('יתרת קרן:'),
    remainingPayments: /^\d+$/.test(count) && Number.isSafeInteger(Number(count)) ? Number(count) : null,
    nextPaymentAmount: amount('סכום התשלום הבא:'),
    nextPaymentDate: date('תאריך התשלום הבא:'),
    interestRatePercent: rateNumber !== null && Number.isFinite(rateNumber) ? rateNumber : null,
    interestRateText: rate && rate.length <= 80 ? rate : null,
    indexation: value('סוג הצמדה:').slice(0, 100) || null,
    bankStartDate: date('תאריך העמדת הלוואה'),
    bankEndDate: date('תאריך סיום:'),
  };
}

export async function readLeumiLoanDetails(page: Page, snapshot: BankLoanSnapshot): Promise<void> {
  for (const loan of snapshot.loans) loan.details = unavailableLoanDetails();
  if (snapshot.status !== 'reported') return;
  try {
    const origin = new URL(page.url()).origin;
    // Capture existing links before leaving the summary. Never construct account/loan URLs.
    const source = await page.$eval('#TableNIS1', table =>
      Array.from((table as HTMLTableElement).rows, row => ({
        cells: Array.from(row.cells, cell => (cell.textContent || '').trim()),
        links: Array.from(row.querySelectorAll('a[href]'), a => (a as HTMLAnchorElement).href),
      })),
    );
    const header = source.find(row => row.cells.map(clean).includes('יתרה משוערכת'))?.cells;
    if (!header) return;
    const targets = new Map<string, string>();
    for (const row of source) {
      const parsed = parseLeumiLoans([header, row.cells]);
      if (parsed.status !== 'reported') continue;
      const links = row.links.filter(link => {
        try {
          const url = new URL(link);
          return url.origin === origin && url.pathname === '/eBanking/LoanAndMortgages/DisplayLoanActivity.aspx';
        } catch {
          return false;
        }
      });
      if (links.length === 1) targets.set(parsed.loans[0].sourceId, links[0]);
    }
    const deadline = Date.now() + 60000;
    // Bounded optional information reads. Zero revalued balance does not imply repaid.
    for (const loan of snapshot.loans.filter(l => l.revaluedBalance > 0).slice(0, 12)) {
      const target = targets.get(loan.sourceId);
      if (!target || Date.now() >= deadline) continue;
      try {
        await page.goto(target, {
          waitUntil: 'domcontentloaded',
          timeout: Math.max(1, Math.min(15000, deadline - Date.now())),
        });
        await page.waitForFunction(
          () => {
            const headings = [...document.querySelectorAll('h1,h2,h3')];
            const sections = ['מידע כללי', 'יתרות', 'ריביות', 'תאריכים'].map(label =>
              headings.find(e => e.textContent?.trim() === label),
            );
            if (sections.some(section => !section)) return false;
            const fields = sections.flatMap(section => [...(section?.closest('tbody')?.rows || [])]);
            return [
              'נכון לתאריך:',
              'חשבון:',
              'מספר הלוואה:',
              'יתרת קרן:',
              'תשלומים שנותרו:',
              'שיעור ריבית:',
              'תאריך סיום:',
            ].every(label =>
              fields.some(row => row.cells[0]?.textContent?.trim() === label && !!row.cells[1]?.textContent?.trim()),
            );
          },
          { timeout: Math.max(1, Math.min(15000, deadline - Date.now())) },
        );
        const rows = await page.evaluate(() =>
          [...document.querySelectorAll('h1,h2,h3')]
            .filter(h => ['מידע כללי', 'יתרות', 'ריביות', 'תאריכים'].includes(h.textContent?.trim() || ''))
            .flatMap(h =>
              [...(h.closest('tbody')?.rows || [])].map(row =>
                [...row.cells].map(cell => (cell.textContent || '').trim()),
              ),
            ),
        );
        loan.details = parseLeumiLoanDetails(rows, loan.sourceId);
      } catch {
        /* Optional detail failure never discards summary observations or transactions. */
      }
    }
  } catch {
    /* No URLs, errors, financial data or credentials are logged. */
  }
}
