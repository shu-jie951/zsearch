/* ==========================================================================
   ZSEARCH · 质感层（polish.js）
   --------------------------------------------------------------------------
   纯装饰性交互特效，不参与任何搜索/收藏/导出逻辑。
   与业务代码的关系是**单向**的：它只订阅 results.js 派发的 `zsearch:rendered`
   事件，绝不反过来调用 results.js 的渲染函数（和 workbench.js 的约定一致）。

   包含三项：
     1. 卡片聚光   —— 一团跟着光标走的柔光（键盘导航时改由 CSS 接管）
     2. 数字滚动   —— 结果条数从 0 滚到目标值
     3. 长列表渐入 —— 第 16 条之后的行进入视口才渐显

   性能口径：全部只改 transform / opacity / 自定义属性，走合成器线程；
   pointermove 一律 passive，且用 rAF 把同一帧内的多次事件合并成一次写入。
   ========================================================================== */
(function () {
  'use strict';

  var reduceMotion = !!(window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  /* =======================================================================
     1. 卡片聚光跟随
     -----------------------------------------------------------------------
     用一个挂在列表容器上的事件委托，而不是给每张卡片各挂一组监听器：
     一页 60 条结果就是 120 个监听器，内存和事件派发都是白花的。
     ======================================================================= */
  function initCardSpotlight() {
    var host = document.getElementById('resultList');
    if (!host) return;

    var active = null;   // 当前被照亮的那张卡
    var rect = null;     // 缓存盒子位置：别在 pointermove 里反复 measure
    var raf = 0;
    var px = 0;
    var py = 0;

    function flush() {
      raf = 0;
      if (!active) return;
      active.style.setProperty('--spot-x', px + 'px');
      active.style.setProperty('--spot-y', py + 'px');
    }

    function setActive(el) {
      if (el === active) return;
      if (active) active.classList.remove('is-spot');
      active = el;
      rect = null;
      if (active) active.classList.add('is-spot');
    }

    function clear() {
      setActive(null);
    }

    // 触屏没有 hover 概念，聚光不跟随 —— 省掉一条纯属浪费的高频路径
    host.addEventListener('pointerover', function (e) {
      if (e.pointerType === 'touch') return;
      var el = e.target && e.target.closest ? e.target.closest('.result-item') : null;
      setActive(el && host.contains(el) ? el : null);
    }, { passive: true });

    host.addEventListener('pointermove', function (e) {
      if (e.pointerType === 'touch' || !active) return;
      if (!rect) rect = active.getBoundingClientRect();
      px = Math.round(e.clientX - rect.left);
      py = Math.round(e.clientY - rect.top);
      if (!raf) raf = requestAnimationFrame(flush);
    }, { passive: true });

    host.addEventListener('pointerleave', clear, { passive: true });

    // 列表每次重渲染都是新节点，旧的 active 已不在文档里 —— 必须清掉，
    // 否则下一帧会往一个游离节点上写样式（不报错，但纯属无效工作）。
    document.addEventListener('zsearch:rendered', clear);

    // 键盘导航接管时把鼠标那盏灯关掉：
    // 否则「鼠标悬停 A + 键盘选中 B」会同时亮两块，看着像 bug。
    // 键盘态的高亮本身由 CSS 的 .keyboard-focus 规则负责，这里只需要熄灯。
    document.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' ||
          e.key === 'Home' || e.key === 'End') {
        clear();
      }
    }, true);
  }

  /* =======================================================================
     2. 统计数字滚动
     -----------------------------------------------------------------------
     仅对结果条数这一个数字做。数字滚动的价值在于"这次搜索有产出"这个
     瞬间反馈，铺到所有数字上就成了花活。
     ======================================================================= */
  function animateCount(el, target) {
    if (!el) return;
    if (reduceMotion || !target || target < 2) {
      el.textContent = String(target || 0);
      return;
    }
    var token = (el.__countToken || 0) + 1;
    el.__countToken = token;

    var start = 0;
    var dur = 460;
    var t0 = 0;

    function step(now) {
      // 期间若发生了新的渲染（两阶段搜索会再来一次），这次就作废
      if (el.__countToken !== token) return;
      if (!t0) t0 = now;
      var p = Math.min(1, (now - t0) / dur);
      // easeOutCubic：前快后慢，收尾时会稳稳停在目标值上
      var v = Math.round(start + (target - start) * (1 - Math.pow(1 - p, 3)));
      el.textContent = String(v);
      if (p < 1) {
        requestAnimationFrame(step);
      } else {
        el.textContent = String(target);
      }
    }

    el.textContent = '0';
    requestAnimationFrame(step);
  }

  function initCountUp() {
    document.addEventListener('zsearch:rendered', function () {
      var stats = document.getElementById('statsContainer');
      if (!stats) return;
      var b = stats.querySelector('b');
      if (!b) return;
      var target = parseInt(b.textContent, 10);
      if (isNaN(target)) return;
      b.classList.add('count-up');
      animateCount(b, target);
    });
  }

  /* =======================================================================
     3. 长列表懒渐入
     -----------------------------------------------------------------------
     只处理第 16 条之后的行。前 16 条走 results.js 原有的 item-in 错峰渐入，
     再往后继续叠延迟会让长列表的"出场"拖得很长，反而显得慢。
     第 16 条以后默认在首屏之外，让它们进视口时再亮起来更省事也更自然。

     ⚠️ 保险丝：1.2s 后无条件全部放行。
     没有这条，一旦 IntersectionObserver 因为任何原因（后台标签页、打印、
     无头浏览器不触发滚动）没回调，这些行就会永远停在 opacity:0 ——
     内容"消失"是最严重的一类 bug，宁可少一个动画。
     ======================================================================= */
  var LAZY_FROM = 16;

  function initLazyReveal() {
    if (reduceMotion || !('IntersectionObserver' in window)) return;

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        reveal(en.target);
        io.unobserve(en.target);
      });
    }, { rootMargin: '220px 0px' });

    function reveal(el) {
      el.classList.add('in-view');
    }

    function done(el) {
      // 两个类一起摘掉：回到自然状态（opacity 1、无 transform），
      // 不依赖 animation-fill-mode —— 常驻 transform 会破坏后代定位。
      el.classList.remove('pending-in', 'in-view');
    }

    document.addEventListener('zsearch:rendered', function () {
      var host = document.getElementById('resultList');
      if (!host) return;
      var rows = host.querySelectorAll('.result-item');
      if (rows.length <= LAZY_FROM) return;

      var pending = [];
      for (var i = LAZY_FROM; i < rows.length; i++) {
        var el = rows[i];
        if (el.classList.contains('pending-in')) continue;
        el.classList.add('pending-in');
        el.addEventListener('animationend', function () { done(this); }, { once: true });
        pending.push(el);
        io.observe(el);
      }
      if (!pending.length) return;

      // 保险丝：无论观察器有没有回来，1.2s 后一律放行
      window.setTimeout(function () {
        pending.forEach(function (el) {
          if (el.classList.contains('pending-in')) done(el);
        });
      }, 1200);
    });
  }

  /* =======================================================================
     初始化
     ======================================================================= */
  function boot() {
    try { initCardSpotlight(); } catch (err) { /* 装饰层出错不能影响主流程 */ }
    try { initCountUp(); } catch (err) { /* 同上 */ }
    try { initLazyReveal(); } catch (err) { /* 同上 */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
