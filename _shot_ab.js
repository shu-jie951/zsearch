/**
 * _shot_ab.js —— 性能优化的视觉代价评估（同一环境出"改前/改后"两张图）
 *
 * 用法: node _shot_ab.js   （需要 5178 上有服务，需要 ws）
 * 产出: _ab_before.png / _ab_after.png / _ab_zoom_before.png / _ab_zoom_after.png
 *
 * 为什么要有这个脚本：
 *   _perf_grain.js 已经实测出「噪点改 normal + 去极光 blur72」能把横扫 p95
 *   从 12ms 降到 5ms（渲染吞吐 225 → 403fps）。但那是拿视觉换性能的方向，
 *   必须先确认画面没有变丑再落地 —— 所以这里在同一页面、同一主题下，
 *   注入优化样式前后各截一张，连局部放大一起出，让人眼来判。
 *
 *   两张图必须在**同一次浏览器会话**里出：换一次会话就换了窗口尺寸、
 *   字体渲染和 GPU 状态，像素级比较会失去意义。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = Number(process.env.PORT || 5178);
// nowall = 关掉壁纸，让极光层完全暴露 —— 这是「去 blur(72px)」唯一可能露馅的场景
const NOWALL = process.argv[2] === 'nowall';
const THEME = process.argv[2] === 'light' ? 'light' : 'dark';
const PREFIX = NOWALL ? '_ab_nowall' : THEME === 'dark' ? '_ab_dark' : '_ab_light';

/* 关掉壁纸：把 root 的 data-wall 置 off 并藏起舞台层，
   让 .atmosphere 的极光/网格/噪点成为唯一背景 —— 等价于用户手动关壁纸后的画面 */
const NOWALL_JS = `(() => {
  document.documentElement.dataset.wall = 'off';
  delete document.documentElement.dataset.wallTone;
  var st = document.querySelector('.wall-stage');
  if (st) st.style.display = 'none';
  document.body.style.backgroundColor = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#0e0e11';
  return 1;
})()`;

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

/* 待验证的优化方案（和 _perf_grain.js 的 E 变体一致） */
const OPT_CSS =
  '.atmosphere .aura{animation:none!important;filter:none!important}' +
  '.atmosphere .grain,.wall-grain{mix-blend-mode:normal!important}';

(async () => {
  const cport = 9800 + Math.floor(Math.random() * 60);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-ab-'));
  const proc = spawn(
    EDGE,
    [
      '--headless=new',
      '--no-first-run',
      '--hide-scrollbars',
      '--remote-debugging-port=' + cport,
      '--user-data-dir=' + prof,
      '--window-size=1440,900',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

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
      const timer = setTimeout(() => {
        if (pend.has(i)) {
          pend.delete(i);
          res({ error: { message: 'cdp-timeout: ' + method } });
        }
      }, 20000);
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
  // 主题必须显式压，无头 Edge 会继承系统暗色偏好
  await send(
    'Emulation.setEmulatedMedia',
    { features: [{ name: 'prefers-color-scheme', value: THEME }] },
    sid
  );

  async function evalJs(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid);
    if (r.result && r.result.exceptionDetails) {
      throw new Error(r.result.exceptionDetails.text + ' :: ' + expr.slice(0, 90));
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  }

  async function shot(file, clip) {
    const p = { format: 'png', captureBeyondViewport: false };
    if (clip) p.clip = { ...clip, scale: 2 }; // scale 2 = 局部 2 倍放大，看噪点和光晕
    const r = await send('Page.captureScreenshot', p, sid);
    if (!r.result || !r.result.data) throw new Error('截图失败: ' + JSON.stringify(r).slice(0, 120));
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    console.log('  → ' + file);
  }

  await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' }, sid);
  await sleep(2800);
  // 导航后媒体特性会失效，补压一次
  await send(
    'Emulation.setEmulatedMedia',
    { features: [{ name: 'prefers-color-scheme', value: THEME }] },
    sid
  );
  await sleep(400);

  if (NOWALL) {
    await evalJs(NOWALL_JS);
    await sleep(700);
    console.log('  （已关闭壁纸，极光层完全暴露）');
  }

  // 局部放大区域：编辑区上半部（柔光 + 噪点 + 光晕都在这里）
  const box = await evalJs(`(() => {
    var ed = document.querySelector('.chat-editor-content');
    if (!ed) return { x: 240, y: 240, width: 700, height: 300 };
    var r = ed.getBoundingClientRect();
    return { x: Math.round(r.left - 30), y: Math.round(r.top - 24), width: Math.round(r.width + 60), height: Math.round(r.height * 0.62) };
  })()`);

  console.log('[' + THEME + '] 采集改前');
  await shot(PREFIX + '_before.png');
  await shot(PREFIX + '_zoom_before.png', box);

  await evalJs(`(() => {
    var s = document.createElement('style');
    s.id = '__opt';
    s.textContent = ${JSON.stringify(OPT_CSS)};
    document.head.appendChild(s);
    return 1;
  })()`);
  await sleep(600);

  console.log('[' + THEME + '] 采集改后');
  await shot(PREFIX + '_after.png');
  await shot(PREFIX + '_zoom_after.png', box);

  // 顺手把两态的关键计算样式读出来，作为"确实变了/没变"的文字证据
  const styles = await evalJs(`(() => {
    var a = document.querySelector('.atmosphere .aura');
    var g1 = document.querySelector('.atmosphere .grain');
    var g2 = document.querySelector('.wall-grain');
    var cs = function (el) { return el ? getComputedStyle(el) : null; };
    return {
      aura: a ? { filter: cs(a).filter, animation: cs(a).animationName, wc: cs(a).willChange } : null,
      grain: g1 ? { blend: cs(g1).mixBlendMode, op: cs(g1).opacity } : null,
      wallGrain: g2 ? { blend: cs(g2).mixBlendMode, op: cs(g2).opacity } : null,
    };
  })()`);
  console.log('  改后计算样式: ' + JSON.stringify(styles));

  try { ws.close(); } catch (e) {}
  try { proc.kill(); } catch (e) {}
  setTimeout(() => process.exit(0), 250);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
