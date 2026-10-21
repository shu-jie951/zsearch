/**
 * 量化测量结果页关键元素的几何位置，确认排版错位。
 * 用法: node _measure_layout.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(d)); })
    .on('error', rej);
});

(async () => {
  const cport = 9720 + Math.floor(Math.random() * 40);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'zsmea-'));
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--remote-debugging-port=' + cport, '--user-data-dir=' + prof,
    '--window-size=1920,1000', 'about:blank'], { stdio: 'ignore' });

  let ver = null;
  for (let i = 0; i < 60; i++) {
    try { ver = JSON.parse(await get('http://127.0.0.1:' + cport + '/json/version')); break; }
    catch (e) { await sleep(250); }
  }
  const WebSocket = require('ws');
  const ws = new WebSocket(ver.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r) => ws.on('open', r));
  let id = 0; const pend = new Map();
  ws.on('message', (m) => {
    const o = JSON.parse(m);
    if (o.id && pend.has(o.id)) { pend.get(o.id)(o); pend.delete(o.id); }
  });
  const send = (method, params, sessionId) => new Promise((res) => {
    const i = ++id; pend.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params: params || {}, sessionId }));
  });
  const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
  const { result: { sessionId: sid } } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sid);
  await send('Runtime.enable', {}, sid);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, sid);

  for (const W of [1920, 1440, 1200, 1000]) {
    const { result: win } = await send('Browser.getWindowForTarget', { targetId });
    await send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'normal', width: W, height: 1000 } });
    await send('Page.navigate', { url: 'http://127.0.0.1:5178/search?q=考研' }, sid);
    await sleep(12000);
    const r = await send('Runtime.evaluate', {
      expression: `(() => {
        const g = (s) => { const e = document.querySelector(s); if (!e) return null;
          const r = e.getBoundingClientRect(); return {x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width)}; };
        return {
          vw: window.innerWidth,
          header: g('.results-header'),
          composer: g('.results-ai-composer'),
          nav: g('.header-nav-wrap'),
          navFirstTab: g('.cloud-tab'),
          main: g('.results-main'),
          firstItem: g('.result-item'),
          stats: g('.results-stats'),
        };
      })()`, returnByValue: true,
    }, sid);
    console.log('=== vw=' + W + ' ===');
    console.log(JSON.stringify(r.result.result.value, null, 1));
  }

  ws.close(); proc.kill();
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
})().catch((e) => { console.error(e); process.exit(1); });
