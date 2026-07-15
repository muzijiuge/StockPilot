const assert = require('assert');
const { EastmoneyProxyServer } = require('../out/eastmoneyProxyServer');

async function readUntilMatch(response, pattern, timeoutMs) {
  assert.ok(response.body, 'SSE response should expose a readable body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let text = '';
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    let handle;
    const timer = new Promise((_, reject) => {
      handle = setTimeout(() => reject(new Error('SSE read timeout')), remaining);
      handle.unref();
    });
    const result = await Promise.race([reader.read(), timer]);
    clearTimeout(handle);
    text += decoder.decode(result.value || new Uint8Array(), { stream: !result.done });
    if (pattern.test(text)) {
      return { reader, text };
    }
    if (result.done) {
      break;
    }
  }
  assert.match(text, pattern);
  return { reader, text };
}

async function main() {
  const proxy = new EastmoneyProxyServer();
  let trendTemplateRequests = 0;
  const createUpstreamRequest = proxy.createUpstreamRequest.bind(proxy);
  proxy.createUpstreamRequest = (request, target, onResponse, methodOverride) => {
    if (target.hostname === 'quote.eastmoney.com' && target.pathname === '/basic/full.html') {
      trendTemplateRequests += 1;
    }
    return createUpstreamRequest(request, target, onResponse, methodOverride);
  };
  try {
    proxy.setMarketRequestsAllowed(false);
    const trendUrl = await proxy.trendUrl('sh600036');
    const parsed = new URL(trendUrl);
    assert.equal(parsed.hostname, '127.0.0.1');
    assert.match(parsed.pathname, /^\/[a-f0-9]{48}\/trend$/);

    const pageResponse = await fetch(trendUrl);
    assert.equal(pageResponse.status, 200);
    assert.equal(pageResponse.headers.get('x-frame-options'), null);
    assert.equal(pageResponse.headers.get('cross-origin-resource-policy'), 'cross-origin');
    const pageCsp = pageResponse.headers.get('content-security-policy') || '';
    assert.ok(pageCsp.length > 0, 'Rewritten trend page should keep a constrained CSP');
    assert.ok(
      !/frame-ancestors/i.test(pageCsp),
      'Custom vscode-webview ancestors must not be rejected by the proxy page CSP'
    );
    const pageHtml = await pageResponse.text();
    assert.match(pageHtml, /window\.EventSource/);
    assert.match(pageHtml, /\/proxy\?url=/);
    assert.match(pageHtml, /a-share-eastmoney-layout/);
    assert.ok(!/http-equiv=["']content-security-policy/i.test(pageHtml));

    const indexTrendUrl = await proxy.trendUrl('sh000688');
    assert.equal(new URL(indexTrendUrl).searchParams.get('mcid'), '1.000688');
    const indexPageResponse = await fetch(indexTrendUrl);
    assert.equal(indexPageResponse.status, 200);
    const indexPageHtml = await indexPageResponse.text();
    assert.match(indexPageHtml, /window\.EventSource/);
    assert.match(indexPageHtml, /mcid=1\.000688/);
    assert.equal(
      trendTemplateRequests,
      1,
      'stock switches within the template TTL should share one upstream full.html request'
    );

    const tokenRoot = parsed.pathname.split('/').slice(0, 2).join('/');
    const blockedTarget = `${parsed.origin}${tokenRoot}/proxy?url=${encodeURIComponent(
      'https://example.com/'
    )}`;
    assert.equal((await fetch(blockedTarget)).status, 403);

    const detailsSse = new URL('https://push2.eastmoney.com/api/qt/stock/details/sse');
    detailsSse.searchParams.set('secid', '1.600036');
    detailsSse.searchParams.set('fields1', 'f1,f2,f3,f4,f5');
    detailsSse.searchParams.set('fields2', 'f51,f52,f53,f54,f55');
    detailsSse.searchParams.set('pos', '-16');
    detailsSse.searchParams.set('iscca', '1');
    detailsSse.searchParams.set('invt', '2');
    const localSse = `${parsed.origin}${tokenRoot}/proxy?url=${encodeURIComponent(
      detailsSse.toString()
    )}`;

    const pausedResponse = await fetch(localSse, {
      headers: { Accept: 'text/event-stream' }
    });
    assert.equal(pausedResponse.status, 200);
    const paused = await readUntilMatch(pausedResponse, /market requests paused/, 3000);
    assert.match(paused.text, /market requests paused/);
    proxy.setMarketRequestsAllowed(true);
    await paused.reader.read();

    const controller = new AbortController();
    const liveResponse = await fetch(localSse, {
      headers: { Accept: 'text/event-stream' },
      signal: controller.signal
    });
    assert.equal(liveResponse.status, 200);
    await readUntilMatch(liveResponse, /^data:\s*\{/m, 8000);
    controller.abort();

    console.log(
      JSON.stringify(
        {
          trendUrl: `${parsed.origin}/<token>/trend?mcid=1.600036`,
          htmlBytes: Buffer.byteLength(pageHtml),
          trendTemplateRequests,
          pausedSse: true,
          liveSse: true
        },
        null,
        2
      )
    );
  } finally {
    proxy.dispose();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
