const assert = require('assert');
const {
  createStoredQuoteSnapshot,
  getStoredQuoteSnapshot,
  resolveQuoteForDisplay
} = require('../out/quoteSnapshot');

function quote(overrides = {}) {
  return {
    code: 'sh600036',
    secid: '1.600036',
    name: '招商银行',
    price: 37.18,
    percent: -0.19,
    change: -0.07,
    volume: 5058,
    amount: 18800000,
    high: 37.24,
    low: 36.82,
    open: 37.1,
    previousClose: 37.25,
    amplitude: 1.13,
    turnover: 0.2,
    pe: 6.8,
    pb: 0.9,
    marketCap: 900000000000,
    floatMarketCap: 700000000000,
    updatedAt: 2000,
    ...overrides
  };
}

const remembered = quote({ price: 36.96, previousClose: 37.02, updatedAt: 1000 });

const current = resolveQuoteForDisplay(
  quote({ price: 37.18, previousClose: 37.25, updatedAt: 3000 }),
  remembered
);
assert.equal(current.price, 37.18, 'a positive current quote must have highest priority');
assert.equal(current.previousClose, 37.25);

// Premarket fixture: Eastmoney f2 can be zero while f18 is already usable.
const premarket = resolveQuoteForDisplay(
  quote({ price: 0, previousClose: 37.25, percent: -9, change: -3, updatedAt: 4000 }),
  remembered
);
assert.equal(premarket.price, 37.25, 'premarket zero must fall back to previous close');
assert.equal(premarket.previousClose, 37.25);
assert.equal(premarket.percent, 0, 'previous-close fallback should be neutral');
assert.equal(premarket.change, 0, 'previous-close fallback should be neutral');

const unavailable = resolveQuoteForDisplay(
  quote({ price: 0, previousClose: 0, name: '招商银行', updatedAt: 5000 }),
  remembered
);
assert.equal(unavailable.price, 36.96, 'an all-zero response must preserve the last valid price');
assert.equal(unavailable.updatedAt, 1000, 'remembered data must keep its original timestamp');

assert.equal(
  resolveQuoteForDisplay(quote({ price: 0, previousClose: 0 }), undefined),
  undefined,
  'an invalid quote without any fallback must not enter the display cache'
);

const missingPreviousClose = resolveQuoteForDisplay(
  quote({ price: 38, previousClose: 0 }),
  remembered
);
assert.equal(
  missingPreviousClose.previousClose,
  37.02,
  'zero previous-close must not overwrite a remembered valid baseline'
);

const stored = createStoredQuoteSnapshot([
  quote({ price: 0, previousClose: 37.25, updatedAt: 6000 }),
  quote({ code: 'sz000858', secid: '0.000858', name: '五 粮 液', price: 0, previousClose: 0 }),
  quote({ price: 36, previousClose: 35, updatedAt: 1000 })
]);
assert.equal(stored.quotes.length, 1, 'only valid resolved quotes should be persisted');
assert.equal(stored.quotes[0].price, 37.25);
assert.equal(stored.quotes[0].updatedAt, 6000, 'newest duplicate quote should win');

const restored = getStoredQuoteSnapshot(JSON.parse(JSON.stringify(stored)));
assert.equal(restored.length, 1);
assert.equal(restored[0].price, 37.25);

console.log(
  JSON.stringify(
    {
      currentPrice: current.price,
      premarketPrice: premarket.price,
      rememberedPrice: unavailable.price,
      storedQuotes: restored.length
    },
    null,
    2
  )
);
