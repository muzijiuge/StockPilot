import * as vscode from 'vscode';
import { CenterPanel } from './centerPanel';
import { DataService } from './dataService';
import { EastmoneyProxyServer } from './eastmoneyProxyServer';
import { getChinaMarketState } from './marketHours';
import { pickAStock } from './pickStock';
import { HomeProvider, StockNode, StockProvider } from './providers';
import { SidebarViewProvider } from './sidebarView';
import { StateStore } from './stateStore';
import { StockTrendPanel } from './stockTrendPanel';
import { AppSnapshot, Holding, Quote, WatchGroup, isAShareCode } from './types';

function extractCode(value: unknown): string | undefined {
  if (typeof value === 'string' && isAShareCode(value.toLowerCase())) {
    return value.toLowerCase();
  }
  if (value instanceof StockNode) {
    return value.code;
  }
  if (value && typeof value === 'object' && 'code' in value) {
    const code = String((value as { code?: unknown }).code || '').toLowerCase();
    return isAShareCode(code) ? code : undefined;
  }
  return undefined;
}

function extractItemKind(value: unknown): 'holding' | 'stock' | 'index' | undefined {
  if (value instanceof StockNode) {
    return value.kind;
  }
  if (value && typeof value === 'object' && 'kind' in value) {
    const kind = String((value as { kind?: unknown }).kind || '');
    return kind === 'holding' || kind === 'stock' || kind === 'index' ? kind : undefined;
  }
  return undefined;
}

function extractGroupId(value: unknown): string | undefined {
  if (typeof value === 'string' && /^group-[a-z0-9-]{6,64}$/.test(value)) {
    return value;
  }
  if (value && typeof value === 'object' && 'groupId' in value) {
    const groupId = String((value as { groupId?: unknown }).groupId || '').toLowerCase();
    return /^group-[a-z0-9-]{6,64}$/.test(groupId) ? groupId : undefined;
  }
  return undefined;
}

function signed(value: number, digits = 2, suffix = ''): string {
  return (value > 0 ? '+' : '') + value.toFixed(digits) + suffix;
}

function money(value: number): string {
  const prefix = value >= 0 ? '+' : '-';
  return prefix + '¥' + Math.abs(value).toFixed(2);
}

function computeHoldingTotals(snapshot: AppSnapshot): {
  floating: number;
  daily: number;
  marketValue: number;
  totalCost: number;
  profitPercent: number | null;
  pricedHoldings: number;
} {
  const quotes = new Map(snapshot.quotes.map((item) => [item.code, item]));
  const totals = snapshot.holdings.reduce(
    (result, holding) => {
      result.totalCost += holding.amount * holding.cost;
      const quote = quotes.get(holding.code);
      if (!quote || quote.price <= 0) {
        return result;
      }
      const previousClose = quote.previousClose > 0 ? quote.previousClose : quote.price;
      const marketValue = holding.amount * quote.price;
      result.marketValue += marketValue;
      result.floating += holding.amount * (quote.price - holding.cost);
      result.daily += holding.amount * (quote.price - previousClose);
      result.pricedHoldings += 1;
      return result;
    },
    { floating: 0, daily: 0, marketValue: 0, totalCost: 0, pricedHoldings: 0 }
  );
  return {
    ...totals,
    profitPercent:
      totals.pricedHoldings === snapshot.holdings.length && totals.totalCost > 0
        ? (totals.floating / totals.totalCost) * 100
        : null
  };
}

async function inputWatchGroupName(
  title: string,
  value = ''
): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title,
    prompt: '分组名称（1–24 个字符）',
    value,
    ignoreFocusOut: true,
    validateInput(input) {
      const name = input.trim();
      return name.length >= 1 && name.length <= 24
        ? undefined
        : '请输入 1–24 个字符的分组名称';
    }
  });
}

