import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { DataService } from './dataService';
import { getChinaMarketState } from './marketHours';
import { StockProvider } from './providers';
import {
  AppSnapshot,
  CommunityCommentCursor,
  CommunityCursor,
  CommunityPost,
  CommunityPostSort,
  SectorBoard,
  SectorBoardKind,
  SectorBoardSort,
  isAIndexCode,
  isAShareCode
} from './types';

type SidebarItemKind = 'holding' | 'stock' | 'index';

export class SidebarViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private readonly snapshotSubscription: vscode.Disposable;
  private readonly sectorBoards: Record<SectorBoardKind, SectorBoard[]> = {
    industry: [],
    concept: []
  };
  private readonly sectorSortModes: Record<SectorBoardKind, SectorBoardSort> = {
    industry: 'percent',
    concept: 'percent'
  };
  private sectorUpdatedAt = 0;
  private readonly displayedSectorSortModes = { ...this.sectorSortModes };
  private readonly sectorRefreshPromises = new Map<string, Promise<void>>();
  private visibleRefreshPromise: Promise<void> | undefined;
  private sectorTimer: NodeJS.Timeout | undefined;
  private sidebarMode: 'quotes' | 'community' | 'community-detail' = 'quotes';
  private communityCode = '';
  private communityName = '';
  private communitySort: CommunityPostSort = 'hot';
  private communityCursor: CommunityCursor | undefined;
  private communityLoading = false;
  private communityGeneration = 0;
  private readonly communityPosts = new Map<string, CommunityPost>();
  private communityDetailPost: CommunityPost | undefined;
  private communityCommentCursor: CommunityCommentCursor | undefined;
  private communityDetailLoading = false;
  private communityCommentsLoading = false;
  private readonly communityRepliesLoading = new Set<string>();

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
    this.communityGeneration += 1;
    this.view = undefined;
    this.snapshotSubscription.dispose();
  }

  public isVisible(): boolean {
    return this.view?.visible === true && this.sidebarMode === 'quotes';
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
        this.sidebarMode = 'quotes';
        this.communityGeneration += 1;
        this.communityLoading = false;
        this.communityCode = '';
        this.communityCursor = undefined;
        this.communityPosts.clear();
        this.communityDetailPost = undefined;
        this.communityCommentCursor = undefined;
        this.communityRepliesLoading.clear();
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
          sort?: unknown;
          postId?: unknown;
          rootId?: unknown;
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
      const sectorCode = String(payload.code || '').toUpperCase();
      const board = this.sectorBoards[kind].find((item) => item.code === sectorCode);
      await vscode.commands.executeCommand('aShareLeek.openSector', {
        code: sectorCode,
        kind,
        board
      });
      return;
    }
    if (payload?.type === 'toggleSectorSort') {
      const kind: SectorBoardKind = payload.kind === 'concept' ? 'concept' : 'industry';
      this.sectorSortModes[kind] =
        this.sectorSortModes[kind] === 'heat' ? 'percent' : 'heat';
      await this.refreshSectorKind(kind, true);
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
    if (payload?.type === 'closeCommunity') {
      this.sidebarMode = 'quotes';
      this.communityGeneration += 1;
      this.communityLoading = false;
      this.communityCode = '';
      this.communityCursor = undefined;
      this.communityPosts.clear();
      this.communityDetailPost = undefined;
      this.communityCommentCursor = undefined;
      this.communityRepliesLoading.clear();
      await this.refreshVisibleView();
      return;
    }
    if (payload?.type === 'openCommunityPost') {
      const post = this.communityPosts.get(String(payload.postId || ''));
      if (post) {
        this.sidebarMode = 'community-detail';
        this.stopSectorTimer();
        await this.loadCommunityDetail(post);
      }
      return;
    }
    if (payload?.type === 'closeCommunityDetail') {
      this.sidebarMode = 'community';
      this.communityGeneration += 1;
      this.communityDetailLoading = false;
      this.communityCommentsLoading = false;
      this.communityRepliesLoading.clear();
      void this.view?.webview.postMessage({ type: 'communityDetailClosed' });
      return;
    }
    if (payload?.type === 'openCommunityPostExternal') {
      const post = this.communityDetailPost;
      if (post?.url) {
        await vscode.env.openExternal(vscode.Uri.parse(post.url));
      }
      return;
    }
    if (payload?.type === 'refreshCommunityDetail') {
      if (this.communityDetailPost) {
        await this.loadCommunityDetail(this.communityDetailPost);
      }
      return;
    }
    if (payload?.type === 'loadMoreCommunityComments') {
      await this.loadMoreCommunityComments();
      return;
    }
    if (payload?.type === 'loadCommunityReplies') {
      await this.loadCommunityReplies(String(payload.rootId || ''));
      return;
    }
    if (payload?.type === 'loadMoreCommunity') {
      await this.loadCommunityPage(false);
      return;
    }
    if (payload?.type === 'refreshCommunity') {
      this.communityCursor = undefined;
      this.communityPosts.clear();
      await this.loadCommunityPage(true);
      return;
    }
    if (!isAShareCode(code)) {
      return;
    }
    if (payload?.type === 'openCommunity' && !isAIndexCode(code)) {
      const quote = this.stockProvider.getSnapshot().quotes.find((item) => item.code === code);
      this.sidebarMode = 'community';
      this.communityCode = code;
      this.communityName = quote?.name || code;
      this.communitySort = 'hot';
      this.communityCursor = undefined;
      this.communityPosts.clear();
      this.communityDetailPost = undefined;
      this.communityCommentCursor = undefined;
      this.stopSectorTimer();
      await this.loadCommunityPage(true);
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

  private async loadCommunityPage(replace: boolean): Promise<void> {
    if (
      this.sidebarMode !== 'community' ||
      !this.view?.visible ||
      !isAShareCode(this.communityCode) ||
      (!replace && (this.communityLoading || !this.communityCursor))
    ) {
      return;
    }
    const generation = ++this.communityGeneration;
    this.communityLoading = true;
    void this.view.webview.postMessage({
      type: 'communityState',
      code: this.communityCode,
      name: this.communityName,
      sort: this.communitySort,
      posts: [],
      append: !replace,
      loading: true,
      hasMore: replace || Boolean(this.communityCursor),
      warning: '',
      error: ''
    });
    try {
      const page = await this.dataService.getCommunityPosts(
        this.communityCode,
        this.communitySort,
        20,
        replace ? undefined : this.communityCursor
      );
      if (
        generation !== this.communityGeneration ||
        this.sidebarMode !== 'community' ||
        !this.view?.visible
      ) {
        return;
      }
      this.communityCursor = page.cursor || undefined;
      for (const post of page.posts) {
        this.communityPosts.set(post.id, post);
      }
      void this.view.webview.postMessage({
        type: 'communityState',
        code: this.communityCode,
        name: this.communityName,
        sort: this.communitySort,
        posts: page.posts,
        append: !replace,
        loading: false,
        hasMore: page.hasMore,
        warning: page.warning,
        error: ''
      });
    } catch (error) {
      if (
        generation === this.communityGeneration &&
        this.sidebarMode === 'community' &&
        this.view?.visible
      ) {
        void this.view.webview.postMessage({
          type: 'communityState',
          code: this.communityCode,
          name: this.communityName,
          sort: this.communitySort,
          posts: [],
          append: !replace,
          loading: false,
          hasMore: Boolean(this.communityCursor),
          warning: '',
          error: error instanceof Error ? error.message : '同花顺社区加载失败'
        });
      }
    } finally {
      if (generation === this.communityGeneration) {
        this.communityLoading = false;
      }
    }
  }

  private async loadCommunityDetail(post: CommunityPost): Promise<void> {
    if (!this.view?.visible || this.sidebarMode !== 'community-detail') {
      return;
    }
    const generation = ++this.communityGeneration;
    this.communityDetailLoading = true;
    this.communityCommentsLoading = false;
    this.communityCommentCursor = undefined;
    this.communityRepliesLoading.clear();
    this.communityDetailPost = post;
    void this.view.webview.postMessage({
      type: 'communityDetailState',
      post,
      comments: [],
      append: false,
      loading: true,
      commentsLoading: false,
      commentsHaveMore: false,
      commentTotal: post.commentCount,
      ipLocation: '',
      error: ''
    });
    try {
      const detail = await this.dataService.getCommunityPostDetail(post);
      if (
        generation !== this.communityGeneration ||
        this.sidebarMode !== 'community-detail' ||
        !this.view?.visible
      ) {
        return;
      }
      this.communityDetailPost = detail.post;
      this.communityPosts.set(detail.post.id, detail.post);
      this.communityCommentCursor = detail.commentCursor || undefined;
      void this.view.webview.postMessage({
        type: 'communityDetailState',
        post: detail.post,
        comments: detail.comments,
        append: false,
        loading: false,
        commentsLoading: false,
        commentsHaveMore: detail.commentsHaveMore,
        commentTotal: detail.commentTotal,
        ipLocation: detail.ipLocation,
        error: ''
      });
    } catch (error) {
      if (
        generation === this.communityGeneration &&
        this.sidebarMode === 'community-detail' &&
        this.view?.visible
      ) {
        void this.view.webview.postMessage({
          type: 'communityDetailState',
          post,
          comments: [],
          append: false,
          loading: false,
          commentsLoading: false,
          commentsHaveMore: false,
          commentTotal: post.commentCount,
          ipLocation: '',
          error: error instanceof Error ? error.message : '同花顺帖子详情加载失败'
        });
      }
    } finally {
      if (generation === this.communityGeneration) {
        this.communityDetailLoading = false;
      }
    }
  }

  private async loadMoreCommunityComments(): Promise<void> {
    const post = this.communityDetailPost;
    if (
      !this.view?.visible ||
      this.sidebarMode !== 'community-detail' ||
      !post ||
      !this.communityCommentCursor ||
      this.communityDetailLoading ||
      this.communityCommentsLoading
    ) {
      return;
    }
    const generation = this.communityGeneration;
    this.communityCommentsLoading = true;
    void this.view.webview.postMessage({
      type: 'communityCommentsLoading',
      loading: true
    });
    try {
      const page = await this.dataService.getCommunityComments(
        post.id,
        post.contentId,
        this.communityCommentCursor
      );
      if (
        generation !== this.communityGeneration ||
        this.sidebarMode !== 'community-detail' ||
        !this.view?.visible
      ) {
        return;
      }
      this.communityCommentCursor = page.cursor || undefined;
      void this.view.webview.postMessage({
        type: 'communityDetailState',
        post,
        comments: page.comments,
        append: true,
        loading: false,
        commentsLoading: false,
        commentsHaveMore: page.hasMore,
        commentTotal: Math.max(page.total, post.commentCount),
        error: ''
      });
    } catch (error) {
      if (generation === this.communityGeneration && this.view?.visible) {
        void this.view.webview.postMessage({
          type: 'communityCommentsError',
          error: error instanceof Error ? error.message : '同花顺评论加载失败'
        });
      }
    } finally {
      if (generation === this.communityGeneration) {
        this.communityCommentsLoading = false;
      }
    }
  }

  private async loadCommunityReplies(rootId: string): Promise<void> {
    const post = this.communityDetailPost;
    if (
      !this.view?.visible ||
      this.sidebarMode !== 'community-detail' ||
      !post ||
      !/^\d+$/.test(rootId) ||
      this.communityRepliesLoading.has(rootId)
    ) {
      return;
    }
    const generation = this.communityGeneration;
    this.communityRepliesLoading.add(rootId);
    void this.view.webview.postMessage({ type: 'communityRepliesLoading', rootId });
    try {
      const replies = await this.dataService.getCommunityCommentReplies(
        post.id,
        post.contentId,
        rootId
      );
      if (
        generation === this.communityGeneration &&
        this.sidebarMode === 'community-detail' &&
        this.view?.visible
      ) {
        void this.view.webview.postMessage({
          type: 'communityReplies',
          rootId,
          replies,
          error: ''
        });
      }
    } catch (error) {
      if (generation === this.communityGeneration && this.view?.visible) {
        void this.view.webview.postMessage({
          type: 'communityReplies',
          rootId,
          replies: [],
          error: error instanceof Error ? error.message : '同花顺回复加载失败'
        });
      }
    } finally {
      this.communityRepliesLoading.delete(rootId);
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
    if (this.sidebarMode !== 'quotes') {
      this.stopSectorTimer();
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
    if (!this.view?.visible || this.sidebarMode !== 'quotes') {
      return;
    }
    this.sectorTimer = setTimeout(() => {
      this.sectorTimer = undefined;
      if (!this.view?.visible || this.sidebarMode !== 'quotes') {
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
    if (!this.view?.visible || this.sidebarMode !== 'quotes') {
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
    return Promise.all([
      this.refreshSectorKind('industry', force),
      this.refreshSectorKind('concept', force)
    ]).then(() => undefined);
  }

  private refreshSectorKind(kind: SectorBoardKind, force: boolean): Promise<void> {
    const sort = this.sectorSortModes[kind];
    const requestKey = kind + ':' + sort;
    const active = this.sectorRefreshPromises.get(requestKey);
    if (active) {
      return active;
    }
    const request = this.dataService
      .getTopSectorBoards(kind, 20, force, sort)
      .then((boards) => {
        if (this.sectorSortModes[kind] !== sort) {
          return;
        }
        this.sectorBoards[kind] = boards.slice(0, 20);
        this.displayedSectorSortModes[kind] = sort;
        this.sectorUpdatedAt = Date.now();
        this.postSectors();
      })
      .catch((error) => {
        if (this.sectorSortModes[kind] === sort) {
          this.sectorSortModes[kind] = this.displayedSectorSortModes[kind];
        }
        console.warn(
          '[A股韭菜盒子] 侧栏' + (kind === 'industry' ? '行业' : '概念') +
            (sort === 'heat' ? '热度' : '涨幅') +
            '排行刷新失败：',
          error instanceof Error ? error.message : String(error)
        );
        this.postSectors();
      })
      .finally(() => {
        if (this.sectorRefreshPromises.get(requestKey) === request) {
          this.sectorRefreshPromises.delete(requestKey);
        }
      });
    this.sectorRefreshPromises.set(requestKey, request);
    return request;
  }

  private postSectors(): void {
    if (this.view?.visible && this.sidebarMode === 'quotes') {
      void this.view.webview.postMessage({
        type: 'sectors',
        data: this.sectorBoards,
        sortModes: this.displayedSectorSortModes,
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
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https://*.thsi.cn https://*.10jqka.com.cn data:; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
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
      <div class="group-heading sector-group-heading">
        <button class="group-header" type="button" data-toggle-group="industry" aria-expanded="true">
          <span class="group-arrow" aria-hidden="true"></span><span class="group-title">行业板块</span>
        </button>
        <button class="sector-sort-toggle" type="button" data-sector-sort-toggle="industry" title="切换为热度排序" aria-label="行业板块切换为热度排序" aria-pressed="false">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v10m0 0-2-2m2 2 2-2M12 13.5v-10m0 0-2 2m2-2 2 2" /></svg>
        </button>
      </div>
      <div class="group-rows" data-group-rows="industry"></div>
    </section>
    <section class="quote-group" data-group="concept">
      <div class="group-heading sector-group-heading">
        <button class="group-header" type="button" data-toggle-group="concept" aria-expanded="true">
          <span class="group-arrow" aria-hidden="true"></span><span class="group-title">概念板块</span>
        </button>
        <button class="sector-sort-toggle" type="button" data-sector-sort-toggle="concept" title="切换为热度排序" aria-label="概念板块切换为热度排序" aria-pressed="false">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v10m0 0-2-2m2 2 2-2M12 13.5v-10m0 0-2 2m2-2 2 2" /></svg>
        </button>
      </div>
      <div class="group-rows" data-group-rows="concept"></div>
    </section>
  </main>
  <section id="communityPage" class="community-page hidden" aria-label="同花顺社区">
    <header class="community-toolbar">
      <button id="communityBack" class="community-icon-button" type="button" title="返回行情" aria-label="返回行情">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.75 3.25 5 8l4.75 4.75M5.4 8H13" /></svg>
      </button>
      <div class="community-heading">
        <strong id="communityName">同花顺社区</strong>
        <span id="communityCode"></span>
      </div>
      <div class="community-actions">
        <span>热门</span>
        <button id="communityRefresh" class="community-icon-button" type="button" title="刷新社区" aria-label="刷新社区">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M12.5 5.5V2.75m0 0H9.75m2.75 0A5.5 5.5 0 1 0 13.2 9" /></svg>
        </button>
      </div>
    </header>
    <div id="communityNotice" class="community-notice hidden" role="status"></div>
    <div id="communityFeed" class="community-feed" aria-live="polite"></div>
    <div id="communityStatus" class="community-status" role="status"></div>
    <div id="communitySentinel" class="community-sentinel" aria-hidden="true"></div>
  </section>
  <section id="communityDetailPage" class="community-page community-detail-page hidden" aria-label="社区动态详情">
    <header class="community-toolbar">
      <button id="communityDetailBack" class="community-icon-button" type="button" title="返回社区" aria-label="返回社区">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.75 3.25 5 8l4.75 4.75M5.4 8H13" /></svg>
      </button>
      <div class="community-heading">
        <strong>动态详情</strong>
        <span id="communityDetailStock"></span>
      </div>
      <div class="community-actions">
        <button id="communityDetailExternal" class="community-icon-button" type="button" title="在同花顺打开" aria-label="在同花顺打开">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 3h4v4M8 8l5-5M12 9.5V13H3V4h3.5" /></svg>
        </button>
        <button id="communityDetailRefresh" class="community-icon-button" type="button" title="刷新动态与评论" aria-label="刷新动态与评论">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M12.5 5.5V2.75m0 0H9.75m2.75 0A5.5 5.5 0 1 0 13.2 9" /></svg>
        </button>
      </div>
    </header>
    <article id="communityDetailArticle" class="community-detail-article">
      <div class="community-detail-author">
        <div id="communityDetailAvatar" class="community-avatar"></div>
        <div class="community-author"><strong id="communityDetailAuthor">同花顺用户</strong><span id="communityDetailMeta"></span></div>
      </div>
      <h2 id="communityDetailTitle" class="hidden"></h2>
      <p id="communityDetailContent" class="community-detail-content"></p>
      <div id="communityDetailImages" class="community-detail-images"></div>
      <div id="communityDetailTags" class="community-tags"></div>
      <div id="communityDetailStats" class="community-stats"></div>
    </article>
    <div class="community-comments-heading"><strong>评论</strong><span id="communityCommentTotal">0</span></div>
    <div id="communityComments" class="community-comments" aria-live="polite"></div>
    <div id="communityCommentsStatus" class="community-status" role="status"></div>
    <div id="communityCommentsSentinel" class="community-sentinel" aria-hidden="true"></div>
  </section>
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
    <button type="button" role="menuitem" data-context-action="community">查看同花顺社区</button>
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
