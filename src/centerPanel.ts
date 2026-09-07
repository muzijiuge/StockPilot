import * as crypto from 'crypto';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { shouldRequestCloudNetwork } from './cloudSnapshot';
import { DataService } from './dataService';
import { ChinaMarketState, getChinaMarketState } from './marketHours';
import { pickAStock } from './pickStock';
import { StockProvider } from './providers';
import { StateStore } from './stateStore';
import {
  CenterTab,
  CloudStock,
  DEFAULT_NAMES,
  MarketFilter,
  SectorBoardKind,
  isAShareCode
} from './types';

const VALID_TABS = new Set<CenterTab>(['watch', 'assets', 'news', 'cloud', 'sector']);
const VALID_FILTERS = new Set<MarketFilter>(['all', 'sh', 'sz', 'bj', 'star', 'chinext']);
const VALID_SECTOR_KINDS = new Set<SectorBoardKind>(['industry', 'concept']);
const SECTOR_CODE_PATTERN = /^BK\d{4}$/i;
const SECTOR_LIST_REFRESH_INTERVAL = 60_000;
const SECTOR_DETAIL_REFRESH_INTERVAL = 15_000;

type SectorView = 'overview' | 'boards' | 'detail';
type SectorListKind = SectorBoardKind | 'ranking';

export class CenterPanel {
  private static current: CenterPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private ready = false;
  private activeTab: CenterTab;
  private selectedCode: string;
  private profileRequestId = 0;
  private cloudRequestId = 0;
  private readonly cloudInFlight = new Map<MarketFilter, Promise<CloudStock[]>>();
  private cloudFilter: MarketFilter = 'all';
  private sectorView: SectorView = 'overview';
  private sectorKind: SectorListKind = 'industry';
  private selectedSectorCode = '';
  private sectorOverviewRequestId = 0;
  private readonly sectorBoardsRequestIds: Record<SectorBoardKind, number> = {
    industry: 0,
    concept: 0
  };
  private sectorDetailRequestId = 0;
  private lastNewsLoadedAt = 0;
  private lastNewsAttemptAt = 0;
  private lastCloudLoadedAt = 0;
  private lastCloudAttemptAt = 0;
  private lastSectorRequestAt = 0;

  public static async autoRefreshVisible(
    allowMarketRequest: boolean,
    market: ChinaMarketState = getChinaMarketState()
  ): Promise<void> {
    const current = CenterPanel.current;
    if (!current || !current.ready) {
      return;
    }
    current.post({ type: 'marketState', data: market });
    if (!current.panel.visible) {
      return;
    }
    await current.autoRefresh(allowMarketRequest);
  }

  public static isVisible(): boolean {
    return Boolean(CenterPanel.current?.ready && CenterPanel.current.panel.visible);
  }

