/**
 * 本轮修复的目视出图：聚焦空态（查叠字）+ 首页壁纸（查清晰度）。
 * 用法: node _shot_fix3.js   （需要 5178 上有服务，且需要 ws）
 * 产出: _fix_focus.png / _fix_home.png（验完即删，README 不引用）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 5178;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (u) =>
  new Promise((res, rej) => {
    http.get(u, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(d)); })
      .on('error', rej);
  });

(async () => {
  const cport = 10100 + Math.floor(Math.random() * 60);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-fixshot-'));
  const proc = spawn(EDGE, [
    '--headless=new', '--no-first-run', '--hide-scrollbars',
    '--remote-debugging-port=' + cport, '--user-data-dir=' + prof,
    '--window-size=1440,900', 'about:blank',
  ], { stdio: 'ignore' });

  let ver = null;
  for (let i = 0; i < 80; i++) {
    try { ver = JSON.parse(await get('http://127.0.0.1:' + cport + '/json/version')); break; }
    catch (e) { await sleep(250); }
  }
  if (!ver) { console.error('edge did not start'); proc.kill(); process.exit(1); }

  const WebSocket = require('ws');
  const ws = new WebSocket(ver.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r) => ws.on('open', r));

  let id = 0; const pend = new Map(); const errs = [];
  ws.on('message', (m) => {
    const o = JSON.parse(m);
    if (o.id && pend.has(o.id)) { pend.get(o.id)(o); pend.delete(o.id); }
    if (o.method === 'Runtime.exceptionThrown') errs.push('EXC');
  });
  const send = (method, params, sessionId) =>
    new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {}, sessionId })); });

  const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
  const { result: { sessionId: sid } } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sid);
  await send('Runtime.enable', {}, sid);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, sid);

  async function evalJs(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid);
    if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
    return r.result && r.result.result ? r.result.result.value : undefined;
  }
  async function shot(out) {
    const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sid);
    fs.writeFileSync(out, Buffer.from(s.result.data, 'base64'));
    console.log('wrote ' + out);
  }

  await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' }, sid);
  await sleep(3200);

  // 1) 首页全貌（看壁纸清晰度）
  await shot('_fix_home.png');

  // 2) 聚焦空态：这就是用户说的"鼠标点击后字体重映"的场景
  await evalJs(`document.querySelector('#searchInput').focus()`);
  await sleep(1400);   // 等打字机敲出一段，两层若有重叠会非常明显
  const st = await evalJs(`(() => {
    const ta = document.querySelector('#searchInput');
    return {
      ghost: (document.querySelector('#ghostOverlay').textContent || '').trim(),
      hasGhost: ta.classList.contains('has-ghost'),
      phColor: getComputedStyle(ta, '::placeholder').color,
      value: ta.value,
    };
  })()`);
  console.log('聚焦空态 → ' + JSON.stringify(st));
  await shot('_fix_focus.png');

  // 3) 点击提示文本补全后（另一个漏过的叠字入口）
  await evalJs(`(() => {
    const sp = document.querySelector('#ghostOverlay .ghost-suffix');
    if (sp) sp.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  })()`);
  await sleep(500);
  const st2 = await evalJs(`(() => {
    const ta = document.querySelector('#searchInput');
    return { ghost: (document.querySelector('#ghostOverlay').textContent || '').trim(), value: ta.value };
  })()`);
  console.log('点击补全后 → ' + JSON.stringify(st2));
  await shot('_fix_clicked.png');

  console.log('\n控制台异常: ' + (errs.length ? errs.length + ' 条' : '无'));
  ws.close();
  proc.kill();
  await sleep(300);
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
})();
