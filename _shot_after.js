/**
 * 出「优化后」成品图（存 docs/assets/，供文档引用）。
 * 用法: node _shot_after.js
 *
 * 与普通截图脚本的差别：
 *   1. 2x 像素密度 → 图上文字/边缘可读，不会被缩略图抹平；
 *   2. 先把指针移到指定位置再截，光斑才会出现在画面里；
 *   3. 结果页必须**真的等到结果渲染**才截，否则截到的是空态。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 5178;
const OUT = path.join('docs', 'assets');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(d)); }).on('error', rej);
});

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const cport = 9980 + Math.floor(Math.random() * 40);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-after-'));
  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
    '--remote-debugging-port=' + cport, '--user-data-dir=' + prof,
    '--window-size=1440,900', 'about:blank',
  ], { stdio: 'ignore' });

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
  ws.on('message', (m) => { const o = JSON.parse(m); if (o.id && pend.has(o.id)) { pend.get(o.id)(o); pend.delete(o.id); } });
  const send = (m2, p, s) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m2, params: p || {}, sessionId: s })); });

  const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
  const { result: { sessionId: sid } } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sid);
  await send('Runtime.enable', {}, sid);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, sid);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false }, sid);

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid);
    if (r.result && r.result.exceptionDetails) {
      const d = r.result.exceptionDetails;
      return { error: (d.exception && d.exception.description) || d.text };
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sid);
    const p = path.join(OUT, name);
    fs.writeFileSync(p, Buffer.from(s.result.data, 'base64'));
    console.log('wrote ' + p);
  };
  const move = (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 }, sid);

  /* ---------- 首页 ---------- */
  await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' }, sid);
  await sleep(2600);
  await evalJs("window.ZSearchWall && window.ZSearchWall.set('w07')");
  await sleep(1900);
  // 指针停在左下偏中，光斑落在花枝亮部，最能看出"光在动"
  await move(520, 620);
  await sleep(900);
  await shot('after-home.png');

  /* ---------- 结果页 ---------- */
  await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/search?q=' + encodeURIComponent('考研') }, sid);

  // 轮询等结果真的渲染出来（上游不稳，最多等 40s）
  let n = 0;
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    n = (await evalJs("document.querySelectorAll('.result-item').length")) || 0;
    if (n > 0) break;
  }
  console.log('结果条数: ' + n);
  if (n > 0) {
    await sleep(1200);
    await move(980, 560);
    await sleep(800);
    await shot('after-results.png');
  } else {
    console.log('上游无结果，跳过结果页出图');
  }

  ws.close(); proc.kill();
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
})().catch((e) => { console.error(e); process.exit(1); });
