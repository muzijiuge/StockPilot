import * as vscode from 'vscode';
import { DataService } from './dataService';
import { resolveQuoteForDisplay } from './quoteSnapshot';
import { StateStore } from './stateStore';
import {
  AppSnapshot,
  CenterTab,
  DEFAULT_NAMES,
  INDEX_CODES,
  Quote
} from './types';

type GroupKind = 'holdingGroup' | 'stockGroup' | 'indexGroup';

const QUOTE_SNAPSHOT_PERSIST_INTERVAL = 60_000;

class GroupNode extends vscode.TreeItem {
  public constructor(
    public readonly kind: GroupKind,
    label: string,
    public readonly codes: string[],
    expanded: boolean
  ) {
    super(
      label,
      expanded
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed
    );
    this.contextValue = 'category';
  }
}

export class StockNode extends vscode.TreeItem {
  public constructor(
    public readonly code: string,
    public readonly quote: Quote | undefined,
    public readonly kind: 'stock' | 'holding' | 'index'
  ) {
    const name = quote?.name || DEFAULT_NAMES[code] || code;
    const percent = quote ? signed(quote.percent, 2, '%') : '--';
    const price = quote && quote.price > 0 ? formatPrice(quote.price) : '--';
    super(percent.padStart(8) + '   ' + price.padStart(9) + '   「' + name + '」');
    this.contextValue = kind;
    this.command = {
      command: 'aShareLeek.openStock',
      title: '查看 K 线',
      arguments: [code]
    };
    if (quote) {
      const isRise = quote.percent >= 0;
      this.iconPath = new vscode.ThemeIcon(
        isRise ? 'chevron-up' : 'chevron-down',
        new vscode.ThemeColor(isRise ? 'charts.red' : 'charts.green')
      );
      this.tooltip = buildTooltip(quote, kind);
      this.description = quote.updatedAt
        ? new Date(quote.updatedAt).toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit'
          })
        : undefined;
    } else {
      this.iconPath = new vscode.ThemeIcon('dash', new vscode.ThemeColor('descriptionForeground'));
      this.tooltip = name + '（等待行情）';
    }
  }
}

function signed(value: number, digits: number, suffix = ''): string {
  const prefix = value > 0 ? '+' : '';
  return prefix + value.toFixed(digits) + suffix;
}

function formatPrice(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '--';
  }
  if (value >= 10000) {
    return value.toFixed(1);
  }
  if (value >= 100) {
    return value.toFixed(2);
  }
  return value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function formatLarge(value: number): string {
  if (Math.abs(value) >= 100000000) {
    return (value / 100000000).toFixed(2) + '亿';
  }
  if (Math.abs(value) >= 10000) {
    return (value / 10000).toFixed(2) + '万';
  }
  return value.toFixed(0);
}

function buildTooltip(quote: Quote, kind: string): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString(undefined, true);
  tooltip.appendMarkdown('### ' + quote.name + '  ' + quote.code + '\n\n');
  tooltip.appendMarkdown(
    '**现价** ' +
      formatPrice(quote.price) +
      '　**涨跌** ' +
      signed(quote.percent, 2, '%') +
      '\n\n'
  );
  tooltip.appendMarkdown(
    '今开 ' +
      formatPrice(quote.open) +
      '　最高 ' +
      formatPrice(quote.high) +
      '　最低 ' +
      formatPrice(quote.low) +
      '\n\n'
  );
  tooltip.appendMarkdown(
    '昨收 ' +
      formatPrice(quote.previousClose) +
      '　成交量 ' +
      formatLarge(quote.volume) +
      '　成交额 ' +
      formatLarge(quote.amount) +
      '\n\n'
  );
  tooltip.appendMarkdown(kind === 'holding' ? '已加入本地持仓账本' : '点击打开暗色 K 线详情');
  tooltip.isTrusted = false;
  return tooltip;
}

