/* ==========================================================================
   ZSEARCH · 工作台
   --------------------------------------------------------------------------
   把四件「用得上但不是每次都要」的东西收进一个右侧抽屉，而不是把按钮摊在
   主界面上：
     收藏夹   —— 结果条目右上角星标，localStorage 持久化
     搜索历史 —— 记录查询词与结果数，可回填、可单删、可清空
     探活     —— 批量探测分享链接是否还有效（进度条 + 逐条状态点 + 分布条）
     状态看板 —— 拉 /api/status，把运行时长/内存/源健康/防护开关如实摊开

   再加一个不占面板的：导出 CSV（当前结果 / 收藏夹）。

   设计原则
     1. 单一数据源：`favs` / `hist` 两个数组就是唯一真相，任何修改都先落
        localStorage，再整体重绘。渲染函数之间互不调用。
     2. 与 results.js 解耦：results.js 只派发 `zsearch:rendered` 事件并暴露
        window.ZSearchResults，本文件订阅后自己去挂星标、自己重置探活。
        工作台脚本没加载时，搜索页依然完整可用。
     3. 抽屉挂在 <body> 直接子级。祖先带 backdrop-filter 会把 fixed 困住
        （本项目已踩过两次，见记忆里的 transform 同类坑）。
     4. 探活分批串行：一次 8 条，服务端再摊到 4 并发。上游 check 接口对
        并发敏感，一口气打 48 条会被限流成一半 unknown。
   ========================================================================== */

