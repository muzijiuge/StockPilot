const assert = require('assert');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return {};
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { StateStore } = require('../out/stateStore');

async function main() {
  const values = new Map();
  let syncKeys = [];
  const context = {
    globalState: {
      get(key, fallback) {
        return values.has(key) ? values.get(key) : fallback;
      },
      async update(key, value) {
        values.set(key, value);
      },
      setKeysForSync(keys) {
        syncKeys = keys.slice();
      }
    }
  };
  const store = new StateStore(context);
  await store.setWatchlist(['sh600036', 'sz000001']);

  const bank = await store.createWatchGroup('银行');
  const focus = await store.createWatchGroup('重点关注');
  assert.ok(syncKeys.includes('aShareLeek.watchGroups.v1'));
  assert.deepEqual(
    store.getWatchGroups().map((item) => item.name),
    ['银行', '重点关注']
  );

  await store.replaceWatchGroups('sh600036', bank.id);
  assert.deepEqual(store.getWatchGroupAssignments().sh600036, [bank.id]);
  await store.renameWatchGroup(bank.id, '银行股');
  assert.equal(store.getWatchGroups()[0].name, '银行股');

  await store.addWatchToGroup('sh600036', focus.id);
  assert.deepEqual(store.getWatchGroupAssignments().sh600036, [bank.id, focus.id]);
  await store.moveWatchBetweenGroups('sh600036', bank.id, undefined);
  assert.deepEqual(store.getWatchGroupAssignments().sh600036, [focus.id, 'default']);
  const removedAllAfterDefault = await store.removeWatchFromGroup('sh600036', undefined);
  assert.equal(removedAllAfterDefault, false);
  assert.deepEqual(store.getWatchGroupAssignments().sh600036, [focus.id]);
  assert.ok(store.getWatchlist().includes('sh600036'));
  const removedAllAfterFocus = await store.removeWatchFromGroup('sh600036', focus.id);
  assert.equal(removedAllAfterFocus, true);
  assert.ok(!store.getWatchlist().includes('sh600036'));

  await store.addWatch('sh600036', 'stock');
  await store.replaceWatchGroups('sh600036', focus.id);
  await store.deleteWatchGroup(focus.id);
  assert.deepEqual(store.getWatchGroupAssignments().sh600036, ['default']);
  assert.ok(store.getWatchlist().includes('sh600036'));

  await store.replaceWatchGroups('sz000001', bank.id);
  await store.removeWatch('sz000001');
  await store.addWatch('sz000001', 'stock');
  assert.equal(
    store.getWatchGroupAssignments().sz000001,
    undefined,
    'removing and re-adding a stock must not restore a stale assignment'
  );

  values.set('aShareLeek.watchGroups.v1', {
    groups: store.getWatchGroups(),
    assignments: { sh600036: bank.id }
  });
  assert.deepEqual(
    store.getWatchGroupAssignments().sh600036,
    [bank.id],
    'the former single-group storage format must migrate in memory'
  );

  await assert.rejects(() => store.createWatchGroup('银行股'), /同名/);
  console.log(
    JSON.stringify({
      persistedCustomGroups: true,
      multipleMemberships: true,
      legacySingleMembershipMigrated: true,
      dragAndContextMoveOnlySourceMembership: true,
      contextDeleteOnlySourceMembership: true,
      renameSupported: true,
      deleteReturnsStocksToDefault: true,
      staleAssignmentsPruned: true
    })
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
