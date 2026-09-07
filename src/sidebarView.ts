import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { DataService } from './dataService';
import { getChinaMarketState } from './marketHours';
import { StockProvider } from './providers';
import { AppSnapshot, SectorBoard, SectorBoardKind, isAShareCode } from './types';

type SidebarItemKind = 'holding' | 'stock' | 'index';

export class SidebarViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private readonly snapshotSubscription: vscode.Disposable;
  private readonly sectorBoards: Record<SectorBoardKind, SectorBoard[]> = {
    industry: [],
    concept: []
  };
  private sectorUpdatedAt = 0;
  private sectorRefreshPromise: Promise<void> | undefined;
  private visibleRefreshPromise: Promise<void> | undefined;
  private sectorTimer: NodeJS.Timeout | undefined;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly stockProvider: StockProvider,
    private readonly dataService: DataService
  ) {
    this.snapshotSubscription = this.stockProvider.onDidUpdateSnapshot((snapshot) => {
      this.postSnapshot(snapshot);
    });
  }

  public dispose(): void {
    this.stopSectorTimer();
    this.view = undefined;
    this.snapshotSubscription.dispose();
  }

  public isVisible(): boolean {
    return this.view?.visible === true;
  }

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    };
    view.webview.html = this.getHtml(view.webview);
    const visibilitySubscription = view.onDidChangeVisibility(() => {
      if (view.visible) {
        void this.refreshVisibleView();
      } else {
        this.stopSectorTimer();
      }
    });
    view.onDidDispose(() => {
      visibilitySubscription.dispose();
      if (this.view === view) {
        this.view = undefined;
      }
    });
    view.webview.onDidReceiveMessage((message) => {
      void this.handleMessage(message);
    });
  }

  private async handleMessage(message: unknown): Promise<void> {
    const payload = message as
      | {
          type?: unknown;
          code?: unknown;
          kind?: unknown;
          groupId?: unknown;
          sourceGroupId?: unknown;
        }
      | undefined;
    const code = String(payload?.code || '').toLowerCase();
    if (payload?.type === 'ready') {
      await this.refreshVisibleView();
      return;
    }
    if (payload?.type === 'openSector') {
      const kind = payload.kind === 'concept' ? 'concept' : 'industry';
      await vscode.commands.executeCommand('aShareLeek.openSector', {
        code: String(payload.code || '').toUpperCase(),
        kind
      });
      return;
    }
    if (payload?.type === 'renameWatchGroup') {
      await vscode.commands.executeCommand('aShareLeek.renameWatchGroup', {
        groupId: String(payload.groupId || '').toLowerCase()
      });
      return;
    }
    if (payload?.type === 'deleteWatchGroup') {
      await vscode.commands.executeCommand('aShareLeek.deleteWatchGroup', {
        groupId: String(payload.groupId || '').toLowerCase()
      });
      return;
    }
    if (payload?.type === 'createWatchGroup') {
      await vscode.commands.executeCommand('aShareLeek.addWatchGroup');
      return;
    }
    if (!isAShareCode(code)) {
      return;
    }
    if (payload?.type === 'openStock') {
      await vscode.commands.executeCommand('aShareLeek.openStock', code);
      return;
    }
    if (payload?.type === 'setHolding') {
      await vscode.commands.executeCommand('aShareLeek.setHolding', code);
      return;
    }
    if (payload?.type === 'moveWatchToGroup') {
      await vscode.commands.executeCommand('aShareLeek.moveWatchToGroup', {
        code,
        sourceGroupId: String(payload.sourceGroupId || '').toLowerCase()
      });
      return;
    }
    if (payload?.type === 'assignWatchToGroup') {
      await vscode.commands.executeCommand('aShareLeek.moveWatchToGroup', {
        code,
        sourceGroupId: String(payload.sourceGroupId || '').toLowerCase(),
        groupId: String(payload.groupId || '').toLowerCase()
      });
      return;
    }
    if (payload?.type === 'removeStock') {
      const kind: SidebarItemKind =
        payload.kind === 'holding' || payload.kind === 'index' ? payload.kind : 'stock';
      await vscode.commands.executeCommand('aShareLeek.removeStock', {
        code,
        kind,
        groupId: String(payload.groupId || '').toLowerCase()
      });
    }
  }

  private postSnapshot(snapshot: AppSnapshot): void {
    if (this.view?.visible) {
      void this.view.webview.postMessage({ type: 'snapshot', data: snapshot });
    }
  }

  private refreshVisibleView(): Promise<void> {
    if (!this.view?.visible) {
      return Promise.resolve();
    }
    this.postSnapshot(this.stockProvider.getSnapshot());
    this.stopSectorTimer();
    if (this.visibleRefreshPromise) {
      return this.visibleRefreshPromise;
    }
    const request = Promise.all([
      this.stockProvider.refresh(false),
      this.refreshSectors(true)
    ])
      .then(() => undefined)
      .finally(() => {
        if (this.visibleRefreshPromise === request) {
          this.visibleRefreshPromise = undefined;
        }
        this.scheduleSectorRefresh();
      });
    this.visibleRefreshPromise = request;
    return request;
  }

  private scheduleSectorRefresh(): void {
    this.stopSectorTimer();
    if (!this.view?.visible) {
      return;
    }
    this.sectorTimer = setTimeout(() => {
      this.sectorTimer = undefined;
      if (!this.view?.visible) {
        return;
      }
      const market = getChinaMarketState();
      const requestOutsideTradingHours = vscode.workspace
        .getConfiguration('aShareLeek')
        .get<boolean>('requestOutsideTradingHours', false);
      const refresh = market.isTradingTime || requestOutsideTradingHours
        ? this.refreshSectors(true)
        : Promise.resolve();
      void refresh.finally(() => this.scheduleSectorRefresh());
    }, 10_000);
  }

  private stopSectorTimer(): void {
    if (this.sectorTimer) {
      clearTimeout(this.sectorTimer);
      this.sectorTimer = undefined;
    }
  }

  public refreshSectors(force = false): Promise<void> {
    if (!this.view?.visible) {
      return Promise.resolve();
    }
    if (
      !force &&
      this.sectorUpdatedAt > 0 &&
      Date.now() - this.sectorUpdatedAt < 10_000
    ) {
      this.postSectors();
      return Promise.resolve();
    }
    if (this.sectorRefreshPromise) {
      return this.sectorRefreshPromise;
    }
    const request = Promise.all([
      this.dataService.getTopSectorBoards('industry', 20, force),
      this.dataService.getTopSectorBoards('concept', 20, force)
    ])
      .then(([industry, concept]) => {
        this.sectorBoards.industry = this.topBoards(industry);
        this.sectorBoards.concept = this.topBoards(concept);
        this.sectorUpdatedAt = Date.now();
        this.postSectors();
      })
      .catch((error) => {
        console.warn(
          '[A股韭菜盒子] 侧栏板块排行刷新失败：',
          error instanceof Error ? error.message : String(error)
        );
        this.postSectors();
      })
      .finally(() => {
        if (this.sectorRefreshPromise === request) {
          this.sectorRefreshPromise = undefined;
        }
      });
    this.sectorRefreshPromise = request;
    return request;
  }

  private topBoards(boards: SectorBoard[]): SectorBoard[] {
    return [...boards]
      .sort((left, right) => right.percent - left.percent)
      .slice(0, 20);
  }

  private postSectors(): void {
    if (this.view?.visible) {
      void this.view.webview.postMessage({
        type: 'sectors',
        data: this.sectorBoards,
        updatedAt: this.sectorUpdatedAt
      });
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'sidebar.css')
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'sidebar.js')
    );
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style nonce="${nonce}">
    html, body { margin: 0; min-height: 100%; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); }
    body.booting > * { visibility: hidden; }
  </style>
  <link rel="stylesheet" href="${cssUri}" />
  <title>A股行情</title>
