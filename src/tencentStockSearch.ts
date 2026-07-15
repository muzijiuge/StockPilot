import { SearchResult } from './types';

export const TENCENT_STOCK_SEARCH_ENDPOINT =
  'https://proxy.finance.qq.com/ifzqgtimg/appstock/smartbox/search/get?q=';

interface TencentSearchResponse {
  ok: boolean;
  status: number;
  statusText?: string;
  json(): Promise<unknown>;
}

export type TencentSearchFetch = (
  input: string,
  init?: { headers?: Record<string, string> }
) => Promise<TencentSearchResponse>;

function isAllowedSecurityType(value: string): boolean {
  const normalized = value.trim().toUpperCase();
  if (!normalized || /ETF|LOF/.test(normalized)) {
    return false;
  }
  return normalized === 'GP' || normalized === 'ZS' || normalized.startsWith('GP-A');
}

function marketLabel(market: string, securityType: string): string {
  if (securityType === 'ZS') {
    return 'A股指数';
  }
  if (market === 'bj') {
    return '北交所A股';
  }
  return market === 'sh' ? '上证A股' : '深证A股';
}

/**
 * Parses Tencent SmartBox `data.stock` while preserving the server order.
 * SmartBox rows are `[market, code, name, ..., securityType, ...]`.
 */
export function parseTencentStockSearch(payload: unknown): SearchResult[] {
  const rows = (payload as { data?: { stock?: unknown } } | undefined)?.data?.stock;
  if (!Array.isArray(rows)) {
    return [];
  }
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const candidate of rows) {
    if (!Array.isArray(candidate)) {
      continue;
    }
    const market = String(candidate[0] || '').trim().toLowerCase();
    const rawCode = String(candidate[1] || '').trim();
    const name = String(candidate[2] || '').trim();
    const securityType = String(candidate[4] || '').trim().toUpperCase();
    if (
      !['sh', 'sz', 'bj'].includes(market) ||
      !/^\d{6}$/.test(rawCode) ||
      !name ||
      !isAllowedSecurityType(securityType)
    ) {
      continue;
    }
    const code = market + rawCode;
    if (seen.has(code)) {
      continue;
    }
    seen.add(code);
    results.push({
      code,
      secid: (market === 'sh' ? '1.' : '0.') + rawCode,
      name,
      marketLabel: marketLabel(market, securityType)
    });
  }
  return results;
}

export async function searchTencentAStocks(
  query: string,
  fetcher: TencentSearchFetch = fetch as TencentSearchFetch
): Promise<SearchResult[]> {
  const text = query.trim();
  if (!text) {
    return [];
  }
  const response = await fetcher(TENCENT_STOCK_SEARCH_ENDPOINT + encodeURIComponent(text), {
    headers: {
      Accept: 'application/json',
      Referer: 'https://stockapp.finance.qq.com/'
    }
  });
  if (!response.ok) {
    throw new Error(
      'Tencent SmartBox HTTP ' + response.status + ' ' + (response.statusText || '')
    );
  }
  return parseTencentStockSearch(await response.json());
}

