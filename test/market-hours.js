const assert = require('assert');
const { getChinaMarketState } = require('../out/marketHours');

function atShanghaiTime(isoUtc) {
  return getChinaMarketState(new Date(isoUtc));
}

function runMarketHoursTests() {
  const trading = atShanghaiTime('2026-07-14T02:00:00.000Z');
  assert.equal(trading.date, '2026-07-14');
  assert.equal(trading.time, '10:00:00');
  assert.equal(trading.phase, 'trading');
  assert.equal(trading.isTradingTime, true);

  const lunch = atShanghaiTime('2026-07-14T04:00:00.000Z');
  assert.equal(lunch.date, '2026-07-14');
  assert.equal(lunch.time, '12:00:00');
  assert.equal(lunch.phase, 'lunch');
  assert.equal(lunch.isTradingTime, false);

  const weekend = atShanghaiTime('2026-07-18T02:00:00.000Z');
  assert.equal(weekend.date, '2026-07-18');
  assert.equal(weekend.phase, 'closed');
  assert.equal(weekend.label, '周末休市');
  assert.equal(weekend.isTradingTime, false);

  const nationalDay = atShanghaiTime('2026-10-01T02:00:00.000Z');
  assert.equal(nationalDay.date, '2026-10-01');
  assert.equal(nationalDay.phase, 'holiday');
  assert.equal(nationalDay.label, '节假日休市');
  assert.equal(nationalDay.isTradingTime, false);

  const boundaryCases = [
    ['2026-07-14T01:14:00.000Z', 'preopen', false],
    ['2026-07-14T01:15:00.000Z', 'call-auction', true],
    ['2026-07-14T01:25:00.000Z', 'call-auction', true],
    ['2026-07-14T01:30:00.000Z', 'trading', true],
    ['2026-07-14T03:30:00.000Z', 'trading', true],
    ['2026-07-14T03:31:00.000Z', 'lunch', false],
    ['2026-07-14T05:00:00.000Z', 'trading', true],
    ['2026-07-14T06:57:00.000Z', 'trading', true],
    ['2026-07-14T07:00:00.000Z', 'trading', true],
    ['2026-07-14T07:05:00.000Z', 'closing-sync', true],
    ['2026-07-14T07:06:00.000Z', 'closed', false]
  ];
  for (const [iso, phase, allowed] of boundaryCases) {
    const state = atShanghaiTime(iso);
    assert.equal(state.phase, phase, `${state.time} phase`);
    assert.equal(state.isTradingTime, allowed, `${state.time} request gate`);
  }

  return { trading, lunch, weekend, nationalDay, boundaryCases: boundaryCases.length };
}

if (require.main === module) {
  console.log(JSON.stringify(runMarketHoursTests(), null, 2));
}

module.exports = { runMarketHoursTests };
