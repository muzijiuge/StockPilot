const assert = require('assert');
const {
  getStoredCloudSnapshot,
  shouldRequestCloudNetwork,
  updateStoredCloudSnapshots
} = require('../out/cloudSnapshot');

function stock(code, name, percent) {
  const market = code.startsWith('sh') ? '1' : '0';
  return {
    code,
    secid: market + '.' + code.slice(2),
    name,
    price: 10 + percent,
    percent,
    marketCap: 1000000000 + percent * 1000000,
    industry: '测试行业',
    subIndustry: '测试子行业'
  };
}

const all = [
  stock('sh600000', '沪市主板', 1),
  stock('sh688001', '科创样本', 2),
  stock('sz000001', '深市主板', -1),
  stock('sz300001', '创业样本', 3),
  stock('bj430001', '北交样本', -2)
];

let stored = updateStoredCloudSnapshots(undefined, 'all', all, 1000);
const persisted = JSON.parse(JSON.stringify(stored));
const starFromAll = getStoredCloudSnapshot(persisted, 'star');
assert.ok(starFromAll, 'full-market snapshot should serve STAR market while closed');
assert.equal(starFromAll.sourceFilter, 'all');
assert.deepEqual(starFromAll.data.map((item) => item.code), ['sh688001']);

const shFromAll = getStoredCloudSnapshot(persisted, 'sh');
assert.deepEqual(
  shFromAll.data.map((item) => item.code),
  ['sh600000', 'sh688001'],
  'full-market snapshot should derive exchange filters without a network request'
);

stored = updateStoredCloudSnapshots(
  stored,
  'star',
  [stock('sh688001', '科创样本', 6)],
  2000
);
const latestStar = getStoredCloudSnapshot(stored, 'star');
assert.equal(latestStar.sourceFilter, 'star');
assert.equal(latestStar.updatedAt, 2000);
assert.equal(latestStar.data[0].percent, 6, 'newer exact-filter snapshot should win');

stored = updateStoredCloudSnapshots(
  stored,
  'chinext',
  [stock('sz300001', '创业样本', 7)],
  3000
);
assert.equal(stored.snapshots.length, 2, 'only two compact snapshots should be retained');
assert.ok(
  stored.snapshots.some((item) => item.filter === 'all'),
  'full-market snapshot should be retained as the reusable fallback'
);
assert.equal(
  getStoredCloudSnapshot(stored, 'star').sourceFilter,
  'all',
  'evicted filters should still be derived from the retained full-market snapshot'
);

const oversized = Array.from({ length: 7100 }, (_item, index) =>
  stock('sh' + String(600000 + (index % 1000)).padStart(6, '0'), '样本' + index, 1)
);
const capped = updateStoredCloudSnapshots(undefined, 'all', oversized, 4000);
assert.equal(capped.snapshots[0].rows.length, 7000, 'snapshot storage must have a hard size cap');

assert.equal(
  shouldRequestCloudNetwork(false, false, false),
  false,
  'closed background auto-refresh must not request merely because it bypasses cache'
);
assert.equal(
  shouldRequestCloudNetwork(true, false, false),
  true,
  'explicit open, filter switch and manual refresh may request while closed'
);
assert.equal(shouldRequestCloudNetwork(false, true, false), true, 'trading time may request');
assert.equal(
  shouldRequestCloudNetwork(false, false, true),
  true,
  'outside-hours option may opt into requests'
);

console.log(
  JSON.stringify({
    persistedAcrossReload: true,
    derivedStarCount: starFromAll.data.length,
    retainedSnapshots: stored.snapshots.map((item) => item.filter),
    storedRowCap: capped.snapshots[0].rows.length,
    closedAutomaticRequest: shouldRequestCloudNetwork(false, false, false),
    closedUserInitiatedRequest: shouldRequestCloudNetwork(true, false, false)
  })
);
