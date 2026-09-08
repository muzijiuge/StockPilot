import {
  CandlePoint,
  ChartInterval,
  ChartPayload,
  CloudStock,
  CommunityComment,
  CommunityCommentCursor,
  CommunityCommentPage,
  CommunityCursor,
  CommunityPage,
  CommunityPost,
  CommunityPostDetail,
  CommunityPostSort,
  INDEX_CODES,
  MarketFilter,
  NewsItem,
  Quote,
  RealtimeExtras,
  SearchResult,
  SectorBoard,
  SectorBoardKind,
  SectorBoardSort,
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

interface HtmlTableCell {
  html: string;
  text: string;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) =>
      String.fromCodePoint(Number.parseInt(code, 16))
    )
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function htmlText(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<br\s*\/?\s*>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function communityPlainText(value: unknown): string {
  return decodeHtmlEntities(
    String(value || '')
      .replace(
        /<hx_stock>([\s\S]*?)<\/hx_stock>/gi,
        (_match, stock) => {
          const name = String(stock).match(/stockName:([^,]+)/i)?.[1]?.trim() || '';
          const code = String(stock).match(/stockCode:(\d{6})/i)?.[1] || '';
          return name ? '$' + name + (code ? '(' + code + ')' : '') + '$' : code;
        }
      )
      .replace(/<img\b[^>]*\btitle=(['"])(.*?)\1[^>]*>/gi, '$2')
      .replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/<\/p\s*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/[ \t\f\v]+/g, ' ')
      .replace(/\n\s*\n+/g, '\n')
      .trim()
  );
}

function communityHttpsUrl(value: unknown): string {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }
  const normalized = raw.startsWith('//')
    ? 'https:' + raw
    : raw.startsWith('/')
      ? 'https://t.10jqka.com.cn' + raw
      : raw;
  try {
    const parsed = new URL(normalized);
    const hostname = parsed.hostname.toLowerCase();
    if (
      parsed.protocol !== 'https:' ||
      !(
        hostname === '10jqka.com.cn' ||
        hostname.endsWith('.10jqka.com.cn') ||
        hostname === 'thsi.cn' ||
        hostname.endsWith('.thsi.cn')
      )
    ) {
      return '';
    }
    return parsed.toString();
  } catch {
    return '';
  }
}

function communityTimestamp(value: unknown): number {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function communityContentId(value: unknown): string {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }
  if (/^[a-z0-9]+$/i.test(raw)) {
    return raw;
  }
  try {
    const url = new URL(raw.startsWith('//') ? 'https:' + raw : raw);
    return String(url.searchParams.get('contentId') || url.searchParams.get('content_id') || '');
  } catch {
    return '';
  }
}

/** Converts one public 同花顺 feed row to the extension's read-only card model. */
export function parseTonghuashunCommunityPost(item: any): CommunityPost | null {
  const info = item?.info || {};
  const author = item?.author || {};
  const stat = item?.stat || {};
  const id = String(info.id || item?.id || '').trim();
  if (!id) {
    return null;
  }
  const imageCandidates = [
    ...asArray<unknown>(item?.image?.urls),
    ...asArray<any>(item?.share?.display_info?.images).map((image) => image?.url),
    item?.share?.display_info?.image
  ];
  const images = Array.from(
    new Set(imageCandidates.map(communityHttpsUrl).filter(Boolean))
  ).slice(0, 9);
  const title = communityPlainText(item?.title?.content || item?.title || '');
  const content = communityPlainText(
    item?.abstract?.content || item?.content?.content || item?.content || ''
  );
  const tags = asArray<any>(item?.tag?.tags)
    .map((tag) => String(tag?.name || '').trim())
    .filter(Boolean)
    .slice(0, 6);
  return {
    id,
    contentId: communityContentId(
      info.content_id || info.contentId || info.jump_url || info.client_url || item?.jump_url
    ),
    author: String(author.name || author.nickname || '同花顺用户').trim(),
    authorDescription: String(author.description || '').trim(),
    avatar: communityHttpsUrl(author.avatar),
    title,
    content,
    images,
    publishedAt: communityTimestamp(info.ctime || item?.ctime),
    likeCount: toNumber(stat.like_num ?? stat.likeNum),
    commentCount: toNumber(stat.comment_num ?? stat.commentNum),
    forwardCount: toNumber(stat.forward_num ?? stat.forwardNum),
    url: communityHttpsUrl(info.jump_url || info.client_url || item?.jump_url),
    tags
  };
}

/** Converts a public 同花顺 comment row, including the replies embedded in it. */
export function parseTonghuashunCommunityComment(item: any): CommunityComment | null {
  const id = String(item?.id || '').trim();
  if (!id) {
    return null;
  }
  const user = item?.from_user || item?.fromUser || {};
  const inReplyToUser = item?.in_reply_to_user || item?.inReplyToUser || {};
  const replies = asArray<any>(item?.child_comments ?? item?.childComments)
    .map(parseTonghuashunCommunityComment)
    .filter((reply): reply is CommunityComment => Boolean(reply));
  return {
    id,
    author: String(user.nickname || user.name || '同花顺用户').trim(),
    avatar: communityHttpsUrl(user.avatar),
    content: communityPlainText(item?.content),
    publishedAt: communityTimestamp(item?.ctime),
    replyTo: String(inReplyToUser.nickname || inReplyToUser.name || '').trim(),
    isAuthor: Boolean(toNumber(user.is_article_author ?? user.isArticleAuthor)),
    replyCount: Math.max(toNumber(item?.reply_num ?? item?.replyNum), replies.length),
    replies
  };
}

/** Parses the public post-info payload and keeps a feed card as a safe fallback. */
export function parseTonghuashunCommunityPostDetail(
  payload: any,
  fallback: CommunityPost
): { post: CommunityPost; ipLocation: string } {
  const statusCode = toNumber(payload?.status_code ?? payload?.statusCode, -1);
  const raw = payload?.data?.post;
  if (statusCode !== 0 || !raw) {
    throw new Error(String(payload?.status_msg || payload?.statusMsg || '同花顺帖子详情暂不可用'));
  }
  const user = raw.user || {};
  const stat = raw.stat || {};
  const images = Array.from(
    new Set(
      asArray<unknown>(raw?.ext?.att_img?.img_urls ?? raw?.ext?.attImg?.imgUrls)
        .map(communityHttpsUrl)
        .filter(Boolean)
    )
  ).slice(0, 18);
  const forumName = String(raw?.forum?.name || payload?.data?.relate_forum?.name || '').trim();
  const contentId = communityContentId(raw.content_id || raw.contentId || raw.jump_url);
  const post: CommunityPost = {
    ...fallback,
    id: String(raw.id || raw.pid || fallback.id),
    contentId: contentId || fallback.contentId,
    author: String(user.nickname || user.name || fallback.author || '同花顺用户').trim(),
    authorDescription: String(user.description || fallback.authorDescription || '').trim(),
    avatar: communityHttpsUrl(user.avatar) || fallback.avatar,
    title: communityPlainText(raw.title || fallback.title),
    content: communityPlainText(raw.content || raw.short_content || fallback.content),
    images: images.length ? images : fallback.images,
    publishedAt: communityTimestamp(raw.ctime) || fallback.publishedAt,
    likeCount: Math.max(toNumber(stat.like ?? stat.like_num), fallback.likeCount),
    commentCount: Math.max(toNumber(stat.reply ?? stat.comment_num), fallback.commentCount),
    forwardCount: Math.max(toNumber(stat.forward ?? stat.share), fallback.forwardCount),
    url: communityHttpsUrl(raw.jump_url || raw.pc_jump_url) || fallback.url,
    tags: forumName ? Array.from(new Set([forumName, ...fallback.tags])) : fallback.tags
  };
  const location = raw.ip_location || raw.ipLocation || {};
  return {
    post,
    ipLocation: String(location.province_name || location.provinceName || location.area_name || '').trim()
  };
}

function htmlTableRows(source: string): HtmlTableCell[][] {
  const rows: HtmlTableCell[][] = [];
  for (const rowMatch of source.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = Array.from(
      rowMatch[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi),
      (cellMatch) => ({
        html: cellMatch[1],
        text: htmlText(cellMatch[1])
      })
    );
    if (cells.length) {
      rows.push(cells);
    }
  }
  return rows;
}

function jsonpPayload<T>(source: string): T {
  const start = source.indexOf('(');
  const end = source.lastIndexOf(')');
  if (start < 0 || end <= start) {
    throw new Error('同花顺 JSONP 数据格式无效');
  }
  return JSON.parse(source.slice(start + 1, end)) as T;
}

function thsNumber(value: string): number {
  return toNumber(value.replace(/[,，%亿万手元]/g, '').replace(/--/g, ''));
}

function thsAmount(value: string): number {
  const amount = thsNumber(value);
  if (/亿/.test(value)) {
    return amount * 100_000_000;
  }
  if (/万/.test(value)) {
    return amount * 10_000;
  }
  return amount;
}

function thsStockCode(value: string): string {
  const digits = value.trim();
  if (!/^\d{6}$/.test(digits)) {
    return '';
  }
  if (digits.startsWith('6')) {
    return 'sh' + digits;
  }
  if (/^(4|8|9)/.test(digits)) {
    return 'bj' + digits;
  }
  return 'sz' + digits;
}

function emptyThsSectorBoard(
  code: string,
  name: string,
  kind: SectorBoardKind,
  secid = code,
  updatedAt = Date.now()
): SectorBoard {
  return {
    code,
    secid,
    name,
    kind,
    price: 0,
    percent: 0,
    change: 0,
    turnover: 0,
    netInflow: 0,
    upCount: 0,
    downCount: 0,
    leaderName: '',
    leaderCode: '',
    leaderSecid: '',
    leaderPercent: 0,
    threeDayPercent: 0,
    threeMinutePercent: 0,
    updatedAt
  };
}

/** Parses the public 同花顺行业 table without mixing in other vendors' taxonomies. */
export function parseTonghuashunIndustryBoards(
  source: string,
  updatedAt = Date.now()
): SectorBoard[] {
  const boards = new Map<string, SectorBoard>();
  for (const match of source.matchAll(
    /<a\b[^>]*href=["'][^"']*\/thshy\/detail\/code\/(\d{6})\/["'][^>]*>([\s\S]*?)<\/a>/gi
  )) {
    const code = match[1];
    const name = htmlText(match[2]);
    if (name && !boards.has(code)) {
      boards.set(code, emptyThsSectorBoard(code, name, 'industry', code, updatedAt));
    }
  }
  for (const cells of htmlTableRows(source)) {
    if (cells.length < 12) {
      continue;
    }
    const boardMatch = cells[1].html.match(/\/thshy\/detail\/code\/(\d{6})\//i);
    if (!boardMatch) {
      continue;
    }
    const code = boardMatch[1];
    const price = thsNumber(cells[8].text);
    const percent = thsNumber(cells[2].text);
    const previousPrice = percent === -100 ? 0 : price / (1 + percent / 100);
    const leaderDigits =
      cells[9].html.match(/stockpage\.10jqka\.com\.cn\/(\d{6})\//i)?.[1] || '';
    const leaderCode = thsStockCode(leaderDigits);
    boards.set(code, {
      ...emptyThsSectorBoard(code, cells[1].text, 'industry', code, updatedAt),
      price,
      percent,
      change: previousPrice ? price - previousPrice : 0,
      netInflow: thsNumber(cells[5].text) * 100_000_000,
      upCount: thsNumber(cells[6].text),
      downCount: thsNumber(cells[7].text),
      leaderName: cells[9].text,
      leaderCode,
      leaderSecid: leaderCode ? codeToSecid(leaderCode) : '',
      leaderPercent: thsNumber(cells[11].text)
    });
  }
  return Array.from(boards.values());
}

/** Parses 同花顺's own concept directory and its embedded live ranking payload. */
export function parseTonghuashunConceptBoards(
  source: string,
  updatedAt = Date.now()
): SectorBoard[] {
  const boards = new Map<string, SectorBoard>();
  for (const match of source.matchAll(
    /<a\b[^>]*href=["'][^"']*\/gn\/detail\/code\/(\d{6})\/["'][^>]*>([\s\S]*?)<\/a>/gi
  )) {
    const code = match[1];
    const name = htmlText(match[2]);
    if (name && !boards.has(code)) {
      boards.set(code, emptyThsSectorBoard(code, name, 'concept', code, updatedAt));
    }
  }

  const input = source.match(/<input\b[^>]*\bid=["']gnSection["'][^>]*>/i)?.[0] || '';
  const encodedPayload = input.match(/\bvalue=(["'])([\s\S]*?)\1/i)?.[2] || '';
  if (encodedPayload) {
    try {
      const payload = JSON.parse(decodeHtmlEntities(encodedPayload)) as Record<
        string,
        Record<string, unknown>
      >;
      for (const item of Object.values(payload)) {
        const code = String(item.cid || '').trim();
        const name = String(item.platename || '').trim();
        if (!/^\d{6}$/.test(code) || !name) {
          continue;
        }
        const current =
          boards.get(code) ||
          emptyThsSectorBoard(code, name, 'concept', String(item.platecode || code), updatedAt);
        boards.set(code, {
          ...current,
          name,
          secid: String(item.platecode || current.secid || code),
          percent: toNumber(item['199112']),
          netInflow: toNumber(item.zjjlr) * 100_000_000,
          updatedAt
        });
      }
    } catch {
      // The directory links above remain useful if 同花顺 temporarily omits the payload.
    }
  }
  return Array.from(boards.values());
}

/** Parses the headline and definition shown on an official 同花顺 board detail page. */
export function parseTonghuashunSectorBoardDetail(
  source: string,
  kind: SectorBoardKind,
  routeCode: string,
  base?: SectorBoard,
  updatedAt = Date.now()
): SectorBoard {
  const heading = source.match(
    /<h3[^>]*>\s*([\s\S]*?)<span[^>]*>\s*(88\d{4})\s*<\/span>\s*<\/h3>/i
  );
  const name = htmlText(heading?.[1] || base?.name || '');
  const secid = String(heading?.[2] || base?.secid || routeCode).trim();
  const price = thsNumber(
    htmlText(source.match(/class=["'][^"']*board-xj[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] || '')
  );
  const changeText = htmlText(
    source.match(/class=["'][^"']*board-zdf[^"']*["'][^>]*>([\s\S]*?)<\/p>/i)?.[1] || ''
  );
  const changes = Array.from(changeText.matchAll(/[+-]?\d+(?:\.\d+)?%?/g), (match) => match[0]);
  const info = new Map<string, string>();
  const infoSource = source.match(
    /class=["'][^"']*board-infos[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
  )?.[1];
  for (const match of String(infoSource || '').matchAll(
    /<dl[^>]*>[\s\S]*?<dt[^>]*>([\s\S]*?)<\/dt>[\s\S]*?<dd[^>]*>([\s\S]*?)<\/dd>[\s\S]*?<\/dl>/gi
  )) {
    info.set(htmlText(match[1]), htmlText(match[2]));
  }
  const definition = htmlText(
    source.match(
      /class=["'][^"']*board-txt[^"']*["'][^>]*>[\s\S]*?<h4[^>]*>\s*定义\s*<\/h4>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i
    )?.[1] || ''
  );
  const value = base || emptyThsSectorBoard(routeCode, name, kind, secid, updatedAt);
  const tradingStat = (label: string, previous: number | undefined): number | undefined => {
    const entry = Array.from(info.entries()).find(([key]) => key.replace(/[（(].*$/, '').trim() === label);
    if (!entry || !/\d/.test(entry[1])) return previous;
    const unit = entry[1].match(/[亿万千手股元]+/)?.[0] || entry[0].match(/[（(]([^）)]+)[）)]/)?.[1] || '';
    const factor = unit.includes('亿') ? 1e8 : unit.includes('万') ? 1e4 : unit.includes('千') ? 1e3 : 1;
    return thsNumber(entry[1]) * factor * (label === '成交量' && !unit.includes('股') ? 100 : 1);
  };
  return {
    ...value,
    code: routeCode,
    secid,
    name: name || value.name,
    kind,
    price: price || value.price,
    change: changes.length ? thsNumber(changes[0]) : value.change,
    percent: changes.length > 1 ? thsNumber(changes[1]) : value.percent,
    open: thsNumber(info.get('今开') || '') || value.open,
    previousClose: thsNumber(info.get('昨收') || '') || value.previousClose,
    low: thsNumber(info.get('最低') || '') || value.low,
    high: thsNumber(info.get('最高') || '') || value.high,
    volume: tradingStat('成交量', value.volume),
    amount: tradingStat('成交额', value.amount),
    description: definition || value.description,
    updatedAt
  };
}

/** Parses the first official 同花顺 constituent ranking page for a board. */
export function parseTonghuashunSectorConstituents(
  source: string,
  updatedAt = Date.now()
): SectorConstituent[] {
  const rows: SectorConstituent[] = [];
  for (const cells of htmlTableRows(source)) {
    if (cells.length < 13 || !/^\d{6}$/.test(cells[1].text)) {
      continue;
    }
    const code = thsStockCode(cells[1].text);
    if (!code || !cells[2].text) {
      continue;
    }
    rows.push({
      code,
      secid: codeToSecid(code),
      name: cells[2].text,
      price: thsNumber(cells[3].text),
      percent: thsNumber(cells[4].text),
      change: thsNumber(cells[5].text),
      turnover: thsNumber(cells[7].text),
      netInflow: 0,
      volumeRatio: thsNumber(cells[8].text),
      amplitude: thsNumber(cells[9].text),
      amount: thsAmount(cells[10].text),
      pe: cells.length > 13 ? thsNumber(cells[13].text) : 0,
      marketCap: thsAmount(cells[12].text),
      updatedAt
    });
  }
  return rows;
}

interface TonghuashunBlockRankPayload {
  blocks?: Record<string, unknown> & { subcodeCount?: unknown };
  block?: Record<string, unknown> & { subcodeCount?: unknown };
  items?: Array<Record<string, unknown>>;
}

/** Board volume and constituent quote field 13 both use shares. */
export function withSectorTradingTotals(board: SectorBoard, rows: SectorConstituent[]): SectorBoard {
  const sum = (field: 'volume' | 'amount'): number | undefined => {
    if (!rows.length || rows.some(row => row[field] === undefined || !Number.isFinite(row[field]))) return undefined;
    return rows.reduce((total, row) => total + Number(row[field]), 0);
  };
  return { ...board, volume: board.volume ?? sum('volume'), amount: board.amount ?? sum('amount') };
}

/** Parses the live board headline bundled with a mobile quote-bridge response. */
export function parseTonghuashunBlockRankBoard(
  source: string,
  kind: SectorBoardKind,
  routeCode: string,
  base?: SectorBoard,
  updatedAt = Date.now()
): SectorBoard {
  const payload = jsonpPayload<TonghuashunBlockRankPayload>(source);
  const block = payload.block || payload.blocks || {};
  const secid = String(base?.secid || routeCode).trim();
  const value =
    base || emptyThsSectorBoard(routeCode, String(block.name || ''), kind, secid, updatedAt);
  return {
    ...value,
    code: routeCode,
    secid,
    name: String(block.name || value.name).trim(),
    kind,
    price: toNumber(block['10'], value.price),
    percent: toNumber(block['199112'], value.percent),
    change: toNumber(block['264648'], value.change),
    constituentCount: toNumber(block.subcodeCount, value.constituentCount),
    updatedAt
  };
}

/** Parses the exact-size board ranking returned by 同花顺's mobile quote bridge. */
export function parseTonghuashunBlockRankBoards(
  source: string,
  kind: SectorBoardKind,
  updatedAt = Date.now()
): SectorBoard[] {
  const payload = jsonpPayload<TonghuashunBlockRankPayload>(source);
  return asArray<Record<string, unknown>>(payload.items)
    .map((item) => {
      const code = String(item['5'] || '').trim();
      const name = String(item['55'] || '').trim();
      const leaderDigits = String(item['275'] || '').trim();
      const leaderCode = thsStockCode(leaderDigits);
      return {
        ...emptyThsSectorBoard(code, name, kind, code, updatedAt),
        price: toNumber(item['10']),
        percent: toNumber(item['199112']),
        change: toNumber(item['264648']),
        leaderCode,
        leaderSecid: leaderCode ? codeToSecid(leaderCode) : ''
      };
    })
    .filter((item) => /^\d{6}$/.test(item.code) && item.name.length > 0);
}

interface TonghuashunHotPlatePayload {
  status_code?: unknown;
  data?: {
    plate_list?: Array<Record<string, unknown>>;
  };
}

/** Parses the official 同花顺板块热榜, which already contains exactly TOP20. */
export function parseTonghuashunHotSectorBoards(
  source: string,
  kind: SectorBoardKind,
  updatedAt = Date.now()
): SectorBoard[] {
  const payload = JSON.parse(source) as TonghuashunHotPlatePayload;
  if (toNumber(payload.status_code, -1) !== 0) {
    throw new Error('同花顺板块热榜返回失败');
  }
  return asArray<Record<string, unknown>>(payload.data?.plate_list)
    .map((item, index) => {
      const code = String(item.code || '').trim();
      const name = String(item.name || '').trim();
      const rank = toNumber(item.order, index + 1);
      return {
        ...emptyThsSectorBoard(code, name, kind, code, updatedAt),
        percent: toNumber(item.rise_and_fall),
        heat: toNumber(item.rate),
        heatRank: rank,
        heatRankChange: toNumber(item.hot_rank_chg),
        updatedAt
      };
    })
    .filter((item) => /^\d{6}$/.test(item.code) && item.name.length > 0)
    .sort((left, right) => (left.heatRank || 0) - (right.heatRank || 0));
}

/** Parses a complete 同花顺 board constituent payload. */
export function parseTonghuashunBlockRankConstituents(
  source: string,
  updatedAt = Date.now()
): { total: number; items: SectorConstituent[] } {
  const payload = jsonpPayload<TonghuashunBlockRankPayload>(source);
  const items = asArray<Record<string, unknown>>(payload.items)
    .map((item) => {
      const code = thsStockCode(String(item['5'] || '').trim());
      const previousClose = toNumber(item['6']);
      const high = toNumber(item['8']);
      const low = toNumber(item['9']);
      return {
        code,
        secid: code ? codeToSecid(code) : '',
        name: String(item['55'] || '').trim(),
        price: toNumber(item['10']),
        percent: toNumber(item['199112']),
        change: toNumber(item['264648']),
        turnover: toNumber(item['1968584']),
        netInflow: 0,
        amount: item['19'] === undefined || item['19'] === null || item['19'] === ''
          ? undefined : toNumber(item['19'], NaN),
        open: toNumber(item['7']),
        previousClose,
        high,
        low,
        volume: item['13'] === undefined || item['13'] === null || item['13'] === ''
          ? undefined : toNumber(item['13'], NaN),
        amplitude: previousClose ? ((high - low) / previousClose) * 100 : 0,
        pe: toNumber(item['2034120']),
        marketCap: toNumber(item['3475914']),
        totalMarketCap: toNumber(item['3541450']),
        updatedAt
      };
    })
    .filter((item) => Boolean(item.code && item.name));
  return {
    total: toNumber(payload.block?.subcodeCount ?? payload.blocks?.subcodeCount, items.length),
    items
  };
}

export function parseTonghuashunPageCount(source: string): number {
  const pageInfo = source.match(
    /class=["']page_info["'][^>]*>\s*\d+\s*\/\s*(\d+)/i
  );
  const linkedPages = Array.from(
    source.matchAll(/\/page\/(\d+)\/ajax\/1\//gi),
    (match) => toNumber(match[1], 1)
  );
  return Math.max(1, toNumber(pageInfo?.[1], 1), ...linkedPages);
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
const TONGHUASHUN_SECTOR_GROUPS: Record<SectorBoardKind, readonly string[]> = {
  industry: ['8811', '8812'],
  concept: ['8853', '8854', '8855', '8856', '8857', '8858', '8859', '8860', '8861']
};

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
  private readonly sectorRankCache = new Map<string, CacheEntry<string>>();
  private readonly sectorRankRequests = new Map<string, Promise<string>>();
  private readonly sectorRankingDirectoryCache = new Map<SectorBoardKind, CacheEntry<SectorBoard[]>>();

  private readonly chartCache = new Map<string, CacheEntry<ChartPayload>>();
  private readonly cloudCache = new Map<MarketFilter, CacheEntry<CloudStock[]>>();
  private readonly profileCache = new Map<string, CacheEntry<StockProfile>>();
  private readonly extrasCache = new Map<string, CacheEntry<RealtimeExtras>>();
  private readonly sectorBoardCache = new Map<SectorBoardKind, CacheEntry<SectorBoard[]>>();
  private readonly topSectorBoardCache = new Map<string, CacheEntry<SectorBoard[]>>();
  private readonly sectorDetailBoardCache = new Map<string, CacheEntry<SectorBoard>>();
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
        const requestUrl = resolveEastmoneyRequestUrl(url);
        const isTonghuashunQuotePage = requestUrl.includes('q.10jqka.com.cn/');
        const response = await fetch(requestUrl, {
          signal: controller.signal,
          headers: {
            Accept: isTonghuashunQuotePage
              ? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
              : 'application/json, text/plain, */*',
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/132 Safari/537.36',
            Referer: url.includes('xueqiu.com')
              ? 'https://xueqiu.com/hq'
              : new URL(url).hostname === 'c.10jqka.com.cn'
                ? 'https://t.10jqka.com.cn/'
              : url.includes('10jqka.com.cn/lgt/post/open/api/post/info/') ||
                  url.includes('10jqka.com.cn/lgt/content/open/api/comment/')
                ? 'https://c.10jqka.com.cn/m/post/discussDetail/'
              : url.includes('d.10jqka.com.cn')
                ? 'https://m.10jqka.com.cn/hq/rank/market.html'
              : isTonghuashunQuotePage
                ? 'https://q.10jqka.com.cn/'
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
        const bytes = await response.arrayBuffer();
        const contentType = response.headers.get('content-type') || '';
        const encoding = /charset\s*=\s*(?:gbk|gb2312|gb18030)/i.test(contentType)
          ? 'gb18030'
          : 'utf-8';
        return new TextDecoder(encoding).decode(bytes);
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

  public async getCommunityPosts(
    code: string,
    sort: CommunityPostSort,
    limit = 20,
    cursor?: CommunityCursor
  ): Promise<CommunityPage> {
    const normalized = code.trim().toLowerCase();
    if (!/^(sh|sz|bj)\d{6}$/.test(normalized)) {
      throw new Error('股票代码无效');
    }
    if (sort !== 'hot') {
      throw new Error('社区排序方式无效');
    }
    const digits = normalized.slice(2);
    const marketId = normalized.startsWith('sh')
      ? '17'
      : normalized.startsWith('bj')
        ? '151'
        : '33';
    const requested = Math.min(50, Math.max(1, Math.floor(limit)));
    const collected = [...asArray<CommunityPost>(cursor?.buffered)];
    const seen = new Set(collected.map((post) => post.id));
    let next: CommunityCursor = {
      page: Math.max(1, Math.floor(toNumber(cursor?.page, 1))),
      lastScore: cursor?.lastScore,
      lastPublishTime: cursor?.lastPublishTime,
      startPage: cursor?.startPage
    };
    let upstreamHasMore = true;
    let requests = 0;

    while (collected.length < requested && upstreamHasMore && requests < 6) {
      requests += 1;
      const query = new URLSearchParams({
        code: digits,
        marketId,
        page: '1',
        pageSize: '15'
      });

      if (next.lastScore !== undefined) {
        query.set('lastScore', String(next.lastScore));
      }
      if (next.lastPublishTime !== undefined) {
        query.set('lastPublishTime', String(next.lastPublishTime));
      }
      if (next.startPage !== undefined) {
        query.set('startPage', String(next.startPage));
      }
      const endpoint = 'hot_feed';
      const payload = await this.getJson<any>(
        'https://c.10jqka.com.cn/lgt/post/open/api/forum/content/v1/' +
          endpoint +
          '?' +
          query.toString(),
        12000,
        2
      );
      const statusCode = toNumber(payload?.status_code ?? payload?.statusCode);
      if (statusCode !== 0 || !payload?.data) {
        throw new Error(String(payload?.status_msg || payload?.message || '同花顺社区暂不可用'));
      }
      const data = payload.data;
      const rows = asArray<any>(data.feed);
      let added = 0;
      for (const row of rows) {
        // The mobile stock community is the user-discussion stream. The public
        // hot feed also mixes in long articles (biz type 2), which made the
        // sidebar look different from the app even though the endpoint matched.
        if (toNumber(row?.info?.community_biz_type ?? row?.community_biz_type) !== 1) {
          continue;
        }
        const post = parseTonghuashunCommunityPost(row);
        if (post && !seen.has(post.id)) {
          seen.add(post.id);
          collected.push(post);
          added += 1;
        }
      }
      next = {
        page: next.page + 1,
        lastScore: toNumber(data.last_score ?? data.lastScore, next.lastScore),
        lastPublishTime: toNumber(
          data.last_publish_time ?? data.lastPublishTime,
          next.lastPublishTime
        ),
        startPage: toNumber(data.start_page ?? data.startPage, next.startPage)
      };
      upstreamHasMore = Boolean(data.has_more ?? data.hasMore);
      if (!rows.length || !added) {
        upstreamHasMore = false;
      }
    }

    const posts = collected.slice(0, requested);
    const buffered = collected.slice(requested);
    const hasMore = buffered.length > 0 || upstreamHasMore;
    if (buffered.length) {
      next.buffered = buffered;
    }
    const warning = '';
    return {
      posts,
      cursor: hasMore ? next : null,
      hasMore,
      warning
    };
  }

  public async getCommunityPostDetail(fallback: CommunityPost): Promise<CommunityPostDetail> {
    const postId = String(fallback.id || '').trim();
    const contentId = communityContentId(fallback.contentId || fallback.url);
    if (!/^\d+$/.test(postId) || !contentId) {
      throw new Error('同花顺帖子详情参数无效');
    }
    const [detailPayload, commentPage] = await Promise.all([
      this.getJson<any>(
        'https://c.10jqka.com.cn/lgt/post/open/api/post/info/get?content_id=' +
          encodeURIComponent(contentId),
        12_000,
        2
      ),
      this.getCommunityComments(postId, contentId)
    ]);
    const detail = parseTonghuashunCommunityPostDetail(detailPayload, fallback);
    return {
      post: detail.post,
      ipLocation: detail.ipLocation,
      comments: commentPage.comments,
      commentCursor: commentPage.cursor,
      commentsHaveMore: commentPage.hasMore,
      commentTotal: Math.max(commentPage.total, detail.post.commentCount)
    };
  }

  public async getCommunityComments(
    postId: string,
    contentId: string,
    cursor?: CommunityCommentCursor,
    limit = 10
  ): Promise<CommunityCommentPage> {
    const normalizedPostId = String(postId || '').trim();
    const normalizedContentId = communityContentId(contentId);
    if (!/^\d+$/.test(normalizedPostId) || !normalizedContentId) {
      throw new Error('同花顺评论参数无效');
    }
    const page = Math.max(1, Math.floor(toNumber(cursor?.page, 1)));
    const requested = Math.max(1, Math.min(50, Math.floor(limit)));
    const query = new URLSearchParams({
      resource_id: normalizedPostId,
      biz_type: '1',
      page: String(page),
      limit: String(requested),
      query_type: '1',
      cid: String(cursor?.cid || '0'),
      original_id: normalizedContentId
    });
    const payload = await this.getJson<any>(
      'https://c.10jqka.com.cn/lgt/content/open/api/comment/v3/list?' + query.toString(),
      12_000,
      2
    );
    const statusCode = toNumber(payload?.status_code ?? payload?.statusCode, -1);
    if (statusCode !== 0 || !payload?.data) {
      throw new Error(String(payload?.status_msg || payload?.statusMsg || '同花顺评论暂不可用'));
    }
    const rawRows = asArray<any>(payload.data.comments);
    const comments = rawRows
      .map(parseTonghuashunCommunityComment)
      .filter((comment): comment is CommunityComment => Boolean(comment));
    const noMoreHint = String(
      payload.data.comment_area?.no_comment_hint ??
        payload.data.commentArea?.noCommentHint ??
        ''
    ).trim();
    const lastId = String(rawRows.at(-1)?.id || cursor?.cid || '0');
    const hasMore = comments.length > 0 && !noMoreHint && lastId !== String(cursor?.cid || '0');
    return {
      comments,
      cursor: hasMore ? { page: page + 1, cid: lastId } : null,
      hasMore,
      total: Math.max(0, toNumber(payload.data.comment_count ?? payload.data.commentCount))
    };
  }

  public async getCommunityCommentReplies(
    postId: string,
    contentId: string,
    rootId: string
  ): Promise<CommunityComment[]> {
    const normalizedPostId = String(postId || '').trim();
    const normalizedContentId = communityContentId(contentId);
    const normalizedRootId = String(rootId || '').trim();
    if (
      !/^\d+$/.test(normalizedPostId) ||
      !normalizedContentId ||
      !/^\d+$/.test(normalizedRootId)
    ) {
      throw new Error('同花顺楼中楼评论参数无效');
    }
    const collected = new Map<string, CommunityComment>();
    let page = 1;
    let cid = '0';
    for (let request = 0; request < 100; request += 1) {
      const query = new URLSearchParams({
        resource_id: normalizedPostId,
        biz_type: '1',
        page: String(page),
        limit: '50',
        cid,
        original_id: normalizedContentId,
        root_id: normalizedRootId
      });
      const payload = await this.getJson<any>(
        'https://c.10jqka.com.cn/lgt/content/open/api/comment/v3/child_list?' +
          query.toString(),
        12_000,
        2
      );
      const statusCode = toNumber(payload?.status_code ?? payload?.statusCode, -1);
      if (statusCode !== 0 || !payload?.data) {
        throw new Error(
          String(payload?.status_msg || payload?.statusMsg || '同花顺回复暂不可用')
        );
      }
      const rawRows = asArray<any>(payload.data.comments);
      for (const raw of rawRows) {
        const comment = parseTonghuashunCommunityComment(raw);
        if (comment) {
          collected.set(comment.id, comment);
        }
      }
      const nextCid = String(rawRows.at(-1)?.id || cid);
      const noMoreHint = String(
        payload.data.comment_area?.no_comment_hint ??
          payload.data.commentArea?.noCommentHint ??
          ''
      ).trim();
      if (!rawRows.length || noMoreHint || nextCid === cid) {
        break;
      }
      cid = nextCid;
      page += 1;
    }
    return Array.from(collected.values());
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

  private async getEastmoneySectorBoards(kind: SectorBoardKind): Promise<SectorBoard[]> {
    const fields =
      'f2,f3,f4,f8,f12,f13,f14,f22,f62,f104,f105,f124,f127,f128,f136,f140,f141';
    const filter = kind === 'industry' ? 'm:90+t:2' : 'm:90+t:3';
    const rows = await this.getSectorListRows(filter, 'f62', fields);
    return this.mapSectorBoardRows(rows, kind);
  }

  private async getTonghuashunSectorLanding(kind: SectorBoardKind): Promise<string> {
    const path = kind === 'industry' ? 'thshy' : 'gn';
    return this.getText('https://q.10jqka.com.cn/' + path + '/', 18_000, 3);
  }

  public async getSectorBoards(
    kind: SectorBoardKind,
    force = false
  ): Promise<SectorBoard[]> {
    const cached = this.sectorBoardCache.get(kind);
    if (!force && cached && Date.now() - cached.at < SECTOR_LIST_CACHE_TTL) {
      return cached.value;
    }
    try {
      const updatedAt = Date.now();
      const landing = await this.getTonghuashunSectorLanding(kind);
      let value =
        kind === 'industry'
          ? parseTonghuashunIndustryBoards(landing, updatedAt)
          : parseTonghuashunConceptBoards(landing, updatedAt);
      if (kind === 'industry') {
        try {
          const secondPage = await this.getText(
            'https://q.10jqka.com.cn/thshy/index/field/199112/order/desc/page/2/ajax/1/',
            18_000,
            3
          );
          const merged = new Map(value.map((item) => [item.code, item]));
          for (const item of parseTonghuashunIndustryBoards(secondPage, updatedAt)) {
            merged.set(item.code, item);
          }
          value = Array.from(merged.values());
        } catch {
          // The landing page still contains the complete official industry directory.
        }
      }
      // The desktop directory is the authoritative source for every board and its
      // route code, while the quote bridge owns the live quote code and prices.
      // Merge every row from each current group here. The sidebar intentionally
      // uses d20 below, but the centre list is expected to contain full quotes.
      try {
        const quoteSources = await Promise.all(
          TONGHUASHUN_SECTOR_GROUPS[kind].map((parent) =>
            this.getText(
              'https://d.10jqka.com.cn/v2/blocksrank/' +
                parent +
                '/199112/d1000.js',
              18_000,
              3
            )
          )
        );
        const liveBoards = quoteSources.flatMap((source) =>
          parseTonghuashunBlockRankBoards(source, kind, updatedAt)
        );
        const liveByCode = new Map(liveBoards.map((item) => [item.code, item]));
        const liveByName = new Map(liveBoards.map((item) => [item.name, item]));
        value = value.map((item) => {
          const live =
            liveByCode.get(item.secid) ||
            liveByCode.get(item.code) ||
            liveByName.get(item.name);
          if (!live) {
            return item;
          }
          return {
            ...item,
            secid: live.code,
            price: live.price,
            percent: live.percent,
            change: live.change,
            leaderName: live.leaderName || item.leaderName,
            leaderCode: live.leaderCode || item.leaderCode,
            leaderSecid: live.leaderSecid || item.leaderSecid,
            leaderPercent: live.leaderPercent || item.leaderPercent,
            updatedAt
          };
        });
      } catch {
        // Directory data and its embedded quotes remain usable if a quote group
        // is temporarily unavailable.
      }
      const minimum = kind === 'industry' ? 80 : 250;
      if (value.length < minimum) {
        throw new Error('同花顺' + (kind === 'industry' ? '行业' : '概念') + '目录返回不完整');
      }
      this.sectorBoardCache.set(kind, { at: updatedAt, value });
      return value;
    } catch (error) {
      if (cached?.value.length) {
        return cached.value;
      }
      throw error;
    }
  }

  private async getSectorRankingDirectory(kind: SectorBoardKind): Promise<SectorBoard[]> {
    const cached = this.sectorRankingDirectoryCache.get(kind);
    if (cached && Date.now() - cached.at < SECTOR_LIST_CACHE_TTL) return cached.value;
    const source = await this.getTonghuashunSectorLanding(kind);
    const value = kind === 'industry'
      ? parseTonghuashunIndustryBoards(source)
      : parseTonghuashunConceptBoards(source);
    if (value.length < (kind === 'industry' ? 80 : 250)) {
      throw new Error('同花顺板块排行目录不完整');
    }
    this.sectorRankingDirectoryCache.set(kind, { at: Date.now(), value });
    return value;
  }

  private async getTonghuashunRankedSectorBoards(
    kind: SectorBoardKind,
    count: number,
    updatedAt: number
  ): Promise<SectorBoard[]> {
    // block identifiers are code prefixes, not complete industry/concept universes.
    // Discover all quote prefixes from the official directory, including new boards.
    const directory = await this.getSectorRankingDirectory(kind);
    const quoteCodePattern = kind === 'industry' ? /^881\d{3}$/ : /^88[56]\d{3}$/;
    const prefixes = Array.from(new Set(directory
      .map((board) => board.secid)
      .filter((code) => quoteCodePattern.test(code))
      .map((code) => code.slice(0, 4))));
    if (!prefixes.length) {
      throw new Error('同花顺板块排行目录不可用');
    }
    const groups = await Promise.all(prefixes.map(async (prefix) => {
      const source = await this.getText(
        'https://d.10jqka.com.cn/v2/blocksrank/' + prefix + '/199112/d' + count + '.js',
        15_000,
        3
      );
      const total = Number(jsonpPayload<TonghuashunBlockRankPayload>(source).blocks?.subcodeCount);
      const boards = parseTonghuashunBlockRankBoards(source, kind, updatedAt);
      const unique = new Map(boards.map((board) => [board.code, board]));
      if (!Number.isInteger(total) || total < 0 ||
          unique.size < Math.min(count, total) ||
          boards.some((board) => !board.code.startsWith(prefix))) {
        throw new Error('同花顺板块排行分组返回不完整：' + prefix);
      }
      return boards;
    }));
    // A global TOP N can only contain boards from each prefix's own TOP N.
    return Array.from(new Map(groups.flat().map((board) => [board.code, board])).values())
      .sort((left, right) => right.percent - left.percent || left.code.localeCompare(right.code))
      .slice(0, count);
  }

  public async getTopSectorBoards(
    kind: SectorBoardKind,
    limit = 20,
    force = false,
    sort: SectorBoardSort = 'percent'
  ): Promise<SectorBoard[]> {
    const count = Math.max(1, Math.min(20, Math.floor(limit)));
    const cacheKey = kind + ':' + sort;
    const cached = this.topSectorBoardCache.get(cacheKey);
    if (
      !force &&
      cached &&
      cached.value.length >= count &&
      Date.now() - cached.at < SECTOR_TOP_CACHE_TTL
    ) {
      return cached.value.slice(0, count);
    }
    try {
      const updatedAt = Date.now();
      const value =
        sort === 'heat'
          ? parseTonghuashunHotSectorBoards(await this.getText(
              'https://dq.10jqka.com.cn/fuyao/hot_list_data/out/hot_list/v1/plate?type=' +
                kind,
              15_000,
              3
            ), kind, updatedAt).slice(0, count)
          : await this.getTonghuashunRankedSectorBoards(kind, count, updatedAt);
      if (value.length < count) {
        throw new Error('同花顺板块排行返回不完整');
      }
      this.topSectorBoardCache.set(cacheKey, { at: updatedAt, value });
      return value;
    } catch (error) {
      if (cached?.value.length) {
        return cached.value.slice(0, count);
      }
      throw error;
    }
  }

  private getSectorRankPage(code: string, order: 'a' | 'd', count: number, force: boolean): Promise<string> {
    const key = code + ':' + order + count;
    const pending = this.sectorRankRequests.get(key);
    if (pending) return pending;
    const cached = this.sectorRankCache.get(key);
    if (cached && Date.now() - cached.at < (force ? 500 : SECTOR_DETAIL_CACHE_TTL)) return Promise.resolve(cached.value);
    const request = this.getText('https://d.10jqka.com.cn/v2/blockrank/' + code +
      '/199112/' + order + count + '.js', 8_000, 1).then(value => {
        this.sectorRankCache.set(key, { at: Date.now(), value });
        return value;
      }).finally(() => { this.sectorRankRequests.delete(key); });
    this.sectorRankRequests.set(key, request);
    return request;
  }

  public async getSectorBoardDetail(
    bkCode: string,
    force = false,
    kind?: SectorBoardKind,
    quoteCode?: string,
    name?: string
  ): Promise<SectorBoard> {
    const normalized = bkCode.trim().toUpperCase().replace(/^48[.:]/, '');
    if (!/^\d{6}$/.test(normalized)) {
      throw new Error('Invalid sector board code: ' + bkCode);
    }
    const resolvedKind =
      kind === 'concept' || kind === 'industry'
        ? kind
        : normalized.startsWith('881')
          ? 'industry'
          : 'concept';
    const cacheKey = resolvedKind + ':' + normalized;
    const cached = this.sectorDetailBoardCache.get(cacheKey);
    if (!force && cached && Date.now() - cached.at < SECTOR_DETAIL_CACHE_TTL) {
      return cached.value;
    }
    const updatedAt = Date.now();
    // Clicking one board must not download the centre's full market rankings.
    let directory = this.sectorBoardCache.get(resolvedKind)?.value ||
      this.sectorRankingDirectoryCache.get(resolvedKind)?.value || [];
    if (resolvedKind === 'concept' && !directory.some(item => item.code === normalized || item.secid === normalized)) {
      try { directory = await this.getSectorRankingDirectory(resolvedKind); }
      catch { /* Native quote codes remain usable without the web route directory. */ }
    }
    const hintedName = String(name || '').trim();
    const base = directory.find(
      (item) =>
        item.code === normalized ||
        item.secid === normalized ||
        Boolean(hintedName && item.name === hintedName)
    );
    const routeCode = base?.code || normalized;
    const hintedQuoteCode = String(quoteCode || '').trim().replace(/^48[.:]/, '');
    const nativeQuoteCode = /^88\d{4}$/.test(hintedQuoteCode)
      ? hintedQuoteCode
      : /^88\d{4}$/.test(base?.secid || '')
        ? String(base?.secid)
        : /^88\d{4}$/.test(normalized)
          ? normalized
          : '';
    let value =
      base || emptyThsSectorBoard(routeCode, hintedName || normalized, resolvedKind, nativeQuoteCode || normalized, updatedAt);
    let enriched = Boolean(base);
    const detailPath = resolvedKind === 'industry' ? 'thshy' : 'gn';
    const canLoadDetailPage =
      resolvedKind === 'industry' ? /^881\d{3}$/.test(routeCode) : !/^88\d{4}$/.test(routeCode);
    const pageRequest = canLoadDetailPage
      ? this.getText('https://q.10jqka.com.cn/' + detailPath + '/detail/code/' + routeCode + '/', 8_000, 1)
          .catch(() => undefined)
      : Promise.resolve(undefined);
    const rankRequest = nativeQuoteCode
      ? this.getSectorRankPage(nativeQuoteCode, 'd', 500, force).catch(() => undefined)
      : Promise.resolve(undefined);
    const [pageSource, rankSource] = await Promise.all([pageRequest, rankRequest]);
    if (pageSource) {
      value = parseTonghuashunSectorBoardDetail(pageSource, resolvedKind, routeCode, value, updatedAt);
      enriched = true;
    }
    const resolvedQuoteCode = /^88\d{4}$/.test(value.secid || '') ? String(value.secid) : nativeQuoteCode;
    // A legacy route can reveal its quote code only in the detail heading.
    const source = rankSource || (!nativeQuoteCode && resolvedQuoteCode
      ? await this.getSectorRankPage(resolvedQuoteCode, 'd', 500, force).catch(() => undefined)
      : undefined);
    if (source) {
      value = parseTonghuashunBlockRankBoard(source, resolvedKind, routeCode,
        { ...value, secid: resolvedQuoteCode }, updatedAt);
      enriched = true;
    }
    if (!enriched && !hintedName) {
      throw new Error('同花顺板块详情暂不可用');
    }
    const directoryCache = this.sectorBoardCache.get(resolvedKind);
    if (directoryCache) {
      directoryCache.value = directoryCache.value.map((item) =>
        item.code === value.code || item.secid === value.secid || item.name === value.name
          ? { ...item, ...value }
          : item
      );
    }
    this.sectorDetailBoardCache.set(cacheKey, { at: updatedAt, value });
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
    const [industry, concept] = await Promise.all([
      this.getEastmoneySectorBoards('industry'),
      this.getEastmoneySectorBoards('concept')
    ]);
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
    force = false,
    kind?: SectorBoardKind,
    quoteCode?: string
  ): Promise<SectorConstituent[]> {
    const normalized = bkCode.trim().toUpperCase().replace(/^90\./, '');
    if (!/^BK\d+$/.test(normalized) && !/^\d{6}$/.test(normalized)) {
      throw new Error('Invalid sector board code: ' + bkCode);
    }
    const resolvedKind =
      kind === 'concept' || kind === 'industry'
        ? kind
        : normalized.startsWith('881')
          ? 'industry'
          : 'concept';
    const cacheKey = resolvedKind + ':' + normalized;
    const cached = this.sectorConstituentCache.get(cacheKey);
    if (!force && cached && Date.now() - cached.at < SECTOR_DETAIL_CACHE_TTL) {
      return cached.value;
    }
    if (/^\d{6}$/.test(normalized)) {
      try {
        const path = resolvedKind === 'industry' ? 'thshy' : 'gn';
        const updatedAt = Date.now();
        const hintedQuoteCode = String(quoteCode || '').trim().replace(/^48[.:]/, '');
        const cachedBoard = this.sectorBoardCache
          .get(resolvedKind)
          ?.value.find((item) => item.code === normalized);
        const nativeQuoteCode = /^88\d{4}$/.test(hintedQuoteCode)
          ? hintedQuoteCode
          : /^88\d{4}$/.test(cachedBoard?.secid || '')
            ? String(cachedBoard?.secid)
            : /^88\d{4}$/.test(normalized)
              ? normalized
              : '';
        let value: SectorConstituent[] = [];
        if (nativeQuoteCode) {
          const loadRank = async (order: 'a' | 'd', count: number) =>
            parseTonghuashunBlockRankConstituents(
              await this.getSectorRankPage(nativeQuoteCode, order, count, force),
              updatedAt
            );
          let ranked;
          try {
            // d1000 is prone to gateway timeouts for large boards. d500 returns
            // all current boards in one request and remains considerably more
            // stable; if a board grows beyond 500 rows, merge both ends.
            ranked = await loadRank('d', 500);
          } catch {
            const [descending, ascending] = await Promise.all([
              loadRank('d', 200),
              loadRank('a', 200)
            ]);
            const recovered = new Map(
              [...descending.items, ...ascending.items].map((item) => [item.code, item])
            );
            ranked = {
              items: Array.from(recovered.values()),
              total: Math.max(descending.total, ascending.total)
            };
          }
          if (ranked.total > ranked.items.length) {
            const ascending = await loadRank('a', 500);
            const merged = new Map(
              [...ranked.items, ...ascending.items].map((item) => [item.code, item])
            );
            ranked = {
              items: Array.from(merged.values()),
              total: Math.max(ranked.total, ascending.total)
            };
          }
          if (ranked.total > ranked.items.length) {
            throw new Error(
              '同花顺板块成分股返回不完整：' + ranked.items.length + '/' + ranked.total
            );
          }
          value = ranked.items;
        } else {
          const landing = await this.getText(
            'https://q.10jqka.com.cn/' + path + '/detail/code/' + normalized + '/',
            18_000,
            3
          );
          const merged = new Map(
            parseTonghuashunSectorConstituents(landing, updatedAt).map((item) => [
              item.code,
              item
            ])
          );
          const pageCount = parseTonghuashunPageCount(landing);
          for (let page = 2; page <= pageCount; page += 4) {
            const pages = Array.from(
              { length: Math.min(4, pageCount - page + 1) },
              (_unused, offset) => page + offset
            );
            const sources = await Promise.all(
              pages.map((currentPage) =>
                this.getText(
                  'https://q.10jqka.com.cn/' +
                    path +
                    '/detail/code/' +
                    normalized +
                    '/field/199112/order/desc/page/' +
                    currentPage +
                    '/ajax/1/',
                  18_000,
                  3
                )
              )
            );
            for (const source of sources) {
              for (const item of parseTonghuashunSectorConstituents(source, updatedAt)) {
                merged.set(item.code, item);
              }
            }
          }
          value = Array.from(merged.values());
        }
        value.sort((left, right) => right.percent - left.percent);
        if (!value.length) {
          throw new Error('同花顺板块成分股返回为空');
        }
        this.sectorConstituentCache.set(cacheKey, { at: updatedAt, value });
        return value;
      } catch (error) {
        if (cached?.value.length) {
          return cached.value;
        }
        throw error;
      }
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
    this.sectorConstituentCache.set(cacheKey, { at: Date.now(), value });
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
