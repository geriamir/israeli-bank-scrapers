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
  jest
    .mocked(fetchPostWithinPage)
    .mock.calls.map(([, , body]) => (body as { seqVoucherNumber: string }).seqVoucherNumber);

describe('addTransactionDetails', () => {
  beforeEach(() => {
    jest.mocked(fetchPostWithinPage).mockReset();
  });

  test('takes the category from the details, and stops asking once two charges of a merchant agree', async () => {
    jest.mocked(fetchPostWithinPage).mockResolvedValue(details('חניוני רכב'));

    const txns = await run([settled('1', 'פנגו'), settled('2', 'פנגו'), settled('3', 'פנגו'), settled('4', 'פנגו')]);

    expect(requestedVouchers()).toEqual(['1', '2']);
    expect(txns.map(txn => txn.category)).toEqual(['חניוני רכב', 'חניוני רכב', 'חניוני רכב', 'חניוני רכב']);
  });

  test('uses the given category cache once a call confirms the merchant, and adds a merchant once two of its charges agree', async () => {
    jest.mocked(fetchPostWithinPage).mockResolvedValueOnce(details('חניוני רכב')).mockResolvedValue(details('מסעדות'));
    const cache = new Map([['פנגו', 'חניוני רכב']]);

    const txns = await run(
      [settled('1', 'פנגו'), settled('2', 'שגב'), settled('3', 'קפה'), settled('4', 'קפה'), settled('5', 'פנגו')],
      { additionalTransactionInformationCategoryCache: cache },
    );

    expect(requestedVouchers()).toEqual(['1', '2', '3', '4']);
    expect(txns.map(txn => txn.category)).toEqual(['חניוני רכב', 'מסעדות', 'מסעדות', 'מסעדות', 'חניוני רכב']);
    expect(cache.has('שגב')).toBe(false);
    expect(cache.get('קפה')).toBe('מסעדות');
  });

  test("doesn't cache a merchant whose charges disagree", async () => {
    jest
      .mocked(fetchPostWithinPage)
      .mockResolvedValueOnce(details('מסעדות'))
      .mockResolvedValueOnce(details('בתי קפה'))
      .mockResolvedValueOnce(details('בתי קפה'));
    const cache = new Map<string, string>();

    await run([settled('1', 'קפה'), settled('2', 'קפה'), settled('3', 'קפה')], {
      additionalTransactionInformationCategoryCache: cache,
    });

    expect(requestedVouchers()).toEqual(['1', '2', '3']);
    expect(cache.get('קפה')).toBe('בתי קפה');
  });

  test("a plain payment first doesn't hide a transfer app's later transfers", async () => {
    jest
      .mocked(fetchPostWithinPage)
      .mockResolvedValueOnce(details('מחשבים ותוכנות'))
      .mockResolvedValueOnce(details('מחשבים ותוכנות', { transferBeneficiary: 'רבקה דוד' }))
      .mockResolvedValueOnce(details('מחשבים ותוכנות', { transferBeneficiary: 'יוסי כהן' }));
    const cache = new Map<string, string>();

    const txns = await run([settled('1', 'NEWPAY'), settled('2', 'NEWPAY'), settled('3', 'NEWPAY')], {
      additionalTransactionInformationCategoryCache: cache,
    });

    expect(requestedVouchers()).toEqual(['1', '2', '3']);
    expect(txns.map(txn => txn.memo)).toEqual(['', 'העברה ל: רבקה דוד', 'העברה ל: יוסי כהן']);
    expect(cache.has('NEWPAY')).toBe(false);
  });

  test('a transfer app cached by an earlier scrape is dropped once its check shows a transfer', async () => {
    jest
      .mocked(fetchPostWithinPage)
      .mockResolvedValueOnce(details('מחשבים ותוכנות', { transferBeneficiary: 'רבקה דוד' }))
      .mockResolvedValueOnce(details('מחשבים ותוכנות', { transferBeneficiary: 'יוסי כהן' }));
    const cache = new Map([['NEWPAY', 'מחשבים ותוכנות']]);

    const txns = await run([settled('1', 'NEWPAY'), settled('2', 'NEWPAY')], {
      additionalTransactionInformationCategoryCache: cache,
    });

    expect(requestedVouchers()).toEqual(['1', '2']);
    expect(txns.map(txn => txn.memo)).toEqual(['העברה ל: רבקה דוד', 'העברה ל: יוסי כהן']);
    expect(cache.has('NEWPAY')).toBe(false);
  });

  test('tries a failed call once more at the end', async () => {
    jest
      .mocked(fetchPostWithinPage)
      .mockResolvedValueOnce({ isSuccess: false, data: null })
      .mockResolvedValueOnce(details('מסעדות'));
    const known = { ...settled('1', 'ארומה'), additionalInformation: { isIsraelDeal: true } };

    const txns = await run([known]);

    expect(requestedVouchers()).toEqual(['1', '1']);
    expect(txns[0].category).toBe('מסעדות');
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
    expect(txns.map(txn => txn.memo)).toEqual(['העברה ל: רבקה דוד', 'העברה ל: יוסי כהן']);
    expect(txns.map(txn => txn.category)).toEqual([undefined, undefined]);
    expect(cache.has(BIT)).toBe(false);
  });

  test("doesn't take a pending transaction's category for the settled ones", async () => {
    const BIT = 'העברה ב BIT בנה"פ';
    jest.mocked(fetchPostWithinPage).mockResolvedValue(details('העברות כספים', { transferBeneficiary: 'רבקה דוד' }));
    const pending = { description: BIT, category: 'העברות כספים', status: 'pending' } as Transaction;

    const txns = await run([pending, settled('1', BIT)]);

    expect(requestedVouchers()).toEqual(['1']);
    expect(txns[1].memo).toBe('העברה ל: רבקה דוד');
  });

  test('never serves a transfer service from the cache, nor caches one without a beneficiary', async () => {
    jest
      .mocked(fetchPostWithinPage)
      .mockResolvedValueOnce(details('מחשבים ותוכנות'))
      .mockResolvedValueOnce(details('מחשבים ותוכנות', { transferBeneficiary: 'אינה שרון' }));
    const cache = new Map([['PAYBOX', 'מחשבים ותוכנות']]);

    const txns = await run([settled('1', 'PAYBOX'), settled('2', 'PAYBOX')], {
      additionalTransactionInformationCategoryCache: cache,
    });

    expect(requestedVouchers()).toEqual(['1', '2']);
    expect(txns[1].memo).toBe('העברה ל: אינה שרון');
    expect(cache.has('PAYBOX')).toBe(false);
  });

  test('stops caching a merchant once it is seen making a transfer', async () => {
    jest
      .mocked(fetchPostWithinPage)
      .mockResolvedValueOnce(details('העברות', { transferBeneficiary: 'רבקה דוד' }))
      .mockResolvedValueOnce(details('העברות'))
      .mockResolvedValueOnce(details('העברות', { transferBeneficiary: 'יוסי כהן' }));
    const cache = new Map<string, string>();

    const txns = await run([settled('1', 'NEWPAY'), settled('2', 'NEWPAY'), settled('3', 'NEWPAY')], {
      additionalTransactionInformationCategoryCache: cache,
    });

    expect(requestedVouchers()).toEqual(['1', '2', '3']);
    expect(txns[2].memo).toBe('העברה ל: יוסי כהן');
    expect(cache.has('NEWPAY')).toBe(false);
  });

  test('skips the transactions the caller says not to fetch', async () => {
    jest.mocked(fetchPostWithinPage).mockResolvedValue(details('מסעדות'));

    const txns = await run([settled('1', 'שגב'), settled('2', 'קפה')], {
      shouldFetchAdditionalTransactionInformation: txn => txn.identifier !== '1',
    });

    expect(requestedVouchers()).toEqual(['2']);
    expect(txns[0].category).toBeUndefined();
  });

  test("asks only as the voucher's own kind of deal, also when trying again", async () => {
    jest.mocked(fetchPostWithinPage).mockResolvedValue({ isSuccess: false, data: null });
    const abroadInShekels = { ...settled('1', 'Booking'), additionalInformation: { isIsraelDeal: false } };

    await run([abroadInShekels]);

    expect(
      jest.mocked(fetchPostWithinPage).mock.calls.map(([, , body]) => (body as { isIsraelDeal: boolean }).isIsraelDeal),
    ).toEqual([false, false]);
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
