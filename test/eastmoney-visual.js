const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { EastmoneyProxyServer } = require('../out/eastmoneyProxyServer');

const chromePath =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const screenshotPath = path.resolve(
  process.argv[2] || path.join(__dirname, 'trend-leekfund-v130.png')
);
const trendTab = String(process.argv[3] || process.env.TREND_TAB || '').trim();
const stockCode = String(process.argv[4] || process.env.TREND_CODE || 'sh600036').trim();

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function json(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Chrome debugging endpoint returned HTTP ${response.status}`);
  }
  return response.json();
}

async function waitForPage(debugPort) {
  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const targets = await json(`http://127.0.0.1:${debugPort}/json/list`);
      const page = targets.find((target) => target.type === 'page');
      if (page?.webSocketDebuggerUrl) {
        return page;
      }
    } catch (error) {
      lastError = error;
    }
    await wait(125);
  }
  throw lastError || new Error('Chrome did not expose a page target');
}

async function connectCdp(webSocketDebuggerUrl) {
  const Socket = globalThis.WebSocket || require('ws');
  const socket = new Socket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method && listeners.has(message.method)) {
      for (const listener of listeners.get(message.method)) {
        listener(message.params || {});
      }
    }
    if (!message.id || !pending.has(message.id)) {
      return;
    }
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) {
      reject(new Error(message.error.message));
    } else {
      resolve(message.result || {});
    }
  });
  return {
    send(method, params = {}) {
      const id = ++nextId;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    on(method, listener) {
      const current = listeners.get(method) || [];
      current.push(listener);
      listeners.set(method, current);
    },
    close() {
      socket.close();
    }
  };
}

async function main() {
  assert.ok(fs.existsSync(chromePath), 'Chrome executable is required for visual QA');
  const proxy = new EastmoneyProxyServer();
  proxy.setMarketRequestsAllowed(true);
  const trendUrl = await proxy.trendUrl(stockCode);

  const wrapper = http.createServer((_request, response) => {
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-security-policy': `default-src 'none'; frame-src ${new URL(trendUrl).origin}; style-src 'unsafe-inline'`,
      'content-type': 'text/html; charset=utf-8'
    });
    response.end(`<!doctype html><html><head><style>
html,body,iframe{width:100%;height:100%;margin:0;border:0;overflow:hidden;background:#050505}
iframe{display:block;filter:invert(1) hue-rotate(180deg)}
</style></head><body><iframe src="${trendUrl}"></iframe></body></html>`);
  });

  try {
    const wrapperPort = await listen(wrapper);
    const debugProbe = http.createServer();
    const debugPort = await listen(debugProbe);
    await close(debugProbe);
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'a-share-leek-visual-'));
    const launchUrl = trendTab ? trendUrl : `http://127.0.0.1:${wrapperPort}/`;
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profile}`,
      '--window-size=1600,960',
      `--remote-debugging-port=${debugPort}`,
      launchUrl
    ];
    const child = spawn(chromePath, args, { stdio: 'ignore', windowsHide: true });
    child.once('error', (error) => console.error(error));
    const page = await waitForPage(debugPort);
    const cdp = await connectCdp(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    const marketResponses = [];
    const networkFailures = [];
    const requestUrls = new Map();
    cdp.on('Network.requestWillBeSent', ({ requestId, request }) => {
      requestUrls.set(requestId, request?.url || '');
    });
    cdp.on('Network.responseReceived', ({ requestId, response }) => {
      const localUrl = response?.url || '';
      let upstreamUrl = localUrl;
      try {
        upstreamUrl = new URL(localUrl).searchParams.get('url') || localUrl;
      } catch {
        // Keep the browser URL.
      }
      if (/\/api\/qt\/stock\/(?:kline|trends2)\//i.test(upstreamUrl)) {
        marketResponses.push({ requestId, url: upstreamUrl, status: response.status });
      }
    });
    cdp.on('Network.loadingFailed', ({ requestId, errorText }) => {
      networkFailures.push({ requestId, url: requestUrls.get(requestId) || '', errorText });
    });
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1600,
      height: 960,
      deviceScaleFactor: 1,
      mobile: false
    });
    await wait(10_000);
    let pageState = {};
    if (trendTab) {
      const clickResult = await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          document.documentElement.style.filter = 'invert(1) hue-rotate(180deg)';
          document.documentElement.style.background = '#fff';
          const label = ${JSON.stringify(trendTab)};
          const target = [...document.querySelectorAll('a,button,li,div,span')]
            .find((element) => element.children.length === 0 && element.textContent.trim() === label);
          if (!target) return false;
          target.click();
          return true;
        })()`,
        returnByValue: true
      });
      assert.equal(clickResult.result?.value, true, `Trend tab ${trendTab} should be clickable`);
      await wait(12_000);
    }
    const stateResult = await cdp.send('Runtime.evaluate', {
      expression: `({
        title: document.title,
        canvasCount: document.querySelectorAll('canvas').length,
        bodyTextLength: document.body.innerText.length
      })`,
      returnByValue: true
    });
    pageState = stateResult.result?.value || {};
    pageState.marketResponses = marketResponses.map(({ url, status }) => ({ url, status }));
    pageState.networkFailures = networkFailures;
    assert.ok(pageState.bodyTextLength > 500, 'Trend page should render quote text');
    assert.ok(pageState.canvasCount > 0, 'Trend page should render chart canvases');
    const capture = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false
    });
    fs.writeFileSync(screenshotPath, Buffer.from(capture.data, 'base64'));
    await cdp.send('Browser.close').catch(() => undefined);
    cdp.close();
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      wait(5_000).then(() => child.kill())
    ]);
    assert.ok(fs.existsSync(screenshotPath), 'Chrome should create the trend screenshot');
    const bytes = fs.statSync(screenshotPath).size;
    assert.ok(bytes > 50_000, 'Trend screenshot should contain a rendered market page');
    console.log(
      JSON.stringify(
        { screenshotPath, bytes, trendUrl: '<loopback>/<token>/trend', stockCode, trendTab: trendTab || '分时', pageState },
        null,
        2
      )
    );
  } finally {
    await close(wrapper);
    proxy.dispose();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
