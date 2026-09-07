(function () {
  'use strict';

  var vscode = acquireVsCodeApi();
  var restored = vscode.getState() || {};
  var state = {
    snapshot: {
      watchlist: [],
      indexCodes: [],
      watchGroups: [],
      watchGroupAssignments: {},
      holdings: [],
      quotes: [],
      sortMode: 0,
      updatedAt: 0
    },
    sectors: { industry: [], concept: [] },
    collapsed: Object.assign(
      { holding: false, stocks: false, stock: false, index: true, industry: false, concept: false },
      restored.collapsed || {}
    ),
    hoveredKey: '',
    contextTarget: null,
    contextGroupId: '',
    draggedCode: '',
    draggedGroupId: ''
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function number(value) {
    var parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function price(value) {
    var current = number(value);
    return current > 0 ? current.toFixed(2) : '--';
  }

  function signed(value, suffix) {
    var current = number(value);
    return (current > 0 ? '+' : '') + current.toFixed(2) + (suffix || '');
  }

  function compact(value) {
    var current = number(value);
    var absolute = Math.abs(current);
    if (absolute >= 100000000) {
      return (current / 100000000).toFixed(2) + '亿';
    }
    if (absolute >= 10000) {
      return (current / 10000).toFixed(2) + '万';
    }
    return current.toFixed(0);
  }

  function direction(value) {
    var current = number(value);
    return current > 0.000001 ? 'rise' : current < -0.000001 ? 'fall' : 'flat';
  }

  function quoteMap() {
    var result = Object.create(null);
    state.snapshot.quotes.forEach(function (quote) {
      result[quote.code] = quote;
    });
    return result;
  }

  function isIndex(code) {
    return (state.snapshot.indexCodes || []).indexOf(code) >= 0 ||
      /^sh(?:000|930|931|932|950|980|990)\d{3}$/.test(code) ||
      /^sz399\d{3}$/.test(code);
  }

  function watchMemberships(code, assignments) {
    var saved = assignments[code];
    var memberships = Array.isArray(saved) ? saved : saved ? [saved] : [];
    return memberships.length ? memberships : ['default'];
  }

  function holdingTotalPercent(codes, holdings, quotes) {
    var totalCost = 0;
    var totalValue = 0;
    codes.forEach(function (code) {
      var holding = holdings[code];
      var quote = quotes[code];
      var amount = holding ? number(holding.amount) : 0;
      var cost = holding ? number(holding.cost) : 0;
      var current = quote ? number(quote.price) : 0;
      if (amount > 0 && cost > 0 && current > 0) {
        totalCost += amount * cost;
        totalValue += amount * current;
      }
    });
    return totalCost > 0 ? ((totalValue - totalCost) / totalCost) * 100 : null;
  }

  function sortGroupCodes(codes, quotes) {
    if (!state.snapshot.sortMode) {
      return codes.slice();
    }
    return codes.slice().sort(function (left, right) {
      var leftValue = quotes[left] ? number(quotes[left].percent) : null;
      var rightValue = quotes[right] ? number(quotes[right].percent) : null;
      if (leftValue === null || rightValue === null) {
        return leftValue === rightValue ? 0 : leftValue === null ? 1 : -1;
      }
      return state.snapshot.sortMode === 1
        ? leftValue - rightValue
        : rightValue - leftValue;
    });
  }

  function groupSection(kind) {
    return Array.prototype.find.call(document.querySelectorAll('.quote-group'), function (section) {
      return section.dataset.group === kind;
    });
  }

  function groupRows(kind) {
    var section = groupSection(kind);
    return section ? section.querySelector('.group-rows') : null;
  }

  function createRow(code, kind, groupKey) {
    var row = document.createElement('div');
    row.className = 'quote-row';
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.dataset.code = code;
    row.dataset.kind = kind;
    row.dataset.groupKey = groupKey;
    row.draggable = kind === 'stock';
    row.innerHTML =
      '<span class="trend-icon flat" data-cell="trend">◆</span>' +
      '<span class="quote-percent flat" data-cell="percent">--</span>' +
      '<span class="quote-price" data-cell="price">--</span>' +
      '<span class="quote-name" data-cell="name">「' + code + '」</span>';
    return row;
  }

  function updateRow(row, quote) {
    var hasQuote = Boolean(quote && number(quote.price) > 0);
    var shownPercent = quote ? quote.percent : 0;
    var hasPercent = hasQuote;
    var className = direction(shownPercent);
    var trend = row.querySelector('[data-cell="trend"]');
    var percent = row.querySelector('[data-cell="percent"]');
    var currentPrice = row.querySelector('[data-cell="price"]');
    var name = row.querySelector('[data-cell="name"]');
    trend.textContent = hasPercent ? (number(shownPercent) >= 0 ? '▲' : '▼') : '◆';
    trend.className = 'trend-icon ' + (hasPercent ? className : 'flat');
    percent.textContent = hasPercent ? signed(shownPercent, '%') : '--';
    percent.className = 'quote-percent ' + (hasPercent ? className : 'flat');
    percent.title = '今日涨跌幅';
    currentPrice.textContent = hasQuote ? price(quote.price) : '--';
    name.textContent = '「' + (quote && quote.name ? quote.name : row.dataset.code) + '」';
    row.setAttribute('aria-label',
      (quote && quote.name ? quote.name : row.dataset.code) + ' ' +
      (hasQuote
        ? currentPrice.textContent + ' ' +
          '今日涨跌 ' + percent.textContent
        : '等待行情')
    );
  }

  function findRow(container, code) {
    return Array.prototype.find.call(container.children, function (child) {
      return child.dataset.code === code;
    });
  }

  function reconcileGroup(groupKey, rowKind, title, codes, quotes) {
    var section = groupSection(groupKey);
    var rows = groupRows(groupKey);
    if (!section || !rows) {
      return;
    }
    var expected = Object.create(null);
    sortGroupCodes(codes, quotes).forEach(function (code) {
      expected[code] = true;
      var row = findRow(rows, code);
      if (!row) {
        row = createRow(code, rowKind, groupKey);
      }
      row.dataset.kind = rowKind;
      row.dataset.groupKey = groupKey;
      row.dataset.watchGroupId = section.dataset.watchGroupId || '';
      row.draggable = rowKind === 'stock';
      updateRow(row, quotes[code]);
      rows.appendChild(row);
    });
    Array.prototype.slice.call(rows.children).forEach(function (row) {
      if (!expected[row.dataset.code]) {
        if (state.hoveredKey === groupKey + ':' + row.dataset.code) {
          hideTooltip();
        }
        row.remove();
      }
    });
    section.querySelector('.group-title').textContent = title;
    applyCollapsedState(groupKey);
  }

  function ensureWatchGroupSections(groups) {
    var container = groupRows('stocks');
    var expected = Object.create(null);
    (groups || []).forEach(function (group) {
      var groupKey = 'watch-' + group.id;
      expected[groupKey] = true;
      var section = groupSection(groupKey);
      if (!section) {
        section = document.createElement('section');
        section.className = 'quote-group nested-watch-group custom-watch-group';
        section.dataset.group = groupKey;
        section.dataset.watchGroupId = group.id;
        var header = document.createElement('button');
        header.className = 'group-header';
        header.type = 'button';
        header.dataset.toggleGroup = groupKey;
        header.dataset.watchGroupId = group.id;
        header.dataset.watchDropTarget = '';
        header.setAttribute('aria-expanded', 'true');
        header.innerHTML =
          '<span class="group-arrow" aria-hidden="true"></span>' +
          '<span class="group-title"></span>';
        var rows = document.createElement('div');
        rows.className = 'group-rows';
        rows.dataset.groupRows = groupKey;
        rows.dataset.watchDropTarget = '';
        rows.dataset.watchGroupId = group.id;
        section.appendChild(header);
        section.appendChild(rows);
      }
      section.dataset.watchGroupId = group.id;
      section.querySelector('.group-header').dataset.watchGroupId = group.id;
      section.querySelector('.group-rows').dataset.watchGroupId = group.id;
      container.appendChild(section);
      if (!(groupKey in state.collapsed)) {
        state.collapsed[groupKey] = false;
      }
    });
    Array.prototype.slice.call(document.querySelectorAll('.custom-watch-group')).forEach(
      function (section) {
        var groupKey = section.dataset.group;
        if (!expected[groupKey]) {
          if (state.hoveredKey.indexOf(groupKey + ':') === 0) {
            hideTooltip();
          }
          delete state.collapsed[groupKey];
          section.remove();
        }
      }
    );
    persist();
  }

  function createSectorRow(item) {
    var row = document.createElement('div');
    row.className = 'sector-row';
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.dataset.code = item.code;
    row.innerHTML =
      '<span class="sector-rank" data-cell="rank">--</span>' +
      '<span class="sector-percent flat" data-cell="percent">--</span>' +
      '<span class="sector-name" data-cell="name">--</span>';
    return row;
  }

  function updateSectorRow(row, item, rank) {
    var className = direction(item.percent);
    row.dataset.code = item.code;
    row.dataset.sectorKind = item.kind;
    row.querySelector('[data-cell="rank"]').textContent = String(rank);
    var percent = row.querySelector('[data-cell="percent"]');
    percent.textContent = signed(item.percent, '%');
    percent.className = 'sector-percent ' + className;
    row.querySelector('[data-cell="name"]').textContent = item.name || item.code;
    row.setAttribute(
      'aria-label',
      '第' + String(rank) + '名 ' + (item.name || item.code) + ' ' + percent.textContent
    );
  }

  function reconcileSectorGroup(kind, title, items) {
    var section = groupSection(kind);
    var rows = groupRows(kind);
    var expected = Object.create(null);
    (items || []).slice(0, 20).forEach(function (item, index) {
      expected[item.code] = true;
      var row = findRow(rows, item.code);
      if (!row) {
        row = createSectorRow(item);
      }
      updateSectorRow(row, item, index + 1);
      rows.appendChild(row);
    });
    Array.prototype.slice.call(rows.children).forEach(function (row) {
      if (!expected[row.dataset.code]) {
        row.remove();
      }
    });
    section.querySelector('.group-title').textContent = title;
    applyCollapsedState(kind);
  }

  function render() {
    var quotes = quoteMap();
    var holdingCodes = state.snapshot.holdings.map(function (holding) {
      return holding.code;
    });
    var holdings = Object.create(null);
    state.snapshot.holdings.forEach(function (holding) {
      holdings[holding.code] = holding;
    });
    var indexCodes = state.snapshot.watchlist.filter(isIndex);
    var indices = Object.create(null);
    indexCodes.forEach(function (code) {
      indices[code] = true;
    });
    var stockCodes = state.snapshot.watchlist.filter(function (code) {
      return !holdings[code] && !indices[code];
    });
    var watchGroups = state.snapshot.watchGroups || [];
    var assignments = state.snapshot.watchGroupAssignments || {};
    var validGroupIds = Object.create(null);
    watchGroups.forEach(function (group) {
      validGroupIds[group.id] = true;
    });
    ensureWatchGroupSections(watchGroups);
    var totalPercent = holdingTotalPercent(holdingCodes, holdings, quotes);
    reconcileGroup('holding', 'holding', '我的持仓', holdingCodes, quotes);
    var holdingSummary = document.querySelector('[data-holding-summary]');
    holdingSummary.textContent = totalPercent === null ? '' : signed(totalPercent, '%');
    holdingSummary.className = 'group-summary ' +
      (totalPercent === null ? 'flat' : direction(totalPercent));
    reconcileGroup(
      'stock',
      'stock',
      '自选股',
      stockCodes.filter(function (code) {
        return watchMemberships(code, assignments).indexOf('default') >= 0;
      }),
      quotes
    );
    watchGroups.forEach(function (group) {
      reconcileGroup(
        'watch-' + group.id,
        'stock',
        group.name,
        stockCodes.filter(function (code) {
          return (
            validGroupIds[group.id] &&
            watchMemberships(code, assignments).indexOf(group.id) >= 0
          );
        }),
        quotes
      );
    });
    reconcileGroup('index', 'index', '指数', indexCodes, quotes);
    reconcileSectorGroup('industry', '行业板块', state.sectors.industry);
    reconcileSectorGroup('concept', '概念板块', state.sectors.concept);
    refreshVisibleTooltip();
  }

  function applyCollapsedState(kind) {
    var section = groupSection(kind);
    if (!section) {
      return;
    }
    var collapsed = Boolean(state.collapsed[kind]);
    section.classList.toggle('collapsed', collapsed);
    var header = section.querySelector('.group-header');
    header.setAttribute('aria-expanded', String(!collapsed));
  }

  function persist() {
    vscode.setState({ collapsed: state.collapsed });
  }

  function setText(id, value) {
    byId(id).textContent = value;
  }

  function tooltipRow() {
    if (!state.hoveredKey) {
      return null;
    }
    var parts = state.hoveredKey.split(':');
    var container = groupRows(parts[0]);
    return container ? findRow(container, parts.slice(1).join(':')) : null;
  }

  function updateTooltip(row) {
    var quotes = quoteMap();
    var quote = quotes[row.dataset.code] || {};
    var hasQuote = number(quote.price) > 0;
    var className = direction(quote.percent);
    setText('tooltipName', quote.name || row.dataset.code);
    setText('tooltipCode', row.dataset.code);
    setText('tooltipPrice', hasQuote ? price(quote.price) : '--');
    setText('tooltipPercent', hasQuote ? signed(quote.percent, '%') : '--');
    byId('tooltipPrice').className = hasQuote ? className : 'flat';
    byId('tooltipPercent').className = hasQuote ? className : 'flat';
    setText('tooltipOpen', hasQuote ? price(quote.open) : '--');
    setText('tooltipHigh', hasQuote ? price(quote.high) : '--');
    setText('tooltipLow', hasQuote ? price(quote.low) : '--');
    setText('tooltipPrevious', hasQuote ? price(quote.previousClose) : '--');
    setText(
      'tooltipVolumeRatio',
      hasQuote && number(quote.volumeRatio) > 0 ? number(quote.volumeRatio).toFixed(2) : '--'
    );
    setText('tooltipTurnover', hasQuote ? number(quote.turnover).toFixed(2) + '%' : '--');
    setText('tooltipVolume', hasQuote ? compact(quote.volume) : '--');
    setText('tooltipAmount', hasQuote ? compact(quote.amount) : '--');
    setText(
      'tooltipHint',
      row.dataset.kind === 'holding'
        ? '列表百分比为今日涨跌幅'
        : '点击打开实时走势'
    );
  }

  function positionTooltip(row) {
    var tooltip = byId('quoteTooltip');
    var rowRect = row.getBoundingClientRect();
    var top = rowRect.bottom + 5;
    var height = tooltip.offsetHeight;
    if (top + height > window.innerHeight - 6) {
      top = Math.max(6, rowRect.top - height - 5);
    }
    tooltip.style.top = Math.round(top) + 'px';
  }

  function showTooltip(row) {
    state.hoveredKey = row.dataset.groupKey + ':' + row.dataset.code;
    var tooltip = byId('quoteTooltip');
    tooltip.classList.remove('hidden');
    updateTooltip(row);
    positionTooltip(row);
  }

  function refreshVisibleTooltip() {
    var row = tooltipRow();
    if (!row) {
      hideTooltip();
      return;
    }
    var tooltip = byId('quoteTooltip');
    tooltip.classList.remove('hidden');
    updateTooltip(row);
    positionTooltip(row);
  }

  function hideTooltip() {
    state.hoveredKey = '';
    byId('quoteTooltip').classList.add('hidden');
  }

  function hideContextMenu() {
    state.contextTarget = null;
    byId('rowContextMenu').classList.add('hidden');
  }

  function hideWatchGroupContextMenu() {
    state.contextGroupId = '';
    byId('watchGroupContextMenu').classList.add('hidden');
  }

  function positionContextMenu(menu, clientX, clientY) {
    menu.classList.remove('hidden');
    menu.style.left = '0px';
    menu.style.top = '0px';
    var rect = menu.getBoundingClientRect();
    var left = Math.min(clientX, Math.max(5, window.innerWidth - rect.width - 5));
    var top = Math.min(clientY, Math.max(5, window.innerHeight - rect.height - 5));
    menu.style.left = Math.max(5, left) + 'px';
    menu.style.top = Math.max(5, top) + 'px';
  }

  function showContextMenu(row, clientX, clientY) {
    var menu = byId('rowContextMenu');
    var holdingAction = menu.querySelector('[data-context-action="holding"]');
    var moveGroupAction = menu.querySelector('[data-context-action="move-group"]');
    var removeAction = menu.querySelector('[data-context-action="remove"]');
    state.contextTarget = {
      code: row.dataset.code,
      kind: row.dataset.kind,
      groupId: row.dataset.watchGroupId || ''
    };
    holdingAction.classList.toggle('hidden', row.dataset.kind === 'index');
    moveGroupAction.classList.toggle('hidden', row.dataset.kind !== 'stock');
    removeAction.textContent = row.dataset.kind === 'stock'
      ? '从当前分组移除'
      : '从侧栏移除';
    hideWatchGroupContextMenu();
    positionContextMenu(menu, clientX, clientY);
    menu.querySelector('[data-context-action="remove"]').focus();
  }

  function showWatchGroupContextMenu(header, clientX, clientY) {
    var menu = byId('watchGroupContextMenu');
    state.contextGroupId = header.dataset.watchGroupId || '';
    hideContextMenu();
    positionContextMenu(menu, clientX, clientY);
    menu.querySelector('[data-group-context-action="rename"]').focus();
  }

  byId('sidebar').addEventListener('click', function (event) {
    var createGroup = event.target.closest('[data-create-watch-group]');
    if (createGroup) {
      vscode.postMessage({ type: 'createWatchGroup' });
      return;
    }
    var header = event.target.closest('[data-toggle-group]');
    if (header) {
      var kind = header.getAttribute('data-toggle-group');
      state.collapsed[kind] = !state.collapsed[kind];
      applyCollapsedState(kind);
      persist();
      hideTooltip();
      return;
    }
    var sectorRow = event.target.closest('.sector-row');
    if (sectorRow) {
      vscode.postMessage({
        type: 'openSector',
        code: sectorRow.dataset.code,
        kind: sectorRow.dataset.sectorKind
      });
      return;
    }
    var row = event.target.closest('.quote-row');
    if (!row) {
      return;
    }
    vscode.postMessage({ type: 'openStock', code: row.dataset.code });
  });

  byId('sidebar').addEventListener('contextmenu', function (event) {
    var customHeader = event.target.closest('.custom-watch-group .group-header');
    if (customHeader) {
      event.preventDefault();
      hideTooltip();
      showWatchGroupContextMenu(customHeader, event.clientX, event.clientY);
      return;
    }
    var row = event.target.closest('.quote-row');
    if (!row) {
      hideContextMenu();
      hideWatchGroupContextMenu();
      return;
    }
    event.preventDefault();
    hideTooltip();
    showContextMenu(row, event.clientX, event.clientY);
  });

  byId('sidebar').addEventListener('dragstart', function (event) {
    var row = event.target.closest('.quote-row');
    if (!row || row.dataset.kind !== 'stock') {
      event.preventDefault();
      return;
    }
    state.draggedCode = row.dataset.code;
    state.draggedGroupId = row.dataset.watchGroupId || '';
    row.classList.add('dragging');
    hideTooltip();
    hideContextMenu();
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', row.dataset.code);
    }
  });

  byId('sidebar').addEventListener('dragover', function (event) {
    var target = event.target.closest('[data-watch-drop-target]');
    if (!target || !state.draggedCode) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
    document.querySelectorAll('.drag-over').forEach(function (element) {
      if (element !== target) {
        element.classList.remove('drag-over');
      }
    });
    target.classList.add('drag-over');
  });

  byId('sidebar').addEventListener('dragleave', function (event) {
    var target = event.target.closest('[data-watch-drop-target]');
    if (target && !target.contains(event.relatedTarget)) {
      target.classList.remove('drag-over');
    }
  });

  byId('sidebar').addEventListener('drop', function (event) {
    var target = event.target.closest('[data-watch-drop-target]');
    var code = state.draggedCode;
    if (!target || !code) {
      return;
    }
    event.preventDefault();
    target.classList.remove('drag-over');
    vscode.postMessage({
      type: 'assignWatchToGroup',
      code: code,
      sourceGroupId: state.draggedGroupId,
      groupId: target.dataset.watchGroupId || ''
    });
  });

  byId('sidebar').addEventListener('dragend', function () {
    state.draggedCode = '';
    state.draggedGroupId = '';
    document.querySelectorAll('.dragging, .drag-over').forEach(function (element) {
      element.classList.remove('dragging', 'drag-over');
    });
  });

  byId('rowContextMenu').addEventListener('click', function (event) {
    var action = event.target.closest('[data-context-action]');
    var target = state.contextTarget;
    if (!action || !target) {
      return;
    }
    var actionName = action.getAttribute('data-context-action');
    hideContextMenu();
    if (actionName === 'holding') {
      vscode.postMessage({ type: 'setHolding', code: target.code });
    } else if (actionName === 'move-group') {
      vscode.postMessage({
        type: 'moveWatchToGroup',
        code: target.code,
        sourceGroupId: target.groupId
      });
    } else if (actionName === 'remove') {
      vscode.postMessage({
        type: 'removeStock',
        code: target.code,
        kind: target.kind,
        groupId: target.groupId
      });
    }
  });

  byId('watchGroupContextMenu').addEventListener('click', function (event) {
    var action = event.target.closest('[data-group-context-action]');
    var groupId = state.contextGroupId;
    if (!action || !groupId) {
      return;
    }
    var actionName = action.getAttribute('data-group-context-action');
    hideWatchGroupContextMenu();
    if (actionName === 'rename') {
      vscode.postMessage({ type: 'renameWatchGroup', groupId: groupId });
    } else if (actionName === 'delete') {
      vscode.postMessage({ type: 'deleteWatchGroup', groupId: groupId });
    }
  });

  byId('sidebar').addEventListener('keydown', function (event) {
    var sectorRow = event.target.closest('.sector-row');
    if (sectorRow && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      vscode.postMessage({
        type: 'openSector',
        code: sectorRow.dataset.code,
        kind: sectorRow.dataset.sectorKind
      });
      return;
    }
    var row = event.target.closest('.quote-row');
    if (!row) {
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      vscode.postMessage({ type: 'openStock', code: row.dataset.code });
    } else if (event.key === 'Delete') {
      event.preventDefault();
      vscode.postMessage({
        type: 'removeStock',
        code: row.dataset.code,
        kind: row.dataset.kind,
        groupId: row.dataset.watchGroupId || ''
      });
    }
  });

  byId('sidebar').addEventListener('pointermove', function (event) {
    var row = event.target.closest('.quote-row');
    if (!row) {
      hideTooltip();
      return;
    }
    var key = row.dataset.groupKey + ':' + row.dataset.code;
    if (key !== state.hoveredKey) {
      showTooltip(row);
    }
  });

  byId('sidebar').addEventListener('pointerleave', hideTooltip);
  document.addEventListener('pointerdown', function (event) {
    if (!event.target.closest('#rowContextMenu')) {
      hideContextMenu();
    }
    if (!event.target.closest('#watchGroupContextMenu')) {
      hideWatchGroupContextMenu();
    }
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      hideContextMenu();
      hideWatchGroupContextMenu();
    }
  });
  window.addEventListener('blur', function () {
    hideContextMenu();
    hideWatchGroupContextMenu();
  });
  window.addEventListener('scroll', function () {
    hideContextMenu();
    hideWatchGroupContextMenu();
  }, true);
  window.addEventListener('resize', refreshVisibleTooltip);
  window.addEventListener('message', function (event) {
    var message = event.data || {};
    if (message.type === 'snapshot') {
      state.snapshot = message.data || state.snapshot;
      render();
    } else if (message.type === 'sectors') {
      state.sectors = message.data || state.sectors;
      render();
    }
  });

  Object.keys(state.collapsed).forEach(applyCollapsedState);
  document.body.classList.remove('booting');
  vscode.postMessage({ type: 'ready' });
})();
