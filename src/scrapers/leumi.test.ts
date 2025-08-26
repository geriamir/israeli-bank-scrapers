import LeumiScraper from './leumi';
import { maybeTestCompanyAPI, extendAsyncTimeout, getTestsConfig, exportTransactions } from '../tests/tests-utils';
import { SCRAPERS } from '../definitions';
import { LoginResults } from './base-scraper-with-browser';
import fs from 'fs';
import path from 'path';
import * as json2csv from 'json2csv';
import moment from 'moment';

const COMPANY_ID = 'leumi'; // TODO this property should be hard-coded in the provider
const testsConfig = getTestsConfig();

// Helper function to export portfolios data
function exportPortfolios(fileName: string, portfolios: any[]) {
  const config = getTestsConfig();

  if (
    !config.companyAPI.enabled ||
    !config.companyAPI.excelFilesDist ||
    !fs.existsSync(config.companyAPI.excelFilesDist)
  ) {
    return;
  }

  let data: any = [];

  for (let i = 0; i < portfolios.length; i += 1) {
    const portfolio = portfolios[i];

    // Export investments
    data = [
      ...data,
      ...portfolio.investments.map((investment: any) => {
        return {
          portfolioId: portfolio.portfolioId,
          portfolioName: portfolio.portfolioName,
          type: 'investment',
          paperId: investment.paperId,
          paperName: investment.paperName,
          symbol: investment.symbol,
          amount: investment.amount,
          value: investment.value,
          currency: investment.currency,
        };
      }),
    ];

    // Export investment transactions
    data = [
      ...data,
      ...portfolio.transactions.map((transaction: any) => {
        return {
          portfolioId: portfolio.portfolioId,
          portfolioName: portfolio.portfolioName,
          type: 'transaction',
          paperId: transaction.paperId,
          paperName: transaction.paperName,
          symbol: transaction.symbol,
          amount: transaction.amount,
          value: transaction.value,
          currency: transaction.currency,
          taxSum: transaction.taxSum,
          executionDate: moment(transaction.executionDate).format('DD/MM/YYYY'),
          executablePrice: transaction.executablePrice,
        };
      }),
    ];
  }

  if (data.length === 0) {
    data = [
      {
        comment: 'no portfolios found for requested time frame',
      },
    ];
  }

  const csv = json2csv.parse(data, { withBOM: true });
  const filePath = `${path.join(config.companyAPI.excelFilesDist, `${fileName}_portfolios`)}.csv`;
  fs.writeFileSync(filePath, csv);
}

// Helper function to export foreign currency accounts data
function exportForeignCurrencyAccounts(fileName: string, accounts: any[]) {
  const config = getTestsConfig();

  if (
    !config.companyAPI.enabled ||
    !config.companyAPI.excelFilesDist ||
    !fs.existsSync(config.companyAPI.excelFilesDist)
  ) {
    return;
  }

  let data: any = [];

  for (let i = 0; i < accounts.length; i += 1) {
    const account = accounts[i];

    data = [
      ...data,
      ...account.txns.map((txn: any) => {
        return {
          accountNumber: account.accountNumber,
          balance: `account balance: ${account.balance}`,
          currency: account.currency,
          ...txn,
          date: moment(txn.date).format('DD/MM/YYYY'),
          processedDate: moment(txn.processedDate).format('DD/MM/YYYY'),
        };
      }),
    ];
  }

  if (data.length === 0) {
    data = [
      {
        comment: 'no foreign currency accounts found for requested time frame',
      },
    ];
  }

  const csv = json2csv.parse(data, { withBOM: true });
  const filePath = `${path.join(config.companyAPI.excelFilesDist, `${fileName}_foreign_currency`)}.csv`;
  fs.writeFileSync(filePath, csv);
}

