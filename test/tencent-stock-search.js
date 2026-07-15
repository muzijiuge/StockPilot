const assert = require('assert');
const {
  TENCENT_STOCK_SEARCH_ENDPOINT,
  parseTencentStockSearch,
  searchTencentAStocks
} = require('../out/tencentStockSearch');

const payload = {
  code: 0,
  data: {
    stock: [
      ['sh', '600036', '招商银行', '', 'GP-A'],
      ['hk', '03968', '招商银行', '', 'GP'],
      ['sz', '000001', '平安银行', '', 'GP'],
      ['bj', '830799', '艾融软件', '', 'GP-A-BJ'],
      ['sh', '000001', '上证指数', '', 'ZS'],
      ['sh', '510300', '沪深300ETF', '', 'ETF'],
      ['sz', '160517', '银行LOF', '', 'LOF'],
      ['sh', '600036', '重复招商银行', '', 'GP-A'],
      ['SZ', '300750', '宁德时代', '', 'gp-a-cyb'],
      ['sh', '688001', '伪ETF类型', '', 'GP-AETF'],
      ['us', 'AAPL.N', '苹果', '', 'GP'],
      ['sh', '12345', '非法代码', '', 'GP-A'],
      { market: 'sh', code: '601318' },
      null
    ]
  }
};

const parsed = parseTencentStockSearch(payload);
assert.deepEqual(
  parsed.map((item) => item.code),
  ['sh600036', 'sz000001', 'bj830799', 'sh000001', 'sz300750'],
  'parser must preserve Tencent order while removing non-A-share types and duplicates'
);
assert.deepEqual(parsed[0], {
  code: 'sh600036',
  secid: '1.600036',
  name: '招商银行',
  marketLabel: '上证A股'
});
assert.equal(parsed[2].secid, '0.830799');
assert.equal(parsed[2].marketLabel, '北交所A股');
assert.equal(parsed[3].marketLabel, 'A股指数');
assert.deepEqual(parseTencentStockSearch({ data: { stock: null } }), []);
assert.deepEqual(parseTencentStockSearch(undefined), []);

async function main() {
  const calls = [];
  const fetched = await searchTencentAStocks('招商 银行', async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      async json() {
        return payload;
      }
    };
  });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    TENCENT_STOCK_SEARCH_ENDPOINT + encodeURIComponent('招商 银行')
  );
  assert.equal(calls[0].init.headers.Accept, 'application/json');
  assert.deepEqual(fetched, parsed);

  let emptyCalled = false;
  assert.deepEqual(
    await searchTencentAStocks('   ', async () => {
      emptyCalled = true;
      throw new Error('must not run');
    }),
    []
  );
  assert.equal(emptyCalled, false);

  await assert.rejects(
    () =>
      searchTencentAStocks('600036', async () => ({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        async json() {
          return {};
        }
      })),
    /Tencent SmartBox HTTP 502/
  );

  console.log(
    JSON.stringify({
      codes: parsed.map((item) => item.code),
      preservesServerOrder: true,
      duplicateRemoved: true,
      etfLofExcluded: true,
      encodedQuery: true
    })
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

