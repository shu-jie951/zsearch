/* ZSEARCH · 搜索结果页交互
   在原有多源聚合渲染之上，补充：
     - 顶部滚动进度条
     - 结果条目渐入编排（只对首屏做，避免长列表卡顿）
     - 键盘导航（j / k 移动，Enter 打开，Esc 取消）
     - 来源归属改为徽章 + 状态文案人话化
     - 空状态给出可点击的备选关键词
*/
(function () {
  'use strict';

  document.getElementById('current-year').textContent = new Date().getFullYear();

  const resultsMain = document.getElementById('resultsMain');
  const statsContainer = document.getElementById('statsContainer');
  const resultList = document.getElementById('resultList');
  const sortField = document.getElementById('sortField');
  const cloudField = document.getElementById('cloudField');
  const sortToggle = document.getElementById('sortToggle');
  const sortLabel = document.getElementById('sortLabel');
  const cloudTabs = document.getElementById('cloudTabs');

  const params = new URLSearchParams(location.search);
  const state = {
    q: params.get('q') || '',
    sort: params.get('sort') === 'oldest' ? 'oldest' : 'latest',
    cloud: ['all', 'quark', 'baidu', 'uc', 'xunlei'].includes(params.get('cloud'))
      ? params.get('cloud')
      : 'all',
  };

  /* ---------------------------------------------------------------------
     初始化界面状态
     --------------------------------------------------------------------- */
  const input = document.getElementById('resultsSearchInput');
  const submitBtn = document.getElementById('resultsSubmitBtn');
  const clearBtn = document.getElementById('resultsClearBtn');

  input.value = state.q;
  document.title = state.q ? state.q + ' - ZSEARCH' : '搜索 - ZSEARCH';
  sortField.value = state.sort;
  cloudField.value = state.cloud;
  sortLabel.textContent = state.sort === 'oldest' ? '最早优先' : '最新优先';
  resultsMain.dataset.query = state.q;
  resultsMain.dataset.sort = state.sort;
  resultsMain.dataset.cloud = state.cloud;

  function syncTabs() {
    cloudTabs.querySelectorAll('.cloud-tab[data-cloud]').forEach(function (el) {
      el.classList.toggle('active', el.dataset.cloud === state.cloud);
    });
  }
  syncTabs();
  syncSubmitState();

  function syncSubmitState() {
    submitBtn.classList.toggle('active', !!input.value.trim());
    // 首页搜索框有清空键，结果页也必须有：同一个动作在两个页面表现不一致，
    // 是最容易被用户感知到的"半成品感"。
    if (clearBtn) clearBtn.hidden = !input.value.trim();
  }

  input.addEventListener('input', syncSubmitState);

  if (clearBtn) {
    clearBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      input.value = '';
      syncSubmitState();
      input.focus();
    });
  }

  // Esc 清空（输入为空时不拦截，留给页面其他 Esc 行为）
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && input.value) {
      e.preventDefault();
      input.value = '';
      syncSubmitState();
    }
  });

  /* ---------------------------------------------------------------------
     排序 & 筛选：改 URL 后重新拉数据（不整页刷新）
     --------------------------------------------------------------------- */
  sortToggle.addEventListener('click', function (e) {
    e.preventDefault();
    state.sort = state.sort === 'latest' ? 'oldest' : 'latest';
    sortLabel.textContent = state.sort === 'oldest' ? '最早优先' : '最新优先';
    resultsMain.dataset.sort = state.sort;
    syncUrl();
    load();
  });

  cloudTabs.querySelectorAll('.cloud-tab[data-cloud]').forEach(function (el) {
    el.addEventListener('click', function (e) {
      e.preventDefault();
      state.cloud = el.dataset.cloud;
      headBackToTop();
      syncTabs();
      resultsMain.dataset.cloud = state.cloud;
      syncUrl();
      load();
    });
  });

  function syncUrl() {
    const p = new URLSearchParams();
    p.set('q', state.q);
    if (state.sort !== 'latest') p.set('sort', state.sort);
    if (state.cloud !== 'all') p.set('cloud', state.cloud);
    history.replaceState(null, '', '/search?' + p.toString());
  }

  function headBackToTop() {
    try {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      window.scrollTo(0, 0);
    }
  }

  /* ---------------------------------------------------------------------
     渲染
     --------------------------------------------------------------------- */
  const CLOUD_ICON = {
    quark: { src: '/static/quark.png', name: '夸克网盘' },
    baidu: { src: '/static/baidu.png', name: '百度网盘' },
    uc: { src: '/static/uc.png', name: 'UC网盘' },
    xunlei: { src: '/static/xunlei.png', name: '迅雷云盘' },
  };

  const PROVIDER_NAME = {
    pansou: '盘搜',
    jso: '珈珈',
    hunhepan: '混沌搜',
    zreso: '原站',
  };

  function createBadge(status) {
    const map = {
      fast_acquire: { cls: 'fast', dot: 'dot-green', text: '快速' },
      valid: { cls: 'valid', dot: 'dot-green', text: '有效' },
      invalid: { cls: 'invalid', dot: 'dot-red', text: '失效' },
    };
    if (status === 'fallback') {
      const b = document.createElement('span');
      b.className = 'resource-badge fallback';
      b.innerHTML = '<span class="status-dot dot-amber"></span>演示';
      b.title = '该结果来自本地演示数据，非实时抓取';
      return b;
    }
    const cfg = map[status];
    if (!cfg) return null;
    const b = document.createElement('span');
    b.className = 'resource-badge ' + cfg.cls;
    b.innerHTML = '<span class="status-dot ' + cfg.dot + '"></span>' + cfg.text;
    return b;
  }

  /* ---------------------------------------------------------------------
     安全徽章（防病毒 / 防钓鱼提示）
     服务端 /api/search 返回的 item.sec：
       { level, score, safe, host, fileKind, fileExt, warnings[] }
     设计原则：**安全的什么都不显示**，只有低/中/高才出徽章，
     否则每条都挂个"安全"会把真正有害的那条淹掉。
     点击徽章展开详情（warnings 逐条列出）。
     --------------------------------------------------------------------- */
  function createSecurityBadge(item) {
    const sec = item && item.sec;
    if (!sec || !sec.level) return null;
    if (sec.level === 'safe') return null;

    const map = {
      low: { cls: 'sec-low', dot: 'dot-blue', text: '低风险' },
      medium: { cls: 'sec-medium', dot: 'dot-amber', text: '注意' },
      high: { cls: 'sec-high', dot: 'dot-red', text: '高风险' },
    };
    const cfg = map[sec.level];
    if (!cfg) return null;

    const b = document.createElement('span');
    b.className = 'resource-badge sec ' + cfg.cls;
    b.innerHTML = '<span class="status-dot ' + cfg.dot + '"></span>' + cfg.text;

    const isFile = sec.fileKind === 'dangerous';
    const warnList = Array.isArray(sec.warnings) ? sec.warnings.filter(Boolean) : [];
    const tipLines = [];
    if (sec.host) tipLines.push('目标域名：' + sec.host);
    if (isFile) tipLines.push('可执行文件类型：.' + (sec.fileExt || 'exe'));
    for (const w of warnList) tipLines.push('· ' + w);
    if (!tipLines.length) tipLines.push('该结果触发了安全检查规则，点击查看详情');
    b.title = tipLines.join('\n');

    b.setAttribute('role', 'button');
    b.setAttribute('tabindex', '0');

    // 点击展开一个内联详情块（不弹窗、不打断浏览）
    function toggle(ev) {
      if (ev) { ev.preventDefault(); ev.stopPropagation(); }
      const next = b.nextElementSibling;
      if (next && next.classList && next.classList.contains('sec-detail')) {
        next.remove();
        return;
      }
      const box = document.createElement('div');
      box.className = 'sec-detail';
      const ul = document.createElement('ul');
      const items = [];
      if (sec.host) items.push('目标域名：' + sec.host);
      if (isFile) items.push('检测到可执行文件（.' + (sec.fileExt || 'exe') + '），下载后请先杀毒');
      for (const w of warnList) items.push(w);
      if (!items.length) items.push('命中安全检查规则');
      for (const line of items) {
        const li = document.createElement('li');
        li.textContent = line;
        ul.appendChild(li);
      }
      const foot = document.createElement('div');
      foot.className = 'sec-detail-foot';
      foot.textContent = '跳转时会先弹出安全提示页；本站不做病毒扫描，请务必自行杀毒。';
      box.appendChild(ul);
      box.appendChild(foot);
      b.insertAdjacentElement('afterend', box);
    }

    b.addEventListener('click', toggle);
    b.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') toggle(e);
    });
    return b;
  }

  function renderStats(query, count, data, opts) {
    statsContainer.textContent = '';
    if (!count) {
      statsContainer.style.display = 'none';
      return;
    }
    statsContainer.style.display = 'flex';

    const span = document.createElement('span');
    span.innerHTML = '找到 <b>' + count + '</b> 条与「' + escapeHtml(query) + '」相关的资源';
    statsContainer.appendChild(span);

    // 两阶段的第一阶段：先把快速源的结果给出来，同时明说还有来源在跑，
    // 否则用户会以为这就是全部。
    if (opts && opts.partial) {
      const pending = document.createElement('span');
      pending.className = 'src-tag pending';
      pending.textContent = '更多来源搜索中';
      pending.title = '夸克资源的主力来源较慢，结果到达后会自动补齐';
      statsContainer.appendChild(pending);
    }

    const tag = document.createElement('span');
    tag.className = 'src-tag';

    const isAgg = data && (data.source === 'aggregate' || data.source === 'aggregate-empty' || data.source === 'no-result');
    if (isAgg) {
      const list = (data.providers || []).filter(function (p) { return p.ok; });
      const names = list
        .map(function (p) { return (PROVIDER_NAME[p.id] || p.id) + ' ' + p.count; })
        .join(' · ');
      tag.textContent = data.fromCache
        ? '聚合 · 已缓存'
        : (names ? '聚合 ' + list.length + ' 源' : '聚合');
      tag.title = list.length
        ? '数据源：' + list.map(function (p) {
            return (PROVIDER_NAME[p.id] || p.id) + ' ' + p.count + ' 条 / ' + p.ms + 'ms';
          }).join('，')
        : '多源聚合结果';
    } else if (data && data.source === 'upstream') {
      tag.textContent = data.cached ? '实时数据 · 已缓存' : '实时数据';
    } else {
      tag.className = 'src-tag warn';
      tag.textContent = '离线数据';
      const reasonMap = {
        'circuit-open': '上游暂不可用，已自动熔断保护',
        'rate-limited': '请求过于频繁，已限速',
        'offline-mode': '服务运行在离线模式',
        'all-sources-empty': '所有数据源暂未返回结果',
        'upstream-timeout': '上游响应超时，不是没有资源，稍后重试通常就有',
      };
      const msg = reasonMap[data && data.reason];
      tag.title = msg || '上游不可达，已自动降级到本地数据';
    }
    statsContainer.appendChild(tag);

    if (isAgg && Array.isArray(data.degraded) && data.degraded.length) {
      const warn = document.createElement('span');
      warn.className = 'src-tag warn';
      warn.textContent = data.degraded.length + ' 源未响应';
      warn.title = '以下数据源本次未返回结果：' +
        data.degraded.map(function (id) { return PROVIDER_NAME[id] || id; }).join('、') +
        '（其他源结果不受影响）';
      statsContainer.appendChild(warn);
    }

    // 查询理解的结果要如实交代，不能悄悄改掉用户的词。
    // 两种情况值得说：① 口语被清洗成了核心词；② 结果太少时自动补查了变体。
    if (data && data.expanded && count > 0) {
      const ex = data.expanded;
      const bits = [];
      if (ex.rewritten && ex.to) bits.push('按「' + ex.to + '」检索');
      const tried = (ex.variants || []).filter(function (v) { return v.count > 0; });
      if (tried.length) bits.push('已放宽：' + tried.map(function (v) { return v.q; }).join('、'));
      if (bits.length) {
        const hint = document.createElement('span');
        hint.className = 'src-tag hint';
        hint.textContent = bits.join(' · ');
        hint.title =
          '你输入的词里有口语修饰（求 / 有没有 / 的资源 …），先清洗成核心词再检索；' +
          '结果偏少时会自动用更宽松的变体补查，补到的条目排在后面。';
        statsContainer.appendChild(hint);
      }
    }

    // 查询变体建议：真实源全空时，在统计行尾部挂「试试：」chips
    // —— 去年份 / 缩短查询往往立刻有结果。
    if (
      data &&
      (data.source === 'fallback' || data.source === 'no-result') &&
      Array.isArray(data.suggest) &&
      data.suggest.length
    ) {
      const wrap = document.createElement('span');
      wrap.className = 'suggest-variants';
      const lead = document.createElement('span');
      lead.className = 'suggest-variants-lead';
      lead.textContent = '试试：';
      wrap.appendChild(lead);
      data.suggest.forEach(function (w) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'sug-chip';
        chip.textContent = w;
        chip.addEventListener('click', function () {
          input.value = w;
          state.q = w;
          syncSubmitState();
          syncUrl();
          load();
        });
        wrap.appendChild(chip);
      });
      statsContainer.appendChild(wrap);
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  const FALLBACK_SUGGEST = ['考研', '周杰伦', 'Office 2021', '奥本海默', '无损音乐', '豆瓣 Top250'];

  /**
   * @param {string} title
   * @param {string} desc
   * @param {string[]} [suggestWords]
   * @param {{retry?: Function}} [opts]  需要时给一个「重试」主按钮
   */
  function renderEmpty(title, desc, suggestWords, opts) {
    resultList.textContent = '';
    const box = document.createElement('div');
    box.className = 'empty-state-container';
    box.innerHTML =
      '<div class="empty-state-icon">' +
      '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>' +
      '</div>';
    const t = document.createElement('div');
    t.className = 'empty-state-title';
    t.textContent = title;
    const d = document.createElement('div');
    d.className = 'empty-state-desc';
    d.textContent = desc;
    box.appendChild(t);
    box.appendChild(d);

    // 重试按钮：只在「重试确实有意义」时出现（例如上游超时）。
    // 不能给所有空状态都加 —— 关键词本身搜不到时，重试一百次也一样。
    const retry = opts && typeof opts.retry === 'function' ? opts.retry : null;
    if (retry) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'empty-state-retry';
      btn.textContent = '重试一次';
      btn.addEventListener('click', function () {
        btn.disabled = true;
        btn.textContent = '正在重试…';
        retry();
      });
      box.appendChild(btn);
    }

    if (Array.isArray(suggestWords) && suggestWords.length) {
      const wrap = document.createElement('div');
      wrap.className = 'empty-state-suggest';
      suggestWords.forEach(function (w) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'sug-chip';
        chip.textContent = w;
        chip.addEventListener('click', function () {
          input.value = w;
          state.q = w;
          syncSubmitState();
          syncUrl();
          load();
        });
        wrap.appendChild(chip);
      });
      box.appendChild(wrap);
    }

    resultList.appendChild(box);
  }

  /**
   * 「第一阶段空手，第二阶段还在路上」的中间态。
   * 比一直转骨架屏诚实：骨架屏看不出是在跑还是已经卡死。
   */
  function renderSearching() {
    resultList.textContent = '';
    currentItems = [];
    const box = document.createElement('div');
    box.className = 'searching-hint';
    const dots = document.createElement('span');
    dots.className = 'searching-dots';
    dots.innerHTML = '<i></i><i></i><i></i>';
    box.appendChild(dots);
    box.appendChild(document.createTextNode('正在从主力源检索夸克资源，慢源返回后会自动补齐'));
    resultList.appendChild(box);
  }

  /**
   * @param {Array} results
   * @param {Array} [extraSuggest] 服务端根据本次查询生成的变体建议
   *   （去年份、缩短查询之类，通常比固定热门词更贴题）
   */
  /**
   * 最近一次真正渲染到列表里的条目。
   * 供工作台（收藏 / CSV 导出 / 批量探活）读取 —— 它们只能操作"用户看得见的
   * 这些"，而不是服务端返回的原始数组（里面可能有被折叠的同资源条目）。
   */
  let currentItems = [];
  let currentMeta = { partial: false, source: '' };

  // 上一次渲染的条目 + 它属于哪一轮请求。
  // 用途：两阶段搜索里，第二阶段偶尔会比第一阶段**更少**（上游本身不稳，
  // 同一个词两次调用返回条数不同）。直接整体覆盖会让用户眼睁睁看着结果消失，
  // 所以第二阶段只做"并集"：新的在前，第一阶段独有的补在后面。绝不缩水。
  let lastItems = [];
  let lastSeq = 0;

  function renderResults(results, extraSuggest, meta) {
    resultList.textContent = '';
    currentItems = [];
    currentMeta = meta || { partial: false, source: '' };

    if (!results.length) {
      const merged = []
        .concat(Array.isArray(extraSuggest) ? extraSuggest : [])
        .concat(FALLBACK_SUGGEST)
        .filter(function (w, i, a) { return a.indexOf(w) === i; })
        .slice(0, 6);

      // 空状态要分清两件事：
      //   「上游超时」——资源可能就在那儿，只是这次没等到。给「重试」，别让用户
      //                 以为整个站没货。
      //   「确实没有」——重试没意义，该引导换词。
      // 判据用服务端给的 reason，兼容只有 providers 明细的老响应。
      const m = meta || {};
      const provs = Array.isArray(m.providers) ? m.providers : [];
      const timedOut = m.reason === 'upstream-timeout' ||
        (provs.length > 0 && provs.every(function (p) { return !p.ok; }) &&
          provs.some(function (p) { return p.error === 'timeout'; }));

      if (timedOut) {
        renderEmpty(
          '上游这次太慢，还没等到结果',
          '这次查询没能在超时前拿到数据，并不代表没有这个资源。稍等几秒再试，往往就有了。',
          merged,
          { retry: function () { load(); } }
        );
      } else {
        renderEmpty('没有找到相关资源', '换个说法再试试，或者看看下面这些关键词', merged);
      }
      dispatchRendered();
      return;
    }

    const frag = document.createDocumentFragment();

    results.forEach(function (item, idx) {
      if (!item.title) return;
      currentItems.push(item);
      const row = document.createElement('div');
      row.className = 'result-item';
      // 仅对首屏前 12 条做错峰渐入，长列表保持流畅
      if (idx < 12) {
        row.style.animationDelay = (idx * 26) + 'ms';
      } else {
        row.style.animation = 'none';
      }
      row.dataset.href = item.first_url || '#';

      const title = document.createElement('a');
      title.className = 'result-title';
      title.href = item.first_url || '#';
      title.target = '_blank';
      title.rel = 'noopener noreferrer nofollow';
      title.textContent = item.title;
      row.appendChild(title);

      const snippet = document.createElement('div');
      snippet.className = 'result-snippet';

      if (item.date) {
        const s = document.createElement('span');
        s.innerHTML =
          '<svg width="12.5" height="12.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:.7;flex-shrink:0"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>';
        s.appendChild(document.createTextNode(item.date));
        snippet.appendChild(s);
      }

      if (item.cloud_type_name || item.cloud_type) {
        const s = document.createElement('span');
        // 必须有类名：早先这里没写 class，样式只能靠 `.result-snippet > span`
        // 这种位置选择器兜着，既查不到也改不动（同级的 provider / badge / dupes
        // 全都有类名，只有它没有）。
        s.className = 'result-cloud';
        const meta = CLOUD_ICON[item.cloud_type];
        const name = item.cloud_type_name || (meta ? meta.name : '网盘');
        if (meta) {
          const img = document.createElement('img');
          img.src = meta.src;
          img.width = 12;
          img.height = 12;
          img.alt = '';
          img.onerror = function () { this.style.display = 'none'; };
          s.appendChild(img);
        } else {
          s.innerHTML =
            '<svg width="12.5" height="12.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:.7;flex-shrink:0"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"></path></svg>';
        }
        s.appendChild(document.createTextNode(name));
        snippet.appendChild(s);
      }

      // 来源归属：多源聚合时标注这条来自哪个源（胶囊徽章）
      const provs = item._providers && item._providers.length
        ? item._providers
        : (item.provider ? [item.provider] : []);
      if (provs.length && !item._fallback) {
        const s = document.createElement('span');
        s.className = 'result-provider';
        s.textContent = provs.map(function (p) { return PROVIDER_NAME[p] || p; }).join(' + ');
        s.title = '该结果来自：' + provs.map(function (p) { return PROVIDER_NAME[p] || p; }).join('、');
        snippet.appendChild(s);
      }

      const badge = createBadge(item._fallback ? 'fallback' : item.status);
      if (badge) snippet.appendChild(badge);

      // 安全标记：只在有风险时出现，安全的不打扰（避免满屏"安全"噪音）
      const secBadge = createSecurityBadge(item);
      if (secBadge) snippet.appendChild(secBadge);

      // 同标题折叠提示：不隐藏信息，只压缩重复展示
      if (item._dupes > 0) {
        const d = document.createElement('span');
        d.className = 'result-dupes';
        d.textContent = '另有 ' + item._dupes + ' 条同资源';
        d.title = '还有 ' + item._dupes + ' 条不同分享链接指向同一资源';
        snippet.appendChild(d);
      }

      row.appendChild(snippet);

      if (item.note && item.note !== item.title) {
        const desc = document.createElement('div');
        desc.className = 'result-desc';
        desc.textContent = item.note;
        row.appendChild(desc);
      }

      if (Array.isArray(item.tags) && item.tags.length) {
        const tags = document.createElement('div');
        tags.className = 'result-tags';
        item.tags.forEach(function (tag) {
          const el = document.createElement('span');
          el.className = 'result-tag';
          el.textContent = '#' + tag;
          el.addEventListener('click', function () {
            input.value = tag;
            state.q = tag;
            syncSubmitState();
            syncUrl();
            load();
          });
          tags.appendChild(el);
        });
        row.appendChild(tags);
      }

      frag.appendChild(row);
    });

    resultList.appendChild(frag);
    kbdFocus = -1;

    lastItems = currentItems.slice();

    // 通知工作台：结果集换了，重新挂星标 / 重置探活状态。
    // 用事件而不是直接调用，是为了让 results.js 不依赖 workbench.js
    //（工作台没加载时页面依然完整可用）。
    dispatchRendered();
  }

  function dispatchRendered() {
    try {
      document.dispatchEvent(new CustomEvent('zsearch:rendered', {
        detail: { items: currentItems.slice(), partial: currentMeta.partial, source: currentMeta.source },
      }));
    } catch (err) {
      // CustomEvent 不支持时静默降级：工作台会退化成"打开面板时才同步"
    }
  }

  /* ---------------------------------------------------------------------
     搜索历史
     数据放在 localStorage 的 zs-hist-v1，与工作台共用同一个 key。
     这里之所以自己写而不是调用工作台：搜索历史是"搜索行为"的副产物，
     即使工作台脚本没加载（比如被 CSP 拦了），历史也应该照常记录。
     --------------------------------------------------------------------- */
  const HIST_KEY = 'zs-hist-v1';
  const HIST_MAX = 40;

  function readHistory() {
    try {
      const raw = localStorage.getItem(HIST_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (err) {
      return []; // 隐私模式 / 存储被禁 → 静默降级为「不记录」
    }
  }

  function recordHistory(q, n) {
    const word = String(q || '').trim();
    if (!word) return;
    try {
      const list = readHistory().filter(function (it) {
        return it && it.q && it.q !== word;
      });
      list.unshift({ q: word, at: Date.now(), n: Number(n) || 0 });
      localStorage.setItem(HIST_KEY, JSON.stringify(list.slice(0, HIST_MAX)));
    } catch (err) {
      /* 写不进去就算了，不能因为历史记录让搜索流程报错 */
    }
  }

  /* ---------------------------------------------------------------------
     对外接口
     工作台（收藏 / CSV / 批量探活）需要知道"现在列表里是什么"。
     只暴露读取与重载，不暴露内部渲染函数，避免两边改同一份 DOM。
     --------------------------------------------------------------------- */
  window.ZSearchResults = {
    getState: function () {
      return { q: state.q, sort: state.sort, cloud: state.cloud };
    },
    items: function () {
      return currentItems.slice();
    },
    reload: load,
  };

  /* ---------------------------------------------------------------------
     加载数据
     --------------------------------------------------------------------- */
  function showSkeleton() {
    resultList.innerHTML =
      // 等待计时条：从第 0 秒就告诉用户"系统在工作"。
      // 为什么需要它：阶段 1 的服务端硬上限是 6.5 秒，上游慢的时候用户要盯着
      // 一块**完全静止**的骨架屏等 6.5 秒，主观上就是"点了没反应/卡死了"。
      // 有了秒数在跳，等待变成"可感知的进行中"，这是纯粹的观感修复，不发任何额外请求。
      '<div class="wait-hint" role="status">正在连接数据源…</div>' +
      '<div class="result-loading" aria-hidden="true"><div class="loading-line title" style="width:70%"></div><div class="loading-line snippet"></div><div class="loading-line tags"></div></div>' +
      '<div class="result-loading" aria-hidden="true"><div class="loading-line title" style="width:55%"></div><div class="loading-line snippet" style="width:85%"></div><div class="loading-line tags" style="width:25%"></div></div>' +
      '<div class="result-loading" aria-hidden="true"><div class="loading-line title" style="width:80%"></div><div class="loading-line snippet" style="width:95%"></div><div class="loading-line tags" style="width:40%"></div></div>' +
      '<div class="result-loading" aria-hidden="true"><div class="loading-line title" style="width:60%"></div><div class="loading-line snippet"></div><div class="loading-line tags"></div></div>';
    startWaitClock();
  }

  /* 等待计时器：跟着骨架屏一起生，跟着骨架屏一起死。
     不需要在任何地方显式 stop —— 用 el.isConnected 判断元素是否还在文档里，
     被 renderResults / renderEmpty 换掉之后下一拍就自己 clearInterval。
     这样即使某条代码路径忘了收尾，也不会留下一个永久跑着的定时器。 */
  let waitTimer = 0;

  function startWaitClock() {
    if (waitTimer) {
      window.clearInterval(waitTimer);
      waitTimer = 0;
    }
    const el = resultList.querySelector('.wait-hint');
    if (!el) return;
    const t0 = Date.now();
    const tick = function () {
      if (!el.isConnected) {
        window.clearInterval(waitTimer);
        waitTimer = 0;
        return;
      }
      const sec = Math.round((Date.now() - t0) / 1000);
      // 前 6 秒只是报数；超过 6 秒说明撞上慢源了，换一句能解释当前状况的话，
      // 否则用户会以为是本站坏了而不是上游慢。
      el.textContent =
        sec < 6
          ? '正在从多个数据源检索… ' + sec + ' 秒'
          : '数据源响应偏慢，已用 ' + sec + ' 秒 · 慢源返回后会自动补齐';
    };
    tick();
    waitTimer = window.setInterval(tick, 500);
  }

  let reqSeq = 0;

  /**
   * @param {string} q
   * @param {boolean} fast true = 只问快速源（两阶段的第一阶段）
   */
  function fetchSearch(q, fast) {
    const url =
      '/api/search?q=' + encodeURIComponent(q) +
      '&sort=' + encodeURIComponent(state.sort) +
      '&cloud=' + encodeURIComponent(state.cloud) +
      (fast ? '&fast=1' : '');

    return fetch(url, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok || !j || !j.ok) throw new Error('bad-response');
        return j.data || {};
      });
    });
  }

  function load() {
    const q = state.q.trim();
    if (!q) {
      statsContainer.style.display = 'none';
      currentItems = [];
      renderEmpty('输入关键词开始搜索', '聚合夸克 · 百度 · UC · 迅雷 四大网盘资源', FALLBACK_SUGGEST);
      dispatchRendered();
      return;
    }

    const mySeq = ++reqSeq;
    showSkeleton();
    // 骨架屏期间先把「探活/导出」工具条收起来：此时列表里没有可操作对象
    currentItems = [];
    dispatchRendered();

    // ---- 阶段 1：能多快给用户看到就多快 ----
    // 现在 pansou 也在这一档（它快的词 1~5 秒就回），hunhepan 3~8 秒波动，
    // 服务端统一压 6.5 秒上限。没赶上的源不会丢：服务端那边请求还在跑，
    // 第二阶段直接复用同一个在途请求，不会重复打上游。
    fetchSearch(q, true)
      .then(function (data) {
        if (mySeq !== reqSeq) return; // 用户已经换了关键词
        const results = Array.isArray(data.results) ? data.results : [];
        // 第一阶段空手而归：不要一直挂着骨架屏（用户会以为卡死了），
        // 明确告诉他"主力源还在跑"。第二阶段到了自然覆盖掉这句提示。
        if (!results.length) {
          renderSearching();
          return;
        }
        lastSeq = mySeq;
        renderStats(q, results.length, data, { partial: true });
        renderResults(results, data.suggest, {
          partial: true,
          source: data.source,
          reason: data.reason,
          providers: data.providers,
        });
      })
      .catch(function () {
        /* 阶段 1 失败不打扰用户，阶段 2 会兜住 */
      });

    // ---- 阶段 2：全量，到达后覆盖（但不缩水，见 mergeNoShrink） ----
    fetchSearch(q, false)
      .then(function (data) {
        if (mySeq !== reqSeq) return;
        const results = mergeNoShrink(Array.isArray(data.results) ? data.results : [], mySeq);
        renderStats(q, results.length, data);
        renderResults(results, data.suggest, {
          partial: false,
          source: data.source,
          reason: data.reason,
          providers: data.providers,
        });
        recordHistory(q, results.length);
      })
      .catch(function () {
        if (mySeq !== reqSeq) return;
        // 阶段 1 已经渲染出内容时，不要用错误页把它盖掉
        if (resultList.querySelector('.result-item')) return;
        statsContainer.style.display = 'none';
        renderEmpty('网络请求失败', '请检查本地服务是否正常运行');
      });
  }

  /**
   * 第二阶段的结果如果比第一阶段还少，把第一阶段独有的条目补在后面。
   *
   * 这不是"凑数"：第一次已经展示过的内容，第二次不该凭空消失。上游抖动的
   * 时候（同一个词两次调用返回 14 条 / 6 条）用户会以为自己眼花了。
   * 只在同一轮请求（seq 相同）内合并，换关键词 / 换筛选时不串味。
   */
  function mergeNoShrink(results, mySeq) {
    if (mySeq !== lastSeq || !lastItems.length) return results;
    if (results.length >= lastItems.length) return results;

    const seen = Object.create(null);
    for (const it of results) seen[it.first_url || it.title] = true;

    const extra = lastItems.filter(function (it) {
      return !seen[it.first_url || it.title];
    });
    return extra.length ? results.concat(extra) : results;
  }

  load();

  /* ---------------------------------------------------------------------
     表单提交
     --------------------------------------------------------------------- */
  const form = document.getElementById('resultsSearchForm');
  form.addEventListener('submit', function (e) {
    const v = input.value.trim();
    if (!v) {
      e.preventDefault();
      input.focus();
      return;
    }
    e.preventDefault();
    state.q = v;
    syncUrl();
    load();
  });

  /* ---------------------------------------------------------------------
     语音输入
     --------------------------------------------------------------------- */
  const voiceBtn = document.getElementById('resultsVoiceBtn');
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SR && voiceBtn) {
    const recognition = new SR();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'zh-CN';
    let listening = false;
    const origPlaceholder = input.placeholder;

    voiceBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (listening) recognition.stop();
      else {
        try { recognition.start(); } catch (err) { /* ignore */ }
      }
    });

    recognition.onstart = function () {
      listening = true;
      voiceBtn.classList.add('listening-active');
      input.placeholder = '正在倾听…';
    };
    recognition.onresult = function (event) {
      let transcript = '';
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        transcript += event.results[i][0].transcript;
      }
      if (transcript) {
        input.value = transcript;
        syncSubmitState();
      }
    };
    recognition.onerror = stop;
    recognition.onend = stop;
    function stop() {
      listening = false;
      voiceBtn.classList.remove('listening-active');
      input.placeholder = origPlaceholder;
    }
  } else if (voiceBtn) {
    voiceBtn.style.opacity = '0.35';
    voiceBtn.title = '当前浏览器不支持语音输入';
  }

  /* ---------------------------------------------------------------------
     滚动进度 + 返回顶部
     --------------------------------------------------------------------- */
  (function initScrollUI() {
    const btn = document.getElementById('backToTopBtn');
    const bar = document.getElementById('scrollProgress');

    function onScroll() {
      const doc = document.documentElement;
      const y = window.pageYOffset || doc.scrollTop || 0;
      const max = Math.max(1, (doc.scrollHeight || 1) - window.innerHeight);
      if (bar) bar.style.width = Math.min(100, (y / max) * 100) + '%';
      if (btn) btn.classList.toggle('visible', y > 180);
    }

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });

    if (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        headBackToTop();
      });
    }
    onScroll();
  })();

  /* ---------------------------------------------------------------------
     键盘导航：j / k 上下移动，Enter 打开，Esc 清除焦点
     （输入框内不触发）
     --------------------------------------------------------------------- */
  let kbdFocus = -1;

  function items() {
    return Array.prototype.slice.call(resultList.querySelectorAll('.result-item[data-href]'));
  }

  function setFocus(next) {
    const list = items();
    if (!list.length) return;
    if (kbdFocus >= 0 && list[kbdFocus]) list[kbdFocus].classList.remove('keyboard-focus');
    kbdFocus = Math.max(0, Math.min(list.length - 1, next));
    const el = list[kbdFocus];
    el.classList.add('keyboard-focus');
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  document.addEventListener('keydown', function (e) {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      const list = items();
      if (!list.length) return;
      setFocus(kbdFocus < 0 ? 0 : kbdFocus + 1);
      return;
    }
    if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (kbdFocus < 0) return;
      setFocus(kbdFocus - 1);
      return;
    }
    if (e.key === 'Enter' && kbdFocus >= 0) {
      const el = items()[kbdFocus];
      const link = el && el.querySelector('.result-title');
      if (link) {
        e.preventDefault();
        window.open(link.href, '_blank', 'noopener');
      }
      return;
    }
    if (e.key === 'Escape' && kbdFocus >= 0) {
      const list = items();
      if (list[kbdFocus]) list[kbdFocus].classList.remove('keyboard-focus');
      kbdFocus = -1;
    }
  });

  // 首次出现结果后，短暂提示键盘用法（桌面端）
  (function initKbdTip() {
    if (window.matchMedia('(max-width: 800px)').matches) return;
    const tip = document.createElement('div');
    tip.className = 'kbd-tip';
    tip.innerHTML =
      '<span><span class="kbd">J</span><span class="kbd">K</span> 浏览</span>' +
      '<span><span class="kbd">Enter</span> 打开</span>';
    document.body.appendChild(tip);
    const t1 = setTimeout(function () { tip.classList.add('show'); }, 900);
    const t2 = setTimeout(function () { tip.classList.remove('show'); }, 6200);
    document.addEventListener('keydown', function () { tip.classList.remove('show'); });
    window.addEventListener('beforeunload', function () {
      clearTimeout(t1); clearTimeout(t2);
    });
  })();

  /* ---------------------------------------------------------------------
     导航横向滚动遮罩
     --------------------------------------------------------------------- */
  (function initNavScrollMask() {
    const wrap = document.querySelector('.header-nav-wrap');
    const nav = document.querySelector('.header-nav');
    if (!wrap || !nav) return;

    function updateMask() {
      const scrollLeft = nav.scrollLeft;
      const maxScroll = nav.scrollWidth - nav.clientWidth;
      wrap.classList.remove('has-overflow-left', 'has-overflow-right', 'has-overflow-both');
      if (maxScroll <= 3) return;
      const atStart = scrollLeft <= 4;
      const atEnd = scrollLeft >= maxScroll - 4;
      if (atStart && !atEnd) wrap.classList.add('has-overflow-right');
      else if (!atStart && atEnd) wrap.classList.add('has-overflow-left');
      else if (!atStart && !atEnd) wrap.classList.add('has-overflow-both');
    }

    nav.addEventListener('scroll', updateMask, { passive: true });
    window.addEventListener('resize', updateMask, { passive: true });

    wrap.addEventListener('wheel', function (e) {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && nav.scrollWidth > nav.clientWidth) {
        e.preventDefault();
        nav.scrollLeft += e.deltaY * 0.8;
      }
    }, { passive: false });

    const activeTab = nav.querySelector('.cloud-tab.active');
    if (activeTab && activeTab.offsetLeft > nav.clientWidth * 0.6) {
      setTimeout(function () {
        activeTab.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
      }, 100);
    }

    updateMask();
  })();

  /* ---------------------------------------------------------------------
     内联事件替代（CSP 收紧配套）
     原来 HTML 里用 onclick/onerror 内联属性实现的两个行为，改为 JS 绑定，
     这样 script-src 可以严格只允许 'self'，不必放开 'unsafe-inline'。
     --------------------------------------------------------------------- */
  (function bindInlineReplacers() {
    // 1) 点击搜索框外围聚焦
    const composer = document.getElementById('resultsComposer');
    if (composer && input) {
      composer.addEventListener('click', function () {
        const el = document.activeElement;
        if (el && el !== document.body && composer.contains(el) && el !== input) return;
        input.focus();
      });
    }

    // 2) 网盘图标加载失败时隐藏（原来是 onerror="this.style.display='none'"）
    document.querySelectorAll('img[data-hide-on-error]').forEach(function (img) {
      img.addEventListener('error', function () { this.style.display = 'none'; });
      // 已经失败过的（缓存的 error 不会再触发）
      if (img.complete && img.naturalWidth === 0) img.style.display = 'none';
    });
  })();
})();
