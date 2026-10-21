/**
 * Screenshot the brand mark regions of both pages, light + dark, via Edge CDP.
 *
 * Uses the real window (Browser.setWindowBounds) rather than a device-metrics
 * override: an emulated viewport makes getBoundingClientRect disagree with the
 * compositor, which shifts fixed-position elements in the capture and misleads
 * any layout judgement.
 *
 * Usage: node _shot_brand.js <outdir> [WxH]
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://127.0.0.1:5178';
const OUT = process.argv[2] || '_logo_out';
// Optional WxH. Without it headless Edge uses its default 750x485, which is too
// small to double as a README screenshot.
const SIZE = (process.argv[3] || '').match(/^(\d+)x(\d+)$/);

function get(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => res(d));
    }).on('error', rej);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const port = 9330 + Math.floor(Math.random() * 90);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'zsshot-'));
  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
    '--remote-debugging-port=' + port, '--user-data-dir=' + prof,
    ...(SIZE ? ['--window-size=' + SIZE[1] + ',' + SIZE[2]] : []),
    'about:blank',
  ], { stdio: 'ignore' });

  // wait for the debugging endpoint
  let ver = null;
  for (let i = 0; i < 60; i++) {
    try { ver = JSON.parse(await get('http://127.0.0.1:' + port + '/json/version')); break; }
    catch (e) { await sleep(250); }
  }
  if (!ver) { console.error('edge did not come up'); proc.kill(); process.exit(1); }

  const WebSocket = require('ws');
  const ws = new WebSocket(ver.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r) => ws.on('open', r));

  let id = 0;
  const pending = new Map();
  ws.on('message', (m) => {
    const msg = JSON.parse(m);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  function send(method, params, sessionId) {
    return new Promise((res) => {
      const mid = ++id;
      pending.set(mid, res);
      ws.send(JSON.stringify({ id: mid, method, params: params || {}, sessionId }));
    });
  }

  const targets = [
    { name: 'home', url: BASE + '/' },
    { name: 'search', url: BASE + '/search?q=%E7%94%B5%E5%BD%B1' },
  ];

  for (const t of targets) {
    const created = await send('Target.createTarget', { url: 'about:blank' });
    const targetId = created.result.targetId;
    const attached = await send('Target.attachToTarget', { targetId, flatten: true });
    const sid = attached.result.sessionId;

    for (const theme of ['light', 'dark']) {
      await send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: theme }],
      }, sid);
      await send('Page.enable', {}, sid);
      await send('Page.navigate', { url: t.url }, sid);
      await sleep(2600);

      // Report the brand mark's real box so the crop is measured, not guessed.
      const box = await send('Runtime.evaluate', {
        expression: `(() => {
          const a = document.querySelector('.brand-mark') || document.querySelector('.results-logo');
          if (!a) return JSON.stringify({ err: 'no brand element' });
          const r = a.getBoundingClientRect();
          const s = a.querySelector('svg');
          const sr = s ? s.getBoundingClientRect() : null;
          const doc = document.documentElement;
          return JSON.stringify({
            link: [r.x, r.y, r.width, r.height],
            svg: sr ? [sr.x, sr.y, sr.width, sr.height] : null,
            vb: s ? s.getAttribute('viewBox') : null,
            scrollY: window.scrollY,
            docH: doc.scrollHeight,
            overflowX: doc.scrollWidth > doc.clientWidth,
            bg: getComputedStyle(document.body).backgroundColor,
          });
        })()`, returnByValue: true,
      }, sid);
      console.log(t.name, theme, box.result && box.result.result
        ? box.result.result.value : JSON.stringify(box.result));

      const shot = await send('Page.captureScreenshot', {
        format: 'png', captureBeyondViewport: false,
      }, sid);
      const buf = Buffer.from(shot.result.data, 'base64');
      fs.writeFileSync(path.join(OUT, `brand-${t.name}-${theme}.png`), buf);

      // Crop tightly around the mark, 3x, for a legibility read.
      try {
        const info = JSON.parse(box.result.result.value);
        if (info.svg) {
          const [sx, sy, sw, sh] = info.svg;
          const pad = 16;
          const crop = await send('Page.captureScreenshot', {
            format: 'png', captureBeyondViewport: false,
            clip: { x: Math.max(0, sx - pad), y: Math.max(0, sy - pad),
                    width: sw + pad * 2, height: sh + pad * 2, scale: 3 },
          }, sid);
          fs.writeFileSync(path.join(OUT, `cropped-${t.name}-${theme}.png`),
            Buffer.from(crop.result.data, 'base64'));
        }
      } catch (e) { console.error('crop failed', e.message); }
    }
    await send('Target.closeTarget', { targetId });
  }

  ws.close();
  proc.kill();
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
  console.log('done');
}

main().catch((e) => { console.error(e); process.exit(1); });
