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
  WatchGroup,
  isAIndexCode,
  isAShareCode
} from './types';

const WATCHLIST_KEY = 'aShareLeek.watchlist.v1';
const HOLDINGS_KEY = 'aShareLeek.holdings.v1';
const SECTOR_FOLLOWS_KEY = 'aShareLeek.sectorFollows.v1';
const CLOUD_SNAPSHOTS_KEY = 'aShareLeek.cloudSnapshots.v1';
const QUOTE_SNAPSHOT_KEY = 'aShareLeek.quoteSnapshot.v1';
const INDEX_WATCHLIST_KEY = 'aShareLeek.indexWatchlist.v1';
const WATCH_GROUPS_KEY = 'aShareLeek.watchGroups.v1';
const SECTOR_CODE_PATTERN = /^BK\d{4}$/i;
const WATCH_GROUP_ID_PATTERN = /^group-[a-z0-9-]{6,64}$/;

interface StoredWatchGroupState {
  groups: WatchGroup[];
  assignments: Record<string, string[]>;
}

interface LegacyWatchGroupState {
  groups?: WatchGroup[];
  assignments?: Record<string, unknown>;
}

export class StateStore {
  private cloudSnapshotWrite: Promise<void> = Promise.resolve();
  private quoteSnapshotWrite: Promise<void> = Promise.resolve();

  public constructor(private readonly context: vscode.ExtensionContext) {
    context.globalState.setKeysForSync([
      WATCHLIST_KEY,
      HOLDINGS_KEY,
      SECTOR_FOLLOWS_KEY,
      INDEX_WATCHLIST_KEY,
      WATCH_GROUPS_KEY
    ]);
  }

  private getWatchGroupState(): StoredWatchGroupState {
    const saved = this.context.globalState.get<LegacyWatchGroupState>(WATCH_GROUPS_KEY);
    const groups: WatchGroup[] = [];
    const validIds = new Set<string>();
    const usedNames = new Set<string>();
    for (const item of Array.isArray(saved?.groups) ? saved.groups : []) {
      const id = String(item?.id || '').toLowerCase();
      const name = String(item?.name || '').trim().slice(0, 24);
      const normalizedName = name.toLocaleLowerCase('zh-CN');
      if (
        !WATCH_GROUP_ID_PATTERN.test(id) ||
        !name ||
        validIds.has(id) ||
        usedNames.has(normalizedName)
      ) {
        continue;
      }
      validIds.add(id);
      usedNames.add(normalizedName);
      groups.push({ id, name });
    }

    const watchlist = new Set(this.getWatchlist());
    const assignments: Record<string, string[]> = {};
    const sourceAssignments =
      saved?.assignments && typeof saved.assignments === 'object' ? saved.assignments : {};
    for (const [rawCode, rawMemberships] of Object.entries(sourceAssignments)) {
      const code = rawCode.toLowerCase();
      const memberships = Array.from(
        new Set(
          (Array.isArray(rawMemberships) ? rawMemberships : [rawMemberships])
            .map((item) => String(item || '').toLowerCase())
            .filter((groupId) => groupId === 'default' || validIds.has(groupId))
        )
      );
      if (
        watchlist.has(code) &&
        isAShareCode(code) &&
        !this.isIndex(code) &&
        memberships.length > 0
      ) {
        assignments[code] = memberships;
      }
    }
    return { groups, assignments };
  }

  private async saveWatchGroupState(state: StoredWatchGroupState): Promise<void> {
    await this.context.globalState.update(WATCH_GROUPS_KEY, state);
  }

  public getWatchGroups(): WatchGroup[] {
    return this.getWatchGroupState().groups;
  }

  public getWatchGroupAssignments(): Record<string, string[]> {
    return this.getWatchGroupState().assignments;
  }

  public async createWatchGroup(rawName: string): Promise<WatchGroup> {
    const name = rawName.trim();
    if (!name || name.length > 24) {
      throw new Error('分组名称需要包含 1–24 个字符。');
    }
    const state = this.getWatchGroupState();
    if (state.groups.some((item) => item.name.toLocaleLowerCase('zh-CN') === name.toLocaleLowerCase('zh-CN'))) {
      throw new Error('已经存在同名自选分组。');
    }
    const group: WatchGroup = {
      id:
        'group-' +
        Date.now().toString(36) +
        '-' +
        Math.random().toString(36).slice(2, 8),
      name
    };
    state.groups.push(group);
    await this.saveWatchGroupState(state);
    return group;
  }

  public async renameWatchGroup(groupId: string, rawName: string): Promise<void> {
    const name = rawName.trim();
    if (!name || name.length > 24) {
      throw new Error('分组名称需要包含 1–24 个字符。');
    }
    const state = this.getWatchGroupState();
    const group = state.groups.find((item) => item.id === groupId);
    if (!group) {
      throw new Error('自选分组不存在或已被删除。');
    }
    if (
      state.groups.some(
        (item) =>
          item.id !== groupId &&
          item.name.toLocaleLowerCase('zh-CN') === name.toLocaleLowerCase('zh-CN')
      )
    ) {
      throw new Error('已经存在同名自选分组。');
    }
    group.name = name;
    await this.saveWatchGroupState(state);
  }

