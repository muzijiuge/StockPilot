import * as vscode from 'vscode';
import {
  CloudSnapshot,
  getStoredCloudSnapshot,
  StoredCloudSnapshotState,
  updateStoredCloudSnapshots
} from './cloudSnapshot';
import {
  StoredQuoteSnapshotState,
  createStoredQuoteSnapshot,
  getStoredQuoteSnapshot
} from './quoteSnapshot';
import {
  CloudStock,
  DEFAULT_WATCHLIST,
  Holding,
  MarketFilter,
  Quote,
  isAShareCode
} from './types';

const WATCHLIST_KEY = 'aShareLeek.watchlist.v1';
const HOLDINGS_KEY = 'aShareLeek.holdings.v1';
const SECTOR_FOLLOWS_KEY = 'aShareLeek.sectorFollows.v1';
const CLOUD_SNAPSHOTS_KEY = 'aShareLeek.cloudSnapshots.v1';
const QUOTE_SNAPSHOT_KEY = 'aShareLeek.quoteSnapshot.v1';
const SECTOR_CODE_PATTERN = /^BK\d{4}$/i;

export class StateStore {
  private cloudSnapshotWrite: Promise<void> = Promise.resolve();
  private quoteSnapshotWrite: Promise<void> = Promise.resolve();

  public constructor(private readonly context: vscode.ExtensionContext) {
    context.globalState.setKeysForSync([WATCHLIST_KEY, HOLDINGS_KEY, SECTOR_FOLLOWS_KEY]);
  }

  public getSectorFollows(): string[] {
    const saved = this.context.globalState.get<string[]>(SECTOR_FOLLOWS_KEY, []);
    return Array.from(
      new Set(
        saved
          .map((item) => String(item).toUpperCase())
          .filter((item) => SECTOR_CODE_PATTERN.test(item))
      )
    );
  }

  public hasSectorFollow(code: string): boolean {
    return this.getSectorFollows().includes(code.toUpperCase());
  }

  public async toggleSectorFollow(code: string): Promise<boolean> {
    const normalized = code.toUpperCase();
    if (!SECTOR_CODE_PATTERN.test(normalized)) {
      return false;
    }
    if (this.hasSectorFollow(normalized)) {
      await this.setSectorFollows(
        this.getSectorFollows().filter((item) => item !== normalized)
      );
      return false;
    }
    await this.setSectorFollows([...this.getSectorFollows(), normalized]);
    return true;
  }

  public async setSectorFollows(codes: string[]): Promise<void> {
    const clean = Array.from(
      new Set(
        codes
          .map((item) => String(item).toUpperCase())
          .filter((item) => SECTOR_CODE_PATTERN.test(item))
      )
    );
    await this.context.globalState.update(SECTOR_FOLLOWS_KEY, clean);
  }

  public getCloudSnapshot(filter: MarketFilter): CloudSnapshot | undefined {
    return getStoredCloudSnapshot(
      this.context.globalState.get<StoredCloudSnapshotState>(CLOUD_SNAPSHOTS_KEY),
      filter
    );
  }

  public saveCloudSnapshot(
    filter: MarketFilter,
    data: CloudStock[],
    updatedAt: number
  ): Promise<void> {
    const write = this.cloudSnapshotWrite
      .catch(() => undefined)
      .then(async () => {
        const current = this.context.globalState.get<StoredCloudSnapshotState>(
          CLOUD_SNAPSHOTS_KEY
        );
        const next = updateStoredCloudSnapshots(current, filter, data, updatedAt);
        await this.context.globalState.update(CLOUD_SNAPSHOTS_KEY, next);
      });
    this.cloudSnapshotWrite = write;
    return write;
  }

  public getQuoteSnapshot(): Quote[] {
    return getStoredQuoteSnapshot(
      this.context.globalState.get<StoredQuoteSnapshotState>(QUOTE_SNAPSHOT_KEY)
    );
  }

  public saveQuoteSnapshot(quotes: Quote[]): Promise<void> {
    const snapshot = createStoredQuoteSnapshot(quotes);
    const write = this.quoteSnapshotWrite
      .catch(() => undefined)
      .then(() => this.context.globalState.update(QUOTE_SNAPSHOT_KEY, snapshot));
    this.quoteSnapshotWrite = write;
    return write;
  }

  public getWatchlist(): string[] {
    const saved = this.context.globalState.get<string[]>(WATCHLIST_KEY);
    // An explicitly saved empty array means the user removed every stock.
    // Only fall back to defaults before the setting has ever been saved.
    const source = saved ?? DEFAULT_WATCHLIST;
    return Array.from(new Set(source.map((item) => item.toLowerCase()).filter(isAShareCode)));
  }

  public hasWatch(code: string): boolean {
    return this.getWatchlist().includes(code.toLowerCase());
  }

  public async toggleWatch(code: string): Promise<boolean> {
    const normalized = code.toLowerCase();
    if (!isAShareCode(normalized)) {
      return false;
    }
    if (this.hasWatch(normalized)) {
      await this.removeWatch(normalized);
      return false;
    }
    await this.addWatch(normalized);
    return true;
  }

  public async setWatchlist(codes: string[]): Promise<void> {
    const clean = Array.from(new Set(codes.map((item) => item.toLowerCase()).filter(isAShareCode)));
    await this.context.globalState.update(WATCHLIST_KEY, clean);
  }

  public async addWatch(code: string): Promise<void> {
    const normalized = code.toLowerCase();
    if (!isAShareCode(normalized)) {
      return;
    }
    const next = this.getWatchlist();
    if (!next.includes(normalized)) {
      next.push(normalized);
      await this.setWatchlist(next);
    }
  }

  public async removeWatch(code: string): Promise<void> {
    await this.setWatchlist(this.getWatchlist().filter((item) => item !== code.toLowerCase()));
  }

  public getHoldings(): Holding[] {
    const saved = this.context.globalState.get<Holding[]>(HOLDINGS_KEY, []);
    return saved
      .filter((item) => isAShareCode(item.code) && item.amount > 0 && item.cost >= 0)
      .map((item) => ({
        ...item,
        code: item.code.toLowerCase(),
        amount: Number(item.amount),
        cost: Number(item.cost)
      }));
  }

  public async saveHolding(holding: Holding): Promise<void> {
    const normalized: Holding = {
      ...holding,
      code: holding.code.toLowerCase(),
      amount: Number(holding.amount),
      cost: Number(holding.cost),
      updatedAt: Date.now()
    };
    if (!isAShareCode(normalized.code) || normalized.amount <= 0 || normalized.cost < 0) {
      throw new Error('持仓数量必须大于 0，成本价不能小于 0。');
    }
    const next = this.getHoldings().filter((item) => item.code !== normalized.code);
    next.push(normalized);
    await this.context.globalState.update(HOLDINGS_KEY, next);
    await this.addWatch(normalized.code);
  }

  public async deleteHolding(code: string): Promise<void> {
    const next = this.getHoldings().filter((item) => item.code !== code.toLowerCase());
    await this.context.globalState.update(HOLDINGS_KEY, next);
  }
}
