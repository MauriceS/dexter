/**
 * Yahoo Finance data source using yahoo-finance2 v3.
 * Used as a free fallback when FINANCIAL_DATASETS_API_KEY is not set
 * or when DATA_SOURCE=yfinance is configured.
 */
// v3: default export is the YahooFinance class — must be instantiated.
import YahooFinanceClass from 'yahoo-finance2';
const yahooFinance = new (YahooFinanceClass as any)({
  suppressNotices: ['yahooSurvey', 'ripHistorical'],
});

function fmtDate(d: Date | undefined | null): string | undefined {
  if (!d) return undefined;
  return d.toISOString().split('T')[0];
}

/** Return a period1 date string far enough back to cover `limit` periods. */
function periodStart(period: 'annual' | 'quarterly' | 'ttm', limit: number): string {
  const months = period === 'annual' ? limit * 12 + 3 : limit * 3 + 3;
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString().split('T')[0];
}

/** Map financialdatasets.ai period strings to fundamentalsTimeSeries types. */
function ftsType(period: 'annual' | 'quarterly' | 'ttm'): string {
  if (period === 'ttm') return 'trailing';
  return period;
}

/**
 * Current stock quote snapshot (price, market cap, key ratios).
 */
export async function getCurrentQuote(ticker: string) {
  const q = await yahooFinance.quote(ticker);
  return {
    ticker,
    name: q.longName ?? q.shortName,
    price: q.regularMarketPrice,
    open: q.regularMarketOpen,
    high: q.regularMarketDayHigh,
    low: q.regularMarketDayLow,
    previous_close: q.regularMarketPreviousClose,
    volume: q.regularMarketVolume,
    market_cap: q.marketCap,
    pe_ratio: q.trailingPE,
    week_52_high: q.fiftyTwoWeekHigh,
    week_52_low: q.fiftyTwoWeekLow,
    source: 'Yahoo Finance',
  };
}

/** Map financialdatasets.ai interval strings to yahoo-finance2 intervals. */
function mapInterval(interval: string): '1d' | '1wk' | '1mo' {
  switch (interval) {
    case 'week': return '1wk';
    case 'month': return '1mo';
    default: return '1d';
  }
}

/**
 * Historical OHLCV price data — uses chart() (historical() is deprecated in v3).
 */
export async function getHistoricalPrices(
  ticker: string,
  startDate: string,
  endDate: string,
  interval: string = 'day'
) {
  const result = await yahooFinance.chart(ticker, {
    period1: startDate,
    period2: endDate,
    interval: mapInterval(interval),
  });
  const quotes: any[] = result?.quotes ?? [];
  return quotes.map((r) => ({
    ticker,
    date: fmtDate(r.date),
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
    adjusted_close: r.adjclose,
    source: 'Yahoo Finance',
  }));
}

function applyDateFilters<T>(
  items: T[],
  getDate: (item: T) => string | undefined,
  filters?: DateFilters
): T[] {
  if (!filters) return items;
  return items.filter((item) => {
    const d = getDate(item);
    if (!d) return true;
    if (filters.report_period_gte && d < filters.report_period_gte) return false;
    if (filters.report_period_gt && d <= filters.report_period_gt) return false;
    if (filters.report_period_lte && d > filters.report_period_lte) return false;
    if (filters.report_period_lt && d >= filters.report_period_lt) return false;
    return true;
  });
}

type DateFilters = {
  report_period_gte?: string;
  report_period_gt?: string;
  report_period_lte?: string;
  report_period_lt?: string;
};

/**
 * Income statements — uses fundamentalsTimeSeries (quoteSummary incomeStatementHistory
 * stopped providing data in Nov 2024).
 */
