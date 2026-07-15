import { randomBytes } from 'crypto';
import * as http from 'http';
import * as https from 'https';
import { AddressInfo, Socket } from 'net';
import * as zlib from 'zlib';

const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_INITIAL_BURST_MS = 10_000;
const MAX_INITIAL_BURST_MS = 60_000;
const MAX_REWRITABLE_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_SSE_REDIRECTS = 3;
const MAX_KLINE_REDIRECTS = 3;
const MAX_KLINE_LIMIT = 2_000;
const KLINE_FALLBACK_TIMEOUT_MS = 30_000;
const TREND_PAGE_TEMPLATE_TTL_MS = 5 * 60_000;
const EASTMONEY_KLINE_PATH = '/api/qt/stock/kline/get';
const EASTMONEY_TRENDS_URL = 'https://push2delay.eastmoney.com/api/qt/stock/trends2/get';
const SOHU_HISTORY_URL = 'https://q.stock.sohu.com/hisHq';
const EASTMONEY_UT = 'fa5fd1943c7b386f172d6893dbfba10b';
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36';

const PAGE_CSP = [
  "default-src 'self' data: blob:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "media-src 'self' data: blob:",
  "frame-src 'self'",
  "base-uri https://eastmoney.com https://*.eastmoney.com"
].join('; ');

const STRIPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'content-length',
  'content-security-policy',
  'content-security-policy-report-only',
  'cross-origin-embedder-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'keep-alive',
  'origin-agent-cluster',
  'proxy-authenticate',
  'proxy-authorization',
  'set-cookie',
  'strict-transport-security',
  'transfer-encoding',
  'trailer',
  'upgrade',
  'x-frame-options'
]);

interface ActiveSseConnection {
  readonly response: http.ServerResponse;
  upstreamRequest?: http.ClientRequest;
  upstreamResponse?: http.IncomingMessage;
  paused: boolean;
}

interface TrendPageTemplate {
  readonly body: string;
  readonly contentType: string;
  readonly expiresAt: number;
}

interface EastmoneyKlineData {
  code: string;
  market: number;
  name: string;
  decimal: number;
  preKPrice: number;
  prePrice: number;
  klines: string[];
}

interface EastmoneyKlinePayload {
  rc: number;
  rt: number;
  svr: number;
  lt: number;
  full: number;
  dlmkts: unknown;
  dsc: string;
  data: EastmoneyKlineData;
}

function formatKlineNumber(value: number, precision = 2): string {
  return Number.isFinite(value) ? value.toFixed(precision) : '0.00';
}

function parsePercent(value: unknown): number {
  return Number(String(value ?? '0').replace('%', '')) || 0;
}

function compactDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function parseJsonpPayload(source: string): unknown {
  const text = String(source ?? '').trim();
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  const json = open >= 0 && close > open ? text.slice(open + 1, close) : text;
  return JSON.parse(json) as unknown;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function sohuRowToDailyKline(row: unknown[]): string {
  const date = String(row[0] ?? '');
  const open = Number(row[1]) || 0;
  const close = Number(row[2]) || 0;
  const change = Number(row[3]) || 0;
  const percent = parsePercent(row[4]);
  const low = Number(row[5]) || 0;
  const high = Number(row[6]) || 0;
  const volume = Number(row[7]) || 0;
  const amount = (Number(row[8]) || 0) * 10_000;
  const turnover = parsePercent(row[9]);
  const previousClose = close - change;
  const amplitude = previousClose !== 0 ? ((high - low) / previousClose) * 100 : 0;

  return [
    date,
    formatKlineNumber(open),
    formatKlineNumber(close),
    formatKlineNumber(high),
    formatKlineNumber(low),
    String(Math.round(volume)),
    formatKlineNumber(amount),
    formatKlineNumber(amplitude),
    formatKlineNumber(percent),
    formatKlineNumber(change),
    formatKlineNumber(turnover)
  ].join(',');
}

function getWeekKey(date: string): string {
  const value = new Date(`${date}T00:00:00`);
  const day = value.getDay() || 7;
  value.setDate(value.getDate() + 4 - day);
  const yearStart = new Date(value.getFullYear(), 0, 1);
  const week = Math.ceil(((value.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${value.getFullYear()}-${String(week).padStart(2, '0')}`;
}

function aggregateDailyRows(rows: unknown[][], period: number): string[] {
  if (period === 101) {
    return rows.map(sohuRowToDailyKline);
  }

  const groups = new Map<string, unknown[][]>();
  for (const row of rows) {
    const date = String(row[0] ?? '');
    const key = period === 102 ? getWeekKey(date) : date.slice(0, 7);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  const klines: string[] = [];
  let previousGroupClose = 0;
  for (const group of groups.values()) {
    const first = group[0];
    const last = group[group.length - 1];
    const date = String(last[0] ?? '');
    const open = Number(first[1]) || 0;
    const close = Number(last[2]) || 0;
    const high = Math.max(...group.map((row) => Number(row[6]) || 0));
    const low = Math.min(...group.map((row) => Number(row[5]) || 0));
    const volume = group.reduce((sum, row) => sum + (Number(row[7]) || 0), 0);
    const amount = group.reduce((sum, row) => sum + (Number(row[8]) || 0), 0) * 10_000;
    const change = previousGroupClose !== 0 ? close - previousGroupClose : Number(last[3]) || 0;
    const previousClose = previousGroupClose || close - change;
    const percent = previousClose !== 0 ? (change / previousClose) * 100 : 0;
    const amplitude = previousClose !== 0 ? ((high - low) / previousClose) * 100 : 0;
    const turnover = group.reduce((sum, row) => sum + parsePercent(row[9]), 0);

    klines.push(
      [
        date,
        formatKlineNumber(open),
        formatKlineNumber(close),
        formatKlineNumber(high),
        formatKlineNumber(low),
        String(Math.round(volume)),
        formatKlineNumber(amount),
        formatKlineNumber(amplitude),
        formatKlineNumber(percent),
        formatKlineNumber(change),
        formatKlineNumber(turnover)
      ].join(',')
    );
    previousGroupClose = close;
  }
  return klines;
}

function aggregateMinuteTrends(trends: unknown[], period: number, previousClose: number): string[] {
  const klines: string[] = [];
  let group: string[][] = [];
  let previousBucket = -1;

  const flush = (): void => {
    if (group.length === 0) {
      return;
    }
    const first = group[0];
    const last = group[group.length - 1];
    const open = Number(first[1]) || 0;
    const close = Number(last[2]) || 0;
    const high = Math.max(...group.map((row) => Number(row[3]) || 0));
    const low = Math.min(...group.map((row) => Number(row[4]) || 0));
    const volume = group.reduce((sum, row) => sum + (Number(row[5]) || 0), 0);
    const amount = group.reduce((sum, row) => sum + (Number(row[6]) || 0), 0);
    const baseline = previousClose || open;
    const change = close - baseline;
    const percent = baseline !== 0 ? (change / baseline) * 100 : 0;
    const amplitude = baseline !== 0 ? ((high - low) / baseline) * 100 : 0;

    klines.push(
      [
        first[0],
        formatKlineNumber(open),
        formatKlineNumber(close),
        formatKlineNumber(high),
        formatKlineNumber(low),
        String(Math.round(volume)),
        formatKlineNumber(amount),
        formatKlineNumber(amplitude),
        formatKlineNumber(percent),
        formatKlineNumber(change),
        '0.00'
      ].join(',')
    );
    group = [];
  };

  for (const trend of trends) {
    const row = String(trend).split(',');
    const timeParts = String(row[0] ?? '').slice(11, 16).split(':');
    const minutes = (Number(timeParts[0]) || 0) * 60 + (Number(timeParts[1]) || 0);
    const bucket = Math.floor(minutes / period) * period;
    if (group.length > 0 && bucket !== previousBucket) {
      flush();
    }
    previousBucket = bucket;
    group.push(row);
  }
  flush();
  return klines;
}

/**
 * A loopback-only reverse proxy for Eastmoney's full quote page.
 *
 * The random route token is a capability: callers must not expose it outside the
 * webview that needs the page. Every upstream URL is validated independently;
 * the token never turns this server into an open proxy.
 */
export class EastmoneyProxyServer {
  private server: http.Server | undefined;
  private startPromise: Promise<number> | undefined;
  private port: number | undefined;
  private token = randomBytes(24).toString('hex');
  private requestsAllowed = true;
  private initialBurstUntil = 0;
  private trendPageTemplate: TrendPageTemplate | undefined;
  private trendPageTemplatePromise: Promise<TrendPageTemplate> | undefined;
  private readonly sockets = new Set<Socket>();
  private readonly activeSse = new Set<ActiveSseConnection>();
  private heartbeatTimer: NodeJS.Timeout | undefined;

  /** Starts the proxy once and returns its randomly assigned loopback port. */
  public ensureStarted(): Promise<number> {
    if (this.port !== undefined) {
      return Promise.resolve(this.port);
    }
    if (this.startPromise !== undefined) {
      return this.startPromise;
    }

    this.startPromise = new Promise<number>((resolve, reject) => {
      const server = http.createServer((request, response) => {
        void this.handleRequest(request, response).catch((error: unknown) => {
          if (response.headersSent) {
            if (!response.writableEnded) {
              response.end();
            }
            return;
          }
          const message = error instanceof Error ? error.message : 'Unknown proxy error';
          this.writeText(response, 502, `Eastmoney proxy error: ${message}`);
        });
      });

      this.server = server;
      server.on('connection', (socket: Socket) => {
        this.sockets.add(socket);
        socket.once('close', () => this.sockets.delete(socket));
      });
      server.once('error', (error: Error) => {
        if (this.port === undefined) {
          this.server = undefined;
          this.startPromise = undefined;
          reject(error);
        }
      });
      server.listen(0, LOOPBACK_HOST, () => {
        const address = server.address() as AddressInfo | null;
        if (address === null) {
          this.server = undefined;
          this.startPromise = undefined;
          reject(new Error('The Eastmoney proxy did not receive a listening address.'));
          return;
        }
        this.port = address.port;
        this.startHeartbeat();
        resolve(address.port);
      });
    });

    return this.startPromise;
  }

  /** Returns the proxied Eastmoney full quote URL for an A-share code. */
  public async trendUrl(code: string): Promise<string> {
    const secid = this.normalizeSecid(code);
    const port = await this.ensureStarted();

    // Opening a page while the market is closed still needs one snapshot. This
    // never permits SSE; setMarketRequestsAllowed(false) continues to pause it.
    this.allowInitialBurst();
    return `http://${LOOPBACK_HOST}:${port}/${this.token}/trend?mcid=${encodeURIComponent(secid)}`;
  }

  /**
   * Enables or pauses upstream market traffic. Pausing aborts every active
   * upstream SSE request but deliberately keeps the browser-facing stream open.
   * Enabling closes those paused streams, which makes native EventSource apply
   * its normal reconnect behavior.
   */
  public setMarketRequestsAllowed(allowed: boolean): void {
    if (this.requestsAllowed === allowed) {
      return;
    }
    this.requestsAllowed = allowed;

    if (!allowed) {
      for (const connection of this.activeSse) {
        this.pauseSse(connection);
      }
      return;
    }

    for (const connection of [...this.activeSse]) {
      if (!connection.paused) {
        continue;
      }
      if (!connection.response.writableEnded) {
        connection.response.write('retry: 250\n\n');
        connection.response.end();
      }
      this.activeSse.delete(connection);
    }
  }

  /**
   * Temporarily allows non-SSE quote API calls so a newly opened trend page can
   * obtain its initial snapshot while normal market requests remain disabled.
   */
  public allowInitialBurst(durationMs = DEFAULT_INITIAL_BURST_MS): void {
    const safeDuration = Math.max(0, Math.min(MAX_INITIAL_BURST_MS, durationMs));
    this.initialBurstUntil = Math.max(this.initialBurstUntil, Date.now() + safeDuration);
  }

  /** Stops listeners, upstream streams, timers, and all accepted sockets. */
  public dispose(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }

    for (const connection of this.activeSse) {
      connection.upstreamRequest?.destroy();
      connection.upstreamResponse?.destroy();
      if (!connection.response.writableEnded) {
        connection.response.end();
      }
    }
    this.activeSse.clear();

    this.server?.close();
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();

    this.server = undefined;
    this.port = undefined;
    this.startPromise = undefined;
    this.initialBurstUntil = 0;
    this.trendPageTemplate = undefined;
    this.trendPageTemplatePromise = undefined;
    this.token = randomBytes(24).toString('hex');
  }

  private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const localUrl = new URL(request.url ?? '/', `http://${LOOPBACK_HOST}`);
    const routeRoot = `/${this.token}`;

    if (request.method === 'OPTIONS') {
      response.writeHead(204, this.corsHeaders());
      response.end();
      return;
    }
    if (!['GET', 'HEAD', 'POST'].includes(request.method ?? 'GET')) {
      this.writeText(response, 405, 'Method not allowed.');
      return;
    }
    if (!localUrl.pathname.startsWith(`${routeRoot}/`)) {
      this.writeText(response, 404, 'Not found.');
      return;
    }

    if (localUrl.pathname === `${routeRoot}/trend`) {
      const mcid = localUrl.searchParams.get('mcid') ?? '';
      if (!/^[01]\.\d{6}$/.test(mcid)) {
        this.writeText(response, 400, 'Invalid A-share market code.');
        return;
      }
      const target = new URL('https://quote.eastmoney.com/basic/full.html');
      target.searchParams.set('mcid', mcid);
      await this.forward(request, response, target, true);
      return;
    }

    if (localUrl.pathname === `${routeRoot}/proxy`) {
      const rawTarget = localUrl.searchParams.get('url') ?? '';
      if (rawTarget.length === 0 || rawTarget.length > 32_768) {
        this.writeText(response, 400, 'Invalid proxy target.');
        return;
      }

      let target: URL;
      try {
        target = new URL(rawTarget);
      } catch {
        this.writeText(response, 400, 'Malformed proxy target.');
        return;
      }
      if (!this.isAllowedTarget(target)) {
        this.writeText(response, 403, 'The proxy target is not an allowed Eastmoney host.');
        return;
      }

      await this.forward(request, response, target, false);
      return;
    }

    this.writeText(response, 404, 'Not found.');
  }

  private async forward(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    target: URL,
    isTrendPage: boolean
  ): Promise<void> {
    if (!this.isAllowedTarget(target)) {
      this.writeText(response, 403, 'The upstream host is not allowed.');
      return;
    }

    const isSse = this.isSseRequest(request, target);
    // Switching a historical K-line period is an explicit, finite user action.
    // Serve the stable fallback even while automatic market streaming is gated.
    if (!isSse && await this.tryKlineFallback(request, response, target)) {
      return;
    }
    if (isSse && !this.requestsAllowed) {
      this.createPausedSse(response);
      return;
    }
    if (!isSse && this.isMarketApi(target) && !this.requestsAllowed && Date.now() >= this.initialBurstUntil) {
      this.writeBlockedMarketResponse(response);
      return;
    }

    if (isSse) {
      this.forwardSse(request, response, target);
      return;
    }
    if (isTrendPage && (request.method === 'GET' || request.method === 'HEAD')) {
      await this.forwardTrendPage(request, response, target);
      return;
    }
    await this.forwardRegular(request, response, target, isTrendPage);
  }

  /**
   * The full quote shell is identical for every mcid; the selected security is
   * read from location.search by the browser. Keep one short-lived upstream
   * template and rewrite it for each local URL. This removes the extra remote
   * HTML round trip when switching stocks or reopening the panel, while all
   * quote/trend/detail APIs continue to obey their existing market gate.
   */
  private async forwardTrendPage(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    target: URL
  ): Promise<void> {
    const template = await this.getTrendPageTemplate(request, target);
    const rewrittenBody = Buffer.from(this.rewriteHtml(template.body, target), 'latin1');
    response.writeHead(200, {
      ...this.corsHeaders(),
      'cache-control': 'no-store',
      'content-length': String(rewrittenBody.byteLength),
      'content-security-policy': PAGE_CSP,
      'content-type': template.contentType,
      'cross-origin-resource-policy': 'cross-origin'
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    response.end(rewrittenBody);
  }

  private getTrendPageTemplate(
    request: http.IncomingMessage,
    target: URL
  ): Promise<TrendPageTemplate> {
    const cached = this.trendPageTemplate;
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      return Promise.resolve(cached);
    }
    if (this.trendPageTemplatePromise !== undefined) {
      return this.trendPageTemplatePromise;
    }

    // The upstream body does not contain mcid. Canonicalising the URL also
    // lets simultaneous first clicks for different stocks share one request.
    const templateTarget = new URL(target.toString());
    templateTarget.search = '';
    const loading = this.fetchTrendPageTemplate(request, templateTarget);
    this.trendPageTemplatePromise = loading;
    void loading.then(
      (template) => {
        if (this.trendPageTemplatePromise === loading) {
          this.trendPageTemplate = template;
          this.trendPageTemplatePromise = undefined;
        }
      },
      () => {
        if (this.trendPageTemplatePromise === loading) {
          this.trendPageTemplatePromise = undefined;
        }
      }
    );
    return loading;
  }

  private fetchTrendPageTemplate(
    request: http.IncomingMessage,
    target: URL
  ): Promise<TrendPageTemplate> {
    return new Promise<TrendPageTemplate>((resolve, reject) => {
      const upstreamRequest = this.createUpstreamRequest(request, target, (upstreamResponse) => {
        const statusCode = upstreamResponse.statusCode ?? 502;
        if (statusCode !== 200) {
          upstreamResponse.resume();
          reject(new Error(`Eastmoney trend page returned HTTP ${statusCode}.`));
          return;
        }
        this.collectBody(upstreamResponse).then(
          (compressedBody) => {
            const decodedBody = this.decodeBody(
              compressedBody,
              upstreamResponse.headers['content-encoding']
            );
            resolve({
              body: decodedBody.toString('latin1'),
              contentType: String(
                upstreamResponse.headers['content-type'] ?? 'text/html; charset=utf-8'
              ),
              expiresAt: Date.now() + TREND_PAGE_TEMPLATE_TTL_MS
            });
          },
          reject
        );
      }, 'GET');
      upstreamRequest.once('error', reject);
      upstreamRequest.end();
    });
  }

  /**
   * Eastmoney's numbered push2his edges frequently reset TLS connections. The
   * installed LeekFund extension avoids that edge for ordinary A-share K-lines:
   * daily data comes from Sohu and intraday candles are aggregated from the
   * stable push2delay trends endpoint. Only an actual fallback failure reaches
   * the original Eastmoney K-line upstream.
   */
  private async tryKlineFallback(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    target: URL
  ): Promise<boolean> {
    if (request.method !== 'GET' || target.pathname.toLowerCase() !== EASTMONEY_KLINE_PATH) {
      return false;
    }

    const secid = target.searchParams.get('secid') ?? '';
    if (/^90\.BK/i.test(secid)) {
      return false;
    }

    try {
      const payload = await this.getFallbackKlinePayload(target.searchParams);
      if (payload === undefined) {
        return false;
      }
      this.writeKlinePayload(response, target.searchParams, payload);
      return true;
    } catch {
      return false;
    }
  }

  private async getFallbackKlinePayload(searchParams: URLSearchParams): Promise<EastmoneyKlinePayload | undefined> {
    const secid = searchParams.get('secid') ?? '';
    const match = /^([01])\.(\d{6})$/.exec(secid);
    if (match === null) {
      return undefined;
    }

    const period = Number(searchParams.get('klt') ?? '101');
    const requestedLimit = Number(searchParams.get('lmt') ?? searchParams.get('smplmt') ?? '1000');
    const limit = Math.min(
      Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.floor(requestedLimit) : 1_000,
      MAX_KLINE_LIMIT
    );
    const market = Number(match[1]);
    const code = match[2];

    if ([5, 15, 30, 60].includes(period)) {
      return this.getMinuteKlinePayload(secid, code, market, period, limit);
    }
    if ([101, 102, 103].includes(period)) {
      return this.getDailyKlinePayload(secid, code, market, period, limit);
    }
    return undefined;
  }

  private async getMinuteKlinePayload(
    secid: string,
    code: string,
    market: number,
    period: number,
    limit: number
  ): Promise<EastmoneyKlinePayload> {
    const target = new URL(EASTMONEY_TRENDS_URL);
    target.searchParams.set('fields1', 'f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13');
    target.searchParams.set('fields2', 'f51,f52,f53,f54,f55,f56,f57,f58');
    target.searchParams.set('ut', EASTMONEY_UT);
    target.searchParams.set('iscr', '0');
    target.searchParams.set('ndays', '1');
    target.searchParams.set('secid', secid);

    const parsed = toRecord(JSON.parse(await this.fetchKlineFallbackText(target)) as unknown);
    const data = toRecord(parsed.data);
    const trends = Array.isArray(data.trends) ? data.trends : [];
    const preClose = Number(data.preClose) || Number(data.prePrice) || 0;
    const klines = aggregateMinuteTrends(trends, period, preClose).slice(-limit);

    return {
      rc: 0,
      rt: 17,
      svr: Number(parsed.svr) || 0,
      lt: 1,
      full: 0,
      dlmkts: parsed.dlmkts || '',
      dsc: '0',
      data: {
        code,
        market,
        name: typeof data.name === 'string' ? data.name : '',
        decimal: Number(data.decimal) || 2,
        preKPrice: preClose,
        prePrice: preClose,
        klines
      }
    };
  }

  private async getDailyKlinePayload(
    _secid: string,
    code: string,
    market: number,
    period: number,
    limit: number
  ): Promise<EastmoneyKlinePayload> {
    const target = new URL(SOHU_HISTORY_URL);
    target.searchParams.set('code', `cn_${code}`);
    target.searchParams.set('start', '19900101');
    target.searchParams.set('end', compactDate(new Date()));
    target.searchParams.set('stat', '1');
    target.searchParams.set('order', 'D');
    target.searchParams.set('period', 'd');
    target.searchParams.set('callback', 'historySearchHandler');
    target.searchParams.set('rt', 'jsonp');

    const parsed = parseJsonpPayload(await this.fetchKlineFallbackText(target));
    const quote = Array.isArray(parsed) ? toRecord(parsed[0]) : {};
    const sourceRows = Array.isArray(quote.hq)
      ? quote.hq.filter((row): row is unknown[] => Array.isArray(row)).slice().reverse()
      : [];
    const klines = aggregateDailyRows(sourceRows, period).slice(-limit);
    const lastFields = klines.length > 0 ? klines[klines.length - 1].split(',') : [];
    const prePrice = Number(lastFields[2]) || 0;

    return {
      rc: 0,
      rt: 17,
      svr: 0,
      lt: 1,
      full: 0,
      dlmkts: '',
      dsc: '0',
      data: {
        code,
        market,
        name: typeof quote.name === 'string' ? quote.name : '',
        decimal: 2,
        preKPrice: prePrice,
        prePrice,
        klines
      }
    };
  }

  private fetchKlineFallbackText(target: URL, redirectCount = 0): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const transport = target.protocol === 'https:' ? https : http;
      const upstreamRequest = transport.get(
        target,
        {
          headers: {
            accept: 'application/json, text/plain, */*',
            'accept-encoding': 'identity',
            referer: 'https://quote.eastmoney.com/',
            'user-agent': BROWSER_USER_AGENT
          },
          timeout: KLINE_FALLBACK_TIMEOUT_MS
        },
        (upstreamResponse) => {
          const statusCode = upstreamResponse.statusCode ?? 502;
          if (statusCode >= 300 && statusCode < 400) {
            const location = upstreamResponse.headers.location;
            upstreamResponse.resume();
            if (location && redirectCount < MAX_KLINE_REDIRECTS) {
              try {
                const redirected = new URL(location, target);
                if (this.isAllowedKlineFallbackTarget(redirected)) {
                  void this.fetchKlineFallbackText(redirected, redirectCount + 1).then(resolve, reject);
                  return;
                }
              } catch {
                // Reject the invalid redirect below.
              }
            }
            reject(new Error('K-line fallback returned an invalid redirect.'));
            return;
          }
          if (statusCode < 200 || statusCode >= 300) {
            upstreamResponse.resume();
            reject(new Error(`K-line fallback returned HTTP ${statusCode}.`));
            return;
          }

          this.collectBody(upstreamResponse).then(
            (body) => {
              const decoded = this.decodeBody(body, upstreamResponse.headers['content-encoding']);
              resolve(decoded.toString('utf8'));
            },
            reject
          );
        }
      );
      upstreamRequest.setTimeout(KLINE_FALLBACK_TIMEOUT_MS, () => {
        upstreamRequest.destroy(new Error('K-line fallback request timed out.'));
      });
      upstreamRequest.once('error', reject);
    });
  }

  private writeKlinePayload(
    response: http.ServerResponse,
    searchParams: URLSearchParams,
    payload: EastmoneyKlinePayload
  ): void {
    const requestedCallback = searchParams.get('cb') ?? searchParams.get('callback') ?? '';
    const callback = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(requestedCallback)
      ? requestedCallback
      : '';
    const json = JSON.stringify(payload);
    const body = Buffer.from(callback.length > 0 ? `${callback}(${json});` : json, 'utf8');
    response.writeHead(200, {
      ...this.corsHeaders(),
      'cache-control': 'no-store',
      'content-length': String(body.byteLength),
      'content-type': callback.length > 0 ? 'application/javascript; charset=utf-8' : 'application/json; charset=utf-8'
    });
    response.end(body);
  }

  private isAllowedKlineFallbackTarget(target: URL): boolean {
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      return false;
    }
    if (target.username.length > 0 || target.password.length > 0) {
      return false;
    }
    if (target.port !== '' && target.port !== '80' && target.port !== '443') {
      return false;
    }
    const hostname = target.hostname.toLowerCase();
    return hostname === 'q.stock.sohu.com' || hostname === 'push2delay.eastmoney.com';
  }

  private forwardSse(request: http.IncomingMessage, response: http.ServerResponse, target: URL): void {
    const connection: ActiveSseConnection = { response, paused: false };
    this.activeSse.add(connection);

    const openUpstream = (requestedTarget: URL, redirectCount: number): void => {
      const upstreamTarget = this.resolveEastmoneyUpstreamTarget(requestedTarget);
      const upstreamRequest = this.createUpstreamRequest(request, upstreamTarget, (upstreamResponse) => {
        connection.upstreamResponse = upstreamResponse;
        if (connection.paused) {
          upstreamResponse.destroy();
          return;
        }

        const statusCode = upstreamResponse.statusCode ?? 502;
        if (statusCode >= 300 && statusCode < 400) {
          const location = upstreamResponse.headers.location;
          upstreamResponse.resume();
          if (location && redirectCount < MAX_SSE_REDIRECTS) {
            try {
              const redirected = new URL(location, upstreamTarget);
              if (this.isAllowedTarget(redirected)) {
                openUpstream(redirected, redirectCount + 1);
                return;
              }
            } catch {
              // Report an invalid redirect below.
            }
          }
          this.writeText(response, 502, 'Eastmoney SSE returned an invalid redirect.');
          this.activeSse.delete(connection);
          return;
        }

        if (statusCode !== 200) {
          upstreamResponse.resume();
          if (statusCode === 204) {
            response.writeHead(204, this.corsHeaders());
            response.end();
          } else {
            this.writeText(
              response,
              statusCode >= 400 && statusCode <= 599 ? statusCode : 502,
              `Eastmoney SSE upstream returned HTTP ${statusCode}.`
            );
          }
          this.activeSse.delete(connection);
          return;
        }

        this.writeSseHeaders(response);
        upstreamResponse.on('data', (chunk: Buffer) => {
          if (connection.paused || response.writableEnded) {
            return;
          }
          if (!response.write(chunk)) {
            upstreamResponse.pause();
            response.once('drain', () => upstreamResponse.resume());
          }
        });
        upstreamResponse.once('end', () => {
          if (!connection.paused && !response.writableEnded) {
            response.end();
            this.activeSse.delete(connection);
          }
        });
        upstreamResponse.once('error', () => {
          if (!connection.paused && !response.writableEnded) {
            response.end();
            this.activeSse.delete(connection);
          }
        });
      });

      connection.upstreamRequest = upstreamRequest;
      upstreamRequest.once('error', (error: Error) => {
        if (connection.upstreamRequest !== upstreamRequest || connection.paused || response.writableEnded) {
          return;
        }
        if (!response.headersSent) {
          this.writeText(response, 502, `Eastmoney SSE connection failed: ${error.message}`);
        } else {
          response.end();
        }
        this.activeSse.delete(connection);
      });
      if (redirectCount === 0) {
        request.pipe(upstreamRequest);
      } else {
        upstreamRequest.end();
      }
    };

    response.once('close', () => {
      connection.upstreamRequest?.destroy();
      connection.upstreamResponse?.destroy();
      this.activeSse.delete(connection);
    });
    openUpstream(target, 0);
  }

  private forwardRegular(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    target: URL,
    isTrendPage: boolean
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      const upstreamTarget = this.resolveEastmoneyUpstreamTarget(target);
      const upstreamRequest = this.createUpstreamRequest(request, upstreamTarget, (upstreamResponse) => {
        const contentType = String(upstreamResponse.headers['content-type'] ?? '').toLowerCase();
        const shouldRewriteHtml = isTrendPage || contentType.includes('text/html');
        const shouldRewriteCss = contentType.includes('text/css');

        if (!shouldRewriteHtml && !shouldRewriteCss) {
          this.copyResponseHeaders(upstreamResponse, response, upstreamTarget, false, false);
          response.writeHead(upstreamResponse.statusCode ?? 502);
          upstreamResponse.pipe(response);
          upstreamResponse.once('end', resolve);
          upstreamResponse.once('error', () => {
            if (!response.writableEnded) {
              response.end();
            }
            resolve();
          });
          return;
        }

        this.collectBody(upstreamResponse)
          .then((compressedBody) => {
            const decodedBody = this.decodeBody(compressedBody, upstreamResponse.headers['content-encoding']);
            let bodyText = decodedBody.toString('latin1');
            bodyText = shouldRewriteHtml
              ? this.rewriteHtml(bodyText, upstreamTarget)
              : this.rewriteCss(bodyText, upstreamTarget);
            const rewrittenBody = Buffer.from(bodyText, 'latin1');

            this.copyResponseHeaders(upstreamResponse, response, upstreamTarget, true, shouldRewriteHtml);
            response.setHeader('content-length', String(rewrittenBody.byteLength));
            response.writeHead(upstreamResponse.statusCode ?? 502);
            if (request.method === 'HEAD') {
              response.end();
            } else {
              response.end(rewrittenBody);
            }
            resolve();
          })
          .catch((error: unknown) => {
            if (!response.headersSent) {
              const message = error instanceof Error ? error.message : 'Unable to rewrite upstream response.';
              this.writeText(response, 502, message);
            } else if (!response.writableEnded) {
              response.end();
            }
            resolve();
          });
      });

      upstreamRequest.once('error', (error: Error) => {
        if (!response.headersSent) {
          this.writeText(response, 502, `Upstream request failed: ${error.message}`);
        } else if (!response.writableEnded) {
          response.end();
        }
        resolve();
      });
      response.once('close', () => upstreamRequest.destroy());
      request.pipe(upstreamRequest);
    });
  }

  private createUpstreamRequest(
    request: http.IncomingMessage,
    target: URL,
    onResponse: (response: http.IncomingMessage) => void,
    methodOverride?: string
  ): http.ClientRequest {
    const headers: http.OutgoingHttpHeaders = {};
    const copiedHeaders = [
      'accept',
      'accept-language',
      'cache-control',
      'content-length',
      'content-type',
      'if-modified-since',
      'if-none-match',
      'last-event-id',
      'pragma',
      'range',
      'user-agent'
    ];
    for (const name of copiedHeaders) {
      const value = request.headers[name];
      if (value !== undefined) {
        headers[name] = value;
      }
    }

    const isSse = this.isSseRequest(request, target);
    headers.host = target.host;
    headers['accept-encoding'] = 'identity';
    headers.referer = 'https://quote.eastmoney.com/';
    // This is a server-side hop, so do not forge an Origin header. Eastmoney's
    // SSE edge currently resets streams that carry a synthetic origin.
    const userAgent = String(headers['user-agent'] ?? '');
    if (!/Mozilla\//i.test(userAgent)) {
      headers['user-agent'] = BROWSER_USER_AGENT;
    }

    const transport = target.protocol === 'https:' ? https : http;
    const upstreamRequest = transport.request(
      target,
      {
        method: methodOverride ?? request.method ?? 'GET',
        headers,
        timeout: isSse ? 0 : 20_000
      },
      onResponse
    );
    if (!isSse) {
      upstreamRequest.setTimeout(20_000, () => {
        upstreamRequest.destroy(new Error('Eastmoney upstream request timed out.'));
      });
    }
    return upstreamRequest;
  }

  private copyResponseHeaders(
    upstream: http.IncomingMessage,
    response: http.ServerResponse,
    target: URL,
    rewritten: boolean,
    html: boolean
  ): void {
    for (const [name, value] of Object.entries(upstream.headers)) {
      const lowerName = name.toLowerCase();
      if (value === undefined || STRIPPED_RESPONSE_HEADERS.has(lowerName)) {
        continue;
      }
      if (rewritten && lowerName === 'content-encoding') {
        continue;
      }
      if (lowerName === 'location') {
        const location = Array.isArray(value) ? value[0] : value;
        try {
          const redirected = new URL(location, target);
          if (this.isAllowedTarget(redirected)) {
            response.setHeader(name, this.proxyUrlFor(redirected));
          }
        } catch {
          // An invalid Location header is safer to omit than to expose directly.
        }
        continue;
      }
      response.setHeader(name, value);
    }

    for (const [name, value] of Object.entries(this.corsHeaders())) {
      response.setHeader(name, value);
    }
    response.setHeader('cross-origin-resource-policy', 'cross-origin');
    if (html) {
      response.setHeader('content-security-policy', PAGE_CSP);
      response.setHeader('cache-control', 'no-store');
    }
  }

  private collectBody(upstream: http.IncomingMessage): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let byteLength = 0;
      upstream.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        byteLength += buffer.byteLength;
        if (byteLength > MAX_REWRITABLE_RESPONSE_BYTES) {
          upstream.destroy();
          reject(new Error('The upstream response is too large to rewrite safely.'));
          return;
        }
        chunks.push(buffer);
      });
      upstream.once('end', () => resolve(Buffer.concat(chunks, byteLength)));
      upstream.once('error', reject);
    });
  }

  private decodeBody(body: Buffer, contentEncoding: string | string[] | undefined): Buffer {
    const encoding = String(Array.isArray(contentEncoding) ? contentEncoding[0] : contentEncoding ?? '')
      .toLowerCase()
      .trim();
    if (encoding === 'gzip') {
      return zlib.gunzipSync(body);
    }
    if (encoding === 'br') {
      return zlib.brotliDecompressSync(body);
    }
    if (encoding === 'deflate') {
      return zlib.inflateSync(body);
    }
    return body;
  }

  private rewriteHtml(source: string, target: URL): string {
    let html = source
      .replace(/<meta\b[^>]*http-equiv\s*=\s*(["']?)content-security-policy\1[^>]*>/gi, '')
      .replace(/<base\b[^>]*>/gi, '');

    html = html.replace(
      /\b(src|href|action|poster)\s*=\s*(["'])([^"']*)\2/gi,
      (_match, attribute: string, quote: string, value: string) =>
        `${attribute}=${quote}${this.rewriteUrl(value, target)}${quote}`
    );
    html = html.replace(
      /\b(src|href|action|poster)\s*=\s*([^\s"'=<>`]+)/gi,
      (_match, attribute: string, value: string) => `${attribute}=${this.rewriteUrl(value, target)}`
    );
    html = html.replace(/\bsrcset\s*=\s*(["'])([^"']*)\1/gi, (_match, quote: string, value: string) => {
      const rewritten = value
        .split(',')
        .map((candidate) => {
          const pieces = candidate.trim().split(/\s+/);
          const url = pieces.shift() ?? '';
          return [this.rewriteUrl(url, target), ...pieces].join(' ');
        })
        .join(', ');
      return `srcset=${quote}${rewritten}${quote}`;
    });
    // Rewrite CSS only where CSS is actually expected. Applying url(...) to the
    // entire document could accidentally mutate a JavaScript string or regex.
    html = html.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (_match, attributes: string, css: string) => {
      return `<style${attributes}>${this.rewriteCss(css, target)}</style>`;
    });
    html = html.replace(/\bstyle\s*=\s*(["'])([^"']*)\1/gi, (_match, quote: string, css: string) => {
      return `style=${quote}${this.rewriteCss(css, target)}${quote}`;
    });

    const injection = `<base href="${this.escapeHtml(target.toString())}"><style id="a-share-eastmoney-layout">html,body{width:100%!important;height:100%!important;margin:0!important;overflow:hidden!important}body{padding:0!important}.fullbox{width:100%!important;height:100%!important;min-width:0!important;min-height:0!important;overflow:hidden!important}</style><script>${this.injectionScript()}</script>`;
    if (/<head\b[^>]*>/i.test(html)) {
      return html.replace(/<head\b[^>]*>/i, (head) => `${head}${injection}`);
    }
    return `${injection}${html}`;
  }

  private rewriteCss(source: string, target: URL): string {
    return source
      .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (_match, quote: string, value: string) => {
        const rewritten = this.rewriteUrl(value.trim(), target);
        return `url(${quote}${rewritten}${quote})`;
      })
      .replace(/@import\s+(["'])([^"']+)\1/gi, (_match, quote: string, value: string) => {
        return `@import ${quote}${this.rewriteUrl(value, target)}${quote}`;
      });
  }

  private rewriteUrl(value: string, base: URL): string {
    const trimmed = value.trim();
    if (
      trimmed.length === 0 ||
      trimmed.startsWith('#') ||
      /^(?:data|blob|javascript|mailto|tel):/i.test(trimmed) ||
      trimmed.startsWith(this.localOrigin())
    ) {
      return value;
    }

    try {
      const target = new URL(trimmed, base);
      return this.isAllowedTarget(target) ? this.proxyUrlFor(target) : value;
    } catch {
      return value;
    }
  }

  private injectionScript(): string {
    const proxyEndpoint = `${this.localOrigin()}/${this.token}/proxy?url=`;
    const localOrigin = this.localOrigin();
    return `(() => {
  'use strict';
  const endpoint = ${JSON.stringify(proxyEndpoint)};
  const localOrigin = ${JSON.stringify(localOrigin)};
  const allowed = (hostname) => hostname === 'eastmoney.com' || hostname.endsWith('.eastmoney.com');
  const proxify = (value) => {
    if (value === undefined || value === null) return value;
    const raw = value instanceof URL ? value.href : String(value);
    if (raw.startsWith(localOrigin) || /^(?:data|blob|javascript|mailto|tel):/i.test(raw)) return raw;
    try {
      const absolute = new URL(raw, document.baseURI);
      return allowed(absolute.hostname.toLowerCase()) ? endpoint + encodeURIComponent(absolute.href) : raw;
    } catch (_) {
      return raw;
    }
  };

  const nativeFetch = window.fetch && window.fetch.bind(window);
  if (nativeFetch) {
    window.fetch = (input, init) => {
      if (typeof Request !== 'undefined' && input instanceof Request) {
        const nextUrl = proxify(input.url);
        input = nextUrl === input.url ? input : new Request(nextUrl, input);
      } else {
        input = proxify(input);
      }
      return nativeFetch(input, init);
    };
  }

  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    return nativeOpen.call(this, method, proxify(url), ...rest);
  };

  if (window.EventSource) {
    const NativeEventSource = window.EventSource;
    const ProxyEventSource = function(url, options) {
      return new NativeEventSource(proxify(url), options);
    };
    Object.setPrototypeOf(ProxyEventSource, NativeEventSource);
    ProxyEventSource.prototype = NativeEventSource.prototype;
    window.EventSource = ProxyEventSource;
  }

  if (navigator.sendBeacon) {
    const nativeSendBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url, data) => nativeSendBeacon(proxify(url), data);
  }

  const nativeSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    const lowerName = String(name).toLowerCase();
    if (lowerName === 'src' || lowerName === 'href' || lowerName === 'action' || lowerName === 'poster') {
      value = proxify(value);
    }
    return nativeSetAttribute.call(this, name, value);
  };

  const patchUrlProperty = (constructor, property) => {
    if (!constructor || !constructor.prototype) return;
    const descriptor = Object.getOwnPropertyDescriptor(constructor.prototype, property);
    if (!descriptor || !descriptor.get || !descriptor.set || descriptor.configurable === false) return;
    Object.defineProperty(constructor.prototype, property, {
      configurable: descriptor.configurable,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set(value) { descriptor.set.call(this, proxify(value)); }
    });
  };
  [
    [window.HTMLScriptElement, 'src'],
    [window.HTMLLinkElement, 'href'],
    [window.HTMLImageElement, 'src'],
    [window.HTMLSourceElement, 'src'],
    [window.HTMLIFrameElement, 'src'],
    [window.HTMLFormElement, 'action'],
    [window.HTMLAnchorElement, 'href']
  ].forEach(([constructor, property]) => patchUrlProperty(constructor, property));

  if (window.Worker) {
    const NativeWorker = window.Worker;
    window.Worker = function(url, options) { return new NativeWorker(proxify(url), options); };
    window.Worker.prototype = NativeWorker.prototype;
  }
})();`;
  }

  private proxyUrlFor(target: URL): string {
    return `${this.localOrigin()}/${this.token}/proxy?url=${encodeURIComponent(target.toString())}`;
  }

  private localOrigin(): string {
    if (this.port === undefined) {
      throw new Error('The Eastmoney proxy has not started.');
    }
    return `http://${LOOPBACK_HOST}:${this.port}`;
  }

  private isAllowedTarget(target: URL): boolean {
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      return false;
    }
    if (target.username.length > 0 || target.password.length > 0) {
      return false;
    }
    if (target.port !== '' && target.port !== '80' && target.port !== '443') {
      return false;
    }
    const hostname = target.hostname.toLowerCase();
    return hostname === 'eastmoney.com' || hostname.endsWith('.eastmoney.com');
  }

  /** Mirrors LeekFund's stable push2 upstream selection. */
  private resolveEastmoneyUpstreamTarget(target: URL): URL {
    const hostname = target.hostname.toLowerCase();
    if (/^\d+\.push2his\.eastmoney\.com$/i.test(hostname)) {
      const resolved = new URL(target.toString());
      resolved.protocol = 'https:';
      resolved.port = '';
      return resolved;
    }
    if (
      /^push2(?:delay)?\.eastmoney\.com$/i.test(hostname) ||
      /^\d+\.push2\.eastmoney\.com$/i.test(hostname) ||
      /^push2his\.eastmoney\.com$/i.test(hostname)
    ) {
      const resolved = new URL(target.toString());
      resolved.protocol = 'https:';
      resolved.hostname = 'push2delay.eastmoney.com';
      resolved.port = '';
      return resolved;
    }
    return target;
  }

  private isSseRequest(request: http.IncomingMessage, target: URL): boolean {
    const accept = String(request.headers.accept ?? '').toLowerCase();
    return accept.includes('text/event-stream') || /(?:^|\/)sse(?:\/|$)/i.test(target.pathname);
  }

  private isMarketApi(target: URL): boolean {
    const hostname = target.hostname.toLowerCase();
    return (
      hostname.startsWith('push2.') ||
      hostname.startsWith('push2his.') ||
      hostname.startsWith('push2delay.') ||
      /\/api\/qt\//i.test(target.pathname)
    );
  }

  private createPausedSse(response: http.ServerResponse): void {
    this.writeSseHeaders(response);
    const connection: ActiveSseConnection = { response, paused: true };
    this.activeSse.add(connection);
    response.write(': market requests paused\n\n');
    response.once('close', () => this.activeSse.delete(connection));
  }

  private pauseSse(connection: ActiveSseConnection): void {
    if (connection.paused) {
      return;
    }
    connection.paused = true;
    connection.upstreamRequest?.destroy();
    connection.upstreamResponse?.destroy();
    if (!connection.response.writableEnded) {
      this.writeSseHeaders(connection.response);
      connection.response.write(': market requests paused\n\n');
    }
  }

  private writeSseHeaders(response: http.ServerResponse): void {
    if (response.headersSent) {
      return;
    }
    response.writeHead(200, {
      ...this.corsHeaders(),
      'cache-control': 'no-cache, no-store, must-revalidate',
      connection: 'keep-alive',
      'content-type': 'text/event-stream; charset=utf-8',
      'x-accel-buffering': 'no'
    });
    response.flushHeaders();
  }

  private writeBlockedMarketResponse(response: http.ServerResponse): void {
    const body = Buffer.from('{"rc":-1,"rt":0,"data":null,"message":"market requests paused"}', 'utf8');
    response.writeHead(200, {
      ...this.corsHeaders(),
      'cache-control': 'no-store',
      'content-length': String(body.byteLength),
      'content-type': 'application/json; charset=utf-8'
    });
    response.end(body);
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      for (const connection of this.activeSse) {
        if (connection.paused && !connection.response.writableEnded) {
          connection.response.write(': paused heartbeat\n\n');
        }
      }
    }, 15_000);
    this.heartbeatTimer.unref();
  }

  private corsHeaders(): Record<string, string> {
    return {
      'access-control-allow-headers': 'content-type, last-event-id',
      'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS',
      'access-control-allow-origin': '*'
    };
  }

  private writeText(response: http.ServerResponse, status: number, message: string): void {
    const body = Buffer.from(message, 'utf8');
    response.writeHead(status, {
      ...this.corsHeaders(),
      'cache-control': 'no-store',
      'content-length': String(body.byteLength),
      'content-type': 'text/plain; charset=utf-8'
    });
    response.end(body);
  }

  private normalizeSecid(input: string): string {
    const code = String(input).trim().toLowerCase();
    const secid = /^([01])\.(\d{6})$/.exec(code);
    if (secid !== null) {
      return `${secid[1]}.${secid[2]}`;
    }

    const prefixed = /^(sh|sz|bj)[._-]?(\d{6})$/.exec(code);
    if (prefixed !== null) {
      return `${prefixed[1] === 'sh' ? '1' : '0'}.${prefixed[2]}`;
    }

    if (!/^\d{6}$/.test(code)) {
      throw new Error(`Invalid A-share code: ${input}`);
    }
    const market = /^[569]/.test(code) ? '1' : '0';
    return `${market}.${code}`;
  }

  private escapeHtml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
