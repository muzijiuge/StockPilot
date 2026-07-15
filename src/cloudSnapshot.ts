import { CloudStock, MarketFilter, isAShareCode } from './types';

const CLOUD_SNAPSHOT_VERSION = 1;
const MAX_SNAPSHOTS = 2;
const MAX_ROWS_PER_SNAPSHOT = 7000;
const VALID_FILTERS = new Set<MarketFilter>([
  'all',
  'sh',
  'sz',
  'bj',
  'star',
  'chinext'
]);

type StoredCloudRow = [string, string, string, number, number, number, string, string];

interface StoredCloudSnapshot {
  filter: MarketFilter;
  updatedAt: number;
  rows: StoredCloudRow[];
}

export interface StoredCloudSnapshotState {
  version: number;
  snapshots: StoredCloudSnapshot[];
}

export interface CloudSnapshot {
  filter: MarketFilter;
  sourceFilter: MarketFilter;
  updatedAt: number;
  data: CloudStock[];
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function decodeRow(value: unknown): CloudStock | undefined {
  if (!Array.isArray(value) || value.length < 8) {
    return undefined;
  }
  const code = String(value[0] || '').toLowerCase();
  const price = finiteNumber(value[3]);
  const percent = finiteNumber(value[4]);
  const marketCap = finiteNumber(value[5]);
  if (
    !isAShareCode(code) ||
    price === undefined ||
    percent === undefined ||
    marketCap === undefined
  ) {
    return undefined;
  }
  return {
    code,
    secid: String(value[1] || ''),
    name: String(value[2] || code),
    price,
    percent,
    marketCap,
    industry: String(value[6] || '其他行业'),
    subIndustry: String(value[7] || value[6] || '其他')
  };
}

function encodeRow(item: CloudStock): StoredCloudRow | undefined {
  const code = String(item.code || '').toLowerCase();
  const price = finiteNumber(item.price);
  const percent = finiteNumber(item.percent);
  const marketCap = finiteNumber(item.marketCap);
  if (
    !isAShareCode(code) ||
    price === undefined ||
    percent === undefined ||
    marketCap === undefined
  ) {
    return undefined;
  }
  return [
    code,
    String(item.secid || ''),
    String(item.name || code),
    price,
    percent,
    marketCap,
    String(item.industry || '其他行业'),
    String(item.subIndustry || item.industry || '其他')
  ];
}

function normalizeState(value: unknown): StoredCloudSnapshotState {
  const candidate = value as Partial<StoredCloudSnapshotState> | undefined;
  if (!candidate || candidate.version !== CLOUD_SNAPSHOT_VERSION) {
    return { version: CLOUD_SNAPSHOT_VERSION, snapshots: [] };
  }
  const snapshots = (Array.isArray(candidate.snapshots) ? candidate.snapshots : [])
    .map((item): StoredCloudSnapshot | undefined => {
      const filter = String((item as StoredCloudSnapshot)?.filter || '') as MarketFilter;
      const updatedAt = finiteNumber((item as StoredCloudSnapshot)?.updatedAt);
      if (!VALID_FILTERS.has(filter) || !updatedAt || updatedAt <= 0) {
        return undefined;
      }
      const rows = (Array.isArray((item as StoredCloudSnapshot)?.rows)
        ? (item as StoredCloudSnapshot).rows
        : []
      )
        .slice(0, MAX_ROWS_PER_SNAPSHOT)
        .filter((row) => Boolean(decodeRow(row))) as StoredCloudRow[];
      return rows.length ? { filter, updatedAt, rows } : undefined;
    })
    .filter((item): item is StoredCloudSnapshot => Boolean(item))
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_SNAPSHOTS);
  return { version: CLOUD_SNAPSHOT_VERSION, snapshots };
}

export function cloudStockMatchesFilter(item: CloudStock, filter: MarketFilter): boolean {
  const code = item.code.toLowerCase();
  switch (filter) {
    case 'sh':
      return code.startsWith('sh');
    case 'sz':
      return code.startsWith('sz');
    case 'bj':
      return code.startsWith('bj');
    case 'star':
      return /^sh68[89]\d{3}$/.test(code);
    case 'chinext':
      return /^sz30[01]\d{3}$/.test(code);
    default:
      return true;
  }
}

export function getStoredCloudSnapshot(
  value: unknown,
  filter: MarketFilter
): CloudSnapshot | undefined {
  const state = normalizeState(value);
  const compatible = state.snapshots
    .filter((snapshot) => snapshot.filter === filter || snapshot.filter === 'all')
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
  if (!compatible) {
    return undefined;
  }
  const decoded = compatible.rows
    .map(decodeRow)
    .filter((item): item is CloudStock => Boolean(item));
  const data =
    compatible.filter === filter || filter === 'all'
      ? decoded
      : decoded.filter((item) => cloudStockMatchesFilter(item, filter));
  if (!data.length) {
    return undefined;
  }
  return {
    filter,
    sourceFilter: compatible.filter,
    updatedAt: compatible.updatedAt,
    data
  };
}

export function updateStoredCloudSnapshots(
  value: unknown,
  filter: MarketFilter,
  data: CloudStock[],
  updatedAt: number
): StoredCloudSnapshotState {
  const state = normalizeState(value);
  const rows = data
    .slice(0, MAX_ROWS_PER_SNAPSHOT)
    .map(encodeRow)
    .filter((item): item is StoredCloudRow => Boolean(item));
  if (
    !VALID_FILTERS.has(filter) ||
    !rows.length ||
    !Number.isFinite(updatedAt) ||
    updatedAt <= 0
  ) {
    return state;
  }
  const current: StoredCloudSnapshot = { filter, updatedAt, rows };
  const remaining = state.snapshots.filter((snapshot) => snapshot.filter !== filter);
  const fullMarket = remaining.find((snapshot) => snapshot.filter === 'all');
  const fallback = fullMarket || remaining[0];
  return {
    version: CLOUD_SNAPSHOT_VERSION,
    snapshots: [current, ...(fallback ? [fallback] : [])].slice(0, MAX_SNAPSHOTS)
  };
}

export function shouldRequestCloudNetwork(
  userInitiated: boolean,
  isTradingTime: boolean,
  requestOutsideTradingHours: boolean
): boolean {
  return userInitiated || isTradingTime || requestOutsideTradingHours;
}
