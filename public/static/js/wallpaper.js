/**
 * ZSEARCH · 壁纸系统
 * ---------------------------------------------------------------------------
 * 职责：壁纸切换、tone 联动、底部胶囊、右上抽屉、持久化。
 *
 * 架构（单向，禁止成环）
 *   事件 → 改 state → saveState() → apply(changed) → 各 render 函数各读 state
 *   渲染函数之间互不调用。唯一入口是 apply()。
 *
 * 为什么要有 tone
 *   10 张壁纸明度从近白到近黑。同一套文字色必然在一半图上失效，
 *   所以每张图带 tone，切图时整套 CSS 变量跟着换，再按 tone 定遮罩浓度。
 */
(function () {
  'use strict';

  /* ======================================================================
     1. 数据
     ====================================================================== */

  var BASE = '/static/img/wall/';

  // sat / bri：单张的调色参数。缺省按 tone 取默认值。
  // 高饱和的图（花枝四色、红叶、卡通）必须单独压下来，否则整屏像打翻的调色盘。
  var WALLS = [
    { id: 'w01', name: '软梦月球', tone: 'light', file: '01.webp', group: '插画', sat: 0.82 },
    { id: 'w02', name: '夜湖倒影', tone: 'dark',  file: '02.webp', group: '影像' },
    { id: 'w03', name: '橘子洲头', tone: 'dark',  file: '03.webp', group: '影像', sat: 0.78 },
    { id: 'w04', name: '林间车站', tone: 'dark',  file: '04.webp', group: '影像' },
    { id: 'w05', name: '星月夜',   tone: 'dark',  file: '05.webp', group: '影像', sat: 0.84 },
    { id: 'w06', name: '雪峰银河', tone: 'dark',  file: '06.webp', group: '影像' },
    { id: 'w07', name: '檐外花枝', tone: 'light', file: '07.webp', group: '影像', sat: 0.5, bri: 1.0 },
    { id: 'w08', name: '秋径红叶', tone: 'light', file: '08.webp', group: '影像', sat: 0.64 },
    { id: 'w09', name: '山河剪影', tone: 'dark',  file: '09.webp', group: '影像', sat: 0.72 },
    { id: 'w10', name: '夏日树荫', tone: 'light', file: '10.webp', group: '插画', sat: 0.72 }
  ];

  var DEFAULT_SAT = { light: 0.9, dark: 0.94 };
  var DEFAULT_BRI = { light: 1.03, dark: 0.88 };

  var STORE_KEY = 'zsearch.wall.v1';
  var AUTOPLAY_MS = 45000;
  // 交叉淡入时长。必须与 wallpaper.css 的 --wp-dur 一致（那里是 520ms）。
  // 原来 880ms：两张全屏照片叠加的时间太长，视觉上很容易看成"重影/图片重叠"，
  // 而且切一次要等将近一秒才落定。520ms 足够柔，又不会留下可辨认的双影。
  var FADE_MS = 520;

  // 默认用 02「夜湖倒影」：
  //   壁纸的第一要务是不干扰内容。这张是单一冷色调 + 对称构图 + 大片留白水面，
  //   是全套里唯一「完全不会和文字抢注意力」的一张。
  //   07 檐外花枝构图虽好，但粉/白/黄/蓝四色同框，全屏之后非常闹，已降级。
  var DEFAULT_STATE = { id: 'w02', blur: 0, scrim: 1, auto: false };

  /* ======================================================================
     2. 状态与持久化
     ====================================================================== */

  var state = Object.assign({}, DEFAULT_STATE);

  function findWall(id) {
    for (var i = 0; i < WALLS.length; i++) {
      if (WALLS[i].id === id) return WALLS[i];
    }
    return null;
  }

  function clamp(n, lo, hi) {
    n = Number(n);
    if (!isFinite(n)) return lo;
    return n < lo ? lo : n > hi ? hi : n;
  }

  function loadState() {
    var raw;
    try {
      raw = window.localStorage.getItem(STORE_KEY);
    } catch (e) {
      return;
    }
    if (!raw) return;

    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;

    if (parsed.id === null || findWall(parsed.id)) {
      state.id = parsed.id === null ? null : parsed.id;
    }
    state.blur = clamp(parsed.blur, 0, 24);
    state.scrim = clamp(
      typeof parsed.scrim === 'number' ? parsed.scrim : 1,
      0,
      1.4
    );
    state.auto = parsed.auto === true;
  }

  function saveState() {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) {
      /* 隐身模式 / 配额满：忽略，不影响使用 */
    }
  }

  /* ======================================================================
     3. DOM 引用
     ====================================================================== */

  var root = document.documentElement;
  var stage = null;
  var layers = [];
  var dock = null;
  var dockHandle = null;
  var dockList = null;
  var triggerBtn = null;
  var drawer = null;
  var drawerScrim = null;
  var drawerBody = null;
  var drawerClose = null;
  var autoplayTimer = null;

  var activeIdx = 0;
  var switchSeq = 0; // 竞态守卫：连续切图时丢弃过期的异步回调

  var systemDark =
    window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');

  /* ======================================================================
     4. 渲染（全部只读 state）
     ====================================================================== */

  /** 把 tone 与壁纸相关的数值写进 CSS 变量 */
  function renderTone() {
    var wall = state.id ? findWall(state.id) : null;

    if (wall) {
      root.dataset.wall = 'on';
      root.dataset.wallTone = wall.tone;
    } else {
      root.dataset.wall = 'off';
      // 交还给系统深浅色偏好（base.css 的 @media 接管）
      delete root.dataset.wallTone;
    }

    root.style.setProperty('--wp-scrim-op', String(state.scrim));
    root.style.setProperty('--wp-scale', state.blur > 0 ? '1.06' : '1');

    // 调色：单张覆盖优先，否则按 tone 取默认
    var tone = wall ? wall.tone : 'light';
    var sat = wall && typeof wall.sat === 'number' ? wall.sat : DEFAULT_SAT[tone];
    var bri = wall && typeof wall.bri === 'number' ? wall.bri : DEFAULT_BRI[tone];

    // 整条 filter 由这里拼好，而不是在 CSS 里拼。
    // 原因：blur(0px) 虽然视觉上等于没模糊，但 filter 链里只要出现 blur()，
    // 浏览器就得为这个全屏层单独准备一次滤镜 pass。模糊滑杆默认是 0，
    // 那就干脆别把 blur() 写进去 —— 这一层直接退化成"纯图片 + 透明度"，
    // 是合成器最省事的一种图层。
    var chain = '';
    if (state.blur > 0) chain += 'blur(' + state.blur + 'px) ';
    chain += 'saturate(' + sat + ') brightness(' + bri + ')';
    root.style.setProperty('--wp-filter', chain);
  }

  /* ---- 切换期间的运行时降级 ----
     只在「真的在淡」的那 880ms 里打开，其余时间一切照旧。
     挂两处：
       1. root 上打 data-wall-fading → wallpaper.css 末尾那段把全屏噪点层的
          mix-blend-mode 摘掉（混合模式会强制合成器回读底图）
       2. 两个壁纸层挂 is-fading → 只在这时候给 will-change: opacity
     用共享 timer 收口：连续快速点缩略图时，每次切换都重置倒计时，
     不会出现「上一次的定时器把本次降级提前关掉」。
     另外加一层保险：万一淡入动画被系统降级（prefers-reduced-motion）
     或标签页切后台，transitionend 不一定来，所以只靠 setTimeout 收尾。 */
  var fadeTimer = null;

  function beginFade() {
    if (fadeTimer) {
      window.clearTimeout(fadeTimer);
      fadeTimer = null;
    }
    root.dataset.wallFading = '1';
    for (var i = 0; i < layers.length; i++) layers[i].classList.add('is-fading');

    fadeTimer = window.setTimeout(endFade, FADE_MS + 120);
  }

  function endFade() {
    if (fadeTimer) {
      window.clearTimeout(fadeTimer);
      fadeTimer = null;
    }
    if (root.dataset.wallFading) delete root.dataset.wallFading;
    for (var i = 0; i < layers.length; i++) layers[i].classList.remove('is-fading');
  }

  /**
   * 壁纸鼠标视差。
   *
   * 这是"高级感"里最便宜也最有效的一招：整张背景随鼠标做几像素的反向位移，
   * 前景卡片不动 —— 人眼立刻会把它读成「背景在后面，内容在前面」。
   *
   * 三条纪律：
   *   1. 只改 transform（合成器线程），绝不改 top/left/margin；
   *   2. 用缓动跟随而不是直接赋值，鼠标一动图就瞬移的话会显得廉价；
   *   3. 触屏、prefers-reduced-motion 一律不启用 —— 手机上没有"悬停"这回事，
   *      跟着手指晃只会晕。
   *
   * 缓动用 rAF 自驱动：只有"还没追上目标"时才继续请求下一帧，
   * 停下之后彻底不再占用主线程。
   */
  function initParallax() {
    var reduce =
      window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return;

    var AMP = 12;           // 最大位移（px），再大就不是纵深而是晃
    var EASE = 0.12;        // 每帧靠近目标的比例
    var tx = 0, ty = 0;     // 目标
    var cx = 0, cy = 0;     // 当前
    var raf = 0;

    function tick() {
      raf = 0;
      cx += (tx - cx) * EASE;
      cy += (ty - cy) * EASE;
      root.style.setProperty('--wp-px', cx.toFixed(2) + 'px');
      root.style.setProperty('--wp-py', cy.toFixed(2) + 'px');
      if (Math.abs(tx - cx) > 0.08 || Math.abs(ty - cy) > 0.08) {
        raf = window.requestAnimationFrame(tick);
      }
    }

    window.addEventListener(
      'pointermove',
      function (e) {
        if (e.pointerType === 'touch') return;
        // 反向位移：鼠标往右，背景往左，产生"视差"而不是"跟随"
        tx = (e.clientX / window.innerWidth - 0.5) * -2 * AMP;
        ty = (e.clientY / window.innerHeight - 0.5) * -2 * AMP;
        if (!raf) raf = window.requestAnimationFrame(tick);
      },
      { passive: true }
    );

    // 指针离开窗口时归位，否则背景会一直歪着
    window.addEventListener('pointerleave', function () {
      tx = 0;
      ty = 0;
      if (!raf) raf = window.requestAnimationFrame(tick);
    });
  }
  /**
   * 壁纸层交叉淡入。
   * 关键点：新图必须塞进「当前不可见」的那一层，并且先把它无过渡归零，
   * 否则连续切换时会出现硬切。
   * 旧层必须**同步**淡出，不能等新层盖满再瞬间归零 —— 见 paint() 里的说明。
   */
  function renderWallpaper(animate) {
    var wall = state.id ? findWall(state.id) : null;

    if (!wall) {
      for (var k = 0; k < layers.length; k++) {
        layers[k].classList.remove('is-on');
      }
      endFade();
      return;
    }

    var src = BASE + wall.file;
    var next = layers[1 - activeIdx];
    var cur = layers[activeIdx];
    var mySeq = ++switchSeq;

    function paint() {
      if (mySeq !== switchSeq) return; // 已被更新的切换取代

      var useFade = animate === true;

      // 1) 无过渡地把目标层归零并换图
      next.style.transition = 'none';
      next.classList.remove('is-on');
      next.style.backgroundImage = 'url("' + src + '")';
      void next.offsetWidth; // 强制回流，让归零真正生效

      if (!useFade) {
        next.classList.add('is-on');
        cur.style.transition = 'none';
        cur.classList.remove('is-on');
        void next.offsetWidth;
        next.style.transition = '';
        cur.style.transition = '';
        activeIdx = 1 - activeIdx;
        return;
      }

      // 2) 恢复过渡并淡入
      //    进入「正在切」状态：两层挂上 will-change，
      //    同时给 root 打标记，让 wallpaper.css 末尾那段运行时降级生效。
      beginFade();
      next.style.transition = '';
      void next.offsetWidth;
      next.classList.add('is-on');

      // 3) 旧层**同步**淡出，做真正的交叉淡入。
      //
      //    旧写法是让旧层一直保持 opacity:1，等新层淡满（880ms）后再瞬间归零。
      //    问题：中间那段时间是「新图渐显 + 旧图全亮」的叠加态，两张全屏照片
      //    构图不同，看起来就是两张图糊在一起 —— 用户报的"图片重叠"就是这个。
      //    同时把两层的 is-on 一起翻掉，两层各自过渡，中点约等于 50/50 混合，
      //    观感是渐变而不是重影，也不会出现"旧图突然消失"的硬切。
      cur.style.transition = '';
      cur.classList.remove('is-on');

      activeIdx = 1 - activeIdx;

      // 4) 过渡结束后收尾：
      //    旧层可能还留着上一次非动画切换时写进去的 inline transition:none，
      //    这里统一清干净，并撤掉降级标记。
      window.setTimeout(function () {
        if (mySeq !== switchSeq) return;
        cur.style.transition = '';
        cur.classList.remove('is-on');
        endFade();
      }, FADE_MS + 20);
    }

    // 图必须先「解码完」再翻 opacity，不能只等 onload。
    // onload 只代表字节到齐，真正的解码通常发生在首次绘制的那一刻 ——
    // 一张 1920×1080 的 webp 解出来是 8MB 位图，正好砸在淡入的第一帧上，
    // 表现就是"点了缩略图，画面先顿一下才开始动"。
    // decode() 会把解码提前到淡入之前完成，代价只是一次异步等待。
    var probe = new Image();
    var started = false;
    function go() {
      if (started) return;
      started = true;
      paint();
    }
    probe.onload = function () {
      if (typeof probe.decode === 'function') {
        probe.decode().then(go, go); // 解码失败也照常切，别把功能卡死
      } else {
        go();
      }
    };
    probe.onerror = function () {
      /* 图挂了就保持当前壁纸，不阻断交互 */
    };
    probe.src = src;
  }

  /* ---- 空闲时把 10 张图全部预解码 ----
     第一次点某张缩略图时的顿挫，根源就是"这一张还没解过码"。
     页面加载完把 10 张全部 decode 一遍（合计约 310KB 源文件 / 80MB 位图，
     浏览器会自己管理内存，不会真的常驻 80MB），之后任何一次切换都只剩翻 opacity。 */
  var preloaded = false;

  function preloadAll() {
    if (preloaded) return;
    preloaded = true;
    for (var i = 0; i < WALLS.length; i++) {
      (function (file) {
        var im = new Image();
        im.decoding = 'async';
        im.onload = function () {
          if (typeof im.decode === 'function') im.decode().catch(function () {});
        };
        im.src = BASE + file;
      })(WALLS[i].file);
    }
  }

  /** 底部胶囊的选中态 */
  function renderDockSelection() {
    if (!dockList) return;
    var items = dockList.querySelectorAll('.wall-thumb');
    for (var i = 0; i < items.length; i++) {
      var on = items[i].getAttribute('data-id') === state.id;
      items[i].setAttribute('aria-checked', on ? 'true' : 'false');
    }
  }

  /** 抽屉里的选中态 */
  function renderDrawerSelection() {
    if (!drawerBody) return;
    var cards = drawerBody.querySelectorAll('.wall-card');
    for (var i = 0; i < cards.length; i++) {
      var on = cards[i].getAttribute('data-id') === state.id;
      cards[i].setAttribute('aria-checked', on ? 'true' : 'false');
    }
  }

  /** 滑杆与开关的当前值 */
  function renderControls() {
    if (!drawerBody) return;

    var blurInput = drawerBody.querySelector('#wallBlur');
    var blurOut = drawerBody.querySelector('#wallBlurValue');
    var scrimInput = drawerBody.querySelector('#wallScrim');
    var scrimOut = drawerBody.querySelector('#wallScrimValue');
    var autoBtn = drawerBody.querySelector('#wallAuto');

    if (blurInput) blurInput.value = String(state.blur);
    if (blurOut) blurOut.textContent = state.blur + 'px';
    if (scrimInput) scrimInput.value = String(Math.round(state.scrim * 100));
    if (scrimOut) scrimOut.textContent = Math.round(state.scrim * 100) + '%';
    if (autoBtn) autoBtn.setAttribute('aria-checked', state.auto ? 'true' : 'false');
  }

  /** 唯一刷新入口。changed 只在壁纸本身变化时传 'wall'。 */
  function apply(changed) {
    renderTone();
    if (changed === 'wall' || changed === 'init') {
      renderWallpaper(changed === 'wall');
    }
    renderDockSelection();
    renderDrawerSelection();
    renderControls();
    syncAutoplay();
  }

  /* ======================================================================
     5. 行为
     ====================================================================== */

  function pickWall(id) {
    if (state.id === id) return;
    state.id = id;
    saveState();
    apply('wall');
  }

  function pickRelative(delta) {
    var idx = -1;
    for (var i = 0; i < WALLS.length; i++) {
      if (WALLS[i].id === state.id) {
        idx = i;
        break;
      }
    }
    var next = (idx + delta + WALLS.length) % WALLS.length;
    pickWall(WALLS[next].id);
  }

  function syncAutoplay() {
    if (autoplayTimer) {
      window.clearInterval(autoplayTimer);
      autoplayTimer = null;
    }
    if (!state.auto || !state.id) return;
    autoplayTimer = window.setInterval(function () {
      if (document.hidden) return; // 后台不跑，省电
      pickRelative(1);
    }, AUTOPLAY_MS);
  }

  /* ---- 构建壁纸相关的 DOM（只做一次） ---- */

  function buildStage() {
    var existing = document.querySelector('.wall-stage');
    if (existing) {
      stage = existing;
      layers = Array.prototype.slice.call(existing.querySelectorAll('.wall-layer'));
      return;
    }

    stage = document.createElement('div');
    stage.className = 'wall-stage';
    stage.setAttribute('aria-hidden', 'true');

    var a = document.createElement('div');
    a.className = 'wall-layer';
    var b = document.createElement('div');
    b.className = 'wall-layer';

    var scrim = document.createElement('div');
    scrim.className = 'wall-scrim';

    var veil = document.createElement('div');
    veil.className = 'wall-veil';

    var grain = document.createElement('div');
    grain.className = 'wall-grain';

    stage.appendChild(a);
    stage.appendChild(b);
    stage.appendChild(scrim);
    stage.appendChild(veil);
    stage.appendChild(grain);
    document.body.appendChild(stage);

    layers = [a, b];
  }

  function buildDock() {
    if (document.querySelector('.wall-dock')) return;

    dock = document.createElement('div');
    dock.className = 'wall-dock';

    dockHandle = document.createElement('button');
    dockHandle.type = 'button';
    dockHandle.className = 'wall-dock-handle';
    dockHandle.setAttribute('aria-label', '切换壁纸');
    dockHandle.setAttribute('aria-expanded', 'false');
    dockHandle.setAttribute('title', '切换壁纸');
    dockHandle.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
      ' stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<rect x="3" y="3" width="18" height="18" rx="3"></rect>' +
      '<circle cx="8.5" cy="8.5" r="1.6"></circle>' +
      '<path d="m21 15-4.6-4.6a2 2 0 0 0-2.8 0L4 20"></path></svg>';

    dockList = document.createElement('div');
    dockList.className = 'wall-dock-list';
    dockList.setAttribute('role', 'radiogroup');
    dockList.setAttribute('aria-label', '壁纸选择');

    // 纯纸感：一键回到无壁纸状态。放在最前面，想「退回原来的干净样子」不用翻抽屉。
    var plainThumb = document.createElement('button');
    plainThumb.type = 'button';
    plainThumb.className = 'wall-thumb is-plain';
    plainThumb.setAttribute('role', 'radio');
    plainThumb.setAttribute('data-id', 'none');
    plainThumb.setAttribute('aria-checked', 'false');
    plainThumb.setAttribute('aria-label', '纯纸感（无壁纸）');
    plainThumb.setAttribute('title', '纯纸感（无壁纸）');
    dockList.appendChild(plainThumb);

    for (var i = 0; i < WALLS.length; i++) {
      var w = WALLS[i];
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'wall-thumb';
      btn.setAttribute('role', 'radio');
      btn.setAttribute('data-id', w.id);
      btn.setAttribute('aria-checked', 'false');
      btn.setAttribute('aria-label', w.name);
      btn.setAttribute('title', w.name);
      btn.style.backgroundImage = 'url("' + BASE + 'thumb/' + w.file + '")';
      dockList.appendChild(btn);
    }

    dock.appendChild(dockHandle);
    dock.appendChild(dockList);
    document.body.appendChild(dock);

    dockHandle.addEventListener('click', function () {
      var open = dock.classList.toggle('is-open');
      dockHandle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    dockList.addEventListener('click', function (ev) {
      var btn = ev.target.closest ? ev.target.closest('.wall-thumb') : null;
      if (!btn) return;
      var id = btn.getAttribute('data-id');
      pickWall(id === 'none' ? null : id);
    });
  }

  function buildDrawer() {
    if (document.querySelector('.wall-drawer')) return;

    drawerScrim = document.createElement('div');
    drawerScrim.className = 'wall-drawer-scrim';

    drawer = document.createElement('aside');
    drawer.className = 'wall-drawer';
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-modal', 'true');
    drawer.setAttribute('aria-label', '外观设置');
    drawer.setAttribute('aria-hidden', 'true');

    /* 头部 */
    var head = document.createElement('div');
    head.className = 'wall-drawer-head';

    var title = document.createElement('span');
    title.className = 'wall-drawer-title';
    title.textContent = '外观';

    drawerClose = document.createElement('button');
    drawerClose.type = 'button';
    drawerClose.className = 'wall-drawer-close';
    drawerClose.setAttribute('aria-label', '关闭');
    drawerClose.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
      ' stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"></path></svg>';

    head.appendChild(title);
    head.appendChild(drawerClose);

    /* 主体 */
    drawerBody = document.createElement('div');
    drawerBody.className = 'wall-drawer-body';

    // 壁纸网格：按风格分组。
    // 8 张摄影/油画与 2 张卡通插画的气质差得很远，混在一起切会显得跳，
    // 分开摆用户一眼就知道自己进的是哪个区。
    var labelWall = document.createElement('span');
    labelWall.className = 'wall-section-label';
    labelWall.textContent = '壁纸';
    drawerBody.appendChild(labelWall);

    var grid = document.createElement('div');
    grid.className = 'wall-grid';
    grid.setAttribute('role', 'radiogroup');
    grid.setAttribute('aria-label', '壁纸');

    // 无壁纸选项
    var plain = document.createElement('button');
    plain.type = 'button';
    plain.className = 'wall-card is-plain';
    plain.setAttribute('role', 'radio');
    plain.setAttribute('data-id', 'none');
    plain.setAttribute('aria-checked', 'false');
    plain.innerHTML = '<span class="wall-card-name">纯纸感</span>';
    grid.appendChild(plain);

    var GROUPS = ['影像', '插画'];
    for (var g = 0; g < GROUPS.length; g++) {
      var gname = GROUPS[g];
      var members = WALLS.filter(function (w) {
        return w.group === gname;
      });
      if (!members.length) continue;

      var glabel = document.createElement('span');
      glabel.className = 'wall-group-label';
      glabel.textContent = gname;
      grid.appendChild(glabel);

      for (var i = 0; i < members.length; i++) {
        var w = members[i];
        var card = document.createElement('button');
        card.type = 'button';
        card.className = 'wall-card';
        card.setAttribute('role', 'radio');
        card.setAttribute('data-id', w.id);
        card.setAttribute('aria-checked', 'false');
        card.style.backgroundImage = 'url("' + BASE + 'thumb/' + w.file + '")';

        var name = document.createElement('span');
        name.className = 'wall-card-name';
        name.textContent = w.name;

        card.appendChild(name);
        grid.appendChild(card);
      }
    }

    drawerBody.appendChild(grid);

    // 调节
    var labelTune = document.createElement('span');
    labelTune.className = 'wall-section-label';
    labelTune.textContent = '画面';
    drawerBody.appendChild(labelTune);

    drawerBody.appendChild(
      buildSlider('wallBlur', '模糊', 0, 24, 1, 'px')
    );
    drawerBody.appendChild(
      buildSlider('wallScrim', '暗度', 0, 140, 1, '%')
    );

    // 自动轮播
    var autoRow = document.createElement('div');
    autoRow.className = 'wall-switch-row';
    autoRow.appendChild(document.createTextNode('自动轮播（45 秒）'));

    var autoBtn = document.createElement('button');
    autoBtn.type = 'button';
    autoBtn.className = 'wall-switch';
    autoBtn.id = 'wallAuto';
    autoBtn.setAttribute('role', 'switch');
    autoBtn.setAttribute('aria-checked', 'false');
    autoBtn.setAttribute('aria-label', '自动轮播');
    autoRow.appendChild(autoBtn);
    drawerBody.appendChild(autoRow);

    drawer.appendChild(head);
    drawer.appendChild(drawerBody);

    document.body.appendChild(drawerScrim);
    document.body.appendChild(drawer);

    /* ---- 事件 ---- */

    grid.addEventListener('click', function (ev) {
      var card = ev.target.closest ? ev.target.closest('.wall-card') : null;
      if (!card) return;
      var id = card.getAttribute('data-id');
      pickWall(id === 'none' ? null : id);
    });

    drawerBody.querySelector('#wallBlur').addEventListener('input', function (ev) {
      state.blur = clamp(ev.target.value, 0, 24);
      saveState();
      apply();
    });

    drawerBody.querySelector('#wallScrim').addEventListener('input', function (ev) {
      state.scrim = clamp(Number(ev.target.value) / 100, 0, 1.4);
      saveState();
      apply();
    });

    autoBtn.addEventListener('click', function () {
      state.auto = !state.auto;
      saveState();
      apply();
    });

    drawerScrim.addEventListener('click', closeDrawer);
    drawerClose.addEventListener('click', closeDrawer);
  }

  function buildSlider(id, labelText, min, max, step, unit) {
    var row = document.createElement('div');
    row.className = 'wall-slider';

    var label = document.createElement('span');
    label.className = 'wall-slider-label';
    label.textContent = labelText;

    var input = document.createElement('input');
    input.type = 'range';
    input.id = id;
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.setAttribute('aria-label', labelText);

    var out = document.createElement('span');
    out.className = 'wall-slider-value';
    out.id = id + 'Value';

    row.appendChild(label);
    row.appendChild(input);
    row.appendChild(out);
    return row;
  }

  function openDrawer() {
    if (!drawer) return;
    drawer.classList.add('is-open');
    drawerScrim.classList.add('is-open');
    drawer.setAttribute('aria-hidden', 'false');
    apply();
    if (drawerClose) drawerClose.focus({ preventScroll: true });
  }

  function closeDrawer() {
    if (!drawer) return;
    drawer.classList.remove('is-open');
    drawerScrim.classList.remove('is-open');
    drawer.setAttribute('aria-hidden', 'true');
    if (triggerBtn) triggerBtn.focus({ preventScroll: true });
  }

  function isDrawerOpen() {
    return !!drawer && drawer.classList.contains('is-open');
  }

  /* ---- 顶栏触发按钮：首页挂在 home-header-right，结果页挂在 topbar-actions ---- */

  function mountTrigger() {
    var host =
      document.querySelector('.home-header-right') ||
      document.querySelector('.results-topbar-actions');
    if (!host || host.querySelector('.wall-trigger')) return;

    triggerBtn = document.createElement('button');
    triggerBtn.type = 'button';
    triggerBtn.className = 'wall-trigger';
    triggerBtn.setAttribute('aria-label', '外观设置');
    triggerBtn.setAttribute('title', '外观设置');
    triggerBtn.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
      ' stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="9"></circle>' +
      '<path d="M12 3a9 9 0 0 0 0 18" fill="currentColor" stroke="none" opacity="0.28"></path>' +
      '<circle cx="12" cy="12" r="3.2"></circle></svg>';

    triggerBtn.addEventListener('click', openDrawer);
    host.insertBefore(triggerBtn, host.firstChild);
  }

  /* ---- 键盘 ---- */

  function onKeydown(ev) {
    var t = ev.target;
    var tag = t && t.tagName ? t.tagName.toLowerCase() : '';
    var typing = tag === 'input' || tag === 'textarea' || (t && t.isContentEditable);

    if (ev.key === 'Escape' && isDrawerOpen()) {
      closeDrawer();
      ev.preventDefault();
      return;
    }

    // Alt + ←/→ 切壁纸：在输入框里也允许，但输入框内左方向键是光标移动，
    // 所以只在非输入态生效，避免抢走文本编辑。
    if (typing) return;

    if (ev.altKey && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) {
      pickRelative(ev.key === 'ArrowRight' ? 1 : -1);
      ev.preventDefault();
    }
  }

  /* ======================================================================
     6. 启动
     ====================================================================== */

  function init() {
    buildStage();
    buildDock();
    buildDrawer();
    mountTrigger();

    loadState();
    apply('init');

    // 视差挂在首屏之后：它只影响鼠标移动时的几像素位移，
    // 和首屏渲染没有先后依赖，放这里不抢关键路径。
    initParallax();

    document.addEventListener('keydown', onKeydown);

    // 系统主题变化时，仅在「无壁纸」模式下需要重绘（有壁纸由 tone 决定）
    if (systemDark) {
      var onScheme = function () {
        if (!state.id) apply();
      };
      if (systemDark.addEventListener) systemDark.addEventListener('change', onScheme);
      else if (systemDark.addListener) systemDark.addListener(onScheme);
    }

    // 暴露最小接口，供其他脚本（如结果页筛选）联动，不暴露内部状态
    window.ZSearchWall = {
      set: function (id) { pickWall(id); },
      open: openDrawer,
      close: closeDrawer,
      list: function () { return WALLS.slice(); }
    };

    // 预解码排在首屏之后：别和首屏抢带宽/主线程。
    // rIC 在后台标签页可能一直不触发，所以再挂一个 timeout 兜底。
    if (window.requestIdleCallback) {
      window.requestIdleCallback(preloadAll, { timeout: 2500 });
    } else {
      window.setTimeout(preloadAll, 1200);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
