/* ZSEARCH · 首页交互
   模块：
     1. 数据源状态探测
     2. 输入框自动增高 / 提交态
     3. 幽灵提示轮播
     4. 搜索联想（高亮匹配 + 键盘导航）
     5. 语音输入
     6. 搜索历史（localStorage）
     7. 快捷面板（Ctrl/⌘ + K）
     8. 今日探索标签
*/
(function () {
  'use strict';

  document.getElementById('current-year').textContent = new Date().getFullYear();

  const textarea = document.getElementById('searchInput');
  const submitBtn = document.getElementById('searchSubmitBtn');
  const voiceBtn = document.getElementById('voiceBtn');
  const brainBtn = document.getElementById('brainBtn');
  const form = document.getElementById('searchForm');
  const ghostOverlay = document.getElementById('ghostOverlay');
  const suggestDropdown = document.getElementById('suggestDropdown');
  const editorContent = document.getElementById('editorContent');

  /* ---------------------------------------------------------------------
     1. 数据源状态探测
     --------------------------------------------------------------------- */
  fetch('/api/status')
    .then((r) => r.json())
    .then((res) => {
      const pill = document.getElementById('statusPill');
      const text = document.getElementById('statusText');
      if (!res || !res.ok) {
        pill.className = 'status-pill is-offline';
        text.textContent = '状态未知';
        return;
      }
      const d = res.data || {};
      const live = (d.sources || []).filter((s) => s.enabled).length;
      if (d.offlineMode) {
        pill.className = 'status-pill is-offline';
        text.textContent = '离线模式';
      } else if (!live) {
        pill.className = 'status-pill is-fallback';
        text.textContent = '演示数据';
      } else {
        pill.className = 'status-pill';
        text.textContent = live + ' 源在线';
        pill.title = '数据来源：' + (d.sources || []).filter((s) => s.enabled).map((s) => s.label).join(' · ');
      }
    })
    .catch(() => {
      const pill = document.getElementById('statusPill');
      document.getElementById('statusText').textContent = '状态未知';
      pill.className = 'status-pill is-offline';
    });

  /* ---------------------------------------------------------------------
     2. 自动增高 + 提交按钮激活
     --------------------------------------------------------------------- */
  // 与 home.css 的 .chat-input-editor{max-height:300px} 保持同步，两处必须一起改
  const MAX_H = 300;

  function autoGrow() {
    textarea.style.height = 'auto';
    const h = Math.min(textarea.scrollHeight, MAX_H);
    textarea.style.height = h + 'px';
    if (ghostOverlay) ghostOverlay.style.height = h + 'px';
    textarea.style.overflowY = textarea.scrollHeight > MAX_H ? 'auto' : 'hidden';
  }

  function syncSubmitState() {
    submitBtn.classList.toggle('active', !!textarea.value.trim());
  }

  textarea.addEventListener('input', function () {
    autoGrow();
    syncSubmitState();
    syncSmartUI(this.value);
    // 必须先清提示层再画别的：有内容时提示层要立刻消失，否则会和真实输入叠字
    renderGhost();
    if (brainEnabled) scheduleSuggest(this.value);
    else hideSuggest();
    positionGhost();
  });

  textarea.addEventListener('scroll', positionGhost);

  function positionGhost() {
    if (!ghostOverlay) return;
    ghostOverlay.scrollTop = textarea.scrollTop;
  }

  /* ---------------------------------------------------------------------
     2.5 智能交互层
         a. 光标跟随柔光：pointermove 只记坐标，写变量交给 rAF 合并
         b. 意图识别：本地规则打分，纯前端，不发请求
         c. 清空按钮 + Esc 清空
     三者都不改变任何搜索行为 —— 只有输入内容本身才决定搜什么。
     --------------------------------------------------------------------- */

  /* ---- a. 柔光 ---- */
  (function initAura() {
    const aura = editorContent && editorContent.querySelector('.editor-aura');
    if (!aura) return;

    let rect = null;      // 缓存盒子位置：别在 pointermove 里反复 measure
    let raf = 0;
    let px = 0;
    let py = 0;

    function flush() {
      raf = 0;
      editorContent.style.setProperty('--fx', px + 'px');
      editorContent.style.setProperty('--fy', py + 'px');
    }

    function invalidate() {
      rect = null;
    }

    editorContent.addEventListener('pointerenter', function () {
      rect = editorContent.getBoundingClientRect();
    }, { passive: true });

    editorContent.addEventListener('pointermove', function (e) {
      // 触屏没有 hover 概念，柔光不跟随，省掉一条无意义的高频路径
      if (e.pointerType === 'touch') return;
      if (!rect) rect = editorContent.getBoundingClientRect();
      px = Math.round(e.clientX - rect.left);
      py = Math.round(e.clientY - rect.top);
      if (!raf) raf = requestAnimationFrame(flush);
    }, { passive: true });

    window.addEventListener('scroll', invalidate, { passive: true });
    window.addEventListener('resize', invalidate);
  })();

  /* ---- b. 意图识别 ----
     只给"往哪个方向补词"的提示，不做任何过滤或改写。
     打分用「命中关键词长度之和」而不是命中个数 —— 长词更具体，
     "Office 2021 安装包" 里「安装包」比「Office」更能说明意图。 */
  const INTENT_RULES = [
    {
      key: 'video', label: '影视资源',
      hint: '带上年份、分辨率（4K / 1080p）或「中字」更容易命中',
      words: ['电影', '电视剧', '美剧', '日剧', '韩剧', '动漫', '番剧', '纪录片', '综艺',
        '4K', '1080p', '蓝光', '中字', '字幕', '高清', '全集', '剧场版'],
    },
    {
      key: 'study', label: '课程 / 考研',
      hint: '带上年份、老师名或机构名（如「2026 张宇」）更准',
      words: ['考研', '考公', '四六级', '六级', '雅思', '托福', '网课', '课程', '教程',
        '讲义', '题库', '真题', '强化班', '冲刺班', '基础班', '期末', '高考', '中考'],
    },
    {
      key: 'music', label: '音乐资源',
      hint: '加「无损」「flac」可筛出高音质版本',
      words: ['音乐', '无损', 'flac', 'wav', '专辑', '单曲', '演唱会', '歌单', '原声', 'ost'],
    },
    {
      key: 'book', label: '电子书',
      hint: '加格式（epub / mobi / pdf）能少走弯路',
      words: ['电子书', '小说', 'epub', 'mobi', 'azw3', 'kindle', 'pdf', '文集', '著作'],
    },
    {
      key: 'soft', label: '软件工具',
      hint: '带上版本号（2021 / v2.3）和「安装包」更精确',
      words: ['安装包', '破解', '绿色版', '插件', 'office', 'adobe', 'photoshop', 'ps',
        'pr', 'ae', 'matlab', 'windows', '系统镜像', 'iso', '驱动', '客户端'],
    },
    {
      key: 'game', label: '游戏资源',
      hint: '加「免安装」「整合包」可避开一堆分卷压缩',
      words: ['游戏', '单机', 'steam', '免安装', '整合包', 'mod', '模拟器', 'switch', 'ps5', '汉化'],
    },
    {
      key: 'asset', label: '设计素材',
      hint: '加「模板」「字体」「样机」能一次找齐',
      words: ['字体', '笔刷', '样机', '模板', '素材', '图标', '矢量', 'ppt', '设计'],
    },
  ];

  const intentChip = document.getElementById('editorIntent');
  const intentText = intentChip ? intentChip.querySelector('.editor-intent__text') : null;
  const clearBtn = document.getElementById('clearBtn');

  function detectIntent(raw) {
    const s = String(raw || '').toLowerCase();
    if (!s.trim()) return null;
    let best = null;
    let bestScore = 0;
    for (const rule of INTENT_RULES) {
      let score = 0;
      for (const w of rule.words) {
        if (s.indexOf(w.toLowerCase()) !== -1) score += w.length;
      }
      if (score > bestScore) {
        bestScore = score;
        best = rule;
      }
    }
    // 太弱的命中宁可不显示：一个词的 1~2 个字碰巧被扫到，不代表意图
    return bestScore >= 2 ? best : null;
  }

  let lastIntentKey = '';

  function syncSmartUI(value) {
    const has = !!String(value || '').trim();

    if (clearBtn) clearBtn.hidden = !has;

    if (!intentChip || !intentText) return;

    const hit = detectIntent(value);
    const key = hit ? hit.key : '';

    if (!hit) {
      intentChip.hidden = true;
      lastIntentKey = '';
      return;
    }

    // 同一类别不重复改 DOM，避免每敲一个字就重播一次入场动画
    if (key !== lastIntentKey) {
      intentText.textContent = hit.label;
      intentChip.title = hit.hint;
      // 重新触发入场动画：先摘 hidden 再强制一次 reflow
      intentChip.hidden = false;
      void intentChip.offsetWidth;
      lastIntentKey = key;
    }
  }

  function clearInput(keepFocus) {
    textarea.value = '';
    autoGrow();
    syncSubmitState();
    syncSmartUI('');
    hideSuggest();
    if (brainEnabled) scheduleSuggest('');
    if (keepFocus !== false) textarea.focus();
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      clearInput();
    });
  }

  /* ---------------------------------------------------------------------
     3. 幽灵提示：聚焦且为空时轮播示例，逐字打字，Tab / 点击补全
     --------------------------------------------------------------------- */
  const GHOST_EXAMPLES = [
    '考研数学张宇强化班',
    '周杰伦无损音乐合集',
    '奥本海默 4K 中字',
    'Office 2021 安装包',
    'Python 从入门到精通',
    '豆瓣高分电影 Top250',
  ];
  let ghostIndex = 0;
  let ghostText = '';
  let typing = false;

  /**
   * 输入框为空时的「示例提示」层。
   *
   * ⚠️ 这里修的是一个真实的叠字 bug（原来只在 focus/blur 时重绘）：
   *    input 事件没有调用本函数 —— 用户一敲字，提示文本不会被清掉，
   *    于是「已输入的文字」和「示例提示」两层同时可见，看着就是字叠字。
   *
   * 另外两点也一并去掉：
   *   1. 不再画假光标 .ghost-caret。textarea 自己有 caret-color 的真光标，
   *      两者位置只要有 1px 差就会看成"两个光标压在一起"。
   *   2. 不再每 55ms 重建 innerHTML。只更新已有文本节点的 textContent，
   *      打字机动画期间不会反复触发布局。
   */
  function renderGhost() {
    if (!ghostOverlay) return;
    const focused = document.activeElement === textarea;
    // 有内容 / 没聚焦 → 立刻清空（不是"保留 caret"，什么都不留）
    if (!focused || textarea.value) {
      if (ghostOverlay.dataset.mode !== 'idle') {
        ghostOverlay.textContent = '';
        ghostOverlay.dataset.mode = 'idle';
      }
      return;
    }
    let suffix = ghostOverlay.querySelector('.ghost-suffix');
    if (!suffix) {
      ghostOverlay.textContent = '';
      suffix = document.createElement('span');
      suffix.className = 'ghost-suffix';
      ghostOverlay.appendChild(suffix);
      ghostOverlay.dataset.mode = 'typing';
    }
    if (suffix.textContent !== ghostText) suffix.textContent = ghostText;
  }

  textarea.addEventListener('focus', renderGhost);
  textarea.addEventListener('blur', function () {
    setTimeout(renderGhost, 120);
  });

  function startGhostLoop() {
    setInterval(function () {
      const focused = document.activeElement === textarea;
      if (textarea.value || typing || !focused) return;
      ghostIndex = (ghostIndex + 1) % GHOST_EXAMPLES.length;
      const full = GHOST_EXAMPLES[ghostIndex];
      let i = 0;
      typing = true;
      ghostText = '';
      renderGhost();
      const timer = setInterval(function () {
        i++;
        ghostText = full.slice(0, i);
        renderGhost();
        if (i >= full.length) {
          clearInterval(timer);
          typing = false;
        }
      }, 55);
    }, 3400);
  }

  function completeGhost(word) {
    const w = word || ghostText;
    if (!w) return;
    textarea.value = w;
    autoGrow();
    syncSubmitState();
    syncSmartUI(w);
    hideSuggest();
    textarea.focus();
  }

  if (ghostOverlay) {
    ghostOverlay.addEventListener('click', function (e) {
      if (e.target.classList.contains('ghost-suffix') && ghostText) completeGhost();
    });
  }

  /* ---------------------------------------------------------------------
     6. 搜索历史
     --------------------------------------------------------------------- */
  const HISTORY_KEY = 'zsearch.history.v1';
  const HISTORY_MAX = 12;

  const History = {
    read() {
      try {
        const raw = localStorage.getItem(HISTORY_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string' && x.trim()) : [];
      } catch (err) {
        return [];
      }
    },
    push(word) {
      const w = String(word || '').trim();
      if (!w || w.length > 80) return;
      const list = History.read().filter((x) => x !== w);
      list.unshift(w);
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX)));
      } catch (err) {
        /* 隐私模式 / 配额满：静默降级 */
      }
    },
    clear() {
      try {
        localStorage.removeItem(HISTORY_KEY);
      } catch (err) {
        /* ignore */
      }
    },
  };

  /* ---------------------------------------------------------------------
     4. 搜索联想
     --------------------------------------------------------------------- */
  let brainEnabled = true; // 默认开启，减少一次点击
  brainBtn.classList.add('active');

  let suggestTimer = null;
  let suggestAbort = null;
  let suggestItems = [];
  let suggestSelected = -1;

  function hideSuggest() {
    if (suggestDropdown) {
      suggestDropdown.classList.add('hidden');
      suggestDropdown.innerHTML = '';
      suggestDropdown.style.top = '';
      suggestDropdown.style.left = '';
      suggestDropdown.style.width = '';
      suggestDropdown.style.maxHeight = '';
    }
    document.body.classList.remove('suggest-open');
    suggestItems = [];
    suggestSelected = -1;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  /** 把查询词在候选里命中的片段包成 <mark>，其余转义 */
  function highlight(word, q) {
    const w = String(word);
    const idx = w.toLowerCase().indexOf(String(q).toLowerCase());
    if (idx < 0 || !q) return escapeHtml(w);
    return (
      escapeHtml(w.slice(0, idx)) +
      '<mark>' + escapeHtml(w.slice(idx, idx + q.length)) + '</mark>' +
      escapeHtml(w.slice(idx + q.length))
    );
  }

  const ICON_SEARCH =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>';
  const ICON_CLOCK =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><polyline points="12 7 12 12 15.5 14"></polyline></svg>';
  const ICON_TREND =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 17 9 11 13 15 21 7"></polyline><polyline points="15 7 21 7 21 13"></polyline></svg>';

  function renderSuggest(groups) {
    if (!suggestDropdown) return;
    const flat = [];
    groups.forEach((g) => g.items.forEach((it) => flat.push(it)));
    if (!flat.length) return hideSuggest();

    suggestDropdown.innerHTML = '';
    let flatIdx = 0;

    groups.forEach(function (g) {
      if (!g.items.length) return;
      const label = document.createElement('div');
      label.className = 'suggest-group-label';
      label.textContent = g.label;
      suggestDropdown.appendChild(label);

      g.items.forEach(function (it) {
        const a = document.createElement('div');
        a.className = 'suggest-item';
        a.setAttribute('role', 'option');
        a.dataset.idx = String(flatIdx++);

        const icon = document.createElement('span');
        icon.className = 'suggest-item-icon';
        icon.innerHTML = g.icon || ICON_SEARCH;
        a.appendChild(icon);

        const t = document.createElement('span');
        t.className = 'suggest-title';
        t.innerHTML = g.highlight ? highlight(it, g.query) : escapeHtml(it);
        a.appendChild(t);

        if (g.tail) {
          const tail = document.createElement('span');
          tail.className = 'suggest-item-tail';
          tail.textContent = g.tail;
          a.appendChild(tail);
        }

        a.addEventListener('mousedown', function (e) {
          e.preventDefault();
          textarea.value = it;
          autoGrow();
          syncSubmitState();
          syncSmartUI(it);
          hideSuggest();
          form.submit();
        });

        suggestDropdown.appendChild(a);
      });
    });

    suggestItems = Array.from(suggestDropdown.querySelectorAll('.suggest-item'));
    suggestSelected = -1;
    suggestDropdown.classList.remove('hidden');
    document.body.classList.add('suggest-open');
    positionSuggest();
  }

  function positionSuggest() {
    if (!suggestDropdown || !editorContent) return;
    // fixed 定位：直接用搜索框的视口坐标，不受任何父级布局影响
    const r = editorContent.getBoundingClientRect();
    suggestDropdown.style.top = Math.round(r.bottom + 10) + 'px';
    suggestDropdown.style.left = Math.round(r.left) + 'px';
    suggestDropdown.style.width = Math.round(r.width) + 'px';
    suggestDropdown.style.right = 'auto';

    // 视口不够高时向上翻转，并收紧最大高度
    const spaceBelow = window.innerHeight - r.bottom - 20;
    const spaceAbove = r.top - 20;
    const desired = Math.min(320, suggestDropdown.scrollHeight || 320);
    if (spaceBelow < Math.min(desired, 200) && spaceAbove > spaceBelow) {
      const h = Math.min(desired, spaceAbove);
      suggestDropdown.style.top = Math.round(r.top - h - 10) + 'px';
      suggestDropdown.style.maxHeight = Math.round(h) + 'px';
    } else {
      suggestDropdown.style.maxHeight = Math.round(Math.max(120, Math.min(320, spaceBelow))) + 'px';
    }
  }

  function moveSelection(delta) {
    if (!suggestItems.length) return;
    suggestSelected = (suggestSelected + delta + suggestItems.length) % suggestItems.length;
    suggestItems.forEach((el, i) => el.classList.toggle('selected', i === suggestSelected));
    suggestItems[suggestSelected].scrollIntoView({ block: 'nearest' });
  }

  function scheduleSuggest(q) {
    if (suggestTimer) clearTimeout(suggestTimer);
    const v = String(q || '').trim();
    if (!v) return hideSuggest();

    suggestTimer = setTimeout(function () {
      if (suggestAbort) suggestAbort.abort();
      suggestAbort = new AbortController();

      const history = History.read()
        .filter((h) => h.toLowerCase().includes(v.toLowerCase()) && h !== v)
        .slice(0, 3);

      fetch('/api/suggest?q=' + encodeURIComponent(v), { signal: suggestAbort.signal })
        .then((r) => r.json())
        .then((res) => {
          if (suggestSelected >= 0) return; // 用户已在键盘操作，别打断
          const remote = res && res.ok && Array.isArray(res.data) ? res.data.slice(0, 8) : [];
          const remoteSet = new Set(remote);
          const groups = [];
          if (history.length) {
            groups.push({ label: '最近搜索', icon: ICON_CLOCK, items: history, highlight: true, query: v });
          }
          if (remote.length) {
            groups.push({
              label: history.length ? '相关推荐' : '推荐搜索',
              icon: ICON_TREND,
              items: remote.filter((x) => !remoteSet.has(x) || true),
              highlight: true,
              query: v,
            });
          }
          renderSuggest(groups);
        })
        .catch(function () {});
    }, 160);
  }

  if (brainBtn) {
    brainBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      brainEnabled = !brainEnabled;
      brainBtn.classList.toggle('active', brainEnabled);
      if (brainEnabled) scheduleSuggest(textarea.value);
      else hideSuggest();
    });
  }

  document.addEventListener('click', function (e) {
    const inDropdown = suggestDropdown && suggestDropdown.contains(e.target);
    const onBrain = brainBtn && (e.target === brainBtn || brainBtn.contains(e.target));
    if (!inDropdown && !onBrain) hideSuggest();
  });

  // fixed 定位不随滚动移动，滚动 / 缩放时重新对齐
  window.addEventListener('scroll', function () {
    if (suggestDropdown && !suggestDropdown.classList.contains('hidden')) positionSuggest();
  }, { passive: true });
  window.addEventListener('resize', function () {
    if (suggestDropdown && !suggestDropdown.classList.contains('hidden')) positionSuggest();
  }, { passive: true });

  /* ---------------------------------------------------------------------
     键盘：Tab 补全 / 联想导航 / Enter 提交
     --------------------------------------------------------------------- */
  textarea.addEventListener('keydown', function (e) {
    const open = suggestDropdown && !suggestDropdown.classList.contains('hidden');

    if (open && suggestItems.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); return moveSelection(1); }
      if (e.key === 'ArrowUp') { e.preventDefault(); return moveSelection(-1); }
      if (e.key === 'Escape') { e.preventDefault(); return hideSuggest(); }
      if (e.key === 'Enter' && suggestSelected >= 0) {
        e.preventDefault();
        suggestItems[suggestSelected].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        return;
      }
    }

    // Esc：优先关掉联想下拉（上面已处理），没有下拉时才清空输入
    if (e.key === 'Escape' && textarea.value) {
      e.preventDefault();
      return clearInput();
    }

    if (e.key === 'Tab' && ghostText && !textarea.value) {
      e.preventDefault();
      return completeGhost();
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (textarea.value.trim()) {
        History.push(textarea.value.trim());
        form.submit();
      }
    }
  });

  /* ---------------------------------------------------------------------
     5. 语音输入
     --------------------------------------------------------------------- */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SR && voiceBtn) {
    const recognition = new SR();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'zh-CN';

    let listening = false;
    const origPlaceholder = textarea.placeholder;

    voiceBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (listening) recognition.stop();
      else {
        try { recognition.start(); } catch (err) { /* 已在运行 */ }
      }
    });

    recognition.onstart = function () {
      listening = true;
      voiceBtn.classList.add('listening-active');
      textarea.placeholder = '正在倾听…';
    };

    recognition.onresult = function (event) {
      let transcript = '';
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        transcript += event.results[i][0].transcript;
      }
      if (transcript) {
        textarea.value = transcript;
        autoGrow();
        syncSubmitState();
        syncSmartUI(transcript);
      }
    };

    recognition.onerror = stopListening;
    recognition.onend = stopListening;

    function stopListening() {
      listening = false;
      voiceBtn.classList.remove('listening-active');
      textarea.placeholder = origPlaceholder;
    }
  } else if (voiceBtn) {
    voiceBtn.style.opacity = '0.35';
    voiceBtn.title = '当前浏览器不支持语音输入';
  }

  /* ---------------------------------------------------------------------
     7. 快捷面板
     --------------------------------------------------------------------- */
  const QUICK_ENTRIES = [
    { label: '考研专区', q: '考研' },
    { label: '每日精选', q: '每日精选' },
    { label: '热门音乐', q: '热门音乐' },
    { label: '实用工具', q: '实用工具' },
    { label: '海外热榜', q: '海外热榜' },
    { label: '福利社', q: '福利' },
  ];

  const cmdkOverlay = document.getElementById('cmdkOverlay');
  const cmdkBody = document.getElementById('cmdkBody');
  const cmdkClose = document.getElementById('cmdkClose');
  const cmdBtn = document.getElementById('cmdBtn');
  const cmdHintBtn = document.getElementById('cmdHintBtn');

  const cmdkState = { rows: [], selected: -1 };

  function goSearch(word) {
    const w = String(word || '').trim();
    if (!w) return;
    History.push(w);
    location.href = '/search?q=' + encodeURIComponent(w);
  }

  function renderCmdk() {
    if (!cmdkBody) return;
    const history = History.read();
    cmdkBody.innerHTML = '';
    cmdkState.rows = [];
    cmdkState.selected = -1;

    if (!history.length) {
      const empty = document.createElement('div');
      empty.className = 'cmdk-empty';
      empty.innerHTML = '还没有搜索记录。<br>随便搜一次，这里就会记住。';
      cmdkBody.appendChild(empty);
    } else {
      const label = document.createElement('div');
      label.className = 'suggest-group-label';
      label.textContent = '最近搜索';
      cmdkBody.appendChild(label);

      history.slice(0, 8).forEach(function (word) {
        const row = document.createElement('div');
        row.className = 'suggest-item';
        row.innerHTML =
          '<span class="suggest-item-icon">' + ICON_CLOCK + '</span>';
        const t = document.createElement('span');
        t.className = 'suggest-title';
        t.textContent = word;
        row.appendChild(t);
        row.addEventListener('click', function () { goSearch(word); });
        cmdkBody.appendChild(row);
        cmdkState.rows.push(row);
      });
    }

    const label2 = document.createElement('div');
    label2.className = 'suggest-group-label';
    label2.textContent = '快捷入口';
    cmdkBody.appendChild(label2);

    QUICK_ENTRIES.forEach(function (it) {
      const row = document.createElement('div');
      row.className = 'suggest-item';
      row.innerHTML = '<span class="suggest-item-icon">' + ICON_TREND + '</span>';
      const t = document.createElement('span');
      t.className = 'suggest-title';
      t.textContent = it.label;
      row.appendChild(t);
      const tail = document.createElement('span');
      tail.className = 'suggest-item-tail';
      tail.textContent = it.q;
      row.appendChild(tail);
      row.addEventListener('click', function () { goSearch(it.q); });
      cmdkBody.appendChild(row);
      cmdkState.rows.push(row);
    });

    if (history.length) {
      const label3 = document.createElement('div');
      label3.className = 'suggest-group-label';
      label3.textContent = '其他';
      cmdkBody.appendChild(label3);

      const row = document.createElement('div');
      row.className = 'suggest-item';
      row.innerHTML =
        '<span class="suggest-item-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg></span>';
      const t = document.createElement('span');
      t.className = 'suggest-title';
      t.textContent = '清空搜索记录';
      row.appendChild(t);
      row.addEventListener('click', function () {
        History.clear();
        renderCmdk();
      });
      cmdkBody.appendChild(row);
      cmdkState.rows.push(row);
    }
  }

  function openCmdk() {
    if (!cmdkOverlay) return;
    renderCmdk();
    cmdkOverlay.classList.remove('hidden');
    hideSuggest();
  }

  function closeCmdk() {
    if (cmdkOverlay) cmdkOverlay.classList.add('hidden');
  }

  function moveCmdk(delta) {
    if (!cmdkState.rows.length) return;
    cmdkState.selected =
      (cmdkState.selected + delta + cmdkState.rows.length) % cmdkState.rows.length;
    cmdkState.rows.forEach((el, i) => el.classList.toggle('selected', i === cmdkState.selected));
    cmdkState.rows[cmdkState.selected].scrollIntoView({ block: 'nearest' });
  }

  if (cmdBtn) cmdBtn.addEventListener('click', function (e) { e.stopPropagation(); openCmdk(); });
  if (cmdHintBtn) cmdHintBtn.addEventListener('click', function (e) { e.stopPropagation(); openCmdk(); });
  if (cmdkClose) cmdkClose.addEventListener('click', closeCmdk);
  if (cmdkOverlay) {
    cmdkOverlay.addEventListener('click', function (e) {
      if (e.target === cmdkOverlay) closeCmdk();
    });
  }

  document.addEventListener('keydown', function (e) {
    const open = cmdkOverlay && !cmdkOverlay.classList.contains('hidden');

    // Ctrl/⌘ + K 开合
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      return open ? closeCmdk() : openCmdk();
    }

    // Ctrl/⌘ + L 聚焦输入框
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      textarea.focus();
      textarea.select();
      return;
    }

    if (!open) return;
    if (e.key === 'Escape') { e.preventDefault(); return closeCmdk(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); return moveCmdk(1); }
    if (e.key === 'ArrowUp') { e.preventDefault(); return moveCmdk(-1); }
    if (e.key === 'Enter' && cmdkState.selected >= 0) {
      e.preventDefault();
      cmdkState.rows[cmdkState.selected].click();
    }
  });

  /* ---------------------------------------------------------------------
     8. 今日探索标签
     --------------------------------------------------------------------- */
  const EXPLORE_WORDS = [
    '考研英语真题', '周杰伦', '奥本海默', 'Office 2021',
    '豆瓣 Top250', 'Kindle 电子书', 'PS 教程', '无损音乐',
  ];

  (function initExplore() {
    const box = document.getElementById('exploreChips');
    if (!box) return;
    EXPLORE_WORDS.forEach(function (w, i) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'explore-chip';
      const idx = document.createElement('span');
      idx.className = 'chip-idx';
      idx.textContent = String(i + 1).padStart(2, '0');
      chip.appendChild(idx);
      const t = document.createElement('span');
      t.textContent = w;
      chip.appendChild(t);
      chip.addEventListener('click', function () { goSearch(w); });
      box.appendChild(chip);
    });
  })();

  /* ---------------------------------------------------------------------
     页面载入时若已带 ?q= 则回填
     --------------------------------------------------------------------- */
  const params = new URLSearchParams(location.search);
  if (params.get('q')) {
    textarea.value = params.get('q');
    autoGrow();
    syncSubmitState();
    syncSmartUI(textarea.value);
  }

  /* ---------------------------------------------------------------------
     表单校验：提交前落一次历史
     --------------------------------------------------------------------- */
  form.addEventListener('submit', function (e) {
    const v = textarea.value.trim();
    if (!v) {
      e.preventDefault();
      textarea.focus();
      return;
    }
    History.push(v);
  });

  submitBtn.addEventListener('click', function (e) {
    if (!textarea.value.trim()) {
      e.preventDefault();
      textarea.focus();
    }
  });

  /* ---------------------------------------------------------------------
     胶囊导航滚动
     --------------------------------------------------------------------- */
  window.scrollPluginTrack = function (dir) {
    const track = document.getElementById('homePluginsTrack');
    if (!track) return;
    const step = Math.max(160, track.clientWidth * 0.6);
    track.scrollBy({ left: dir === 'left' ? -step : step, behavior: 'smooth' });
  };

  /* 事件委托绑定（替代 HTML 里的 onclick 内联属性）。
     内联事件处理器属于 script-src 管辖，会导致 CSP 必须放开 'unsafe-inline'，
     等于把防挂马最关键的一道门打开。所以这里统一改成 JS 绑定。 */
  (function bindInlineReplacers() {
    // 点击输入框外围区域时聚焦到搜索框
    const editor = document.getElementById('editorContent');
    const input = document.getElementById('searchInput');
    if (editor && input) {
      editor.addEventListener('click', function () {
        // 点到按钮/链接时不要抢焦点
        var el = document.activeElement;
        if (el && el !== document.body && editor.contains(el) && el !== input) return;
        input.focus();
      });
    }

    // 左右滚动箭头
    const left = document.getElementById('pluginScrollLeftBtn');
    const right = document.getElementById('pluginScrollRightBtn');
    if (left) left.addEventListener('click', function () { window.scrollPluginTrack('left'); });
    if (right) right.addEventListener('click', function () { window.scrollPluginTrack('right'); });
  })();

  (function initArrowVisibility() {
    const track = document.getElementById('homePluginsTrack');
    const left = document.getElementById('pluginScrollLeftBtn');
    const right = document.getElementById('pluginScrollRightBtn');
    if (!track) return;

    function update() {
      const max = track.scrollWidth - track.clientWidth;
      if (!left || !right) return;
      left.classList.toggle('visible', max > 4 && track.scrollLeft > 4);
      right.classList.toggle('visible', max > 4 && track.scrollLeft < max - 4);
    }

    track.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update, { passive: true });
    update();
  })();

  /* ---------------------------------------------------------------------
     入场动画收尾
     .reveal 元素带 transform，会成为后代的"包含块"，
     让联想下拉框的 position:fixed 退化成相对该元素定位。
     动画跑完立刻打上 reveal-done 摘掉 transform，恢复干净布局。
     --------------------------------------------------------------------- */
  (function finishReveal() {
    const nodes = document.querySelectorAll('.reveal');
    const mark = (el) => el.classList.add('reveal-done');
    nodes.forEach(function (el) {
      el.addEventListener('animationend', function () { mark(el); }, { once: true });
    });
    // 兜底：动画被拦截 / 未触发时，1.6s 后强制收尾
    setTimeout(function () { nodes.forEach(mark); }, 1600);
  })();

  /* ---------------------------------------------------------------------
     初始化
     --------------------------------------------------------------------- */
  autoGrow();
  syncSubmitState();
  ghostText = GHOST_EXAMPLES[0];
  renderGhost();
  startGhostLoop();
})();
