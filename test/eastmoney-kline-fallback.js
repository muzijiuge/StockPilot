const assert = require('assert');
const { EastmoneyProxyServer } = require('../out/eastmoneyProxyServer');

const SOHU_ROWS_DESCENDING = [
  ['2026-07-14', '37.10', '37.18', '-0.07', '-0.19%', '36.82', '37.24', '804154', '297912.28', '0.39%'],
  ['2026-07-10', '36.70', '37.25', '0.45', '1.22%', '36.60', '37.30', '610000', '226000.00', '0.31%'],
  ['2026-06-30', '36.20', '36.80', '0.50', '1.38%', '36.00', '36.90', '520000', '190000.00', '0.28%'],
  ['2026-06-01', '35.90', '36.30', '0.30', '0.83%', '35.70', '36.40', '480000', '172000.00', '0.25%']
];

const MINUTE_TRENDS = [
  '2026-07-14 09:30,37.10,37.11,37.12,37.09,100,371000.00,37.10',
  '2026-07-14 09:34,37.10,37.13,37.14,37.08,120,445200.00,37.11',
  '2026-07-14 09:35,37.13,37.12,37.15,37.10,130,482300.00,37.12',
  '2026-07-14 09:44,37.12,37.16,37.18,37.11,140,519400.00,37.13',
  '2026-07-14 09:45,37.16,37.20,37.22,37.14,150,557000.00,37.15',
  '2026-07-14 09:59,37.20,37.21,37.24,37.18,160,594000.00,37.17',
  '2026-07-14 10:00,37.21,37.19,37.23,37.17,170,631000.00,37.18',
  '2026-07-14 10:31,37.19,37.25,37.27,37.18,180,669000.00,37.20'
];

function parseJsonp(text, callback) {
  assert.ok(text.startsWith(`${callback}(`), 'response should preserve a valid JSONP callback');
  assert.ok(text.endsWith(');'), 'JSONP response should end with );');
  return JSON.parse(text.slice(callback.length + 1, -2));
}

