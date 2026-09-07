import {
  CandlePoint,
  ChartInterval,
  ChartPayload,
  CloudStock,
  INDEX_CODES,
  MarketFilter,
  NewsItem,
  Quote,
  RealtimeExtras,
  SearchResult,
  SectorBoard,
  SectorBoardKind,
  SectorConstituent,
  SectorOverview,
  StockProfile,
  TradeTick,
  TrendPoint,
  codeToSecid,
  secidToCode
} from './types';
import { resolveQuoteForDisplay } from './quoteSnapshot';
import { parseTencentStockSearch } from './tencentStockSearch';

interface CacheEntry<T> {
  at: number;
  value: T;
}

interface IndustryHierarchy {
  industry: string;
  subIndustry: string;
}

function toNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** Uses the same stable Eastmoney push upstream selection as LeekFund 4.2.9. */
function resolveEastmoneyRequestUrl(rawUrl: string): string {
  try {
    const target = new URL(rawUrl);
    const hostname = target.hostname.toLowerCase();
    if (/^\d+\.push2his\.eastmoney\.com$/i.test(hostname)) {
      return target.toString();
    }
    if (
      /^push2(?:delay)?\.eastmoney\.com$/i.test(hostname) ||
      /^\d+\.push2\.eastmoney\.com$/i.test(hostname)
    ) {
      target.protocol = 'https:';
      target.hostname = 'push2delay.eastmoney.com';
      target.port = '';
      return target.toString();
    }
  } catch {
    // Let fetch report malformed URLs through the existing retry path.
  }
  return rawUrl;
}

interface SohuDailyCandle extends CandlePoint {
  previousClose: number;
}

function percentage(value: unknown): number {
  return toNumber(String(value ?? '').replace('%', ''));
}

function isoWeekKey(dateText: string): string {
  const date = new Date(dateText + 'T00:00:00Z');
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const year = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return String(year) + '-W' + String(week).padStart(2, '0');
}

function aggregateDailyCandles(
  rows: SohuDailyCandle[],
  interval: '102' | '103'
): CandlePoint[] {
  const groups = new Map<string, SohuDailyCandle[]>();
  for (const row of rows) {
    const key = interval === '102' ? isoWeekKey(row.time) : row.time.slice(0, 7);
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }
  const result: CandlePoint[] = [];
  let previousClose = rows[0]?.previousClose || rows[0]?.open || 0;
  for (const group of groups.values()) {
    const first = group[0];
    const last = group[group.length - 1];
    const high = Math.max(...group.map((item) => item.high));
    const low = Math.min(...group.map((item) => item.low));
    const change = last.close - previousClose;
    result.push({
      time: last.time,
      open: first.open,
      close: last.close,
      high,
      low,
      volume: group.reduce((sum, item) => sum + item.volume, 0),
      amount: group.reduce((sum, item) => sum + item.amount, 0),
      percent: previousClose ? (change / previousClose) * 100 : 0,
      turnover: group.reduce((sum, item) => sum + item.turnover, 0)
    });
    previousClose = last.close;
  }
  return result;
}

function shanghaiDateKey(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);
  const value = new Map(parts.map((part) => [part.type, part.value]));
  return [value.get('year'), value.get('month'), value.get('day')].join('-');
}

