export type CenterTab = 'watch' | 'assets' | 'news' | 'cloud' | 'sector';
export type ChartInterval =
  | 'trend'
  | 'trend5'
  | '1'
  | '5'
  | '15'
  | '30'
  | '60'
  | '101'
  | '102'
  | '103';
export type MarketFilter = 'all' | 'sh' | 'sz' | 'bj' | 'star' | 'chinext';
export type SectorBoardKind = 'industry' | 'concept';

export interface Quote {
  code: string;
  secid: string;
  name: string;
  price: number;
  percent: number;
  change: number;
  volume: number;
  amount: number;
  high: number;
  low: number;
  open: number;
  previousClose: number;
  amplitude: number;
  volumeRatio: number;
  turnover: number;
  pe: number;
  pb: number;
  marketCap: number;
  floatMarketCap: number;
  updatedAt: number;
}

export interface Holding {
  code: string;
  name: string;
  amount: number;
  cost: number;
  updatedAt: number;
}

export interface SearchResult {
  code: string;
  secid: string;
  name: string;
  marketLabel: string;
}

export interface CandlePoint {
  time: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
  amount: number;
  percent: number;
  turnover: number;
}

export interface TrendPoint {
  time: string;
  price: number;
  average: number;
  volume: number;
}

export interface ChartPayload {
  code: string;
  name: string;
  interval: ChartInterval;
  kind: 'candle' | 'trend';
  points: CandlePoint[] | TrendPoint[];
}

export interface NewsItem {
  id: string;
  time: string;
  title: string;
  summary: string;
  url: string;
}

export interface CommunityHeat {
  thsAvailable: boolean;
  thsHeat: number | null;
  thsRank: number | null;
  thsRankChange: number | null;
  thsPeriod: string;
  xueqiuAvailable: boolean;
  xueqiuFollowers: number | null;
}

export interface StockAnomalyInterpretation {
  id: string;
  date: string;
  title: string;
  tagName: string;
  content: string;
  keywords: string[];
}

export interface StockProfile {
  code: string;
  fullName: string;
  englishName: string;
  industry: string;
  subIndustry: string;
  listingBoard: string;
  listingDate: string;
  exchange: string;
  registeredCapital: string;
  employeeCount: string;
  website: string;
  business: string;
  summary: string;
  concepts: string[];
  community: CommunityHeat;
  anomalies: StockAnomalyInterpretation[];
  updatedAt: number;
}

export interface CapitalFlow {
  mainNet: number;
  superLargeNet: number;
  largeNet: number;
  mediumNet: number;
  smallNet: number;
}

export interface TradeTick {
  time: string;
  price: number;
  volume: number;
  trades: number;
  side: 'buy' | 'sell' | 'neutral';
  auction: boolean;
}

export interface RealtimeExtras {
  code: string;
  flow: CapitalFlow;
  trades: TradeTick[];
  updatedAt: number;
  flowUpdatedAt: number;
  tradesUpdatedAt: number;
  sessionDate: string;
  partial: boolean;
}

export interface CloudStock {
  code: string;
  secid: string;
  name: string;
  price: number;
  percent: number;
  marketCap: number;
  industry: string;
  subIndustry: string;
}

export interface SectorBoard {
  code: string;
  secid: string;
  name: string;
  kind: SectorBoardKind;
  price: number;
  percent: number;
  change: number;
  turnover: number;
  netInflow: number;
  upCount: number;
  downCount: number;
  leaderName: string;
  leaderCode: string;
  leaderSecid: string;
  leaderPercent: number;
  threeDayPercent: number;
  threeMinutePercent: number;
  updatedAt: number;
}

export interface SectorOverview {
  hot3d: SectorBoard[];
  fast3m: SectorBoard[];
  industryTopInflow: SectorBoard[];
  conceptTopInflow: SectorBoard[];
  updatedAt: number;
}

export interface SectorConstituent {
  code: string;
  secid: string;
  name: string;
  price: number;
  percent: number;
  change: number;
  turnover: number;
  netInflow: number;
  marketCap: number;
  updatedAt: number;
}

export interface AppSnapshot {
  watchlist: string[];
  indexCodes: string[];
  watchGroups: WatchGroup[];
  watchGroupAssignments: Record<string, string[]>;
  holdings: Holding[];
  quotes: Quote[];
  sortMode: number;
  updatedAt: number;
}

export interface WatchGroup {
  id: string;
  name: string;
}

export const INDEX_CODES = new Set([
  'sh000001',
  'sh000300',
  'sh000016',
  'sh000688',
  'sz399001',
  'sz399006'
]);

/**
 * Recognises the exchange code ranges reserved for A-share indices.
 *
 * The built-in list above contains the default sidebar indices, while these
 * ranges cover indices discovered through search (including sector/theme
 * indices) before their explicit instrument type has been persisted.
 */
export function isAIndexCode(code: string): boolean {
  const normalized = code.trim().toLowerCase();
  return (
    INDEX_CODES.has(normalized) ||
    /^sh(?:000|930|931|932|950|980|990)\d{3}$/.test(normalized) ||
    /^sz399\d{3}$/.test(normalized)
  );
}

export const DEFAULT_NAMES: Record<string, string> = {
  sh600036: '招商银行',
  sz000858: '五 粮 液',
  sh688981: '中芯国际',
  sz300750: '宁德时代',
  sh601318: '中国平安',
  sh000001: '上证指数',
  sh000300: '沪深300',
  sh000016: '上证50',
  sh000688: '科创50',
  sz399001: '深证成指',
  sz399006: '创业板指'
};

export const DEFAULT_WATCHLIST = [
  'sh600036',
  'sz000858',
  'sh688981',
  'sz300750',
  'sh601318',
  'sh000001',
  'sh000300',
  'sh000016',
  'sh000688',
  'sz399001',
  'sz399006'
];

export function codeToSecid(code: string): string {
  const normalized = code.trim().toLowerCase();
  const digits = normalized.replace(/^(sh|sz|bj)/, '');
  return (normalized.startsWith('sh') ? '1.' : '0.') + digits;
}

export function secidToCode(secid: string, rawCode?: string): string {
  const parts = secid.split('.');
  const market = parts[0];
  const digits = rawCode || parts[1] || '';
  if (market === '1') {
    return 'sh' + digits;
  }
  if (/^(4|8|9)/.test(digits)) {
    return 'bj' + digits;
  }
  return 'sz' + digits;
}

export function isAShareCode(code: string): boolean {
  return /^(sh|sz|bj)\d{6}$/.test(code);
}
