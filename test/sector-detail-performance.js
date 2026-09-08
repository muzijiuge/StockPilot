const assert = require('assert');
const Module = require('module');
const { DataService, parseTonghuashunSectorBoardDetail, withSectorTradingTotals } = require('../out/dataService');
const originalLoad = Module._load;
Module._load = function(request, parent, main) {
  return request === 'vscode' ? {} : originalLoad.call(this, request, parent, main);
};
const { CenterPanel } = require('../out/centerPanel');
Module._load = originalLoad;
const tick = () => new Promise(resolve => setImmediate(resolve));
const html = `<h3>元件<span>881270</span></h3><div class="board-infos">
  <dl><dt>成交量(万手)</dt><dd>1,018.11</dd></dl>
  <dl><dt>成交额(亿)</dt><dd>506.91</dd></dl></div>`;
const board = parseTonghuashunSectorBoardDetail(html, 'industry', '881270');
assert.equal(board.volume, 1_018_110_000, '万手 must normalize to shares');
assert.equal(board.amount, 50_691_000_000, '亿元 must normalize to yuan');
const zeroHtml = html.replace('1,018.11', '0').replace('506.91', '0');
const zero = parseTonghuashunSectorBoardDetail(zeroHtml, 'industry', '881270', board);
assert.equal(zero.volume, 0, 'zero trading volume must replace a previous nonzero value');
assert.equal(zero.amount, 0);
const inline = parseTonghuashunSectorBoardDetail(html.replace('(万手)', '').replace('1,018.11', '2.5万手')
  .replace('(亿)', '').replace('506.91', '3亿元'), 'industry', '881270');
assert.equal(inline.volume, 2_500_000);
assert.equal(inline.amount, 300_000_000);
const missing = parseTonghuashunSectorBoardDetail('<h3>元件<span>881270</span></h3>', 'industry', '881270');
assert.equal(withSectorTradingTotals(missing, [{ volume: 100, amount: 200 }, { volume: 300 }]).amount, undefined,
  'missing constituent values must not become misleading partial totals');

(async () => {
  const service = new DataService();
  service.getSectorBoards = async () => { throw new Error('full board list must not be requested'); };
  let releaseHtml;
  const delayedHtml = new Promise(resolve => { releaseHtml = resolve; });
  const urls = [];
  service.getText = async url => {
    urls.push(url);
    if (url.includes('/detail/code/')) return delayedHtml;
    assert.ok(url.endsWith('/881270/199112/d500.js'), 'one rank response must serve headline and constituents');
    return 'cb(' + JSON.stringify({block: { name:'元件', subcodeCount:2, '10':'120', '199112':'3' },items:[
      {'5':'600000','55':'样本甲','10':'10','13':'1000','19':'10000','199112':'2'},
      {'5':'000001','55':'样本乙','10':'20','13':'2000','19':'40000','199112':'1'}
    ]}) + ')';
  };
  const messages = [];
  const center = Object.assign(Object.create(CenterPanel.prototype), {
    dataService:service, sectorDetailRequestId:0, sectorView:'detail', sectorKind:'industry',
    selectedSectorCode:'881270', selectedSectorBoard:missing,
    post: message => messages.push(message)
  });
  const loading = center.loadSectorDetail('881270', false);
  await tick();
  assert.equal(messages.filter(message => message.type === 'sectorDetail').length, 1,
    'the list must render while optional HTML metrics are still pending');
  const early = messages.at(-1);
  assert.equal(early.data.length, 2);
  assert.equal(early.board.volume, 3000);
  assert.equal(early.board.amount, 50000);
  assert.equal(urls.filter(url => url.includes('blockrank/')).length, 1);
  releaseHtml(html);
  await loading;
  assert.equal(messages.at(-1).board.volume, board.volume);
  assert.equal(messages.at(-1).board.amount, board.amount);
  assert.equal(urls.length, 2, 'no full list, extra quote headline or duplicate constituent request');
  await center.loadSectorDetail('881270', false);
  assert.equal(urls.length, 2, 'reopening a fresh detail must use both caches');

  let finishOld;
  center.dataService = {
    getSectorBoardDetail: () => new Promise(resolve => { finishOld = resolve; }),
    getSectorConstituents: async () => [{ code:'sh600000', volume:1, amount:2 }]
  };
  const old = center.loadSectorDetail('881270', true);
  await tick();
  center.selectedSectorCode = '881121';
  const before = messages.length;
  finishOld(board);
  await old;
  assert.equal(messages.length, before, 'late metrics cannot switch the visible board back');
  console.log('Sector units, zero/missing totals, early rendering, shared requests and stale navigation passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