async function main() {
  const proxy = new EastmoneyProxyServer();
  let emptySohu = false;
  let failFallback = false;
  const fallbackTargets = [];
  let regularForwardCount = 0;

  proxy.fetchKlineFallbackText = async (target) => {
    fallbackTargets.push(target.toString());
    if (failFallback) {
      throw new Error('fixture fallback failure');
    }
    if (target.hostname === 'q.stock.sohu.com') {
      assert.equal(target.pathname, '/hisHq');
      assert.equal(target.searchParams.get('code'), 'cn_600036');
      assert.equal(target.searchParams.get('start'), '19900101');
      assert.equal(target.searchParams.get('callback'), 'historySearchHandler');
      return `historySearchHandler(${JSON.stringify([
        { status: 0, name: '招商银行', hq: emptySohu ? [] : SOHU_ROWS_DESCENDING }
      ])})`;
    }
    if (target.hostname === 'push2delay.eastmoney.com') {
      assert.equal(target.pathname, '/api/qt/stock/trends2/get');
      assert.equal(target.searchParams.get('fields1'), 'f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13');
      assert.equal(target.searchParams.get('fields2'), 'f51,f52,f53,f54,f55,f56,f57,f58');
      assert.equal(target.searchParams.get('ndays'), '1');
      assert.equal(target.searchParams.get('secid'), '1.600036');
      return JSON.stringify({
        rc: 0,
        rt: 17,
        svr: 42,
        dlmkts: '',
        data: {
          code: '600036',
          market: 1,
          name: '招商银行',
          decimal: 2,
          preClose: 37,
          trends: MINUTE_TRENDS
        }
      });
    }
    throw new Error(`unexpected fallback target: ${target}`);
  };

  try {
    const trendUrl = new URL(await proxy.trendUrl('sh600036'));
    const tokenRoot = trendUrl.pathname.split('/').slice(0, 2).join('/');
    const proxyEndpoint = `${trendUrl.origin}${tokenRoot}/proxy?url=`;

    const localKlineUrl = (period, options = {}) => {
      const target = new URL('http://58.push2his.eastmoney.com/api/qt/stock/kline/get');
      target.searchParams.set('secid', options.secid || '1.600036');
      target.searchParams.set('klt', String(period));
      target.searchParams.set('lmt', String(options.limit || 2));
      if (options.callback) target.searchParams.set('cb', options.callback);
      return `${proxyEndpoint}${encodeURIComponent(target.toString())}`;
    };

    const periods = [101, 102, 103, 5, 15, 30, 60];
    for (const period of periods) {
      const callback = `jQuery_fixture_${period}`;
      const response = await fetch(localKlineUrl(period, { callback }));
      assert.equal(response.status, 200, `period ${period} should return HTTP 200`);
      assert.match(response.headers.get('content-type') || '', /^application\/javascript/i);
      const payload = parseJsonp(await response.text(), callback);
      assert.equal(payload.rc, 0);
      assert.equal(payload.data.code, '600036');
      assert.equal(payload.data.market, 1);
      assert.ok(payload.data.klines.length > 0, `period ${period} should contain K-lines`);
      assert.ok(payload.data.klines.length <= 2, `period ${period} should honor lmt=2`);
      for (const kline of payload.data.klines) {
        assert.equal(kline.split(',').length, 11, `period ${period} should emit Eastmoney's 11 fields`);
      }
    }

    assert.equal(fallbackTargets.filter((url) => url.includes('q.stock.sohu.com')).length, 3);
    assert.equal(fallbackTargets.filter((url) => url.includes('/trends2/get')).length, 4);

    proxy.setMarketRequestsAllowed(false);
    const closedMarketKline = await (await fetch(localKlineUrl(101))).json();
    assert.ok(
      closedMarketKline.data.klines.length > 0,
      'an explicit K-line period switch should remain available while automatic streaming is gated'
    );
    proxy.setMarketRequestsAllowed(true);

    emptySohu = true;
    const emptyResponse = await fetch(localKlineUrl(101));
    assert.equal(emptyResponse.status, 200);
    const emptyPayload = await emptyResponse.json();
    assert.equal(emptyPayload.rc, 0);
    assert.deepEqual(emptyPayload.data.klines, [], 'a valid empty Sohu response should be a successful fallback');
    emptySohu = false;

    const invalidCallbackResponse = await fetch(localKlineUrl(101, { callback: 'alert(1)//' }));
    assert.match(invalidCallbackResponse.headers.get('content-type') || '', /^application\/json/i);
    assert.equal((await invalidCallbackResponse.json()).rc, 0, 'an unsafe JSONP callback should fall back to JSON');
    assert.equal(proxy.isAllowedKlineFallbackTarget(new URL('http://127.0.0.1/internal')), false);
    assert.equal(proxy.isAllowedKlineFallbackTarget(new URL('https://q.stock.sohu.com/hisHq')), true);
    assert.equal(proxy.isAllowedKlineFallbackTarget(new URL('https://push2delay.eastmoney.com/api/qt/')), true);
    assert.equal(proxy.isAllowedKlineFallbackTarget(new URL('https://push2delay.eastmoney.com:8443/api/qt/')), false);

    const originalForwardRegular = proxy.forwardRegular.bind(proxy);
    proxy.forwardRegular = async (_request, response, target) => {
      regularForwardCount += 1;
      const body = Buffer.from(JSON.stringify({ forwarded: true, secid: target.searchParams.get('secid') }));
      response.writeHead(200, {
        'content-length': String(body.length),
        'content-type': 'application/json; charset=utf-8'
      });
      response.end(body);
    };

    failFallback = true;
    const failedFallback = await (await fetch(localKlineUrl(101))).json();
    assert.equal(failedFallback.forwarded, true, 'an exception should fall through to the original upstream path');
    assert.equal(regularForwardCount, 1);
    failFallback = false;

    const callsBeforeBoard = fallbackTargets.length;
    const boardResponse = await (await fetch(localKlineUrl(101, { secid: '90.BK0475' }))).json();
    assert.equal(boardResponse.forwarded, true, '90.BK sectors should skip the A-share fallback');
    assert.equal(fallbackTargets.length, callsBeforeBoard, '90.BK should not contact Sohu or trends2');
    assert.equal(regularForwardCount, 2);

    proxy.forwardRegular = originalForwardRegular;

    console.log(
      JSON.stringify(
        {
          periods,
          jsonp: true,
          unsafeCallbackRejected: true,
          redirectAllowlist: true,
          limit: 2,
          emptyDataSuccess: true,
          manualKlineWhileClosed: true,
          exceptionFallsThrough: true,
          boardSkipped: true
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
