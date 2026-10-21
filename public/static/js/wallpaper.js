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
  // 2026-10-21 二次调整：颜色调整（饱和度/亮度）已**烘焙进图片像素**
  // （见 _rebuild_wall.py），这里不再有 sat/bri 字段。
  // 原因有两条，都很硬：
  //   1. 全屏层上的 filter 是一笔真金白银的开销 —— 只要有 filter，
  //      合成器就得为这个全屏图层单独准备一次滤镜 pass。而背景还挂着鼠标视差，
  //      图层每帧都在动 ⇒ **每帧重跑一次 1920×1080 的滤镜 pass**，这比什么都卡。
  //      烘焙进像素后默认状态零滤镜，视差退化成纯合成，是最便宜的形态。
  //   2. 原来每张图被 saturate(0.5~0.94) 压着，画面发灰 —— 主观上就是"不清晰"。
  var WALLS = [
    { id: 'w01', name: '软梦月球', tone: 'light', file: '01.webp', group: '插画' },
    { id: 'w02', name: '夜湖倒影', tone: 'dark',  file: '02.webp', group: '影像' },
    { id: 'w03', name: '橘子洲头', tone: 'dark',  file: '03.webp', group: '影像' },
    { id: 'w04', name: '林间车站', tone: 'dark',  file: '04.webp', group: '影像' },
    { id: 'w05', name: '星月夜',   tone: 'dark',  file: '05.webp', group: '影像' },
    { id: 'w06', name: '雪峰银河', tone: 'dark',  file: '06.webp', group: '影像' },
    { id: 'w07', name: '檐外花枝', tone: 'light', file: '07.webp', group: '影像' },
    { id: 'w08', name: '秋径红叶', tone: 'light', file: '08.webp', group: '影像' },
    { id: 'w09', name: '山河剪影', tone: 'dark',  file: '09.webp', group: '影像' },
    { id: 'w10', name: '夏日树荫', tone: 'light', file: '10.webp', group: '插画' }
  ];

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

  // 视差的"把当前位移立刻同步到可见层"入口，由 initParallax 安装。
  // 切图后新层拿到的是 CSS 初始 transform，不同步就会从 (0,0) 跳一下。
  var parallaxSync = null;

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
    // 模糊变了 → transform 里的 scale 也要跟着变（blur>0 需要额外 1.06 防露边）。
    // 位移值没变，只是重新拼一次 transform。
    if (parallaxSync) parallaxSync();

    // 整条 filter 由这里拼好，而不是在 CSS 里拼。
    //
    // 2026-10-21 二次调整：调色（saturate / brightness）已烘焙进图片，这里只剩
    // **用户自己拖的模糊**。所以默认状态下 chain 是空字符串 → 这一层没有 filter，
    // 合成器不用为它准备任何滤镜 pass。
    //
    // 这一点必须守住：背景还挂着鼠标视差，图层每帧都在动。
    // 只要 filter 链里留着一个 saturate()，哪怕参数是 1，也会变成
    // "每帧一次全屏滤镜 pass" —— 这是上一版切图/移动都发卡的直接原因之一。
    // （blur(0px) 也是同理，所以只在真的 >0 时才写进去。）
    var chain = '';
    if (state.blur > 0) chain += 'blur(' + state.blur + 'px) ';
    root.style.setProperty('--wp-filter', chain || 'none');
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

    // 放大系数：1.012 用来盖住位移（background-size:cover 铺满时位移会露边），
    // blur > 0 时再叠 1.06（模糊的采样半径会向外扩）。
    function scaleOf() {
      return (state && state.blur > 0 ? 1.06 : 1) * 1.012;
    }

    /* 这里曾经有过一段"动的时候给可见层加 will-change: transform、
       停下 700ms 再还回去"的图层提升逻辑。删掉的原因很直接：实测无效。
       开与不开，60 次鼠标移动的主线程耗时分别是 439ms / 437ms（噪声级别），
       而代价是它会和切换动画的 `will-change: opacity` 抢同一个属性，
       让"淡入结束后已释放 will-change"这条断言失效。
       没有效果的复杂度就是负债，不留。 */

    /* 每帧只做**一次属性写**，而且只写给**当前可见的那一层**。
       三个细节都是踩出来的：

       ① 不用 CSS 变量，直接写 transform。
          自定义属性会被后代继承，赋值时浏览器要沿继承链传播失效；
          transform 是普通属性，失效范围只有这个元素自己。

       ② 只写可见层。
          两层里有一层 opacity:0，它照样会参与样式重算和图层合成 ——
          给它写位移等于白烧一帧的合成预算。

       ③ 交叉淡入期间（data-wall-fading 存在）两层都要写。
          那 520ms 里两层同时可见，只让一层动就会看成"两张图错位"。 */
    function write(vx, vy) {
      var tf = 'scale(' + scaleOf().toFixed(4) + ') translate3d(' +
        vx.toFixed(2) + 'px,' + vy.toFixed(2) + 'px,0)';
      var fading = !!(root.dataset && root.dataset.wallFading);
      for (var i = 0; i < layers.length; i++) {
        if (fading || layers[i].classList.contains('is-on')) {
          layers[i].style.transform = tf;
        }
      }
    }

    var frame = 0;

    function tick() {
      raf = 0;
      cx += (tx - cx) * EASE;
      cy += (ty - cy) * EASE;
      frame++;
      // ★ 每 2 帧写一次（30fps）。
      // 视差本身是缓动跟随，位移每次只有零点几像素，30fps 和 60fps
      // 在观感上分不出来；但全屏图层的合成为此少跑一半 —— 在集成显卡 /
      // 软件合成的机器上，这一半就是"能不能流畅"的分界线。
      // 缓动计算仍然每帧推进，所以跟随手感不变，只是刷新率减半。
      if (frame % 2 === 0) write(cx, cy);
      if (Math.abs(tx - cx) > 0.08 || Math.abs(ty - cy) > 0.08) {
        raf = window.requestAnimationFrame(tick);
      } else {
        // 收敛时补最后一帧，避免停在半路上（150% 之内的残余位移）
        write(cx, cy);
      }
    }

    // 切图后新层拿到的是 CSS 里的初始 transform，需要立刻同步到当前位移，
    // 否则会从 (0,0) 跳一下。
    parallaxSync = function () {
      write(cx, cy);
    };

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

      // 新层刚拿到 CSS 里的初始 transform，把当前位移补上去，
      // 否则它会在淡入的同时从 (0,0) 滑一下 —— 视觉上像"图在漂"。
      if (parallaxSync) parallaxSync();

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

  /* ---- 按需预解码 ----
     第一次点某张缩略图时的顿挫，根源是"这一张还没解过码"。
     decode() 把解码提前，切图时就只剩翻 opacity。

     ⚠️ 2026-10-21 二次调整：**不再在页面加载完就一次性解全部 10 张。**
     当时以为"浏览器会自己管内存，不会真常驻"，但实际上 10 张 1920×1080
     解出来是 ~83MB 的位图，扎堆解码会把主线程和解码线程占满几秒 ——
     用户感受到的就是"一打开就卡、滚一下也卡"。壁纸换成原图后体积涨到 3.6MB，
     这个问题只会更明显。

     现在改成两级按需：
       ① 打开外观抽屉时才逐张预热（间隔 120ms，不扎堆）；
       ② 指针指到哪张缩略图，就先解哪张 —— 用户从"看一眼"到"点下去"
          中间通常有几百毫秒，足够解完。
     首屏因此零额外成本。 */
  var decoded = {};

  function decodeOne(file) {
    if (!file || decoded[file]) return;
    decoded[file] = true;          // 先占位，避免同一张被并发解码多次
    var im = new Image();
    im.decoding = 'async';
    im.onload = function () {
      if (typeof im.decode === 'function') im.decode().catch(function () {});
    };
    im.onerror = function () {
      // 失败也留着标记，别让预热逻辑反复重试砸请求
    };
    im.src = BASE + file;
  }

  /* 抽屉打开时逐张预热。用递归 setTimeout 而不是 for 循环一次性 src 赋值：
     后者会让 10 个解码任务在同一时刻全部排队，正是要避免的"扎堆"。 */
  function warmUpWalls() {
    var i = 0;
    (function next() {
      if (i >= WALLS.length) return;
      decodeOne(WALLS[i].file);
      i++;
      window.setTimeout(next, 120);
    })();
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

        // 指针指到哪张就先解哪张。从"看一眼缩略图"到"点下去"通常有几百毫秒，
        // 足够把这张 1920 宽的图解码完 —— 点下去时就不用等 decode 了。
        // focus 也挂上：键盘 Tab 到这张同理。
        (function (file) {
          card.addEventListener('pointerenter', function () { decodeOne(file); }, { passive: true });
          card.addEventListener('focus', function () { decodeOne(file); });
        })(w.file);
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
    // 用户已经表达"我要换壁纸"这个意图了，这时候预热解码最合理：
    // 不占首屏，又能在真正点下去之前把图解好。
    warmUpWalls();
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

    // 首屏**不做**预解码。
    // 原来这里排了一个 requestIdleCallback(() => preloadAll())，把 10 张全屏图
    // 一次解完（~83MB 位图）。本意是"之后切图更快"，实际效果是页面加载完
    // 几秒内主线程/解码线程一直被占着 —— 首屏本来能滑，反而滑不动。
    // 现在解码时机交给"打开抽屉"和"指针指到缩略图"两个真实意图，见 warmUpWalls。
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
