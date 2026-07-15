const assert = require('assert');
const { DataService } = require('../out/dataService');

async function main() {
  const service = new DataService();
  let failRequests = false;

  service.getJson = async function (url) {
    if (failRequests) {
      throw new Error('simulated network interruption');
    }
    if (url.includes('/fflow/')) {
      return {
        data: {
          klines: ['2026-07-15 10:00,1200000,200000,300000,400000,500000']
        }
      };
    }
    return {
      data: {
        details: ['10:00:03,37.18,5058,12,2']
      }
    };
  };

  const initial = await service.getRealtimeExtras('sh600036', true);
  assert.equal(initial.trades.length, 1);
  assert.equal(initial.trades[0].side, 'buy');
  assert.equal(initial.partial, false);

  failRequests = true;
  const fallback = await service.getRealtimeExtras('sh600036', true);
  assert.deepEqual(fallback.flow, initial.flow);
  assert.deepEqual(fallback.trades, initial.trades);
  assert.equal(fallback.flowUpdatedAt, initial.flowUpdatedAt);
  assert.equal(fallback.tradesUpdatedAt, initial.tradesUpdatedAt);
  assert.equal(fallback.partial, true);

  console.log('Realtime extras cache fallback passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
