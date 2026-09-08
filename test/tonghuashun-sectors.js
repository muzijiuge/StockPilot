const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  parseTonghuashunBlockRankBoard,
  parseTonghuashunBlockRankBoards,
  parseTonghuashunBlockRankConstituents,
  parseTonghuashunConceptBoards,
  parseTonghuashunHotSectorBoards,
  parseTonghuashunIndustryBoards,
  parseTonghuashunPageCount,
  parseTonghuashunSectorBoardDetail,
  parseTonghuashunSectorConstituents
} = require('../out/dataService');

const dataServiceSource = fs.readFileSync(
  path.resolve(__dirname, '..', 'src', 'dataService.ts'),
  'utf8'
);
const centerPanelSource = fs.readFileSync(
  path.resolve(__dirname, '..', 'src', 'centerPanel.ts'),
  'utf8'
);
const centerScriptSource = fs.readFileSync(
  path.resolve(__dirname, '..', 'media', 'center.js'),
  'utf8'
);

const industryHtml = `
  <a href="http://q.10jqka.com.cn/thshy/detail/code/881270/">元件</a>
  <table><tbody><tr>
    <td>1</td>
    <td><a href="http://q.10jqka.com.cn/thshy/detail/code/881270/">元件</a></td>
    <td class="c-rise">3.69</td><td>582.64</td><td>276.64</td><td>30.94</td>
    <td>62</td><td>0</td><td>47.48</td>
    <td><a href="http://stockpage.10jqka.com.cn/688655/">迅捷兴</a></td>
    <td>50.52</td><td>20.00</td>
  </tr></tbody></table>`;

const conceptHtml = `
  <a href="http://q.10jqka.com.cn/gn/detail/code/300435/">转基因</a>
  <a href="http://q.10jqka.com.cn/gn/detail/code/309030/">PET铜箔</a>
  <input type="hidden" id="gnSection" value='{
    "1":{"platecode":"885877","platename":"转基因","cid":"300435","199112":3.37,"zjjlr":0.59,"zfl":90},
    "2":{"platecode":"886020","platename":"PET铜箔","cid":"309030","199112":2.84,"zjjlr":2.74,"zfl":80}
  }'>`;

const constituentsHtml = `
  <table><tbody><tr>
    <td>1</td><td><a href="http://stockpage.10jqka.com.cn/688655/">688655</a></td>
    <td><a href="http://stockpage.10jqka.com.cn/688655/">迅捷兴</a></td>
    <td>50.52</td><td>20.00</td><td>8.42</td><td>0.00</td><td>8.09</td>
    <td>19.61</td><td>15.96</td><td>5.22亿</td><td>1.33亿</td><td>67.39亿</td><td>236.23</td>
  </tr></tbody></table>`;

const boardRankJsonp = `quotebridge_v2_blocksrank_8811_199112_d2({
  "blocks":{"subcodeCount":68},
  "items":[
    {"5":"881270","10":"24754.627","55":"元件","275":"688655","199112":"5.216","264648":"1227.261"},
    {"5":"881121","10":"6142.113","55":"半导体","275":"688256","199112":"3.108","264648":"184.555"}
  ]
})`;

const hotPlateJson = JSON.stringify({
  status_code: 0,
  data: {
    plate_list: [
      {
        code: '885573',
        name: '猪肉',
        rise_and_fall: 1.3351,
        rate: '327504.5',
        order: 1,
        hot_rank_chg: 2
      },
      {
        code: '886042',
        name: '存储芯片',
        rise_and_fall: 2.8619,
        rate: '314557.0',
        order: 2,
        hot_rank_chg: 0
      }
    ]
  }
});

const constituentRankJsonp = `quotebridge_v2_blockrank_881270_199112_d1000({
  "block":{"name":"元件","subcodeCount":2,"10":"24754.627","199112":"5.216","264648":"1227.261"},
  "items":[
    {"5":"688655","6":"42.10","7":"43.00","8":"50.52","9":"42.80","10":"50.52","13":"1000000","19":"50520000","55":"迅捷兴","199112":"20.000","264648":"8.420","1968584":"9.171","2034120":"35.620","3475914":"6738862800.000","3541450":"8120000000.000"},
    {"5":"002463","10":"14.08","55":"沪电股份","199112":"3.120","264648":"0.426","1968584":"2.800","3475914":"26990000000.000"}
  ]
})`;

const boardDetailHtml = `
  <div class="board-txt"><h4>定义</h4><p>测试板块的完整定义。</p></div>
  <div class="board-hq"><h3>元件<span>881270</span></h3>
    <span class="board-xj arr-rise">24754.63</span>
    <p class="board-zdf">1227.26&nbsp;&nbsp;5.22%</p>
  </div>
  <div class="board-infos">
    <dl><dt>今开</dt><dd>23800.00</dd></dl>
    <dl><dt>昨收</dt><dd>23527.37</dd></dl>
    <dl><dt>最低</dt><dd>23700.00</dd></dl>
    <dl><dt>最高</dt><dd>24800.00</dd></dl>
    <dl><dt>成交量</dt><dd>12.50亿</dd></dl>
    <dl><dt>成交额</dt><dd>320.25亿</dd></dl>
  </div>`;

