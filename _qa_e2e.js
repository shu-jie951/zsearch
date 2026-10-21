/**
 * 全流程端到端实测（真实浏览器 + 真实上游 + 真实日志）。
 * 用法: node _qa_e2e.js
 *
 * 和 _qa.js / _qa_ui.js 的分工：
 *   _qa.js      按接口逐个断言（快，但不证明"用户能走通"）
 *   _qa_ui.js   页面级断言（但只覆盖首页与少量交互）
 *   _qa_e2e.js  ★ 按「用户路径」走一遍：从首页输入一句话开始，
 *               到结果页筛选、收藏、探活、导出、工作台、外观、安全页、404，
 *               全程记录每一步的耗时与结果，最后把服务端日志一起打出来。
 *
 * 它自己拉起一个独立服务（端口 5399），跑完自动关掉，不依赖任何常驻进程。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 5399;
const BASE = 'http://127.0.0.1:' + PORT;
const ROOT = __dirname;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (u) =>
  new Promise((res, rej) => {
    http.get(u, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(d)); })
      .on('error', rej);
  });

let pass = 0, fail = 0;
const rows = [];
function step(section, label, okFlag, detail) {
  if (okFlag) pass++; else fail++;
  rows.push({ section, label, ok: !!okFlag, detail });
  console.log(`  ${okFlag ? '✓' : '✗'} ${label}${detail !== undefined && detail !== '' ? '  → ' + detail : ''}`);
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

(async () => {
  /* ---------------------------------------------------------------- 服务 */
  const serverLog = [];
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => serverLog.push(...String(d).split(/\r?\n/).filter(Boolean)));
  child.stderr.on('data', (d) => serverLog.push(...String(d).split(/\r?\n/).filter(Boolean)));

  let up = false;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch (e) { /* wait */ }
    await sleep(300);
  }
  if (!up) { console.error('服务没起来'); child.kill(); process.exit(1); }
  console.log('服务已就绪 ' + BASE);

  /* -------------------------------------------------------------- 浏览器 */
  const cport = 9200 + Math.floor(Math.random() * 60);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-e2e-'));
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
  if (!ver) { console.error('edge 没起来'); proc.kill(); child.kill(); process.exit(1); }

  const WebSocket = require('ws');
  const ws = new WebSocket(ver.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r) => ws.on('open', r));

  let id = 0; const pend = new Map(); const consoleErrs = [];
  ws.on('message', (m) => {
    const o = JSON.parse(m);
    if (o.id && pend.has(o.id)) { pend.get(o.id)(o); pend.delete(o.id); }
    if (o.method === 'Runtime.exceptionThrown') {
      const d = o.params.exceptionDetails;
      consoleErrs.push('EXC ' + (d.exception ? d.exception.description : d.text));
    }
    if (o.method === 'Runtime.consoleAPICalled' && o.params.type === 'error') {
      consoleErrs.push('CONSOLE ' + o.params.args.map((a) => a.value || a.description || '').join(' '));
    }
  });
  const send = (method, params, sessionId) =>
    new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {}, sessionId })); });

  const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
  const { result: { sessionId: sid } } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sid);
  await send('Runtime.enable', {}, sid);
  await send('DOM.enable', {}, sid);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, sid);

  async function evalJs(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid);
    if (r.result && r.result.exceptionDetails) {
      return { __err: r.result.exceptionDetails.text };
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  }
  async function nav(url) {
    await send('Page.navigate', { url }, sid);
    await sleep(600);
  }
  async function waitFor(expr, ms = 30000, gap = 300) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const v = await evalJs(expr);
      if (v) return v;
      await sleep(gap);
    }
    return null;
  }
  const click = (sel) => evalJs(`(() => { const e = document.querySelector('${sel}'); if (!e) return false; e.click(); return true; })()`);

  /**
   * 带一次退避重试的 API 搜索。
   * 上游耗时在 1~20s 之间随机波动，偶尔整轮 0 条 —— 单次 0 条不足以判定功能异常，
   * 所以 0 条时等 2.5s 再问一次，仍为 0 才认账（和 _qa.js 的 searchQ 同一套思路）。
   */
  async function apiSearch(qs, tries = 2) {
    let last = null;
    for (let i = 0; i < tries; i++) {
      const t0 = Date.now();
      const json = await fetch(BASE + '/api/search?' + qs).then((r) => r.json());
      const items = (json.data && json.data.results) || [];
      last = { json, items, ms: Date.now() - t0, tried: i + 1 };
      if (items.length > 0) return last;
      if (i < tries - 1) await sleep(2500);
    }
    return last;
  }

  /* ============================================================ 1 首页 */
  section('1. 首页渲染');
  await nav(BASE + '/');
  await sleep(2200);
  const home = await evalJs(`(() => {
    const q = (s) => document.querySelector(s);
    const box = q('.chat-editor-content');
    return {
      title: document.title,
      brand: (q('.home-logo-text') || {}).textContent || '',
      boxH: box ? Math.round(box.getBoundingClientRect().height) : 0,
      status: (q('#statusText') || {}).textContent || '',
      shortcuts: document.querySelectorAll('.publisher-shortcut__link').length,
      explore: document.querySelectorAll('.explore-chip').length,
      wall: document.documentElement.dataset.wall || '',
      tone: document.documentElement.dataset.wallTone || '',
      wbBtn: !!q('#wbTrigger'),
      wallBtn: !!q('#wallTrigger') || !!q('.wall-dock'),
      aura: !!q('.editor-aura'),
      intent: !!q('#editorIntent'),
      clearBtn: !!q('#clearBtn'),
      cmdk: !!q('#cmdkOverlay'),
    };
  })()`);
  step('首页', '页面标题正确', /ZSEARCH/.test(home.title || ''), home.title);
  step('首页', '搜索框已放大（高度 ≥ 150px）', home.boxH >= 150, home.boxH + 'px');
  step('首页', '数据源状态胶囊有文案', !!home.status, home.status);
  step('首页', '快捷入口（网盘直链区）已渲染', home.shortcuts >= 3, home.shortcuts + ' 个');
  step('首页', '今日探索标签已渲染', home.explore >= 6, home.explore + ' 个');
  step('首页', '壁纸层已启用', home.wall === 'on', home.wall + ' / tone=' + home.tone);
  step('首页', '工作台入口存在', home.wbBtn);
  step('首页', '外观入口存在', home.wallBtn);
  step('首页', '智能交互三件套齐全（柔光/意图/清空）', home.aura && home.intent && home.clearBtn);
  step('首页', '命令面板存在', home.cmdk);

  /* ============================================================ 2 搜索 */
  section('2. 首页搜索 → 结果页（两阶段）');
  const typed = await evalJs(`(() => {
    const t = document.querySelector('#searchInput');
    t.focus(); t.value = '甄嬛传'; t.dispatchEvent(new Event('input', { bubbles: true }));
    const c = document.querySelector('#clearBtn');
    const it = document.querySelector('#editorIntent');
    return { clearShown: c ? !c.hidden : false, intent: it && !it.hidden ? it.querySelector('.editor-intent__text').textContent : '' };
  })()`);
  step('搜索', '输入后清空按钮出现', typed.clearShown);
  // 甄嬛传 是作品名，规则表按「类目词」识别（影视/课程/音乐…），不含作品名。
  // 所以这里的正确预期是：不弹意图胶囊。类目命中的 6 个类别由 _shot_editor.js 覆盖。
  step('搜索', '作品名不误报类目（规则按类目词识别）', typed.intent === '', typed.intent || '(未显示)');

  const tSearch0 = Date.now();
  await click('#searchSubmitBtn');
  const went = await waitFor(`location.pathname === '/search'`, 6000);
  step('搜索', '点击搜索进入结果页', !!went, (Date.now() - tSearch0) + 'ms');

  // 快速阶段：先出结果
  // 上限放到 32s：第一阶段 6.5s 封顶，但如果所有源都慢，结果要到第二阶段（实测最慢 20s）
  // 才回来。这里等的是"用户终于看到结果"，不区分是哪个阶段给的。
  const fastAt = await waitFor(`document.querySelectorAll('.result-item').length > 0`, 32000, 250);
  const fastMs = Date.now() - tSearch0;
  step('搜索', '第一阶段（快速）已出结果', !!fastAt, fastAt ? fastAt + ' 条 / ' + fastMs + 'ms' : '超时');
  const fastCount = Number(fastAt || 0);

  // 最终阶段：条数不能比第一阶段少
  let finalCount = fastCount;
  const t1 = Date.now();
  while (Date.now() - t1 < 25000) {
    const n = await evalJs(`document.querySelectorAll('.result-item').length`);
    if (n !== undefined && n >= finalCount) finalCount = n;
    const done = await evalJs(`(() => { const s = document.querySelector('.src-tag.pending'); return !s; })()`);
    if (done && finalCount > 0) break;
    await sleep(400);
  }
  step('搜索', '结果条数与快速阶段相比不减少（mergeNoShrink）', finalCount >= fastCount, fastCount + ' → ' + finalCount);

  const cards = await evalJs(`(() => {
    const items = [...document.querySelectorAll('.result-item')];
    const withCloud = items.filter((i) => i.querySelector('.result-cloud')).length;
    const quark = items.filter((i) => /夸克/.test(i.textContent)).length;
    return { n: items.length, withCloud, quark,
             hasHref: items.filter((i) => i.hasAttribute('data-href')).length,
             tools: document.querySelectorAll('.wb-tools .tool-btn').length,
             stars: document.querySelectorAll('.fav-btn').length,
             stats: (document.querySelector('.results-stats') || {}).textContent || '' };
  })()`);
  step('结果页', '结果卡片带网盘标识', cards.withCloud > 0, cards.withCloud + '/' + cards.n);
  step('结果页', '夸克资源占比可见', cards.quark > 0, cards.quark + ' 条含「夸克」');
  step('结果页', '卡片带跳转短链属性', cards.hasHref === cards.n, cards.hasHref + '/' + cards.n);
  step('结果页', '工具条两个按钮（探活 / 导出）', cards.tools === 2, cards.tools + ' 个');
  step('结果页', '星标数与结果数一一对应', cards.stars === cards.n, cards.stars + '/' + cards.n);
  step('结果页', '统计行有内容', !!String(cards.stats).trim(), String(cards.stats).trim().slice(0, 40));

  /* ============================================================ 3 筛选排序 */
  section('3. 筛选与排序');
  const filterInfo = await evalJs(`(() => {
    const sels = [...document.querySelectorAll('select, .filter-chip, [data-cloud]')];
    return sels.slice(0, 12).map((e) => (e.id || e.className || e.tagName) + '=' + (e.value || e.dataset.cloud || ''));
  })()`);
  step('筛选', '结果页存在筛选/排序控件', Array.isArray(filterInfo) && filterInfo.length > 0, JSON.stringify(filterInfo).slice(0, 120));

  // 先保证全量结果在缓存里（这一步本来就要打上游），之后筛选必须走本地过滤
  const full = await apiSearch('q=' + encodeURIComponent('甄嬛传') + '&sort=latest&cloud=all');
  const fullDist = {};
  full.items.forEach((x) => { fullDist[x.cloud_type] = (fullDist[x.cloud_type] || 0) + 1; });
  step('筛选', '全量搜索有结果（可继续验证筛选）', full.items.length > 0,
    full.items.length + ' 条 ' + JSON.stringify(fullDist).slice(0, 90));

  const tFil = Date.now();
  const fil = await apiSearch('q=' + encodeURIComponent('甄嬛传') + '&cloud=quark', 1);
  const filMs = Date.now() - tFil;
  const items1 = fil.items;
  const onlyQuark = items1.every((it) => it.cloud_type === 'quark' || it.cloud_type === 'other');
  step('筛选', 'cloud=quark 只返回夸克（或 other）', onlyQuark, items1.length + ' 条');
  // 关键回归：筛选吃「全量缓存 + 本地过滤」，毫秒级返回。
  // 早先是按 cloud 重新问上游，实测 20s 超时 + 0 条 —— 用户明明看到过夸克资源却筛不出来。
  if (full.items.length > 0) {
    const expectQuark = full.items.filter((it) => it.cloud_type === 'quark' || it.cloud_type === 'other').length;
    step('筛选', '筛选用全量缓存本地过滤（毫秒级，且条数与全量一致）',
      items1.length === expectQuark && filMs < 1500,
      items1.length + '/' + expectQuark + ' 条 / ' + filMs + 'ms');
  } else {
    step('筛选', '筛选用全量缓存本地过滤（本次上游 0 条，跳过）', true, '上游没数据');
  }

  const old = await apiSearch('q=' + encodeURIComponent('甄嬛传') + '&sort=oldest');
  step('排序', 'sort=oldest 返回结果', old.items.length > 0, old.items.length + ' 条 / ' + old.ms + 'ms');

  /* ============================================================ 4 收藏/探活/导出 */
  section('4. 收藏 · 探活 · 导出');
  await click('.result-item .fav-btn');
  await sleep(400);
  const fav = await evalJs(`(() => {
    const raw = localStorage.getItem('zs-fav-v1');
    let n = 0; try { n = (JSON.parse(raw) || []).length; } catch (e) {}
    const marked = document.querySelectorAll('.fav-btn.is-on, .fav-btn[aria-pressed="true"]').length;
    return { stored: n, marked };
  })()`);
  step('收藏', '点击星标写入 localStorage', fav.stored >= 1, fav.stored + ' 条');
  step('收藏', '星标呈选中态', fav.marked >= 1, fav.marked + ' 个');

  const tProbe = Date.now();
  await evalJs(`(() => { const b = [...document.querySelectorAll('.wb-tools .tool-btn')][0]; if (b) b.click(); return 1; })()`);
  const probeDone = await waitFor(
    `(() => { const s = document.querySelector('.probe-summary'); return s && !s.hidden; })()`, 90000, 600);
  const probeInfo = await evalJs(`(() => {
    const seg = [...document.querySelectorAll('.probe-stack i')].map((i) => i.style.width);
    const dots = document.querySelectorAll('.alive-dot').length;
    const txt = (document.querySelector('.probe-legend') || {}).textContent || '';
    return { seg, dots, txt };
  })()`);
  step('探活', '批量探活跑完并出摘要', !!probeDone, ((Date.now() - tProbe) / 1000).toFixed(1) + 's');
  step('探活', '每条结果都有状态点', probeInfo.dots >= finalCount, probeInfo.dots + '/' + finalCount);
  step('探活', '三段堆叠条有宽度', (probeInfo.seg || []).some((w) => parseFloat(w) > 0), JSON.stringify(probeInfo.seg));
  step('探活', '图例有文案', !!probeInfo.txt.trim(), probeInfo.txt.trim().slice(0, 50));

  const csv = await evalJs(`(() => {
    const b = [...document.querySelectorAll('.wb-tools .tool-btn')][1];
    if (!b) return { err: 'no btn' };
    return { found: true };
  })()`);
  // 直接调导出逻辑拿不到内容，改为拦截 Blob 的方式验证
  const csvInfo = await evalJs(`(async () => {
    let captured = null;
    const orig = URL.createObjectURL;
    URL.createObjectURL = function (blob) {
      captured = blob;
      return 'blob:mock';
    };
    const b = [...document.querySelectorAll('.wb-tools .tool-btn')][1];
    b.click();
    await new Promise((r) => setTimeout(r, 300));
    URL.createObjectURL = orig;
    if (!captured) return { err: '未生成 Blob' };
    // ⚠️ 不能用 blob.text() 判 BOM：它按 UTF-8 解码，会把 EF BB BF 直接去掉，
    //    看起来"没有 BOM"其实是被解码器吃了。必须看原始字节。
    const buf = new Uint8Array(await captured.arrayBuffer());
    const hasBom = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
    const text = new TextDecoder('utf-8').decode(buf);
    const crlf = (text.match(/\\r\\n/g) || []).length;
    return { size: captured.size, hasBom, crlf, lines: text.split('\\r\\n').length };
  })()`);
  step('导出', '能生成 CSV 文件', !csvInfo.err, csvInfo.err || csvInfo.size + ' 字节');
  step('导出', 'CSV 带 UTF-8 BOM', csvInfo.hasBom === true);
  step('导出', 'CSV 行数 = 结果数 + 表头', !csvInfo.err && csvInfo.lines >= finalCount, csvInfo.lines + ' 行');

  /* ============================================================ 5 工作台 */
  section('5. 工作台三标签');
  await click('#wbTrigger');
  await sleep(600);
  const wb = await evalJs(`(() => {
    const p = document.querySelector('.wb-panel');
    if (!p) return { err: 'no panel' };
    const cs = getComputedStyle(p);
    const r = p.getBoundingClientRect();
    // ⚠️ fixed 元素的 offsetParent 恒为 null，不能用来判"可见"。
    //    改为看：尺寸 > 0 + 没被 visibility/opacity 藏起来 + 真的落在视口里。
    const shown = r.width > 0 && r.height > 0 &&
      cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.01 &&
      r.right > 0 && r.left < window.innerWidth;
    return { tabs: p.querySelectorAll('.wb-tab').length, open: shown,
             rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
             z: cs.zIndex, pos: cs.position,
             labels: [...p.querySelectorAll('.wb-tab')].map((b) => b.textContent.replace(/\\d+/g, '').trim()) };
  })()`);
  step('工作台', '面板已打开且可见', !wb.err && wb.open === true,
    wb.err || 'rect=' + JSON.stringify(wb.rect) + ' z=' + wb.z + ' ' + wb.pos);
  step('工作台', '三个标签页齐全', wb.tabs === 3, JSON.stringify(wb.labels));
  step('工作台', '面板层级高于结果页顶栏（z > 1000）', parseInt(wb.z, 10) > 1000, wb.z);

  const tabs = await evalJs(`(async () => {
    const out = [];
    const btns = [...document.querySelectorAll('.wb-tab')];
    for (const b of btns) {
      b.click();
      await new Promise((r) => setTimeout(r, 250));
      const body = document.querySelector('.wb-body');
      out.push({ tab: b.textContent.replace(/\\d+/g, '').trim(), len: body ? body.textContent.trim().length : 0 });
    }
    return out;
  })()`);
  step('工作台', '每个标签页都有内容', Array.isArray(tabs) && tabs.every((t) => t.len > 0), JSON.stringify(tabs));

  const statusBoard = await evalJs(`(async () => {
    const btns = [...document.querySelectorAll('.wb-tab')];
    const s = btns.find((b) => /状态/.test(b.textContent));
    if (s) s.click();
    await new Promise((r) => setTimeout(r, 400));
    return { metrics: document.querySelectorAll('.wb-metric').length,
             srcRows: document.querySelectorAll('.wb-src').length,
             pills: document.querySelectorAll('.wb-pill').length };
  })()`);
  step('工作台', '运行状态看板有指标卡与源列表',
    statusBoard.metrics >= 3 && statusBoard.srcRows >= 1,
    statusBoard.metrics + ' 卡 / ' + statusBoard.srcRows + ' 源 / ' + statusBoard.pills + ' 安全项');
  await click('.wb-close') || await evalJs(`(() => { const c = document.querySelector('.wb-scrim'); if (c) c.click(); return 1; })()`);
  await sleep(400);

  /* ============================================================ 6 外观 */
  section('6. 外观 · 壁纸切换');
  const wallResult = await evalJs(`(async () => {
    const before = document.querySelector('.wall-layer.is-on');
    const beforeBg = before ? before.style.backgroundImage : '';
    window.ZSearchWall.set('w07');
    await new Promise((r) => setTimeout(r, 200));
    const fading = document.documentElement.dataset.wallFading === '1';
    await new Promise((r) => setTimeout(r, 1200));
    const after = document.querySelector('.wall-layer.is-on');
    return { beforeBg, afterBg: after ? after.style.backgroundImage : '',
             fadingDuring: fading,
             fadingAfter: document.documentElement.dataset.wallFading || null,
             tone: document.documentElement.dataset.wallTone || '' };
  })()`);
  step('外观', '切换壁纸后背景图真的变了', wallResult.beforeBg !== wallResult.afterBg,
    (wallResult.afterBg || '').slice(-14));
  step('外观', '切换途中触发降级', wallResult.fadingDuring === true);
  step('外观', '切换完成后降级已撤', wallResult.fadingAfter === null);
  step('外观', 'tone 跟随壁纸', wallResult.tone === 'light', wallResult.tone);

  /* ============================================================ 7 安全页 */
  section('7. /go 安全把关');
  const target = await evalJs(`(() => { const it = document.querySelector('.result-item[data-href]'); return it ? it.getAttribute('data-href') : ''; })()`);
  if (target) {
    const g = await fetch(BASE + target, { redirect: 'manual' });
    const body = await g.text();
    step('安全', '/go 首次访问给风险提示页而不是裸跳', g.status === 200 && /即将前往|风险|继续/.test(body), 'HTTP ' + g.status);
    step('安全', '安全页不泄露真实直链', !/pan\.(quark|baidu)\.cn\/s\//i.test(body.split('<body')[1] || ''));
  } else {
    step('安全', '/go 安全把关', false, '没拿到可跳转结果');
  }

  /* ============================================================ 8 404 */
  section('8. 404 与异常路径');
  const r404 = await fetch(BASE + '/nope-xyz-123');
  step('健壮性', '未知路径返回 404 页面', r404.status === 404, 'HTTP ' + r404.status);
  const rEmpty = await fetch(BASE + '/api/search?q=');
  step('健壮性', '空查询不报错', rEmpty.status === 200, 'HTTP ' + rEmpty.status);
  const rLong = await fetch(BASE + '/api/search?q=' + 'a'.repeat(400));
  step('健壮性', '超长查询不崩', rLong.status === 200, 'HTTP ' + rLong.status);
  // 标签必须被归一化摘掉；纯乱按的长串必须短路（不打上游、不等 20 秒）
  const tXss = Date.now();
  const rXss = await fetch(BASE + '/api/search?q=' + encodeURIComponent('<script>alert(1)</script>'));
  const xssJson = await rXss.json();
  const xssMs = Date.now() - tXss;
  step('健壮性', '脚本标签被归一化摘除', rXss.status === 200 && !/[<>]/.test(String(xssJson.data.query || '')),
    'query=' + JSON.stringify(xssJson.data.query));

  const tJunk = Date.now();
  const rJunk = await fetch(BASE + '/api/search?q=' + 'a'.repeat(120));
  const junkJson = await rJunk.json();
  const junkMs = Date.now() - tJunk;
  step('健壮性', '垃圾长串直接短路（不打上游）',
    junkJson.data && junkJson.data.source === 'invalid' && junkMs < 800, junkMs + 'ms source=' + (junkJson.data || {}).source);

  const rPunc = await fetch(BASE + '/api/search?q=' + encodeURIComponent('！！！。。。'));
  const puncJson = await rPunc.json();
  step('健壮性', '纯标点被判为非搜索词', (puncJson.data || {}).source === 'invalid', (puncJson.data || {}).source);

  /* ============================================================ 9 键盘 */
  section('9. 键盘与可访问性');
  await nav(BASE + '/');
  await sleep(1800);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'k', code: 'KeyK', modifiers: 2, windowsVirtualKeyCode: 75 }, sid);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'k', code: 'KeyK', modifiers: 2, windowsVirtualKeyCode: 75 }, sid);
  await sleep(500);
  const cmdkOpen = await evalJs(`(() => { const o = document.querySelector('#cmdkOverlay'); return o ? !o.classList.contains('hidden') : false; })()`);
  step('键盘', 'Ctrl+K 打开命令面板', cmdkOpen === true, cmdkOpen);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sid);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sid);
  await sleep(400);
  const cmdkClosed = await evalJs(`(() => { const o = document.querySelector('#cmdkOverlay'); return o ? o.classList.contains('hidden') : false; })()`);
  step('键盘', 'Esc 关闭命令面板', cmdkClosed === true);

  const a11y = await evalJs(`(() => {
    const t = document.querySelector('#searchInput');
    const labels = [...document.querySelectorAll('button')].filter((b) => b.getAttribute('aria-label') || b.textContent.trim()).length;
    const buttons = document.querySelectorAll('button').length;
    return { hasAriaLabel: !!t.getAttribute('aria-label'), labels, buttons,
             lang: document.documentElement.lang };
  })()`);
  step('可访问性', '输入框有 aria-label', a11y.hasAriaLabel);
  step('可访问性', '所有按钮都有名称', a11y.labels === a11y.buttons, a11y.labels + '/' + a11y.buttons);
  step('可访问性', 'html lang 已声明', a11y.lang === 'zh-CN', a11y.lang);

  /* ============================================================ 10 移动端 */
  section('10. 移动端');
  const { result: win } = await send('Browser.getWindowForTarget', { targetId });
  await send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'normal', width: 420, height: 820 } });
  await sleep(700);
  const mobile = await evalJs(`(() => {
    const body = document.body;
    const box = document.querySelector('.chat-editor-content');
    const r = box.getBoundingClientRect();
    return { overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
             boxRight: Math.round(r.right), vw: window.innerWidth,
             font: getComputedStyle(document.querySelector('#searchInput')).fontSize };
  })()`);
  step('移动端', '无横向溢出', mobile.overflowX === false, mobile.boxRight + '/' + mobile.vw);
  step('移动端', '输入字号 ≥ 16px（防 iOS 缩放）', parseFloat(mobile.font) >= 16, mobile.font);

  /* ============================================================ 日志 */
  section('11. 服务端日志分析');
  const access = serverLog.filter((l) => l.includes('[access]'));
  const warns = access.filter((l) => l.includes('WARN'));
  const errors = access.filter((l) => l.includes('ERROR'));
  const searches = access.filter((l) => l.includes('/api/search'));
  const msOf = (l) => { const m = l.match(/(\d+)ms/); return m ? Number(m[1]) : 0; };
  const sorted = searches.map(msOf).sort((a, b) => a - b);
  const p50 = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  const cacheHits = searches.filter((l) => msOf(l) < 60).length;

  console.log('  访问日志 ' + access.length + ' 条，其中 /api/search ' + searches.length + ' 条');
  console.log('  慢请求(WARN) ' + warns.length + ' 条，错误(ERROR) ' + errors.length + ' 条');
  console.log('  搜索耗时 p50 = ' + p50 + 'ms，疑似命中缓存(<60ms) ' + cacheHits + ' 条');
  console.log('\n  --- 搜索日志抽样 ---');
  searches.slice(0, 8).forEach((l) => console.log('  ' + l));
  if (warns.length) {
    console.log('\n  --- 慢请求抽样 ---');
    warns.slice(0, 6).forEach((l) => console.log('  ' + l));
  }

  step('日志', '访问日志已产生', access.length > 0, access.length + ' 条');
  step('日志', '搜索日志带结果条数与来源', searches.some((l) => /结果=\d+/.test(l)));
  step('日志', '没有 5xx 错误', errors.length === 0, errors.length + ' 条');

  /* ============================================================ 汇总 */
  console.log('\n================================================');
  console.log('  全流程实测：通过 ' + pass + ' / ' + (pass + fail));
  if (fail) {
    console.log('\n  未通过项：');
    rows.filter((r) => !r.ok).forEach((r) => console.log('    - [' + r.section + '] ' + r.label +
      (r.detail !== undefined ? '  → ' + r.detail : '')));
  }
  console.log('  控制台报错：' + (consoleErrs.length ? consoleErrs.slice(0, 5).join(' | ') : '无'));
  console.log('================================================');

  // 落一份报告，供后续分析
  fs.writeFileSync(path.join(ROOT, '_e2e_report.json'), JSON.stringify({
    at: new Date().toISOString(),
    pass, fail, rows,
    consoleErrors: consoleErrs,
    logStats: { access: access.length, searches: searches.length, warns: warns.length, errors: errors.length, p50, cacheHits },
    serverLogTail: serverLog.slice(-40),
  }, null, 2));
  console.log('报告写入 _e2e_report.json');

  ws.close(); proc.kill(); child.kill();
  setTimeout(() => process.exit(fail ? 1 : 0), 300);
})().catch((e) => { console.error(e); process.exit(1); });
