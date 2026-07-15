const assert = require('assert');
const Module = require('module');

function eventSlot() {
  const listeners = [];
  return {
    event(listener) {
      listeners.push(listener);
      return {
        dispose() {
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
        }
      };
    },
    fire(value) {
      for (const listener of [...listeners]) listener(value);
    }
  };
}

function createFakePicker() {
  const change = eventSlot();
  const accept = eventSlot();
  const hide = eventSlot();
  return {
    items: [],
    activeItems: [],
    selectedItems: [],
    busy: false,
    disposed: false,
    onDidChangeValue: change.event,
    onDidAccept: accept.event,
    onDidHide: hide.event,
    show() {},
    dispose() {
      this.disposed = true;
    },
    fireChange(value) {
      change.fire(value);
    },
    fireAccept() {
      accept.fire();
    },
    fireHide() {
      hide.fire();
    }
  };
}

const pickers = [];
const fakeVscode = {
  window: {
    createQuickPick() {
      const picker = createFakePicker();
      pickers.push(picker);
      return picker;
    }
  }
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return fakeVscode;
  return originalLoad.call(this, request, parent, isMain);
};
const { pickAStock } = require('../out/pickStock');
Module._load = originalLoad;

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function result(code, name) {
  return {
    code,
    secid: code.startsWith('sh') ? '1.' + code.slice(2) : '0.' + code.slice(2),
    name,
    marketLabel: '沪深A股'
  };
}

async function main() {
  const calls = [];
  const service = {
    async searchStocks(query) {
      calls.push(query);
      return [result('sh600036', '招商银行')];
    }
  };
  const pickedPromise = pickAStock(service);
  const picker = pickers.at(-1);
  picker.fireChange('z');
  await wait(45);
  picker.fireChange('zsyh');
  await wait(160);
  assert.deepEqual(calls, ['zsyh'], 'typing should debounce superseded requests');
  assert.equal(picker.items.length, 1);
  assert.equal(picker.items[0].label, 'sh600036 | 招商银行');
  assert.equal(picker.items[0].description, 'A股');
  assert.equal(picker.items[0].alwaysShow, true, 'pinyin results must bypass local Chinese filtering');
  picker.selectedItems = [picker.items[0]];
  picker.fireAccept();
  const picked = await pickedPromise;
  assert.equal(picked.code, 'sh600036');
  assert.equal(picker.disposed, true);

  const literalService = {
    async searchStocks() {
      return [
        result('sh603103', '横店影视'),
        result('sz002415', '海康威视')
      ];
    }
  };
  const literalPromise = pickAStock(literalService);
  const literalPicker = pickers.at(-1);
  literalPicker.fireChange('视');
  await wait(160);
  assert.equal(literalPicker.items.length, 2);
  assert.equal(
    literalPicker.items.every((item) => item.alwaysShow === false),
    true,
    'Chinese searches should keep LeekFund/VS Code native filtering and ranking'
  );
  literalPicker.fireHide();
  assert.equal(await literalPromise, undefined);

  const marketPromise = pickAStock(literalService);
  const marketPicker = pickers.at(-1);
  marketPicker.fireChange('sh');
  await wait(160);
  assert.equal(
    marketPicker.items.every((item) => item.alwaysShow === false),
    true,
    'market prefixes should let QuickPick hide non-matching markets'
  );
  marketPicker.fireHide();
  assert.equal(await marketPromise, undefined);

  const pending = new Map();
  const raceService = {
    searchStocks(query) {
      return new Promise((resolve) => pending.set(query, resolve));
    }
  };
  const cancelledPromise = pickAStock(raceService);
  const racePicker = pickers.at(-1);
  racePicker.fireChange('old');
  await wait(130);
  racePicker.fireChange('new');
  await wait(130);
  pending.get('new')([result('sz000858', '五粮液')]);
  await wait(0);
  assert.equal(racePicker.items[0].label, 'sz000858 | 五粮液');
  pending.get('old')([result('sh600036', '招商银行')]);
  await wait(0);
  assert.equal(
    racePicker.items[0].label,
    'sz000858 | 五粮液',
    'late responses must not replace current input'
  );
  racePicker.fireHide();
  assert.equal(await cancelledPromise, undefined);

  console.log(
    JSON.stringify({
      debounceQuery: calls[0],
      pinyinAlwaysVisible: true,
      nativeLiteralFiltering: true,
      nativeMarketPrefixFiltering: true,
      staleResponseIgnored: true,
      selectedCode: picked.code
    })
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