export async function getIncomeStatements(
  ticker: string,
  period: 'annual' | 'quarterly' | 'ttm',
  limit: number,
  filters?: DateFilters
) {
  const rows: any[] = await yahooFinance.fundamentalsTimeSeries(ticker, {
    type: ftsType(period) as any,
    module: 'financials',
    period1: periodStart(period, limit),
  });
  let stmts = rows.map((r) => ({
    report_period: fmtDate(r.date),
    ticker,
    period,
    revenue: r.totalRevenue ?? null,
    cost_of_revenue: r.costOfRevenue ?? null,
    gross_profit: r.grossProfit ?? null,
    operating_expense: r.operatingExpense ?? null,
    operating_income: r.operatingIncome ?? null,
    research_and_development: r.researchAndDevelopment ?? null,
    selling_general_and_admin: r.sellingGeneralAndAdministration ?? null,
    ebit: r.EBIT ?? null,
    pretax_income: r.pretaxIncome ?? null,
    income_tax_expense: r.taxProvision ?? null,
    net_income: r.netIncome ?? null,
    diluted_eps: r.dilutedEPS ?? null,
    source: 'Yahoo Finance',
  }));
  stmts = applyDateFilters(stmts, (s) => s.report_period, filters);
  stmts.sort((a, b) => (b.report_period ?? '').localeCompare(a.report_period ?? ''));
  return stmts.slice(0, limit);
}

/**
 * Balance sheet statements.
 */
export async function getBalanceSheets(
  ticker: string,
  period: 'annual' | 'quarterly' | 'ttm',
  limit: number,
  filters?: DateFilters
) {
  const rows: any[] = await yahooFinance.fundamentalsTimeSeries(ticker, {
    type: ftsType(period) as any,
    module: 'balance-sheet',
    period1: periodStart(period, limit),
  });
  let stmts = rows.map((r) => ({
    report_period: fmtDate(r.date),
    ticker,
    period,
    total_assets: r.totalAssets ?? null,
    total_liabilities: r.totalLiabilitiesNetMinorityInterest ?? null,
    total_equity: r.stockholdersEquity ?? null,
    cash_and_equivalents: r.cashAndCashEquivalents ?? null,
    cash_equiv_and_short_term_investments: r.cashCashEquivalentsAndShortTermInvestments ?? null,
    total_current_assets: r.currentAssets ?? null,
    total_current_liabilities: r.currentLiabilities ?? null,
    long_term_debt: r.longTermDebt ?? null,
    total_debt: r.totalDebt ?? null,
    net_debt: r.netDebt ?? null,
    retained_earnings: r.retainedEarnings ?? null,
    accounts_receivable: r.accountsReceivable ?? null,
    inventory: r.inventory ?? null,
    net_ppe: r.netPPE ?? null,
    source: 'Yahoo Finance',
  }));
  stmts = applyDateFilters(stmts, (s) => s.report_period, filters);
  stmts.sort((a, b) => (b.report_period ?? '').localeCompare(a.report_period ?? ''));
  return stmts.slice(0, limit);
}

/**
 * Cash flow statements.
 */
export async function getCashFlowStatements(
  ticker: string,
  period: 'annual' | 'quarterly' | 'ttm',
  limit: number,
  filters?: DateFilters
) {
  const rows: any[] = await yahooFinance.fundamentalsTimeSeries(ticker, {
    type: ftsType(period) as any,
    module: 'cash-flow',
    period1: periodStart(period, limit),
  });
  let stmts = rows.map((r) => ({
    report_period: fmtDate(r.date),
    ticker,
    period,
    operating_cash_flow: r.operatingCashFlow ?? r.cashFlowFromContinuingOperatingActivities ?? null,
    investing_cash_flow: r.investingCashFlow ?? r.cashFlowFromContinuingInvestingActivities ?? null,
    financing_cash_flow: r.financingCashFlow ?? r.cashFlowFromContinuingFinancingActivities ?? null,
    capital_expenditure: r.capitalExpenditure ?? null,
    free_cash_flow: r.freeCashFlow ?? null,
    depreciation_and_amortization: r.depreciationAndAmortization ?? r.depreciationAmortizationDepletion ?? null,
    stock_based_compensation: r.stockBasedCompensation ?? null,
    change_in_working_capital: r.changeInWorkingCapital ?? null,
    source: 'Yahoo Finance',
  }));
  stmts = applyDateFilters(stmts, (s) => s.report_period, filters);
  stmts.sort((a, b) => (b.report_period ?? '').localeCompare(a.report_period ?? ''));
  return stmts.slice(0, limit);
}

