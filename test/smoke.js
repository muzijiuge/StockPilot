const assert = require('assert');
const { DataService } = require('../out/dataService');
const { runMarketHoursTests } = require('./market-hours');

async function main() {
  runMarketHoursTests();

  const service = new DataService();
  const [visualSuggestions, marketSuggestions, suggestions, exactSuggestions] =
    await Promise.all([
      service.searchStocks('视'),
      service.searchStocks('sh'),
      service.searchStocks('zsyh'),
      service.searchStocks('600036')
    ]);
  assert.ok(
    visualSuggestions.filter((item) => item.name.includes('视')).length >= 7,
    'a Chinese character query should return the broad LeekFund/Tencent result set'
  );
  assert.ok(
    marketSuggestions.filter((item) => item.code.startsWith('sh')).length >= 10,
    'a market-prefix query should contain a scrollable Shanghai A-share list'
  );
  assert.ok(
    suggestions.some((item) => item.code === 'sh600036'),
    'pinyin initials should suggest 招商银行 while typing'
  );
  assert.ok(
    exactSuggestions.some((item) => item.code === 'sh600036'),
    'an exact numeric code should suggest 招商银行'
  );
  const quotes = await service.getQuotes(['sh600036', 'sh000001']);
  assert.ok(quotes.length >= 2, 'quotes should contain A-share stock and index');
  assert.ok(quotes.every((item) => item.price > 0), 'quote prices should be positive');

  const chart = await service.getChart('sh600036', '101');
  assert.equal(chart.kind, 'candle');
  assert.ok(chart.points.length >= 30, 'daily K-line should contain history');

  // Real-time trends, funds and trades are owned by the full-page proxy and
  // covered by eastmoney-proxy plus browser visual tests, not this legacy service.

  const news = await service.getNews(true);
  assert.ok(news.length > 0, 'news feed should contain current items');

  const profile = await service.getStockProfile('sh600036', true);
  assert.equal(profile.code, 'sh600036');
  assert.ok(profile.fullName.length > 0, 'stock profile should contain company name');
  assert.ok(profile.summary.length > 0, 'stock profile should contain company summary');
  assert.ok(profile.industry.length > 0, 'stock profile should contain industry');
  assert.ok(profile.subIndustry.length > 0, 'stock profile should contain sub-industry');
  assert.ok(profile.concepts.length > 0, 'stock profile should contain concepts');

  const sectorOverview = await service.getSectorOverview(true);
  const industryBoards = await service.getSectorBoards('industry');
  const conceptBoards = await service.getSectorBoards('concept');
  assert.ok(industryBoards.length > 400, 'industry sector list should contain all board levels');
  assert.ok(conceptBoards.length > 400, 'concept sector list should contain current boards');
  assert.equal(sectorOverview.hot3d.length, 12, 'sector overview should contain 3-day hot boards');
  assert.equal(
    sectorOverview.fast3m.length,
    12,
    'sector overview should contain 3-minute fast boards'
  );
  assert.equal(
    sectorOverview.industryTopInflow.length,
    10,
    'sector overview should contain industry inflow TOP10'
  );
  assert.equal(
    sectorOverview.conceptTopInflow.length,
    10,
    'sector overview should contain concept inflow TOP10'
  );
  assert.ok(
    industryBoards.every(
      (item) =>
        /^BK\d+$/.test(item.code) &&
        Number.isFinite(item.threeDayPercent) &&
        Number.isFinite(item.threeMinutePercent) &&
        Number.isFinite(item.netInflow)
    ),
    'sector boards should expose f127, f22 and f62 metrics'
  );
  const sampleBoard =
    industryBoards.find((item) => item.upCount + item.downCount > 0) || industryBoards[0];
  const sectorConstituents = await service.getSectorConstituents(sampleBoard.code, true);
  assert.ok(sectorConstituents.length > 0, 'sector board should contain constituent stocks');
  assert.ok(
    sectorConstituents.every(
      (item) => /^(sh|sz|bj)\d{6}$/.test(item.code) && Number.isFinite(item.marketCap)
    ),
    'sector constituents should use normalized A-share codes'
  );

  const cloud = await service.getCloud('star', true);
  assert.ok(cloud.length > 50, 'STAR market cloud should contain stocks');
  assert.ok(
    cloud.every(
      (item) => typeof item.subIndustry === 'string' && item.subIndustry.trim().length > 0
    ),
    'cloud stocks should contain sub-industry grouping'
  );

  console.log(
    JSON.stringify(
      {
        visualSearchCount: visualSuggestions.length,
        visualLiteralCount: visualSuggestions.filter((item) => item.name.includes('视')).length,
        shPrefixCount: marketSuggestions.filter((item) => item.code.startsWith('sh')).length,
        pinyinSearchCount: suggestions.length,
        exactSearchCount: exactSuggestions.length,
        quoteCount: quotes.length,
        chartPoints: chart.points.length,
        newsCount: news.length,
        profileName: profile.fullName,
        profileConcepts: profile.concepts.length,
        industrySectorCount: industryBoards.length,
        conceptSectorCount: conceptBoards.length,
        hot3dCount: sectorOverview.hot3d.length,
        fast3mCount: sectorOverview.fast3m.length,
        sectorConstituentCount: sectorConstituents.length,
        cloudCount: cloud.length,
        cloudSubIndustries: new Set(cloud.map((item) => item.subIndustry)).size
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
