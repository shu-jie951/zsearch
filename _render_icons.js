/**
 * Render the app mark to per-size PNGs, at a supersampled resolution.
 *
 * Why the browser instead of a rasteriser: Edge paints the mark exactly the way
 * the site does, so the desktop icon cannot drift from the in-page logo. And
 * because the page background is overridden to fully transparent, the rounded
 * corners come out genuinely alpha-0 -- no masking, no white fringing.
 *
 * Each size is rendered at SS x its own pixel size and handed to Python to
 * downscale, which is what keeps the 16/20/24px entries crisp instead of muddy.
 *
 * Usage: node _render_icons.js <svg> <outdir> [ss]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const SIZES = (process.env.ZSIC_SIZES
  ? process.env.ZSIC_SIZES.split(',').map((s) => parseInt(s, 10))
  : [256, 128, 96, 64, 48, 40, 32, 24, 20, 16]);

const svgPath = process.argv[2];
const outDir = process.argv[3] || '_icons_raw';
const SS = parseInt(process.argv[4] || '4', 10);

// One page PER SIZE, not one wide row of tiles.
//
// The row trick is a trap: at ss=8 the ten sizes laid side by side need a
// 5792px-wide document, and no window can be that wide. The OS clamps the
// window, `captureBeyondViewport:false` then limits the capture to what is
// really on screen, and the crops for the rightmost -- i.e. SMALLEST -- tiles
// come back silently truncated. That is exactly how the 16px frame lost its
// right-hand edge while the 256px one looked perfect.
//
// Rendering each size alone, with the window deliberately larger than the
// largest tile, removes the whole class of problem: the clip is always 0,0 and
// always fully inside the viewport.
const MAX_TILE = 1024;   // largest supersampled tile we ever ask the window for
const SLACK = 400;       // absorbs window chrome (~95px) plus any rounding

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(d)); })
    .on('error', rej);
});

// 256px at 8x would be a 2048px tile -- taller than the viewport we can
// guarantee, so the big end quietly drops to 4x. Everything from 128px down
// still gets the full 8x, and 4x into 256 is more supersampling than anyone
// can see.
const ssFor = (s) => Math.max(1, Math.min(SS, Math.floor(MAX_TILE / s)));

const page = (inner, px) => `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;width:${px}px;height:${px}px;overflow:hidden;background:transparent}
  svg{display:block;width:${px}px;height:${px}px}
</style></head>
<body><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"
  width="${px}" height="${px}">${inner}</svg></body></html>`;

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const svg = fs.readFileSync(svgPath, 'utf8');
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zsic-'));
  const htmlFile = path.join(tmp, 'a.html');
  const win = MAX_TILE + SLACK;

  const port = 9630 + Math.floor(Math.random() * 60);
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--hide-scrollbars', '--force-device-scale-factor=1',
    '--remote-debugging-port=' + port, '--user-data-dir=' + path.join(tmp, 'p'),
    '--window-size=' + win + ',' + win, 'about:blank'], { stdio: 'ignore' });

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

  // Transparent page background -> the PNG keeps real alpha.
  await send('Emulation.setDefaultBackgroundColorOverride',
    { color: { r: 0, g: 0, b: 0, a: 0 } }, sid);

  for (const s of SIZES) {
    const ss = ssFor(s);
    const px = s * ss;
    fs.writeFileSync(htmlFile, page(inner, px), 'utf8');
    await send('Page.navigate', { url: 'file:///' + htmlFile.replace(/\\/g, '/') }, sid);
    await sleep(450);
    const shot = await send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: false,
      clip: { x: 0, y: 0, width: px, height: px, scale: 1 },
    }, sid);
    const out = path.join(outDir, 'icon-' + s + '@' + ss + 'x.png');
    fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
    console.log('  %s  %dpx @%dx -> %s', String(s).padStart(3), px, ss, path.basename(out));
  }
  console.log('rendered ' + SIZES.length + ' tiles into ' + outDir + ' (window ' + win + 'px)');

  ws.close(); proc.kill();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
})().catch((e) => { console.error(e); process.exit(1); });
