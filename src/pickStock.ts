import * as vscode from 'vscode';
import { DataService } from './dataService';
import { SearchResult } from './types';

const SEARCH_DEBOUNCE_MS = 100;

interface StockQuickPickItem extends vscode.QuickPickItem {
  readonly value?: SearchResult;
}

const INPUT_HINT: StockQuickPickItem = {
  label: '请输入代码、股票名称或拼音，如：600036、招商银行、zsyh',
  alwaysShow: true
};

function shouldKeepRemoteMatchesVisible(query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!/^[a-z]+$/.test(normalized)) {
    return false;
  }
  // LeekFund lets VS Code filter market/code prefixes locally. This is what
  // turns Tencent's mixed "sh" response into the long Shanghai-only list.
  // Other Latin input is usually a pinyin abbreviation (for example zsyh),
  // which is not present in the Chinese label and must remain explicitly visible.
  return !/^(?:s|sh|sz|b|bj)\d*$/.test(normalized);
}

function buildQuickPickItems(
  results: SearchResult[],
  query: string
): StockQuickPickItem[] {
  const seen = new Set<string>();
  const items: StockQuickPickItem[] = [];
  const alwaysShow = shouldKeepRemoteMatchesVisible(query);
  for (const result of results) {
    if (seen.has(result.code)) {
      continue;
    }
    seen.add(result.code);
    items.push({
      label: result.code + ' | ' + result.name,
      description: result.marketLabel.includes('指数') ? 'A股指数' : 'A股',
      // Literal Chinese/code searches retain LeekFund's native QuickPick
      // filtering and ranking. Pinyin-only results need to bypass that filter.
      alwaysShow,
      value: result
    });
  }
  return items;
}

/** Opens one LeekFund-style input that updates matching A shares as the user types. */
export async function pickAStock(dataService: DataService): Promise<SearchResult | undefined> {
  const picker = vscode.window.createQuickPick<StockQuickPickItem>();
  picker.canSelectMany = false;
  picker.matchOnDescription = true;
  picker.matchOnDetail = false;
  picker.keepScrollPosition = false;
  picker.items = [INPUT_HINT];

  return new Promise<SearchResult | undefined>((resolve) => {
    let settled = false;
    let searchVersion = 0;
    let debounceTimer: NodeJS.Timeout | undefined;
    const subscriptions: vscode.Disposable[] = [];

    const finish = (result: SearchResult | undefined): void => {
      if (settled) {
        return;
      }
      settled = true;
      searchVersion += 1;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }
      while (subscriptions.length) {
        subscriptions.pop()?.dispose();
      }
      picker.dispose();
      resolve(result);
    };

    const runSearch = async (query: string, version: number): Promise<void> => {
      try {
        const results = await dataService.searchStocks(query);
        if (settled || version !== searchVersion) {
          return;
        }
        const items = buildQuickPickItems(results, query);
        picker.items = items;
      } catch (error) {
        if (settled || version !== searchVersion) {
          return;
        }
        picker.items = [
          {
            label: '股票查询失败，请重试',
            description: error instanceof Error ? error.message : String(error),
            alwaysShow: true
          }
        ];
        picker.activeItems = [];
      } finally {
        if (!settled && version === searchVersion) {
          picker.busy = false;
        }
      }
    };

    subscriptions.push(
      picker.onDidChangeValue((value) => {
        const query = value.trim();
        const version = ++searchVersion;
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = undefined;
        }
        picker.items = [];
        picker.activeItems = [];
        if (!query) {
          picker.busy = false;
          picker.items = [INPUT_HINT];
          return;
        }
        picker.busy = true;
        debounceTimer = setTimeout(() => {
          debounceTimer = undefined;
          void runSearch(query, version);
        }, SEARCH_DEBOUNCE_MS);
      }),
      picker.onDidAccept(() => {
        const selected = picker.selectedItems[0] || picker.activeItems[0];
        if (selected?.value) {
          finish(selected.value);
        }
      }),
      picker.onDidHide(() => finish(undefined))
    );

    picker.show();
  });
}
