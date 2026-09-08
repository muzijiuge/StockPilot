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
    sectorSortModes: { industry: 'percent', concept: 'percent' },
    collapsed: Object.assign(
      { holding: false, stocks: false, stock: false, index: true, industry: false, concept: false },
      restored.collapsed || {}
    ),
    hoveredKey: '',
    contextTarget: null,
    contextGroupId: '',
    draggedCode: '',
    draggedGroupId: '',
    community: {
      visible: false,
      code: '',
      name: '',
      sort: 'hot',
      posts: [],
      loading: false,
      hasMore: true,
      warning: '',
      error: ''
    },
    communityDetail: {
      visible: false,
      post: null,
      ipLocation: '',
      comments: [],
      loading: false,
      commentsLoading: false,
      commentsHaveMore: false,
      commentTotal: 0,
      error: '',
      commentsError: '',
      repliesLoading: Object.create(null),
      repliesError: Object.create(null)
    }
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

  function compactCount(value) {
    var current = Math.max(0, number(value));
    if (current >= 10000) {
      return (current / 10000).toFixed(current >= 100000 ? 0 : 1) + '万';
    }
    return String(Math.round(current));
  }

  function communityTime(value) {
    var timestamp = number(value);
    if (!timestamp) {
      return '';
    }
    var date = new Date(timestamp);
    var now = new Date();
    var sameYear = date.getFullYear() === now.getFullYear();
    var pad = function (part) { return part < 10 ? '0' + String(part) : String(part); };
    return (sameYear ? '' : date.getFullYear() + '-') +
      pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' +
      pad(date.getHours()) + ':' + pad(date.getMinutes());
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
      (state.sectorSortModes[item.kind] === 'heat' ? '热度' : '涨幅') +
        '第' + String(rank) + '名 ' + (item.name || item.code) + ' ' + percent.textContent
    );
  }

  function updateSectorSortToggle(kind) {
    var button = document.querySelector('[data-sector-sort-toggle="' + kind + '"]');
    if (!button) {
      return;
    }
    var heat = state.sectorSortModes[kind] === 'heat';
    var label = heat
      ? (kind === 'industry' ? '行业板块' : '概念板块') + '当前按热度排序，点击恢复涨幅排序'
      : (kind === 'industry' ? '行业板块' : '概念板块') + '切换为热度排序';
    button.classList.toggle('active', heat);
    button.setAttribute('aria-pressed', String(heat));
    button.setAttribute('aria-label', label);
    button.title = label;
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
    updateSectorSortToggle(kind);
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

  function createCommunityCard(post) {
    var card = document.createElement('article');
    card.className = 'community-card';
    card.tabIndex = 0;
    card.setAttribute('role', 'link');
    card.dataset.postId = String(post.id || '');

    var header = document.createElement('div');
    header.className = 'community-card-header';
    var avatar = document.createElement('div');
    avatar.className = 'community-avatar';
    if (post.avatar) {
      var avatarImage = document.createElement('img');
      avatarImage.src = post.avatar;
      avatarImage.alt = '';
      avatarImage.loading = 'lazy';
      avatarImage.referrerPolicy = 'no-referrer';
      avatarImage.addEventListener('error', function () {
        avatar.textContent = String(post.author || '同').slice(0, 1);
      });
      avatar.appendChild(avatarImage);
    } else {
      avatar.textContent = String(post.author || '同').slice(0, 1);
    }
    var authorBlock = document.createElement('div');
    authorBlock.className = 'community-author';
    var authorName = document.createElement('strong');
    authorName.textContent = post.author || '同花顺用户';
    var publishedAt = document.createElement('span');
    publishedAt.textContent = communityTime(post.publishedAt);
    authorBlock.appendChild(authorName);
    authorBlock.appendChild(publishedAt);
    header.appendChild(avatar);
    header.appendChild(authorBlock);
    card.appendChild(header);

    if (post.title) {
      var title = document.createElement('h3');
      title.textContent = post.title;
      card.appendChild(title);
    }
    if (post.content) {
      var content = document.createElement('p');
      content.className = 'community-card-content';
      content.textContent = post.content;
      card.appendChild(content);
    }
    if (Array.isArray(post.images) && post.images.length) {
      var imageGrid = document.createElement('div');
      imageGrid.className = 'community-images community-images-' +
        String(Math.min(3, post.images.length));
      post.images.slice(0, 9).forEach(function (url) {
        var image = document.createElement('img');
        image.src = url;
        image.alt = '帖子图片';
        image.loading = 'lazy';
        image.referrerPolicy = 'no-referrer';
        image.addEventListener('error', function () { image.remove(); });
        imageGrid.appendChild(image);
      });
      card.appendChild(imageGrid);
    }
    if (Array.isArray(post.tags) && post.tags.length) {
      var tags = document.createElement('div');
      tags.className = 'community-tags';
      post.tags.forEach(function (tag) {
        var chip = document.createElement('span');
        chip.textContent = tag;
        tags.appendChild(chip);
      });
      card.appendChild(tags);
    }
    var stats = document.createElement('div');
    stats.className = 'community-stats';
    stats.innerHTML =
      '<span>评论 <b></b></span><span>赞 <b></b></span><span>转发 <b></b></span>';
    var values = stats.querySelectorAll('b');
    values[0].textContent = compactCount(post.commentCount);
    values[1].textContent = compactCount(post.likeCount);
    values[2].textContent = compactCount(post.forwardCount);
    card.appendChild(stats);
    card.setAttribute('aria-label',
      (post.author || '同花顺用户') + ' ' + (post.title || post.content || '社区帖子'));
    return card;
  }

  function fillCommunityAvatar(target, post) {
    target.replaceChildren();
    if (post && post.avatar) {
      var image = document.createElement('img');
      image.src = post.avatar;
      image.alt = '';
      image.referrerPolicy = 'no-referrer';
      image.addEventListener('error', function () {
        target.replaceChildren(document.createTextNode(String(post.author || '同').slice(0, 1)));
      });
      target.appendChild(image);
    } else {
      target.textContent = String((post && post.author) || '同').slice(0, 1);
    }
  }

  function createCommunityComment(comment, rootId, child) {
    var item = document.createElement('article');
    item.className = child ? 'community-comment community-comment-reply' : 'community-comment';
    item.dataset.commentId = String(comment.id || '');
    var header = document.createElement('div');
    header.className = 'community-comment-header';
    var avatar = document.createElement('div');
    avatar.className = 'community-avatar community-comment-avatar';
    fillCommunityAvatar(avatar, comment);
    var identity = document.createElement('div');
    identity.className = 'community-comment-identity';
    var author = document.createElement('strong');
    author.textContent = comment.author || '同花顺用户';
    if (comment.isAuthor) {
      var owner = document.createElement('i');
      owner.textContent = '作者';
      author.appendChild(owner);
    }
    var time = document.createElement('span');
    time.textContent = communityTime(comment.publishedAt);
    identity.appendChild(author);
    identity.appendChild(time);
    header.appendChild(avatar);
    header.appendChild(identity);
    item.appendChild(header);
    var content = document.createElement('p');
    if (comment.replyTo && child) {
      var replyTo = document.createElement('b');
      replyTo.textContent = '回复 @' + comment.replyTo + '：';
      content.appendChild(replyTo);
    }
    content.appendChild(document.createTextNode(comment.content || ''));
    item.appendChild(content);

    if (!child) {
      var replies = Array.isArray(comment.replies) ? comment.replies : [];
      if (replies.length) {
        var replyList = document.createElement('div');
        replyList.className = 'community-comment-replies';
        replies.forEach(function (reply) {
          replyList.appendChild(createCommunityComment(reply, comment.id, true));
        });
        item.appendChild(replyList);
      }
      var replyCount = Math.max(number(comment.replyCount), replies.length);
      if (replyCount > replies.length) {
        var more = document.createElement('button');
        more.type = 'button';
        more.className = 'community-replies-more';
        more.dataset.communityRepliesRoot = String(rootId || comment.id || '');
        if (state.communityDetail.repliesLoading[String(comment.id)]) {
          more.disabled = true;
          more.textContent = '正在加载全部回复…';
        } else {
          more.textContent = '展开全部 ' + String(replyCount) + ' 条回复';
        }
        item.appendChild(more);
      }
      var replyError = state.communityDetail.repliesError[String(comment.id)];
      if (replyError) {
        var error = document.createElement('div');
        error.className = 'community-replies-error';
        error.textContent = replyError;
        item.appendChild(error);
      }
    }
    return item;
  }

  function renderCommunityDetail() {
    var detail = state.communityDetail;
    var page = byId('communityDetailPage');
    page.classList.toggle('hidden', !detail.visible);
    if (!detail.visible) {
      return;
    }
    var post = detail.post || {};
    byId('communityDetailStock').textContent = state.community.name || state.community.code || '';
    fillCommunityAvatar(byId('communityDetailAvatar'), post);
    byId('communityDetailAuthor').textContent = post.author || '同花顺用户';
    var meta = [communityTime(post.publishedAt), detail.ipLocation ? 'IP属地 ' + detail.ipLocation : '']
      .filter(Boolean)
      .join(' · ');
    byId('communityDetailMeta').textContent = meta;
    var title = byId('communityDetailTitle');
    title.textContent = post.title || '';
    title.classList.toggle('hidden', !post.title);
    byId('communityDetailContent').textContent = post.content || (detail.loading ? '正在加载完整正文…' : '');
    var images = byId('communityDetailImages');
    images.replaceChildren();
    (Array.isArray(post.images) ? post.images : []).forEach(function (url) {
      var image = document.createElement('img');
      image.src = url;
      image.alt = '帖子图片';
      image.loading = 'lazy';
      image.referrerPolicy = 'no-referrer';
      image.addEventListener('error', function () { image.remove(); });
      images.appendChild(image);
    });
    var tags = byId('communityDetailTags');
    tags.replaceChildren();
    (Array.isArray(post.tags) ? post.tags : []).forEach(function (tag) {
      var chip = document.createElement('span');
      chip.textContent = tag;
      tags.appendChild(chip);
    });
    byId('communityDetailStats').innerHTML =
      '<span>评论 <b>' + compactCount(detail.commentTotal || post.commentCount) +
      '</b></span><span>赞 <b>' + compactCount(post.likeCount) +
      '</b></span><span>转发 <b>' + compactCount(post.forwardCount) + '</b></span>';
    byId('communityCommentTotal').textContent = compactCount(detail.commentTotal);
    byId('communityDetailRefresh').classList.toggle('loading', detail.loading);
    byId('communityDetailExternal').classList.toggle('hidden', !post.url);

    var comments = byId('communityComments');
    comments.replaceChildren();
    detail.comments.forEach(function (comment) {
      comments.appendChild(createCommunityComment(comment, comment.id, false));
    });
    var status = byId('communityCommentsStatus');
    status.replaceChildren();
    if (detail.error) {
      var detailError = document.createElement('span');
      detailError.textContent = detail.error;
      var retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'community-detail-retry community-retry';
      retry.textContent = '重试';
      status.appendChild(detailError);
      status.appendChild(retry);
    } else if (detail.commentsError) {
      var commentError = document.createElement('span');
      commentError.textContent = detail.commentsError;
      var commentRetry = document.createElement('button');
      commentRetry.type = 'button';
      commentRetry.className = 'community-comments-retry community-retry';
      commentRetry.textContent = '重试';
      status.appendChild(commentError);
      status.appendChild(commentRetry);
    } else if (detail.loading) {
      status.textContent = '正在加载完整动态与评论…';
    } else if (detail.commentsLoading) {
      status.textContent = '正在加载更多评论…';
    } else if (!detail.comments.length) {
      status.textContent = '暂无评论';
    } else if (!detail.commentsHaveMore) {
      status.textContent = '全部评论已加载';
    } else {
      status.textContent = '继续向下滚动加载更多评论';
    }
  }

  function renderCommunity() {
    var community = state.community;
    var detailVisible = state.communityDetail.visible;
    byId('sidebar').classList.toggle('hidden', community.visible || detailVisible);
    byId('communityPage').classList.toggle('hidden', !community.visible || detailVisible);
    renderCommunityDetail();
    if (!community.visible || detailVisible) {
      return;
    }
    hideTooltip();
    hideContextMenu();
    hideWatchGroupContextMenu();
    byId('communityName').textContent = community.name || '同花顺社区';
    byId('communityCode').textContent = community.code || '';
    byId('communityRefresh').classList.toggle('loading', community.loading);

    var notice = byId('communityNotice');
    notice.textContent = community.warning || '';
    notice.classList.toggle('hidden', !community.warning);
    var feed = byId('communityFeed');
    var expectedPosts = Object.create(null);
    community.posts.forEach(function (post) {
      expectedPosts[post.id] = true;
      var existing = Array.prototype.find.call(feed.children, function (card) {
        return card.dataset.postId === String(post.id);
      });
      feed.appendChild(existing || createCommunityCard(post));
    });
    Array.prototype.slice.call(feed.children).forEach(function (card) {
      if (!expectedPosts[card.dataset.postId]) {
        card.remove();
      }
    });
    var status = byId('communityStatus');
    status.replaceChildren();
    if (community.error) {
      var errorText = document.createElement('span');
      errorText.textContent = community.error;
      var retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'community-retry';
      retry.textContent = '重试';
      status.appendChild(errorText);
      status.appendChild(retry);
    } else if (community.loading) {
      status.textContent = community.posts.length ? '正在加载更多…' : '正在加载社区内容…';
    } else if (!community.posts.length) {
      status.textContent = community.warning ? '' : '暂无社区内容';
    } else if (!community.hasMore) {
      status.textContent = '已经到底了';
    } else {
      status.textContent = '继续向下滚动加载更多';
    }
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
    vscode.setState({
      collapsed: state.collapsed
    });
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
    var communityAction = menu.querySelector('[data-context-action="community"]');
    var holdingAction = menu.querySelector('[data-context-action="holding"]');
    var moveGroupAction = menu.querySelector('[data-context-action="move-group"]');
    var removeAction = menu.querySelector('[data-context-action="remove"]');
    state.contextTarget = {
      code: row.dataset.code,
      kind: row.dataset.kind,
      groupId: row.dataset.watchGroupId || ''
    };
    communityAction.classList.toggle('hidden', row.dataset.kind === 'index');
    holdingAction.classList.toggle('hidden', row.dataset.kind === 'index');
    moveGroupAction.classList.toggle('hidden', row.dataset.kind !== 'stock');
    removeAction.textContent = row.dataset.kind === 'stock'
      ? '从当前分组移除'
      : '从侧栏移除';
    hideWatchGroupContextMenu();
    positionContextMenu(menu, clientX, clientY);
    (row.dataset.kind === 'index' ? removeAction : communityAction).focus();
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
    var sectorSortToggle = event.target.closest('[data-sector-sort-toggle]');
    if (sectorSortToggle) {
      vscode.postMessage({
        type: 'toggleSectorSort',
        kind: sectorSortToggle.getAttribute('data-sector-sort-toggle')
      });
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
    if (actionName === 'community') {
      vscode.postMessage({
        type: 'openCommunity',
        code: target.code,
        sort: state.community.sort
      });
    } else if (actionName === 'holding') {
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

  byId('communityBack').addEventListener('click', function () {
    state.community.visible = false;
    state.communityDetail.visible = false;
    renderCommunity();
    vscode.postMessage({ type: 'closeCommunity' });
  });

  byId('communityDetailBack').addEventListener('click', function () {
    state.communityDetail.visible = false;
    state.community.visible = true;
    renderCommunity();
    window.scrollTo(0, 0);
    vscode.postMessage({ type: 'closeCommunityDetail' });
  });

  byId('communityDetailExternal').addEventListener('click', function () {
    vscode.postMessage({ type: 'openCommunityPostExternal' });
  });

  byId('communityDetailRefresh').addEventListener('click', function () {
    if (state.communityDetail.loading) {
      return;
    }
    state.communityDetail.loading = true;
    state.communityDetail.error = '';
    state.communityDetail.commentsError = '';
    renderCommunityDetail();
    window.scrollTo(0, 0);
    vscode.postMessage({ type: 'refreshCommunityDetail' });
  });

  byId('communityComments').addEventListener('click', function (event) {
    var button = event.target.closest('[data-community-replies-root]');
    if (!button || button.disabled) {
      return;
    }
    var rootId = button.getAttribute('data-community-replies-root');
    state.communityDetail.repliesLoading[rootId] = true;
    delete state.communityDetail.repliesError[rootId];
    renderCommunityDetail();
    vscode.postMessage({ type: 'loadCommunityReplies', rootId: rootId });
  });

  byId('communityCommentsStatus').addEventListener('click', function (event) {
    if (event.target.closest('.community-detail-retry')) {
      state.communityDetail.loading = true;
      state.communityDetail.error = '';
      renderCommunityDetail();
      vscode.postMessage({ type: 'refreshCommunityDetail' });
    } else if (event.target.closest('.community-comments-retry')) {
      state.communityDetail.commentsLoading = true;
      state.communityDetail.commentsError = '';
      renderCommunityDetail();
      vscode.postMessage({ type: 'loadMoreCommunityComments' });
    }
  });

  byId('communityRefresh').addEventListener('click', function () {
    if (state.community.loading) {
      return;
    }
    state.community.posts = [];
    state.community.loading = true;
    state.community.error = '';
    state.community.warning = '';
    state.community.hasMore = true;
    renderCommunity();
    window.scrollTo(0, 0);
    vscode.postMessage({ type: 'refreshCommunity' });
  });

  function openCommunityCard(event) {
    var card = event.target.closest('.community-card');
    if (!card) {
      return;
    }
    vscode.postMessage({ type: 'openCommunityPost', postId: card.dataset.postId });
  }

  byId('communityFeed').addEventListener('click', openCommunityCard);
  byId('communityFeed').addEventListener('keydown', function (event) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openCommunityCard(event);
    }
  });
  byId('communityStatus').addEventListener('click', function (event) {
    if (!event.target.closest('.community-retry')) {
      return;
    }
    state.community.error = '';
    state.community.loading = true;
    renderCommunity();
    vscode.postMessage({
      type: state.community.posts.length ? 'loadMoreCommunity' : 'refreshCommunity'
    });
  });

  function requestMoreCommunity() {
    if (
      state.community.visible &&
      state.community.posts.length &&
      state.community.hasMore &&
      !state.community.loading &&
      !state.community.error
    ) {
      state.community.loading = true;
      renderCommunity();
      vscode.postMessage({ type: 'loadMoreCommunity' });
    }
  }

  var communityObserver = new IntersectionObserver(function (entries) {
    if (entries.some(function (entry) { return entry.isIntersecting; })) {
      requestMoreCommunity();
    }
  }, { rootMargin: '360px 0px' });
  communityObserver.observe(byId('communitySentinel'));

  var communityCommentsObserver = new IntersectionObserver(function (entries) {
    if (
      entries.some(function (entry) { return entry.isIntersecting; }) &&
      state.communityDetail.visible &&
      state.communityDetail.comments.length &&
      state.communityDetail.commentsHaveMore &&
      !state.communityDetail.loading &&
      !state.communityDetail.commentsLoading &&
      !state.communityDetail.commentsError
    ) {
      state.communityDetail.commentsLoading = true;
      renderCommunityDetail();
      vscode.postMessage({ type: 'loadMoreCommunityComments' });
    }
  }, { rootMargin: '360px 0px' });
  communityCommentsObserver.observe(byId('communityCommentsSentinel'));

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
      state.sectorSortModes = Object.assign(
        { industry: 'percent', concept: 'percent' },
        message.sortModes || {}
      );
      render();
    } else if (message.type === 'communityState') {
      var wasVisible = state.community.visible;
      state.community.visible = true;
      state.community.code = String(message.code || '');
      state.community.name = String(message.name || '');
      state.community.sort = 'hot';
      var incoming = Array.isArray(message.posts) ? message.posts : [];
      if (message.append) {
        var known = Object.create(null);
        state.community.posts.forEach(function (post) { known[post.id] = true; });
        incoming.forEach(function (post) {
          if (!known[post.id]) {
            known[post.id] = true;
            state.community.posts.push(post);
          }
        });
      } else {
        state.community.posts = incoming;
      }
      state.community.loading = Boolean(message.loading);
      state.community.hasMore = Boolean(message.hasMore);
      state.community.warning = String(message.warning || '');
      state.community.error = String(message.error || '');
      persist();
      renderCommunity();
      if (!wasVisible || !message.append) {
        window.scrollTo(0, 0);
      }
    } else if (message.type === 'communityDetailState') {
      var wasDetailVisible = state.communityDetail.visible;
      state.community.visible = true;
      state.communityDetail.visible = true;
      state.communityDetail.post = message.post || state.communityDetail.post;
      var detailComments = Array.isArray(message.comments) ? message.comments : [];
      if (message.append) {
        var knownComments = Object.create(null);
        state.communityDetail.comments.forEach(function (comment) {
          knownComments[comment.id] = true;
        });
        detailComments.forEach(function (comment) {
          if (!knownComments[comment.id]) {
            knownComments[comment.id] = true;
            state.communityDetail.comments.push(comment);
          }
        });
      } else {
        state.communityDetail.comments = detailComments;
        state.communityDetail.repliesLoading = Object.create(null);
        state.communityDetail.repliesError = Object.create(null);
      }
      if (typeof message.ipLocation === 'string') {
        state.communityDetail.ipLocation = message.ipLocation;
      }
      state.communityDetail.loading = Boolean(message.loading);
      state.communityDetail.commentsLoading = Boolean(message.commentsLoading);
      state.communityDetail.commentsHaveMore = Boolean(message.commentsHaveMore);
      state.communityDetail.commentTotal = number(message.commentTotal);
      state.communityDetail.error = String(message.error || '');
      state.communityDetail.commentsError = '';
      renderCommunity();
      if (!wasDetailVisible || !message.append) {
        window.scrollTo(0, 0);
      }
    } else if (message.type === 'communityDetailClosed') {
      state.communityDetail.visible = false;
      state.community.visible = true;
      renderCommunity();
    } else if (message.type === 'communityCommentsLoading') {
      state.communityDetail.commentsLoading = Boolean(message.loading);
      state.communityDetail.commentsError = '';
      renderCommunityDetail();
    } else if (message.type === 'communityCommentsError') {
      state.communityDetail.commentsLoading = false;
      state.communityDetail.commentsError = String(message.error || '同花顺评论加载失败');
      renderCommunityDetail();
    } else if (message.type === 'communityRepliesLoading') {
      state.communityDetail.repliesLoading[String(message.rootId || '')] = true;
      renderCommunityDetail();
    } else if (message.type === 'communityReplies') {
      var replyRootId = String(message.rootId || '');
      delete state.communityDetail.repliesLoading[replyRootId];
      var rootComment = state.communityDetail.comments.find(function (comment) {
        return String(comment.id) === replyRootId;
      });
      if (message.error) {
        state.communityDetail.repliesError[replyRootId] = String(message.error);
      } else if (rootComment) {
        rootComment.replies = Array.isArray(message.replies) ? message.replies : [];
        rootComment.replyCount = rootComment.replies.length;
        delete state.communityDetail.repliesError[replyRootId];
      }
      renderCommunityDetail();
    }
  });

  Object.keys(state.collapsed).forEach(applyCollapsedState);
  renderCommunity();
  document.body.classList.remove('booting');
  vscode.postMessage({ type: 'ready' });
})();