const industry = parseTonghuashunIndustryBoards(industryHtml, 123);
assert.equal(industry.length, 1);
assert.deepEqual(
  [industry[0].code, industry[0].name, industry[0].percent, industry[0].leaderCode],
  ['881270', '元件', 3.69, 'sh688655']
);
assert.equal(industry[0].netInflow, 3_094_000_000);

const concepts = parseTonghuashunConceptBoards(conceptHtml, 456).sort(
  (left, right) => right.percent - left.percent
);
assert.equal(concepts.length, 2);
assert.deepEqual(
  [concepts[0].code, concepts[0].secid, concepts[0].name, concepts[0].percent],
  ['300435', '885877', '转基因', 3.37]
);
assert.ok(!concepts.some((item) => item.name.includes('昨日首板')));

const constituents = parseTonghuashunSectorConstituents(constituentsHtml, 789);
assert.equal(constituents.length, 1);
assert.deepEqual(
  [constituents[0].code, constituents[0].name, constituents[0].turnover],
  ['sh688655', '迅捷兴', 8.09]
);
assert.equal(constituents[0].marketCap, 6_739_000_000);

const rankedBoards = parseTonghuashunBlockRankBoards(boardRankJsonp, 'industry', 1000);
assert.equal(rankedBoards.length, 2);
assert.deepEqual(
  [rankedBoards[0].code, rankedBoards[0].name, rankedBoards[0].leaderCode],
  ['881270', '元件', 'sh688655']
);

const hotBoards = parseTonghuashunHotSectorBoards(hotPlateJson, 'concept', 1001);
assert.equal(hotBoards.length, 2);
assert.deepEqual(
  [hotBoards[0].code, hotBoards[0].heat, hotBoards[0].heatRank, hotBoards[0].heatRankChange],
  ['885573', 327504.5, 1, 2]
);

const rankedConstituents = parseTonghuashunBlockRankConstituents(
  constituentRankJsonp,
  1002
);
assert.equal(rankedConstituents.total, 2);
assert.equal(rankedConstituents.items.length, 2);
assert.deepEqual(
  [
    rankedConstituents.items[0].code,
    rankedConstituents.items[0].turnover,
    rankedConstituents.items[0].marketCap
  ],
  ['sh688655', 9.171, 6_738_862_800]
);
assert.equal(rankedConstituents.items[0].amount, 50_520_000);
assert.equal(rankedConstituents.items[0].pe, 35.62);
assert.equal(rankedConstituents.items[0].totalMarketCap, 8_120_000_000);
assert.ok(Math.abs(rankedConstituents.items[0].amplitude - 18.3372921615) < 1e-6);

const detailBoard = parseTonghuashunSectorBoardDetail(
  boardDetailHtml,
  'industry',
  '881270',
  rankedBoards[0],
  1003
);
assert.equal(detailBoard.description, '测试板块的完整定义。');
assert.equal(detailBoard.open, 23800);
assert.equal(detailBoard.amount, 32_025_000_000);
assert.equal(detailBoard.secid, '881270');

const bridgeBoard = parseTonghuashunBlockRankBoard(
  constituentRankJsonp,
  'industry',
  '881270',
  detailBoard,
  1004
);
assert.equal(bridgeBoard.constituentCount, 2);
assert.equal(bridgeBoard.percent, 5.216);
assert.equal(bridgeBoard.description, '测试板块的完整定义。');

assert.match(dataServiceSource, /industry: \['8811', '8812'\]/);
assert.match(dataServiceSource, /\['8853', '8854', '8855', '8856', '8857', '8858', '8859', '8860', '8861'\]/);
assert.match(dataServiceSource, /TONGHUASHUN_SECTOR_GROUPS\[kind\]/);
assert.match(dataServiceSource, /\/199112\/d1000\.js/);
assert.match(dataServiceSource, /ranked = await loadRank\('d', 500\)/);
assert.match(dataServiceSource, /loadRank\('a', 500\)/);
assert.match(dataServiceSource, /const resolvedQuoteCode = \/\^88\\d\{4\}\$\//);
assert.match(centerPanelSource, /type: 'sectorDetailError'/);
assert.match(centerScriptSource, /Math\.max\(number\(board\.constituentCount\), constituents\.length\)/);
assert.match(centerScriptSource, /case 'sectorDetailError'/);
assert.equal(
  parseTonghuashunPageCount('<span class="page_info">1/7</span><a href="/page/9/ajax/1/">'),
  9
);

console.log(
  JSON.stringify({
    source: 'Tonghuashun',
    industryCode: industry[0].code,
    conceptRouteCode: concepts[0].code,
    conceptQuoteCode: concepts[0].secid,
    constituentCode: constituents[0].code,
    lightweightRankCount: rankedBoards.length,
    hotRankCount: hotBoards.length,
    completeConstituentCount: rankedConstituents.total
  })
);