function oneMonthAgoShanghaiDateKey(now = new Date()): string {
  const [year, month, day] = shanghaiDateKey(now).split('-').map(Number);
  const lastDayOfPreviousMonth = new Date(Date.UTC(year, month - 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(year, month - 2, Math.min(day, lastDayOfPreviousMonth))
  )
    .toISOString()
    .slice(0, 10);
}

const SECTOR_LIST_CACHE_TTL = 60 * 1000;
const SECTOR_TOP_CACHE_TTL = 10 * 1000;
const SECTOR_DETAIL_CACHE_TTL = 15 * 1000;

const PRIMARY_INDUSTRY_RULES: Array<{ name: string; pattern: RegExp }> = [
  { name: '电子', pattern: /半导体|元件|消费电子|光学光电子|电子化学|其他电子/ },
  { name: '医药生物', pattern: /化学制药|中药|生物制品|医疗器械|医疗服务|医药商业/ },
  { name: '机械设备', pattern: /通用设备|专用设备|自动化设备|轨交设备|工程机械/ },
  { name: '计算机', pattern: /软件开发|计算机设备|IT服务/ },
  { name: '电力设备', pattern: /光伏设备|风电设备|电池|电网设备|电机|其他电源/ },
  { name: '国防军工', pattern: /航空装备|航天装备|地面兵装|航海装备|军工电子/ },
  { name: '基础化工', pattern: /化学原料|化学制品|农化制品|塑料|橡胶|化纤|非金属材料/ },
  { name: '有色金属', pattern: /工业金属|贵金属|小金属|能源金属|金属新材料/ },
  { name: '汽车', pattern: /汽车整车|汽车零部件|汽车服务|摩托车/ },
  { name: '非银金融', pattern: /证券|保险|多元金融/ },
  { name: '食品饮料', pattern: /白酒|饮料乳品|食品加工|调味发酵品|休闲食品/ },
  { name: '农林牧渔', pattern: /养殖业|种植业|饲料|农产品加工|农业综合|渔业|动物保健/ },
  { name: '家用电器', pattern: /白色家电|黑色家电|厨卫电器|小家电|照明设备|家电零部件/ },
  { name: '传媒', pattern: /游戏|广告营销|影视院线|数字媒体|出版|电视广播/ },
  { name: '通信', pattern: /通信设备|通信服务/ },
  { name: '公用事业', pattern: /电力|燃气|环保/ },
  { name: '交通运输', pattern: /航运港口|航空机场|铁路公路|物流/ },
  { name: '房地产', pattern: /房地产开发|房地产服务/ },
  { name: '建筑装饰', pattern: /房屋建设|基础建设|专业工程|装修装饰/ },
  { name: '建筑材料', pattern: /水泥|玻璃玻纤|装修建材/ },
  { name: '商贸零售', pattern: /一般零售|专业连锁|贸易|互联网电商/ },
  { name: '社会服务', pattern: /酒店餐饮|旅游景区|教育|体育/ },
  { name: '美容护理', pattern: /化妆品|医疗美容|个护用品/ },
  { name: '纺织服饰', pattern: /纺织制造|服装家纺|饰品/ },
  { name: '轻工制造', pattern: /造纸|包装印刷|家居用品|文娱用品/ },
  { name: '银行', pattern: /银行/ },
  { name: '煤炭', pattern: /煤炭/ },
  { name: '石油石化', pattern: /油气开采|油服工程|炼化及贸易|石油石化/ },
  { name: '钢铁', pattern: /普钢|特钢|冶钢原料|钢铁/ }
];

function primaryIndustryOf(subIndustry: string): string {
  const normalized = subIndustry.trim() || '其他';
  return PRIMARY_INDUSTRY_RULES.find((rule) => rule.pattern.test(normalized))?.name || '其他行业';
}

export class DataService {
  private readonly chartCache = new Map<string, CacheEntry<ChartPayload>>();
  private readonly cloudCache = new Map<MarketFilter, CacheEntry<CloudStock[]>>();
  private readonly profileCache = new Map<string, CacheEntry<StockProfile>>();
  private readonly extrasCache = new Map<string, CacheEntry<RealtimeExtras>>();
  private readonly sectorBoardCache = new Map<SectorBoardKind, CacheEntry<SectorBoard[]>>();
  private readonly topSectorBoardCache = new Map<
    SectorBoardKind,
    CacheEntry<SectorBoard[]>
  >();
  private readonly sectorConstituentCache = new Map<
    string,
    CacheEntry<SectorConstituent[]>
  >();
  private readonly cloudUpdatedAt = new Map<MarketFilter, number>();
  private industryHierarchyCache: CacheEntry<Map<string, IndustryHierarchy>> | undefined;
  private newsCache: CacheEntry<NewsItem[]> | undefined;
  private sectorOverviewCache: CacheEntry<SectorOverview> | undefined;
  private sectorClistHost = 'https://push2.eastmoney.com';

  private async getText(url: string, timeoutMs = 10000, maxAttempts = 3): Promise<string> {
    let lastError: unknown;
    const attempts = Math.max(1, maxAttempts);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(resolveEastmoneyRequestUrl(url), {
          signal: controller.signal,
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/132 Safari/537.36',
            Referer: url.includes('xueqiu.com')
              ? 'https://xueqiu.com/hq'
              : url.includes('10jqka.com.cn')
                ? 'https://eq.10jqka.com.cn/frontend/thsTopRank/index.html'
                : url.includes('sina.com.cn')
                  ? 'https://vip.stock.finance.sina.com.cn/'
                  : 'https://quote.eastmoney.com/'
          }
        });
        if (!response.ok) {
          throw new Error('HTTP ' + response.status + ' ' + response.statusText);
        }
        return await response.text();
      } catch (error) {
        lastError = error;
        if (attempt < attempts - 1) {
          await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('网络请求失败');
  }

  private async getJson<T>(
    url: string,
    timeoutMs = 10000,
    maxAttempts = 3
  ): Promise<T> {
    const text = await this.getText(url, timeoutMs, maxAttempts);
    return JSON.parse(text) as T;
  }

  private async postJson<T>(
    url: string,
    body: unknown,
    referer: string,
    timeoutMs = 10000,
    maxAttempts = 3
  ): Promise<T> {
    let lastError: unknown;
    const attempts = Math.max(1, maxAttempts);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            Accept: 'application/json, text/plain, */*',
            'Content-Type': 'application/json',
            Referer: referer,
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/132 Safari/537.36'
          },
          body: JSON.stringify(body)
        });
        if (!response.ok) {
          throw new Error('HTTP ' + response.status + ' ' + response.statusText);
        }
        return JSON.parse(await response.text()) as T;
      } catch (error) {
        lastError = error;
        if (attempt < attempts - 1) {
          await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('网络请求失败');
  }

  private async getSectorListPage(
    filter: string,
    sortField: string,
    fields: string,
    page: number,
    pageSize: number
  ): Promise<any> {
    const path =
      '/api/qt/clist/get?pn=' +
      String(page) +
      '&pz=' +
      String(pageSize) +
      '&po=1&np=1&fltt=2&invt=2&fid=' +
      encodeURIComponent(sortField) +
      '&ut=bd1d9ddb04089700cf9c27f6f7426281&fs=' +
      encodeURIComponent(filter) +
      '&fields=' +
      encodeURIComponent(fields);
    let payload: any;
    try {
      payload = await this.getJson<any>(this.sectorClistHost + path, 18000);
    } catch (error) {
      if (this.sectorClistHost === 'https://push2delay.eastmoney.com') {
        throw error;
      }
      this.sectorClistHost = 'https://push2delay.eastmoney.com';
      payload = await this.getJson<any>(this.sectorClistHost + path, 18000);
    }
    if (payload?.rc !== 0 || !payload?.data) {
      throw new Error('Sector market data is unavailable');
    }
    return payload;
  }

  private async getSectorListRows(
    filter: string,
    sortField: string,
    fields: string
  ): Promise<any[]> {
    const pageSize = 100;
    const fetchPage = (page: number): Promise<any> =>
      this.getSectorListPage(filter, sortField, fields, page, pageSize);

    const first = await fetchPage(1);
    const total = Math.max(0, toNumber(first.data.total));
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    if (pageCount > 20) {
      throw new Error('Sector market data exceeds the supported page limit');
    }
    const rows = [...asArray<any>(first.data.diff)];
    const remaining = Array.from({ length: pageCount - 1 }, (_item, index) => index + 2);
    for (const page of remaining) {
      const payload = await fetchPage(page);
      rows.push(...asArray<any>(payload.data.diff));
    }
    if (total > 0 && rows.length < total) {
      throw new Error('Sector market data is incomplete');
    }
    return total > 0 ? rows.slice(0, total) : rows;
  }

  private mapSectorBoardRows(rows: any[], kind: SectorBoardKind): SectorBoard[] {
    return rows
      .map((item) => {
        const code = String(item.f12 || '').trim().toUpperCase();
        const leaderRawCode = String(item.f140 || '').trim();
        const leaderMarket = toNumber(item.f141, -1);
        const leaderSecid =
          /^\d{6}$/.test(leaderRawCode) && (leaderMarket === 0 || leaderMarket === 1)
            ? String(leaderMarket) + '.' + leaderRawCode
            : '';
        const timestamp = toNumber(item.f124);
        return {
          code,
          secid: String(toNumber(item.f13, 90)) + '.' + code,
          name: String(item.f14 || code),
          kind,
          price: toNumber(item.f2),
          percent: toNumber(item.f3),
          change: toNumber(item.f4),
          turnover: toNumber(item.f8),
          netInflow: toNumber(item.f62),
          upCount: toNumber(item.f104),
          downCount: toNumber(item.f105),
          leaderName: String(item.f128 || ''),
          leaderCode: leaderSecid ? secidToCode(leaderSecid, leaderRawCode) : '',
          leaderSecid,
          leaderPercent: toNumber(item.f136),
          threeDayPercent: toNumber(item.f127),
          threeMinutePercent: toNumber(item.f22),
          updatedAt: timestamp > 0 ? timestamp * 1000 : Date.now()
        } as SectorBoard;
      })
      .filter((item) => /^BK\d+$/.test(item.code) && item.name.length > 0);
  }

  public async getSectorBoards(
    kind: SectorBoardKind,
    force = false
  ): Promise<SectorBoard[]> {
    const cached = this.sectorBoardCache.get(kind);
    if (!force && cached && Date.now() - cached.at < SECTOR_LIST_CACHE_TTL) {
      return cached.value;
    }
    const fields =
      'f2,f3,f4,f8,f12,f13,f14,f22,f62,f104,f105,f124,f127,f128,f136,f140,f141';
    const filter = kind === 'industry' ? 'm:90+t:2' : 'm:90+t:3';
    const rows = await this.getSectorListRows(filter, 'f62', fields);
    const value = this.mapSectorBoardRows(rows, kind);
    if (value.length < 100) {
      throw new Error('Sector market data contains too few boards');
    }
    this.sectorBoardCache.set(kind, { at: Date.now(), value });
    return value;
  }

  public async getTopSectorBoards(
    kind: SectorBoardKind,
    limit = 20,
    force = false
  ): Promise<SectorBoard[]> {
    const count = Math.max(1, Math.min(50, Math.floor(limit)));
    const cached = this.topSectorBoardCache.get(kind);
    if (
      !force &&
      cached &&
      cached.value.length >= count &&
      Date.now() - cached.at < SECTOR_TOP_CACHE_TTL
    ) {
      return cached.value.slice(0, count);
    }
    const fields =
      'f2,f3,f4,f8,f12,f13,f14,f22,f62,f104,f105,f124,f127,f128,f136,f140,f141';
    const filter = kind === 'industry' ? 'm:90+t:2' : 'm:90+t:3';
    const payload = await this.getSectorListPage(filter, 'f3', fields, 1, count);
    const value = this.mapSectorBoardRows(asArray<any>(payload.data.diff), kind)
      .sort((left, right) => right.percent - left.percent)
      .slice(0, count);
    if (!value.length) {
      throw new Error('Sector ranking data is unavailable');
    }
    this.topSectorBoardCache.set(kind, { at: Date.now(), value });
    return value;
  }

  public async getSectorOverview(force = false): Promise<SectorOverview> {
    if (
      !force &&
      this.sectorOverviewCache &&
      Date.now() - this.sectorOverviewCache.at < SECTOR_LIST_CACHE_TTL
    ) {
      return this.sectorOverviewCache.value;
    }
    const industry = await this.getSectorBoards('industry', force);
    const concept = await this.getSectorBoards('concept', force);
    const combined = [...industry, ...concept];
    const value: SectorOverview = {
      hot3d: [...combined]
        .sort((left, right) => right.threeDayPercent - left.threeDayPercent)
        .slice(0, 12),
      fast3m: [...combined]
        .sort((left, right) => right.threeMinutePercent - left.threeMinutePercent)
        .slice(0, 12),
      industryTopInflow: [...industry]
        .sort((left, right) => right.netInflow - left.netInflow)
        .slice(0, 10),
      conceptTopInflow: [...concept]
        .sort((left, right) => right.netInflow - left.netInflow)
        .slice(0, 10),
      updatedAt: Date.now()
    };
    this.sectorOverviewCache = { at: Date.now(), value };
    return value;
  }

  public async getSectorConstituents(
    bkCode: string,
    force = false
  ): Promise<SectorConstituent[]> {
    const normalized = bkCode.trim().toUpperCase().replace(/^90\./, '');
    if (!/^BK\d+$/.test(normalized)) {
      throw new Error('Invalid sector board code: ' + bkCode);
    }
    const cached = this.sectorConstituentCache.get(normalized);
    if (!force && cached && Date.now() - cached.at < SECTOR_DETAIL_CACHE_TTL) {
      return cached.value;
    }
    const fields = 'f2,f3,f4,f8,f12,f13,f14,f20,f62,f124';
    const rows = await this.getSectorListRows('b:' + normalized, 'f3', fields);
    const value = rows
      .map((item) => {
        const rawCode = String(item.f12 || '').trim();
        const secid = String(toNumber(item.f13)) + '.' + rawCode;
        const timestamp = toNumber(item.f124);
        return {
          code: secidToCode(secid, rawCode),
          secid,
          name: String(item.f14 || rawCode),
          price: toNumber(item.f2),
          percent: toNumber(item.f3),
          change: toNumber(item.f4),
          turnover: toNumber(item.f8),
          netInflow: toNumber(item.f62),
          marketCap: toNumber(item.f20),
          updatedAt: timestamp > 0 ? timestamp * 1000 : Date.now()
        } as SectorConstituent;
      })
      .filter((item) => /^(sh|sz|bj)\d{6}$/.test(item.code));
    this.sectorConstituentCache.set(normalized, { at: Date.now(), value });
    return value;
  }

  public async getQuotes(codes: string[]): Promise<Quote[]> {
    const unique = Array.from(new Set(codes.map((item) => item.toLowerCase())));
    const chunks: string[][] = [];
    for (let index = 0; index < unique.length; index += 45) {
      chunks.push(unique.slice(index, index + 45));
    }
    const results = await Promise.all(chunks.map((chunk) => this.getQuoteChunk(chunk)));
    return results.flat();
  }

  private async getQuoteChunk(codes: string[]): Promise<Quote[]> {
    if (!codes.length) {
      return [];
    }
    const secids = codes.map(codeToSecid);
    const codeBySecid = new Map(secids.map((secid, index) => [secid, codes[index]]));
    const fields =
      'f2,f3,f4,f5,f6,f7,f8,f9,f10,f12,f13,f14,f15,f16,f17,f18,f20,f21,f23,f124';
    const url =
      'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=' +
      fields +
      '&secids=' +
      secids.join(',');
    const payload = await this.getJson<any>(url);
    return asArray<any>(payload?.data?.diff)
      .map((item): Quote | undefined => {
        const secid = String(item.f13) + '.' + String(item.f12);
        const code = codeBySecid.get(secid) || secidToCode(secid, String(item.f12));
        const quote = {
          code,
          secid,
          name: String(item.f14 || code),
          price: toNumber(item.f2),
          percent: toNumber(item.f3),
          change: toNumber(item.f4),
          volume: toNumber(item.f5),
          amount: toNumber(item.f6),
          high: toNumber(item.f15),
          low: toNumber(item.f16),
          open: toNumber(item.f17),
          previousClose: toNumber(item.f18),
          amplitude: toNumber(item.f7),
          volumeRatio: toNumber(item.f10),
          turnover: toNumber(item.f8),
          pe: toNumber(item.f9),
          pb: toNumber(item.f23),
          marketCap: toNumber(item.f20),
          floatMarketCap: toNumber(item.f21),
          updatedAt: toNumber(item.f124) > 0 ? toNumber(item.f124) * 1000 : Date.now()
        } as Quote;
        // Eastmoney commonly reports f2 as zero or "-" before continuous
        // trading while f18 already contains yesterday's close. Quotes with
        // neither value are omitted so direct consumers never receive price 0.
        return resolveQuoteForDisplay(quote);
      })
      .filter((quote): quote is Quote => Boolean(quote));
  }

  public async searchStocks(query: string): Promise<SearchResult[]> {
    const text = query.trim();
    if (!text) {
      return [];
    }
    // LeekFund 4.2.9 uses Tencent SmartBox for its live stock picker. Unlike
    // Eastmoney's best-match endpoint it returns the broad result set needed
    // for inputs such as "视" and market prefixes such as "sh".
    const tencentUrl =
      'https://proxy.finance.qq.com/ifzqgtimg/appstock/smartbox/search/get?q=' +
      encodeURIComponent(text);
    const payload = await this.getJson<any>(tencentUrl);
    if (payload?.code !== 0 || !payload?.data) {
      throw new Error('腾讯股票联想暂不可用，请重试');
    }
    return parseTencentStockSearch(payload);
  }

  public async getChart(
    code: string,
    interval: ChartInterval,
    force = false
  ): Promise<ChartPayload> {
    const cacheKey = code + ':' + interval;
    const cached = this.chartCache.get(cacheKey);
    // Only a visible stock panel asks for this at the automatic cadence, so
    // refreshing the current candle at the configured quote interval is safe.
    const ttl = 2500;
    if (!force && cached && Date.now() - cached.at < ttl) {
      return cached.value;
    }
    const value =
      interval === 'trend' || interval === 'trend5'
        ? await this.getTrend(code, interval)
        : await this.getKline(code, interval);
    this.chartCache.set(cacheKey, { at: Date.now(), value });
    return value;
  }

  private async getTrend(
    code: string,
    interval: 'trend' | 'trend5'
  ): Promise<ChartPayload> {
    const secid = codeToSecid(code);
    const url =
      'https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=' +
      secid +
      '&ndays=' +
      (interval === 'trend5' ? '5' : '1') +
      '&iscr=0&iscca=0&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13' +
      '&fields2=f51,f52,f53,f54,f55,f56,f57,f58';
    const payload = await this.getJson<any>(url);
    if (!payload?.data) {
      throw new Error('分时数据暂不可用');
    }
    const points: TrendPoint[] = asArray<string>(payload.data.trends).map((line) => {
      const parts = String(line).split(',');
      return {
        time: parts[0],
        price: toNumber(parts[1]),
        average: toNumber(parts[7], toNumber(parts[1])),
        volume: toNumber(parts[5])
      };
    });
    return {
      code,
      name: String(payload.data.name || code),
      interval,
      kind: 'trend',
      points
    };
  }

  private async getKline(
    code: string,
    interval: Exclude<ChartInterval, 'trend' | 'trend5'>
  ): Promise<ChartPayload> {
    if (interval === '101' || interval === '102' || interval === '103') {
      const daily = await this.getSohuDailyKline(code);
      const points =
        interval === '101' ? daily : aggregateDailyCandles(daily, interval);
      return {
        code,
        name: code,
        interval,
        kind: 'candle',
        points: points.slice(-260)
      };
    }
    const secid = codeToSecid(code);
    const limit = ['1', '5', '15', '30', '60'].includes(interval) ? 320 : 260;
    const url =
      'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=' +
      secid +
      '&klt=' +
      interval +
      '&fqt=1&lmt=' +
      String(limit) +
      '&end=20500101&fields1=f1,f2,f3,f4,f5,f6,f7,f8' +
      '&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61';
    const payload = await this.getJson<any>(url);
    if (!payload?.data) {
      throw new Error('K 线数据暂不可用');
    }
    const points: CandlePoint[] = asArray<string>(payload.data.klines)
      .slice(-limit)
      .map<CandlePoint>((line) => {
        const parts = String(line).split(',');
        return {
          time: parts[0],
          open: toNumber(parts[1]),
          close: toNumber(parts[2]),
          high: toNumber(parts[3]),
          low: toNumber(parts[4]),
          volume: toNumber(parts[5]),
          amount: toNumber(parts[6]),
          percent: toNumber(parts[8]),
          turnover: toNumber(parts[10])
        };
      });
    return {
      code,
      name: String(payload.data.name || code),
      interval,
      kind: 'candle',
      points
    };
  }

  private async getSohuDailyKline(code: string): Promise<SohuDailyCandle[]> {
    const secid = codeToSecid(code);
    const [market, digits] = secid.split('.');
    if ((market !== '0' && market !== '1') || !/^\d{6}$/.test(digits || '')) {
      throw new Error('K 线代码暂不支持');
    }
    const today = shanghaiDateKey().replace(/-/g, '');
    const url =
      'https://q.stock.sohu.com/hisHq?code=cn_' +
      digits +
      '&start=19900101&end=' +
      today +
      '&stat=1&order=D&period=d&callback=historySearchHandler&rt=jsonp';
    const text = await this.getText(url, 30_000, 2);
    const start = text.indexOf('(');
    const end = text.lastIndexOf(')');
    if (start < 0 || end <= start) {
      throw new Error('K 线备源返回格式错误');
    }
    const payload = JSON.parse(text.slice(start + 1, end));
    const rows = asArray<any>(asArray<any>(payload)[0]?.hq);
    return rows
      .map<SohuDailyCandle>((row) => {
        const fields = asArray<any>(row);
        const close = toNumber(fields[2]);
        const change = toNumber(fields[3]);
        return {
          time: String(fields[0] || ''),
          open: toNumber(fields[1]),
          close,
          high: toNumber(fields[6]),
          low: toNumber(fields[5]),
          volume: Math.round(toNumber(fields[7])),
          amount: toNumber(fields[8]) * 10_000,
          percent: percentage(fields[4]),
          turnover: percentage(fields[9]),
          previousClose: close - change
        };
      })
      .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item.time) && item.close > 0)
      .sort((left, right) => left.time.localeCompare(right.time));
  }

  public async getNews(force = false): Promise<NewsItem[]> {
    if (!force && this.newsCache && Date.now() - this.newsCache.at < 45000) {
      return this.newsCache.value;
    }
    let value: NewsItem[];
    try {
      value = await this.getEastmoneyJsonpNews();
    } catch {
      value = await this.getEastmoneyFastNews();
    }
    this.newsCache = { at: Date.now(), value };
    return value;
  }

  private async getEastmoneyJsonpNews(): Promise<NewsItem[]> {
    const url =
      'https://newsapi.eastmoney.com/kuaixun/v1/getlist_102_ajaxResult_40_1_.html?_=' +
      String(Date.now());
    const text = await this.getText(url);
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) {
      throw new Error('资讯返回格式错误');
    }
    const payload = JSON.parse(text.slice(start, end + 1));
    return asArray<any>(payload.LivesList).map((item) => ({
      id: String(item.id || item.newsid || item.sort),
      time: String(item.showtime || item.ordertime || ''),
      title: String(item.title || item.simtitle || '市场快讯'),
      summary: String(item.digest || item.simdigest || ''),
      url: String(item.url_w || item.url_m || '')
    }));
  }

  private async getEastmoneyFastNews(): Promise<NewsItem[]> {
    const url =
      'https://np-weblist.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724' +
      '&fastColumn=102&sortEnd=&pageSize=40&req_trace=' +
      String(Date.now());
    const payload = await this.getJson<any>(url);
    const list = asArray<any>(payload?.data?.fastNewsList);
    return list.map((item) => ({
      id: String(item.code || item.id || item.realSort),
      time: String(item.showTime || item.showtime || ''),
      title: String(item.title || '市场快讯'),
      summary: String(item.summary || item.digest || ''),
      url: String(item.url || item.url_w || '')
    }));
  }

  public async getStockProfile(code: string, force = false): Promise<StockProfile> {
    const normalized = code.toLowerCase();
    const cached = this.profileCache.get(normalized);
    if (!force && cached && Date.now() - cached.at < 1800000) {
      return cached.value;
    }
    if (INDEX_CODES.has(normalized)) {
      const value: StockProfile = {
        code: normalized,
        fullName: 'A 股市场指数',
        englishName: '',
        industry: '市场指数',
        subIndustry: '指数',
        listingBoard: normalized.startsWith('sh') ? '上海证券交易所' : '深圳证券交易所',
        listingDate: '--',
        exchange: normalized.startsWith('sh') ? '上海证券交易所' : '深圳证券交易所',
        registeredCapital: '--',
        employeeCount: '--',
        website: '',
        business: '用于反映对应股票市场或样本组合的整体价格表现。',
        summary: '指数不是上市公司，不提供企业简介、社区热度和个股异动解读。',
        concepts: ['市场指数'],
        community: {
          thsAvailable: false,
          thsHeat: null,
          thsRank: null,
          thsRankChange: null,
          thsPeriod: '1小时',
          xueqiuAvailable: false,
          xueqiuFollowers: null
        },
        anomalies: [],
        updatedAt: Date.now()
      };
      this.profileCache.set(normalized, { at: Date.now(), value });
      return value;
    }

    const prefix = normalized.slice(0, 2).toUpperCase();
    const digits = normalized.replace(/^(sh|sz|bj)/, '');
    const companyUrl =
      'https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/CompanySurveyAjax?code=' +
      prefix +
      digits;
    const conceptUrl =
      'https://emweb.securities.eastmoney.com/PC_HSF10/CoreConception/PageAjax?code=' +
      prefix +
      digits;
    const thsHotUrl =
      'https://dq.10jqka.com.cn/fuyao/hot_list_data/out/hot_list/v1/stock' +
      '?stock_type=a&type=hour&list_type=normal';
    const xueqiuSymbol = prefix + digits;
    const xueqiuUrl =
      'https://xueqiu.com/service/v5/stock/screener/screen' +
      '?category=CN&size=1&order=desc&order_by=follow&only_count=0&page=1&symbol=' +
      encodeURIComponent(xueqiuSymbol);
    const thsMarket = normalized.startsWith('sh')
      ? '17'
      : normalized.startsWith('bj')
        ? '151'
        : '33';
    const anomalyLatestUrl =
      'https://dq.10jqka.com.cn/fuyao/transaction_history/service/v1/get/' +
      thsMarket +
      '_' +
      digits +
      '.txt';
    const anomalyHistoryUrl = 'https://flow.10jqka.com.cn/anomaly/v1/history';
    const anomalyHistoryReferer =
      'https://flow.10jqka.com.cn/app/anomaly_analysis/history?marketId=' +
      thsMarket +
      '&thsHqCode=' +
      digits;

    const [
      companyResult,
      conceptResult,
      thsHotResult,
      xueqiuResult,
      anomalyHistoryResult,
      anomalyLatestResult
    ] =
      await Promise.allSettled([
        this.getJson<any>(companyUrl, 15000),
        this.getJson<any>(conceptUrl, 15000),
        this.getJson<any>(thsHotUrl, 15000),
        this.getJson<any>(xueqiuUrl, 15000),
        this.postJson<any>(
          anomalyHistoryUrl,
          { thsHqCode: digits, marketId: thsMarket, count: 31 },
          anomalyHistoryReferer,
          15000
        ),
        this.getJson<any>(anomalyLatestUrl, 15000)
      ]);
    const company = companyResult.status === 'fulfilled' ? companyResult.value?.jbzl || {} : {};
    const boardRows =
      conceptResult.status === 'fulfilled' ? asArray<any>(conceptResult.value?.ssbk) : [];
    const rankOne = boardRows.find((item) => toNumber(item.BOARD_RANK) === 1);
    const rankTwo = boardRows.find((item) => toNumber(item.BOARD_RANK) === 2);
    const concepts = Array.from(
      new Set(
        boardRows
          .map((item) => String(item.BOARD_NAME || '').trim())
          .filter(Boolean)
      )
    ).slice(0, 24);
    const thsRows =
      thsHotResult.status === 'fulfilled'
        ? asArray<any>(thsHotResult.value?.data?.stock_list)
        : [];
    const thsRow = thsRows.find((item) => String(item?.code || '') === digits);
    const xueqiuRows =
      xueqiuResult.status === 'fulfilled'
        ? asArray<any>(xueqiuResult.value?.data?.list)
        : [];
    const xueqiuRow = xueqiuRows.find(
      (item) => String(item?.symbol || '').toUpperCase() === xueqiuSymbol
    );
    const historyRows =
      anomalyHistoryResult.status === 'fulfilled'
        ? asArray<any>(anomalyHistoryResult.value?.data?.anomalyAnalysisList)
        : [];
    const anomalyRows = historyRows.length
      ? historyRows
      : anomalyLatestResult.status === 'fulfilled'
        ? asArray<any>(anomalyLatestResult.value?.data?.anomalyAnalysisList)
        : [];
    const anomalyCutoffDate = oneMonthAgoShanghaiDateKey();
    const anomalies = anomalyRows
      .map((item, index) => {
        const keywords = asArray<unknown>(item?.keywordList)
          .map((keyword) => String(keyword || '').trim())
          .filter(Boolean);
        return {
          id: String(item?.id || digits + '-' + String(index)),
          date: String(item?.date || '').slice(0, 10),
          title: keywords.join(' · ') || String(item?.tagName || '异动解读'),
          tagName: String(item?.tagName || '异动'),
          content: String(item?.reason || '').trim(),
          keywords
        };
      })
      .filter(
        (item) =>
          item.content.length > 0 &&
          /^\d{4}-\d{2}-\d{2}$/.test(item.date) &&
          item.date >= anomalyCutoffDate
      );
    const industry = String(company.sshy || rankOne?.BOARD_NAME || '其他行业');
    const subIndustry = String(rankTwo?.BOARD_NAME || company.sszjhhy || industry);
    const value: StockProfile = {
      code: normalized,
      fullName: String(company.gsmc || company.agjc || digits),
      englishName: String(company.ywmc || ''),
      industry,
      subIndustry,
      listingBoard: String(company.zqlb || '--'),
      listingDate: String(company.agssrq || company.ssrq || company.clrq || '--').slice(0, 10),
      exchange: String(company.ssjys || '--'),
      registeredCapital: String(company.zczb || '--'),
      employeeCount: String(company.gyrs || '--'),
      website: String(company.gswz || ''),
      business: String(company.jyfw || company.zyfw || '暂无主营业务信息。'),
      summary: String(company.gsjj || '暂无公司简介。').trim(),
      concepts: concepts.length ? concepts : [industry],
      community: {
        thsAvailable: thsHotResult.status === 'fulfilled' && Array.isArray(thsHotResult.value?.data?.stock_list),
        thsHeat: thsRow ? toNumber(thsRow.rate) : null,
        thsRank: thsRow ? toNumber(thsRow.order || thsRow.display_order) : null,
        thsRankChange: thsRow ? toNumber(thsRow.hot_rank_chg) : null,
        thsPeriod: '1小时',
        xueqiuAvailable: xueqiuResult.status === 'fulfilled' && Boolean(xueqiuResult.value?.data),
        xueqiuFollowers: xueqiuRow ? toNumber(xueqiuRow.follow) : null
      },
      anomalies,
      updatedAt: Date.now()
    };
    this.profileCache.set(normalized, { at: Date.now(), value });
    return value;
  }

  public async getRealtimeExtras(code: string, force = false): Promise<RealtimeExtras> {
    const normalized = code.toLowerCase();
    const cached = this.extrasCache.get(normalized);
    if (!force && cached && Date.now() - cached.at < 3500) {
      return cached.value;
    }
    const secid = codeToSecid(normalized);
    const flowUrl =
      'https://push2.eastmoney.com/api/qt/stock/fflow/kline/get?lmt=1&klt=1&secid=' +
      secid +
      '&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63';
    const detailUrl =
      'https://push2.eastmoney.com/api/qt/stock/details/get?secid=' +
      secid +
      '&fields1=f1,f2,f3,f4,f5&fields2=f51,f52,f53,f54,f55&pos=-40&iscca=1&invt=2';
    const [flowResult, detailResult] = await Promise.allSettled([
      this.getJson<any>(flowUrl, 6000, 1),
      this.getJson<any>(detailUrl, 6000, 1)
    ]);
    const now = Date.now();
    const sessionDate = shanghaiDateKey(new Date(now));
    const previous = cached?.value.sessionDate === sessionDate ? cached.value : undefined;
    const flowPayload = flowResult.status === 'fulfilled' ? flowResult.value : undefined;
    const flowLines =
      flowResult.status === 'fulfilled' ? asArray<string>(flowPayload?.data?.klines) : [];
    const flowParts = String(flowLines.at(-1) || '').split(',');
    const flowAvailable = Boolean(
      flowPayload?.data &&
      flowLines.length &&
      flowParts.length >= 6 &&
      flowParts.slice(1, 6).every((part) => Number.isFinite(Number(part)))
    );
    const detailPayload = detailResult.status === 'fulfilled' ? detailResult.value : undefined;
    const detailAvailable = Boolean(
      detailPayload?.data && Array.isArray(detailPayload.data.details)
    );
    const detailLines =
      detailAvailable ? asArray<string>(detailPayload.data.details) : [];
    const parsedTrades: TradeTick[] = detailLines
      .slice(-30)
      .reverse()
      .map<TradeTick>((line) => {
        const parts = String(line).split(',');
        const sideCode = String(parts[4] || '');
        return {
          time: String(parts[0] || ''),
          price: toNumber(parts[1]),
          volume: toNumber(parts[2]),
          trades: toNumber(parts[3]),
          side: sideCode === '2' ? 'buy' : sideCode === '1' ? 'sell' : 'neutral',
          auction: sideCode === '4' && toNumber(parts[3]) === 0
        };
      })
      .filter((item) => Boolean(item.time) && item.price > 0 && item.volume >= 0);

    if (!flowAvailable && !detailAvailable && !previous) {
      throw new Error('实时资金与成交明细暂不可用');
    }

    const flow = flowAvailable
      ? {
          mainNet: toNumber(flowParts[1]),
          smallNet: toNumber(flowParts[2]),
          mediumNet: toNumber(flowParts[3]),
          largeNet: toNumber(flowParts[4]),
          superLargeNet: toNumber(flowParts[5])
        }
      : previous?.flow || {
          mainNet: 0,
          smallNet: 0,
          mediumNet: 0,
          largeNet: 0,
          superLargeNet: 0
        };
    const trades = parsedTrades.length ? parsedTrades : previous?.trades || [];
    const flowUpdatedAt = flowAvailable
      ? now
      : previous?.flowUpdatedAt || previous?.updatedAt || 0;
    const tradesUpdatedAt = parsedTrades.length
      ? now
      : previous?.tradesUpdatedAt || previous?.updatedAt || 0;
    const value: RealtimeExtras = {
      code: normalized,
      flow,
      trades,
      updatedAt: Math.max(flowUpdatedAt, tradesUpdatedAt) || now,
      flowUpdatedAt,
      tradesUpdatedAt,
      sessionDate,
      partial:
        !flowAvailable ||
        !detailAvailable ||
        (!parsedTrades.length && Boolean(previous?.trades.length))
    };
    this.extrasCache.set(normalized, { at: now, value });
    return value;
  }

  public getCloudUpdatedAt(filter: MarketFilter): number {
    return this.cloudUpdatedAt.get(filter) || Date.now();
  }

  public async getCloud(filter: MarketFilter, force = false): Promise<CloudStock[]> {
    const cached = this.cloudCache.get(filter);
    if (!force && cached && Date.now() - cached.at < 300000) {
      return cached.value;
    }
    let value: CloudStock[];
    try {
      value = await this.getEastmoneyCloud(filter);
      if (value.length < 20) {
        throw new Error('东方财富云图返回数据不足');
      }
    } catch {
      value = await this.getSinaCloud(filter);
    }
    this.cloudCache.set(filter, { at: Date.now(), value });
    this.cloudUpdatedAt.set(filter, Date.now());
    return value;
  }

  private async getEastmoneyCloud(filter: MarketFilter): Promise<CloudStock[]> {
    const filterMap: Record<MarketFilter, string> = {
      all: 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048',
      sh: 'm:1+t:2,m:1+t:23',
      sz: 'm:0+t:6,m:0+t:80',
      bj: 'm:0+t:81+s:2048',
      star: 'm:1+t:23',
      chinext: 'm:0+t:80'
    };
    const fields = 'f12,f13,f14,f2,f3,f20,f100';
    const pageSize = 100;
    const fetchPage = async (page: number): Promise<any> => {
      const url =
        'https://push2.eastmoney.com/api/qt/clist/get?pn=' +
        String(page) +
        '&pz=' +
        String(pageSize) +
        '&po=1&np=1&fltt=2&invt=2&fid=f20' +
        '&ut=bd1d9ddb04089700cf9c27f6f7426281&fs=' +
        encodeURIComponent(filterMap[filter]) +
        '&fields=' +
        fields;
      return this.getJson<any>(url, 18000);
    };

    const hierarchyPromise = this.getIndustryHierarchy().catch(
      () => new Map<string, IndustryHierarchy>()
    );
    const first = await fetchPage(1);
    const total = Math.max(0, toNumber(first?.data?.total));
    const pageCount = Math.min(70, Math.max(1, Math.ceil(total / pageSize)));
    const rows = [...asArray<any>(first?.data?.diff)];
    const pages = Array.from({ length: pageCount - 1 }, (_item, index) => index + 2);
    for (let index = 0; index < pages.length; index += 6) {
      const batch = pages.slice(index, index + 6);
      const payloads = await Promise.allSettled(batch.map((page) => fetchPage(page)));
      for (const result of payloads) {
        if (result.status === 'fulfilled') {
          rows.push(...asArray<any>(result.value?.data?.diff));
        }
      }
    }
    const expectedRows = Math.min(total, pageCount * pageSize);
    if (expectedRows > 0 && rows.length < expectedRows * 0.85) {
      throw new Error('东方财富云图分页数据不完整');
    }

    const hierarchy = await hierarchyPromise;
    const seen = new Set<string>();
    const value = rows
      .map((item) => {
        const secid = String(item.f13) + '.' + String(item.f12);
        const relation = hierarchy.get(String(item.f12));
        const subIndustry = relation?.subIndustry || String(item.f100 || '其他');
        return {
          code: secidToCode(secid, String(item.f12)),
          secid,
          name: String(item.f14 || item.f12),
          price: toNumber(item.f2),
          percent: toNumber(item.f3),
          marketCap: Math.max(1, toNumber(item.f20, 1)),
          industry: relation?.industry || primaryIndustryOf(subIndustry),
          subIndustry
        } as CloudStock;
      })
      .filter((item) => {
        if (item.price <= 0 || !Number.isFinite(item.percent) || seen.has(item.secid)) {
          return false;
        }
        seen.add(item.secid);
        return true;
      });
    return value;
  }

  private async getIndustryHierarchy(): Promise<Map<string, IndustryHierarchy>> {
    const cached = this.industryHierarchyCache;
    if (cached && Date.now() - cached.at < 12 * 60 * 60 * 1000) {
      return cached.value;
    }
    const pageSize = 500;
    const fetchPage = async (page: number): Promise<any> => {
      const query = new URLSearchParams({
        reportName: 'RPT_F10_CORETHEME_BOARDTYPE',
        columns: 'SECURITY_CODE,BOARD_NAME,BOARD_RANK',
        source: 'WEB',
        client: 'WEB',
        filter: '(BOARD_RANK<=2)',
        sortColumns: 'SECURITY_CODE,BOARD_RANK',
        sortTypes: '1,1',
        pageNumber: String(page),
        pageSize: String(pageSize)
      });
      return this.getJson<any>(
        'https://datacenter-web.eastmoney.com/api/data/v1/get?' + query.toString(),
        18000
      );
    };
    const first = await fetchPage(1);
    if (first?.success === false || !first?.result) {
      throw new Error('行业层级数据暂不可用');
    }
    const pages = Math.min(50, Math.max(1, toNumber(first.result.pages, 1)));
    const rows = [...asArray<any>(first.result.data)];
    const remaining = Array.from({ length: pages - 1 }, (_item, index) => index + 2);
    for (let index = 0; index < remaining.length; index += 6) {
      const payloads = await Promise.allSettled(
        remaining.slice(index, index + 6).map((page) => fetchPage(page))
      );
      for (const payload of payloads) {
        if (payload.status === 'fulfilled') {
          rows.push(...asArray<any>(payload.value?.result?.data));
        }
      }
    }
    const grouped = new Map<string, { one?: string; two?: string }>();
    for (const row of rows) {
      const rawCode = String(row.SECURITY_CODE || '').trim();
      if (!/^\d{6}$/.test(rawCode)) {
        continue;
      }
      const code = rawCode;
      const current = grouped.get(code) || {};
      const rank = toNumber(row.BOARD_RANK);
      if (rank === 1 && !current.one) {
        current.one = String(row.BOARD_NAME || '').trim();
      } else if (rank === 2 && !current.two) {
        current.two = String(row.BOARD_NAME || '').trim();
      }
      grouped.set(code, current);
    }
    const value = new Map<string, IndustryHierarchy>();
    for (const [code, levels] of grouped) {
      const industry = levels.one || primaryIndustryOf(levels.two || '其他');
      const subIndustry = levels.two || industry;
      value.set(code, { industry, subIndustry });
    }
    if (value.size < 1000) {
      throw new Error('行业层级数据不完整');
    }
    this.industryHierarchyCache = { at: Date.now(), value };
    return value;
  }

  private async getSinaCloud(filter: MarketFilter): Promise<CloudStock[]> {
    const hierarchyPromise = this.getIndustryHierarchy().catch(
      () => new Map<string, IndustryHierarchy>()
    );
    const node = filter === 'sh' || filter === 'star' ? 'sh_a' : filter === 'sz' || filter === 'chinext' ? 'sz_a' : 'hs_a';
    const rows: any[] = [];
    const pageSize = 100;
    const fetchPage = async (page: number): Promise<any[]> => {
      const url =
        'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/' +
        'Market_Center.getHQNodeData?page=' +
        String(page) +
        '&num=' +
        String(pageSize) +
        '&sort=symbol&asc=1&node=' +
        node +
        '&symbol=&_s_r_a=page';
      return asArray<any>(await this.getJson<any>(url, 18000));
    };

    for (let start = 1; start <= 70; start += 6) {
      const pages = Array.from({ length: 6 }, (_item, index) => start + index);
      const results = await Promise.allSettled(pages.map((page) => fetchPage(page)));
      let reachedEnd = false;
      for (const result of results) {
        if (result.status === 'fulfilled') {
          rows.push(...result.value);
          reachedEnd ||= result.value.length < pageSize;
        }
      }
      if (reachedEnd) {
        break;
      }
    }

    const accepts = (code: string): boolean => {
      if (!/^(sh|sz|bj)\d{6}$/.test(code)) {
        return false;
      }
      if (filter === 'sh') {
        return code.startsWith('sh');
      }
      if (filter === 'sz') {
        return code.startsWith('sz');
      }
      if (filter === 'bj') {
        return code.startsWith('bj');
      }
      if (filter === 'star') {
        return code.startsWith('sh68');
      }
      if (filter === 'chinext') {
        return code.startsWith('sz30');
      }
      return true;
    };
    const boardName = (code: string): string => {
      if (code.startsWith('bj')) {
        return '北交所';
      }
      if (code.startsWith('sh68')) {
        return '科创板';
      }
      if (code.startsWith('sz30')) {
        return '创业板';
      }
      return code.startsWith('sh') ? '沪市主板' : '深市主板';
    };

    const hierarchy = await hierarchyPromise;
    const seen = new Set<string>();
    return rows
      .map((item) => {
        const code = String(item.symbol || '').toLowerCase();
        const digits = code.replace(/^(sh|sz|bj)/, '');
        const relation = hierarchy.get(digits);
        const fallbackSubIndustry = boardName(code);
        return {
          code,
          secid: codeToSecid(code),
          name: String(item.name || item.code || code),
          price: toNumber(item.trade),
          percent: toNumber(item.changepercent),
          marketCap: Math.max(1, toNumber(item.mktcap, 1) * 10000),
          industry: relation?.industry || '交易市场',
          subIndustry: relation?.subIndustry || fallbackSubIndustry
        } as CloudStock;
      })
      .filter((item) => {
        if (!accepts(item.code) || item.price <= 0 || !Number.isFinite(item.percent) || seen.has(item.code)) {
          return false;
        }
        seen.add(item.code);
        return true;
      });
  }
}
