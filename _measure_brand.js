/**
 * Measure the brand lockup's geometry in real SVG user units.
 *
 * getBBox() gives ink boxes in the SVG's own coordinate space, so this is exact
 * -- no eyeballing screenshots for optical alignment. Reports the tile group and
 * the wordmark text separately, plus the shine element's computed box.
 *
 * Usage: node _measure_brand.js
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = 'http://127.0.0.1:5178';

function get(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(d)); })
      .on('error', rej);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROBE = `(() => {
  const root = document.querySelector('.brand-mark') || document.querySelector('.results-logo');
  const svg = root.querySelector('svg');
  const tile = svg.querySelector('g[transform]');
  const texts = [...svg.querySelectorAll('text')];
  const word = texts.find(t => t.textContent.trim() === 'ZSEARCH');
  const zmark = texts.find(t => t.textContent.trim() === 'Z');
  const tb = tile.getBBox();
  const zb = zmark.getBBox();
  const shine = root.querySelector('.brand-shine');
  const sr = shine ? shine.getBoundingClientRect() : null;
  const rr = root.getBoundingClientRect();
  const cs = shine ? getComputedStyle(shine) : null;

  // Advance width is what decides whether the viewBox clips the wordmark --
  // getBBox() for text returns the font's em box, which is not the ink and not
  // the advance either, so it cannot be used for this.
  const wordX = Number(word.querySelector('tspan').getAttribute('x'));
  const advance = word.getComputedTextLength();
  const vb = svg.getAttribute('viewBox').split(/[\\s,]+/).map(Number);

  // Tile placement in the parent coordinate system (getBBox ignores the
  // element's own transform, so read the transform's own numbers out).
  const m = tile.transform.baseVal.consolidate().matrix;

  return JSON.stringify({
    viewBox: vb,
    wordAdvance: +advance.toFixed(2),
    wordX,
    wordRightEdge: +(wordX + advance).toFixed(2),
    slackRight: +(vb[2] - (wordX + advance)).toFixed(2),
    zAdvance: +zmark.getComputedTextLength().toFixed(2),
    zBBoxCentreX: +(zb.x + zb.width / 2).toFixed(2),
    tileInParent: [m.e, m.f, +(128 * m.a).toFixed(2)],
    tileCentreY: +(m.f + 128 * m.a / 2).toFixed(2),
    fontsStatus: document.fonts.status,
    rootBox: [rr.x, rr.y, rr.width, rr.height],
    shineBox: sr ? [sr.x - rr.x, sr.y - rr.y, sr.width, sr.height] : null,
    shineAnim: cs ? cs.animationName + ' ' + cs.animationDuration + ' ' + cs.animationDelay : null,
  });
})()`;

async function main() {
  const port = 9410 + Math.floor(Math.random() * 80);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'zsmeas-'));
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--hide-scrollbars', '--remote-debugging-port=' + port, '--user-data-dir=' + prof,
    'about:blank'], { stdio: 'ignore' });

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
    const msg = JSON.parse(m);
    if (msg.id && pend.has(msg.id)) { pend.get(msg.id)(msg); pend.delete(msg.id); }
  });
  const send = (method, params, sessionId) => new Promise((res) => {
    const mid = ++id; pend.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params: params || {}, sessionId }));
  });

  for (const t of [{ n: 'home', u: BASE + '/' }, { n: 'search', u: BASE + '/search?q=x' }]) {
    const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
    const { result: { sessionId: sid } } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sid);
    await send('Page.navigate', { url: t.u }, sid);
    await sleep(2200);
    const r = await send('Runtime.evaluate', { expression: PROBE, returnByValue: true }, sid);
    console.log('\n== ' + t.n + ' ==');
    const v = r.result && r.result.result && r.result.result.value;
    if (!v) { console.log(JSON.stringify(r.result)); }
    else {
      const o = JSON.parse(v);
      for (const k of Object.keys(o)) console.log('  ' + k + ':', JSON.stringify(o[k]));
      console.log('  -> right slack is ' + (o.slackRight < 0
        ? 'NEGATIVE (' + o.slackRight + ') -- the wordmark IS clipped'
        : 'ok (' + o.slackRight + ' units spare)'));
    }
    await send('Target.closeTarget', { targetId });
  }
  ws.close(); proc.kill();
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
}

main().catch((e) => { console.error(e); process.exit(1); });
