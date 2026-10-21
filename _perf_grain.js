/**
 * _perf_grain.js —— 找出「鼠标一动就卡」的真实来源（A/B 实测，不是猜）
 *
 * 用法: node _perf_grain.js [real]
 *   默认无头（SwiftShader），第二个参数给 real 则用真窗口真 GPU。
 *
 * 为什么要有这个脚本：
 *   用户反馈"运行不够流畅，是十分卡顿"。上一轮我把卡顿全归到壁纸淡入和视差上，
 *   改完用户依然说卡 —— 说明还有别的东西在买单。
 *
 *   静态盘点发现页面上有**两层** mix-blend-mode: overlay 的噪点：
 *     · .atmosphere .grain（base.css）
 *     · .wall-grain（wallpaper.css）
 *   开壁纸时两层叠加。而 mix-blend-mode 会强迫合成器回读底图再混合；
 *   视差一旦让下层 transform 每帧变化，整屏混合就得每帧重算。
 *
 *   这个脚本用同一套鼠标轨迹跑三个变体，只改噪点层的混合方式：
 *     A 现状        —— 两层 overlay
 *     B 改 normal   —— 去掉回读底图的要求，噪声用透明度叠加
 *     C 全隐藏      —— 上界：噪点完全不参与合成
 *   如果 B ≈ C 且明显好于 A，说明噪点层的混合模式就是主要成本，
 *   那就把 B 落进 CSS（视觉几乎不变，成本直接消失）。
 *   如果三者差不多，说明我猜错了，别动 CSS，继续找。
 *
 * ⚠️ 只做对比诊断，不做绝对耗时断言。
 *   本机无头浏览器受 SwiftShader 限制，空转就到不了 60fps，
 *   绝对数字没有意义，同环境下的相对差值才有意义。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = Number(process.env.PORT || 5178);
const REAL = process.argv[2] === 'real';
const OUT = path.join(__dirname, '_perf_grain.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (u) =>
  new Promise((res, rej) => {
    http
      .get(u, (r) => {
        let d = '';
        r.on('data', (c) => (d += c));
        r.on('end', () => res(d));
      })
      .on('error', rej);
  });

/* 四个变体：注入的 CSS 与说明
 *
 * 从「静态盘点」发现的三个嫌疑里挑最值得量测的：
 *   ① 两层 mix-blend-mode: overlay 噪点（回读底图 → 下层一动就整屏重混合）
 *   ② .atmosphere .aura：三块 96vw×96vh 的径向渐变，带 filter: blur(72px)，
 *      还挂着 animation ... infinite alternate —— 页面静止时它也在动，
 *      每帧重跑一次全屏大半径高斯模糊。
 */
const VARIANTS = [
  {
    key: 'A',
    label: '现状（两层 overlay 噪点 + aura 无限漂移 + blur72）',
    css: '',
  },
  {
    key: 'B',
    label: '只改噪点 → normal',
    css: '.atmosphere .grain,.wall-grain{mix-blend-mode:normal!important}',
  },
  {
    key: 'D',
    label: '只停极光动画（保留 blur）',
    css: '.atmosphere .aura{animation:none!important}',
  },
  {
    key: 'E',
    label: '合并方案：停极光动画 + 去 blur + 噪点 normal',
    css:
      '.atmosphere .aura{animation:none!important;filter:none!important}' +
      '.atmosphere .grain,.wall-grain{mix-blend-mode:normal!important}',
  },
];

