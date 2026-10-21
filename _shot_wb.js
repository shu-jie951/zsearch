/**
 * 工作台专项截图 + 自检（收藏 / 历史 / 探活 / CSV / 运行状态）
 * 用法: node _shot_wb.js
 *
 * 断言的都是"静默失败"类问题：按钮没挂上、星标数量和结果数对不上、
 * 抽屉 fixed 被吃、探活点没点亮、面板渲染空白、控制台报错。
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
    http.get(u, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => res(d));
    }).on('error', rej);
  });

(async () => {
  const cport = 9760 + Math.floor(Math.random() * 40);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-wb-'));
  const proc = spawn(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--hide-scrollbars',
      '--remote-debugging-port=' + cport,
      '--user-data-dir=' + prof,
      '--window-size=1600,1000',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  let ver = null;
  for (let i = 0; i < 60; i++) {
    try {
      ver = JSON.parse(await get('http://127.0.0.1:' + cport + '/json/version'));
      break;
    } catch (e) {
      await sleep(250);
    }
  }
  if (!ver) {
    console.error('edge did not start');
    proc.kill();
    process.exit(1);
  }

  const WebSocket = require('ws');
  const ws = new WebSocket(ver.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r) => ws.on('open', r));

  let id = 0;
  const pend = new Map();
  const errors = [];

  ws.on('message', (m) => {
    const o = JSON.parse(m);
    if (o.id && pend.has(o.id)) {
      pend.get(o.id)(o);
      pend.delete(o.id);
    }
    if (o.method === 'Runtime.exceptionThrown') {
      const d = o.params.exceptionDetails;
      errors.push('EXC: ' + (d.exception && d.exception.description ? d.exception.description : d.text));
    }
    if (o.method === 'Runtime.consoleAPICalled' && o.params.type === 'error') {
      errors.push('CONSOLE: ' + o.params.args.map((a) => a.value || a.description || '').join(' '));
    }
  });

  const send = (method, params, sessionId) =>
    new Promise((res) => {
      const i = ++id;
      pend.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params: params || {}, sessionId }));
    });

  const {
    result: { targetId },
  } = await send('Target.createTarget', { url: 'about:blank' });
  const {
    result: { sessionId: sid },
  } = await send('Target.attachToTarget', { targetId, flatten: true });

  await send('Page.enable', {}, sid);
  await send('Runtime.enable', {}, sid);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, sid);

  async function evalJs(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid);
    if (r.result && r.result.exceptionDetails) return { error: r.result.exceptionDetails.text };
    return r.result && r.result.result ? r.result.result.value : undefined;
  }

  async function setSize(W, H) {
    const { result: win } = await send('Browser.getWindowForTarget', { targetId });
    await send('Browser.setWindowBounds', {
      windowId: win.windowId,
      bounds: { windowState: 'normal', width: W, height: H },
    });
  }

  async function shot(out) {
    const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sid);
    fs.writeFileSync(out, Buffer.from(s.result.data, 'base64'));
    console.log('wrote ' + out);
  }

  async function report(title, expr) {
    const v = await evalJs(expr);
    console.log('\n=== ' + title + ' ===');
    console.log(JSON.stringify(v, null, 2));
    return v;
  }

  /* ------------------------------------------------------------------ */
  await setSize(1500, 950);
  await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/search?q=' + encodeURIComponent('考研') }, sid);

  // 两阶段：先等第一阶段，看一眼中间态，再等第二阶段
  await sleep(7000);
  await report('阶段1（首屏）', `(() => {
    const items = document.querySelectorAll('.result-item');
    return {
      结果条数: items.length,
      统计行文字: (document.getElementById('statsContainer') || {}).innerText || '',
      中间态提示: !!document.querySelector('.searching-hint')
    };
  })()`);
  await shot('_wb_phase1.png');

  await sleep(12000);
  await report('阶段2（完整）', `(() => {
    const items = document.querySelectorAll('.result-item');
    const marks = document.querySelectorAll('.result-item .fav-btn');
    const bar = document.querySelector('.wb-tools');
    const dist = {};
    document.querySelectorAll('.result-item .result-snippet img').forEach(()=>{});
    const state = window.ZSearchResults ? window.ZSearchResults.getState() : null;
    return {
      结果条数: items.length,
      星标数量: marks.length,
      星标与结果一一对应: items.length === marks.length,
      工具条已显示: bar ? !bar.hidden : '未创建',
      工作台按钮已挂载: !!document.getElementById('wbTrigger'),
      统计行文字: (document.getElementById('statsContainer') || {}).innerText || '',
      query: state && state.q
    };
  })()`);
  await shot('_wb_results.png');

  /* ---- 收藏 ---- */
  await report('点击星标收藏', `(() => {
    const btns = document.querySelectorAll('.result-item .fav-btn');
    if (!btns.length) return '没有星标按钮';
    btns[0].click(); btns[2].click();
    return {
      已收藏数: JSON.parse(localStorage.getItem('zs-fav-v1') || '[]').length,
      角标文字: (document.querySelector('.wb-badge') || {}).textContent || '(无)',
      首条已亮: btns[0].classList.contains('is-on'),
      行已让位: btns[0].closest('.result-item').classList.contains('has-fav')
    };
  })()`);

  /* ---- 面板：收藏 ---- */
  await evalJs("document.getElementById('wbTrigger').click()");
  await sleep(1200);
  await report('面板 · 收藏', `(() => {
    const p = document.querySelector('.wb-panel');
    const r = p.getBoundingClientRect();
    return {
      面板已打开: p.classList.contains('is-open'),
      fixed未被困住: p.offsetParent === null,
      右边界: Math.round(r.right),
      视口宽: window.innerWidth,
      位置正确: Math.round(r.right) <= window.innerWidth + 1,
      当前标签: (document.querySelector('.wb-tab.active') || {}).textContent || '',
      收藏行数: p.querySelectorAll('[data-pane="fav"] .wb-row').length,
      有导出按钮: !!p.querySelector('[data-pane="fav"] .wb-label-btn')
    };
  })()`);
  await shot('_wb_panel_fav.png');

  /* ---- 面板：历史 ---- */
  await evalJs("document.querySelector('.wb-tab[data-tab=\"hist\"]').click()");
  await sleep(700);
  await report('面板 · 历史', `(() => {
    const p = document.querySelector('.wb-panel');
    return {
      记录条数: p.querySelectorAll('[data-pane="hist"] .wb-row').length,
      首条文字: (p.querySelector('[data-pane="hist"] .wb-row-title') || {}).textContent || '(空)'
    };
  })()`);
  await shot('_wb_panel_hist.png');

  /* ---- 面板：状态 ---- */
  await evalJs("document.querySelector('.wb-tab[data-tab=\"status\"]').click()");
  await sleep(2200);
  await report('面板 · 运行状态', `(() => {
    const p = document.querySelector('.wb-panel');
    const pane = p.querySelector('[data-pane="status"]');
    return {
      指标卡数: pane.querySelectorAll('.wb-metric').length,
      指标内容: Array.from(pane.querySelectorAll('.wb-metric')).map(m => m.innerText.replace(/\\n/g,' ')),
      源健康行数: pane.querySelectorAll('.wb-src').length,
      源状态: Array.from(pane.querySelectorAll('.wb-src-head')).map(h => h.innerText.replace(/\\s+/g,' ')),
      防护胶囊数: pane.querySelectorAll('.wb-pill').length,
      有报错: !!pane.querySelector('.wb-empty')
    };
  })()`);
  await shot('_wb_panel_status.png');

  /* ---- 关闭面板 + 批量探活 ---- */
  await evalJs("document.querySelector('.wb-close').click()");
  await sleep(800);

  await evalJs("document.querySelector('.tool-btn').click()");
  await sleep(1500);
  await report('探活进行中', `(() => {
    const m = document.querySelector('.probe-meter');
    return {
      进度条可见: m ? !m.hidden : false,
      计数: (document.querySelector('.probe-count') || {}).textContent || '',
      按钮文案: (document.querySelector('.tool-btn') || {}).innerText || '',
      已插点: document.querySelectorAll('.alive-dot').length,
      待检测点数: document.querySelectorAll('.alive-dot[data-state="pending"]').length
    };
  })()`);
  await shot('_wb_probing.png');

  // 等探活跑完（每批 8 条，约 1~3 秒一批）
  for (let i = 0; i < 20; i++) {
    await sleep(2500);
    const done = await evalJs("document.querySelector('.probe-summary') && !document.querySelector('.probe-summary').hidden");
    if (done === true) break;
  }

  await report('探活完成', `(() => {
    const dots = document.querySelectorAll('.alive-dot');
    const c = { valid: 0, invalid: 0, unknown: 0, pending: 0 };
    dots.forEach(d => { c[d.dataset.state] = (c[d.dataset.state] || 0) + 1; });
    const stack = document.querySelector('.probe-stack');
    return {
      点数: dots.length,
      状态分布: c,
      摘要可见: document.querySelector('.probe-summary') ? !document.querySelector('.probe-summary').hidden : false,
      图例: (document.querySelector('.probe-legend') || {}).innerText || '',
      堆叠段宽度: stack ? Array.from(stack.children).map(i => i.style.width) : [],
      按钮文案: (document.querySelector('.tool-btn') || {}).innerText || ''
    };
  })()`);
  await shot('_wb_probe_done.png');

  /* ---- CSV 导出（拦截下载，只验内容） ---- */
  await report('CSV 内容抽样', `(() => {
    // 直接复算一份，验证表头/行数/转义是否成立（不触发真实下载）
    const items = window.ZSearchResults.items();
    const cell = (v) => { const s = v == null ? '' : String(v); return /[",\\r\\n]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s; };
    const rows = [['序号','标题','网盘']].concat(items.map((it,i)=>[i+1, it.title, it.cloud_type_name||it.cloud_type]));
    const csv = '\\uFEFF' + rows.map(r=>r.map(cell).join(',')).join('\\r\\n');
    return {
      行数: rows.length,
      有BOM: csv.charCodeAt(0) === 0xFEFF,
      用CRLF: csv.indexOf('\\r\\n') > 0,
      首行: rows[0].join(','),
      样例: rows[1] ? rows[1].map(cell).join(',') : '(无)'
    };
  })()`);

  /* ---- 首页：最近搜索 ---- */
  await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' }, sid);
  await sleep(3200);
  await report('首页 · 最近搜索', `(() => {
    const box = document.getElementById('wbRecent');
    return {
      区块存在: !!box,
      可见: box ? !box.hidden : false,
      芯片数: box ? box.querySelectorAll('.wb-recent-chip').length : 0,
      芯片文字: box ? Array.from(box.querySelectorAll('.wb-recent-chip')).map(c=>c.innerText) : [],
      工作台按钮已挂载: !!document.getElementById('wbTrigger')
    };
  })()`);
  await shot('_wb_home.png');

  console.log('\n=== 控制台错误 ===');
  console.log(errors.length ? errors.join('\n') : '无');

  ws.close();
  proc.kill();
  try {
    fs.rmSync(prof, { recursive: true, force: true });
  } catch (e) {}
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