export class StockProvider implements vscode.TreeDataProvider<GroupNode | StockNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<GroupNode | StockNode | undefined | null>();
  private readonly snapshotEmitter = new vscode.EventEmitter<AppSnapshot>();
  private readonly quoteMap = new Map<string, Quote>();
  private sortMode = 0;
  private refreshedAt = 0;
  private refreshPromise: Promise<AppSnapshot> | undefined;
  private refreshCodesKey = '';
  private lastQuoteSnapshotSavedAt = 0;
  private lastQuoteSnapshotCodesKey = '';

  public readonly onDidChangeTreeData = this.changeEmitter.event;
  public readonly onDidUpdateSnapshot = this.snapshotEmitter.event;

  public constructor(
    private readonly stateStore: StateStore,
    private readonly dataService: DataService
  ) {
    const storedQuotes = this.stateStore.getQuoteSnapshot();
    for (const quote of storedQuotes) {
      this.quoteMap.set(quote.code, quote);
      this.refreshedAt = Math.max(this.refreshedAt, quote.updatedAt);
    }
  }

  public dispose(): void {
    this.persistQuoteSnapshot(true);
    this.changeEmitter.dispose();
    this.snapshotEmitter.dispose();
  }

  public getTreeItem(element: GroupNode | StockNode): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: GroupNode | StockNode): Array<GroupNode | StockNode> {
    if (element instanceof StockNode) {
      return [];
    }
    if (element instanceof GroupNode) {
      return this.sortCodes(element.codes).map(
        (code) =>
          new StockNode(
            code,
            this.quoteMap.get(code),
            element.kind === 'holdingGroup'
              ? 'holding'
              : element.kind === 'indexGroup'
                ? 'index'
                : 'stock'
          )
      );
    }

    const holdingCodes = this.stateStore.getHoldings().map((item) => item.code);
    const holdingSet = new Set(holdingCodes);
    const watchlist = this.stateStore.getWatchlist();
    const stockCodes = watchlist.filter(
      (code) => !holdingSet.has(code) && !INDEX_CODES.has(code)
    );
    const indexCodes = watchlist.filter((code) => INDEX_CODES.has(code));

    return [
      new GroupNode(
        'holdingGroup',
        '我的持仓 (' + holdingCodes.length + ')',
        holdingCodes,
        true
      ),
      new GroupNode('stockGroup', 'A股 (' + stockCodes.length + ')', stockCodes, true),
      new GroupNode('indexGroup', '指数 (' + indexCodes.length + ')', indexCodes, false)
    ];
  }

  private sortCodes(codes: string[]): string[] {
    if (this.sortMode === 0) {
      return [...codes];
    }
    return [...codes].sort((a, b) => {
      const left = this.quoteMap.get(a)?.percent ?? -Infinity;
      const right = this.quoteMap.get(b)?.percent ?? -Infinity;
      return this.sortMode === 1 ? left - right : right - left;
    });
  }

  public cycleSort(): string {
    this.sortMode = (this.sortMode + 1) % 3;
    this.changeEmitter.fire(undefined);
    return ['默认顺序', '涨跌幅升序', '涨跌幅降序'][this.sortMode];
  }

  public refresh(showError = true): Promise<AppSnapshot> {
    const codes = Array.from(
      new Set([
        ...this.stateStore.getWatchlist(),
        ...this.stateStore.getHoldings().map((item) => item.code)
      ])
    );
    const codesKey = codes.slice().sort().join(',');
    if (this.refreshPromise) {
      if (this.refreshCodesKey === codesKey) {
        return this.refreshPromise;
      }
      return this.refreshPromise.then(() => this.refresh(showError));
    }

    this.refreshCodesKey = codesKey;
    const refresh = this.performRefresh(codes, showError);
    this.refreshPromise = refresh;
    void refresh.finally(() => {
      if (this.refreshPromise === refresh) {
        this.refreshPromise = undefined;
        this.refreshCodesKey = '';
      }
    });
    return refresh;
  }

  private async performRefresh(codes: string[], showError: boolean): Promise<AppSnapshot> {
    try {
      const quotes = await this.dataService.getQuotes(codes);
      for (const quote of quotes) {
        const resolved = resolveQuoteForDisplay(quote, this.quoteMap.get(quote.code));
        if (resolved) {
          this.quoteMap.set(quote.code, resolved);
        }
      }
      const activeCodes = new Set(codes);
      for (const code of this.quoteMap.keys()) {
        if (!activeCodes.has(code)) {
          this.quoteMap.delete(code);
        }
      }
      this.refreshedAt = Date.now();
      this.persistQuoteSnapshot();
    } catch (error) {
      if (showError) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showWarningMessage('A 股行情刷新失败：' + message);
      }
    }
    const snapshot = this.getSnapshot();
    this.changeEmitter.fire(undefined);
    this.snapshotEmitter.fire(snapshot);
    return snapshot;
  }

  private persistQuoteSnapshot(force = false): void {
    const activeCodes = new Set([
      ...this.stateStore.getWatchlist(),
      ...this.stateStore.getHoldings().map((item) => item.code)
    ]);
    const quotes = Array.from(this.quoteMap.values()).filter(
      (quote) => activeCodes.has(quote.code) && quote.price > 0
    );
    const codesKey = quotes
      .map((quote) => quote.code)
      .sort()
      .join(',');
    const now = Date.now();
    if (
      !force &&
      codesKey === this.lastQuoteSnapshotCodesKey &&
      now - this.lastQuoteSnapshotSavedAt < QUOTE_SNAPSHOT_PERSIST_INTERVAL
    ) {
      return;
    }

    this.lastQuoteSnapshotSavedAt = now;
    this.lastQuoteSnapshotCodesKey = codesKey;
    void this.stateStore.saveQuoteSnapshot(quotes).catch((error) => {
      this.lastQuoteSnapshotSavedAt = 0;
      console.warn(
        '[A股韭菜盒子] 最近有效报价保存失败：',
        error instanceof Error ? error.message : String(error)
      );
    });
  }

  public getSnapshot(): AppSnapshot {
    const watchlist = this.stateStore.getWatchlist();
    const holdings = this.stateStore.getHoldings();
    const activeCodes = new Set([
      ...watchlist,
      ...holdings.map((item) => item.code)
    ]);
    return {
      watchlist,
      holdings,
      quotes: Array.from(this.quoteMap.values()).filter((quote) => activeCodes.has(quote.code)),
      updatedAt: this.refreshedAt
    };
  }

  public getQuote(code: string): Quote | undefined {
    return this.quoteMap.get(code);
  }
}

class HomeNode extends vscode.TreeItem {
  public constructor(label: string, description: string, icon: string, tab: CenterTab) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(icon);
    this.command = {
      command:
        tab === 'watch'
          ? 'aShareLeek.openCenter'
          : tab === 'assets'
            ? 'aShareLeek.openAssets'
            : tab === 'news'
              ? 'aShareLeek.openNews'
              : tab === 'cloud'
                ? 'aShareLeek.openCloud'
                : 'aShareLeek.openSector',
      title: label
    };
  }
}

export class HomeProvider implements vscode.TreeDataProvider<HomeNode> {
  public getTreeItem(element: HomeNode): vscode.TreeItem {
    return element;
  }

  public getChildren(): HomeNode[] {
    return [
      new HomeNode('韭菜中心', '自选与公司资料', 'star-empty', 'watch'),
      new HomeNode('资产', '本地持仓账本', 'briefcase', 'assets'),
      new HomeNode('资讯', '7×24 市场快讯', 'book', 'news'),
      new HomeNode('大盘云图', 'A 股行业热力', 'map', 'cloud'),
      new HomeNode('板块行情', '行业与概念板块', 'table', 'sector')
    ];
  }
}
