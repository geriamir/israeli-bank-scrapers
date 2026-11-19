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
export interface LoanDetailBinding {
  sourceAccountRaw: string;
  linkIndex: string;
  currentIndex: string | null;
}

export function parseLeumiLoanDetails(rows: string[][], binding: LoanDetailBinding): BankLoanDetails {
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
  // The detail's eight-digit bank number is NOT the formatted summary reference.
  // Its relationship is the unique, captured bank row link, not guessed formatting.
  if (
    !/^\d+-\d+\/\d+$/.test(account) ||
    account !== clean(binding.sourceAccountRaw) ||
    !/^\d{8}$/.test(reference) ||
    !/^\d+$/.test(binding.linkIndex) ||
    binding.currentIndex !== binding.linkIndex
  )
    return unavailableLoanDetails();
  const detailSourceId = createHash('sha256')
    .update(JSON.stringify(['leumi-loan-detail', account, reference]))
    .digest('hex');
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
    detailSourceId,
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
    const targets = new Map<string, { url: string; index: string; account: string }>();
    const indexCounts = new Map<string, number>();
    for (const row of source) {
      const parsed = parseLeumiLoans([header, row.cells]);
      if (parsed.status !== 'reported') continue;
      const links = row.links.filter(link => {
        try {
          const url = new URL(link);
          return (
            url.origin === origin &&
            url.pathname === '/eBanking/LoanAndMortgages/DisplayLoanActivity.aspx' &&
            [...url.searchParams.keys()].length === 1 &&
            /^\d+$/.test(url.searchParams.get('index') || '')
          );
        } catch {
          return false;
        }
      });
      if (links.length === 1) {
        const index = new URL(links[0]).searchParams.get('index')!;
        targets.set(parsed.loans[0].sourceId, { url: links[0], index, account: parsed.loans[0].sourceAccountRaw! });
        indexCounts.set(index, (indexCounts.get(index) || 0) + 1);
      }
    }
    const deadline = Date.now() + 60000;
    // Bounded optional information reads. Zero revalued balance does not imply repaid.
    for (const loan of snapshot.loans.filter(l => l.revaluedBalance > 0).slice(0, 12)) {
      const target = targets.get(loan.sourceId);
      if (!target || indexCounts.get(target.index) !== 1 || Date.now() >= deadline) continue;
      try {
        await page.goto(target.url, {
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
        const current = new URL(page.url());
        const currentIndex =
          current.origin === origin &&
          current.pathname === '/eBanking/LoanAndMortgages/DisplayLoanActivity.aspx' &&
          [...current.searchParams.keys()].length === 1
            ? current.searchParams.get('index')
            : null;
        loan.details = parseLeumiLoanDetails(rows, {
          sourceAccountRaw: target.account,
          linkIndex: target.index,
          currentIndex,
        });
      } catch {
        /* Optional detail failure never discards summary observations or transactions. */
      }
    }
    // A reused detail bank number cannot be attributed to two summary loans.
    const identities = new Map<string, typeof snapshot.loans>();
    for (const loan of snapshot.loans)
      if (loan.details?.status === 'reported') {
        const list = identities.get(loan.details.detailSourceId) || [];
        list.push(loan);
        identities.set(loan.details.detailSourceId, list);
      }
    for (const list of identities.values())
      if (list.length > 1) for (const loan of list) loan.details = unavailableLoanDetails();
  } catch {
    /* No URLs, errors, financial data or credentials are logged. */
  }
}
