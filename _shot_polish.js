/**
 * 质感层目视出图：卡片聚光到底好不好看，断言看不出来，只能看图。
 * 用法: node _shot_polish.js  （需要 5178 上有服务，且需要 ws）
 * 产出: _shot_spot_light.png / _shot_spot_dark.png（验完即删，README 不引用）
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
  const cport = 9900 + Math.floor(Math.random() * 60);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-spot-'));
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
    if (o.method === 'Runtime.exceptionThrown') {
      const d = o.params.exceptionDetails;
      errs.push('EXC ' + (d.exception ? d.exception.description : d.text));
    }
  });
  const send = (method, params, sessionId) =>
    new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {}, sessionId })); });

  const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
  const { result: { sessionId: sid } } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sid);
  await send('Runtime.enable', {}, sid);

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

  for (const theme of ['light', 'dark']) {
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] }, sid);
    await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/search?q=' + encodeURIComponent('电影') }, sid);
    await sleep(9000);

    // 手动点亮第 3 张卡，把圆心放在标题右上方 —— 和真实悬停时的位置接近
    const lit = await evalJs(`(() => {
      const rows = Array.from(document.querySelectorAll('#resultList .result-item'));
      rows.forEach(r => r.classList.remove('is-spot'));
      const el = rows[2];
      if (!el) return 'no-card';
      const r = el.getBoundingClientRect();
      el.style.setProperty('--spot-x', Math.round(r.width * 0.55) + 'px');
      el.style.setProperty('--spot-y', Math.round(r.height * 0.4) + 'px');
      el.classList.add('is-spot');
      return { rows: rows.length, h: Math.round(r.height) };
    })()`);
    console.log(theme + ' → ' + JSON.stringify(lit));
    const probe = await evalJs(`(() => ({
      暗色媒体查询成立: window.matchMedia('(prefers-color-scheme: dark)').matches,
      页面背景: getComputedStyle(document.documentElement).backgroundColor,
      卡片背景: (() => { const c = document.querySelector('#resultList .result-item'); return c ? getComputedStyle(c).backgroundColor : null; })(),
      聚光色: getComputedStyle(document.documentElement).getPropertyValue('--spot-color').trim(),
    }))()`);
    console.log('   ' + JSON.stringify(probe));
    await sleep(500);
    await shot('_shot_spot_' + (theme === 'light' ? 'light' : 'dark') + '.png');
  }

  console.log('\n=== 控制台错误 ===');
  console.log(errs.length ? errs.slice(0, 4).join('\n') : '无');

  ws.close();
  proc.kill();
  await sleep(300);
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
})();