describe('Leumi legacy scraper', () => {
  beforeAll(() => {
    extendAsyncTimeout(); // The default timeout is 5 seconds per async test, this function extends the timeout value
  });

  test('should expose login fields in scrapers constant', () => {
    expect(SCRAPERS.leumi).toBeDefined();
    expect(SCRAPERS.leumi.loginFields).toContain('username');
    expect(SCRAPERS.leumi.loginFields).toContain('password');
  });

  maybeTestCompanyAPI(COMPANY_ID, config => config.companyAPI.invalidPassword)(
    'should fail on invalid user/password"',
    async () => {
      const options = {
        ...testsConfig.options,
        companyId: COMPANY_ID,
      };

      const scraper = new LeumiScraper(options);

      const result = await scraper.scrape({ username: 'e10s12', password: '3f3ss3d' });

      expect(result).toBeDefined();
      expect(result.success).toBeFalsy();
      expect(result.errorType).toBe(LoginResults.InvalidPassword);
    },
  );

  maybeTestCompanyAPI(COMPANY_ID)('should scrape transactions', async () => {
    const options = {
      ...testsConfig.options,
      companyId: COMPANY_ID,
    };

    const scraper = new LeumiScraper(options);
    const result = await scraper.scrape(testsConfig.credentials.leumi);
    expect(result).toBeDefined();
    const error = `${result.errorType || ''} ${result.errorMessage || ''}`.trim();
    expect(error).toBe('');
    expect(result.success).toBeTruthy();

    exportTransactions(COMPANY_ID, result.accounts || []);
  });

  maybeTestCompanyAPI(COMPANY_ID)('should scrape portfolios', async () => {
    const options = {
      ...testsConfig.options,
      companyId: COMPANY_ID,
    };

    const scraper = new LeumiScraper(options);
    const result = await scraper.scrapePortfolios(testsConfig.credentials.leumi);

    expect(result).toBeDefined();
    const error = `${result.errorType || ''} ${result.errorMessage || ''}`.trim();
    expect(error).toBe('');
    expect(result.success).toBeTruthy();

    if (result.portfolios && result.portfolios.length > 0) {
      // Validate portfolio structure
      result.portfolios.forEach(portfolio => {
        expect(portfolio.portfolioId).toBeDefined();
        expect(portfolio.portfolioName).toBeDefined();
        expect(Array.isArray(portfolio.investments)).toBeTruthy();
        expect(Array.isArray(portfolio.transactions)).toBeTruthy();

        // Validate investments structure if any exist
        portfolio.investments.forEach(investment => {
          expect(investment.paperId).toBeDefined();
          expect(investment.paperName).toBeDefined();
          expect(typeof investment.symbol).toBe('string');
          expect(typeof investment.amount).toBe('number');
          expect(typeof investment.value).toBe('number');
          expect(investment.currency).toBeDefined();
          expect(typeof investment.currency).toBe('string');
          expect(investment.currency.length).toBeGreaterThan(0);
        });

        // Validate investment transactions structure if any exist
        portfolio.transactions.forEach(transaction => {
          expect(transaction.paperId).toBeDefined();
          expect(transaction.paperName).toBeDefined();
          expect(transaction.symbol).toBeDefined();
          expect(typeof transaction.amount).toBe('number');
          expect(typeof transaction.value).toBe('number');
          expect(transaction.currency).toBeDefined();
          expect(typeof transaction.taxSum).toBe('number');
          expect(transaction.executionDate).toBeInstanceOf(Date);
          expect(typeof transaction.executablePrice).toBe('number');
        });
      });

      // Export portfolios data for debugging/verification
      exportPortfolios(COMPANY_ID, result.portfolios);
    }
  });

  maybeTestCompanyAPI(COMPANY_ID)('should scrape foreign currency accounts', async () => {
    const options = {
      ...testsConfig.options,
      companyId: COMPANY_ID,
    };

    const scraper = new LeumiScraper(options);
    const result = await scraper.scrapeForeignCurrencyAccounts(testsConfig.credentials.leumi);

    expect(result).toBeDefined();
    const error = `${result.errorType || ''} ${result.errorMessage || ''}`.trim();
    expect(error).toBe('');
    expect(result.success).toBeTruthy();

    if (result.foreignCurrencyAccounts && result.foreignCurrencyAccounts.length > 0) {
      // Validate foreign currency accounts structure
      result.foreignCurrencyAccounts.forEach(account => {
        expect(account.accountNumber).toBeDefined();
        expect(typeof account.balance).toBe('number');
        expect(account.currency).toBeDefined();
        expect(Array.isArray(account.txns)).toBeTruthy();

        // Validate foreign currency transactions structure
        account.txns.forEach(transaction => {
          expect(transaction.type).toBeDefined();
          expect(transaction.date).toBeDefined();
          expect(transaction.processedDate).toBeDefined();
          expect(transaction.description).toBeDefined();
          expect(typeof transaction.originalAmount).toBe('number');
          expect(typeof transaction.chargedAmount).toBe('number');
          expect(transaction.originalCurrency).toBeDefined();
          expect(transaction.status).toBeDefined();
        });
      });

      // Export foreign currency accounts data for debugging/verification
      exportForeignCurrencyAccounts(COMPANY_ID, result.foreignCurrencyAccounts);
    }
  });

  test('should support portfolios', () => {
    const options = {
      ...testsConfig.options,
      companyId: COMPANY_ID,
    };

    const scraper = new LeumiScraper(options);
    expect(scraper.doesSupportPortfolios()).toBeTruthy();
  });

  test('should support foreign currency accounts', () => {
    const options = {
      ...testsConfig.options,
      companyId: COMPANY_ID,
    };

    const scraper = new LeumiScraper(options);
    expect(scraper.doesSupportForeignCurrencyAccounts()).toBeTruthy();
  });
});
