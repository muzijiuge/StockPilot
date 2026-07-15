const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

require('./make-preview');

const chromePath =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const previewPath = path.resolve(__dirname, 'preview.generated.html');
const screenshotPath = path.resolve(__dirname, 'cloud-performance-preview.png');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForPage(port) {
  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === 'page');
      if (page?.webSocketDebuggerUrl) {
        return page;
      }
    } catch (error) {
      lastError = error;
    }
    await wait(100);
  }
  throw lastError || new Error('Chrome page target was not ready');
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) {
      return;
    }
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) {
      request.reject(new Error(message.error.message));
    } else {
      request.resolve(message.result || {});
    }
  });
  return {
    send(method, params = {}) {
      const id = ++nextId;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    close() {
      socket.close();
    }
  };
}

async function evaluate(cdp, expression) {
  const response = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.text || 'Runtime evaluation failed');
  }
  return response.result?.value;
}

async function waitForCloud(cdp) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const state = await evaluate(
      cdp,
      `(() => {
        const chart = document.querySelector('#cloudChart');
        const loading = document.querySelector('#cloudLoading');
        return {
          ready: chart.classList.contains('is-ready'),
          canvasCount: chart.querySelectorAll('canvas').length,
          loadingHidden: loading.classList.contains('hidden'),
          opacity: getComputedStyle(chart).opacity,
          width: chart.getBoundingClientRect().width,
          height: chart.getBoundingClientRect().height
        };
      })()`
    );
    if (state.ready && state.canvasCount > 0 && state.loadingHidden && state.opacity === '1') {
      return state;
    }
    await wait(100);
  }
  throw new Error('Cloud treemap did not reach a visible ready state');
}

async function main() {
  assert.ok(fs.existsSync(chromePath), 'Chrome executable is required for cloud visual QA');
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'a-share-leek-cloud-visual-'));
  const url = pathToFileURL(previewPath).href + '#cloud';
  const child = spawn(
    chromePath,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1600,960',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      url
    ],
    { stdio: 'ignore', windowsHide: true }
  );

  let cdp;
  try {
    const page = await waitForPage(port);
    cdp = await connect(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1600,
      height: 960,
      deviceScaleFactor: 1,
      mobile: false
    });
    const readyState = await waitForCloud(cdp);
    assert.ok(readyState.width > 1200 && readyState.height > 600);

    await evaluate(
      cdp,
      `(() => {
        const node = document.querySelector('#cloudChart');
        const chart = echarts.getInstanceByDom(node);
        window.__cloudSetOptionCount = 0;
        const original = chart.setOption.bind(chart);
        chart.setOption = function () {
          window.__cloudSetOptionCount += 1;
          return original.apply(null, arguments);
        };
        document.querySelector('[data-filter="all"]').click();
      })()`
    );
    await wait(500);
    const duplicateState = await evaluate(
      cdp,
      `({
        setOptionCount: window.__cloudSetOptionCount,
        loadingHidden: document.querySelector('#cloudLoading').classList.contains('hidden'),
        ready: document.querySelector('#cloudChart').classList.contains('is-ready')
      })`
    );
    assert.equal(duplicateState.setOptionCount, 0, 'duplicate cloud payload should skip setOption');
    assert.equal(duplicateState.loadingHidden, true);
    assert.equal(duplicateState.ready, true);

    const capture = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false
    });
    fs.writeFileSync(screenshotPath, Buffer.from(capture.data, 'base64'));
    console.log(
      JSON.stringify({
        ready: readyState.ready,
        canvasCount: readyState.canvasCount,
        opacity: readyState.opacity,
        duplicateSetOptionCount: duplicateState.setOptionCount,
        screenshotPath
      })
    );
  } finally {
    cdp?.close();
    child.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

