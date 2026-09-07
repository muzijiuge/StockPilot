(function () {
  'use strict';

  var vscode = acquireVsCodeApi();
  var restored = vscode.getState() || {};
  var validIntervals = ['trend', 'trend5', '1', '5', '15', '30', '60', '101', '102', '103'];
  var state = {
    code: '',
    interval: validIntervals.indexOf(restored.interval) >= 0 ? restored.interval : 'trend',
    watched: false,
    quote: null,
    chart: null,
    extras: null,
    refresh: null,
    chartRenderKey: '',
    chartSignature: '',
    extrasSessionDate: '',
    lastTrades: []
  };
  var trendChart = null;
  var toastTimer = 0;

  function byId(id) {
    return document.getElementById(id);
  }

  function all(selector) {
    return Array.prototype.slice.call(document.querySelectorAll(selector));
  }

  function post(message) {
    vscode.postMessage(message);
  }

  function persist() {
    vscode.setState({ interval: state.interval });
  }

  function number(value, fallback) {
    var parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback == null ? 0 : fallback;
  }

  function signed(value, digits, suffix) {
    var current = number(value);
    return (current > 0 ? '+' : '') + current.toFixed(digits == null ? 2 : digits) + (suffix || '');
  }

  function directionClass(value) {
    var current = number(value);
    if (current > 0.000001) {
      return 'rise';
    }
    if (current < -0.000001) {
      return 'fall';
    }
    return 'flat';
  }

  function price(value) {
    var current = number(value);
    if (!current) {
      return '--';
    }
    return current.toFixed(2);
  }

  function compact(value) {
    var current = number(value);
    var absolute = Math.abs(current);
    if (absolute >= 1000000000000) {
      return (current / 1000000000000).toFixed(2) + '万亿';
    }
    if (absolute >= 100000000) {
      return (current / 100000000).toFixed(2) + '亿';
    }
    if (absolute >= 10000) {
      return (current / 10000).toFixed(2) + '万';
    }
    return current.toFixed(0);
  }

  function formatTime(value, seconds) {
    if (!value) {
      return '--';
    }
    var date = typeof value === 'number' ? new Date(value) : new Date(String(value).replace(/-/g, '/'));
    if (Number.isNaN(date.getTime())) {
      return String(value);
    }
    return date.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: seconds === false ? undefined : '2-digit',
      hour12: false
    });
  }

  function formatClock(value) {
    if (!value) {
      return '--';
    }
    var date = typeof value === 'number' ? new Date(value) : new Date(String(value).replace(/-/g, '/'));
    if (Number.isNaN(date.getTime())) {
      return String(value);
    }
    return date.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
  }

  function setText(id, value) {
    var element = byId(id);
    if (element) {
      element.textContent = value;
    }
  }

  function setDirection(id, value) {
    var element = byId(id);
    if (element) {
      element.className = directionClass(value);
    }
  }

  function showToast(message) {
    var toast = byId('toast');
    toast.textContent = message;
    toast.classList.remove('hidden');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      toast.classList.add('hidden');
    }, 3600);
  }

  function renderIntervals() {
    all('[data-interval]').forEach(function (button) {
      button.classList.toggle('active', button.getAttribute('data-interval') === state.interval);
    });
  }

  function renderWatch() {
    var button = byId('watchButton');
    button.disabled = false;
    button.classList.toggle('active', state.watched);
    button.setAttribute('aria-pressed', String(state.watched));
    button.title = state.watched ? '移出自选' : '加入自选';
  }

  function resetForStock() {
    state.quote = null;
    state.chart = null;
    state.extras = null;
    state.chartRenderKey = '';
    state.chartSignature = '';
    state.extrasSessionDate = '';
    state.lastTrades = [];
    setText('stockName', '正在加载');
    setText('stockCode', state.code || '--');
    setText('quotePrice', '--');
    byId('quotePrice').className = 'quote-price flat';
    setText('quoteChange', '--');
    byId('quoteChange').className = 'quote-change flat';
    setText('quoteUpdated', '--');
    [
      'metricOpen',
      'metricHigh',
      'metricLow',
      'metricPrevious',
      'metricVolume',
      'metricAmount',
      'metricAmplitude',
      'metricTurnover',
      'metricPe',
      'metricPb',
      'metricMarketCap',
      'metricFloatCap'
    ].forEach(function (id) {
      setText(id, '--');
    });
    renderWatch();
    renderIntervals();
    if (trendChart) {
      trendChart.clear();
    }
    byId('chartLoading').textContent = '正在加载走势…';
    byId('chartLoading').classList.remove('hidden');
    byId('extrasLoading').textContent = '正在同步资金与成交明细…';
    byId('extrasLoading').classList.remove('hidden');
    renderEmptyTrades();
    renderEmptyFlow();
  }

  function renderQuote() {
    var quote = state.quote;
    if (!quote) {
      return;
    }
    var direction = directionClass(quote.percent);
    setText('stockName', quote.name || state.code);
    setText('stockCode', quote.code || state.code);
    setText('quotePrice', price(quote.price));
    byId('quotePrice').className = 'quote-price ' + direction;
    setText('quoteChange', signed(quote.change, 2) + '  ' + signed(quote.percent, 2, '%'));
    byId('quoteChange').className = 'quote-change ' + direction;
    setText('quoteUpdated', formatTime(quote.updatedAt));
    setText('metricOpen', price(quote.open));
    setText('metricHigh', price(quote.high));
    setText('metricLow', price(quote.low));
    setText('metricPrevious', price(quote.previousClose));
    setText('metricVolume', quote.volume ? compact(quote.volume) + ' 手' : '--');
    setText('metricAmount', quote.amount ? compact(quote.amount) : '--');
    var amplitude = number(quote.amplitude);
    if (!amplitude && number(quote.previousClose)) {
      amplitude = ((number(quote.high) - number(quote.low)) / number(quote.previousClose)) * 100;
    }
    setText('metricAmplitude', amplitude ? amplitude.toFixed(2) + '%' : '--');
    setText('metricTurnover', number(quote.turnover) ? number(quote.turnover).toFixed(2) + '%' : '--');
    setText('metricPe', number(quote.pe) ? number(quote.pe).toFixed(2) : '--');
    setText('metricPb', number(quote.pb) ? number(quote.pb).toFixed(2) : '--');
    setText('metricMarketCap', number(quote.marketCap) ? compact(quote.marketCap) : '--');
    setText('metricFloatCap', number(quote.floatMarketCap) ? compact(quote.floatMarketCap) : '--');
  }

  function renderEmptyFlow() {
    ['flowMain', 'flowSuper', 'flowLarge', 'flowMedium', 'flowSmall'].forEach(function (id) {
      setText(id, '--');
      setDirection(id, 0);
    });
    setText('extrasUpdated', '--');
  }

  function renderEmptyTrades() {
    var body = byId('tradeRows');
    if (body.dataset.state === 'empty') {
      return;
    }
    body.replaceChildren();
    var row = document.createElement('tr');
    var cell = document.createElement('td');
    cell.colSpan = 4;
    cell.className = 'empty-row';
    cell.textContent = '暂无成交明细';
    row.appendChild(cell);
    body.appendChild(row);
    body.dataset.state = 'empty';
    body.dataset.signature = '';
  }

  function renderFlowValue(id, value) {
    setText(id, compact(value));
    setDirection(id, value);
  }

  function renderExtras() {
    var extras = state.extras;
    if (!extras) {
      return;
    }
    byId('extrasLoading').classList.add('hidden');
    if (
      extras.sessionDate &&
      state.extrasSessionDate &&
      extras.sessionDate !== state.extrasSessionDate
    ) {
      state.lastTrades = [];
      byId('tradeRows').dataset.signature = '';
    }
    state.extrasSessionDate = extras.sessionDate || state.extrasSessionDate;
    setText('extrasUpdated', '更新 ' + formatClock(extras.flowUpdatedAt));
    setText('tradesUpdated', formatClock(extras.tradesUpdatedAt));
    var flow = extras.flow || {};
    renderFlowValue('flowMain', flow.mainNet);
    renderFlowValue('flowSuper', flow.superLargeNet);
    renderFlowValue('flowLarge', flow.largeNet);
    renderFlowValue('flowMedium', flow.mediumNet);
    renderFlowValue('flowSmall', flow.smallNet);

    var trades = Array.isArray(extras.trades) ? extras.trades : [];
    if (trades.length) {
      state.lastTrades = trades.slice();
    } else if (state.lastTrades.length) {
      trades = state.lastTrades;
    }
    if (!trades.length) {
      renderEmptyTrades();
      return;
    }
    var signature = trades
      .map(function (trade) {
        return [trade.time, trade.price, trade.volume, trade.trades, trade.side, trade.auction ? 1 : 0].join(':');
      })
      .join('|');
    var body = byId('tradeRows');
    if (body.dataset.signature === signature) {
      return;
    }
    var existing = Object.create(null);
    Array.prototype.slice.call(body.querySelectorAll('tr[data-trade-key]')).forEach(function (row) {
      existing[row.dataset.tradeKey] = row;
    });
    var fragment = document.createDocumentFragment();
    var occurrences = Object.create(null);
    trades.forEach(function (trade) {
      var baseKey = [trade.time, trade.price, trade.volume, trade.trades, trade.side, trade.auction ? 1 : 0].join(':');
      occurrences[baseKey] = (occurrences[baseKey] || 0) + 1;
      var key = baseKey + '#' + occurrences[baseKey];
      var row = existing[key] || document.createElement('tr');
      row.dataset.tradeKey = key;
      while (row.children.length < 4) {
        row.appendChild(document.createElement('td'));
      }
      var side = trade.auction
        ? '竞价'
        : trade.side === 'buy'
          ? '买入'
          : trade.side === 'sell'
            ? '卖出'
            : '中性';
      var sideValue = trade.side === 'buy' ? 1 : trade.side === 'sell' ? -1 : 0;
      var values = [trade.time || '--', price(trade.price), compact(trade.volume), side];
      Array.prototype.slice.call(row.children).forEach(function (cell, index) {
        if (cell.textContent !== values[index]) {
          cell.textContent = values[index];
        }
        cell.className = '';
        if (index === 1 || index === 3) {
          cell.classList.add(directionClass(sideValue));
        }
        if (index === 3) {
          cell.classList.add('trade-side');
        }
      });
      fragment.appendChild(row);
    });
    var scrollContainer = body.closest('.trade-table-wrap');
    var previousScrollTop = scrollContainer ? scrollContainer.scrollTop : 0;
    body.replaceChildren(fragment);
    body.dataset.state = 'data';
    body.dataset.signature = signature;
    if (scrollContainer && previousScrollTop > 4) {
      scrollContainer.scrollTop = previousScrollTop;
    }
  }

  function movingAverage(dayCount, values) {
    return values.map(function (_item, index) {
      if (index < dayCount - 1) {
        return '-';
      }
      var sum = 0;
      for (var offset = 0; offset < dayCount; offset += 1) {
        sum += number(values[index - offset][1]);
      }
      return +(sum / dayCount).toFixed(3);
    });
  }

  function chartPayloadSignature(data) {
    var points = Array.isArray(data && data.points) ? data.points : [];
    if (!points.length) {
      return [data && data.kind, data && data.interval, 0].join('|');
    }
    var hash = 2166136261;
    points.forEach(function (point) {
      var token = [
        point.time,
        point.price,
        point.average,
        point.open,
        point.close,
        point.high,
        point.low,
        point.volume
      ].join(',');
      for (var index = 0; index < token.length; index += 1) {
        hash ^= token.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
    });
    return [
      data.kind,
      data.interval,
      points.length,
      hash >>> 0
    ].join('|');
  }

  function applyChartOption(option, renderKey, signature) {
    if (state.chartRenderKey === renderKey) {
      trendChart.setOption(
        {
          xAxis: (option.xAxis || []).map(function (axis) {
            return { id: axis.id, data: axis.data };
          }),
          yAxis: (option.yAxis || []).map(function (axis) {
            return { id: axis.id, min: axis.min, max: axis.max };
          }),
          series: (option.series || []).map(function (series) {
            return { id: series.id, data: series.data };
          })
        },
        { notMerge: false, lazyUpdate: true, silent: true }
      );
    } else {
      trendChart.setOption(option, { notMerge: true, lazyUpdate: false, silent: true });
      state.chartRenderKey = renderKey;
    }
    state.chartSignature = signature;
  }

  function renderChart() {
    if (!state.chart) {
      return;
    }
    byId('chartLoading').classList.add('hidden');
    if (!trendChart) {
      trendChart = window.echarts.init(byId('trendChart'), null, { renderer: 'canvas' });
    }
    var data = state.chart;
    var renderKey = [state.code, data.kind, data.interval].join(':');
    var signature = chartPayloadSignature(data);
    if (state.chartRenderKey === renderKey && state.chartSignature === signature) {
      return;
    }
    var intervalNames = {
      trend: '分时',
      trend5: '5 日分时',
      '1': '1 分钟',
      '5': '5 分钟',
      '15': '15 分钟',
      '30': '30 分钟',
      '60': '60 分钟',
      '101': '日 K',
      '102': '周 K',
      '103': '月 K'
    };
    setText(
      'chartSubtitle',
      (data.kind === 'candle' ? '前复权 · ' : '') +
        (intervalNames[data.interval] || data.interval) +
        ' · 东方财富'
    );

    var base = {
      animation: false,
      backgroundColor: '#07090b',
      textStyle: {
        color: '#aeb6c4',
        fontFamily: 'Segoe UI, Microsoft YaHei UI, sans-serif',
        fontSize: 13
      },
      axisPointer: {
        link: [{ xAxisIndex: 'all' }],
        label: { backgroundColor: '#39445a' }
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        backgroundColor: 'rgba(23,27,34,.97)',
        borderColor: '#47546a',
        textStyle: { color: '#e3e7ee', fontSize: 13 }
      },
      grid: [
        { left: 58, right: 18, top: 30, height: '62%' },
        { left: 58, right: 18, top: '72%', height: '24%' }
      ]
    };

    if (data.kind === 'trend') {
      var trendPoints = Array.isArray(data.points) ? data.points : [];
      var trendTimes = trendPoints.map(function (item) {
        var raw = String(item.time || '');
        return data.interval === 'trend5' ? raw.slice(5, 16) : raw.slice(11);
      });
      base.legend = {
        top: 3,
        data: ['价格', '均价'],
        textStyle: { color: '#bdc4cf', fontSize: 13, fontWeight: 600 }
      };
      base.xAxis = [
        {
          id: 'main-x',
          type: 'category',
          data: trendTimes,
          boundaryGap: false,
          axisLine: { lineStyle: { color: '#4a5261' } },
          axisLabel: { color: '#9aa4b4', fontSize: 12, hideOverlap: true },
          splitLine: { show: false }
        },
        {
          id: 'volume-x',
          type: 'category',
          gridIndex: 1,
          data: trendTimes,
          boundaryGap: false,
          axisLabel: { show: false },
          axisLine: { lineStyle: { color: '#4a5261' } }
        }
      ];
      base.yAxis = [
        {
          id: 'main-y',
          scale: true,
          splitNumber: 5,
          axisLabel: { color: '#a4adbc', fontSize: 12 },
          splitLine: { lineStyle: { color: '#2b303a', type: 'dashed' } }
        },
        {
          id: 'volume-y',
          scale: false,
          min: 0,
          max: function (value) { return value.max > 0 ? Math.ceil(value.max * 1.08) : 1; },
          splitNumber: 2,
          gridIndex: 1,
          axisLabel: { color: '#929cac', fontSize: 12, formatter: compact },
          splitLine: { show: true, lineStyle: { color: '#20242b', type: 'dashed' } }
        }
      ];
      base.dataZoom = [{ type: 'inside', xAxisIndex: [0, 1], start: 0, end: 100 }];
      var lastTrendDirection = 0;
      var trendVolumeData = trendPoints.map(function (item, index) {
        var currentPrice = number(item.price);
        var previousPrice = index > 0
          ? number(trendPoints[index - 1].price)
          : number(state.quote && state.quote.previousClose, currentPrice);
        if (currentPrice > previousPrice) {
          lastTrendDirection = 1;
        } else if (currentPrice < previousPrice) {
          lastTrendDirection = -1;
        }
        return {
          value: item.volume,
          itemStyle: {
            color: lastTrendDirection > 0 ? '#ef5b62' : lastTrendDirection < 0 ? '#35b56b' : '#56606f',
            opacity: 0.88,
            borderRadius: [1, 1, 0, 0]
          }
        };
      });
      base.series = [
        {
          id: 'trend-price',
          name: '价格',
          type: 'line',
          showSymbol: false,
          data: trendPoints.map(function (item) { return item.price; }),
          lineStyle: { color: '#37a7ff', width: 1.5 },
          areaStyle: { color: 'rgba(28,126,195,.12)' }
        },
        {
          id: 'trend-average',
          name: '均价',
          type: 'line',
          showSymbol: false,
          data: trendPoints.map(function (item) { return item.average; }),
          lineStyle: { color: '#e2b93b', width: 1 }
        },
        {
          id: 'trend-volume',
          name: '成交量',
          type: 'bar',
          xAxisIndex: 1,
          yAxisIndex: 1,
          barMinHeight: 1,
          barMaxWidth: 6,
          barCategoryGap: '12%',
          data: trendVolumeData
        }
      ];
      applyChartOption(base, renderKey, signature);
      return;
    }

    var points = Array.isArray(data.points) ? data.points : [];
    var categories = points.map(function (item) { return item.time; });
    var candleValues = points.map(function (item) {
      return [item.open, item.close, item.low, item.high];
    });
    var visibleStart = points.length > 100 ? Math.round((1 - 100 / points.length) * 100) : 0;
    base.legend = {
      top: 3,
      data: ['K线', 'MA5', 'MA10', 'MA20'],
      textStyle: { color: '#bdc4cf', fontSize: 13, fontWeight: 600 }
    };
    base.xAxis = [
      {
        id: 'main-x',
        type: 'category',
        data: categories,
        boundaryGap: true,
        axisLine: { lineStyle: { color: '#4a5261' } },
        axisLabel: { color: '#9aa4b4', fontSize: 12, hideOverlap: true },
        splitLine: { show: false },
        min: 'dataMin',
        max: 'dataMax'
      },
      {
        id: 'volume-x',
        type: 'category',
        gridIndex: 1,
        data: categories,
        boundaryGap: true,
        axisLine: { lineStyle: { color: '#4a5261' } },
        axisLabel: { show: false },
        min: 'dataMin',
        max: 'dataMax'
      }
    ];
    base.yAxis = [
      {
        id: 'main-y',
        scale: true,
        axisLabel: { color: '#a4adbc', fontSize: 12 },
        splitLine: { lineStyle: { color: '#2b303a', type: 'dashed' } }
      },
      {
        id: 'volume-y',
        scale: false,
        min: 0,
        max: function (value) { return value.max > 0 ? Math.ceil(value.max * 1.08) : 1; },
        splitNumber: 2,
        gridIndex: 1,
        axisLabel: { color: '#929cac', fontSize: 12, formatter: compact },
        splitLine: { show: true, lineStyle: { color: '#20242b', type: 'dashed' } }
      }
    ];
    base.dataZoom = [
      { type: 'inside', xAxisIndex: [0, 1], start: visibleStart, end: 100 }
    ];
    base.series = [
      {
        id: 'candle',
        name: 'K线',
        type: 'candlestick',
        data: candleValues,
        itemStyle: {
          color: '#f0524f',
          color0: '#36ad67',
          borderColor: '#f0524f',
          borderColor0: '#36ad67'
        }
      },
      {
        id: 'ma5',
        name: 'MA5',
        type: 'line',
        data: movingAverage(5, candleValues),
        showSymbol: false,
        smooth: true,
        lineStyle: { opacity: 0.78, width: 1, color: '#e8d44d' }
      },
      {
        id: 'ma10',
        name: 'MA10',
        type: 'line',
        data: movingAverage(10, candleValues),
        showSymbol: false,
        smooth: true,
        lineStyle: { opacity: 0.78, width: 1, color: '#4da6ff' }
      },
      {
        id: 'ma20',
        name: 'MA20',
        type: 'line',
        data: movingAverage(20, candleValues),
        showSymbol: false,
        smooth: true,
        lineStyle: { opacity: 0.78, width: 1, color: '#d75ee8' }
      },
      {
        id: 'candle-volume',
        name: '成交量',
        type: 'bar',
        xAxisIndex: 1,
        yAxisIndex: 1,
        barMinHeight: 1,
        barMaxWidth: 8,
        barCategoryGap: '12%',
        data: points.map(function (item) {
          return {
            value: item.volume,
            itemStyle: {
              color: number(item.close) >= number(item.open) ? '#ef5b62' : '#35b56b',
              opacity: 0.88,
              borderRadius: [1, 1, 0, 0]
            }
          };
        })
      }
    ];
    applyChartOption(base, renderKey, signature);
  }

  function renderRefreshState() {
    var refresh = state.refresh || {};
    var market = refresh.market || {};
    var phase = refresh.phase || 'idle';
    var allowed = refresh.allowed !== false;
    var dotClass = allowed ? phase : 'paused';
    byId('statusDot').className = 'status-dot ' + dotClass;
    var text = refresh.message || '等待刷新';
    if (refresh.lastUpdatedAt && phase !== 'refreshing') {
      text += ' · ' + formatTime(refresh.lastUpdatedAt, false);
    }
    setText('refreshState', text);
    var marketText = market.label || 'A 股市场';
    if (allowed && refresh.interval) {
      marketText += ' · 每 ' + Math.max(1, Math.round(number(refresh.interval) / 1000)) + ' 秒自动刷新';
    }
    setText('marketState', marketText);
    byId('refreshButton').disabled = phase === 'refreshing';
  }

  document.addEventListener('click', function (event) {
    var target = event.target.closest('button');
    if (!target) {
      return;
    }
    var interval = target.getAttribute('data-interval');
    if (interval && validIntervals.indexOf(interval) >= 0) {
      state.interval = interval;
      persist();
      renderIntervals();
      byId('chartLoading').textContent = '正在切换周期…';
      byId('chartLoading').classList.remove('hidden');
      post({ type: 'changeInterval', interval: interval });
      return;
    }
    if (target.id === 'refreshButton') {
      post({ type: 'manualRefresh' });
      return;
    }
    if (target.id === 'watchButton') {
      target.disabled = true;
      post({ type: 'toggleWatch' });
    }
  });

  window.addEventListener('message', function (event) {
    var message = event.data || {};
    switch (message.type) {
      case 'bootstrap': {
        var changed = message.code && message.code !== state.code;
        state.code = message.code || state.code;
        state.interval = validIntervals.indexOf(message.interval) >= 0 ? message.interval : state.interval;
        state.watched = Boolean(message.watched);
        persist();
        if (changed || !state.quote) {
          resetForStock();
        } else {
          renderWatch();
          renderIntervals();
        }
        break;
      }
      case 'interval':
        if (validIntervals.indexOf(message.interval) >= 0) {
          state.interval = message.interval;
          persist();
          renderIntervals();
        }
        break;
      case 'quote':
        if (message.code !== state.code || !message.data) {
          break;
        }
        if (
          state.quote &&
          number(state.quote.updatedAt) > number(message.data.updatedAt)
        ) {
          break;
        }
        state.quote = message.data;
        renderQuote();
        break;
      case 'chartLoading':
        if (
          message.code === state.code &&
          (message.blocking || !state.chart || state.chart.interval !== message.interval)
        ) {
          byId('chartLoading').textContent = '正在加载走势…';
          byId('chartLoading').classList.remove('hidden');
        }
        break;
      case 'chart':
        if (message.code === state.code && message.data) {
          state.chart = message.data;
          renderChart();
        }
        break;
      case 'extrasLoading':
        if (message.code === state.code && (message.blocking || !state.extras)) {
          byId('extrasLoading').textContent = '正在同步资金与成交明细…';
          byId('extrasLoading').classList.remove('hidden');
        }
        break;
      case 'extras':
        if (message.code === state.code && message.data) {
          state.extras = message.data;
          renderExtras();
        }
        break;
      case 'watchState':
        if (message.code === state.code) {
          state.watched = Boolean(message.watched);
          renderWatch();
        }
        break;
      case 'refreshState':
        state.refresh = message.data || null;
        renderRefreshState();
        break;
      case 'loadError':
        if (message.scope === 'chart') {
          if (state.chart) {
            byId('chartLoading').classList.add('hidden');
          } else {
            byId('chartLoading').textContent = '走势加载失败：' + (message.message || '未知错误');
          }
        } else if (message.scope === 'extras') {
          if (state.extras) {
            byId('extrasLoading').classList.add('hidden');
          } else {
            byId('extrasLoading').textContent = '实时明细暂不可用';
          }
        } else if (message.scope === 'watch') {
          renderWatch();
        }
        if (!message.silent) {
          showToast(message.message || '数据加载失败');
        }
        break;
      default:
        break;
    }
  });

  window.addEventListener('resize', function () {
    if (trendChart) {
      trendChart.resize();
    }
  });

  window.addEventListener('beforeunload', function () {
    if (trendChart) {
      trendChart.dispose();
      trendChart = null;
    }
  });

  renderIntervals();
  renderWatch();
  renderRefreshState();
  post({ type: 'ready' });
})();