  public async deleteWatchGroup(groupId: string): Promise<void> {
    const state = this.getWatchGroupState();
    state.groups = state.groups.filter((item) => item.id !== groupId);
    for (const code of Object.keys(state.assignments)) {
      const remaining = state.assignments[code].filter((item) => item !== groupId);
      if (remaining.length !== state.assignments[code].length) {
        state.assignments[code] = remaining.length ? remaining : ['default'];
      }
    }
    await this.saveWatchGroupState(state);
  }

  private validateWatchGroupTarget(
    state: StoredWatchGroupState,
    groupId?: string
  ): string {
    const target = groupId || 'default';
    if (target !== 'default' && !state.groups.some((item) => item.id === target)) {
      throw new Error('目标自选分组不存在。');
    }
    return target;
  }

  public async replaceWatchGroups(code: string, groupId?: string): Promise<void> {
    const normalized = code.toLowerCase();
    if (!this.hasWatch(normalized) || this.isIndex(normalized)) {
      throw new Error('只有自选个股可以加入分组。');
    }
    const state = this.getWatchGroupState();
    state.assignments[normalized] = [this.validateWatchGroupTarget(state, groupId)];
    await this.saveWatchGroupState(state);
  }

  public async addWatchToGroup(code: string, groupId?: string): Promise<void> {
    const normalized = code.toLowerCase();
    if (!this.hasWatch(normalized) || this.isIndex(normalized)) {
      throw new Error('只有自选个股可以加入分组。');
    }
    const state = this.getWatchGroupState();
    const target = this.validateWatchGroupTarget(state, groupId);
    const current = state.assignments[normalized] || ['default'];
    state.assignments[normalized] = Array.from(new Set([...current, target]));
    await this.saveWatchGroupState(state);
  }

  public async moveWatchBetweenGroups(
    code: string,
    sourceGroupId?: string,
    targetGroupId?: string
  ): Promise<void> {
    const normalized = code.toLowerCase();
    if (!this.hasWatch(normalized) || this.isIndex(normalized)) {
      throw new Error('只有自选个股可以切换分组。');
    }
    const state = this.getWatchGroupState();
    const source = sourceGroupId || 'default';
    const target = this.validateWatchGroupTarget(state, targetGroupId);
    const current = state.assignments[normalized] || ['default'];
    if (source === target) {
      return;
    }
    state.assignments[normalized] = Array.from(
      new Set([...current.filter((item) => item !== source), target])
    );
    await this.saveWatchGroupState(state);
  }

  public async removeWatchFromGroup(code: string, groupId?: string): Promise<boolean> {
    const normalized = code.toLowerCase();
    if (!this.hasWatch(normalized) || this.isIndex(normalized)) {
      return false;
    }
    const state = this.getWatchGroupState();
    const source = groupId || 'default';
    const current = state.assignments[normalized] || ['default'];
    const remaining = current.filter((item) => item !== source);
    if (remaining.length === current.length) {
      return false;
    }
    if (remaining.length) {
      state.assignments[normalized] = remaining;
      await this.saveWatchGroupState(state);
      return false;
    }
    await this.removeWatch(normalized);
    return true;
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

  public getIndexCodes(): string[] {
    const watchlist = new Set(this.getWatchlist());
    const saved = this.context.globalState.get<string[]>(INDEX_WATCHLIST_KEY, []);
    return Array.from(
      new Set([
        ...saved.map((item) => String(item).toLowerCase()),
        ...Array.from(watchlist).filter(isAIndexCode)
      ])
    ).filter((code) => watchlist.has(code));
  }

  public isIndex(code: string, name = ''): boolean {
    const normalized = code.toLowerCase();
    return (
      this.getIndexCodes().includes(normalized) ||
      isAIndexCode(normalized) ||
      /(?:指数|指)$/.test(name.trim())
    );
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

  public async addWatch(code: string, kind?: 'stock' | 'index'): Promise<void> {
    const normalized = code.toLowerCase();
    if (!isAShareCode(normalized)) {
      return;
    }
    if (kind) {
      const current = this.context.globalState.get<string[]>(INDEX_WATCHLIST_KEY, []);
      const next = new Set(current.map((item) => String(item).toLowerCase()));
      if (kind === 'index') {
        next.add(normalized);
      } else {
        next.delete(normalized);
      }
      await this.context.globalState.update(INDEX_WATCHLIST_KEY, Array.from(next));
    }
    const next = this.getWatchlist();
    if (!next.includes(normalized)) {
      next.push(normalized);
      await this.setWatchlist(next);
    }
  }

  public async removeWatch(code: string): Promise<void> {
    const normalized = code.toLowerCase();
    await this.setWatchlist(this.getWatchlist().filter((item) => item !== normalized));
    const indexCodes = this.context.globalState.get<string[]>(INDEX_WATCHLIST_KEY, []);
    await this.context.globalState.update(
      INDEX_WATCHLIST_KEY,
      indexCodes.filter((item) => String(item).toLowerCase() !== normalized)
    );
    const groupState = this.getWatchGroupState();
    delete groupState.assignments[normalized];
    await this.saveWatchGroupState(groupState);
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
