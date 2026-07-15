(function () {
  'use strict';

  var vscode = acquireVsCodeApi();
  var restored = vscode.getState() || {};
  var state = {
    tab: restored.tab || 'watch',
    selectedCode: restored.selectedCode || '',
    snapshot: { watchlist: [], holdings: [], quotes: [], updatedAt: 0 },
    selectionQuote: null,
    profile: null,
    profileLoading: true,
    chart: null,
    news: [],
    cloud: [],
    cloudFilter: restored.cloudFilter || 'all',
    cloudUpdatedAt: 0,
    newsUpdatedAt: 0,
    sectorOverview: null,
    sectorBoardsByKind: { industry: [], concept: [] },
    sectorKind: restored.sectorKind || 'industry',
    sectorMode: 'overview',
    sectorQuery: '',
    sectorSort: 'netInflow',
    sectorSortDirection: 'desc',
    sectorFollows: [],
    sectorDetail: null,
    sectorUpdatedAt: 0,
    marketState: null
  };
  var klineChart = null;
  var cloudChart = null;
  var cloudResizeObserver = null;
  var cloudResizeFrame = 0;
  var cloudRenderFrame = 0;
  var cloudRenderRevision = 0;
  var cloudRetryTimer = 0;
  var cloudRenderedFingerprint = '';
  var cloudHasOption = false;
  var cloudLastWidth = 0;
  var cloudLastHeight = 0;
  var sectorIndustryChart = null;
  var sectorConceptChart = null;
  var toastTimer = 0;

  function byId(id) {
    return document.getElementById(id);
  }

  function all(selector) {
    return Array.prototype.slice.call(document.querySelectorAll(selector));
  }

  function post(message) {
    vscode.postMessage(message);
  }

  function persist() {
    vscode.setState({
      tab: state.tab,
      selectedCode: state.selectedCode,
      cloudFilter: state.cloudFilter,
      sectorKind: state.sectorKind
    });
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function svgIcon(name, className) {
    var safeName = String(name || '').replace(/[^a-z-]/g, '');
    var safeClass = String(className || '').replace(/[^a-z0-9 _-]/gi, '');
    return '<svg class="ui-icon ' + safeClass + '" aria-hidden="true"><use href="#icon-' +
      safeName + '"></use></svg>';
  }

  function number(value, fallback) {
    var parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback || 0;
  }

  function signed(value, digits, suffix) {
    var current = number(value);
    return (current > 0 ? '+' : '') + current.toFixed(digits == null ? 2 : digits) + (suffix || '');
  }

  function directionClass(value) {
    var current = number(value);
    if (current > 0.000001) {
      return 'rise';
    }
    if (current < -0.000001) {
      return 'fall';
    }
    return 'flat';
  }

  function price(value) {
    var current = number(value);
    if (!current) {
      return '--';
    }
    if (current >= 10000) {
      return current.toFixed(1);
    }
    if (current >= 100) {
      return current.toFixed(2);
    }
    return current.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  }

  function money(value) {
    var current = number(value);
    var sign = current < 0 ? '-' : '';
    return sign + '¥ ' + Math.abs(current).toLocaleString('zh-CN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function compact(value) {
    var current = number(value);
    var absolute = Math.abs(current);
    if (absolute >= 1000000000000) {
      return (current / 1000000000000).toFixed(2) + '万亿';
    }
    if (absolute >= 100000000) {
      return (current / 100000000).toFixed(2) + '亿';
    }
    if (absolute >= 10000) {
      return (current / 10000).toFixed(2) + '万';
    }
    return current.toFixed(0);
  }

  function formatTime(value) {
    if (!value) {
      return '--';
    }
    var date = typeof value === 'number' ? new Date(value) : new Date(String(value).replace(/-/g, '/'));
    if (Number.isNaN(date.getTime())) {
      return String(value);
    }
    return date.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
  }

  function quoteMap() {
    var result = Object.create(null);
    state.snapshot.quotes.forEach(function (item) {
      result[item.code] = item;
    });
    if (state.selectionQuote) {
      result[state.selectionQuote.code] = state.selectionQuote;
    }
    return result;
  }

  function isIndex(code) {
    return [
      'sh000001',
      'sh000300',
      'sh000016',
      'sh000688',
      'sz399001',
      'sz399006'
    ].indexOf(code) >= 0;
  }

  function showToast(message, isError) {
    var toast = byId('toast');
    toast.textContent = message;
    toast.classList.toggle('error', Boolean(isError));
    toast.classList.remove('hidden');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      toast.classList.add('hidden');
    }, 3200);
  }

  function setTab(tab, notifyHost) {
    if (['watch', 'assets', 'news', 'cloud', 'sector'].indexOf(tab) < 0) {
      tab = 'watch';
    }
    state.tab = tab;
    all('.nav-item').forEach(function (button) {
      button.classList.toggle('active', button.getAttribute('data-tab') === tab);
    });
    all('.page').forEach(function (page) {
      page.classList.toggle('active', page.id === 'page-' + tab);
    });
    persist();
    if (notifyHost !== false) {
      post({ type: 'setActiveTab', tab: tab });
    }
    if (tab === 'watch') {
      window.setTimeout(function () {
        if (klineChart) {
          klineChart.resize();
        }
      }, 40);
    } else if (tab === 'cloud') {
      if (state.cloud.length) {
        scheduleCloudRender();
      } else {
        scheduleCloudResize();
      }
    } else if (tab === 'sector') {
      window.setTimeout(function () {
        if (sectorIndustryChart) {
          sectorIndustryChart.resize();
        }
        if (sectorConceptChart) {
          sectorConceptChart.resize();
        }
      }, 40);
    }
  }

  function selectStock(code, notifyHost) {
    var changed = state.selectedCode !== code;
    state.selectedCode = code;
    state.selectionQuote = quoteMap()[code] || null;
    if (changed) {
      state.profile = null;
      state.profileLoading = true;
    }
    persist();
    renderWatchGroups();
    renderQuote();
    renderProfile();
    if (notifyHost !== false) {
      post({ type: 'selectStock', code: code });
    }
  }

  function renderWatchGroups() {
    var container = byId('watchGroups');
    var quotes = quoteMap();
    var filter = byId('stockFilter').value.trim().toLowerCase();
    var holdingCodes = state.snapshot.holdings.map(function (item) {
      return item.code;
    });
    var holdingSet = Object.create(null);
    holdingCodes.forEach(function (code) {
      holdingSet[code] = true;
    });
    var regular = state.snapshot.watchlist.filter(function (code) {
      return !holdingSet[code] && !isIndex(code);
    });
    var indices = state.snapshot.watchlist.filter(isIndex);

    function renderGroup(title, codes) {
      var visible = codes.filter(function (code) {
        var quote = quotes[code] || {};
        var haystack = (code + ' ' + (quote.name || '')).toLowerCase();
        return !filter || haystack.indexOf(filter) >= 0;
      });
      var rows = visible
        .map(function (code) {
          var quote = quotes[code] || { code: code, name: code, price: 0, percent: 0 };
          var className = directionClass(quote.percent);
          var arrow = number(quote.percent) >= 0 ? '⌃' : '⌄';
          return (
            '<button class="stock-row ' +
            (code === state.selectedCode ? 'active' : '') +
            '" data-stock-code="' +
            escapeHtml(code) +
            '">' +
            '<span class="arrow ' +
            className +
            '">' +
            arrow +
            '</span>' +
            '<span class="pct ' +
            className +
            '">' +
            (quote.price ? signed(quote.percent, 2, '%') : '--') +
            '</span>' +
            '<span class="price">' +
            price(quote.price) +
            '</span>' +
            '<span class="name">「' +
            escapeHtml(quote.name || code) +
            '」</span>' +
            '</button>'
          );
        })
        .join('');
      return (
        '<section class="watch-group">' +
        '<div class="group-title"><span class="group-arrow">⌄</span>' +
        escapeHtml(title) +
        ' (' +
        visible.length +
        ')</div>' +
        (rows || '<div class="rail-empty">暂无匹配项</div>') +
        '</section>'
      );
    }

    container.innerHTML =
      renderGroup('我的持仓', holdingCodes) +
      renderGroup('A股', regular) +
      renderGroup('指数', indices);
    byId('stockCount').textContent = String(state.snapshot.watchlist.length);
    byId('quoteUpdateText').textContent = state.snapshot.updatedAt
      ? '更新 ' + formatTime(state.snapshot.updatedAt)
      : '等待行情';
  }

  function renderQuote() {
    var quote = quoteMap()[state.selectedCode] || state.selectionQuote;
    if (!quote) {
      byId('quoteName').textContent = '选择一只 A 股';
      byId('quoteCode').textContent = '--';
      return;
    }
    var className = directionClass(quote.percent);
    byId('quoteName').textContent = quote.name;
    byId('quoteCode').textContent = quote.code;
    byId('quotePrice').textContent = price(quote.price);
    byId('quotePrice').className = 'quote-price ' + className;
    byId('quoteChange').textContent = signed(quote.change, 2) + '  ' + signed(quote.percent, 2, '%');
    byId('quoteChange').className = 'quote-change ' + className;
    byId('quoteUpdated').textContent = formatTime(quote.updatedAt);
    byId('metricOpen').textContent = price(quote.open);
    byId('metricHigh').textContent = price(quote.high);
    byId('metricVolume').textContent = compact(quote.volume) + '手';
    byId('metricPrevious').textContent = price(quote.previousClose);
    byId('metricLow').textContent = price(quote.low);
    byId('metricAmount').textContent = compact(quote.amount);
  }

  function firstValue(source, keys, fallback) {
    if (!source || typeof source !== 'object') {
      return fallback == null ? '' : fallback;
    }
    for (var index = 0; index < keys.length; index += 1) {
      var value = source[keys[index]];
      if (value !== undefined && value !== null && String(value).trim() !== '') {
        return value;
      }
    }
    return fallback == null ? '' : fallback;
  }

  function asList(value) {
    if (Array.isArray(value)) {
      return value;
    }
    if (typeof value === 'string') {
      return value
        .split(/[，,、|]/)
        .map(function (item) {
          return item.trim();
        })
        .filter(Boolean);
    }
    return [];
  }

  function setProfileLoading(loading) {
    state.profileLoading = Boolean(loading);
    var loadingNode = byId('profileLoading');
    var contentNode = byId('profileContent');
    if (loadingNode) {
      loadingNode.classList.toggle('hidden', !state.profileLoading);
    }
    if (contentNode) {
      contentNode.classList.toggle('hidden', state.profileLoading);
    }
  }

  function normalizeReports(profile) {
    var source = firstValue(profile, ['reports', 'organizationReports', 'researchReports'], []);
    return asList(source)
      .map(function (report) {
        if (Array.isArray(report)) {
          var values = report.map(function (cell) {
            if (cell && typeof cell === 'object') {
              return firstValue(cell, ['value', 'content', 'text', 'title'], '--');
            }
            return cell;
          });
          return {
            date: values[0],
            rating: values[1],
            previousRating: values[2],
            direction: values[3],
            targetPrice: values[4],
            analyst: values[5],
            institutionRating: values[6]
          };
        }
        if (!report || typeof report !== 'object') {
          return null;
        }
        return {
          date: firstValue(report, ['date', 'reportDate', 'publishDate', 'time'], '--'),
          rating: firstValue(report, ['latestRating', 'rating', 'currentRating'], '--'),
          previousRating: firstValue(report, ['previousRating', 'lastRating'], '--'),
          direction: firstValue(report, ['changeDirection', 'ratingChange', 'direction'], '--'),
          targetPrice: firstValue(report, ['targetPrice', 'priceTarget'], '--'),
          analyst: firstValue(report, ['analyst', 'researcher', 'author'], '--'),
          institutionRating: firstValue(
            report,
            [
              'organization',
              'institution',
              'institutionRating',
              'consensusRating',
              'leekRating',
              'organizationRating'
            ],
            '--'
          )
        };
      })
      .filter(Boolean)
      .slice(0, 30);
  }

  function renderProfileConcepts(profile) {
    var concepts = asList(firstValue(profile, ['concepts', 'concept', 'tags'], []));
    var industry = firstValue(profile, ['industry', 'sector'], '');
    if (industry && concepts.indexOf(industry) < 0) {
      concepts.unshift({ title: industry, description: '所属行业' });
    }
    byId('profileConcepts').innerHTML = concepts.length
      ? concepts
          .map(function (concept) {
            var title =
              concept && typeof concept === 'object'
                ? firstValue(concept, ['title', 'name', 'label'], '')
                : concept;
            var detail =
              concept && typeof concept === 'object'
                ? firstValue(concept, ['description', 'content', 'detail'], '')
                : '';
            return title
              ? '<span class="concept-tag" title="' +
                  escapeHtml(detail || title) +
                  '">' +
                  escapeHtml(title) +
                  '</span>'
              : '';
          })
          .join('')
      : '<span class="empty-inline">-- 暂无概念资料 --</span>';
  }

  function renderProfileReports(profile) {
    var reports = normalizeReports(profile);
    byId('profileReportCount').textContent = reports.length + ' 条研报';
    byId('profileReportsEmpty').classList.toggle('hidden', reports.length > 0);
    byId('profileReports').innerHTML = reports
      .map(function (report) {
        return (
          '<tr>' +
          '<td>' +
          escapeHtml(report.date || '--') +
          '</td><td>' +
          escapeHtml(report.rating || '--') +
          '</td><td>' +
          escapeHtml(report.previousRating || '--') +
          '</td><td>' +
          escapeHtml(report.direction || '--') +
          '</td><td>' +
          escapeHtml(report.targetPrice || '--') +
          '</td><td><a href="#" tabindex="-1">' +
          escapeHtml(report.analyst || '--') +
          '</a></td><td>' +
          escapeHtml(report.institutionRating || '--') +
          '</td></tr>'
        );
      })
      .join('');
  }

  function renderProfileCommunity(profile) {
    var community = firstValue(profile, ['community', 'communityHeat'], {});
    if (!community || typeof community !== 'object') {
      community = {};
    }
    var ths = firstValue(
      community,
      ['ths', 'tonghuashun', 'hot', 'popularity'],
      firstValue(profile, ['hot', 'popularity'], '--')
    );
    var xueqiu = firstValue(
      community,
      ['xueqiu', 'xueqiuFollowers', 'followers'],
      firstValue(profile, ['xueqiuFollowers'], '--')
    );
    byId('profileCommunity').innerHTML =
      '<p><span>同花顺人气热度</span><strong>' +
      escapeHtml(ths === '--' ? ths : compact(ths)) +
      '</strong></p><p><span>雪球社区关注量</span><strong>' +
      escapeHtml(xueqiu === '--' ? xueqiu : compact(xueqiu)) +
      '</strong></p>';
  }

  function renderProfile() {
    setProfileLoading(state.profileLoading);
    if (state.profileLoading) {
      byId('profileSubtitle').textContent = '正在获取公开资料';
      renderProfileConcepts({});
      renderProfileReports({});
      renderProfileCommunity({});
      return;
    }
    var profile = state.profile || {};
    var quote = quoteMap()[state.selectedCode] || state.selectionQuote || {};
    var companyName = firstValue(
      profile,
      ['companyName', 'fullName', 'company', 'name'],
      quote.name || state.selectedCode || '--'
    );
    var industry = firstValue(profile, ['industry', 'sector'], '--');
    var subIndustry = firstValue(profile, ['subIndustry', 'secondaryIndustry'], '--');
    var board = firstValue(profile, ['listingBoard', 'board', 'market'], '--');
    var exchange = firstValue(profile, ['exchange'], '--');
    var listingDate = firstValue(profile, ['listingDate', 'listedAt', 'listDate'], '--');
    var englishName = firstValue(profile, ['englishName'], '');
    var registeredCapital = firstValue(profile, ['registeredCapital'], '--');
    var employeeCount = firstValue(profile, ['employeeCount'], '--');
    var website = firstValue(profile, ['website'], '--');
    var business = firstValue(profile, ['mainBusiness', 'business', 'businessScope'], '--');
    var description = firstValue(
      profile,
      ['summary', 'description', 'intro', 'companyProfile', 'profile'],
      '--'
    );
    byId('profileSubtitle').textContent =
      industry === '--'
        ? '公开资料摘要'
        : industry + (subIndustry && subIndustry !== '--' ? ' · ' + subIndustry : '');
    byId('profileMeta').innerHTML =
      '<span><b>公司全称</b>' +
      escapeHtml(companyName) +
      '</span>' +
      (englishName ? '<span><b>英文名称</b>' + escapeHtml(englishName) + '</span>' : '') +
      '<span><b>所属行业</b>' +
      escapeHtml(industry) +
      '</span><span><b>二级行业</b>' +
      escapeHtml(subIndustry) +
      '</span><span><b>上市板块</b>' +
      escapeHtml(board) +
      '</span><span><b>交易所</b>' +
      escapeHtml(exchange) +
      '</span><span><b>上市日期</b>' +
      escapeHtml(listingDate) +
      '</span><span><b>注册资本</b>' +
      escapeHtml(registeredCapital) +
      '</span><span><b>员工人数</b>' +
      escapeHtml(employeeCount) +
      '</span><span><b>公司网站</b>' +
      escapeHtml(website) +
      '</span>';
    byId('profileBusiness').textContent = String(business || '--');
    byId('profileDescription').textContent = String(description || '--');
    renderProfileConcepts(profile);
    renderProfileReports(profile);
    renderProfileCommunity(profile);
  }

  function renderAssets() {
    var quotes = quoteMap();
    var rows = [];
    var totalMarket = 0;
    var totalCost = 0;
    var totalDay = 0;
    var pricedRows = 0;
    state.snapshot.holdings.forEach(function (holding) {
      var quote = quotes[holding.code] || {};
      var current = number(quote.price);
      var hasQuote = current > 0;
      var previous = number(quote.previousClose) > 0 ? number(quote.previousClose) : current;
      var marketValue = hasQuote ? current * number(holding.amount) : 0;
      var costValue = number(holding.cost) * number(holding.amount);
      var dayProfit = hasQuote ? (current - previous) * number(holding.amount) : 0;
      var holdingProfit = hasQuote ? marketValue - costValue : 0;
      var holdingPercent = hasQuote && costValue ? (holdingProfit / costValue) * 100 : 0;
      if (hasQuote) {
        totalMarket += marketValue;
        totalDay += dayProfit;
        pricedRows += 1;
      }
      totalCost += costValue;
      rows.push({
        holding: holding,
        quote: quote,
        hasQuote: hasQuote,
        marketValue: marketValue,
        dayProfit: dayProfit,
        holdingProfit: holdingProfit,
        holdingPercent: holdingPercent
      });
    });
    var completeQuotes = rows.length === 0 || pricedRows === rows.length;
    var floating = completeQuotes ? totalMarket - totalCost : 0;
    var floatingPercent = completeQuotes && totalCost ? (floating / totalCost) * 100 : 0;
    byId('assetSummary').innerHTML =
      '<div class="asset-hero">' +
      '<div><div class="eyebrow">' + svgIcon('assets', 'inline-icon') + '<span>总资产（股票市值）</span></div>' +
      '<div class="asset-total">' +
      (completeQuotes ? money(totalMarket) : '--') +
      '</div>' +
      '<div class="asset-floating ' +
      (completeQuotes ? directionClass(floating) : 'flat') +
      '">' + svgIcon('brand', 'inline-icon') + '<span>浮动盈亏 ' +
      (completeQuotes
        ? money(floating) + ' (' + signed(floatingPercent, 2, '%') + ')'
        : '--') +
      '</span></div></div>' +
      '<div class="asset-day"><div class="eyebrow">当日盈亏</div><strong class="' +
      (completeQuotes ? directionClass(totalDay) : 'flat') +
      '">' +
      (completeQuotes ? money(totalDay) : '--') +
      '</strong></div>' +
      '</div>' +
      '<div class="asset-side">' +
      '<div class="asset-side-card"><div class="eyebrow">总成本</div><strong>' +
      money(totalCost) +
      '</strong></div>' +
      '<div class="asset-side-card"><div class="eyebrow">股票市值 · 占比</div><strong>' +
      (completeQuotes ? money(totalMarket) : '--') +
      '</strong><div class="allocation-bar"><span style="width:' +
      (completeQuotes && totalMarket > 0 ? '100' : '0') +
      '%"></span></div></div>' +
      '</div>';

    byId('holdingCount').textContent = rows.length + ' 个标的';
    byId('holdingEmpty').classList.toggle('visible', rows.length === 0);
    byId('holdingRows').innerHTML = rows
      .map(function (row) {
        var holding = row.holding;
        return (
          '<tr>' +
          '<td><div class="symbol-name">' +
          escapeHtml(holding.name) +
          '</div><div class="symbol-code">' +
          escapeHtml(holding.code) +
          '</div></td>' +
          '<td><span class="type-badge">股票</span></td>' +
          '<td>' +
          number(holding.amount).toLocaleString('zh-CN') +
          '</td>' +
          '<td>' +
          price(holding.cost) +
          '</td>' +
          '<td>' +
          price(row.quote.price) +
          '</td>' +
          '<td>' +
          (row.hasQuote ? money(row.marketValue) : '--') +
          '</td>' +
          '<td class="' +
          (row.hasQuote ? directionClass(row.dayProfit) : 'flat') +
          '">' +
          (row.hasQuote ? money(row.dayProfit) : '--') +
          '</td>' +
          '<td class="' +
          (row.hasQuote ? directionClass(row.holdingProfit) : 'flat') +
          '">' +
          (row.hasQuote ? money(row.holdingProfit) : '--') +
          '<div class="symbol-code ' +
          (row.hasQuote ? directionClass(row.holdingProfit) : 'flat') +
          '">' +
          (row.hasQuote ? signed(row.holdingPercent, 2, '%') : '--') +
          '</div></td>' +
          '<td><div class="row-actions">' +
          '<button class="row-action" data-edit-holding="' +
          escapeHtml(holding.code) +
          '" title="编辑">✎</button>' +
          '<button class="row-action" data-open-holding="' +
          escapeHtml(holding.code) +
          '" title="查看 K 线">⌁</button>' +
          '<button class="row-action danger" data-delete-holding="' +
          escapeHtml(holding.code) +
          '" title="删除">⌫</button>' +
          '</div></td>' +
          '</tr>'
        );
      })
      .join('');
  }

  function openHoldingModal(holding) {
    byId('holdingModalTitle').textContent = holding.name || '新增持仓';
    byId('holdingModalCode').textContent = holding.code;
    byId('holdingCode').value = holding.code;
    byId('holdingName').value = holding.name || holding.code;
    byId('holdingAmount').value = String(number(holding.amount, 100));
    byId('holdingCost').value = String(number(holding.cost));
    byId('holdingModal').classList.remove('hidden');
    window.setTimeout(function () {
      byId('holdingAmount').focus();
      byId('holdingAmount').select();
    }, 50);
  }

  function closeHoldingModal() {
    byId('holdingModal').classList.add('hidden');
  }

  function renderNews() {
    byId('newsLoading').classList.add('hidden');
    byId('newsUpdateText').textContent = state.newsUpdatedAt
      ? '更新 ' + formatTime(state.newsUpdatedAt)
      : '暂无更新';
    var previousDay = '';
    var html = '';
    state.news.forEach(function (item) {
      var day = String(item.time || '').slice(0, 10) || '最新';
      if (day !== previousDay) {
        html += '<div class="news-day">' + escapeHtml(day) + '</div>';
        previousDay = day;
      }
      var timePart = String(item.time || '').slice(11, 19) || '--:--:--';
      html +=
        '<article class="news-item" data-news-url="' +
        escapeHtml(item.url || '') +
        '">' +
        '<div class="news-time">' +
        escapeHtml(timePart) +
        '</div>' +
        '<div><div class="news-title">' +
        escapeHtml(item.title) +
        '</div><div class="news-summary">' +
        escapeHtml(item.summary || '') +
        '</div></div></article>';
    });
    byId('newsList').innerHTML =
      html ||
      '<div class="empty-state visible"><div class="empty-state-icon">' +
      svgIcon('news', 'section-icon') +
      '</div><h3>暂无快讯</h3><p>稍后刷新重试。</p></div>';
  }

  function mixColor(percent) {
    var value = Math.max(-20, Math.min(20, number(percent)));
    if (Math.abs(value) < 0.05) {
      return '#3a4254';
    }
    var strength = Math.min(1, Math.abs(value) / 10);
    if (value > 0) {
      var red = Math.round(130 + 120 * strength);
      var green = Math.round(36 - 10 * strength);
      var blue = Math.round(43 - 15 * strength);
      return 'rgb(' + red + ',' + green + ',' + blue + ')';
    }
    var r = Math.round(26 - 8 * strength);
    var g = Math.round(100 + 105 * strength);
    var b = Math.round(65 + 15 * strength);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  function buildCloudTree(items) {
    var industries = Object.create(null);
    items.forEach(function (item) {
      var industry = item.industry || '其他';
      var subIndustry =
        item.subIndustry || item.secondaryIndustry || item.industry2 || item.subSector || '其他';
      var marketCap = Math.max(1, number(item.marketCap, 1));
      var percent = number(item.percent);
      if (!industries[industry]) {
        industries[industry] = {
          total: 0,
          weighted: 0,
          stockCount: 0,
          subGroups: Object.create(null)
        };
      }
      var industryGroup = industries[industry];
      if (!industryGroup.subGroups[subIndustry]) {
        industryGroup.subGroups[subIndustry] = {
          total: 0,
          weighted: 0,
          stocks: []
        };
      }
      var subGroup = industryGroup.subGroups[subIndustry];
      industryGroup.total += marketCap;
      industryGroup.weighted += percent * marketCap;
      industryGroup.stockCount += 1;
      subGroup.total += marketCap;
      subGroup.weighted += percent * marketCap;
      subGroup.stocks.push(item);
    });

    function stockNode(item, industry, subIndustry) {
      return {
        id: 'stock:' + item.code,
        nodeType: 'stock',
        name: item.name,
        labelText: item.name,
        code: item.code,
        price: item.price,
        percent: item.percent,
        industry: industry,
        subIndustry: subIndustry,
        value: Math.max(1, number(item.marketCap, 1)),
        itemStyle: {
          color: mixColor(item.percent),
          borderColor: '#19243a',
          borderWidth: 1
        }
      };
    }

    return Object.keys(industries)
      .map(function (industry) {
        var industryGroup = industries[industry];
        var industryAverage = industryGroup.total
          ? industryGroup.weighted / industryGroup.total
          : 0;
        return {
          id: 'industry:' + industry,
          nodeType: 'industry',
          name: industry,
          labelText: industry + '  ' + signed(industryAverage, 2, '%'),
          industry: industry,
          average: industryAverage,
          stockCount: industryGroup.stockCount,
          value: industryGroup.total,
          children: Object.keys(industryGroup.subGroups)
            .map(function (subIndustry) {
              var subGroup = industryGroup.subGroups[subIndustry];
              var stocks = subGroup.stocks;
              var subAverage = subGroup.total ? subGroup.weighted / subGroup.total : 0;
              var topStocks = stocks
                .slice()
                .sort(function (left, right) {
                  var percentDiff = number(right.percent) - number(left.percent);
                  return percentDiff || number(right.marketCap) - number(left.marketCap);
                })
                .slice(0, 10)
                .map(function (item) {
                  return {
                    name: item.name,
                    code: item.code,
                    price: item.price,
                    percent: item.percent
                  };
                });
              return {
                id: 'sub:' + industry + '/' + subIndustry,
                nodeType: 'subIndustry',
                name: subIndustry,
                labelText: subIndustry + '  ' + signed(subAverage, 2, '%'),
                industry: industry,
                subIndustry: subIndustry,
                average: subAverage,
                stockCount: stocks.length,
                value: subGroup.total,
                topStocks: topStocks,
                children: stocks
                  .slice()
                  .sort(function (left, right) {
                    return number(right.marketCap) - number(left.marketCap);
                  })
                  .map(function (item) {
                    return stockNode(item, industry, subIndustry);
                  })
              };
            })
            .sort(function (left, right) {
              return right.value - left.value;
            })
        };
      })
      .sort(function (left, right) {
        return right.value - left.value;
      });
  }

  function cloudSectorTooltip(data) {
    var rows = asList(data.topStocks)
      .map(function (item) {
        var className = directionClass(item.percent);
        return (
          '<tr><td>' +
          escapeHtml(item.name || item.code || '--') +
          '</td><td>' +
          escapeHtml(price(item.price)) +
          '</td><td class="' +
          className +
          '">' +
          escapeHtml(signed(item.percent, 2, '%')) +
          '</td></tr>'
        );
      })
      .join('');
    return (
      '<div class="cloud-sector-tooltip">' +
      '<div class="cloud-tooltip-title">' +
      escapeHtml(data.industry) +
      '-' +
      escapeHtml(data.subIndustry) +
      '</div><div class="cloud-tooltip-meta">' +
      '<span>个股数：' +
      number(data.stockCount) +
      '</span><span>板块涨幅：<b class="' +
      directionClass(data.average) +
      '">' +
      escapeHtml(signed(data.average, 2, '%')) +
      '</b></span><span>板块市值：' +
      escapeHtml(compact(data.value)) +
      '</span></div>' +
      '<table class="cloud-tooltip-table"><thead><tr><th>股票</th><th>价格</th><th>涨跌幅</th></tr></thead><tbody>' +
      rows +
      '</tbody></table></div>'
    );
  }

  function cloudTooltip(params) {
    var data = params.data || {};
    if (data.nodeType === 'stock' || data.code) {
      return (
        '<strong>' +
        escapeHtml(data.name) +
        '</strong> ' +
        escapeHtml(data.code) +
        '<br/>板块：' +
        escapeHtml(data.industry) +
        ' / ' +
        escapeHtml(data.subIndustry || '其他') +
        '<br/>价格：' +
        price(data.price) +
        '<br/>涨跌幅：<span style="color:' +
        (number(data.percent) >= 0 ? '#ff6b67' : '#66d98d') +
        '">' +
        signed(data.percent, 2, '%') +
        '</span><br/>总市值：' +
        compact(data.value)
      );
    }
    if (data.nodeType === 'subIndustry') {
      return cloudSectorTooltip(data);
    }
    return (
      '<strong>' +
      escapeHtml(data.industry || data.name) +
      '</strong><br/>个股数：' +
      number(data.stockCount) +
      '<br/>行业涨幅：<span style="color:' +
      (number(data.average) >= 0 ? '#ff6b67' : '#66d98d') +
      '">' +
      signed(data.average, 2, '%') +
      '</span><br/>行业市值：' +
      compact(data.value)
    );
  }

  function cloudDataFingerprint(items, filter) {
    var hash = 2166136261;
    function mix(value) {
      var text = String(value == null ? '' : value);
      for (var index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
    }
    items.forEach(function (item) {
      mix(item.code);
      mix(Math.round(number(item.price) * 1000));
      mix(Math.round(number(item.percent) * 1000));
      mix(Math.round(number(item.marketCap)));
      mix(item.industry);
      mix(item.subIndustry || item.secondaryIndustry || item.industry2 || item.subSector);
    });
    return filter + ':' + items.length + ':' + (hash >>> 0).toString(36);
  }

  function cloudLabel(params) {
    var data = params.data || {};
    return data.labelText || data.name || '';
  }

  function cloudTreemapSeries(tree, animate) {
    return {
      id: 'market-cloud',
      type: 'treemap',
      animation: animate,
      animationThreshold: 1200,
      animationDuration: animate ? 140 : 0,
      animationDurationUpdate: animate ? 120 : 0,
      animationEasing: 'cubicOut',
      animationEasingUpdate: 'cubicOut',
      roam: false,
      nodeClick: false,
      breadcrumb: { show: false },
      data: tree,
      leafDepth: 3,
      left: 32,
      right: 32,
      top: 30,
      bottom: 34,
      squareRatio: 1.15,
      visibleMin: 5,
      childrenVisibleMin: 10,
      emphasis: { disabled: true },
      label: {
        show: true,
        color: '#f2f4f8',
        fontSize: 11,
        overflow: 'truncate',
        formatter: cloudLabel
      },
      upperLabel: {
        show: true,
        height: 27,
        color: '#f5f7fb',
        fontSize: 13,
        fontWeight: 700,
        backgroundColor: '#202c40',
        padding: [5, 6],
        formatter: cloudLabel
      },
      itemStyle: {
        borderColor: '#0d1528',
        borderWidth: 2,
        gapWidth: 2
      },
      levels: [
        {
          itemStyle: {
            borderColor: '#0d1528',
            borderWidth: 3,
            gapWidth: 3
          }
        },
        {
          upperLabel: { show: true, formatter: cloudLabel },
          itemStyle: {
            borderColor: '#1d2a42',
            borderWidth: 2,
            gapWidth: 2
          }
        },
        {
          upperLabel: {
            show: true,
            height: 24,
            color: '#e4e9f2',
            fontSize: 11,
            fontWeight: 650,
            backgroundColor: '#1b263a',
            padding: [4, 5],
            formatter: cloudLabel
          },
          itemStyle: {
            borderColor: '#263550',
            borderWidth: 2,
            gapWidth: 1
          }
        },
        {
          itemStyle: {
            borderColor: '#263550',
            borderWidth: 1,
            gapWidth: 1
          }
        }
      ]
    };
  }

  function ensureCloudChart(container, width, height) {
    if (cloudChart) {
      return;
    }
    cloudChart = echarts.init(container, null, {
      renderer: 'canvas',
      width: width,
      height: height,
      devicePixelRatio: Math.min(2, window.devicePixelRatio || 1)
    });
    cloudLastWidth = width;
    cloudLastHeight = height;
    cloudChart.on('click', function (params) {
      if (params && params.data && params.data.code) {
        post({ type: 'openCloudStock', code: params.data.code });
      }
    });
    if (!cloudResizeObserver && typeof ResizeObserver === 'function') {
      cloudResizeObserver = new ResizeObserver(scheduleCloudResize);
      cloudResizeObserver.observe(container);
    }
  }

  function scheduleCloudResize() {
    if (!cloudChart || state.tab !== 'cloud' || cloudResizeFrame) {
      return;
    }
    cloudResizeFrame = window.requestAnimationFrame(function () {
      cloudResizeFrame = 0;
      var container = byId('cloudChart');
      var rect = container.getBoundingClientRect();
      var width = Math.max(0, Math.round(rect.width));
      var height = Math.max(0, Math.round(rect.height));
      if (!width || !height || (width === cloudLastWidth && height === cloudLastHeight)) {
        return;
      }
      cloudLastWidth = width;
      cloudLastHeight = height;
      cloudChart.resize({
        width: width,
        height: height,
        silent: true,
        animation: { duration: 0 }
      });
    });
  }

  function revealCloudChart(revision) {
    window.requestAnimationFrame(function () {
      if (revision !== cloudRenderRevision) {
        return;
      }
      var container = byId('cloudChart');
      container.classList.add('is-ready');
      container.classList.remove('is-updating');
    });
  }

  function renderCloudNow(revision, fingerprint, width, height) {
    if (revision !== cloudRenderRevision) {
      return;
    }
    var container = byId('cloudChart');
    var tree = buildCloudTree(state.cloud);
    ensureCloudChart(container, width, height);
    var animate = cloudHasOption && state.cloud.length <= 1200;
    cloudChart.setOption(
      {
        animation: animate,
        animationThreshold: 1200,
        backgroundColor: '#0d1528',
        tooltip: {
          trigger: 'item',
          confine: true,
          enterable: true,
          transitionDuration: 0.08,
          backgroundColor: 'rgba(18,27,45,.96)',
          borderColor: '#3c5278',
          borderWidth: 1,
          padding: 12,
          extraCssText: 'box-shadow:0 16px 44px rgba(0,0,0,.38);',
          textStyle: { color: '#e5e8ef' },
          formatter: cloudTooltip
        },
        series: [cloudTreemapSeries(tree, animate)]
      },
      {
        notMerge: !cloudHasOption,
        lazyUpdate: false,
        silent: true
      }
    );
    cloudHasOption = true;
    cloudRenderedFingerprint = fingerprint;
    cloudLastWidth = width;
    cloudLastHeight = height;
    byId('cloudLoading').classList.add('hidden');
    revealCloudChart(revision);
  }

  function scheduleCloudRender() {
    cloudRenderRevision += 1;
    var revision = cloudRenderRevision;
    window.clearTimeout(cloudRetryTimer);
    if (cloudRenderFrame) {
      window.cancelAnimationFrame(cloudRenderFrame);
    }
    byId('cloudUpdateText').textContent = formatTime(state.cloudUpdatedAt);
    cloudRenderFrame = window.requestAnimationFrame(function () {
      cloudRenderFrame = 0;
      if (revision !== cloudRenderRevision || state.tab !== 'cloud') {
        return;
      }
      var container = byId('cloudChart');
      var rect = container.getBoundingClientRect();
      var width = Math.max(0, Math.round(rect.width));
      var height = Math.max(0, Math.round(rect.height));
      if (width < 80 || height < 80) {
        cloudRetryTimer = window.setTimeout(scheduleCloudRender, 40);
        return;
      }
      var fingerprint = cloudDataFingerprint(state.cloud, state.cloudFilter);
      if (cloudChart && fingerprint === cloudRenderedFingerprint) {
        byId('cloudLoading').classList.add('hidden');
        container.classList.add('is-ready');
        container.classList.remove('is-updating');
        scheduleCloudResize();
        return;
      }
      if (cloudChart) {
        container.classList.add('is-updating');
      }
      // One extra frame lets the old canvas fade slightly before a large
      // synchronous treemap layout, avoiding the visible lower-left expansion.
      cloudRenderFrame = window.requestAnimationFrame(function () {
        cloudRenderFrame = 0;
        renderCloudNow(revision, fingerprint, width, height);
      });
    });
  }

  function sectorFlow(value) {
    var current = number(value);
    return (current > 0 ? '+' : '') + (current / 100000000).toFixed(2) + '亿';
  }

  function sectorBoardPool() {
    var overview = state.sectorOverview || {};
    var source = []
      .concat(state.sectorBoardsByKind.industry || [])
      .concat(state.sectorBoardsByKind.concept || [])
      .concat(overview.hot3d || [])
      .concat(overview.fast3m || [])
      .concat(overview.industryTopInflow || [])
      .concat(overview.conceptTopInflow || []);
    var seen = Object.create(null);
    return source.filter(function (item) {
      var code = String(item && item.code || '').toUpperCase();
      if (!code || seen[code]) {
        return false;
      }
      seen[code] = true;
      return true;
    });
  }

  function findSectorBoard(code) {
    var normalized = String(code || '').toUpperCase();
    return sectorBoardPool().find(function (item) {
      return String(item.code || '').toUpperCase() === normalized;
    }) || null;
  }

  function showSectorView(mode) {
    state.sectorMode = mode;
    var sectorPage = byId('sectorPage');
    if (sectorPage) {
      sectorPage.classList.remove('mode-overview', 'mode-list', 'mode-detail');
      sectorPage.classList.add('mode-' + mode);
    }
    ['overview', 'list', 'detail'].forEach(function (name) {
      var node = byId('sector' + name.charAt(0).toUpperCase() + name.slice(1) + 'View');
      if (node) {
        node.classList.toggle('hidden', name !== mode);
      }
    });
    window.setTimeout(function () {
      if (mode === 'overview') {
        if (sectorIndustryChart) {
          sectorIndustryChart.resize();
        }
        if (sectorConceptChart) {
          sectorConceptChart.resize();
        }
      }
    }, 40);
    post({
      type: 'setSectorView',
      mode: mode,
      kind: state.sectorKind,
      code: state.sectorDetail && state.sectorDetail.code
    });
  }

  function sectorTile(item, valueKey) {
    var value = number(item[valueKey]);
    return (
      '<button class="sector-tile ' +
      directionClass(value) +
      '" type="button" data-sector-code="' +
      escapeHtml(item.code) +
      '" data-sector-board-kind="' +
      escapeHtml(item.kind || 'industry') +
      '"><span>' +
      escapeHtml(item.name || item.code) +
      '</span><strong>' +
      escapeHtml(signed(value, 2, '%')) +
      '</strong></button>'
    );
  }

  function renderSectorFollows() {
    var container = byId('sectorFollows');
    if (!container) {
      return;
    }
    var followed = state.sectorFollows.map(function (code) {
      return findSectorBoard(code) || { code: code, name: code, percent: 0, kind: 'industry' };
    });
    container.innerHTML = followed.length
      ? followed
          .map(function (item) {
            return (
              '<button class="sector-follow-chip" type="button" data-sector-code="' +
              escapeHtml(item.code) +
              '" data-sector-board-kind="' +
              escapeHtml(item.kind || 'industry') +
              '"><b>' +
              escapeHtml(item.name || item.code) +
              '</b><span>' +
              escapeHtml(item.code) +
              '</span><strong class="' +
              directionClass(item.percent) +
              '">' +
              escapeHtml(signed(item.percent, 2, '%')) +
              '</strong><i data-sector-follow="' +
              escapeHtml(item.code) +
              '" title="取消关注">×</i></button>'
            );
          })
          .join('')
      : '<div class="sector-focus-empty">尚未关注板块，可在板块列表中点击关注按钮。</div>';
  }

  function ensureSectorFlowChart(elementId, items, kind) {
    var element = byId(elementId);
    if (!element || typeof echarts === 'undefined') {
      return;
    }
    var chart = kind === 'industry' ? sectorIndustryChart : sectorConceptChart;
    if (!chart) {
      chart = echarts.init(element, null, { renderer: 'canvas' });
      if (kind === 'industry') {
        sectorIndustryChart = chart;
      } else {
        sectorConceptChart = chart;
      }
      chart.on('click', function (params) {
        if (params && params.data && params.data.code) {
          openSectorDetail(params.data.code, kind);
        }
      });
    }
    var rows = (items || []).slice(0, 10).reverse();
    chart.setOption(
      {
        animation: false,
        backgroundColor: 'transparent',
        textStyle: {
          fontFamily: 'Segoe UI, Microsoft YaHei UI, sans-serif',
          fontSize: 14
        },
        grid: { left: 122, right: 58, top: 12, bottom: 30 },
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'shadow' },
          backgroundColor: '#252525',
          borderColor: '#555',
          textStyle: { color: '#e4e4e4', fontSize: 14 },
          formatter: function (params) {
            var data = params && params[0] && params[0].data;
            return data ? escapeHtml(data.name) + '<br/>主力净流入：' + sectorFlow(data.value) : '';
          }
        },
        xAxis: {
          type: 'value',
          axisLabel: {
            color: '#aeb6c4',
            fontSize: 13,
            formatter: function (value) { return (value / 100000000).toFixed(0); }
          },
          splitLine: { lineStyle: { color: '#374151', width: 1 } },
          axisLine: { show: false },
          axisTick: { show: false }
        },
        yAxis: {
          type: 'category',
          data: rows.map(function (item) { return item.name; }),
          axisLabel: { color: '#d4d7dd', fontSize: 15, width: 108, overflow: 'truncate' },
          axisLine: { show: false },
          axisTick: { show: false }
        },
        series: [
          {
            type: 'bar',
            barMaxWidth: 26,
            data: rows.map(function (item) {
              return {
                name: item.name,
                code: item.code,
                value: number(item.netInflow),
                itemStyle: { color: number(item.netInflow) >= 0 ? '#ff5b5d' : '#4dcc70' }
              };
            })
          }
        ]
      },
      true
    );
  }

  function renderSectorOverview() {
    if (!state.sectorOverview) {
      return;
    }
    var loading = byId('sectorLoading');
    if (loading) {
      loading.classList.add('hidden');
    }
    if (byId('sectorUpdatedAt')) {
      byId('sectorUpdatedAt').textContent = formatTime(state.sectorUpdatedAt || state.sectorOverview.updatedAt);
    }
    if (byId('sectorHot3d')) {
      byId('sectorHot3d').innerHTML = (state.sectorOverview.hot3d || [])
        .map(function (item) { return sectorTile(item, 'threeDayPercent'); })
        .join('');
    }
    if (byId('sectorFast3m')) {
      byId('sectorFast3m').innerHTML = (state.sectorOverview.fast3m || [])
        .map(function (item) { return sectorTile(item, 'threeMinutePercent'); })
        .join('');
    }
    renderSectorFollows();
    ensureSectorFlowChart(
      'sectorIndustryFlowChart',
      state.sectorOverview.industryTopInflow || [],
      'industry'
    );
    ensureSectorFlowChart(
      'sectorConceptFlowChart',
      state.sectorOverview.conceptTopInflow || [],
      'concept'
    );
  }

  function sectorRowsForKind() {
    var source = state.sectorKind === 'ranking'
      ? (state.sectorBoardsByKind.industry || []).concat(state.sectorBoardsByKind.concept || [])
      : state.sectorBoardsByKind[state.sectorKind] || [];
    var seen = Object.create(null);
    return source.filter(function (item) {
      var code = String(item.code || '').toUpperCase();
      if (seen[code]) {
        return false;
      }
      seen[code] = true;
      return true;
    });
  }

  function renderSectorList() {
    var rowsNode = byId('sectorRows');
    if (!rowsNode) {
      return;
    }
    var query = String(state.sectorQuery || '').trim().toLowerCase();
    var sortKey = state.sectorSort;
    var direction = state.sectorSortDirection === 'asc' ? 1 : -1;
    var rows = sectorRowsForKind()
      .filter(function (item) {
        return !query || String(item.name || '').toLowerCase().indexOf(query) >= 0 ||
          String(item.code || '').toLowerCase().indexOf(query) >= 0;
      })
      .sort(function (left, right) {
        var a = left[sortKey];
        var b = right[sortKey];
        if (typeof a === 'string' || typeof b === 'string') {
          return String(a || '').localeCompare(String(b || ''), 'zh-CN') * direction;
        }
        return (number(a) - number(b)) * direction;
      });
    all('#sectorListView [data-sector-kind]').forEach(function (button) {
      button.classList.toggle('active', button.getAttribute('data-sector-kind') === state.sectorKind);
    });
    all('#sectorListView [data-sector-sort]').forEach(function (button) {
      var active = button.getAttribute('data-sector-sort') === sortKey;
      button.classList.toggle('active', active);
      button.setAttribute('data-direction', active ? state.sectorSortDirection : '');
    });
    rowsNode.innerHTML = rows
      .map(function (item) {
        var cls = directionClass(item.percent);
        var followed = state.sectorFollows.indexOf(String(item.code).toUpperCase()) >= 0;
        return (
          '<tr><td><button class="sector-name-button" type="button" data-sector-code="' +
          escapeHtml(item.code) +
          '" data-sector-board-kind="' +
          escapeHtml(item.kind) +
          '"><b>' +
          escapeHtml(item.name) +
          '</b><span>' +
          escapeHtml(item.code) +
          '</span></button></td><td>' +
          escapeHtml(price(item.price)) +
          '</td><td class="' + cls + '">' +
          escapeHtml(signed(item.percent, 2, '%')) +
          '</td><td class="' + cls + '">' +
          escapeHtml(signed(item.change, 2, '')) +
          '</td><td>' +
          escapeHtml(number(item.turnover).toFixed(2) + '%') +
          '</td><td class="' + directionClass(item.netInflow) + '">' +
          escapeHtml(sectorFlow(item.netInflow)) +
          '</td><td><span class="rise">' +
          number(item.upCount) +
          '</span> / <span class="fall">' +
          number(item.downCount) +
          '</span></td><td><button class="sector-leader-button" type="button" data-sector-open-stock="' +
          escapeHtml(item.leaderCode || '') +
          '">' +
          escapeHtml(item.leaderName || '--') +
          '</button></td><td><button class="sector-follow-button' +
          (followed ? ' followed' : '') +
          '" type="button" data-sector-follow="' +
          escapeHtml(item.code) +
          '">' +
          svgIcon('watch', 'inline-icon') +
          '<span>' + (followed ? '已关注' : '关注') + '</span>' +
          '</button></td></tr>'
        );
      })
      .join('');
    var empty = byId('sectorListEmpty');
    if (empty) {
      empty.classList.toggle('hidden', rows.length > 0);
    }
    if (byId('sectorListUpdatedAt')) {
      byId('sectorListUpdatedAt').textContent = formatTime(state.sectorUpdatedAt);
    }
  }

  function requestSectorBoards(kind, force) {
    if (kind === 'ranking') {
      post({ type: 'loadSectorRanking', force: Boolean(force) });
      return;
    }
    post({ type: 'loadSectorBoards', kind: kind, force: Boolean(force) });
  }

  function openSectorList(kind) {
    state.sectorKind = ['industry', 'concept', 'ranking'].indexOf(kind) >= 0 ? kind : 'industry';
    state.sectorSort = state.sectorKind === 'ranking' ? 'percent' : 'netInflow';
    state.sectorSortDirection = 'desc';
    showSectorView('list');
    renderSectorList();
    if (
      (state.sectorKind === 'ranking' &&
        (!state.sectorBoardsByKind.industry.length || !state.sectorBoardsByKind.concept.length)) ||
      (state.sectorKind !== 'ranking' && !state.sectorBoardsByKind[state.sectorKind].length)
    ) {
      requestSectorBoards(state.sectorKind, false);
    }
    persist();
  }

  function renderSectorDetail() {
    var detail = state.sectorDetail || {};
    var board = findSectorBoard(detail.code) || { code: detail.code || '--', name: detail.code || '板块详情' };
    if (byId('sectorDetailTitle')) {
      byId('sectorDetailTitle').textContent = board.name || board.code;
    }
    if (byId('sectorDetailCode')) {
      byId('sectorDetailCode').textContent = board.code || '--';
    }
    if (byId('sectorDetailMetrics')) {
      byId('sectorDetailMetrics').innerHTML =
        '<span>最新 <b>' + escapeHtml(price(board.price)) + '</b></span>' +
        '<span>涨跌幅 <b class="' + directionClass(board.percent) + '">' +
        escapeHtml(signed(board.percent, 2, '%')) + '</b></span>' +
        '<span>涨跌额 <b class="' + directionClass(board.change) + '">' +
        escapeHtml(signed(board.change, 2, '')) + '</b></span>' +
        '<span>换手 <b>' + escapeHtml(number(board.turnover).toFixed(2) + '%') + '</b></span>' +
        '<span>主力净流入 <b class="' + directionClass(board.netInflow) + '">' +
        escapeHtml(sectorFlow(board.netInflow)) + '</b></span>' +
        '<span>上涨/下跌 <b><i class="rise">' + number(board.upCount) + '</i> / <i class="fall">' +
        number(board.downCount) + '</i></b></span>';
    }
    var followButton = byId('sectorDetailFollowButton');
    if (followButton) {
      var boardCode = String(board.code || detail.code || '').toUpperCase();
      var isFollowed = state.sectorFollows.indexOf(boardCode) >= 0;
      followButton.setAttribute('data-sector-code', boardCode);
      followButton.setAttribute('data-sector-board-kind', board.kind || detail.kind || 'industry');
      followButton.setAttribute('data-sector-follow', boardCode);
      followButton.classList.toggle('followed', isFollowed);
      followButton.innerHTML =
        svgIcon('watch', 'inline-icon') +
        '<span>' + (isFollowed ? '已关注' : '关注') + '</span>';
    }
    var constituents = Array.isArray(detail.data)
      ? detail.data
      : Array.isArray(detail.constituents)
        ? detail.constituents
        : [];
    constituents = constituents.slice().sort(function (left, right) {
      return number(right.percent) - number(left.percent);
    });
    var body = byId('sectorConstituentRows');
    if (body) {
      body.innerHTML = constituents
        .map(function (item) {
          var cls = directionClass(item.percent);
          return (
            '<tr><td><button class="sector-stock-button" type="button" data-sector-open-stock="' +
            escapeHtml(item.code) + '"><b>' + escapeHtml(item.name) + '</b><span>' +
            escapeHtml(item.code) + '</span></button></td><td>' + escapeHtml(price(item.price)) +
            '</td><td class="' + cls + '">' + escapeHtml(signed(item.percent, 2, '%')) +
            '</td><td class="' + cls + '">' + escapeHtml(signed(item.change, 2, '')) +
            '</td><td>' + escapeHtml(number(item.turnover).toFixed(2) + '%') +
            '</td><td class="' + directionClass(item.netInflow) + '">' +
            escapeHtml(sectorFlow(item.netInflow)) + '</td><td>' +
            escapeHtml(compact(item.marketCap)) + '</td><td><button class="sector-open-stock" type="button" data-sector-open-stock="' +
            escapeHtml(item.code) + '">查看走势</button><button class="sector-add-stock" type="button" data-sector-add-stock="' +
            escapeHtml(item.code) + '">加入自选</button></td></tr>'
          );
        })
        .join('');
    }
    if (byId('sectorDetailEmpty')) {
      byId('sectorDetailEmpty').classList.toggle('hidden', constituents.length > 0);
    }
  }

  function openSectorDetail(code, kind) {
    var normalized = String(code || '').toUpperCase();
    if (!/^BK\d{4}$/.test(normalized)) {
      return;
    }
    state.sectorDetail = { code: normalized, kind: kind || (findSectorBoard(normalized) || {}).kind, data: [] };
    showSectorView('detail');
    renderSectorDetail();
    post({ type: 'loadSectorDetail', bkCode: normalized, code: normalized, kind: state.sectorDetail.kind });
  }

  function movingAverage(dayCount, values) {
    return values.map(function (_item, index) {
      if (index < dayCount - 1) {
        return '-';
      }
      var sum = 0;
      for (var offset = 0; offset < dayCount; offset += 1) {
        sum += number(values[index - offset][1]);
      }
      return +(sum / dayCount).toFixed(3);
    });
  }

  function renderChart() {
    var chartElement = byId('klineChart');
    var chartLoading = byId('chartLoading');
    if (!state.chart || !chartElement) {
      return;
    }
    if (chartLoading) {
      chartLoading.classList.add('hidden');
    }
    if (!klineChart) {
      klineChart = echarts.init(chartElement, null, { renderer: 'canvas' });
    }
    var data = state.chart;
    var intervalNames = {
      trend: '分时',
      '1': '1 分钟',
      '5': '5 分钟',
      '15': '15 分钟',
      '30': '30 分钟',
      '60': '60 分钟',
      '101': '日 K',
      '102': '周 K',
      '103': '月 K'
    };
    if (byId('chartSubtitle')) {
      byId('chartSubtitle').textContent =
        (data.kind === 'candle' ? '前复权 · ' : '') +
        (intervalNames[data.interval] || data.interval) +
        ' · 东方财富';
    }

    var base = {
      animation: false,
      backgroundColor: '#181b21',
      textStyle: { color: '#9ca4b2' },
      axisPointer: {
        link: [{ xAxisIndex: 'all' }],
        label: { backgroundColor: '#39445a' }
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        backgroundColor: 'rgba(23,27,34,.96)',
        borderColor: '#47546a',
        textStyle: { color: '#d8dde7' }
      },
      grid: [
        { left: 60, right: 24, top: 45, height: '61%' },
        { left: 60, right: 24, top: '75%', height: '13%' }
      ]
    };

    if (data.kind === 'trend') {
      var trendPoints = data.points || [];
      var trendTimes = trendPoints.map(function (item) {
        return item.time.slice(11);
      });
      var trendVolumes = trendPoints.map(function (item) {
        return item.volume;
      });
      base.legend = {
        top: 10,
        data: ['价格', '均价'],
        textStyle: { color: '#a9b0bd' }
      };
      base.xAxis = [
        {
          type: 'category',
          data: trendTimes,
          boundaryGap: false,
          axisLine: { lineStyle: { color: '#4a5261' } },
          axisLabel: { color: '#7f8999', hideOverlap: true },
          splitLine: { show: false }
        },
        {
          type: 'category',
          gridIndex: 1,
          data: trendTimes,
          boundaryGap: false,
          axisLabel: { show: false },
          axisLine: { lineStyle: { color: '#4a5261' } }
        }
      ];
      base.yAxis = [
        {
          scale: true,
          splitNumber: 5,
          axisLabel: { color: '#8b95a6' },
          splitLine: { lineStyle: { color: '#2b303a', type: 'dashed' } }
        },
        {
          scale: true,
          gridIndex: 1,
          axisLabel: { color: '#737d8e', formatter: compact },
          splitLine: { show: false }
        }
      ];
      base.dataZoom = [
        { type: 'inside', xAxisIndex: [0, 1], start: 0, end: 100 },
        {
          type: 'slider',
          xAxisIndex: [0, 1],
          bottom: 4,
          height: 18,
          borderColor: '#323947',
          backgroundColor: '#1b1f27',
          fillerColor: 'rgba(0,122,204,.18)',
          textStyle: { color: '#737d8e' }
        }
      ];
      base.series = [
        {
          name: '价格',
          type: 'line',
          showSymbol: false,
          data: trendPoints.map(function (item) {
            return item.price;
          }),
          lineStyle: { color: '#37a7ff', width: 1.5 },
          areaStyle: { color: 'rgba(28,126,195,.12)' }
        },
        {
          name: '均价',
          type: 'line',
          showSymbol: false,
          data: trendPoints.map(function (item) {
            return item.average;
          }),
          lineStyle: { color: '#e2b93b', width: 1 }
        },
        {
          name: '成交量',
          type: 'bar',
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: trendVolumes,
          itemStyle: { color: '#53647e' }
        }
      ];
      klineChart.setOption(base, true);
      return;
    }

    var points = data.points || [];
    var categories = points.map(function (item) {
      return item.time;
    });
    var candleValues = points.map(function (item) {
      return [item.open, item.close, item.low, item.high];
    });
    var visibleStart = points.length > 100 ? Math.round((1 - 100 / points.length) * 100) : 0;
    base.legend = {
      top: 10,
      data: ['K线', 'MA5', 'MA10', 'MA20'],
      textStyle: { color: '#a9b0bd' }
    };
    base.xAxis = [
      {
        type: 'category',
        data: categories,
        boundaryGap: true,
        axisLine: { lineStyle: { color: '#4a5261' } },
        axisLabel: { color: '#7f8999', hideOverlap: true },
        splitLine: { show: false },
        min: 'dataMin',
        max: 'dataMax'
      },
      {
        type: 'category',
        gridIndex: 1,
        data: categories,
        boundaryGap: true,
        axisLine: { lineStyle: { color: '#4a5261' } },
        axisLabel: { show: false },
        min: 'dataMin',
        max: 'dataMax'
      }
    ];
    base.yAxis = [
      {
        scale: true,
        splitArea: { show: false },
        axisLabel: { color: '#8b95a6' },
        splitLine: { lineStyle: { color: '#2b303a', type: 'dashed' } }
      },
      {
        scale: true,
        gridIndex: 1,
        axisLabel: { color: '#737d8e', formatter: compact },
        splitLine: { show: false }
      }
    ];
    base.dataZoom = [
      { type: 'inside', xAxisIndex: [0, 1], start: visibleStart, end: 100 },
      {
        type: 'slider',
        xAxisIndex: [0, 1],
        start: visibleStart,
        end: 100,
        bottom: 4,
        height: 18,
        borderColor: '#323947',
        backgroundColor: '#1b1f27',
        fillerColor: 'rgba(0,122,204,.18)',
        textStyle: { color: '#737d8e' }
      }
    ];
    base.series = [
      {
        name: 'K线',
        type: 'candlestick',
        data: candleValues,
        itemStyle: {
          color: '#f0524f',
          color0: '#36ad67',
          borderColor: '#f0524f',
          borderColor0: '#36ad67'
        }
      },
      {
        name: 'MA5',
        type: 'line',
        data: movingAverage(5, candleValues),
        showSymbol: false,
        smooth: true,
        lineStyle: { opacity: 0.75, width: 1, color: '#e8d44d' }
      },
      {
        name: 'MA10',
        type: 'line',
        data: movingAverage(10, candleValues),
        showSymbol: false,
        smooth: true,
        lineStyle: { opacity: 0.75, width: 1, color: '#4da6ff' }
      },
      {
        name: 'MA20',
        type: 'line',
        data: movingAverage(20, candleValues),
        showSymbol: false,
        smooth: true,
        lineStyle: { opacity: 0.75, width: 1, color: '#d75ee8' }
      },
      {
        name: '成交量',
        type: 'bar',
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: points.map(function (item) {
          return {
            value: item.volume,
            itemStyle: { color: number(item.close) >= number(item.open) ? '#a6383b' : '#247748' }
          };
        })
      }
    ];
    klineChart.setOption(base, true);
  }

  function renderAll() {
    if (!state.selectedCode && state.snapshot.watchlist.length) {
      state.selectedCode = state.snapshot.watchlist[0];
    }
    renderWatchGroups();
    renderQuote();
    renderProfile();
    renderAssets();
  }

  function renderMarketClock() {
    var market = state.marketState || {};
    byId('marketClock').textContent = market.label && market.time
      ? market.label + ' · ' + market.time
      : 'A股';
  }

  document.addEventListener('click', function (event) {
    var target = event.target.closest('[data-sector-follow], button, article');
    if (!target) {
      return;
    }
    if (target.matches('.nav-item')) {
      var nextTab = target.getAttribute('data-tab');
      if (nextTab === 'sector' && state.tab === 'sector' && state.sectorMode !== 'overview') {
        showSectorView('overview');
        renderSectorOverview();
        return;
      }
      setTab(nextTab);
      return;
    }
    var sectorFollow = target.getAttribute('data-sector-follow');
    if (sectorFollow) {
      post({ type: 'toggleSectorFollow', code: sectorFollow });
      return;
    }
    var sectorStock = target.getAttribute('data-sector-open-stock');
    if (sectorStock) {
      post({ type: 'openSectorStock', code: sectorStock });
      return;
    }
    var sectorAddStock = target.getAttribute('data-sector-add-stock');
    if (sectorAddStock) {
      post({ type: 'addSectorStock', code: sectorAddStock });
      return;
    }
    var sectorSort = target.getAttribute('data-sector-sort');
    if (sectorSort) {
      if (state.sectorSort === sectorSort) {
        state.sectorSortDirection = state.sectorSortDirection === 'desc' ? 'asc' : 'desc';
      } else {
        state.sectorSort = sectorSort;
        state.sectorSortDirection = sectorSort === 'name' ? 'asc' : 'desc';
      }
      renderSectorList();
      return;
    }
    var sectorKind = target.getAttribute('data-sector-kind');
    if (sectorKind) {
      openSectorList(sectorKind);
      return;
    }
    var sectorCode = target.getAttribute('data-sector-code');
    if (sectorCode) {
      openSectorDetail(sectorCode, target.getAttribute('data-sector-board-kind'));
      return;
    }
    var stockCode = target.getAttribute('data-stock-code');
    if (stockCode) {
      selectStock(stockCode, true);
      return;
    }
    var filter = target.getAttribute('data-filter');
    if (filter) {
      state.cloudFilter = filter;
      all('[data-filter]').forEach(function (button) {
        button.classList.toggle('active', button.getAttribute('data-filter') === filter);
      });
      persist();
      byId('cloudLoading').classList.remove('hidden');
      post({ type: 'loadCloud', filter: filter, force: false });
      return;
    }
    var editCode = target.getAttribute('data-edit-holding');
    if (editCode) {
      var current = state.snapshot.holdings.find(function (item) {
        return item.code === editCode;
      });
      if (current) {
        openHoldingModal(current);
      }
      return;
    }
    var openCode = target.getAttribute('data-open-holding');
    if (openCode) {
      setTab('watch', false);
      selectStock(openCode, true);
      return;
    }
    var deleteCode = target.getAttribute('data-delete-holding');
    if (deleteCode) {
      var holding = state.snapshot.holdings.find(function (item) {
        return item.code === deleteCode;
      });
      var name = holding ? holding.name : deleteCode;
      if (window.confirm('确认删除“' + name + '”的本地持仓记录？')) {
        post({ type: 'deleteHolding', code: deleteCode });
      }
      return;
    }
    var newsUrl = target.getAttribute('data-news-url');
    if (newsUrl) {
      post({ type: 'openExternal', url: newsUrl });
    }
  });

  byId('stockFilter').addEventListener('input', renderWatchGroups);

  byId('refreshButton').addEventListener('click', function () {
    post({ type: 'refreshData', tab: state.tab, filter: state.cloudFilter });
    showToast('正在刷新当前页面…', false);
  });

  byId('refreshNewsButton').addEventListener('click', function () {
    byId('newsLoading').classList.remove('hidden');
    post({ type: 'loadNews', force: true });
  });

  byId('refreshCloudButton').addEventListener('click', function () {
    byId('cloudLoading').classList.remove('hidden');
    post({ type: 'loadCloud', filter: state.cloudFilter, force: true });
  });

  byId('fullscreenCloudButton').addEventListener('click', function () {
    byId('cloudPage').classList.toggle('fullscreen');
    scheduleCloudResize();
  });

  if (byId('backSectorOverviewButton')) {
    byId('backSectorOverviewButton').addEventListener('click', function () {
      showSectorView('overview');
      renderSectorOverview();
    });
  }

  if (byId('backSectorListButton')) {
    byId('backSectorListButton').addEventListener('click', function () {
      openSectorList(state.sectorKind || 'industry');
    });
  }

  if (byId('refreshSectorButton')) {
    byId('refreshSectorButton').addEventListener('click', function () {
      if (state.sectorMode === 'detail' && state.sectorDetail && state.sectorDetail.code) {
        post({
          type: 'loadSectorDetail',
          bkCode: state.sectorDetail.code,
          code: state.sectorDetail.code,
          kind: state.sectorDetail.kind,
          force: true
        });
      } else if (state.sectorMode === 'list') {
        requestSectorBoards(state.sectorKind, true);
      } else {
        if (byId('sectorLoading')) {
          byId('sectorLoading').classList.remove('hidden');
        }
        post({ type: 'loadSectorOverview', force: true });
      }
    });
  }

  if (byId('sectorSearch')) {
    byId('sectorSearch').addEventListener('input', function (event) {
      state.sectorQuery = event.target.value || '';
      renderSectorList();
    });
  }

  byId('addHoldingButton').addEventListener('click', function () {
    post({ type: 'pickHolding' });
  });

  byId('closeHoldingModal').addEventListener('click', closeHoldingModal);
  byId('cancelHoldingModal').addEventListener('click', closeHoldingModal);
  byId('holdingModal').addEventListener('click', function (event) {
    if (event.target === byId('holdingModal')) {
      closeHoldingModal();
    }
  });

  byId('holdingForm').addEventListener('submit', function (event) {
    event.preventDefault();
    post({
      type: 'saveHolding',
      holding: {
        code: byId('holdingCode').value,
        name: byId('holdingName').value,
        amount: number(byId('holdingAmount').value),
        cost: number(byId('holdingCost').value)
      }
    });
  });

  window.addEventListener('resize', function () {
    scheduleCloudResize();
    if (sectorIndustryChart) {
      sectorIndustryChart.resize();
    }
    if (sectorConceptChart) {
      sectorConceptChart.resize();
    }
  });

  window.addEventListener('message', function (event) {
    var message = event.data || {};
    switch (message.type) {
      case 'snapshot':
        state.snapshot = message.data || state.snapshot;
        renderAll();
        break;
      case 'marketState':
        state.marketState = message.data || null;
        renderMarketClock();
        break;
      case 'navigate':
        if (message.code) {
          var nextCode = String(message.code).toLowerCase();
          if (nextCode !== state.selectedCode) {
            state.selectedCode = nextCode;
            state.selectionQuote = quoteMap()[nextCode] || null;
            state.profile = null;
            state.profileLoading = true;
          }
        }
        setTab(message.tab || 'watch', false);
        renderWatchGroups();
        renderQuote();
        renderProfile();
        break;
      case 'selectionQuote':
        state.selectionQuote = message.data;
        if (message.data && message.data.code === state.selectedCode) {
          renderQuote();
          renderWatchGroups();
          renderProfileCommunity(state.profile || {});
        }
        break;
      case 'profileLoading':
        if (message.code && String(message.code).toLowerCase() !== state.selectedCode) {
          break;
        }
        state.profile = null;
        state.profileLoading = true;
        renderProfile();
        break;
      case 'profile':
        var profileCode = String(message.code || (message.data && message.data.code) || '').toLowerCase();
        if (profileCode && profileCode !== state.selectedCode) {
          break;
        }
        state.profile = message.data || {};
        state.profileLoading = false;
        renderProfile();
        break;
      case 'newsLoading':
        byId('newsLoading').classList.remove('hidden');
        break;
      case 'news':
        state.news = message.data || [];
        state.newsUpdatedAt = message.updatedAt || Date.now();
        renderNews();
        break;
      case 'cloudLoading':
        byId('cloudLoading').textContent = '正在生成 A 股云图…';
        byId('cloudLoading').classList.remove('cloud-unavailable');
        byId('cloudLoading').classList.remove('hidden');
        break;
      case 'cloudUnavailable':
        byId('cloudLoading').textContent =
          message.message || '暂无最近云图快照，点击右上角刷新按钮获取。';
        byId('cloudLoading').classList.add('cloud-unavailable');
        byId('cloudLoading').classList.remove('hidden');
        break;
      case 'cloudRefreshFailed':
        byId('cloudLoading').classList.add('hidden');
        showToast(
          message.message || '获取最近收盘云图失败，继续显示本地缓存。',
          true
        );
        break;
      case 'cloud':
        byId('cloudLoading').textContent = '正在生成 A 股云图…';
        byId('cloudLoading').classList.remove('cloud-unavailable');
        state.cloud = message.data || [];
        state.cloudFilter = message.filter || state.cloudFilter;
        state.cloudUpdatedAt = message.updatedAt || Date.now();
        all('[data-filter]').forEach(function (button) {
          button.classList.toggle(
            'active',
            button.getAttribute('data-filter') === state.cloudFilter
          );
        });
        scheduleCloudRender();
        persist();
        break;
      case 'sectorOverviewLoading':
        if (byId('sectorLoading')) {
          byId('sectorLoading').classList.remove('hidden');
        }
        break;
      case 'sectorOverview':
        state.sectorOverview = message.data || null;
        state.sectorUpdatedAt = message.updatedAt || Date.now();
        renderSectorOverview();
        break;
      case 'sectorBoardsLoading':
        if (byId('sectorListEmpty')) {
          byId('sectorListEmpty').textContent = '正在加载板块行情…';
          byId('sectorListEmpty').classList.remove('hidden');
        }
        break;
      case 'sectorBoards':
        var boardKind = message.kind === 'concept' ? 'concept' : 'industry';
        state.sectorBoardsByKind[boardKind] = message.data || [];
        state.sectorUpdatedAt = message.updatedAt || Date.now();
        if (byId('sectorListEmpty')) {
          byId('sectorListEmpty').textContent = '-- 暂无板块数据 --';
        }
        renderSectorList();
        renderSectorFollows();
        break;
      case 'sectorDetailLoading':
        var loadingSectorCode = String(message.bkCode || message.code || '').toUpperCase();
        state.sectorDetail = {
          code: loadingSectorCode,
          kind: (findSectorBoard(loadingSectorCode) || {}).kind,
          data: []
        };
        if (byId('sectorDetailEmpty')) {
          byId('sectorDetailEmpty').textContent = '正在加载成分股…';
          byId('sectorDetailEmpty').classList.remove('hidden');
        }
        renderSectorDetail();
        break;
      case 'sectorDetail':
        var detailSectorCode = String(message.bkCode || message.code || '').toUpperCase();
        state.sectorDetail = {
          code: detailSectorCode,
          kind: (findSectorBoard(detailSectorCode) || {}).kind,
          data: message.data || []
        };
        state.sectorUpdatedAt = message.updatedAt || Date.now();
        if (byId('sectorDetailEmpty')) {
          byId('sectorDetailEmpty').textContent = '-- 暂无成分股数据 --';
        }
        renderSectorDetail();
        break;
      case 'sectorFollows':
        state.sectorFollows = (message.data || []).map(function (code) {
          return String(code).toUpperCase();
        });
        renderSectorFollows();
        renderSectorList();
        break;
      case 'sectorStockAdded':
        showToast('已加入自选：' + String(message.code || '').toUpperCase());
        break;
      case 'holdingCandidate':
        openHoldingModal(message.data);
        break;
      case 'holdingSaved':
        closeHoldingModal();
        showToast('持仓已保存到本机。', false);
        break;
      case 'holdingDeleted':
        showToast('持仓记录已删除。', false);
        break;
      case 'error':
        if (byId('cloudLoading')) {
          byId('cloudLoading').classList.add('hidden');
        }
        if (byId('newsLoading')) {
          byId('newsLoading').classList.add('hidden');
        }
        if (byId('sectorLoading')) {
          byId('sectorLoading').classList.add('hidden');
        }
        if (state.tab === 'watch' && state.profileLoading) {
          state.profileLoading = false;
          state.profile = {};
          renderProfile();
        }
        showToast(message.message || '操作失败', true);
        break;
      default:
        break;
    }
  });

  renderMarketClock();
  setTab(state.tab, false);
  post({ type: 'ready' });
})();
