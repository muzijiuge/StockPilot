(function () {
  var savedState = { tab: 'watch', selectedCode: 'sh600036', interval: '101' };
  var requestedTab = String(window.location.hash || '').replace('#', '');
  var sectorPreviewMode = requestedTab === 'sector-list' ? 'list' : 'overview';
  if (requestedTab.indexOf('sector') === 0) {
    savedState.tab = 'sector';
  } else if (['watch', 'assets', 'news', 'cloud'].indexOf(requestedTab) >= 0) {
    savedState.tab = requestedTab;
  }

  function quote(code, name, price, percent, previous) {
    return {
      code: code,
      secid: (code.indexOf('sh') === 0 ? '1.' : '0.') + code.slice(2),
      name: name,
      price: price,
      percent: percent,
      change: price - previous,
      volume: 747531,
      amount: 2768942723,
      high: Math.max(price, previous) * 1.012,
      low: Math.min(price, previous) * 0.991,
      open: previous * 0.997,
      previousClose: previous,
      marketCap: price * 25219800000,
      updatedAt: Date.now()
    };
  }

  var quotes = [
    quote('sh600036', '招商银行', 37.04, -0.56, 37.25),
    quote('sz000858', '五 粮 液', 73.2, 0.52, 72.82),
    quote('sh688981', '中芯国际', 154.99, 18.02, 131.32),
    quote('sz300750', '宁德时代', 329.4, 3.61, 317.93),
    quote('sh601318', '中国平安', 68.72, 1.26, 67.86),
    quote('sh000001', '上证指数', 3955.78, 1.07, 3913.79),
    quote('sh000300', '沪深300', 4810.26, 1.34, 4746.65),
    quote('sh000016', '上证50', 3022.18, 0.88, 2995.82),
    quote('sh000688', '科创50', 1325.91, 5.32, 1258.94),
    quote('sz399001', '深证成指', 14881.88, 2.47, 14522.85),
    quote('sz399006', '创业板指', 3328.5, 3.12, 3227.79)
  ];

  var watchlist = quotes.map(function (item) {
    return item.code;
  });
  var holdings = [
    { code: 'sh600036', name: '招商银行', amount: 1000, cost: 42.6, updatedAt: Date.now() },
    { code: 'sz000858', name: '五 粮 液', amount: 500, cost: 123.7, updatedAt: Date.now() },
    { code: 'sh688981', name: '中芯国际', amount: 500, cost: 110, updatedAt: Date.now() }
  ];

  function candles(code) {
    var q = quotes.find(function (item) {
      return item.code === code;
    }) || quotes[0];
    var result = [];
    var base = q.price * 0.72;
    for (var index = 0; index < 150; index += 1) {
      var trend = base + index * q.price * 0.0015;
      var wave = Math.sin(index / 5) * q.price * 0.025 + Math.cos(index / 13) * q.price * 0.012;
      var open = trend + wave;
      var close = open + Math.sin(index * 1.7) * q.price * 0.012;
      var high = Math.max(open, close) + q.price * (0.006 + (index % 3) * 0.002);
      var low = Math.min(open, close) - q.price * (0.005 + (index % 4) * 0.0015);
      var date = new Date(2025, 11, 1 + index);
      result.push({
        time: date.toISOString().slice(0, 10),
        open: +open.toFixed(2),
        close: +close.toFixed(2),
        high: +high.toFixed(2),
        low: +low.toFixed(2),
        volume: 260000 + ((index * 7919) % 720000),
        amount: 1,
        percent: 0,
        turnover: 0
      });
    }
    return { code: code, name: q.name, interval: savedState.interval, kind: 'candle', points: result };
  }

  var industries = [
    ['电子', '半导体'],
    ['医药生物', '医疗器械'],
    ['机械设备', '自动化设备'],
    ['计算机', '软件开发'],
    ['电力设备', '电池'],
    ['国防军工', '航空装备'],
    ['通信', '通信设备'],
    ['基础化工', '化学制品'],
    ['有色金属', '能源金属'],
    ['汽车', '汽车零部件']
  ];
  var names = [
    '中芯国际',
    '海光信息',
    '寒武纪',
    '宁德时代',
    '金山办公',
    '药明康德',
    '北方华创',
    '立讯精密',
    '中国软件',
    '紫光国微',
    '汇川技术',
    '迈瑞医疗'
  ];
  var cloud = [];
  for (var group = 0; group < industries.length; group += 1) {
    for (var item = 0; item < 12; item += 1) {
      var seed = group * 12 + item;
      cloud.push({
        code: (seed % 3 === 0 ? 'sh6' : 'sz3') + String(10000 + seed).padStart(5, '0'),
        secid: '1.' + String(600000 + seed),
        name: names[seed % names.length] + (item > 3 ? String(item) : ''),
        price: 18 + (seed * 7.13) % 320,
        percent: Math.sin(seed * 1.31) * 9.7,
        marketCap: 1600000000 + ((seed * 9123456789) % 650000000000),
        industry: industries[group][0],
        subIndustry: industries[group][1]
      });
    }
  }

  var industrySectorNames = [
    '有色金属', '工业金属', '电池', '铜', '非银金融', '锂电池', '证券Ⅲ', '证券Ⅱ',
    '国防军工', '电池化学品', '能源金属', '小金属', '稀土', '锂', '航空装备Ⅲ',
    '铝锌', '半导体', '银行', '电子元件', '汽车整车', '通信设备', '医疗器械',
    '软件开发', '白酒', '光伏设备', '电网设备', '工程机械', '化学制药', '消费电子',
    '航运港口', '煤炭开采', '钢铁', '贵金属', '房地产开发', '保险', '食品加工'
  ];
  var conceptSectorNames = [
    '金融地产风格', '红利破净股', '稀土永磁', '发电机概念', '湖北自贸', '跨境支付',
    '交通设备', 'IPV6', '科创板做市商', '净水概念', '机器人概念', '卫星互联网',
    '低空经济', 'AI 眼镜', '算力租赁', '华为昇腾', '固态电池', '数据要素',
    '商业航天', '核聚变', '量子科技', '光通信模块', '创新药', '无人驾驶',
    '国产软件', '工业母机', '新型城镇化', '消费电子概念', '国企改革', '中特估'
  ];

  function sectorBoard(name, index, kind) {
    var percent = +(0.68 + ((index * 137) % 846) / 100).toFixed(2);
    var code = 'BK' + String((kind === 'industry' ? 400 : 1600) + index).padStart(4, '0');
    return {
      code: code,
      secid: '90.' + code,
      name: name,
      kind: kind,
      price: +(1066 + index * 831.73).toFixed(2),
      percent: percent,
      change: +(percent * (23 + index * 4.3)).toFixed(2),
      turnover: +(1.2 + ((index * 83) % 910) / 100).toFixed(2),
      netInflow: 9800000000 - index * 263000000,
      upCount: 12 + ((index * 17) % 111),
      downCount: (index * 7) % 31,
      leaderName: names[index % names.length],
      leaderCode: quotes[index % 5].code,
      leaderSecid: quotes[index % 5].secid,
      leaderPercent: +(percent + 1.15).toFixed(2),
      threeDayPercent: +(20.59 - index * 0.64).toFixed(2),
      threeMinutePercent: +(0.84 - index * 0.035).toFixed(2),
      updatedAt: Date.now()
    };
  }

  var industryBoards = industrySectorNames.map(function (name, index) {
    return sectorBoard(name, index, 'industry');
  });
  var conceptBoards = conceptSectorNames.map(function (name, index) {
    return sectorBoard(name, index, 'concept');
  });
  var sectorOverview = {
    hot3d: industryBoards.slice(0, 12),
    fast3m: conceptBoards.slice(10, 22),
    industryTopInflow: industryBoards.slice(0, 10),
    conceptTopInflow: conceptBoards.slice(0, 10),
    updatedAt: Date.now()
  };
  var sectorFollows = [industryBoards[0].code, industryBoards[3].code];
  var sectorConstituents = quotes.concat(quotes.slice(0, 5)).map(function (item, index) {
    return {
      code: item.code,
      secid: item.secid,
      name: item.name,
      price: item.price,
      percent: item.percent + index * 0.16,
      change: item.change,
      turnover: 2.13 + index * 0.27,
      netInflow: 1200000000 - index * 53000000,
      marketCap: item.marketCap,
      updatedAt: Date.now()
    };
  });

  var news = [
    ['14:44:06', '创业板指午后拉升，元件、PCB、电池等板块涨幅居前', '创业板指盘中涨超3%，科技成长方向成交活跃。'],
    ['14:31:22', '半导体产业链持续走强，多只科创板个股放量上涨', '先进制程、设备与材料方向获得市场关注。'],
    ['14:18:37', '上证指数站上3950点，市场成交额继续放大', '沪深两市成交活跃，行业板块多数上涨。'],
    ['13:56:10', '北交所指数震荡上行，专精特新概念表现活跃', '公开市场数据显示，中小市值个股交投升温。'],
    ['13:30:18', 'A股午后开盘，主要指数延续强势', '电力设备、电子、计算机板块继续领涨。'],
    ['11:30:02', '午间收盘：创业板指涨幅居前', '两市上涨个股数量超过下跌个股。']
  ].map(function (row, index) {
    return {
      id: String(index),
      time: '2026-07-14 ' + row[0],
      title: row[1],
      summary: row[2],
      url: 'https://finance.eastmoney.com/'
    };
  });

  function emit(message) {
    window.postMessage(message, '*');
  }

  window.acquireVsCodeApi = function () {
    return {
      getState: function () {
        return savedState;
      },
      setState: function (value) {
        savedState = value;
      },
      postMessage: function (message) {
        window.setTimeout(function () {
          if (message.type === 'ready') {
            emit({
              type: 'snapshot',
              data: {
                watchlist: watchlist,
                holdings: holdings,
                quotes: quotes,
                updatedAt: Date.now()
              }
            });
            emit({
              type: 'navigate',
              tab: savedState.tab,
              code: savedState.selectedCode,
              interval: savedState.interval
            });
            emit({ type: 'selectionQuote', data: quotes[0] });
            emit({ type: 'sectorFollows', data: sectorFollows });
            emit({ type: 'profileLoading', code: savedState.selectedCode });
            emit({
              type: 'profile',
              code: savedState.selectedCode,
              data: {
                code: savedState.selectedCode,
                fullName: '招商银行股份有限公司',
                englishName: 'China Merchants Bank Co., Ltd.',
                industry: '银行',
                subIndustry: '股份制银行Ⅱ',
                listingBoard: 'A股',
                listingDate: '2002-04-09',
                exchange: '上海证券交易所',
                registeredCapital: '252.20亿元',
                employeeCount: '116529',
                website: 'https://www.cmbchina.com/',
                business: '吸收公众存款；发放短期、中期和长期贷款；办理国内外结算及银行卡业务。',
                summary: '招商银行是一家全国性股份制商业银行，坚持以客户为中心，持续推进数字化经营与财富管理能力建设。',
                concepts: ['银行', '跨境支付', '互联网金融', 'MSCI中国', '沪股通', '证金持股'],
                community: {
                  thsAvailable: true,
                  thsHeat: 7121.1,
                  thsRank: 81,
                  thsRankChange: 6,
                  thsPeriod: '1小时',
                  xueqiuAvailable: true,
                  xueqiuFollowers: 2920044
                },
                anomalies: [
                  {
                    id: '21868570',
                    date: '2026-07-31',
                    tagName: '大跌',
                    title: '银行板块下跌 · 前期涨幅较大 · 市场风格切换',
                    content: '1、银行板块整体回调，招商银行随板块下跌。\n2、此前多个交易日累计上涨，存在短期回调压力。\n3、市场资金阶段性流向成长方向。'
                  }
                ]
              }
            });
            if (savedState.tab === 'cloud') {
              emit({
                type: 'cloud',
                filter: 'all',
                data: cloud,
                updatedAt: Date.now()
              });
            }
          } else if (message.type === 'selectStock' || message.type === 'changeInterval') {
            if (message.code) {
              savedState.selectedCode = message.code;
            }
            if (message.interval) {
              savedState.interval = message.interval;
            }
            emit({ type: 'chart', data: candles(savedState.selectedCode) });
          } else if (message.type === 'loadSectorOverview' || (message.type === 'setActiveTab' && message.tab === 'sector')) {
            emit({ type: 'sectorOverview', data: sectorOverview, updatedAt: Date.now() });
            if (sectorPreviewMode === 'list') {
              window.setTimeout(function () {
                var button = document.getElementById('openSectorListButton');
                if (button) {
                  button.click();
                }
              }, 160);
              sectorPreviewMode = 'overview';
            }
          } else if (message.type === 'loadSectorBoards') {
            var boardKind = message.kind === 'concept' ? 'concept' : 'industry';
            emit({
              type: 'sectorBoards',
              kind: boardKind,
              data: boardKind === 'concept' ? conceptBoards : industryBoards,
              updatedAt: Date.now()
            });
          } else if (message.type === 'loadSectorDetail') {
            var detailCode = String(message.bkCode || message.code || industryBoards[0].code).toUpperCase();
            var detailBoard = industryBoards.concat(conceptBoards).find(function (item) {
              return item.code === detailCode;
            }) || industryBoards[0];
            emit({
              type: 'sectorDetail',
              bkCode: detailCode,
              board: detailBoard,
              data: sectorConstituents,
              updatedAt: Date.now()
            });
          } else if (message.type === 'toggleSectorFollow') {
            var followCode = String(message.code || '').toUpperCase();
            var followIndex = sectorFollows.indexOf(followCode);
            if (followIndex >= 0) {
              sectorFollows.splice(followIndex, 1);
            } else {
              sectorFollows.push(followCode);
            }
            emit({ type: 'sectorFollows', data: sectorFollows });
          } else if (message.type === 'addSectorStock') {
            emit({ type: 'sectorStockAdded', code: message.code });
          } else if (message.type === 'loadNews' || (message.type === 'setActiveTab' && message.tab === 'news')) {
            emit({ type: 'news', data: news, updatedAt: Date.now() });
          } else if (message.type === 'loadCloud' || (message.type === 'setActiveTab' && message.tab === 'cloud')) {
            emit({
              type: 'cloud',
              filter: message.filter || 'all',
              data: cloud,
              updatedAt: Date.now()
            });
          } else if (message.type === 'pickHolding') {
            emit({
              type: 'holdingCandidate',
              data: { code: 'sz300750', name: '宁德时代', amount: 100, cost: 329.4 }
            });
          }
        }, 80);
      }
    };
  };
})();
