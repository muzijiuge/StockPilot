import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { EastmoneyProxyServer } from './eastmoneyProxyServer';
import { ChinaMarketState } from './marketHours';
import { isAShareCode } from './types';

export interface StockTrendRefreshState {
  interval: number;
  allowed: boolean;
  market: ChinaMarketState;
}

function normalizeAShareCode(code: unknown): string {
  const normalized = String(code || '').trim().toLowerCase();
  if (!isAShareCode(normalized)) {
    throw new Error('无效的 A 股代码：' + String(code || ''));
  }
  return normalized;
}

function loopbackOrigin(rawUrl: string, expectedPort: number): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('行情代理返回了无效地址');
  }

  const hostname = parsed.hostname.toLowerCase();
  const isLoopback =
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]';
  const port = Number(parsed.port || (parsed.protocol === 'http:' ? 80 : 443));
  if (parsed.protocol !== 'http:' || !isLoopback || port !== expectedPort) {
    throw new Error('行情代理地址必须是当前本机回环 HTTP 服务');
  }
  return parsed.origin;
}

function scriptLiteral(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export class StockTrendPanel {
  private static current: StockTrendPanel | undefined;
  private static creating: Promise<StockTrendPanel> | undefined;
  private static activeProxy: EastmoneyProxyServer | undefined;
  private static marketRequestsAllowed = true;
  private static latestRequestedCode: string | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private navigationId = 0;
  private webviewReady = false;
  private pendingNavigationUrl: string | undefined;

  public static async createOrShow(
    context: vscode.ExtensionContext,
    proxy: EastmoneyProxyServer,
    code: string
  ): Promise<StockTrendPanel> {
    const normalized = normalizeAShareCode(code);
    StockTrendPanel.latestRequestedCode = normalized;

    if (StockTrendPanel.current) {
      StockTrendPanel.current.panel.reveal(vscode.ViewColumn.One);
      if (StockTrendPanel.current.currentCode !== normalized) {
        await StockTrendPanel.current.navigate(normalized);
      }
      return StockTrendPanel.current;
    }

    if (StockTrendPanel.creating) {
      const current = await StockTrendPanel.creating;
      current.panel.reveal(vscode.ViewColumn.One);
      if (current.currentCode !== normalized) {
        await current.navigate(normalized);
      }
      return current;
    }

    const creation = (async (): Promise<StockTrendPanel> => {
      const port = await proxy.ensureStarted();
      proxy.setMarketRequestsAllowed(StockTrendPanel.marketRequestsAllowed);
      // If several rows are clicked while the loopback listener is starting,
      // render only the most recent one instead of loading stale pages first.
      const initialCode = StockTrendPanel.latestRequestedCode ?? normalized;
      const initialUrl = await proxy.trendUrl(initialCode);
      const frameOrigin = loopbackOrigin(initialUrl, port);
      const panel = vscode.window.createWebviewPanel(
        'aShareLeek.stockTrend',
        '实时走势 · ' + initialCode,
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          enableFindWidget: true
        }
      );
      panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'leekfund.svg');

      const current = new StockTrendPanel(
        panel,
        proxy,
        initialUrl,
        frameOrigin,
        initialCode
      );
      StockTrendPanel.current = current;
      StockTrendPanel.activeProxy = proxy;
      return current;
    })();
    StockTrendPanel.creating = creation;
    try {
      return await creation;
    } finally {
      if (StockTrendPanel.creating === creation) {
        StockTrendPanel.creating = undefined;
      }
    }
  }

  public static autoRefreshVisible(): Promise<void> {
    return Promise.resolve();
  }

  public static updateRefreshState(state: StockTrendRefreshState): void {
    StockTrendPanel.marketRequestsAllowed = Boolean(state.allowed);
    StockTrendPanel.activeProxy?.setMarketRequestsAllowed(
      StockTrendPanel.marketRequestsAllowed
    );
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly proxy: EastmoneyProxyServer,
    initialUrl: string,
    private readonly frameOrigin: string,
    private currentCode: string
  ) {
    this.disposables.push(this.panel.onDidDispose(() => this.dispose()));
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((message: unknown) => {
        if (!message || typeof message !== 'object' || (message as { type?: unknown }).type !== 'ready') {
          return;
        }
        this.webviewReady = true;
        const pendingUrl = this.pendingNavigationUrl;
        this.pendingNavigationUrl = undefined;
        if (pendingUrl) {
          void this.postNavigation(pendingUrl);
        }
      })
    );
    this.panel.webview.html = this.getHtml(initialUrl);
  }

  private async navigate(code: string): Promise<void> {
    const normalized = normalizeAShareCode(code);
    if (normalized === this.currentCode) {
      return;
    }
    const navigationId = ++this.navigationId;
    const nextUrl = await this.proxy.trendUrl(normalized);
    if (loopbackOrigin(nextUrl, Number(new URL(this.frameOrigin).port)) !== this.frameOrigin) {
      throw new Error('行情代理地址在面板生命周期内发生变化');
    }
    if (navigationId !== this.navigationId) {
      return;
    }

    this.panel.title = '实时走势 · ' + normalized;
    this.currentCode = normalized;
    if (!this.webviewReady) {
      this.pendingNavigationUrl = nextUrl;
      return;
    }
    await this.postNavigation(nextUrl);
  }

  private async postNavigation(url: string): Promise<void> {
    const delivered = await this.panel.webview.postMessage({ type: 'navigate', url });
    if (!delivered && StockTrendPanel.current === this) {
      this.webviewReady = false;
      this.pendingNavigationUrl = url;
    }
  }

  private getHtml(initialUrl: string): string {
    const nonce = crypto.randomBytes(18).toString('base64');
    const initialUrlLiteral = scriptLiteral(initialUrl);
    const frameOriginLiteral = scriptLiteral(this.frameOrigin);
    return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${this.frameOrigin}; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>A 股实时走势</title>
    <style>
      html, body, iframe { width: 100%; height: 100%; margin: 0; border: 0; overflow: hidden; background: #050505; }
      body { position: relative; color: #d8d8d8; font: 14px/1.5 var(--vscode-font-family, system-ui, sans-serif); }
      iframe { display: block; opacity: 0; transition: opacity 80ms linear; }
      iframe.loaded { opacity: 1; }
      body.vscode-dark iframe,
      body.vscode-high-contrast iframe { filter: invert(1) hue-rotate(180deg); }
      body.vscode-light iframe,
      body.vscode-high-contrast-light iframe { filter: none; }
      .load-state {
        position: absolute;
        inset: 0;
        z-index: 2;
        display: flex;
        align-items: center;
        justify-content: center;
        background: #050505;
      }
      .load-state[hidden] { display: none; }
      .load-card { display: grid; justify-items: center; gap: 12px; color: #b8b8b8; }
      .spinner {
        width: 22px;
        height: 22px;
        border: 2px solid #333;
        border-top-color: #d0d0d0;
        border-radius: 50%;
        animation: spin .8s linear infinite;
      }
      .retry {
        display: none;
        border: 1px solid #555;
        border-radius: 3px;
        padding: 4px 12px;
        color: #ddd;
        background: #1d1d1d;
        cursor: pointer;
      }
      .load-state.failed .spinner { display: none; }
      .load-state.failed .retry { display: inline-block; }
      @keyframes spin { to { transform: rotate(360deg); } }
    </style>
  </head>
  <body>
    <iframe id="trendFrame" title="A 股实时走势" referrerpolicy="no-referrer-when-downgrade"></iframe>
    <div class="load-state" id="loadState">
      <div class="load-card">
        <div class="spinner" aria-hidden="true"></div>
        <div id="loadMessage">正在连接实时行情…</div>
        <button class="retry" id="retryButton" type="button">重新加载</button>
      </div>
    </div>
    <script nonce="${nonce}">
      (() => {
        const vscode = acquireVsCodeApi();
        const frame = document.getElementById('trendFrame');
        const loadState = document.getElementById('loadState');
        const loadMessage = document.getElementById('loadMessage');
        const retryButton = document.getElementById('retryButton');
        const allowedOrigin = ${frameOriginLiteral};
        let currentUrl = '';
        let loadTimer;
        const showLoading = () => {
          clearTimeout(loadTimer);
          frame.classList.remove('loaded');
          loadState.hidden = false;
          loadState.classList.remove('failed');
          loadMessage.textContent = '正在连接实时行情…';
          loadTimer = setTimeout(() => {
            loadState.classList.add('failed');
            loadMessage.textContent = '实时行情页加载超时';
          }, 15000);
        };
        const showFailure = () => {
          clearTimeout(loadTimer);
          frame.classList.remove('loaded');
          loadState.hidden = false;
          loadState.classList.add('failed');
          loadMessage.textContent = '实时行情页加载失败';
        };
        const navigate = (rawUrl) => {
          try {
            const target = new URL(String(rawUrl || ''));
            if (target.protocol === 'http:' && target.origin === allowedOrigin) {
              currentUrl = target.href;
              showLoading();
              frame.src = target.href;
            }
          } catch {
            // Ignore malformed or non-proxy navigation messages.
          }
        };
        frame.addEventListener('load', () => {
          clearTimeout(loadTimer);
          frame.classList.add('loaded');
          loadState.hidden = true;
        });
        frame.addEventListener('error', showFailure);
        retryButton.addEventListener('click', () => {
          if (!currentUrl) return;
          const retryUrl = new URL(currentUrl);
          retryUrl.searchParams.set('_retry', String(Date.now()));
          navigate(retryUrl.href);
        });
        window.addEventListener('message', (event) => {
          const message = event.data;
          if (message && message.type === 'navigate') {
            navigate(message.url);
          }
        });
        navigate(${initialUrlLiteral});
        vscode.postMessage({ type: 'ready' });
      })();
    </script>
  </body>
</html>`;
  }

  private dispose(): void {
    if (StockTrendPanel.current === this) {
      StockTrendPanel.current = undefined;
    }
    this.navigationId += 1;
    this.webviewReady = false;
    this.pendingNavigationUrl = undefined;
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}