(async () => {
  const cport = 9800 + Math.floor(Math.random() * 60);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-grain-'));
  const flags = REAL
    ? [
        '--no-first-run',
        '--no-default-browser-check',
        '--remote-debugging-port=' + cport,
        '--user-data-dir=' + prof,
        '--window-position=120,80',
        'about:blank',
      ]
    : [
        '--headless=new',
        '--no-first-run',
        '--hide-scrollbars',
        '--remote-debugging-port=' + cport,
        '--user-data-dir=' + prof,
        '--window-size=1440,900',
        'about:blank',
      ];
  const proc = spawn(EDGE, flags, { stdio: 'ignore' });

  let ver = null;
  for (let i = 0; i < 80; i++) {
    try {
      ver = JSON.parse(await get('http://127.0.0.1:' + cport + '/json/version'));
      break;
    } catch (e) {
      await sleep(250);
    }
  }
  if (!ver) {
    console.error('Edge 没起来');
    try { proc.kill(); } catch (e) {}
    process.exit(1);
  }
  console.log('browser:', ver.Browser, REAL ? '(真窗口)' : '(无头)');

  const WebSocket = require('ws');
  const ws = new WebSocket(ver.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r) => ws.on('open', r));

  let id = 0;
  const pend = new Map();
  ws.on('message', (m) => {
    const o = JSON.parse(m);
    if (o.id && pend.has(o.id)) {
      pend.get(o.id)(o);
      pend.delete(o.id);
    }
  });
  const send = (method, params, sessionId) =>
    new Promise((res) => {
      const i = ++id;
      // ⚠️ 必须有超时。真窗口模式下 Input.dispatchMouseEvent 偶发不回响应，
      // 没有超时的话 Promise 永远挂着，整个脚本静默卡死（实测卡了 3 分钟无输出，
      // 而正常一轮只要 40 秒）。超时后返回一个带 error 的对象，让调用方自己判断。
      const timer = setTimeout(() => {
        if (pend.has(i)) {
          pend.delete(i);
          res({ error: { message: 'cdp-timeout: ' + method } });
        }
      }, 15000);
      pend.set(i, (o) => {
        clearTimeout(timer);
        res(o);
      });
      ws.send(JSON.stringify({ id: i, method, params: params || {}, sessionId }));
    });

  const {
    result: { targetId },
  } = await send('Target.createTarget', { url: 'about:blank' });
  const {
    result: { sessionId: sid },
  } = await send('Target.attachToTarget', { targetId, flatten: true });

  await send('Page.enable', {}, sid);
  await send('Runtime.enable', {}, sid);
  await send('Performance.enable', {}, sid);
  await send(
    'Emulation.setEmulatedMedia',
    { features: [{ name: 'prefers-color-scheme', value: 'dark' }] },
    sid
  );

  if (REAL) {
    const { result: win } = await send('Browser.getWindowForTarget', { targetId });
    await send('Browser.setWindowBounds', {
      windowId: win.windowId,
      bounds: { windowState: 'normal', width: 1440, height: 900 },
    });
    await send('Page.bringToFront', {}, sid);
  }

  async function evalJs(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid);
    if (r.result && r.result.exceptionDetails) {
      throw new Error(r.result.exceptionDetails.text + ' :: ' + expr.slice(0, 100));
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  }

  async function metrics() {
    // 页面导航后 Performance 域可能被重置，getMetrics 会返回 error 而不是 result。
    // 这里重试一次并重新 enable，避免整个 A/B 跑到第二个变体就崩。
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await send('Performance.getMetrics', {}, sid);
      if (r && r.result && r.result.metrics) {
        const o = {};
        for (const m of r.result.metrics) o[m.name] = m.value;
        return o;
      }
      await send('Performance.enable', {}, sid);
      await sleep(120);
    }
    throw new Error('Performance.getMetrics 连续两次没有返回指标');
  }

  /* 一次鼠标横扫：CDP 真实派发 Input 事件，走的是和用户一样的那条路径 */
  async function sweep(rect, steps) {
    const y0 = rect.top + rect.height * 0.5;
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1);
      const x = rect.left + 40 + (rect.width - 80) * t;
      const y = y0 + Math.sin(t * Math.PI * 3) * rect.height * 0.28;
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }, sid);
      await sleep(16);
    }
  }

  const results = [];

  for (const v of VARIANTS) {
    // 每个变体都重新加载页面 —— 只换噪点处理方式，其他条件必须完全一致
    await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' }, sid);
    await sleep(2600);
    // 导航后模拟媒体特性会失效，重新压一遍，保证三个变体的主题完全一致
    await send(
      'Emulation.setEmulatedMedia',
      { features: [{ name: 'prefers-color-scheme', value: 'dark' }] },
      sid
    );

    if (v.css) {
      await evalJs(`(() => {
        var s = document.createElement('style');
        s.id = '__variant';
        s.textContent = ${JSON.stringify(v.css)};
        document.head.appendChild(s);
        return 1;
      })()`);
      await sleep(320);
    }

    // 统计"当前真的有几层 overlay 噪点"，防止变体没生效却以为生效了
    const probe = await evalJs(`(() => {
      var n = [];
      ['.atmosphere .grain', '.wall-grain'].forEach(function (sel) {
        var el = document.querySelector(sel);
        if (!el) return;
        var cs = getComputedStyle(el);
        if (cs.display === 'none') return;
        n.push({ sel: sel, blend: cs.mixBlendMode, op: cs.opacity });
      });
      return n;
    })()`);

    const box = await evalJs(`(() => {
      var ed = document.querySelector('.chat-editor-content') || document.body;
      var r = ed.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    })()`);

    // 空闲基线：不动，只让 rAF 转 1.2s
    await evalJs(`(() => {
      window.__p = { frames: [], longs: [], stop: false };
      try {
        new PerformanceObserver(function (l) {
          for (var i = 0; i < l.getEntries().length; i++) window.__p.longs.push(Math.round(l.getEntries()[i].duration));
        }).observe({ entryTypes: ['longtask'] });
      } catch (e) {}
      (function tick(ts) {
        if (window.__p.stop) return;
        window.__p.frames.push(ts);
        requestAnimationFrame(tick);
      })();
      return 1;
    })()`);
    const m0 = await metrics();
    await sleep(1200);
    const m1 = await metrics();
    const idle = await evalJs('({n: window.__p.frames.length})');

    // 横扫阶段
    await evalJs('window.__p.frames = []; window.__p.longs = []; 1');
    const m2 = await metrics();
    await sweep(box, 60);
    await sleep(260);
    const m3 = await metrics();
    const sw = await evalJs('({frames: window.__p.frames, longs: window.__p.longs})');
    await evalJs('window.__p.stop = true; 1');

    const stat = (frames, ms) => {
      const gaps = [];
      for (let k = 1; k < frames.length; k++) gaps.push(frames[k] - frames[k - 1]);
      gaps.sort((a, b) => a - b);
      const pick = (p) => (gaps.length ? Math.round(gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))]) : 0);
      return {
        fps: +(frames.length / (ms / 1000)).toFixed(1),
        p50: pick(0.5),
        p95: pick(0.95),
        max: gaps.length ? Math.round(gaps[gaps.length - 1]) : 0,
        dropped: gaps.filter((g) => g > 32).length,
      };
    };

    const row = {
      key: v.key,
      label: v.label,
      overlayLayers: probe,
      idleFrames: idle.n,
      sweep: stat(sw.frames, 60 * 16 + 260),
      longTasks: sw.longs.length,
      longTaskMs: sw.longs.reduce((a, b) => a + b, 0),
      recalc: Math.round(m3.RecalcStyleCount - m2.RecalcStyleCount),
      layout: Math.round(m3.LayoutCount - m2.LayoutCount),
      recalcMsIdle: +((m1.RecalcStyleDuration - m0.RecalcStyleDuration) * 1000).toFixed(1),
    };
    results.push(row);

    console.log(
      `  ${row.key} ${v.label}\n` +
        `      overlay 层: ${JSON.stringify(row.overlayLayers)}\n` +
        `      横扫 fps=${row.sweep.fps} p50=${row.sweep.p50}ms p95=${row.sweep.p95}ms max=${row.sweep.max}ms 掉帧=${row.sweep.dropped}\n` +
        `      长任务 ${row.longTasks} 条 / ${row.longTaskMs}ms  recalc=${row.recalc}  layout=${row.layout}`
    );
  }

  /* ---- 汇总结论 ---- */
  const A = results.find((r) => r.key === 'A');
  const STEPS = 60;

  console.log('\n' + '='.repeat(60));
  // ⚠️ 无头模式下 rAF 不受 vsync 约束，实测能跑到 200fps 以上。
  //    这种情况下"帧间隔"反映的是无限刷新的速度，而不是用户看到的流畅度 ——
  //    用户屏幕被钉在 60Hz，任何超出的帧都被丢弃。所以无头数据只能看趋势，
  //    要下结论必须加 real 参数用真窗口（真 GPU + 真 vsync）跑一遍。
  if (!REAL && A.sweep.fps > 90) {
    console.log('  ⚠️  无头环境 rAF 未受 vsync 约束（实测 ' + A.sweep.fps + ' fps），');
    console.log('     绝对帧时间不可用于判定卡顿。请用 node _perf_grain.js real 复验。');
    console.log('');
  }
  console.log('  横扫阶段对比（相对 A 基线的 p95 改善）');
  console.log('  变体  p95     掉帧  长任务   实测 fps   说明');
  for (const r of results) {
    const d = r.key === 'A' ? '基线' : '−' + (A.sweep.p95 - r.sweep.p95) + 'ms';
    console.log(
      '   ' + r.key + '   ' + String(r.sweep.p95).padStart(3) + 'ms  ' +
        String(r.sweep.dropped).padStart(3) + '   ' +
        String(r.longTaskMs + 'ms/' + r.longTasks).padStart(7) + '  ' +
        String(r.sweep.fps).padStart(6) + '     ' + d
    );
  }

  const gain = (k) => A.sweep.p95 - (results.find((r) => r.key === k) || {}).sweep?.p95 || 0;
  const gB = gain('B'),
    gD = gain('D'),
    gE = gain('E');
  const best = Math.max(gB, gD, gE);

  console.log('');
  if (best < 3) {
    console.log('  结论：这些改动都换不来可测量的改善（最大 ' + best + 'ms）。');
    console.log('        → 不要为了让数字好看去改 CSS，问题在别处。');
  } else {
    const parts = [];
    if (gB >= 3) parts.push('噪点混合模式（−' + gB + 'ms）');
    if (gD >= 3) parts.push('极光无限动画（−' + gD + 'ms）');
    if (gE >= 3) parts.push('合并方案（−' + gE + 'ms）');
    console.log('  结论：有效的是 ' + parts.join('、'));
    console.log('        → 合并方案 E 共省 ' + gE + 'ms（p95 ' + A.sweep.p95 + 'ms → ' + (results.find((r) => r.key === 'E') || {}).sweep?.p95 + 'ms）');
  }
  console.log('='.repeat(60));
  console.log('='.repeat(56));
  console.log('\n详细数据写入 ' + path.basename(OUT));

  fs.writeFileSync(OUT, JSON.stringify({ real: REAL, at: new Date().toISOString(), results }, null, 2));

  try { ws.close(); } catch (e) {}
  try { proc.kill(); } catch (e) {}
  setTimeout(() => process.exit(0), 300);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
