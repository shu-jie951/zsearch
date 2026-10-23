/**
 * 验收：背景固定 + 光斑跟随 + 壁纸层不再位移。
 * 用法: node _verify_light.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 5178;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(d)); }).on('error', rej);
});

(async () => {
  const cport = 9940 + Math.floor(Math.random() * 40);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-vl-'));
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
  await send('Browser.getWindowForTarget', { targetId }).then(async ({ result: w }) => {
    await send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { windowState: 'normal', width: 1440, height: 900 } });
  });

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid);
    if (r.result && r.result.exceptionDetails) {
      const d = r.result.exceptionDetails;
      return { error: (d.exception && d.exception.description) || d.text };
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const shot = async (out) => {
    const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sid);
    fs.writeFileSync(out, Buffer.from(s.result.data, 'base64'));
    console.log('wrote ' + out);
  };

  await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' }, sid);
  await sleep(2600);
  await evalJs("window.ZSearchWall && window.ZSearchWall.set('w07')");
  await sleep(1800);

  const layerBefore = await evalJs("getComputedStyle(document.querySelector('.wall-layer.is-on')).transform");
  const lightBefore = await evalJs(`(() => {
    const l = document.querySelector('.wall-light');
    if (!l) return '不存在';
    const cs = getComputedStyle(l);
    return { 类名: l.className, 不透明度: cs.opacity, transform: cs.transform, 显隐: cs.display };
  })()`);
  console.log('\n=== 初始（未移动鼠标）===');
  console.log('壁纸层 transform: ' + layerBefore);
  console.log('光斑: ' + JSON.stringify(lightBefore));
  await shot('_v_light_off.png');

  // 移动鼠标到右下
  for (const [x, y] of [[300, 300], [700, 480], [1080, 640]]) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 }, sid);
    await sleep(60);
  }
  await sleep(700);

  const layerAfter = await evalJs("getComputedStyle(document.querySelector('.wall-layer.is-on')).transform");
  const lightAfter = await evalJs(`(() => {
    const l = document.querySelector('.wall-light');
    const cs = getComputedStyle(l);
    return { 类名: l.className, 不透明度: cs.opacity, transform: cs.transform };
  })()`);
  console.log('\n=== 鼠标移到 (1080,640) 之后 ===');
  console.log('壁纸层 transform: ' + layerAfter);
  console.log('光斑: ' + JSON.stringify(lightAfter));
  await shot('_v_light_on.png');

  console.log('\n=== 断言 ===');
  console.log('① 背景固定（壁纸层 transform 不变）: ' + (layerBefore === layerAfter ? 'PASS' : 'FAIL ' + layerBefore + ' -> ' + layerAfter));
  console.log('② 光斑已亮起 opacity=1: ' + (lightAfter && lightAfter.不透明度 === '1' ? 'PASS' : 'FAIL ' + JSON.stringify(lightAfter)));
  console.log('③ 光斑位移正确 translate3d(1080,640): ' + (lightAfter && /1080/.test(lightAfter.transform) ? 'PASS' : 'FAIL ' + JSON.stringify(lightAfter)));

  // 关壁纸后光斑必须收掉
  await evalJs("window.ZSearchWall && window.ZSearchWall.set(null)");
  await sleep(900);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 400, y: 400, button: 'none', clickCount: 0 }, sid);
  await sleep(700);
  const offState = await evalJs(`(() => {
    const l = document.querySelector('.wall-light');
    const stage = document.querySelector('.wall-stage');
    return {
      dataWall: document.documentElement.dataset.wall,
      光斑类名: l ? l.className : null,
      光斑不透明度: l ? getComputedStyle(l).opacity : null,
      舞台显隐: stage ? getComputedStyle(stage).display : null
    };
  })()`);
  console.log('\n=== 关壁纸后 ===');
  console.log(JSON.stringify(offState, null, 1));
  console.log('④ 关壁纸时光斑熄灭: ' + (offState.光斑不透明度 === '0' ? 'PASS' : 'FAIL'));

  ws.close(); proc.kill();
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
})().catch((e) => { console.error(e); process.exit(1); });