(function () {
  'use strict';

  /* -----------------------------------------------------------------------
     常量与存储
     ----------------------------------------------------------------------- */

  var LS_FAV = 'zs-fav-v1';
  var LS_HIST = 'zs-hist-v1';
  var HIST_MAX = 40;

  var PROBE_BATCH = 8;      // 每批请求条数
  var PROBE_GAP = 60;       // 两批之间的间隔，给上游一点喘息

  var PROVIDER_NAME = {
    pansou: '盘搜',
    jso: '珈珈',
    hunhepan: '混沌搜',
    zreso: '原站',
  };

  var CLOUD_LABEL = {
    quark: '夸克',
    baidu: '百度',
    uc: 'UC',
    xunlei: '迅雷',
  };

  /** 读 localStorage，坏数据一律当空数组，绝不让脏数据把页面打挂 */
  function readList(key) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return [];
      var v = JSON.parse(raw);
      return Array.isArray(v) ? v.filter(Boolean) : [];
    } catch (err) {
      return [];
    }
  }

  function writeList(key, list) {
    try {
      localStorage.setItem(key, JSON.stringify(list));
      return true;
    } catch (err) {
      toast('本地存储不可用，无法保存');
      return false;
    }
  }

  var favs = readList(LS_FAV);
  var hist = readList(LS_HIST);

  /* -----------------------------------------------------------------------
     小工具
     ----------------------------------------------------------------------- */

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtDuration(sec) {
    var s = Math.max(0, Math.round(Number(sec) || 0));
    if (s < 60) return s + ' 秒';
    var m = Math.floor(s / 60);
    if (m < 60) return m + ' 分 ' + (s % 60) + ' 秒';
    var h = Math.floor(m / 60);
    if (h < 24) return h + ' 小时 ' + (m % 60) + ' 分';
    return Math.floor(h / 24) + ' 天 ' + (h % 24) + ' 小时';
  }

  function fmtAgo(ts) {
    var d = Date.now() - Number(ts || 0);
    if (!Number.isFinite(d) || d < 0) return '';
    if (d < 60e3) return '刚刚';
    if (d < 3600e3) return Math.floor(d / 60e3) + ' 分钟前';
    if (d < 86400e3) return Math.floor(d / 3600e3) + ' 小时前';
    if (d < 7 * 86400e3) return Math.floor(d / 86400e3) + ' 天前';
    var dt = new Date(Number(ts));
    return (dt.getMonth() + 1) + '月' + dt.getDate() + '日';
  }

  function fmtDateStamp() {
    var d = new Date();
    var p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* -----------------------------------------------------------------------
     轻提示
     ----------------------------------------------------------------------- */

  var toastEl = null;
  var toastTimer = 0;

  function toast(msg) {
    if (!toastEl) {
      toastEl = el('div', 'wb-toast');
      toastEl.setAttribute('role', 'status');
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    // 强制回排，确保连续两次 toast 也有入场动画
    void toastEl.offsetWidth;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('show');
    }, 2000);
  }

  /* -----------------------------------------------------------------------
     图标
     ----------------------------------------------------------------------- */

  var SVG = {
    star: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
      ' stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M12 3.2l2.7 5.5 6 .9-4.35 4.25 1.03 6-5.38-2.83-5.38 2.83 1.03-6L3.3 9.6l6-.9z"/></svg>',

    panel: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
      ' stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<rect x="3.5" y="4.5" width="17" height="15" rx="2.6"/>' +
      '<path d="M9.5 4.8v14.4"/></svg>',

    close: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
      ' stroke-width="1.9" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',

    trash: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
      ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M4 7h16"/><path d="M9 7V4.8h6V7"/><path d="M6.5 7l.8 12.2h9.4L17.5 7"/>' +
      '<path d="M10.2 11v5M13.8 11v5"/></svg>',

    redo: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
      ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M20 11a8 8 0 1 0-2.6 5.9"/><path d="M20 4.5V11h-6.5"/></svg>',

    external: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
      ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M14 4h6v6"/><path d="M20 4l-8.5 8.5"/><path d="M18.5 14.5V19a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V7A1.5 1.5 0 0 1 5 5.5h4.5"/></svg>',

    probe: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
      ' stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M2 13h4l2.5-7 3.5 13 3-9 2 3h5"/></svg>',

    csv: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
      ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 3.5v11"/><path d="M7.5 10.5 12 15l4.5-4.5"/>' +
      '<path d="M4 16.5V19a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 19v-2.5"/></svg>',

    refresh: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
      ' stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M20 11a8 8 0 1 0-2.6 5.9"/><path d="M20 4.5V11h-6.5"/></svg>',
  };

  /* -----------------------------------------------------------------------
     收藏夹
     ----------------------------------------------------------------------- */

  /** 一条结果 → 收藏记录。id 用站内 /go 短链，同一资源不会重复收藏。 */
  function toRecord(item, query) {
    var url = item.first_url || item.target || '';
    return {
      id: url || item.title,
      title: item.title || '',
      url: url,
      cloud: item.cloud_type_name || CLOUD_LABEL[item.cloud_type] || item.cloud_type || '',
      date: item.date || '',
      q: query || '',
      at: Date.now(),
    };
  }

  function favIndex(id) {
    for (var i = 0; i < favs.length; i++) {
      if (favs[i] && favs[i].id === id) return i;
    }
    return -1;
  }

  function isFav(id) {
    return favIndex(id) > -1;
  }

  function toggleFav(record) {
    var i = favIndex(record.id);
    if (i > -1) {
      favs.splice(i, 1);
      writeList(LS_FAV, favs);
      toast('已取消收藏');
      return false;
    }
    favs.unshift(record);
    // 收藏夹不该无限膨胀：上限 300，超出丢最旧的
    if (favs.length > 300) favs.length = 300;
    writeList(LS_FAV, favs);
    toast('已加入收藏');
    return true;
  }

  function syncBadge() {
    var trigger = document.getElementById('wbTrigger');
    if (!trigger) return;
    var old = trigger.querySelector('.wb-badge');
    if (old) old.remove();
    if (!favs.length) return;
    var b = el('span', 'wb-badge', favs.length > 99 ? '99+' : String(favs.length));
    trigger.appendChild(b);
  }

  /* -----------------------------------------------------------------------
     搜索结果 ↔ 收藏记录
     ----------------------------------------------------------------------- */

  var items = [];            // results.js 派发过来的当前结果
  var itemsByHref = {};      // href → item，供星标反查

  function reindex() {
    itemsByHref = {};
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var href = it && (it.first_url || it.target);
      if (href) itemsByHref[href] = it;
    }
  }

  /* -----------------------------------------------------------------------
     抽屉骨架
     ----------------------------------------------------------------------- */

  var panel = null;
  var scrim = null;
  var tabs = [];
  var panes = {};
  var activeTab = 'fav';
  var statusTimer = 0;

  var TAB_DEFS = [
    { id: 'fav', label: '收藏' },
    { id: 'hist', label: '历史' },
    { id: 'status', label: '运行状态' },
  ];

  function buildPanel() {
    if (panel) return;

    scrim = el('div', 'wb-scrim');
    scrim.addEventListener('click', closePanel);

    panel = el('aside', 'wb-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', '工作台');

    var head = el('div', 'wb-head');
    head.appendChild(el('div', 'wb-title', '工作台'));
    var closeBtn = el('button', 'wb-close');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', '关闭');
    closeBtn.innerHTML = SVG.close;
    closeBtn.addEventListener('click', closePanel);
    head.appendChild(closeBtn);
    panel.appendChild(head);

    var tabBar = el('div', 'wb-tabs');
    tabBar.setAttribute('role', 'tablist');
    TAB_DEFS.forEach(function (def) {
      var b = el('button', 'wb-tab');
      b.type = 'button';
      b.dataset.tab = def.id;
      b.setAttribute('role', 'tab');
      b.textContent = def.label;
      b.addEventListener('click', function () { switchTab(def.id); });
      tabBar.appendChild(b);
      tabs.push(b);
    });
    panel.appendChild(tabBar);

    var body = el('div', 'wb-body');
    TAB_DEFS.forEach(function (def) {
      var pane = el('div', 'wb-pane');
      pane.dataset.pane = def.id;
      pane.hidden = true;
      body.appendChild(pane);
      panes[def.id] = pane;
    });
    panel.appendChild(body);

    document.body.appendChild(scrim);
    document.body.appendChild(panel);

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (!panel.classList.contains('is-open')) return;
      var t = e.target;
      var tag = t && t.tagName ? t.tagName.toLowerCase() : '';
      // 输入框里的 Esc 先交给输入框（比如清空搜索联想）
      if (tag === 'input' || tag === 'textarea') return;
      closePanel();
    });
  }

  function switchTab(id) {
    activeTab = id;
    tabs.forEach(function (b) {
      var on = b.dataset.tab === id;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    Object.keys(panes).forEach(function (k) {
      panes[k].hidden = k !== id;
    });

    if (id === 'fav') renderFavs();
    if (id === 'hist') renderHist();
    if (id === 'status') renderStatus();

    // 状态页 5 秒自动刷新一次，离开页面或切走就停，不做无意义的轮询
    clearInterval(statusTimer);
    statusTimer = 0;
    if (id === 'status') {
      statusTimer = setInterval(function () {
        if (!panel.classList.contains('is-open')) { clearInterval(statusTimer); return; }
        renderStatus(true);
      }, 5000);
    }
  }

  function openPanel(tab) {
    buildPanel();
    // 外观抽屉更矮一层，同时开会互相遮挡，开这个就先关那个
    if (window.ZSearchWall && typeof window.ZSearchWall.close === 'function') {
      window.ZSearchWall.close();
    }
    scrim.classList.add('is-open');
    panel.classList.add('is-open');
    var trigger = document.getElementById('wbTrigger');
    if (trigger) trigger.classList.add('is-open');
    switchTab(tab || activeTab || 'fav');
  }

  function closePanel() {
    if (!panel) return;
    scrim.classList.remove('is-open');
    panel.classList.remove('is-open');
    var trigger = document.getElementById('wbTrigger');
    if (trigger) trigger.classList.remove('is-open');
    clearInterval(statusTimer);
    statusTimer = 0;
  }

  /* -----------------------------------------------------------------------
     收藏面板
     ----------------------------------------------------------------------- */

  function renderFavs() {
    var pane = panes.fav;
    if (!pane) return;
    pane.textContent = '';

    if (!favs.length) {
      var empty = el('div', 'wb-empty');
      empty.appendChild(el('div', 'wb-empty-title', '还没有收藏'));
      empty.appendChild(el('div', 'wb-empty-desc', '在结果条目右上角点星标即可收藏，下次进来还能找到'));
      pane.appendChild(empty);
      updateTabCounts();
      return;
    }

    var label = el('div', 'wb-label');
    label.appendChild(el('span', null, '共 ' + favs.length + ' 条'));
    var exportBtn = el('button', 'wb-label-btn', '导出 CSV');
    exportBtn.type = 'button';
    exportBtn.addEventListener('click', function () { exportFavsCSV(); });
    label.appendChild(exportBtn);
    pane.appendChild(label);

    favs.forEach(function (f) { pane.appendChild(favRow(f)); });

    var hint = el('div', 'wb-empty-desc');
    hint.style.marginTop = '18px';
    hint.style.textAlign = 'left';
    hint.textContent = '收藏的链接指向本站中转映射，服务重启后会失效；届时点「重新搜索」按标题找回即可。';
    pane.appendChild(hint);

    updateTabCounts();
  }

  function favRow(f) {
    var row = el('div', 'wb-row');

    var main = el('div', 'wb-row-main');
    var a = el('a', 'wb-row-title', f.title || '(无标题)');
    a.href = f.url || '#';
    a.target = '_blank';
    a.rel = 'noopener noreferrer nofollow';
    main.appendChild(a);

    var meta = el('div', 'wb-row-meta');
    if (f.cloud) meta.appendChild(el('span', null, f.cloud));
    if (f.date) meta.appendChild(el('span', null, f.date));
    if (f.at) meta.appendChild(el('span', null, fmtAgo(f.at)));
    main.appendChild(meta);
    row.appendChild(main);

    var acts = el('div', 'wb-row-actions');

    var re = el('button', 'wb-icon-btn');
    re.type = 'button';
    re.title = '按标题重新搜索';
    re.setAttribute('aria-label', '重新搜索');
    re.innerHTML = SVG.redo;
    re.addEventListener('click', function () {
      var q = String(f.title || '').trim().slice(0, 40);
      closePanel();
      location.href = '/search?q=' + encodeURIComponent(q || f.q || '');
    });
    acts.appendChild(re);

    var del = el('button', 'wb-icon-btn danger');
    del.type = 'button';
    del.title = '移出收藏';
    del.setAttribute('aria-label', '移出收藏');
    del.innerHTML = SVG.trash;
    del.addEventListener('click', function () {
      var i = favIndex(f.id);
      if (i > -1) favs.splice(i, 1);
      writeList(LS_FAV, favs);
      renderFavs();
      syncStars();
      syncBadge();
    });
    acts.appendChild(del);

    row.appendChild(acts);
    return row;
  }

  /* -----------------------------------------------------------------------
     历史面板
     ----------------------------------------------------------------------- */

  function renderHist() {
    var pane = panes.hist;
    if (!pane) return;
    pane.textContent = '';

    hist = readList(LS_HIST);

    if (!hist.length) {
      var empty = el('div', 'wb-empty');
      empty.appendChild(el('div', 'wb-empty-title', '还没有搜索记录'));
      empty.appendChild(el('div', 'wb-empty-desc', '搜过的词会自动留在这里，方便回访'));
      pane.appendChild(empty);
      updateTabCounts();
      return;
    }

    var label = el('div', 'wb-label');
    label.appendChild(el('span', null, '最近 ' + hist.length + ' 次'));
    var clearBtn = el('button', 'wb-label-btn', '清空');
    clearBtn.type = 'button';
    clearBtn.addEventListener('click', function () {
      if (!window.confirm('清空全部搜索历史？此操作不可撤销。')) return;
      hist = [];
      writeList(LS_HIST, hist);
      renderHist();
      renderRecent();
    });
    label.appendChild(clearBtn);
    pane.appendChild(label);

    hist.forEach(function (h) {
      var row = el('div', 'wb-row');
      var main = el('div', 'wb-row-main');

      var b = el('a', 'wb-row-title', h.q || '');
      b.href = '/search?q=' + encodeURIComponent(h.q || '');
      main.appendChild(b);

      var meta = el('div', 'wb-row-meta');
      meta.appendChild(el('span', null, fmtAgo(h.at)));
      meta.appendChild(el('span', null, (Number(h.n) || 0) + ' 条结果'));
      main.appendChild(meta);
      row.appendChild(main);

      var acts = el('div', 'wb-row-actions');
      var del = el('button', 'wb-icon-btn danger');
      del.type = 'button';
      del.title = '删除这条记录';
      del.setAttribute('aria-label', '删除这条记录');
      del.innerHTML = SVG.trash;
      del.addEventListener('click', function () {
        hist = readList(LS_HIST).filter(function (x) { return x && x.q !== h.q; });
        writeList(LS_HIST, hist);
        renderHist();
        renderRecent();
      });
      acts.appendChild(del);
      row.appendChild(acts);

      pane.appendChild(row);
    });

    updateTabCounts();
  }

  function updateTabCounts() {
    tabs.forEach(function (b) {
      var n = b.querySelector('.wb-tab-n');
      if (n) n.remove();
      if (b.dataset.tab === 'fav' && favs.length) {
        b.appendChild(el('span', 'wb-tab-n', String(favs.length)));
      }
      if (b.dataset.tab === 'hist' && hist.length) {
        b.appendChild(el('span', 'wb-tab-n', String(hist.length)));
      }
    });
  }

  /* -----------------------------------------------------------------------
     运行状态看板
     ----------------------------------------------------------------------- */

  function renderStatus(silent) {
    var pane = panes.status;
    if (!pane) return;

    if (!silent) {
      pane.textContent = '';
      var loading = el('div', 'wb-empty');
      loading.appendChild(el('div', 'wb-empty-title', '读取中…'));
      pane.appendChild(loading);
    }

    fetch('/api/status', { headers: { Accept: 'application/json' }, cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) throw new Error('status');
        paintStatus(pane, j.data || {});
      })
      .catch(function () {
        pane.textContent = '';
        var box = el('div', 'wb-empty');
        box.appendChild(el('div', 'wb-empty-title', '读不到运行状态'));
        box.appendChild(el('div', 'wb-empty-desc', '本地服务可能没在跑，或 /api/status 被拦了'));
        pane.appendChild(box);
      });
  }

  function paintStatus(pane, d) {
    pane.textContent = '';

    var ps = d.processStats || {};
    var agg = d.aggregateStats || {};

    /* --- 指标卡 --- */
    var metrics = el('div', 'wb-metrics');
    metrics.appendChild(metric('运行时长', fmtDuration(ps.uptimeSec)));
    metrics.appendChild(metric('内存 RSS', ps.rssMB != null ? ps.rssMB + ' MB' : '—'));
    metrics.appendChild(metric('搜索缓存', String(agg.cacheSize != null ? agg.cacheSize : '—')));
    metrics.appendChild(metric('中转映射', String(d.goMapSize != null ? d.goMapSize : '—')));
    pane.appendChild(metrics);

    /* --- 运行信息 --- */
    pane.appendChild(sectionLabel('运行信息', function () { renderStatus(true); }, SVG.refresh, '刷新'));

    var kv = el('div');
    kv.appendChild(kvRow('上游', d.offlineMode ? '离线模式' : String(d.upstream || '—')));
    kv.appendChild(kvRow('数据源', String((d.sources || []).filter(function (s) { return s.enabled; }).length) + ' 个启用'));
    if (agg.totalCalls != null) {
      kv.appendChild(kvRow('累计搜索', agg.totalCalls + ' 次 · 命中缓存 ' + (agg.cacheHit || 0) + ' 次'));
    }
    if (ps.heapUsedMB != null) {
      kv.appendChild(kvRow('堆内存', ps.heapUsedMB + ' / ' + ps.heapTotalMB + ' MB'));
    }
    kv.appendChild(kvRow('运行环境', (ps.node || '—') + ' · ' + (ps.platform || '—') + ' · PID ' + (ps.pid || '—')));
    pane.appendChild(kv);

    /* --- 数据源健康 --- */
    var health = d.sourceHealth || {};
    var srcRows = (d.sources || []).filter(function (s) {
      return s.enabled || health[s.id];
    });

    if (srcRows.length) {
      pane.appendChild(sectionLabel('数据源健康'));
      srcRows.forEach(function (s) {
        pane.appendChild(srcRow(s, health[s.id]));
      });
    }

    /* --- 安全防护 --- */
    var sec = d.security || {};
    if (sec.enabled != null) {
      pane.appendChild(sectionLabel('安全防护'));
      var pills = el('div', 'wb-pills');
      pills.appendChild(pill('安全响应头', sec.headers));
      pills.appendChild(pill('跳转风险页', sec.riskPage));
      pills.appendChild(pill('高危拦截', sec.blockHighRisk));
      pills.appendChild(pill('结果风险标注', sec.annotateResults));
      pills.appendChild(pill('危险后缀提示', sec.fileWarnings));
      pane.appendChild(pills);
      if (sec.note) {
        var note = el('div', 'wb-empty-desc');
        note.style.textAlign = 'left';
        note.style.marginTop = '8px';
        note.textContent = sec.note;
        pane.appendChild(note);
      }
    }
  }

  function metric(k, v) {
    var box = el('div', 'wb-metric');
    box.appendChild(el('div', 'wb-metric-k', k));
    box.appendChild(el('div', 'wb-metric-v', v));
    return box;
  }

  function sectionLabel(text, onAction, icon, actionLabel) {
    var row = el('div', 'wb-label');
    row.appendChild(el('span', null, text));
    if (onAction) {
      var b = el('button', 'wb-label-btn');
      b.type = 'button';
      b.innerHTML = icon + '<span style="margin-left:4px;vertical-align:1px">' + escapeHtml(actionLabel || '') + '</span>';
      b.addEventListener('click', onAction);
      row.appendChild(b);
    }
    return row;
  }

  function kvRow(k, v) {
    var r = el('div', 'wb-kv');
    r.appendChild(el('b', null, k));
    r.appendChild(el('span', null, v));
    return r;
  }

  function srcRow(meta, h) {
    var box = el('div', 'wb-src');

    var head = el('div', 'wb-src-head');
    var cooling = h && h.cooling;
    var dotCls = !meta.enabled
      ? 'off'
      : cooling
        ? 'cool'
        : h && h.ok
          ? 'ok'
          : h && h.fail
            ? 'bad' /* 有失败记录但还没到熔断阈值 —— 黄灯，不是灰的 */
            : 'off';
    head.appendChild(el('span', 'dot ' + dotCls));
    head.appendChild(el('span', 'name', meta.label || meta.id));

    var state = '未调用';
    if (!meta.enabled) state = '已停用';
    else if (cooling) state = '冷却 ' + fmtDuration(Math.round((h.cooldownLeftMs || 0) / 1000));
    else if (h && h.ok) state = '正常';
    else if (h && h.fail) state = '异常';
    head.appendChild(el('span', 'state', state));
    box.appendChild(head);

    if (h) {
      var line = [];
      if (h.lastMs) line.push('上次 <em>' + h.lastMs + 'ms</em> / ' + h.lastCount + ' 条');
      line.push('成功 ' + (h.ok || 0));
      if (h.fail) line.push('失败 ' + h.fail);
      if (h.skip) line.push('跳过 ' + h.skip);
      if (h.trips) line.push('熔断 ' + h.trips + ' 次');
      if (h.lastError) line.push('最近错误 ' + h.lastError);

      var m = el('div', 'wb-src-meta');
      m.innerHTML = line.join(' · ');
      box.appendChild(m);
    }

    return box;
  }

  function pill(label, on) {
    var p = el('span', 'wb-pill ' + (on ? 'on' : 'off'), label);
    p.title = on ? '已开启' : '已关闭';
    return p;
  }

  /* -----------------------------------------------------------------------
     结果页工具条：批量探活 + 导出 CSV
     ----------------------------------------------------------------------- */

  var toolsBar = null;
  var probeBtn = null;
  var exportBtn = null;
  var probeMeter = null;
  var probeCount = null;
  var probeFill = null;
  var probeSummary = null;
  var probeStack = null;
  var probeLegend = null;

  var probing = false;
  var probeAbort = false;
  var probeState = {};   // href → 'pending' | 'valid' | 'invalid' | 'unknown'
  var probeTotal = 0;
  var probeDone = 0;

  function buildTools() {
    if (toolsBar) return;
    var anchor = document.getElementById('statsContainer');
    if (!anchor) return;

    toolsBar = el('div', 'wb-tools');
    toolsBar.hidden = true;

    probeBtn = el('button', 'tool-btn');
    probeBtn.type = 'button';
    probeBtn.innerHTML = SVG.probe + '<span>批量探活</span>';
    probeBtn.title = '分批检测这些分享链接是否还有效（会更慢，但能筛掉失效资源）';
    probeBtn.addEventListener('click', function () {
      if (probing) { probeAbort = true; probeBtn.classList.remove('busy'); return; }
      probeAll();
    });

    exportBtn = el('button', 'tool-btn');
    exportBtn.type = 'button';
    exportBtn.innerHTML = SVG.csv + '<span>导出 CSV</span>';
    exportBtn.title = '把当前结果导出为表格（Excel 可直接打开）';
    exportBtn.addEventListener('click', exportResultsCSV);

    probeMeter = el('div', 'probe-meter');
    probeMeter.hidden = true;
    probeCount = el('span', 'probe-count', '0/0');
    var track = el('span', 'probe-track');
    probeFill = el('i', 'probe-fill');
    track.appendChild(probeFill);
    probeMeter.appendChild(probeCount);
    probeMeter.appendChild(track);

    probeSummary = el('div', 'probe-summary');
    probeSummary.hidden = true;
    probeStack = el('div', 'probe-stack');
    probeStack.innerHTML = '<i class="s-valid" style="width:0"></i><i class="s-invalid" style="width:0"></i><i class="s-unknown" style="width:0"></i>';
    probeLegend = el('div', 'probe-legend');
    probeSummary.appendChild(probeStack);
    probeSummary.appendChild(probeLegend);

    toolsBar.appendChild(probeBtn);
    toolsBar.appendChild(exportBtn);
    toolsBar.appendChild(probeMeter);
    toolsBar.appendChild(probeSummary);

    anchor.insertAdjacentElement('afterend', toolsBar);
  }

  function syncTools() {
    if (!toolsBar) return;
    var has = items.length > 0;
    toolsBar.hidden = !has;
    if (!has && probing) {
      probeAbort = true;
      resetProbeUI();
    }
    if (has && !probing) {
      // 结果换了 → 旧的探活结论不再成立
      if (Object.keys(probeState).length) resetProbeUI();
    }
    if (exportBtn) exportBtn.title = '导出当前 ' + items.length + ' 条结果为 CSV';
  }

  function resetProbeUI() {
    probing = false;
    probeAbort = false;
    probeState = {};
    probeTotal = 0;
    probeDone = 0;
    if (probeMeter) probeMeter.hidden = true;
    if (probeSummary) probeSummary.hidden = true;
    if (probeBtn) {
      probeBtn.classList.remove('busy');
      probeBtn.disabled = false;
      probeBtn.innerHTML = SVG.probe + '<span>批量探活</span>';
    }
    // 清掉列表上的状态点
    Array.prototype.forEach.call(document.querySelectorAll('.alive-dot'), function (d) { d.remove(); });
  }

  function probeAll() {
    var targets = [];
    for (var i = 0; i < items.length; i++) {
      var href = items[i] && (items[i].first_url || items[i].target);
      if (!href || !/^\/go\/[0-9a-f]{1,16}$/i.test(href)) continue;
      if (targets.indexOf(href) === -1) targets.push(href);
    }
    if (!targets.length) {
      toast('这批结果没有可探测的站内链接');
      return;
    }

    probing = true;
    probeAbort = false;
    probeState = {};
    probeTotal = targets.length;
    probeDone = 0;

    targets.forEach(function (h) { probeState[h] = 'pending'; });

    probeBtn.classList.add('busy');
    probeBtn.innerHTML = SVG.probe + '<span>停止</span>';
    probeMeter.hidden = false;
    probeSummary.hidden = true;
    updateProbeMeter();
    markDots(targets);

    var idx = 0;

    function nextBatch() {
      if (probeAbort || idx >= targets.length) {
        finishProbe();
        return;
      }
      var slice = targets.slice(idx, idx + PROBE_BATCH);
      idx += slice.length;

      var hashes = slice.map(function (h) { return h.replace('/go/', ''); });
      fetch('/api/link/check-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ hashes: hashes }),
      })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          var data = (j && j.data) || {};
          slice.forEach(function (h) {
            var hash = h.replace('/go/', '');
            var rec = data[hash];
            probeState[h] = rec && rec.status ? rec.status : 'unknown';
            probeDone++;
          });
        })
        .catch(function () {
          // 整批失败：这批全记 unknown，不重试 —— 重试只会把用户等更久
          slice.forEach(function (h) {
            probeState[h] = 'unknown';
            probeDone++;
          });
        })
        .then(function () {
          updateProbeMeter();
          paintDots(slice);
          if (probeAbort) { finishProbe(); return; }
          setTimeout(nextBatch, PROBE_GAP);
        });
    }

    nextBatch();
  }

  function finishProbe() {
    probing = false;
    probeAbort = false;
    if (probeBtn) {
      probeBtn.classList.remove('busy');
      probeBtn.innerHTML = SVG.probe + '<span>重新探活</span>';
    }
    updateProbeMeter();
    renderProbeSummary();
  }

  function updateProbeMeter() {
    if (!probeCount || !probeFill) return;
    probeCount.textContent = probeDone + '/' + probeTotal;
    probeFill.style.width = probeTotal ? (probeDone / probeTotal) * 100 + '%' : '0%';
  }

  function countProbe() {
    var c = { valid: 0, invalid: 0, unknown: 0 };
    Object.keys(probeState).forEach(function (k) {
      var s = probeState[k];
      if (s === 'valid') c.valid++;
      else if (s === 'invalid') c.invalid++;
      else if (s === 'unknown') c.unknown++;
    });
    return c;
  }

  function renderProbeSummary() {
    var c = countProbe();
    var total = c.valid + c.invalid + c.unknown;
    if (!total) return;

    probeMeter.hidden = true;
    probeSummary.hidden = false;

    var segs = probeStack.querySelectorAll('i');
    segs[0].style.width = (c.valid / total) * 100 + '%';
    segs[1].style.width = (c.invalid / total) * 100 + '%';
    segs[2].style.width = (c.unknown / total) * 100 + '%';

    probeLegend.innerHTML =
      '<span><i class="s-valid"></i>' + c.valid + ' 有效</span>' +
      '<span><i class="s-invalid"></i>' + c.invalid + ' 失效</span>' +
      '<span><i class="s-unknown"></i>' + c.unknown + ' 未知</span>';
  }

  /** 给列表每条结果插一个状态点（只插一次，靠 data-href 认领） */
  function markDots(targets) {
    Array.prototype.forEach.call(
      document.querySelectorAll('#resultList .result-item[data-href]'),
      function (row) {
        var href = row.dataset.href;
        if (targets.indexOf(href) === -1) return;
        var snippet = row.querySelector('.result-snippet');
        if (!snippet) return;
        var dot = snippet.querySelector('.alive-dot');
        if (!dot) {
          dot = el('span', 'alive-dot');
          snippet.insertBefore(dot, snippet.firstChild);
        }
        dot.dataset.href = href;
        dot.dataset.state = 'pending';
        dot.title = '检测中…';
      }
    );
  }

  function paintDots(hrefs) {
    var map = {
      valid: ['有效', '#16a34a'],
      invalid: ['已失效', '#dc2626'],
      unknown: ['无法判断', ''],
    };
    hrefs.forEach(function (href) {
      var row = document.querySelector('#resultList .result-item[data-href="' + cssEscape(href) + '"]');
      if (!row) return;
      var dot = row.querySelector('.alive-dot');
      if (!dot) return;
      var st = probeState[href] || 'unknown';
      dot.dataset.state = st;
      dot.title = (map[st] && map[st][0]) || '未知';
    });
  }

  /** 属性选择器里的引号/反斜杠要转义，避免 href 里的特殊字符打断查询 */
  function cssEscape(s) {
    return String(s).replace(/(["\\])/g, '\\$1');
  }

  /* -----------------------------------------------------------------------
     CSV
     ----------------------------------------------------------------------- */

  function csvCell(v) {
    var s = v == null ? '' : String(v);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function toCSV(rows) {
    // BOM 必须有：否则 Excel 双击打开中文全是乱码；CRLF 同理（Excel 对 LF 容忍度低）
    return '\uFEFF' + rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n');
  }

  function download(filename, text) {
    var blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // 立刻 revoke 在部分 Chromium 版本会中断下载，给 1.5 秒缓冲
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  function absolute(href) {
    if (!href) return '';
    if (/^https?:\/\//i.test(href)) return href;
    return location.origin + href;
  }

  function exportResultsCSV() {
    if (!items.length) {
      toast('当前没有可导出的结果');
      return;
    }
    var q = (window.ZSearchResults && window.ZSearchResults.getState().q) || '';

    var rows = [['序号', '标题', '网盘', '日期', '来源', '状态', '风险', '标签', '备注', '链接']];

    items.forEach(function (it, i) {
      var href = it.first_url || it.target || '';
      var risk = it.sec && it.sec.level && it.sec.level !== 'safe'
        ? ({ low: '低风险', medium: '注意', high: '高风险' }[it.sec.level] || it.sec.level)
        : '';
      rows.push([
        i + 1,
        it.title || '',
        it.cloud_type_name || CLOUD_LABEL[it.cloud_type] || it.cloud_type || '',
        it.date || '',
        PROVIDER_NAME[it.provider] || it.provider || '',
        it.status === 'invalid' ? '失效' : it.status === 'valid' || it.status === 'fast_acquire' ? '有效' : '',
        risk,
        Array.isArray(it.tags) ? it.tags.join(' / ') : '',
        it.note || '',
        absolute(href),
      ]);
    });

    download('zsearch_' + (q ? encodeURIComponent(q).slice(0, 24) : 'results') + '_' + fmtDateStamp() + '.csv', toCSV(rows));
    toast('已导出 ' + items.length + ' 条');
  }

  function exportFavsCSV() {
    if (!favs.length) {
      toast('收藏夹是空的');
      return;
    }
    var rows = [['序号', '标题', '网盘', '资源日期', '搜索词', '收藏时间', '链接']];
    favs.forEach(function (f, i) {
      rows.push([
        i + 1,
        f.title || '',
        f.cloud || '',
        f.date || '',
        f.q || '',
        f.at ? new Date(f.at).toLocaleString('zh-CN') : '',
        absolute(f.url),
      ]);
    });
    download('zsearch_favorites_' + fmtDateStamp() + '.csv', toCSV(rows));
    toast('已导出收藏 ' + favs.length + ' 条');
  }

  /* -----------------------------------------------------------------------
     星标（结果条目右上角）
     ----------------------------------------------------------------------- */

  function syncStars() {
    var rows = document.querySelectorAll('#resultList .result-item[data-href]');
    Array.prototype.forEach.call(rows, function (row) {
      var href = row.dataset.href;
      var on = isFav(href);
      var btn = row.querySelector('.fav-btn');

      if (!btn) {
        btn = el('button', 'fav-btn');
        btn.type = 'button';
        btn.innerHTML = SVG.star;
        btn.addEventListener('click', function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          var item = itemsByHref[href];
          if (!item) {
            toast('这条结果的上下文已过期，请重新搜索');
            return;
          }
          var q = (window.ZSearchResults && window.ZSearchResults.getState().q) || '';
          var nowOn = toggleFav(toRecord(item, q));
          btn.classList.toggle('is-on', nowOn);
          row.classList.toggle('has-fav', nowOn);
          btn.title = nowOn ? '取消收藏' : '加入收藏';
          btn.setAttribute('aria-pressed', nowOn ? 'true' : 'false');
          // 一点弹性反馈：按下去"弹"一下，比纯状态色变化更容易被看见
          btn.classList.add('pop');
          setTimeout(function () { btn.classList.remove('pop'); }, 190);
          syncBadge();
          if (activeTab === 'fav' && panel && panel.classList.contains('is-open')) renderFavs();
        });
        row.appendChild(btn);
      }

      btn.classList.toggle('is-on', on);
      row.classList.toggle('has-fav', on);
      btn.title = on ? '取消收藏' : '加入收藏';
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  /* -----------------------------------------------------------------------
     首页：最近搜索
     ----------------------------------------------------------------------- */

  function renderRecent() {
    var host = document.querySelector('.home-main');
    var form = document.getElementById('searchForm');
    if (!host || !form) return;

    var box = document.getElementById('wbRecent');
    var list = readList(LS_HIST).slice(0, 8);

    if (!list.length) {
      if (box) box.hidden = true;
      return;
    }

    if (!box) {
      box = el('div', 'wb-recent');
      box.id = 'wbRecent';
      form.insertAdjacentElement('afterend', box);
    }
    box.hidden = false;
    box.textContent = '';

    var head = el('div', 'wb-recent-head');
    head.appendChild(el('span', null, '最近搜索'));
    var clear = el('button', 'wb-recent-clear', '清空');
    clear.type = 'button';
    clear.addEventListener('click', function () {
      writeList(LS_HIST, []);
      hist = [];
      renderRecent();
      toast('已清空搜索历史');
    });
    head.appendChild(clear);
    box.appendChild(head);

    var chips = el('div', 'wb-recent-chips');
    list.forEach(function (h) {
      var b = el('button', 'wb-recent-chip');
      b.type = 'button';
      b.title = (Number(h.n) || 0) + ' 条结果 · ' + fmtAgo(h.at);
      b.appendChild(el('span', null, h.q || ''));
      b.addEventListener('click', function () {
        var input = document.getElementById('searchInput');
        var f = document.getElementById('searchForm');
        if (input && f) {
          input.value = h.q || '';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          f.submit();
        } else {
          location.href = '/search?q=' + encodeURIComponent(h.q || '');
        }
      });
      chips.appendChild(b);
    });
    box.appendChild(chips);
  }

  /* -----------------------------------------------------------------------
     触发按钮挂载
     ----------------------------------------------------------------------- */

  function mountTrigger() {
    var host = document.querySelector('.home-header-right') ||
      document.querySelector('.results-topbar-actions');
    if (!host || document.getElementById('wbTrigger')) return;

    var btn = el('button', 'wb-trigger');
    btn.id = 'wbTrigger';
    btn.type = 'button';
    btn.setAttribute('aria-label', '打开工作台');
    btn.title = '工作台：收藏 · 历史 · 运行状态';
    btn.innerHTML = SVG.panel;
    btn.addEventListener('click', function () {
      if (panel && panel.classList.contains('is-open')) closePanel();
      else openPanel('fav');
    });

    // 放在外观按钮之前，保持「主功能在左、外观在右」的顺序
    host.insertBefore(btn, host.firstChild);
    syncBadge();
  }

  /* -----------------------------------------------------------------------
     事件订阅
     ----------------------------------------------------------------------- */

  document.addEventListener('zsearch:rendered', function (ev) {
    var d = (ev && ev.detail) || {};
    items = Array.isArray(d.items) ? d.items : [];
    reindex();

    buildTools();
    syncTools();

    if (!items.length) return;

    // 两阶段搜索：阶段 1 已有结果、阶段 2 会整体覆盖。
    // 阶段 1 也挂星标（用户可能这时候就想收藏），但探活结论不跨阶段继承。
    syncStars();

    if (typeof d.partial === 'boolean' && d.partial) {
      // 阶段 1 到达，清掉探活status：等全量结果再探测才有意义
      if (probeTotal) resetProbeUI();
    }
  });

  // 历史可能被 results.js 在别处写入（它自己也记一份），面板打开时重读一次
  window.addEventListener('storage', function (e) {
    if (e.key === LS_HIST) {
      hist = readList(LS_HIST);
      if (panel && panel.classList.contains('is-open') && activeTab === 'hist') renderHist();
      if (document.getElementById('wbRecent')) renderRecent();
    }
    if (e.key === LS_FAV) {
      favs = readList(LS_FAV);
      syncStars();
      syncBadge();
      if (panel && panel.classList.contains('is-open') && activeTab === 'fav') renderFavs();
    }
  });

  /* -----------------------------------------------------------------------
     启动
     ----------------------------------------------------------------------- */

  function init() {
    mountTrigger();
    buildTools();
    syncTools();
    renderRecent();

    // 结果页：results.js 可能已经先跑完首屏了（脚本顺序在前），
    // 这里主动同步一次，免得工作台错过第一次事件。
    if (window.ZSearchResults && typeof window.ZSearchResults.items === 'function') {
      items = window.ZSearchResults.items();
      reindex();
      syncTools();
      if (items.length) syncStars();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