async function createWatchGroup(
  stateStore: StateStore,
  stockProvider: StockProvider,
  title = '新建自选分组'
): Promise<WatchGroup | undefined> {
  const name = await inputWatchGroupName(title);
  if (name === undefined) {
    return undefined;
  }
  const group = await stateStore.createWatchGroup(name);
  stockProvider.notifyStateChanged();
  return group;
}

async function pickWatchGroupTarget(
  stateStore: StateStore,
  stockProvider: StockProvider,
  title: string,
  currentGroupIds: string[] = []
): Promise<{ groupId?: string; name: string } | undefined> {
  type GroupPick = vscode.QuickPickItem & {
    groupId?: string;
    groupName?: string;
    create?: boolean;
  };
  const items: GroupPick[] = [
    {
      label: '$(list-unordered) 自选股',
      description: currentGroupIds.includes('default') ? '已存在' : undefined,
      groupId: '',
      groupName: '自选股'
    },
    ...stateStore.getWatchGroups().map((group) => ({
      label: '$(folder) ' + group.name,
      description: currentGroupIds.includes(group.id) ? '已存在' : undefined,
      groupId: group.id,
      groupName: group.name
    })),
    {
      label: '$(new-folder) 新建分组…',
      alwaysShow: true,
      create: true
    }
  ];
  const selected = await vscode.window.showQuickPick(items, {
    title,
    placeHolder: '选择 A股 下的目标分组',
    ignoreFocusOut: true
  });
  if (!selected) {
    return undefined;
  }
  if (selected.create) {
    const group = await createWatchGroup(stateStore, stockProvider, '新建自选分组');
    return group ? { groupId: group.id, name: group.name } : undefined;
  }
  return {
    groupId: selected.groupId || undefined,
    name: selected.groupName || '自选股'
  };
}

