/**
 * 壁纸切换性能实测。
 * 用法: node _perf_wall.js [before|after]
 *
 * 只测「切换那一瞬间」的开销，因为这个动作同时触发了四件事：
 *   1. 两个全屏层做 opacity 交叉淡入
 *   2. 每层都带 filter: blur() saturate() brightness()，且 tone 变化会改这些值
 *   3. tone 一变，整套 CSS 变量翻牌 → 全文档重绘 + 重排
 *   4. 页面上挂了若干 backdrop-filter，背景一动它们就要重新采样
 *
 * 输出三类硬指标：
 *   - 帧间隔 p50/p95/max、掉帧数（>32ms 即掉一帧以上）
 *   - 长任务（longtask）总时长与条数
 *   - 主线程 Layout / RecalcStyle 次数与耗时（用 CDP Performance 域取差值）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 5178;
const TAG = process.argv[2] || 'run';
// 第二个参数给 real 就用真实窗口跑（走真 GPU）。
// 无头模式在这台机器上被 SwiftShader 卡在 ~45fps，基线本身就跑不满 60，
// 量出来的 p50 全是环境噪音，看不出 GPU 侧的真实改善。
const REAL = process.argv[3] === 'real';
const OUT = path.join(__dirname, '_perf_wall_' + TAG + '.json');

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

(async () => {
  const cport = 9800 + Math.floor(Math.random() * 60);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-perf-'));
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
    console.error('edge did not start');
    proc.kill();
    process.exit(1);
  }
  console.log('browser:', ver.Browser);

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
      pend.set(i, res);
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
    { features: [{ name: 'prefers-color-scheme', value: 'light' }] },
    sid
  );

  if (REAL) {
    // 用真实窗口尺寸，不要用 Emulation.setDeviceMetricsOverride 造虚拟视口：
    // 那样 getBoundingClientRect 与合成器坐标系会分叉，量出来的帧时间不可信。
    const { result: win } = await send('Browser.getWindowForTarget', { targetId });
    await send('Browser.setWindowBounds', {
      windowId: win.windowId,
      bounds: { windowState: 'normal', width: 1440, height: 900 },
    });
    await send('Page.bringToFront', {}, sid);
  }

  async function evalJs(expr) {
    const r = await send(
      'Runtime.evaluate',
      { expression: expr, returnByValue: true, awaitPromise: true },
      sid
    );
    if (r.result && r.result.exceptionDetails) {
      throw new Error(r.result.exceptionDetails.text + ' :: ' + expr.slice(0, 120));
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  }

  async function metrics() {
    const r = await send('Performance.getMetrics', {}, sid);
    const o = {};
    for (const m of r.result.metrics) o[m.name] = m.value;
    return o;
  }

  await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' }, sid);
  await sleep(3200);

  /* ---- 静态盘点：谁在花钱 ---- */
  const budget = await evalJs(`(() => {
    const bd = [];
    document.querySelectorAll('*').forEach(el => {
      const cs = getComputedStyle(el);
      const v = cs.backdropFilter || cs.webkitBackdropFilter;
      if (v && v !== 'none') bd.push((el.className && String(el.className).split(' ')[0]) || el.tagName);
    });
    const layers = [...document.querySelectorAll('.wall-layer')].map(el => {
      const cs = getComputedStyle(el);
      return { filter: cs.filter, transform: cs.transform, willChange: cs.willChange };
    });
    return {
      backdropFilterCount: bd.length,
      backdropFilterOn: bd,
      wallLayers: layers,
      bodyTransition: getComputedStyle(document.body).transition,
      htmlTransition: getComputedStyle(document.documentElement).transition,
      veilTransition: (() => { const v = document.querySelector('.wall-veil'); return v ? getComputedStyle(v).transition : ''; })(),
      docHeight: document.documentElement.scrollHeight
    };
  })()`);

  /* ---- 装探针：帧间隔 + 长任务 ---- */
  await evalJs(`(() => {
    window.__perf = { frames: [], longs: [], t0: 0 };
    window.__perfStop = false;
    const tick = (ts) => {
      if (window.__perfStop) return;
      window.__perf.frames.push(ts);
      requestAnimationFrame(tick);
    };
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) window.__perf.longs.push(Math.round(e.duration));
      }).observe({ entryTypes: ['longtask'] });
    } catch (e) {}
    requestAnimationFrame(tick);
    return 1;
  })()`);

  /* ---- 三次连续切换，每次采 1.6s ---- */
  const runs = [];

  // 基线：什么都不做，只让 rAF 空转 1.6s。
  // 没有这条基线，所有帧间隔数字都无法解读 —— 无头 SwiftShader 本身就跑不满 60fps。
  await evalJs('window.__perf.frames = []; window.__perf.longs = []; 1');
  {
    const m0 = await metrics();
    await sleep(1600);
    const m1 = await metrics();
    const raw = await evalJs('({frames: window.__perf.frames, longs: window.__perf.longs})');
    const f = raw.frames;
    const gaps = [];
    for (let k = 1; k < f.length; k++) gaps.push(f[k] - f[k - 1]);
    gaps.sort((a, b) => a - b);
    const pick = (p) => (gaps.length ? Math.round(gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))]) : 0);
    runs.push({
      to: 'IDLE(基线)',
      wallMs: 1600,
      frames: f.length,
      p50: pick(0.5),
      p95: pick(0.95),
      max: gaps.length ? Math.round(gaps[gaps.length - 1]) : 0,
      dropped: gaps.filter((g) => g > 32).length,
      longTasks: raw.longs.length,
      longTaskMs: raw.longs.reduce((a, b) => a + b, 0),
      layoutCount: Math.round(m1.LayoutCount - m0.LayoutCount),
      recalcCount: Math.round(m1.RecalcStyleCount - m0.RecalcStyleCount),
      layoutMs: +((m1.LayoutDuration - m0.LayoutDuration) * 1000).toFixed(1),
      recalcMs: +((m1.RecalcStyleDuration - m0.RecalcStyleDuration) * 1000).toFixed(1),
      taskMs: +((m1.TaskDuration - m0.TaskDuration) * 1000).toFixed(1),
    });
  }

  const seq = ['w07', 'w02', 'w09'];
  for (let i = 0; i < seq.length; i++) {
    await evalJs('window.__perf.frames = []; window.__perf.longs = []; 1');
    const m0 = await metrics();
    const t0 = Date.now();
    await evalJs(`window.ZSearchWall.set('${seq[i]}'); 1`);
    await sleep(1600);
    const m1 = await metrics();

    const raw = await evalJs('({frames: window.__perf.frames, longs: window.__perf.longs})');
    const f = raw.frames;
    const gaps = [];
    for (let k = 1; k < f.length; k++) gaps.push(f[k] - f[k - 1]);
    gaps.sort((a, b) => a - b);
    const pick = (p) => (gaps.length ? Math.round(gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))]) : 0);

    runs.push({
      to: seq[i],
      wallMs: Date.now() - t0,
      frames: f.length,
      p50: pick(0.5),
      p95: pick(0.95),
      max: gaps.length ? Math.round(gaps[gaps.length - 1]) : 0,
      // 掉帧：单帧间隔超过 32ms 就当至少少画了一帧（60Hz 下 16.7ms 一帧）
      dropped: gaps.filter((g) => g > 32).length,
      longTasks: raw.longs.length,
      longTaskMs: raw.longs.reduce((a, b) => a + b, 0),
      layoutCount: Math.round(m1.LayoutCount - m0.LayoutCount),
      recalcCount: Math.round(m1.RecalcStyleCount - m0.RecalcStyleCount),
      layoutMs: +((m1.LayoutDuration - m0.LayoutDuration) * 1000).toFixed(1),
      recalcMs: +((m1.RecalcStyleDuration - m0.RecalcStyleDuration) * 1000).toFixed(1),
      taskMs: +((m1.TaskDuration - m0.TaskDuration) * 1000).toFixed(1),
    });
  }

  // 基线单独拿出来作为参照系，均值只统计真实切换
  const real = runs.slice(1);
  const avg = (k) => Math.round(real.reduce((a, r) => a + r[k], 0) / real.length);

  const report = {
    tag: TAG,
    budget,
    idle: runs[0],
    runs: real,
    summary: {
      p50: avg('p50'),
      p95: avg('p95'),
      max: Math.max(...real.map((r) => r.max)),
      dropped: avg('dropped'),
      longTasks: avg('longTasks'),
      longTaskMs: avg('longTaskMs'),
      layoutCount: avg('layoutCount'),
      recalcCount: avg('recalcCount'),
      layoutMs: +((real.reduce((a, r) => a + r.layoutMs, 0) / real.length).toFixed(1)),
      recalcMs: +((real.reduce((a, r) => a + r.recalcMs, 0) / real.length).toFixed(1)),
      taskMs: +((real.reduce((a, r) => a + r.taskMs, 0) / real.length).toFixed(1)),
    },
  };

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

  console.log('\n===== 静态盘点 =====');
  console.log('backdrop-filter 元素数:', budget.backdropFilterCount);
  console.log('  ->', budget.backdropFilterOn.join(', '));
  console.log('壁纸层 filter:', budget.wallLayers.map((l) => l.filter).join(' | '));
  console.log('壁纸层 transform:', budget.wallLayers.map((l) => l.transform).join(' | '));
  console.log('body transition:', budget.bodyTransition);
  console.log('html transition:', budget.htmlTransition);
  console.log('veil transition:', budget.veilTransition);

  console.log('\n===== 每次切换 =====');
  for (const r of runs) {
    console.log(
      `→ ${r.to}  帧${r.frames} p50=${r.p50}ms p95=${r.p95}ms max=${r.max}ms ` +
        `掉帧=${r.dropped} 长任务=${r.longTasks}(${r.longTaskMs}ms) ` +
        `Layout=${r.layoutCount}/${r.layoutMs}ms 重算样式=${r.recalcCount}/${r.recalcMs}ms 主线程=${r.taskMs}ms`
    );
  }

  console.log('\n===== 均值（' + TAG + '） =====');
  console.log(JSON.stringify(report.summary, null, 2));
  console.log('\n写入 ' + OUT);

  ws.close();
  try {
    proc.kill();
  } catch (e) {}
  // 真实窗口模式下 kill 主进程可能留下子进程，补一刀让浏览器自己退出
  if (REAL) {
    try {
      const p = spawn('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore' });
      p.unref();
    } catch (e) {}
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
