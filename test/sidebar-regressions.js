const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const extensionSource = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
const providerSource = fs.readFileSync(path.join(root, 'src', 'providers.ts'), 'utf8');
const stateStoreSource = fs.readFileSync(path.join(root, 'src', 'stateStore.ts'), 'utf8');
const sidebarViewSource = fs.readFileSync(path.join(root, 'src', 'sidebarView.ts'), 'utf8');
const dataServiceSource = fs.readFileSync(path.join(root, 'src', 'dataService.ts'), 'utf8');
const sidebarScript = fs.readFileSync(path.join(root, 'media', 'sidebar.js'), 'utf8');
const sidebarCss = fs.readFileSync(path.join(root, 'media', 'sidebar.css'), 'utf8');
const centerScript = fs.readFileSync(path.join(root, 'media', 'center.js'), 'utf8');
const centerHtml = fs.readFileSync(path.join(root, 'media', 'center.html'), 'utf8');
const centerPanelSource = fs.readFileSync(path.join(root, 'src', 'centerPanel.ts'), 'utf8');

const stockView = manifest.contributes.views.aShareLeek.find(
  (view) => view.id === 'aShareLeek.stock'
);
assert.equal(stockView.type, 'webview', 'the quote sidebar must use an updateable Webview');
assert.equal(
  manifest.contributes.configuration.properties['aShareLeek.refreshInterval'].default,
  3000,
  'the default quote interval must be three seconds'
);
assert.match(extensionSource, /registerWebviewViewProvider\(\s*'aShareLeek\.stock'/);
assert.match(extensionSource, /isHolding[\s\S]*deleteHolding\(code\)[\s\S]*removeWatch\(code\)/);
assert.doesNotMatch(providerSource, /toLocaleTimeString/, 'quote rows must not render a time suffix');
assert.match(sidebarCss, /\.quote-row\s*\{[\s\S]*display:\s*grid/);
assert.match(sidebarCss, /\.group-arrow::before[\s\S]*border-right:[\s\S]*border-bottom:/);
assert.match(sidebarCss, /\.quote-group\.collapsed > \.group-header \.group-arrow::before[\s\S]*rotate\(-45deg\)/);
assert.doesNotMatch(sidebarScript, /[⌄›]/, 'group disclosure arrows must not use font glyphs');
assert.doesNotMatch(sidebarScript, /padStart|repeat\(\s*['"]\s['"]/, 'columns must not use spaces');
assert.match(sidebarScript, /rows\.appendChild\(row\)/, 'existing row nodes must be moved and reused');
assert.match(sidebarScript, /refreshVisibleTooltip\(\)/, 'the visible hover card must refresh in place');
assert.match(sidebarScript, /tooltipVolumeRatio/);
assert.match(sidebarScript, /tooltipTurnover/);
assert.match(sidebarScript, /quote\.volumeRatio/);
assert.match(sidebarScript, /quote\.turnover/);
assert.doesNotMatch(sidebarScript, /data-action="remove"|>×</, 'rows must not show an inline delete button');
assert.match(sidebarScript, /addEventListener\('contextmenu'/);
assert.match(sidebarScript, /showContextMenu\(row, event\.clientX, event\.clientY\)/);
assert.match(sidebarScript, /data-context-action="remove"/);
assert.match(sidebarScript, /data-context-action="move-group"/);
assert.match(sidebarScript, /showWatchGroupContextMenu/);
assert.match(sidebarScript, /renameWatchGroup/);
assert.match(sidebarScript, /deleteWatchGroup/);
assert.match(sidebarScript, /kind:\s*target\.kind/);
assert.match(sidebarScript, /watchGroupAssignments/);
assert.match(sidebarScript, /ensureWatchGroupSections\(watchGroups\)/);
assert.match(sidebarScript, /'自选股'/);
assert.match(sidebarViewSource, /data-group="stocks"/);
assert.match(sidebarViewSource, /class="group-add"[\s\S]*data-create-watch-group/);
assert.match(sidebarViewSource, /class="quote-group nested-watch-group"[\s\S]*自选股/);
assert.match(sidebarScript, /addEventListener\('dragstart'/);
assert.match(sidebarScript, /addEventListener\('drop'/);
assert.match(sidebarScript, /type: 'assignWatchToGroup'/);
assert.match(sidebarScript, /sourceGroupId:\s*state\.draggedGroupId/);
assert.match(sidebarScript, /从当前分组移除/);
assert.match(sidebarScript, /data-watch-drop-target/);
assert.match(sidebarViewSource, /aShareLeek\.moveWatchToGroup/);
assert.match(sidebarViewSource, /aShareLeek\.addWatchGroup/);
assert.match(extensionSource, /registerCommand\('aShareLeek\.addWatchGroup'/);
assert.match(extensionSource, /registerCommand\('aShareLeek\.moveWatchToGroup'/);
assert.match(extensionSource, /registerCommand\('aShareLeek\.renameWatchGroup'/);
assert.match(extensionSource, /registerCommand\('aShareLeek\.deleteWatchGroup'/);
assert.match(extensionSource, /pickWatchGroupTarget\([\s\S]*添加“/);
assert.match(extensionSource, /hasDirectGroup[\s\S]*moveWatchBetweenGroups/);
assert.match(stateStoreSource, /WATCH_GROUPS_KEY/);
assert.match(stateStoreSource, /addWatchToGroup/);
assert.match(stateStoreSource, /moveWatchBetweenGroups/);
assert.match(stateStoreSource, /removeWatchFromGroup/);
assert.match(stateStoreSource, /Record<string, string\[\]>/);
assert.match(stateStoreSource, /组内股票会回到默认|deleteWatchGroup/);
assert.match(sidebarViewSource, /body\.booting > \* \{ visibility: hidden; \}/);
assert.match(sidebarViewSource, /background: var\(--vscode-sideBar-background\)/);
assert.match(sidebarScript, /document\.body\.classList\.remove\('booting'\)/);
assert.match(sidebarViewSource, /getTopSectorBoards\(kind, 20, force, sort\)/);
assert.match(sidebarViewSource, /sectorSortModes/);
assert.match(sidebarViewSource, /toggleSectorSort/);
assert.match(sidebarViewSource, /data-sector-sort-toggle="industry"/);
assert.match(sidebarViewSource, /data-sector-sort-toggle="concept"/);
assert.match(sidebarScript, /data-sector-sort-toggle/);
assert.match(sidebarScript, /message\.sortModes/);
assert.match(sidebarCss, /\.sector-sort-toggle\.active/);
assert.match(sidebarViewSource, /this\.stockProvider\.refresh\(false\)/);
assert.match(sidebarViewSource, /this\.refreshSectors\(true\)/);
assert.match(sidebarViewSource, /}, 10_000\)/);
assert.match(sidebarViewSource, /this\.stopSectorTimer\(\)/);
assert.match(sidebarViewSource, /executeCommand\('aShareLeek\.openSector',[\s\S]*code:[\s\S]*kind/);
assert.match(centerPanelSource, /openSectorBoard\(kind: SectorBoardKind, code: string, board\?: SectorBoard\)/);
assert.match(dataServiceSource, /q\.10jqka\.com\.cn\/thshy/);
assert.match(dataServiceSource, /kind === 'industry' \? 'thshy' : 'gn'/);
assert.match(dataServiceSource, /parseTonghuashunConceptBoards/);
assert.match(dataServiceSource, /parseTonghuashunSectorConstituents/);
assert.match(dataServiceSource, /v2\/blocksrank\//);
assert.match(dataServiceSource, /['"]\/199112\/d['"]\s*\+/);
assert.match(dataServiceSource, /hot_list_data\/out\/hot_list\/v1\/plate\?type=/);
assert.match(dataServiceSource, /v2\/blockrank\//);
assert.match(dataServiceSource, /\/199112\/d1000\.js/);
assert.match(dataServiceSource, /value\.sort\(\(left, right\) => right\.percent - left\.percent\)/);
assert.match(centerScript, /showSectorView\('detail', false\)/);
assert.match(sidebarScript, /function holdingTotalPercent\(codes, holdings, quotes\)/);
assert.match(sidebarScript, /holdingSummary\.textContent = totalPercent === null/);
assert.match(sidebarCss, /\.group-summary\s*\{[\s\S]*font-family:\s*var\(--vscode-font-family\)[\s\S]*font-weight:\s*500/);
assert.match(extensionSource, /建仓成本：¥/);
assert.match(extensionSource, /盈亏百分比：/);
assert.match(sidebarScript, /var shownPercent = quote \? quote\.percent : 0/);
assert.match(sidebarScript, /percent\.title = '今日涨跌幅'/);
assert.doesNotMatch(
  sidebarScript,
  /kind === 'holding'\s*\?\s*holdingPercent/,
  'holding rows and sorting must preserve daily-change percentage semantics'
);
assert.doesNotMatch(sidebarViewSource, /group-count/, 'group headers must not show item counts');
assert.match(sidebarViewSource, />行业板块<\/span>/);
assert.match(sidebarViewSource, />概念板块<\/span>/);
assert.doesNotMatch(sidebarViewSource, /行业板块涨幅 TOP20|概念板块涨幅 TOP20/);
assert.match(sidebarViewSource, /this\.view\?\.visible/);
assert.match(sidebarViewSource, /onDidChangeVisibility/);
assert.match(extensionSource, /sidebarProvider\.isVisible\(\) \|\| CenterPanel\.isVisible\(\)/);
assert.match(sidebarScript, /reconcileSectorGroup\('industry'/);
assert.match(sidebarScript, /reconcileSectorGroup\('concept'/);
assert.match(sidebarCss, /\.sector-row\s*\{[\s\S]*display:\s*grid/);
assert.match(dataServiceSource, /hot_list_data\/out\/hot_list\/v1\/stock/);
assert.match(dataServiceSource, /xueqiu\.com\/service\/v5\/stock\/screener\/screen/);
assert.match(dataServiceSource, /flow\.10jqka\.com\.cn\/anomaly\/v1\/history/);
assert.match(dataServiceSource, /thsHqCode: digits, marketId: thsMarket, count: 31/);
assert.match(dataServiceSource, /oneMonthAgoShanghaiDateKey/);
assert.match(dataServiceSource, /item\.date >= anomalyCutoffDate/);
assert.match(dataServiceSource, /transaction_history\/service\/v1\/get/);
assert.match(centerHtml, /同花顺异动解读/);
assert.doesNotMatch(centerHtml, /机构研报/);
assert.match(centerScript, /renderProfileAnomalies/);

console.log(
  JSON.stringify({
    sidebarWebview: true,
    hoverRefreshInPlace: true,
    responsiveGridColumns: true,
    removalUi: 'right-click context menu',
    removableGroups: ['holding', 'stock', 'index'],
    sectorRankings: ['industry TOP20', 'concept TOP20', 'Tonghuashun heat sorting'],
    holdingRowMetric: 'daily change percent',
    holdingHeaderMetric: 'weighted floating profit percent',
    groupCountsVisible: false,
    visibilityGatedRefresh: true,
    profileCommunitySources: ['Tonghuashun', 'Xueqiu'],
    profileContent: 'Tonghuashun anomaly interpretations',
    anomalyWindow: 'one rolling month',
    customWatchGroups: true,
    statusBarHoldingDetails: ['cost basis', 'market value', 'profit percent'],
    quoteRefreshInterval: 3000,
    sectorRefreshInterval: 10000,
    timeSuffixRemoved: true
  })
);
