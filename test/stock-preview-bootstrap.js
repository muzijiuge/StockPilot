(function () {
  var saved = { interval: 'trend' };
  var code = 'sh000001';
  var points = [];
  for (var index = 0; index < 241; index += 1) {
    var total = 570 + index + (index > 120 ? 90 : 0);
    var hour = Math.floor(total / 60);
    var minute = total % 60;
    var base = 3913.79 + index * 0.17;
    var wave = Math.sin(index / 7) * 12 + Math.cos(index / 17) * 7;
    points.push({
      time: '2026-07-14 ' + String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0'),
      price: +(base + wave).toFixed(2),
      average: +(3913.79 + index * 0.1 + Math.sin(index / 25) * 4).toFixed(2),
      volume: 180000 + ((index * 39191) % 920000)
    });
  }
  var quote = {
    code: code,
    name: '上证指数',
    price: 3967.13,
    percent: 1.36,
    change: 53.34,
    volume: 580000000,
    amount: 135000000000,
    high: 3967.13,
    low: 3869.3,
    open: 3909.27,
    previousClose: 3913.79,
    amplitude: 2.5,
    turnover: 1.2,
    pe: 15.42,
    pb: 1.53,
    marketCap: 58900000000000,
    floatMarketCap: 52000000000000,
    updatedAt: Date.now()
  };
  var extras = {
    code: code,
    flow: { mainNet: -4703000000, superLargeNet: -2110000000, largeNet: -2593000000, mediumNet: 1350000000, smallNet: 3353000000 },
    trades: Array.from({ length: 30 }, function (_item, index) {
      return { time: '15:' + String(index < 10 ? '0' + index : index) + ':03', price: 3967.13 - index * 0.07, volume: 180 + index * 23, trades: 2, side: index % 3 === 0 ? 'buy' : index % 3 === 1 ? 'sell' : 'neutral' };
    }),
    updatedAt: Date.now(),
    flowUpdatedAt: Date.now(),
    tradesUpdatedAt: Date.now(),
    sessionDate: '2026-07-15',
    partial: false
  };
  function emit(message) { window.postMessage(message, '*'); }
  window.acquireVsCodeApi = function () {
    return {
      getState: function () { return saved; },
      setState: function (next) { saved = next; },
      postMessage: function (message) {
        if (message.type !== 'ready') { return; }
        window.setTimeout(function () {
          emit({ type: 'bootstrap', code: code, interval: 'trend', watched: true });
          emit({ type: 'refreshState', data: { interval: 5000, allowed: false, market: { label: '已休市' }, phase: 'success', lastUpdatedAt: Date.now(), message: '实时数据已更新' } });
          emit({ type: 'quote', code: code, data: quote });
          emit({ type: 'chart', code: code, data: { code: code, name: '上证指数', interval: 'trend', kind: 'trend', points: points } });
          emit({ type: 'extras', code: code, data: extras });
        }, 60);
      }
    };
  };
})();
