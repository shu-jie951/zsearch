/** 抽屉定位诊断：查 computed transform 与命中规则 */
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
    http.get(u, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(d)); }).on('error', rej);
  });

(async () => {
  const cport = 9750 + Math.floor(Math.random() * 40);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-diag-'));
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--remote-debugging-port=' + cport, '--user-data-dir=' + prof,
    '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });

  let ver = null;
  for (let i = 0; i < 60; i++) {
    try { ver = JSON.parse(await get('http://127.0.0.1:' + cport + '/json/version')); break; }
    catch (e) { await sleep(250); }
  }
  const WebSocket = require('ws');
  const ws = new WebSocket(ver.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r) => ws.on('open', r));
  let id = 0; const pend = new Map();
  ws.on('message', (m) => { const o = JSON.parse(m); if (o.id && pend.has(o.id)) { pend.get(o.id)(o); pend.delete(o.id); } });
  const send = (method, params, sessionId) => new Promise((res) => {
    const i = ++id; pend.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params: params || {}, sessionId }));
  });

  const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
  const { result: { sessionId: sid } } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sid);
  await send('Runtime.enable', {}, sid);

  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sid);
    return r.result && r.result.result ? r.result.result.value : r;
  };

  await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' }, sid);
  await sleep(2600);
  await ev('window.ZSearchWall && window.ZSearchWall.open()');
  await sleep(1200);

  const out = await ev(`(() => {
    const d = document.querySelector('.wall-drawer');
    if (!d) return '抽屉不存在';
    const cs = getComputedStyle(d);
    const r = d.getBoundingClientRect();
    // 找出所有命中该元素的 CSS 规则里带 transform 的
    const hits = [];
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch (e) { continue; }
      for (const rule of rules) {
        if (rule.type === 1 && rule.selectorText && rule.style && rule.style.transform) {
          try { if (d.matches(rule.selectorText)) hits.push(rule.selectorText + ' { transform: ' + rule.style.transform + ' }'); } catch (e) {}
        }
        if (rule.type === 4) { // @media
          for (const inner of rule.cssRules) {
            if (inner.type === 1 && inner.style && inner.style.transform) {
              try { if (d.matches(inner.selectorText)) hits.push('@media ' + rule.conditionText + ' -> ' + inner.selectorText + ' { transform: ' + inner.style.transform + ' }'); } catch (e) {}
            }
          }
        }
      }
    }
    return {
      className: d.className,
      computedTransform: cs.transform,
      computedVisibility: cs.visibility,
      computedRight: cs.right,
      computedWidth: cs.width,
      rect: { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) },
      innerWidth: window.innerWidth,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      matchedTransformRules: hits
    };
  })()`);

  console.log(JSON.stringify(out, null, 2));
  ws.close(); proc.kill();
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
})().catch((e) => { console.error(e); process.exit(1); });