</head>
<body class="booting">
  <main id="sidebar" aria-label="A股行情列表">
    <section class="quote-group" data-group="holding">
      <button class="group-header" type="button" data-toggle-group="holding" aria-expanded="true">
        <span class="group-arrow" aria-hidden="true"></span><span class="group-title">我的持仓</span><span class="group-summary flat" data-holding-summary></span>
      </button>
      <div class="group-rows" data-group-rows="holding"></div>
    </section>
    <section class="quote-group stock-root" data-group="stocks">
      <div class="group-heading">
        <button class="group-header" type="button" data-toggle-group="stocks" aria-expanded="true">
          <span class="group-arrow" aria-hidden="true"></span><span class="group-title">A股</span>
        </button>
        <button class="group-add" type="button" data-create-watch-group title="新建自选分组" aria-label="新建自选分组">+</button>
      </div>
      <div class="group-rows stock-group-body" data-group-rows="stocks">
        <section class="quote-group nested-watch-group" data-group="stock" data-watch-group-id="">
          <button class="group-header" type="button" data-toggle-group="stock" data-watch-drop-target data-watch-group-id="" aria-expanded="true">
            <span class="group-arrow" aria-hidden="true"></span><span class="group-title">自选股</span>
          </button>
          <div class="group-rows" data-group-rows="stock" data-watch-drop-target data-watch-group-id=""></div>
        </section>
      </div>
    </section>
    <section class="quote-group" data-group="index">
      <button class="group-header" type="button" data-toggle-group="index" aria-expanded="false">
        <span class="group-arrow" aria-hidden="true"></span><span class="group-title">指数</span>
      </button>
      <div class="group-rows" data-group-rows="index"></div>
    </section>
    <section class="quote-group" data-group="industry">
      <button class="group-header" type="button" data-toggle-group="industry" aria-expanded="true">
        <span class="group-arrow" aria-hidden="true"></span><span class="group-title">行业板块</span>
      </button>
      <div class="group-rows" data-group-rows="industry"></div>
    </section>
    <section class="quote-group" data-group="concept">
      <button class="group-header" type="button" data-toggle-group="concept" aria-expanded="true">
        <span class="group-arrow" aria-hidden="true"></span><span class="group-title">概念板块</span>
      </button>
      <div class="group-rows" data-group-rows="concept"></div>
    </section>
  </main>
  <aside id="quoteTooltip" class="quote-tooltip hidden" role="tooltip" aria-live="polite">
    <div class="tooltip-title"><strong id="tooltipName">--</strong><span id="tooltipCode">--</span></div>
    <div class="tooltip-primary"><span>现价 <b id="tooltipPrice">--</b></span><span>涨跌 <b id="tooltipPercent">--</b></span></div>
    <div class="tooltip-grid">
      <span>今开 <b id="tooltipOpen">--</b></span><span>最高 <b id="tooltipHigh">--</b></span>
      <span>最低 <b id="tooltipLow">--</b></span><span>昨收 <b id="tooltipPrevious">--</b></span>
      <span>量比 <b id="tooltipVolumeRatio">--</b></span><span>换手率 <b id="tooltipTurnover">--</b></span>
      <span>成交量 <b id="tooltipVolume">--</b></span><span>成交额 <b id="tooltipAmount">--</b></span>
    </div>
    <div id="tooltipHint" class="tooltip-hint"></div>
  </aside>
  <div id="rowContextMenu" class="row-context-menu hidden" role="menu" aria-label="股票操作">
    <button type="button" role="menuitem" data-context-action="holding">设置持仓</button>
    <button type="button" role="menuitem" data-context-action="move-group">移入分组…</button>
    <button type="button" role="menuitem" data-context-action="remove">从侧栏移除</button>
  </div>
  <div id="watchGroupContextMenu" class="row-context-menu hidden" role="menu" aria-label="自选分组操作">
    <button type="button" role="menuitem" data-group-context-action="rename">重命名分组</button>
    <button type="button" role="menuitem" data-group-context-action="delete">删除分组</button>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