  public static createOrShow(
    context: vscode.ExtensionContext,
    stateStore: StateStore,
    dataService: DataService,
    stockProvider: StockProvider,
    tab: CenterTab = 'watch',
    code?: string
  ): CenterPanel {
    if (CenterPanel.current) {
      CenterPanel.current.panel.reveal(vscode.ViewColumn.One);
      CenterPanel.current.navigate(tab, code);
      return CenterPanel.current;
    }

    const panel = vscode.window.createWebviewPanel(
      'aShareLeek.center',
      '韭菜中心',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        enableFindWidget: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'media'),
          vscode.Uri.joinPath(context.extensionUri, 'resources')
        ]
      }
    );
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'leekfund.svg');
    CenterPanel.current = new CenterPanel(
      panel,
      context,
      stateStore,
      dataService,
      stockProvider,
      tab,
      code
    );
    return CenterPanel.current;
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly stateStore: StateStore,
    private readonly dataService: DataService,
    private readonly stockProvider: StockProvider,
    tab: CenterTab,
    code?: string
  ) {
    this.activeTab = VALID_TABS.has(tab) ? tab : 'watch';
    this.selectedCode =
      code && isAShareCode(code)
        ? code.toLowerCase()
        : stateStore.getWatchlist()[0] || 'sh600036';
    this.panel.webview.html = this.getHtml(this.panel.webview);

    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((message) => this.handleMessage(message)),
      this.stockProvider.onDidUpdateSnapshot((snapshot) => {
        if (this.ready) {
          this.post({ type: 'snapshot', data: snapshot });
        }
      })
    );
  }

  public navigate(tab: CenterTab, code?: string): void {
    this.activeTab = VALID_TABS.has(tab) ? tab : 'watch';
    if (code && isAShareCode(code)) {
      this.selectedCode = code.toLowerCase();
    }
    if (!this.ready) {
      return;
    }
    this.post({
      type: 'navigate',
      tab: this.activeTab,
      code: this.selectedCode
    });
    void this.loadForActiveTab(false, true).catch((error) => {
      this.post({
        type: 'error',
        message: error instanceof Error ? error.message : String(error)
      });
    });
  }

  public openSectorBoard(kind: SectorBoardKind, code: string): void {
    const normalized = this.normalizeSectorCode(code);
    if (!VALID_SECTOR_KINDS.has(kind) || !normalized) {
      return;
    }
    this.activeTab = 'sector';
    this.sectorView = 'detail';
    this.sectorKind = kind;
    this.selectedSectorCode = normalized;
    if (!this.ready) {
      return;
    }
    this.post({ type: 'navigate', tab: 'sector' });
    void this.loadSectorDetail(normalized, false).catch((error) => {
      this.post({
        type: 'error',
        message: error instanceof Error ? error.message : String(error)
      });
    });
  }

  private async handleMessage(message: any): Promise<void> {
    try {
      switch (message?.type) {
        case 'ready':
          this.ready = true;
          this.post({ type: 'snapshot', data: this.stockProvider.getSnapshot() });
          this.post({ type: 'sectorFollows', data: this.stateStore.getSectorFollows() });
          this.post({ type: 'marketState', data: getChinaMarketState() });
          this.navigate(this.activeTab, this.selectedCode);
          break;
        case 'setActiveTab': {
          const tab = String(message.tab) as CenterTab;
          if (VALID_TABS.has(tab)) {
            const changed = tab !== this.activeTab;
            this.activeTab = tab;
            if (changed) {
              await this.loadForActiveTab(false, true);
            }
          }
          break;
        }
        case 'selectStock': {
          const code = String(message.code || '').toLowerCase();
          if (isAShareCode(code)) {
            this.selectedCode = code;
            this.activeTab = 'watch';
            await this.loadSelectionQuote(code);
            await this.loadProfile(false);
          }
          break;
        }
        case 'refreshData':
          if (this.activeTab !== 'sector') {
            await this.stockProvider.refresh(true);
          }
          await this.loadForActiveTab(true, true);
          break;
        case 'loadNews':
          await this.loadNews(Boolean(message.force));
          break;
        case 'loadCloud': {
          const filter = String(message.filter || 'all') as MarketFilter;
          await this.loadCloud(
            VALID_FILTERS.has(filter) ? filter : 'all',
            Boolean(message.force),
            true
          );
          break;
        }
        case 'loadSectorOverview':
          this.sectorView = 'overview';
          await this.loadSectorOverview(Boolean(message.force));
          break;
        case 'setSectorView': {
          const mode = String(message.mode || 'overview');
          const kind = String(message.kind || 'industry');
          if (mode === 'overview') {
            this.sectorView = 'overview';
            this.selectedSectorCode = '';
          } else if (mode === 'list') {
            this.sectorView = 'boards';
            this.sectorKind =
              kind === 'ranking' || VALID_SECTOR_KINDS.has(kind as SectorBoardKind)
                ? (kind as SectorListKind)
                : 'industry';
            this.selectedSectorCode = '';
          } else if (mode === 'detail') {
            this.sectorView = 'detail';
            if (VALID_SECTOR_KINDS.has(kind as SectorBoardKind)) {
              this.sectorKind = kind as SectorBoardKind;
            }
            const code = this.normalizeSectorCode(message.code);
            if (code) {
              this.selectedSectorCode = code;
            }
          }
          break;
        }
        case 'loadSectorBoards': {
          const kind = String(message.kind || 'industry') as SectorBoardKind;
          if (VALID_SECTOR_KINDS.has(kind)) {
            this.sectorView = 'boards';
            this.sectorKind = kind;
            await this.loadSectorBoards(kind, Boolean(message.force));
          }
          break;
        }
        case 'loadSectorRanking':
          this.sectorView = 'boards';
          this.sectorKind = 'ranking';
          await Promise.all([
            this.loadSectorBoards('industry', Boolean(message.force)),
            this.loadSectorBoards('concept', Boolean(message.force))
          ]);
          break;
        case 'loadSectorDetail': {
          const bkCode = this.normalizeSectorCode(message.bkCode || message.code);
          if (bkCode) {
            this.sectorView = 'detail';
            const kind = String(message.kind || '') as SectorBoardKind;
            if (VALID_SECTOR_KINDS.has(kind)) {
              this.sectorKind = kind;
            }
            this.selectedSectorCode = bkCode;
            await this.loadSectorDetail(bkCode, Boolean(message.force));
          }
          break;
        }
        case 'toggleSectorFollow':
          await this.toggleSectorFollow(String(message.bkCode || message.code || ''));
          break;
        case 'openSectorStock':
          await this.openSectorStock(String(message.code || ''));
          break;
        case 'addSectorStock':
          await this.addSectorStock(String(message.code || ''));
          break;
        case 'pickHolding':
          await this.pickHolding();
          break;
        case 'saveHolding':
          await this.saveHolding(message.holding);
          break;
        case 'deleteHolding':
          await this.deleteHolding(String(message.code || ''));
          break;
        case 'removeWatch':
          await this.stateStore.removeWatch(String(message.code || ''));
          await this.stockProvider.refresh(false);
          break;
        case 'openCloudStock':
          await this.openCloudStock(String(message.code || ''));
          break;
        case 'openExternal':
          await this.openExternal(String(message.url || ''));
          break;
        default:
          break;
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.post({ type: 'error', message: detail });
    }
  }

  private async loadForActiveTab(force: boolean, userInitiated: boolean): Promise<void> {
    if (this.activeTab === 'watch') {
      await this.loadSelectionQuote(this.selectedCode);
      await this.loadProfile(force);
    } else if (this.activeTab === 'news') {
      await this.loadNews(force);
    } else if (this.activeTab === 'cloud') {
      await this.loadCloud(this.cloudFilter, force, userInitiated);
    } else if (this.activeTab === 'sector') {
      await this.loadCurrentSectorView(force);
    }
  }

  private async autoRefresh(allowMarketRequest: boolean): Promise<void> {
    const now = Date.now();
    if (this.activeTab === 'watch' && allowMarketRequest) {
      await this.loadSelectionQuote(this.selectedCode);
      return;
    }
    if (
      this.activeTab === 'news' &&
      now - Math.max(this.lastNewsLoadedAt, this.lastNewsAttemptAt) >= 120_000
    ) {
      await this.loadNews(true);
      return;
    }
    if (
      this.activeTab === 'cloud' &&
      allowMarketRequest &&
      now - Math.max(this.lastCloudLoadedAt, this.lastCloudAttemptAt) >= 300_000
    ) {
      await this.loadCloud(this.cloudFilter, true, false);
      return;
    }
    if (
      this.activeTab === 'sector' &&
      allowMarketRequest &&
      now - this.lastSectorRequestAt >=
        (this.sectorView === 'detail'
          ? SECTOR_DETAIL_REFRESH_INTERVAL
          : SECTOR_LIST_REFRESH_INTERVAL)
    ) {
      await this.loadCurrentSectorView(true);
    }
  }

  private async loadCurrentSectorView(force: boolean): Promise<void> {
    if (this.sectorView === 'detail' && this.selectedSectorCode) {
      await this.loadSectorDetail(this.selectedSectorCode, force);
      return;
    }
    if (this.sectorView === 'boards') {
      if (this.sectorKind === 'ranking') {
        await Promise.all([
          this.loadSectorBoards('industry', force),
          this.loadSectorBoards('concept', force)
        ]);
      } else {
        await this.loadSectorBoards(this.sectorKind, force);
      }
      return;
    }
    await this.loadSectorOverview(force);
  }

  private async loadSelectionQuote(code: string): Promise<void> {
    const existing = this.stockProvider.getQuote(code);
    if (existing) {
      this.post({ type: 'selectionQuote', data: existing });
      return;
    }
    const quotes = await this.dataService.getQuotes([code]);
    if (quotes[0]) {
      this.post({ type: 'selectionQuote', data: quotes[0] });
    }
  }

  private async loadProfile(force: boolean): Promise<void> {
    const code = this.selectedCode;
    const requestId = ++this.profileRequestId;
    this.post({ type: 'profileLoading', code });
    const data = await this.dataService.getStockProfile(code, force);
    if (requestId === this.profileRequestId && code === this.selectedCode) {
      this.post({ type: 'profile', code, data });
    }
  }

  private async loadNews(force: boolean): Promise<void> {
    this.lastNewsAttemptAt = Date.now();
    this.post({ type: 'newsLoading' });
    const data = await this.dataService.getNews(force);
    this.lastNewsLoadedAt = Date.now();
    this.post({ type: 'news', data, updatedAt: this.lastNewsLoadedAt });
  }

  private async loadCloud(
    filter: MarketFilter,
    force: boolean,
    userInitiated: boolean
  ): Promise<void> {
    this.cloudFilter = filter;
    const requestId = ++this.cloudRequestId;
    const snapshot = this.stateStore.getCloudSnapshot(filter);
    if (snapshot && userInitiated && !force) {
      this.lastCloudLoadedAt = snapshot.updatedAt;
      this.post({
        type: 'cloud',
        filter,
        data: snapshot.data,
        updatedAt: snapshot.updatedAt,
        cached: true
      });
    } else if (!snapshot && userInitiated) {
      this.post({ type: 'cloudLoading', filter });
    }

    const market = getChinaMarketState();
    const requestOutsideTradingHours = vscode.workspace
      .getConfiguration('aShareLeek')
      .get<boolean>('requestOutsideTradingHours', false);
    if (
      !shouldRequestCloudNetwork(
        userInitiated,
        market.isTradingTime,
        requestOutsideTradingHours
      )
    ) {
      if (!snapshot && userInitiated) {
        this.post({
          type: 'cloudUnavailable',
          filter,
          message: '暂无最近云图快照，点击右上角刷新按钮获取。'
        });
      }
      return;
    }

    this.lastCloudAttemptAt = Date.now();
    let data: CloudStock[];
    try {
      // User actions always bypass the five-minute memory cache so opening at
      // close cannot keep showing a 14:58 in-memory snapshot as the final close.
      data = await this.requestCloudData(filter, force || userInitiated);
    } catch (error) {
      if (snapshot) {
        console.warn(
          '[A股韭菜盒子] 云图刷新失败，继续展示最近快照：',
          error instanceof Error ? error.message : String(error)
        );
        if (
          userInitiated &&
          requestId === this.cloudRequestId &&
          filter === this.cloudFilter
        ) {
          const cachedAt = new Date(snapshot.updatedAt).toLocaleString('zh-CN', {
            timeZone: 'Asia/Shanghai',
            hour12: false
          });
          this.post({
            type: 'cloudRefreshFailed',
            filter,
            updatedAt: snapshot.updatedAt,
            message: '获取最近收盘云图失败，继续显示 ' + cachedAt + ' 缓存。'
          });
        }
        return;
      }
      throw error;
    }
    const updatedAt = this.dataService.getCloudUpdatedAt(filter) || Date.now();
    void this.stateStore.saveCloudSnapshot(filter, data, updatedAt).catch((error) => {
      console.warn(
        '[A股韭菜盒子] 云图快照保存失败：',
        error instanceof Error ? error.message : String(error)
      );
    });
    if (requestId !== this.cloudRequestId || filter !== this.cloudFilter) {
      return;
    }
    this.lastCloudLoadedAt = updatedAt;
    this.post({ type: 'cloud', filter, data, updatedAt: this.lastCloudLoadedAt });
  }

  private requestCloudData(filter: MarketFilter, force: boolean): Promise<CloudStock[]> {
    const existing = this.cloudInFlight.get(filter);
    if (existing) {
      return existing;
    }
    const request = this.dataService.getCloud(filter, force).finally(() => {
      if (this.cloudInFlight.get(filter) === request) {
        this.cloudInFlight.delete(filter);
      }
    });
    this.cloudInFlight.set(filter, request);
    return request;
  }

  private async loadSectorOverview(force: boolean): Promise<void> {
    const requestId = ++this.sectorOverviewRequestId;
    const requestedAt = Date.now();
    this.lastSectorRequestAt = requestedAt;
    this.post({ type: 'sectorOverviewLoading' });
    const data = await this.dataService.getSectorOverview(force);
    if (requestId !== this.sectorOverviewRequestId || this.sectorView !== 'overview') {
      return;
    }
    this.post({
      type: 'sectorOverview',
      data,
      updatedAt: data.updatedAt || Date.now()
    });
  }

  private async loadSectorBoards(kind: SectorBoardKind, force: boolean): Promise<void> {
    const requestId = ++this.sectorBoardsRequestIds[kind];
    this.lastSectorRequestAt = Date.now();
    this.post({ type: 'sectorBoardsLoading', kind });
    const data = await this.dataService.getSectorBoards(kind, force);
    if (
      requestId !== this.sectorBoardsRequestIds[kind] ||
      this.sectorView !== 'boards'
    ) {
      return;
    }
    this.post({ type: 'sectorBoards', kind, data, updatedAt: Date.now() });
  }

  private async loadSectorDetail(bkCode: string, force: boolean): Promise<void> {
    const requestId = ++this.sectorDetailRequestId;
    this.lastSectorRequestAt = Date.now();
    const kind = this.sectorKind === 'concept' ? 'concept' : 'industry';
    this.post({ type: 'sectorDetailLoading', bkCode, kind });
    const data = await this.dataService.getSectorConstituents(bkCode, force);
    if (
      requestId !== this.sectorDetailRequestId ||
      this.sectorView !== 'detail' ||
      bkCode !== this.selectedSectorCode
    ) {
      return;
    }
    this.post({ type: 'sectorDetail', bkCode, kind, data, updatedAt: Date.now() });
  }

  private async toggleSectorFollow(code: string): Promise<void> {
    const normalized = this.normalizeSectorCode(code);
    if (!normalized) {
      return;
    }
    await this.stateStore.toggleSectorFollow(normalized);
    this.post({ type: 'sectorFollows', data: this.stateStore.getSectorFollows() });
  }

  private normalizeSectorCode(code: unknown): string {
    const normalized = String(code || '').toUpperCase();
    return SECTOR_CODE_PATTERN.test(normalized) ? normalized : '';
  }

  private async pickHolding(): Promise<void> {
    const picked = await pickAStock(this.dataService);
    if (!picked) {
      return;
    }
    const quotes = await this.dataService.getQuotes([picked.code]);
    this.post({
      type: 'holdingCandidate',
      data: {
        code: picked.code,
        name: picked.name,
        amount: 100,
        cost: quotes[0]?.price || 0
      }
    });
  }

  private async saveHolding(raw: any): Promise<void> {
    const code = String(raw?.code || '').toLowerCase();
    if (!isAShareCode(code)) {
      throw new Error('无效的 A 股代码。');
    }
    const quote = this.stockProvider.getQuote(code);
    await this.stateStore.saveHolding({
      code,
      name: String(raw?.name || quote?.name || DEFAULT_NAMES[code] || code),
      amount: Number(raw?.amount),
      cost: Number(raw?.cost),
      updatedAt: Date.now()
    });
    await this.stockProvider.refresh(false);
    this.post({ type: 'holdingSaved', code });
  }

  private async deleteHolding(code: string): Promise<void> {
    const normalized = code.toLowerCase();
    if (!isAShareCode(normalized)) {
      return;
    }
    const holding = this.stateStore.getHoldings().find((item) => item.code === normalized);
    if (!holding) {
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      '确认删除“' + holding.name + '”的本地持仓记录？',
      { modal: true },
      '删除'
    );
    if (answer !== '删除') {
      return;
    }
    await this.stateStore.deleteHolding(normalized);
    await this.stockProvider.refresh(false);
    this.post({ type: 'holdingDeleted', code: normalized });
  }

  private async openCloudStock(code: string): Promise<void> {
    const normalized = code.toLowerCase();
    if (!isAShareCode(normalized)) {
      return;
    }
    await vscode.commands.executeCommand('aShareLeek.openStock', normalized);
  }

  private async openSectorStock(code: string): Promise<void> {
    const normalized = code.toLowerCase();
    if (!isAShareCode(normalized)) {
      return;
    }
    await vscode.commands.executeCommand('aShareLeek.openStock', normalized);
  }

  private async addSectorStock(code: string): Promise<void> {
    const normalized = code.toLowerCase();
    if (!isAShareCode(normalized)) {
      return;
    }
    await this.stateStore.addWatch(normalized, 'stock');
    await this.stockProvider.refresh(false);
    this.post({ type: 'sectorStockAdded', code: normalized });
  }

  private async openExternal(url: string): Promise<void> {
    const uri = vscode.Uri.parse(url);
    if (uri.scheme !== 'http' && uri.scheme !== 'https') {
      throw new Error('已阻止不安全的外部链接。');
    }
    await vscode.env.openExternal(uri);
  }

  private post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview): string {
    const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'center.html').fsPath;
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'center.css')
    );
    const echartsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'echarts.min.js')
    );
    const appUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'center.js')
    );
    const nonce = crypto.randomBytes(18).toString('base64');
    return fs
      .readFileSync(htmlPath, 'utf8')
      .replaceAll('{{cspSource}}', webview.cspSource)
      .replaceAll('{{nonce}}', nonce)
      .replaceAll('{{cssUri}}', cssUri.toString())
      .replaceAll('{{echartsUri}}', echartsUri.toString())
      .replaceAll('{{appUri}}', appUri.toString());
  }

  private dispose(): void {
    CenterPanel.current = undefined;
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}
