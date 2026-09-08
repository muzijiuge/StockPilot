const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');
const { DataService } = require('../out/dataService');

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const board = (code, percent) => ({ code, secid: code, name: code, percent });
const payload = (rows, total = rows.length) => 'callback(' + JSON.stringify({
  blocks: { subcodeCount: total },
  items: rows.map(row => ({ '5': row.code, '55': row.name, '199112': row.percent }))
}) + ')';

async function testRanking() {
  for (const kind of ['industry', 'concept']) {
    const prefixes = kind === 'industry' ? ['8811', '8812'] : ['8855', '8859', '8860', '8862'];
    const groups = Object.fromEntries(prefixes.map((prefix, i) => [prefix,
      [board(prefix + '01', i + 1), board(prefix + '02', i + 2)]
    ]));
    // Include a small group and a newly introduced prefix discovered from the directory.
    groups[prefixes.at(-1)] = [board(prefixes.at(-1) + '01', 12)];
    const service = new DataService();
    service.getSectorRankingDirectory = async () => Object.values(groups).flat();
    const calls = [];
    service.getText = async url => {
      const prefix = url.match(/blocksrank\/(\d+)\//)[1];
      calls.push(prefix);
      return payload(groups[prefix]);
    };
    const ranked = await service.getTopSectorBoards(kind, 2, true);
    assert.deepEqual(ranked.map(row => row.percent), [12, prefixes.length]);
    assert.deepEqual(calls.sort(), prefixes.sort(), 'query every directory quote prefix');
    await service.getTopSectorBoards(kind, 2);
    assert.equal(calls.length, prefixes.length, 'reuse the complete cached ranking');
    service.getText = async url => {
      const prefix = url.match(/blocksrank\/(\d+)\//)[1];
      return prefix === prefixes.at(-1) ? payload([], 2) : payload(groups[prefix]);
    };
    assert.deepEqual(await service.getTopSectorBoards(kind, 2, true), ranked,
      'one incomplete group must preserve the previous complete ranking');
    service.topSectorBoardCache.clear();
    await assert.rejects(service.getTopSectorBoards(kind, 2, true), /分组返回不完整/);
  }
}

const messages = [];
let htmlWrites = 0;
const dispose = { dispose() {} };
const panel = {
  visible: true,
  reveal() {},
  onDidDispose: () => dispose,
  webview: {
    set html(value) { htmlWrites++; this.initialHtml = value; },
    postMessage: message => { messages.push(message); return Promise.resolve(true); },
    onDidReceiveMessage: () => dispose
  }
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return {
    ViewColumn: { One: 1 },
    Uri: { joinPath: (...parts) => parts.join('/') },
    window: { createWebviewPanel: () => panel }
  };
  return originalLoad.call(this, request, parent, isMain);
};
const { CenterPanel } = require('../out/centerPanel');
const { SidebarViewProvider } = require('../out/sidebarView');
Module._load = originalLoad;

async function testNavigation() {
  const detailRequests = [];
  const service = {
    getSectorBoardDetail: async code => board(code, 5),
    getSectorConstituents: async code => { detailRequests.push(code); return []; },
    getSectorOverview: async () => { throw new Error('unexpected overview navigation'); }
  };
  const store = { getWatchlist: () => [], getSectorFollows: () => [] };
  const provider = { onDidUpdateSnapshot: () => dispose, getSnapshot: () => ({}) };
  const originalHtml = CenterPanel.prototype.getHtml;
  CenterPanel.prototype.getHtml = function () {
    return JSON.stringify({ tab: this.activeTab, code: this.selectedSectorCode });
  };
  const center = CenterPanel.createOrShow({ extensionUri: 'test' }, store, service, provider,
    'sector', undefined, { kind: 'concept', code: '886033', board: board('886033', 5) });
  assert.deepEqual(JSON.parse(panel.webview.initialHtml), { tab: 'sector', code: '886033' },
    'cold start must know the destination before creating HTML');
  await center.handleMessage({ type: 'ready' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages.filter(message => message.type === 'navigate').length, 0);
  assert.deepEqual(detailRequests, ['886033']);
  messages.length = 0;
  CenterPanel.createOrShow({ extensionUri: 'test' }, store, service, provider,
    'sector', undefined, { kind: 'industry', code: '881270' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(detailRequests, ['886033', '881270'], 'do not reload the old destination');
  assert.deepEqual(messages.map(message => message.type), ['sectorDetailLoading', 'sectorDetail']);
  assert.equal(htmlWrites, 1, 'reuse the Webview document when switching boards');
  center.dispose();
  CenterPanel.prototype.getHtml = originalHtml;
}

async function testSortTransition() {
  const pending = {};
  const sidebar = new SidebarViewProvider({}, { onDidUpdateSnapshot: () => dispose }, {
    getTopSectorBoards: (kind, count, force, sort) => {
      pending[sort] = deferred();
      return pending[sort].promise;
    }
  });
  const updates = [];
  sidebar.view = { visible: true, webview: { postMessage: message => updates.push(JSON.parse(JSON.stringify(message))) } };
  sidebar.sectorBoards.industry = [board('881101', 3)];
  const toggle = sidebar.handleMessage({ type: 'toggleSectorSort', kind: 'industry' });
  sidebar.postSectors();
  assert.equal(updates.at(-1).sortModes.industry, 'percent', 'old rows keep their old sort label while loading');
  pending.heat.resolve([board('881270', 9)]);
  await toggle;
  assert.equal(updates.at(-1).sortModes.industry, 'heat');
  assert.equal(updates.at(-1).data.industry[0].code, '881270');
  const first = sidebar.handleMessage({ type: 'toggleSectorSort', kind: 'industry' });
  const second = sidebar.handleMessage({ type: 'toggleSectorSort', kind: 'industry' });
  pending.heat.resolve([board('881270', 10)]);
  await second;
  pending.percent.resolve([board('881101', 4)]);
  await first;
  assert.equal(updates.at(-1).sortModes.industry, 'heat');
  assert.equal(updates.at(-1).data.industry[0].percent, 10, 'late responses cannot replace the latest selection');
  const failure = sidebar.handleMessage({ type: 'toggleSectorSort', kind: 'industry' });
  pending.percent.reject(new Error('simulated network failure'));
  await failure;
  assert.equal(sidebar.sectorSortModes.industry, 'heat', 'failed toggles restore the displayed mode');
}

function testDetailRefresh() {
  const script = fs.readFileSync(path.join(__dirname, '../media/center.js'), 'utf8');
  const handler = script.split("case 'sectorDetailLoading':")[1].split("case 'sectorDetail':")[0];
  const context = {
    state: { sectorDetail: { code: '886033', board: board('886033', 5), data: [{ code: 'sh600000' }] } },
    message: { bkCode: '886033', kind: 'concept' },
    setTab() {}, showSectorView() {}, byId: () => null, renderSectorDetail() {}
  };
  vm.createContext(context);
  const refresh = () => vm.runInContext('switch (1) { case 1: ' + handler + '}', context);
  refresh();
  assert.equal(context.state.sectorDetail.data.length, 1, 'refresh retains visible constituents');
  context.message.bkCode = '881270';
  refresh();
  assert.equal(context.state.sectorDetail.data.length, 0, 'new boards must not show old constituents');
  const html = fs.readFileSync(path.join(__dirname, '../media/center.html'), 'utf8');
  assert.ok(html.indexOf('background: var(--vscode-editor-background') < html.indexOf('<link rel="stylesheet"'),
    'theme background must be available before external styles');
}

(async () => {
  await testRanking();
  await testNavigation();
  await testSortTransition();
  testDetailRefresh();
  console.log('Sector ranking, atomic sort transitions, direct navigation and refresh regressions passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
