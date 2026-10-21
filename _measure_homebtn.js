/** 测量搜索框与首页按钮的几何关系 */
const fs = require('fs'); const os = require('os'); const path = require('path');
const http = require('http'); const { spawn } = require('child_process');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(d)); }).on('error', rej);
});
(async () => {
  const cport = 9800 + Math.floor(Math.random() * 40);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'zsm-'));
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--remote-debugging-port=' + cport, '--user-data-dir=' + prof, '--window-size=1920,1000', 'about:blank'], { stdio: 'ignore' });
  let ver = null;
  for (let i = 0; i < 60; i++) {
    try { ver = JSON.parse(await get('http://127.0.0.1:' + cport + '/json/version')); break; }
    catch (e) { await sleep(250); }
  }
  const WS = require('ws');
  const ws = new WS(ver.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r) => ws.on('open', r));
  let id = 0; const pend = new Map();
  ws.on('message', (m) => { const o = JSON.parse(m); if (o.id && pend.has(o.id)) { pend.get(o.id)(o); pend.delete(o.id); } });
  const send = (m, p, s) => new Promise((res) => {
    const i = ++id; pend.set(i, res);
    ws.send(JSON.stringify({ id: i, method: m, params: p || {}, sessionId: s }));
  });
  const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
  const { result: { sessionId: sid } } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sid); await send('Runtime.enable', {}, sid);
  await send('Page.navigate', { url: 'http://127.0.0.1:5178/search?q=考研' }, sid);
  await sleep(3000);
  const expr = [
    '(() => {',
    '  const g = (s) => { const e = document.querySelector(s); if (!e) return null;',
    '    const r = e.getBoundingClientRect();',
    '    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };',
    '  return { composer: g(".results-ai-composer"), homeBtn: g(".header-home-btn"),',
    '    sendBtn: g(".results-send-btn"), header: g(".results-header") };',
    '})()',
  ].join('\n');
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }, sid);
  console.log(JSON.stringify(r.result.result.value, null, 1));
  ws.close(); proc.kill();
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
})().catch((e) => { console.error(e); process.exit(1); });
