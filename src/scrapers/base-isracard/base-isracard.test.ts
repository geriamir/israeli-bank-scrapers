import { type Page } from 'puppeteer';
import { fetchPostWithinPage } from '../../helpers/fetch';
import { type Transaction } from '../../transactions';
import { type ScraperOptions } from '../interface';
import { addTransactionDetails } from './base-isracard';
import { type ScrapedCard, type ScrapedTransactionDetails } from './base-isracard-utils';

jest.mock('../../helpers/fetch');
jest.mock('../../helpers/waiting', () => ({ randomDelay: jest.fn().mockResolvedValue(undefined) }));

const page = {} as Page;
const card = { cardSuffix: '4956', isPartner: false } as ScrapedCard;
const DETAILS_URL = 'https://web.isracard.co.il/details';

const details = (branchDescription: string, transfer: Partial<ScrapedTransactionDetails> = {}) => ({
  isSuccess: true,
  data: {
    parentBranchDescription: null,
    branchDescription,
    secondBranchDescription: null,
    transferBeneficiary: null,
    transferReason: null,
    ...transfer,
  },
});

const settled = (identifier: string, description: string, originalCurrency = 'ILS') =>
  ({ identifier, description, originalCurrency, memo: '', status: 'completed' }) as Transaction;

const run = (txns: Transaction[], options: Partial<ScraperOptions> = {}) =>
  addTransactionDetails(page, DETAILS_URL, 11, card, txns, options as ScraperOptions);

const requestedVouchers = () =>
  jest.mocked(fetchPostWithinPage).mock.calls.map(([, , body]) => (body as { seqVoucherNumber: string }).seqVoucherNumber);

describe('addTransactionDetails', () => {
  beforeEach(() => {
    jest.mocked(fetchPostWithinPage).mockReset();
  });

  test('takes the category from the details, asking once per merchant', async () => {
    jest.mocked(fetchPostWithinPage).mockResolvedValue(details('חניוני רכב'));

    const txns = await run([settled('1', 'פנגו'), settled('2', 'פנגו'), settled('3', 'פנגו')]);

    expect(requestedVouchers()).toEqual(['1']);
    expect(txns.map(txn => txn.category)).toEqual(['חניוני רכב', 'חניוני רכב', 'חניוני רכב']);
  });

  test('uses and fills the given category cache', async () => {
    jest.mocked(fetchPostWithinPage).mockResolvedValue(details('מסעדות'));
    const cache = new Map([['פנגו', 'חניוני רכב']]);

    const txns = await run([settled('1', 'פנגו'), settled('2', 'שגב')], {
      additionalTransactionInformationCategoryCache: cache,
    });

    expect(requestedVouchers()).toEqual(['2']);
    expect(txns.map(txn => txn.category)).toEqual(['חניוני רכב', 'מסעדות']);
    expect(cache.get('שגב')).toBe('מסעדות');
  });

  test('asks for every transfer, since each names its own beneficiary', async () => {
    const BIT = 'העברה ב BIT בנה"פ';
    jest
      .mocked(fetchPostWithinPage)
      .mockResolvedValueOnce(details('העברות כספים', { transferBeneficiary: 'רבקה דוד' }))
      .mockResolvedValueOnce(details('העברות כספים', { transferBeneficiary: 'יוסי כהן' }));
    const cache = new Map<string, string>();

    const txns = await run([settled('1', BIT), settled('2', BIT)], {
      additionalTransactionInformationCategoryCache: cache,
    });

    expect(requestedVouchers()).toEqual(['1', '2']);
    expect(txns.map(txn => txn.memo)).toEqual(['רבקה דוד', 'יוסי כהן']);
    expect(cache.has(BIT)).toBe(false);
  });

  test("doesn't take a pending transaction's category for the settled ones", async () => {
    const BIT = 'העברה ב BIT בנה"פ';
    jest.mocked(fetchPostWithinPage).mockResolvedValue(details('העברות כספים', { transferBeneficiary: 'רבקה דוד' }));
    const pending = { description: BIT, category: 'העברות כספים', status: 'pending' } as Transaction;

    const txns = await run([pending, settled('1', BIT)]);

    expect(requestedVouchers()).toEqual(['1']);
    expect(txns[1].memo).toBe('רבקה דוד');
  });

  test('skips the transactions the caller says not to fetch', async () => {
    jest.mocked(fetchPostWithinPage).mockResolvedValue(details('מסעדות'));

    const txns = await run([settled('1', 'שגב'), settled('2', 'קפה')], {
      shouldFetchAdditionalTransactionInformation: txn => txn.identifier !== '1',
    });

    expect(requestedVouchers()).toEqual(['2']);
    expect(txns[0].category).toBeUndefined();
  });

  test('asks again as the other kind of deal, and keeps the transaction when both fail', async () => {
    jest.mocked(fetchPostWithinPage).mockImplementation((_page, _url, body) => {
      const { seqVoucherNumber, isIsraelDeal } = body as { seqVoucherNumber: string; isIsraelDeal: boolean };
      if (seqVoucherNumber === '2') {
        return Promise.reject(new Error('network'));
      }
      return Promise.resolve(isIsraelDeal ? details('אונליין') : { isSuccess: false, data: null });
    });

    const txns = await run([settled('1', 'Amazon', 'USD'), settled('2', 'eBay', 'USD')]);

    const askedFor1 = jest
      .mocked(fetchPostWithinPage)
      .mock.calls.map(([, , body]) => body as { seqVoucherNumber: string; isIsraelDeal: boolean })
      .filter(body => body.seqVoucherNumber === '1')
      .map(body => body.isIsraelDeal);
    expect(askedFor1).toEqual([false, true]);
    expect(txns[0].category).toBe('אונליין');
    expect(txns[1]).toEqual(settled('2', 'eBay', 'USD'));
  });
});