async function inputHolding(
  stateStore: StateStore,
  dataService: DataService,
  stockProvider: StockProvider,
  initialCode?: string
): Promise<void> {
  let code = initialCode;
  let name = '';
  if (!code) {
    const picked = await pickAStock(dataService);
    if (!picked) {
      return;
    }
    code = picked.code;
    name = picked.name;
  }
  const existing = stateStore.getHoldings().find((item) => item.code === code);
  const quote = stockProvider.getQuote(code) || (await dataService.getQuotes([code]))[0];
  name = existing?.name || quote?.name || name || code;

  const amountText = await vscode.window.showInputBox({
    title: '设置持仓 · ' + name,
    prompt: '持仓数量（股）',
    value: String(existing?.amount || 100),
    validateInput(value) {
      const amount = Number(value);
      return Number.isFinite(amount) && amount > 0 ? undefined : '请输入大于 0 的数字';
    },
    ignoreFocusOut: true
  });
  if (!amountText) {
    return;
  }
  const costText = await vscode.window.showInputBox({
    title: '设置持仓 · ' + name,
    prompt: '平均成本价（元）',
    value: String(existing?.cost || quote?.price || 0),
    validateInput(value) {
      const cost = Number(value);
      return Number.isFinite(cost) && cost >= 0 ? undefined : '请输入不小于 0 的数字';
    },
    ignoreFocusOut: true
  });
  if (costText === undefined) {
    return;
  }
  const holding: Holding = {
    code,
    name,
    amount: Number(amountText),
    cost: Number(costText),
    updatedAt: Date.now()
  };
  await stateStore.saveHolding(holding);
  await stockProvider.refresh(false);
  vscode.window.showInformationMessage(name + ' 的本地持仓已保存。');
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const stateStore = new StateStore(context);
  const dataService = new DataService();
  const eastmoneyProxy = new EastmoneyProxyServer();
  const stockProvider = new StockProvider(stateStore, dataService);
  const sidebarProvider = new SidebarViewProvider(context, stockProvider, dataService);
  const homeProvider = new HomeProvider();

  context.subscriptions.push({ dispose: () => eastmoneyProxy.dispose() });
  // Opening the loopback listener performs no upstream/network request, so it
  // is safe even when off-hours polling is disabled. Starting it alongside
  // activation removes listener setup from the first stock-click critical path.
  void eastmoneyProxy.ensureStarted().catch((error: unknown) => {
    console.warn(
      '[A股韭菜盒子] 行情代理预启动失败，将在首次打开时重试：',
      error instanceof Error ? error.message : String(error)
    );
  });

  const stockViewRegistration = vscode.window.registerWebviewViewProvider(
    'aShareLeek.stock',
    sidebarProvider,
    { webviewOptions: { retainContextWhenHidden: true } }
  );
  const homeTree = vscode.window.createTreeView('aShareLeek.home', {
    treeDataProvider: homeProvider,
    showCollapseAll: false
  });

  const marketStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 92);
  marketStatus.name = 'A股韭菜盒子 · 大盘';
  marketStatus.command = 'aShareLeek.openCenter';

  const holdingStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 91);
  holdingStatus.name = 'A股韭菜盒子 · 持仓';
  holdingStatus.command = 'aShareLeek.openAssets';

  const updateStatusBar = (snapshot: AppSnapshot): void => {
    const enabled = vscode.workspace
      .getConfiguration('aShareLeek')
      .get<boolean>('enableStatusBar', true);
    if (!enabled) {
      marketStatus.hide();
      holdingStatus.hide();
      return;
    }
    const index = snapshot.quotes.find((item) => item.code === 'sh000001');
    if (index && index.price > 0) {
      marketStatus.text =
        '$(pulse) 上证 ' + index.price.toFixed(2) + ' ' + signed(index.percent, 2, '%');
      marketStatus.color = new vscode.ThemeColor(
        index.percent >= 0 ? 'charts.red' : 'charts.green'
      );
      marketStatus.tooltip =
        '上证指数：' +
        index.price.toFixed(2) +
        '\n涨跌幅：' +
        signed(index.percent, 2, '%') +
        '\n点击打开韭菜中心';
      marketStatus.show();
    } else {
      marketStatus.text = '$(pulse) 上证 -- --';
      marketStatus.color = undefined;
      marketStatus.tooltip = '暂无最近有效的上证指数报价\n点击打开韭菜中心';
      marketStatus.show();
    }
    const totals = computeHoldingTotals(snapshot);
    if (snapshot.holdings.length) {
      if (totals.pricedHoldings === snapshot.holdings.length) {
        holdingStatus.text = '$(briefcase) 持仓 ' + money(totals.floating);
        holdingStatus.color = new vscode.ThemeColor(
          totals.floating >= 0 ? 'charts.red' : 'charts.green'
        );
        holdingStatus.tooltip =
          '建仓成本：¥' +
          totals.totalCost.toFixed(2) +
          '\n持仓市值：¥' +
          totals.marketValue.toFixed(2) +
          '\n浮动盈亏：' +
          money(totals.floating) +
          '\n盈亏百分比：' +
          (totals.profitPercent === null ? '--' : signed(totals.profitPercent, 2, '%')) +
          '\n当日盈亏：' +
          money(totals.daily) +
          '\n点击打开资产管理';
      } else {
        holdingStatus.text = '$(briefcase) 持仓 --';
        holdingStatus.color = undefined;
        holdingStatus.tooltip =
          '建仓成本：¥' +
          totals.totalCost.toFixed(2) +
          '\n部分持仓暂无最近有效报价\n点击打开资产管理';
      }
      holdingStatus.show();
    } else {
      holdingStatus.text = '$(briefcase) 持仓 未设置';
      holdingStatus.color = undefined;
      holdingStatus.tooltip = '点击打开资产管理并添加本地持仓';
      holdingStatus.show();
    }
  };

  context.subscriptions.push(
    stockProvider,
    sidebarProvider,
    stockViewRegistration,
    homeTree,
    marketStatus,
    holdingStatus,
    stockProvider.onDidUpdateSnapshot(updateStatusBar),
    vscode.commands.registerCommand('aShareLeek.openCenter', () =>
      CenterPanel.createOrShow(
        context,
        stateStore,
        dataService,
        stockProvider,
        'watch'
      )
    ),
    vscode.commands.registerCommand('aShareLeek.openAssets', () =>
      CenterPanel.createOrShow(
        context,
        stateStore,
        dataService,
        stockProvider,
        'assets'
      )
    ),
    vscode.commands.registerCommand('aShareLeek.openNews', () =>
      CenterPanel.createOrShow(
        context,
        stateStore,
        dataService,
        stockProvider,
        'news'
      )
    ),
    vscode.commands.registerCommand('aShareLeek.openCloud', () =>
      CenterPanel.createOrShow(
        context,
        stateStore,
        dataService,
        stockProvider,
        'cloud'
      )
    ),
    vscode.commands.registerCommand('aShareLeek.openSector', (value?: unknown) => {
      const panel = CenterPanel.createOrShow(
        context,
        stateStore,
        dataService,
        stockProvider,
        'sector'
      );
      if (value && typeof value === 'object' && 'code' in value) {
        const board = value as { code?: unknown; kind?: unknown };
        const kind = String(board.kind || '') === 'concept' ? 'concept' : 'industry';
        panel.openSectorBoard(kind, String(board.code || ''));
      }
    }),
    vscode.commands.registerCommand('aShareLeek.openStock', async (value?: unknown) => {
      const code = extractCode(value);
      if (!code) {
        return;
      }
      try {
        await StockTrendPanel.createOrShow(context, eastmoneyProxy, code);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage('打开实时走势失败：' + message);
      }
    }),
    vscode.commands.registerCommand('aShareLeek.refresh', async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: '正在刷新 A 股行情…'
        },
        () => Promise.all([stockProvider.refresh(true), sidebarProvider.refreshSectors(true)])
      );
      vscode.window.setStatusBarMessage('A 股行情已刷新', 1800);
    }),
    vscode.commands.registerCommand('aShareLeek.sort', () => {
      const mode = stockProvider.cycleSort();
      vscode.window.setStatusBarMessage('侧栏排序：' + mode, 1800);
    }),
    vscode.commands.registerCommand('aShareLeek.addStock', async () => {
      try {
        const picked = await pickAStock(dataService);
        if (!picked) {
          return;
        }
        const isIndex = picked.marketLabel.includes('指数');
        const alreadyWatched = stateStore.hasWatch(picked.code);
        const existingGroups = stateStore.getWatchGroupAssignments()[picked.code] ||
          (alreadyWatched ? ['default'] : []);
        const targetGroup = isIndex
          ? undefined
          : await pickWatchGroupTarget(
              stateStore,
              stockProvider,
              '添加“' + picked.name + '”到分组',
              existingGroups
            );
        if (!isIndex && !targetGroup) {
          return;
        }
        await stateStore.addWatch(picked.code, isIndex ? 'index' : 'stock');
        if (!isIndex) {
          if (alreadyWatched) {
            await stateStore.addWatchToGroup(picked.code, targetGroup?.groupId);
          } else {
            await stateStore.replaceWatchGroups(picked.code, targetGroup?.groupId);
          }
        }
        await stockProvider.refresh(false);
        vscode.window.showInformationMessage(
          '已添加 A 股：' +
            picked.name +
            (isIndex ? '（指数）' : '（' + targetGroup?.name + '）')
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage('添加股票失败：' + message);
      }
    }),
    vscode.commands.registerCommand('aShareLeek.addWatchGroup', async () => {
      try {
        const group = await createWatchGroup(stateStore, stockProvider);
        if (group) {
          vscode.window.showInformationMessage('已创建自选分组：' + group.name);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage('创建分组失败：' + message);
      }
    }),
    vscode.commands.registerCommand('aShareLeek.moveWatchToGroup', async (value?: unknown) => {
      const code = extractCode(value);
      if (!code || stateStore.isIndex(code)) {
        return;
      }
      try {
        const hasSourceGroup =
          Boolean(value && typeof value === 'object') &&
          Object.prototype.hasOwnProperty.call(value, 'sourceGroupId');
        const sourceGroupId = hasSourceGroup
          ? String((value as { sourceGroupId?: unknown }).sourceGroupId || '').toLowerCase() ||
            undefined
          : undefined;
        const hasDirectGroup =
          Boolean(value && typeof value === 'object') &&
          Object.prototype.hasOwnProperty.call(value, 'groupId');
        if (hasDirectGroup) {
          const directGroupId = String(
            (value as { groupId?: unknown }).groupId || ''
          ).toLowerCase();
          await stateStore.moveWatchBetweenGroups(
            code,
            sourceGroupId,
            directGroupId || undefined
          );
          stockProvider.notifyStateChanged();
          return;
        }
        const target = await pickWatchGroupTarget(
          stateStore,
          stockProvider,
          '添加自选股票到分组',
          stateStore.getWatchGroupAssignments()[code] || ['default']
        );
        if (!target) {
          return;
        }
        await stateStore.moveWatchBetweenGroups(code, sourceGroupId, target.groupId);
        stockProvider.notifyStateChanged();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage('添加到自选分组失败：' + message);
      }
    }),
    vscode.commands.registerCommand('aShareLeek.renameWatchGroup', async (value?: unknown) => {
      const groupId = extractGroupId(value);
      const group = stateStore.getWatchGroups().find((item) => item.id === groupId);
      if (!group) {
        return;
      }
      try {
        const name = await inputWatchGroupName('重命名自选分组', group.name);
        if (name === undefined) {
          return;
        }
        await stateStore.renameWatchGroup(group.id, name);
        stockProvider.notifyStateChanged();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage('重命名分组失败：' + message);
      }
    }),
    vscode.commands.registerCommand('aShareLeek.deleteWatchGroup', async (value?: unknown) => {
      const groupId = extractGroupId(value);
      const group = stateStore.getWatchGroups().find((item) => item.id === groupId);
      if (!group) {
        return;
      }
      const answer = await vscode.window.showWarningMessage(
        '删除自选分组“' + group.name + '”？股票会保留在其他已有分组；没有其他分组的股票会回到“自选股”。',
        { modal: true },
        '删除分组'
      );
      if (answer === '删除分组') {
        await stateStore.deleteWatchGroup(group.id);
        stockProvider.notifyStateChanged();
      }
    }),
    vscode.commands.registerCommand('aShareLeek.removeStock', async (value?: unknown) => {
      const code = extractCode(value);
      if (!code) {
        return;
      }
      const kind = extractItemKind(value) || 'stock';
      const quote = stockProvider.getQuote(code);
      const holding = stateStore.getHoldings().find((item) => item.code === code);
      const name = holding?.name || quote?.name || code;
      const isHolding = kind === 'holding';
      const hasGroupId =
        kind === 'stock' &&
        Boolean(value && typeof value === 'object') &&
        Object.prototype.hasOwnProperty.call(value, 'groupId');
      const groupId = hasGroupId
        ? String((value as { groupId?: unknown }).groupId || '').toLowerCase() || undefined
        : undefined;
      const answer = await vscode.window.showWarningMessage(
        isHolding
          ? '删除“' + name + '”的本地持仓记录并从侧栏移除？'
          : hasGroupId
            ? '只从当前分组移除“' + name + '”？其他分组中的同一股票会保留。'
          : '从' + (kind === 'index' ? '指数' : '自选') + '列表移除“' + name + '”？',
        { modal: true },
        isHolding ? '删除' : '移除'
      );
      if (answer === (isHolding ? '删除' : '移除')) {
        if (isHolding) {
          await stateStore.deleteHolding(code);
        }
        if (hasGroupId) {
          await stateStore.removeWatchFromGroup(code, groupId);
          stockProvider.notifyStateChanged();
        } else {
          await stateStore.removeWatch(code);
          await stockProvider.refresh(false);
        }
      }
    }),
    vscode.commands.registerCommand('aShareLeek.setHolding', async (value?: unknown) => {
      try {
        await inputHolding(
          stateStore,
          dataService,
          stockProvider,
          extractCode(value)
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage('保存持仓失败：' + message);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('aShareLeek.enableStatusBar')) {
        updateStatusBar(stockProvider.getSnapshot());
      }
    })
  );

  let timer: NodeJS.Timeout | undefined;
  let refreshGeneration = 0;

  const getRefreshSettings = (): {
    interval: number;
    requestOutsideTradingHours: boolean;
  } => {
    const configuration = vscode.workspace.getConfiguration('aShareLeek');
    const configured = configuration.get<number>('refreshInterval', 3000);
    return {
      interval: Math.max(3000, Math.min(300000, Number(configured) || 3000)),
      requestOutsideTradingHours: configuration.get<boolean>(
        'requestOutsideTradingHours',
        false
      )
    };
  };

  const runAutomaticRefresh = async (generation: number): Promise<void> => {
    const settings = getRefreshSettings();
    const market = getChinaMarketState();
    const allowed = market.isTradingTime || settings.requestOutsideTradingHours;
    StockTrendPanel.updateRefreshState({ interval: settings.interval, allowed, market });
    try {
      if (allowed) {
        if (sidebarProvider.isVisible() || CenterPanel.isVisible()) {
          await stockProvider.refresh(false);
        }
        await Promise.all([
          StockTrendPanel.autoRefreshVisible(),
          CenterPanel.autoRefreshVisible(true, market)
        ]);
      } else {
        await CenterPanel.autoRefreshVisible(false, market);
      }
    } catch (error) {
      console.warn(
        '[A股韭菜盒子] 自动刷新失败：',
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      if (generation === refreshGeneration) {
        timer = setTimeout(() => {
          void runAutomaticRefresh(generation);
        }, settings.interval);
      }
    }
  };

  const restartTimer = (): void => {
    refreshGeneration += 1;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    const generation = refreshGeneration;
    const settings = getRefreshSettings();
    const market = getChinaMarketState();
    StockTrendPanel.updateRefreshState({
      interval: settings.interval,
      allowed: market.isTradingTime || settings.requestOutsideTradingHours,
      market
    });
    timer = setTimeout(() => {
      void runAutomaticRefresh(generation);
    }, settings.interval);
  };
  restartTimer();
  context.subscriptions.push(
    new vscode.Disposable(() => {
      if (timer) {
        clearTimeout(timer);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('aShareLeek.refreshInterval') ||
        event.affectsConfiguration('aShareLeek.requestOutsideTradingHours')
      ) {
        restartTimer();
      }
    })
  );

  updateStatusBar(stockProvider.getSnapshot());
  const startupSettings = getRefreshSettings();
  const startupMarket = getChinaMarketState();
  if (
    (startupMarket.isTradingTime || startupSettings.requestOutsideTradingHours) &&
    (sidebarProvider.isVisible() || CenterPanel.isVisible())
  ) {
    void stockProvider.refresh(false);
  }

  const firstRunKey = 'aShareLeek.firstRunShown.v1';
  if (!context.globalState.get<boolean>(firstRunKey, false)) {
    await context.globalState.update(firstRunKey, true);
    setTimeout(() => {
      void vscode.commands.executeCommand('workbench.view.extension.aShareLeek');
      const settings = getRefreshSettings();
      const market = getChinaMarketState();
      if (market.isTradingTime || settings.requestOutsideTradingHours) {
        CenterPanel.createOrShow(
          context,
          stateStore,
          dataService,
          stockProvider,
          'watch'
        );
      }
    }, 1200);
  }
}

export function deactivate(): void {}
