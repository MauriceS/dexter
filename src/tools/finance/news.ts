import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { callApi, shouldUseYahooFinance } from './api.js';
import { formatToolResult } from '../types.js';
import * as yf from './yfinance-api.js';

const CompanyNewsInputSchema = z.object({
  ticker: z
    .string()
    .describe("The stock ticker symbol to fetch company news for. For example, 'AAPL' for Apple."),
  limit: z
    .number()
    .default(5)
    .describe('Maximum number of news articles to return (default: 5, max: 10).'),
});

export const getCompanyNews = new DynamicStructuredTool({
  name: 'get_company_news',
  description:
    'Retrieves recent company news headlines for a stock ticker, including title, source, publication date, and URL. Use for company catalysts, price move explanations, press releases, and recent announcements.',
  schema: CompanyNewsInputSchema,
  func: async (input) => {
    const ticker = input.ticker.trim().toUpperCase();
    const limit = Math.min(input.limit, 10);
    if (shouldUseYahooFinance(ticker)) {
      const news = await yf.getCompanyNews(ticker, limit);
      return formatToolResult(news, ['Yahoo Finance']);
    }
    const params: Record<string, string | number | undefined> = { ticker, limit };
    const { data, url } = await callApi('/news', params);
    return formatToolResult((data.news as unknown[]) || [], [url]);
  },
});
