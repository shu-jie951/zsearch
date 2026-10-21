/**
 * 截图首页与结果页（多宽度、亮色），用于排版质检。
 * 用法: node _shot_layout.js [关键词]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 5178;
const KW = process.argv[2] || '考研';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(d)); })
    .on('error', rej);
});

(async () => {
  const cport = 9620 + Math.floor(Math.random() * 40);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'zslay-'));
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--hide-scrollbars', '--remote-debugging-port=' + cport, '--user-data-dir=' + prof,
    '--window-size=1920,1000', 'about:blank'], { stdio: 'ignore' });

  let ver = null;
  for (let i = 0; i < 60; i++) {
    try { ver = JSON.parse(await get('http://127.0.0.1:' + cport + '/json/version')); break; }
    catch (e) { await sleep(250); }
  }
  if (!ver) { console.error('edge did not start'); proc.kill(); process.exit(1); }

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
  // 强制亮色（无头 Edge 继承系统暗色偏好）
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  }, sid);

  async function shot(url, out, W, waitMs) {
    const { result: win } = await send('Browser.getWindowForTarget', { targetId });
    await send('Browser.setWindowBounds', {
      windowId: win.windowId, bounds: { windowState: 'normal', width: W, height: 1000 },
    });
    await send('Page.navigate', { url }, sid);
    await sleep(waitMs);
    const s = await send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: false,
    }, sid);
    fs.writeFileSync(out, Buffer.from(s.result.data, 'base64'));
    console.log('wrote ' + out);
  }

  const kw = encodeURIComponent(KW);
  await shot('http://127.0.0.1:' + PORT + '/', '_lay_home_1920.png', 1920, 2200);
  await shot('http://127.0.0.1:' + PORT + '/search?q=' + kw, '_lay_results_1920.png', 1920, 15000);
  await shot('http://127.0.0.1:' + PORT + '/search?q=' + kw, '_lay_results_1280.png', 1280, 4000);
  await shot('http://127.0.0.1:' + PORT + '/', '_lay_home_400.png', 420, 2200);

  ws.close(); proc.kill();
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
})().catch((e) => { console.error(e); process.exit(1); });
