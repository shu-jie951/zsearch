/**
 * HTML -> PNG via Edge CDP, capturing the FULL page (not just the viewport).
 *
 * captureBeyondViewport must be false: with it true the whole-page image comes
 * back squashed and unreadable. So instead the window is resized to the page's
 * real height via Browser.setWindowBounds, and the viewport is captured.
 *
 * Usage: node _shotfull.js <html> <out.png> [width]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const [html, out, widthArg] = process.argv.slice(2);
const W = parseInt(widthArg || '1280', 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(d)); })
    .on('error', rej);
});

(async () => {
  const port = 9520 + Math.floor(Math.random() * 60);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'zsfs-'));
  const url = 'file:///' + path.resolve(html).replace(/\\/g, '/');
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--hide-scrollbars', '--remote-debugging-port=' + port, '--user-data-dir=' + prof,
    '--window-size=' + W + ',900', 'about:blank'], { stdio: 'ignore' });

  let ver = null;
  for (let i = 0; i < 60; i++) {
    try { ver = JSON.parse(await get('http://127.0.0.1:' + port + '/json/version')); break; }
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

  const logs = [];
  ws.on('message', (m) => {
    const o = JSON.parse(m);
    if (o.method === 'Runtime.exceptionThrown') {
      const d = o.params.exceptionDetails;
      const desc = (d.exception && (d.exception.description || d.exception.value)) || d.text;
      logs.push('EXC line ' + d.lineNumber + ':' + d.columnNumber + '  ' + desc);
    }
    if (o.method === 'Runtime.consoleAPICalled' && o.params.type === 'error') {
      logs.push('ERR ' + JSON.stringify(o.params.args.map((a) => a.value || a.description)));
    }
  });

  await send('Page.navigate', { url }, sid);
  await sleep(1800);

  // documentElement.scrollHeight is at least the viewport height, so on a tall
  // window it reports the window rather than the content and the PNG ends up
  // mostly empty. Measure the real content instead: the furthest bottom edge of
  // any body child.
  const contentH = async () => (await send('Runtime.evaluate', {
    expression: `(() => {
      let m = 0;
      for (const c of document.body.children) {
        const r = c.getBoundingClientRect();
        if (r.height) m = Math.max(m, r.bottom + window.scrollY);
      }
      return Math.ceil(m + 6);
    })()`, returnByValue: true,
  }, sid)).result.result.value;
  const viewportH = async () => (await send('Runtime.evaluate', {
    expression: 'window.innerHeight', returnByValue: true,
  }, sid)).result.result.value;
  const { result: win } = await send('Browser.getWindowForTarget', { targetId });
  const setBounds = (hAt) => send('Browser.setWindowBounds', {
    windowId: win.windowId,
    bounds: { windowState: 'normal', width: W, height: Math.min(hAt, 4000) },
  });

  let h = await contentH();
  // +120 covers the window chrome (measured ~95px here), which is not part of
  // the viewport capture.
  await setBounds(h + 120);
  await sleep(800);

  const vh = await viewportH();
  if (vh < h) {
    const zoom = Math.max(0.15, (vh - 6) / h);
    console.log('note: board ' + h + 'px, viewport ' + vh + 'px -- rendering at '
      + (zoom * 100).toFixed(1) + '%');
    await send('Runtime.evaluate', {
      expression: 'document.documentElement.style.zoom=' + zoom.toFixed(4),
    }, sid);
    await sleep(500);
    h = await contentH();
  } else {
    console.log('board ' + h + 'px, viewport ' + vh + 'px');
  }
  await sleep(300);

  const shot = await send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: false,
  }, sid);
  fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  console.log('wrote ' + out + '  (page height ' + h + ')');
  if (logs.length) console.log(logs.join('\n'));

  ws.close(); proc.kill();
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
})().catch((e) => { console.error(e); process.exit(1); });
