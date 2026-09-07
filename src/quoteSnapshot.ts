import { Quote, codeToSecid, isAShareCode } from './types';

const QUOTE_SNAPSHOT_VERSION = 1;
const MAX_STORED_QUOTES = 1000;

export interface StoredQuoteSnapshotState {
  version: number;
  quotes: Quote[];
}

function finiteNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positiveNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function usefulName(name: unknown, code: string): string | undefined {
  const normalized = String(name ?? '').trim();
  return normalized && normalized.toLowerCase() !== code ? normalized : undefined;
}

/**
 * Resolves the display quote without ever replacing a valid price with zero.
 * Priority: current price, incoming previous close, then the last valid quote.
 */
export function resolveQuoteForDisplay(
  incoming: Quote,
  previous?: Quote
): Quote | undefined {
  const code = String(incoming.code || previous?.code || '').trim().toLowerCase();
  if (!isAShareCode(code)) {
    return undefined;
  }

  const previousForCode =
    previous && previous.code.toLowerCase() === code && positiveNumber(previous.price)
      ? previous
      : undefined;
  const currentPrice = positiveNumber(incoming.price);
  const incomingPreviousClose = positiveNumber(incoming.previousClose);
  const rememberedPreviousClose = positiveNumber(previousForCode?.previousClose);
  const identity = {
    code,
    secid: String(incoming.secid || previousForCode?.secid || codeToSecid(code)),
    name:
      usefulName(incoming.name, code) ||
      usefulName(previousForCode?.name, code) ||
      code
  };

  if (currentPrice !== undefined) {
    return {
      ...incoming,
      ...identity,
      price: currentPrice,
      // A missing previous-close value would otherwise make daily P/L equal
      // the entire position value. Prefer a remembered value and finally use
      // the current price as a neutral baseline.
      previousClose:
        incomingPreviousClose ?? rememberedPreviousClose ?? currentPrice
    };
  }

  if (incomingPreviousClose !== undefined) {
    return {
      ...incoming,
      ...identity,
      price: incomingPreviousClose,
      previousClose: incomingPreviousClose,
      change: 0,
      percent: 0
    };
  }

  if (previousForCode) {
    return {
      ...previousForCode,
      ...identity
    };
  }

  return undefined;
}

function normalizeStoredQuote(value: unknown): Quote | undefined {
  const candidate = value as Partial<Quote> | undefined;
  if (!candidate) {
    return undefined;
  }
  const code = String(candidate.code || '').trim().toLowerCase();
  if (!isAShareCode(code)) {
    return undefined;
  }
  const quote: Quote = {
    code,
    secid: String(candidate.secid || codeToSecid(code)),
    name: String(candidate.name || code),
    price: finiteNumber(candidate.price),
    percent: finiteNumber(candidate.percent),
    change: finiteNumber(candidate.change),
    volume: finiteNumber(candidate.volume),
    amount: finiteNumber(candidate.amount),
    high: finiteNumber(candidate.high),
    low: finiteNumber(candidate.low),
    open: finiteNumber(candidate.open),
    previousClose: finiteNumber(candidate.previousClose),
    amplitude: finiteNumber(candidate.amplitude),
    volumeRatio: finiteNumber(candidate.volumeRatio),
    turnover: finiteNumber(candidate.turnover),
    pe: finiteNumber(candidate.pe),
    pb: finiteNumber(candidate.pb),
    marketCap: finiteNumber(candidate.marketCap),
    floatMarketCap: finiteNumber(candidate.floatMarketCap),
    updatedAt: Math.max(0, finiteNumber(candidate.updatedAt))
  };
  return resolveQuoteForDisplay(quote);
}

export function getStoredQuoteSnapshot(value: unknown): Quote[] {
  const candidate = value as Partial<StoredQuoteSnapshotState> | undefined;
  if (
    !candidate ||
    candidate.version !== QUOTE_SNAPSHOT_VERSION ||
    !Array.isArray(candidate.quotes)
  ) {
    return [];
  }

  const byCode = new Map<string, Quote>();
  for (const value of candidate.quotes.slice(0, MAX_STORED_QUOTES)) {
    const quote = normalizeStoredQuote(value);
    if (!quote) {
      continue;
    }
    const existing = byCode.get(quote.code);
    if (!existing || quote.updatedAt >= existing.updatedAt) {
      byCode.set(quote.code, quote);
    }
  }
  return Array.from(byCode.values());
}

export function createStoredQuoteSnapshot(quotes: Quote[]): StoredQuoteSnapshotState {
  const byCode = new Map<string, Quote>();
  for (const value of quotes) {
    const quote = normalizeStoredQuote(value);
    if (!quote) {
      continue;
    }
    const existing = byCode.get(quote.code);
    if (!existing || quote.updatedAt >= existing.updatedAt) {
      byCode.set(quote.code, quote);
    }
  }
  return {
    version: QUOTE_SNAPSHOT_VERSION,
    quotes: Array.from(byCode.values())
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_STORED_QUOTES)
  };
}
