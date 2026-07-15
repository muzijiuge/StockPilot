export type ChinaMarketPhase =
  | 'preopen'
  | 'call-auction'
  | 'trading'
  | 'lunch'
  | 'closing-sync'
  | 'closed'
  | 'holiday';

export interface ChinaMarketState {
  date: string;
  time: string;
  phase: ChinaMarketPhase;
  isTradingTime: boolean;
  label: string;
}

// 上海证券交易所 2026 年休市安排。周末由运行时单独判断。
// https://www.sse.com.cn/disclosure/announcement/general/c/c_20251222_10802507.shtml
const SSE_HOLIDAYS_2026 = new Set([
  '2026-01-01',
  '2026-01-02',
  '2026-02-16',
  '2026-02-17',
  '2026-02-18',
  '2026-02-19',
  '2026-02-20',
  '2026-02-23',
  '2026-04-06',
  '2026-05-01',
  '2026-05-04',
  '2026-05-05',
  '2026-06-19',
  '2026-09-25',
  '2026-10-01',
  '2026-10-02',
  '2026-10-05',
  '2026-10-06',
  '2026-10-07'
]);

const WEEKEND_NAMES = new Set(['Sat', 'Sun']);

function shanghaiParts(now: Date): {
  date: string;
  time: string;
  weekday: string;
  minute: number;
} {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
  const values = new Map(
    formatter
      .formatToParts(now)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
  const year = values.get('year') || '0000';
  const month = values.get('month') || '00';
  const day = values.get('day') || '00';
  const hour = Number(values.get('hour') || 0);
  const minuteValue = Number(values.get('minute') || 0);
  const second = values.get('second') || '00';
  return {
    date: year + '-' + month + '-' + day,
    time:
      String(hour).padStart(2, '0') + ':' + String(minuteValue).padStart(2, '0') + ':' + second,
    weekday: values.get('weekday') || '',
    minute: hour * 60 + minuteValue
  };
}

export function getChinaMarketState(now = new Date()): ChinaMarketState {
  const parts = shanghaiParts(now);
  if (WEEKEND_NAMES.has(parts.weekday)) {
    return { ...parts, phase: 'closed', isTradingTime: false, label: '周末休市' };
  }
  if (SSE_HOLIDAYS_2026.has(parts.date)) {
    return { ...parts, phase: 'holiday', isTradingTime: false, label: '节假日休市' };
  }
  if (parts.minute < 555) {
    return { ...parts, phase: 'preopen', isTradingTime: false, label: '盘前' };
  }
  if (parts.minute < 570) {
    return { ...parts, phase: 'call-auction', isTradingTime: true, label: '集合竞价' };
  }
  if (parts.minute <= 690) {
    return { ...parts, phase: 'trading', isTradingTime: true, label: '交易中' };
  }
  if (parts.minute < 780) {
    return { ...parts, phase: 'lunch', isTradingTime: false, label: '午间休市' };
  }
  if (parts.minute <= 900) {
    return { ...parts, phase: 'trading', isTradingTime: true, label: '交易中' };
  }
  if (parts.minute <= 905) {
    return { ...parts, phase: 'closing-sync', isTradingTime: true, label: '收盘同步' };
  }
  return { ...parts, phase: 'closed', isTradingTime: false, label: '已休市' };
}
