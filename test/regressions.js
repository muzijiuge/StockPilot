const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const { isAIndexCode } = require('../out/types');

assert.equal(isAIndexCode('sh000905'), true, 'Shanghai broad indices belong to the index group');
assert.equal(isAIndexCode('sh931151'), true, 'CSI sector indices belong to the index group');
assert.equal(isAIndexCode('sz399997'), true, 'Shenzhen sector indices belong to the index group');
assert.equal(isAIndexCode('sh600036'), false, 'ordinary stocks must remain in the stock group');

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return {};
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { StateStore } = require('../out/stateStore');
Module._load = originalLoad;

class MemoryGlobalState {
  constructor() {
    this.values = new Map();
    this.syncKeys = [];
  }

  get(key, fallback) {
    return this.values.has(key) ? this.values.get(key) : fallback;
  }

  async update(key, value) {
    this.values.set(key, value);
  }

  setKeysForSync(keys) {
    this.syncKeys = keys;
  }
}

async function main() {
  const globalState = new MemoryGlobalState();
  const store = new StateStore({ globalState });
  await store.setWatchlist([]);

  await store.addWatch('sh931151', 'index');
  assert.deepEqual(store.getWatchlist(), ['sh931151']);
  assert.deepEqual(store.getIndexCodes(), ['sh931151']);

  await store.addWatch('sh600036', 'stock');
  assert.deepEqual(store.getIndexCodes(), ['sh931151']);
  assert.equal(store.isIndex('sh123456', '测试指数'), true, 'quote names provide a migration fallback');

  await store.removeWatch('sh931151');
  assert.deepEqual(store.getIndexCodes(), [], 'removing an index also removes its persisted type');

  await store.saveHolding({
    code: 'sh600036',
    name: '招商银行',
    amount: 100,
    cost: 12.3,
    updatedAt: 1
  });
  await store.deleteHolding('sh600036');
  assert.deepEqual(store.getHoldings(), [], 'asset records can be deleted');

  const root = path.resolve(__dirname, '..');
  const centerScript = fs.readFileSync(path.join(root, 'media', 'center.js'), 'utf8');
  const trendScript = fs.readFileSync(path.join(root, 'media', 'stock-trend.js'), 'utf8');
  const providerSource = fs.readFileSync(path.join(root, 'src', 'providers.ts'), 'utf8');
  const panelSource = fs.readFileSync(path.join(root, 'src', 'centerPanel.ts'), 'utf8');

  assert.doesNotMatch(centerScript, /window\.confirm/, 'asset deletion must not depend on Webview confirm');
  assert.match(panelSource, /showWarningMessage\([\s\S]*\{ modal: true \}/);
  assert.match(centerScript, /function price[\s\S]*?return current\.toFixed\(2\);/);
  assert.match(trendScript, /function price[\s\S]*?return current\.toFixed\(2\);/);
  assert.match(providerSource, /this\.changeEmitter\.fire\(node\)/);
  assert.doesNotMatch(
    providerSource,
    /const snapshot = this\.getSnapshot\(\);\s*this\.changeEmitter\.fire\(undefined\)/,
    'ordinary quote refresh must not rebuild the entire tree'
  );

  console.log(
    JSON.stringify({
      assetDelete: true,
      stableSidebarNodes: true,
      twoDecimalPrices: true,
      extendedIndexGrouping: true
    })
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