/**
 * All three financial statements combined (mirrors /financials/ endpoint).
 */
export async function getAllStatements(
  ticker: string,
  period: 'annual' | 'quarterly' | 'ttm',
  limit: number,
  filters?: DateFilters
) {
  const [income, balance, cashflow] = await Promise.all([
    getIncomeStatements(ticker, period, limit, filters),
    getBalanceSheets(ticker, period, limit, filters),
    getCashFlowStatements(ticker, period, limit, filters),
  ]);
  return { income_statements: income, balance_sheets: balance, cash_flow_statements: cashflow };
}

/**
 * Key ratios snapshot (mirrors /financial-metrics/snapshot/).
 */
export async function getKeyRatiosSnapshot(ticker: string) {
  const data = await yahooFinance.quoteSummary(ticker, {
    modules: ['defaultKeyStatistics', 'financialData', 'summaryDetail'],
  });
  const ks: any = data.defaultKeyStatistics ?? {};
  const fd: any = data.financialData ?? {};
  const sd: any = data.summaryDetail ?? {};
  return {
    ticker,
    // Valuation
    pe_ratio: sd.trailingPE ?? null,
    forward_pe: ks.forwardPE ?? null,
    price_to_book: ks.priceToBook ?? null,
    price_to_sales: sd.priceToSalesTrailing12Months ?? null,
    ev_to_ebitda: ks.enterpriseToEbitda ?? null,
    ev_to_revenue: ks.enterpriseToRevenue ?? null,
    peg_ratio: ks.pegRatio ?? null,
    enterprise_value: ks.enterpriseValue ?? null,
    // Profitability
    gross_margin: fd.grossMargins ?? null,
    operating_margin: fd.operatingMargins ?? null,
    profit_margin: fd.profitMargins ?? null,
    return_on_equity: fd.returnOnEquity ?? null,
    return_on_assets: fd.returnOnAssets ?? null,
    // Per share
    eps_trailing_twelve_months: ks.trailingEps ?? null,
    eps_forward: ks.forwardEps ?? null,
    book_value_per_share: ks.bookValue ?? null,
    // Liquidity & leverage
    current_ratio: fd.currentRatio ?? null,
    // Yahoo Finance reports debt/equity as a percentage — convert to ratio
    debt_to_equity:
      fd.debtToEquity != null ? (fd.debtToEquity as number) / 100 : null,
    // Growth
    revenue_growth: fd.revenueGrowth ?? null,
    earnings_growth: fd.earningsGrowth ?? null,
    // Dividends
    dividend_yield: sd.dividendYield ?? null,
    // Market
    market_cap: sd.marketCap ?? null,
    source: 'Yahoo Finance',
  };
}

/**
 * Insider transactions (mirrors /insider-trades/).
 */
export async function getInsiderTrades(ticker: string, limit: number) {
  const data = await yahooFinance.quoteSummary(ticker, {
    modules: ['insiderTransactions'],
  });
  const transactions = (data.insiderTransactions as any)?.transactions ?? [];
  return (transactions as any[]).slice(0, limit).map((t) => ({
    ticker,
    filing_date: fmtDate(t.startDate),
    trade_date: fmtDate(t.startDate),
    insider_name: t.filerName,
    title: t.filerRelation,
    transaction_type: t.description,
    shares: t.shares ?? null,
    value: t.value ?? null,
    source: 'Yahoo Finance',
  }));
}

/**
 * Company news (mirrors /news/).
 */
export async function getCompanyNews(ticker: string, limit: number) {
  const results = await yahooFinance.search(ticker, {
    newsCount: Math.min(limit, 20),
    quotesCount: 0,
  });
  return ((results.news ?? []) as any[]).slice(0, limit).map((n) => ({
    ticker,
    title: n.title,
    url: n.link,
    source: n.publisher,
    published_at: n.providerPublishTime instanceof Date
      ? n.providerPublishTime.toISOString()
      : new Date((n.providerPublishTime as number) * 1000).toISOString(),
  }));
}
