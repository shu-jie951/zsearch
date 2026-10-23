/**
 * 出结果页成品图 —— 走**离线打桩**，不碰上游。
 * 用法: node _shot_after_stub.js
 *
 * 为什么打桩：上游三源当前被限流（pansou timeout、hunhepan 429、zreso 冷却），
 * 结果页会渲染成空态，拍不到"有结果时长什么样"。
 * 这里用 CDP 的 Fetch 域把 /api/search 的响应替换成一份固定的假数据，
 * 页面上跑的仍然是**真实的 CSS / 真实的结果卡渲染逻辑**，
 * 用来验证的是版式而不是数据，所以打桩不影响结论。
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

const CLOUDS = [
  ['quark', '夸克网盘'],
  ['baidu', '百度网盘'],
  ['uc', 'UC网盘'],
  ['xunlei', '迅雷网盘'],
];

const TITLES = [
  '考研英语一历年真题（2010-2026）高清打印版',
  '张宇考研数学基础30讲 全程班讲义+习题',
  '考研政治徐涛核心考案 强化班笔记整理',
  '考研专业课408计算机统考 王道四件套',
  '考研英语词汇红宝书 乱序便携版 PDF',
  '考研数学李永乐660题 逐题精讲视频',
  '考研复试英语口语模板 常考话题50问',
  '考研择校数据手册 34所自划线院校汇总',
];

function payload(q) {
  const results = TITLES.map((t, i) => {
    const [ct, cn] = CLOUDS[i % CLOUDS.length];
    return {
      title: t,
      date: '2026-10-' + String(23 - i).padStart(2, '0'),
      datetime: '2026-10-' + String(23 - i).padStart(2, '0') + 'T00:00:00Z',
      note: i % 3 === 0 ? '「' + t + '」内含 PDF 与配套讲义，解压后可直接打印。' : t,
      tags: i % 2 === 0 ? ['PDF', '2026考研'] : ['视频', '讲义'],
      cloud_type: ct,
      cloud_type_name: cn,
      icon: ct,
      status: i % 5 === 0 ? 'unknown' : 'valid',
      password: '',
      images: [],
      url: 'https://example.com/s/' + (100000 + i),
      first_url: 'https://example.com/s/' + (100000 + i),
      _provider: ['pansou', 'hunhepan', 'zreso'][i % 3],
    };
  });
  return {
    ok: true,
    data: {
      results: results,
      source: 'aggregate',
      query: q,
      total: results.length,
      providers: [
        { id: 'pansou', count: 6, ms: 820, ok: true, error: null },
        { id: 'hunhepan', count: 2, ms: 1900, ok: true, error: null },
        { id: 'zreso', count: 0, ms: 120, ok: false, error: 'no-data' },
      ],
    },
  };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const cport = 9960 + Math.floor(Math.random() * 19);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-stub-'));
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
  let sid = null;
  const send = (m2, p, s) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m2, params: p || {}, sessionId: s })); });

  ws.on('message', async (m) => {
    const o = JSON.parse(m);
    if (o.id && pend.has(o.id)) { pend.get(o.id)(o); pend.delete(o.id); return; }
    if (o.method === 'Fetch.requestPaused') {
      const url = o.params.request.url;
      const q = decodeURIComponent((url.match(/[?&]q=([^&]*)/) || [])[1] || '考研');
      const body = Buffer.from(JSON.stringify(payload(q)), 'utf8').toString('base64');
      await send('Fetch.fulfillRequest', {
        requestId: o.params.requestId,
        responseCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: 'application/json; charset=utf-8' },
          { name: 'Cache-Control', value: 'no-store' },
        ],
        body: body,
      }, o.params.sessionId || sid);
    }
  });

  const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
  const attach = await send('Target.attachToTarget', { targetId, flatten: true });
  sid = attach.result.sessionId;

  await send('Page.enable', {}, sid);
  await send('Runtime.enable', {}, sid);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, sid);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false }, sid);
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/search*' }] }, sid);

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

  // 先落壁纸偏好，再进结果页
  await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' }, sid);
  await sleep(2500);
  await evalJs("window.ZSearchWall && window.ZSearchWall.set('w07')");
  await sleep(1600);

  await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/search?q=' + encodeURIComponent('考研') }, sid);
  let n = 0;
  for (let i = 0; i < 20; i++) {
    await sleep(600);
    n = (await evalJs("document.querySelectorAll('.result-item').length")) || 0;
    if (n > 0) break;
  }
  console.log('结果条数: ' + n);
  await sleep(900);
  await move(980, 560);
  await sleep(800);
  await shot('after-results.png');

  ws.close(); proc.kill();
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
})().catch((e) => { console.error(e); process.exit(1); });
