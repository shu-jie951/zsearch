/**
 * 用**离线打桩**复核 _qa_ui.js 第 5/6 节那 8 项「依赖真实结果」的断言。
 * 用法: node _verify_results_stub.js
 *
 * 为什么需要它：上游三源被限流时 /api/search 返回空，_qa_ui.js 里
 * "结果条目已渲染 / 标题 / /go 短链 / 来源徽章 / j-k 键盘导航" 这 8 项
 * 会全部变红 —— 那是环境问题，不是代码问题，但也**不能因此就不验**。
 *
 * 这里用 CDP 的 Fetch 域把 /api/search 的响应换成固定假数据，
 * 页面跑的仍是真实的 results.js 渲染与键盘导航逻辑，
 * 所以这 8 项断言的意义与原版完全一致（只是数据源换成了桩）。
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

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) pass++; else fail++;
  console.log('  ' + (ok ? '✔' : '✘') + ' ' + name + (detail !== undefined && detail !== '' ? '  ' + detail : ''));
}

const TITLES = [
  '考研英语一历年真题（2010-2026）高清打印版',
  '张宇考研数学基础30讲 全程班讲义+习题',
  '考研政治徐涛核心考案 强化班笔记整理',
  '考研专业课408计算机统考 王道四件套',
  '考研英语词汇红宝书 乱序便携版 PDF',
  '考研数学李永乐660题 逐题精讲视频',
];
const CLOUDS = [['quark', '夸克网盘'], ['baidu', '百度网盘'], ['uc', 'UC网盘'], ['xunlei', '迅雷网盘']];

function payload(q) {
  const results = TITLES.map((t, i) => {
    const [ct, cn] = CLOUDS[i % 4];
    return {
      title: t,
      date: '2026-10-' + String(23 - i).padStart(2, '0'),
      datetime: '2026-10-' + String(23 - i).padStart(2, '0') + 'T00:00:00Z',
      note: t,
      tags: ['PDF'],
      cloud_type: ct,
      cloud_type_name: cn,
      icon: ct,
      status: 'valid',
      password: '',
      images: [],
      // ★ 这两个字段的形状必须跟真实接口一致，否则桩本身会造出假失败：
      //   · first_url 是**站内短链** `/go/...`（results.js 直接拿它当 href）；
      //   · 来源徽章读的是 _providers（或旧的单数 provider）。
      //   第一版桩里写的是 https://example.com/... 且没给 _providers，
      //   于是"指向 /go 短链""来源徽章存在"两项被误判成红 —— 是桩的错，不是代码的错。
      first_url: '/go/' + (100000 + i),
      url: '/go/' + (100000 + i),
      _providers: [['pansou', 'hunhepan'][i % 2]],
    };
  });
  return {
    ok: true,
    data: {
      results: results,
      source: 'aggregate',
      query: q,
      providers: [
        { id: 'pansou', count: 4, ms: 800, ok: true, error: null },
        { id: 'hunhepan', count: 2, ms: 1500, ok: true, error: null },
      ],
    },
  };
}

(async () => {
  const cport = 9930 + Math.floor(Math.random() * 25);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-vstub-'));
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
  const jsErrors = [];
  let sid = null;
  const send = (m2, p, s) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m2, params: p || {}, sessionId: s })); });

  ws.on('message', async (m) => {
    const o = JSON.parse(m);
    if (o.id && pend.has(o.id)) { pend.get(o.id)(o); pend.delete(o.id); return; }
    if (o.method === 'Runtime.exceptionThrown') {
      const d = o.params.exceptionDetails;
      jsErrors.push((d.exception && d.exception.description) || d.text);
    }
    if (o.method === 'Fetch.requestPaused') {
      const url = o.params.request.url;
      const q = decodeURIComponent((url.match(/[?&]q=([^&]*)/) || [])[1] || '');
      const body = Buffer.from(JSON.stringify(payload(q)), 'utf8').toString('base64');
      await send('Fetch.fulfillRequest', {
        requestId: o.params.requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }],
        body: body,
      }, o.params.sessionId || sid);
    }
  });

  const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
  const attach = await send('Target.attachToTarget', { targetId, flatten: true });
  sid = attach.result.sessionId;

  await send('Page.enable', {}, sid);
  await send('Runtime.enable', {}, sid);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sid);
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/search*' }] }, sid);

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid);
    if (r.result && r.result.exceptionDetails) {
      const d = r.result.exceptionDetails;
      return { __error: (d.exception && d.exception.description) || d.text };
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const waitFor = async (expr, timeout, step) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const v = await evalJs(expr);
      if (v === true) return Date.now() - t0;
      await sleep(step || 150);
    }
    return -1;
  };
  const key = async (k, code, vk) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: code, windowsVirtualKeyCode: vk }, sid);
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: code, windowsVirtualKeyCode: vk }, sid);
  };

  console.log('\n=== 5. 结果页（打桩数据）===');
  await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/search?q=' + encodeURIComponent('考研') }, sid);
  const waitMs = await waitFor(`document.querySelectorAll('.result-item').length > 0`, 20000, 200);
  check('结果条目在 20s 内渲染出来', waitMs >= 0, waitMs >= 0 ? waitMs + 'ms 后出现' : '超时');

  const resPage = await evalJs(`(function(){
    const items = document.querySelectorAll('.result-item');
    const first = items[0];
    return {
      count: items.length,
      hasTitle: !!(first && first.querySelector('.result-title')),
      titleHref: first && first.querySelector('.result-title') ? first.querySelector('.result-title').getAttribute('href') : null,
      hasProvider: !!(first && first.querySelector('.result-provider')),
      hasProgress: !!document.getElementById('scrollProgress'),
      hasComposer: !!document.getElementById('resultsComposer'),
      emptyState: !!document.querySelector('.empty-state')
    };
  })()`);
  check('结果条目已渲染', resPage.count > 0, resPage.count + ' 条');
  check('结果标题存在', resPage.hasTitle);
  check('标题链接指向 /go 短链', /^\/go\//.test(resPage.titleHref || ''), resPage.titleHref);
  check('来源徽章存在', resPage.hasProvider);
  check('滚动进度条存在', resPage.hasProgress);
  check('结果页搜索框存在', resPage.hasComposer);
  check('无空状态(有结果时)', !resPage.emptyState);

  console.log('\n=== 6. 结果页键盘导航 ===');
  await evalJs('window.scrollTo(0,0); document.body.focus();');
  await key('j', 'KeyJ', 74);
  await waitFor(`document.querySelectorAll('.result-item.keyboard-focus').length === 1`, 3000, 100);
  const kbd1 = await evalJs(`document.querySelectorAll('.result-item.keyboard-focus').length`);
  check('按 j 出现键盘焦点', kbd1 === 1, kbd1 + ' 个聚焦');

  await key('j', 'KeyJ', 74);
  await waitFor(`[...document.querySelectorAll('.result-item')].findIndex(e => e.classList.contains('keyboard-focus')) === 1`, 3000, 100);
  const kbd2 = await evalJs(`(function(){
    const all = [...document.querySelectorAll('.result-item')];
    return { count: document.querySelectorAll('.result-item.keyboard-focus').length, idx: all.findIndex(e => e.classList.contains('keyboard-focus')) };
  })()`);
  check('再按 j 焦点下移', kbd2.count === 1 && kbd2.idx === 1, '索引=' + kbd2.idx);

  await key('k', 'KeyK', 75);
  await waitFor(`[...document.querySelectorAll('.result-item')].findIndex(e => e.classList.contains('keyboard-focus')) === 0`, 3000, 100);
  const kbd3 = await evalJs(`[...document.querySelectorAll('.result-item')].findIndex(e => e.classList.contains('keyboard-focus'))`);
  check('按 k 焦点上移', kbd3 === 0, '索引=' + kbd3);

  check('结果页无 JS 报错', jsErrors.length === 0, jsErrors.slice(0, 2).join(' | '));

  console.log('\n================================================');
  console.log('  结果页专项复核（打桩数据）：通过 ' + pass + ' / ' + (pass + fail));
  console.log('================================================');

  ws.close(); proc.kill();
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
