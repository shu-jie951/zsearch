'use strict';
/**
 * 前端交互质检：真实浏览器（CDP）跑交互，捕获所有 console 错误与页面异常。
 *
 * 检查项：
 *   - 页面是否加载成功、有无 JS 报错 / 资源 404
 *   - 命令面板 Ctrl+K 开合
 *   - 联想下拉的固定定位是否正确（offsetParent 必须为 null）
 *   - 键盘导航 j/k/Enter
 *   - 主题（亮/暗）都能渲染
 *   - 移动端布局不溢出
 *
 * 用法： node _qa_ui.js
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');

const PORT = 5324;
const BASE = `http://127.0.0.1:${PORT}`;
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  \u2714 ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; failures.push(name + (extra ? '  ' + extra : '')); console.log(`  \u2718 ${name}${extra ? '  ' + extra : ''}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// ------------------------------------------------------------------ CDP 客户端
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    const c = new CDP(ws);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id && c.pending.has(msg.id)) {
        const { res, rej } = c.pending.get(msg.id);
        c.pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method) {
        c.events.push(msg);
      }
    });
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

async function evaluate(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval error');
  return r.result.value;
}

/**
 * 轮询等待页面内某个条件成立，返回「等待了多少毫秒」；
 * 超时返回 -1。用于替代固定 sleep —— 上游耗时是浮动的，
 * 写死等待时间会在上游偏慢时把正常功能误判成 bug。
 */
async function waitFor(cdp, expr, timeoutMs = 15000, intervalMs = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await evaluate(cdp, `!!(${expr})`)) return Date.now() - t0;
    } catch { /* 页面可能正在导航，忽略 */ }
    await sleep(intervalMs);
  }
  return -1;
}

function waitForDevtools(port, ms = 15000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch { retry(); } });
      }).on('error', retry);
      function retry() {
        if (Date.now() - t0 > ms) reject(new Error('devtools 超时'));
        else setTimeout(tick, 300);
      }
    };
    tick();
  });
}

(async () => {
  // ---------- 起服务 ----------
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: __dirname, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let srvLog = '';
  srv.stdout.on('data', (d) => (srvLog += d));
  srv.stderr.on('data', (d) => (srvLog += d));

  const cleanup = () => { try { srv.kill('SIGKILL'); } catch {} };
  try {
    // 等服务起来
    let up = false;
    for (let i = 0; i < 40; i++) {
      try { const r = await getJson(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch {}
      await sleep(300);
    }
    if (!up) { console.log('服务未起来:\n' + srvLog); cleanup(); return; }

    // ---------- 起浏览器 ----------
    const profile = path.join(__dirname, '_ui_profile');
    // 复用同名目录，但跑完删掉 —— 否则每次质检都留 ~40MB profile 在项目里
    const edge = spawn(EDGE, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--hide-scrollbars', '--remote-debugging-port=9345',
      `--user-data-dir=${profile}`, '--window-size=1440,900',
      'about:blank',
    ], { stdio: 'ignore' });

    // 等 Edge 退出后再删 profile：Windows 上文件还被占用时 rm 会失败
    const removeProfile = async () => {
      for (let i = 0; i < 10; i++) {
        try { fs.rmSync(profile, { recursive: true, force: true }); return; } catch { await sleep(300); }
      }
    };

    const cleanupAll = async () => {
      try { edge.kill(); } catch {}
      await removeProfile();
      cleanup();
    };

    const ver = await waitForDevtools(9345);

    // 连接到目标页
    const targets = await new Promise((res, rej) => {
      http.get('http://127.0.0.1:9345/json/list', (r) => {
        let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d)));
      }).on('error', rej);
    });
    const page = targets.find((t) => t.type === 'page') || targets[0];
    const cdp = await CDP.connect(page.webSocketDebuggerUrl);

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Network.enable');

    console.log(`\n浏览器已就绪 (${ver['Browser'] || 'Edge'}), 开始 UI 质检\n`);

    // ================================================ 1 首页加载
    console.log('=== 1. 首页加载 ===');
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await cdp.send('Page.navigate', { url: BASE + '/' });
    await sleep(2600);

    const consoleErrors = [];
    const netFails = [];
    for (const e of cdp.events) {
      if (e.method === 'Runtime.exceptionThrown') {
        consoleErrors.push(e.params.exceptionDetails.text + ' ' + (e.params.exceptionDetails.exception?.description || ''));
      }
      if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') {
        consoleErrors.push(e.params.args.map((a) => a.value || a.description || '').join(' '));
      }
      if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') {
        consoleErrors.push('[log] ' + e.params.entry.text);
      }
      if (e.method === 'Network.loadingFailed') {
        netFails.push(e.params.errorText + ' ' + (e.params.type || ''));
      }
      if (e.method === 'Network.responseReceived') {
        const s = e.params.response.status;
        if (s >= 400) netFails.push(`HTTP ${s} ${e.params.response.url}`);
      }
    }
    check('页面无 JS 异常', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
    check('无资源加载失败', netFails.length === 0, netFails.slice(0, 3).join(' | '));

    const title = await evaluate(cdp, 'document.title');
    check('页面标题正确', /ZSEARCH/i.test(title), title);

    const cssOk = await evaluate(cdp, `
      (function(){
        const b = getComputedStyle(document.body);
        const s = document.querySelector('.atmosphere');
        const aura = document.querySelector('.aura');
        return {
          hasAtmosphere: !!s,
          hasAura: !!aura,
          bgVar: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
          auraOpacity: aura ? getComputedStyle(aura).opacity : null,
        };
      })()
    `);
    check('氛围层已渲染', cssOk.hasAtmosphere && cssOk.hasAura, `--bg=${cssOk.bgVar}`);
    check('极光可见(非0透明)', cssOk.auraOpacity !== '0', `opacity=${cssOk.auraOpacity}`);

    // ================================================ 2 关键元素
    console.log('\n=== 2. 首页关键元素 ===');
    const elems = await evaluate(cdp, `
      (function(){
        const q = (s) => document.querySelector(s);
        return {
          brand: !!q('.home-logo-block'),
          search: !!q('#editorContent'),
          chips: document.querySelectorAll('.explore-chip').length,
          cmdk: !!q('#cmdkOverlay'),
          kbdHint: !!q('#cmdHintBtn'),
          statusPill: !!q('.status-pill'),
          footer: !!q('footer'),
        };
      })()
    `);
    check('品牌区存在', elems.brand);
    check('搜索框存在', elems.search);
    check('今日探索 chips 已渲染', elems.chips > 0, `${elems.chips} 个`);
    check('命令面板 DOM 存在', elems.cmdk);
    check('快捷键提示存在', elems.kbdHint);
    check('状态徽章存在', elems.statusPill);

    // ================================================ 3 命令面板
    console.log('\n=== 3. 命令面板 (Ctrl+K) ===');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75 });
    await sleep(500);
    const cmdkOpen = await evaluate(cdp, `
      (function(){
        const o = document.getElementById('cmdkOverlay');
        if (!o) return { open:false };
        const st = getComputedStyle(o);
        return {
          open: !o.classList.contains('hidden') && st.display !== 'none',
          visible: st.opacity,
          items: document.querySelectorAll('.cmdk-body [role], .cmdk-body button, #cmdkBody > *').length,
        };
      })()
    `);
    check('Ctrl+K 打开命令面板', cmdkOpen.open, `opacity=${cmdkOpen.visible}`);
    check('面板内有条目', cmdkOpen.items > 0, `${cmdkOpen.items} 项`);

    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(400);
    const cmdkClosed = await evaluate(cdp, `(function(){ const o=document.getElementById('cmdkOverlay'); return o ? o.classList.contains('hidden') : true; })()`);
    check('Esc 关闭命令面板', cmdkClosed);

    // ================================================ 4 联想下拉定位（关键回归）
    console.log('\n=== 4. 联想下拉定位（transform/fixed 回归） ===');
    // 注意：#editorContent 只是外层 div 包装（onclick 负责 focus）。
    // 真正的输入控件是 <textarea id="searchInput">，input 事件必须派发在它身上。
    const suggestSeed = await evaluate(cdp, `
      (function(){
        const ta = document.querySelector('#searchInput');
        if (!ta) return { ok:false, why:'#searchInput 不存在' };
        ta.focus();
        ta.value = '电影';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        const brain = document.getElementById('brainBtn');
        return { ok:true, brainOn: !!(brain && brain.classList.contains('active')), val: ta.value };
      })()
    `);
    check('搜索输入框存在且可派发 input', suggestSeed.ok, suggestSeed.ok ? `brain=${suggestSeed.brainOn}` : suggestSeed.why);
    await sleep(1600);
    const suggest = await evaluate(cdp, `
      (function(){
        const dd = document.querySelector('.suggest-dropdown-menu');
        const ed = document.querySelector('#editorContent');
        if (!dd || !ed) return { exists: false };
        const hidden = dd.classList.contains('hidden') || getComputedStyle(dd).display === 'none';
        const dr = dd.getBoundingClientRect();
        const er = ed.getBoundingClientRect();
        return {
          exists: true, hidden,
          offsetParent: dd.offsetParent ? (dd.offsetParent.className || dd.offsetParent.tagName) : null,
          pos: getComputedStyle(dd).position,
          ddLeft: Math.round(dr.left), ddTop: Math.round(dr.top), ddW: Math.round(dr.width),
          edLeft: Math.round(er.left), edBottom: Math.round(er.bottom), edW: Math.round(er.width),
        };
      })()
    `);
    if (suggest.exists && !suggest.hidden) {
      check('下拉用 fixed 定位', suggest.pos === 'fixed', suggest.pos);
      check('offsetParent 为 null（无 transform 破坏）', suggest.offsetParent === null, String(suggest.offsetParent));
      check('左边缘与搜索框对齐', Math.abs(suggest.ddLeft - suggest.edLeft) <= 2, `${suggest.ddLeft} vs ${suggest.edLeft}`);
      check('在搜索框下方', suggest.ddTop >= suggest.edBottom - 2, `${suggest.ddTop} vs ${suggest.edBottom}`);
      check('宽度与搜索框一致', Math.abs(suggest.ddW - suggest.edW) <= 2, `${suggest.ddW} vs ${suggest.edW}`);
    } else {
      check('联想下拉出现', false, suggest.exists ? '未展开' : 'DOM 不存在');
    }

    // ================================================ 5 结果页
    console.log('\n=== 5. 结果页 ===');
    cdp.events.length = 0;
    await cdp.send('Page.navigate', { url: BASE + '/search?q=' + encodeURIComponent('考研') });
    // 不能用固定 sleep：三个上游耗时在 0.2s ~ 9s 之间浮动，
    // 写死 4000ms 会在上游偏慢时误判成「0 条」。
    // 改为轮询等待结果条目出现（最多 20s），并记录实际耗时。
    const waitMs = await waitFor(cdp, `document.querySelectorAll('.result-item').length > 0`, 20000, 300);
    check('结果条目在 20s 内渲染出来', waitMs >= 0, waitMs >= 0 ? `${waitMs}ms 后出现` : '超时');

    const resPage = await evaluate(cdp, `
      (function(){
        const items = document.querySelectorAll('.result-item');
        const first = items[0];
        return {
          count: items.length,
          hasTitle: !!(first && first.querySelector('.result-title')),
          titleHref: first && first.querySelector('.result-title') ? first.querySelector('.result-title').getAttribute('href') : null,
          hasProvider: !!(first && first.querySelector('.result-provider')),
          hasProgress: !!document.getElementById('scrollProgress'),
          hasComposer: !!document.getElementById('resultsComposer'),
          emptyState: !!document.querySelector('.empty-state'),
        };
      })()
    `);
    check('结果条目已渲染', resPage.count > 0, `${resPage.count} 条`);
    check('结果标题存在', resPage.hasTitle);
    check('标题链接指向 /go 短链', /^\/go\//.test(resPage.titleHref || ''), resPage.titleHref);
    check('来源徽章存在', resPage.hasProvider);
    check('滚动进度条存在', resPage.hasProgress);
    check('结果页搜索框存在', resPage.hasComposer);
    check('无空状态(有结果时)', !resPage.emptyState);

    // 结果页 console 错误
    const resErrors = [];
    for (const e of cdp.events) {
      if (e.method === 'Runtime.exceptionThrown') resErrors.push(e.params.exceptionDetails.text);
      if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') resErrors.push(e.params.entry.text);
    }
    check('结果页无 JS 报错', resErrors.length === 0, resErrors.slice(0, 2).join(' | '));

    // ================================================ 6 键盘导航
    console.log('\n=== 6. 结果页键盘导航 ===');
    await evaluate(cdp, 'window.scrollTo(0,0); document.body.focus();');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'j', code: 'KeyJ', windowsVirtualKeyCode: 74 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'j', code: 'KeyJ', windowsVirtualKeyCode: 74 });
    await waitFor(cdp, `document.querySelectorAll('.result-item.keyboard-focus').length === 1`, 3000, 100);
    const kbd1 = await evaluate(cdp, `document.querySelectorAll('.result-item.keyboard-focus').length`);
    check('按 j 出现键盘焦点', kbd1 === 1, `${kbd1} 个聚焦`);

    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'j', code: 'KeyJ', windowsVirtualKeyCode: 74 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'j', code: 'KeyJ', windowsVirtualKeyCode: 74 });
    await waitFor(cdp, `
      [...document.querySelectorAll('.result-item')].findIndex(e => e.classList.contains('keyboard-focus')) === 1
    `, 3000, 100);
    const kbd2 = await evaluate(cdp, `
      (function(){
        const all = [...document.querySelectorAll('.result-item')];
        const idx = all.findIndex(e => e.classList.contains('keyboard-focus'));
        return { count: document.querySelectorAll('.result-item.keyboard-focus').length, idx };
      })()
    `);
    check('再按 j 焦点下移', kbd2.count === 1 && kbd2.idx === 1, `索引=${kbd2.idx}`);

    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75 });
    await waitFor(cdp, `
      [...document.querySelectorAll('.result-item')].findIndex(e => e.classList.contains('keyboard-focus')) === 0
    `, 3000, 100);
    const kbd3 = await evaluate(cdp, `
      (function(){
        const all=[...document.querySelectorAll('.result-item')];
        return all.findIndex(e=>e.classList.contains('keyboard-focus'));
      })()
    `);
    check('按 k 焦点上移', kbd3 === 0, `索引=${kbd3}`);

    // ================================================ 7 主题切换
    console.log('\n=== 7. 亮色主题渲染 ===');
    // ⚠️ 先关掉壁纸再测系统主题。
    // 壁纸的 tone 会强制覆写 --bg / --text 等变量（html[data-wall-tone="dark"]
    // 优先级高于 :root 里的 @media (prefers-color-scheme)）—— 这是设计行为：
    // 壁纸是暗的就必须配浅色文字，不能让系统偏好把对比度毁掉。
    // 所以"跟随系统深浅色"这个能力只在**无壁纸**状态下成立，测试也必须在这个前提下测。
    await evaluate(
      cdp,
      `(function(){ if (window.ZSearchWall && window.ZSearchWall.set) { window.ZSearchWall.set(null); } return 1; })()`
    );
    await sleep(700);
    const noWall = await evaluate(
      cdp,
      `(function(){ return { wall: document.documentElement.dataset.wall || '', tone: document.documentElement.dataset.wallTone || '' }; })()`
    );
    check('已切到无壁纸态（系统主题才会接管）', noWall.wall === 'off', `wall=${noWall.wall} tone=${noWall.tone}`);

    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await sleep(600);
    const light = await evaluate(cdp, `
      (function(){
        const s = getComputedStyle(document.documentElement);
        return {
          bg: s.getPropertyValue('--bg').trim(),
          text: s.getPropertyValue('--text-strong').trim(),
        };
      })()
    `);
    check('亮色主题变量生效', light.bg && light.bg !== '#0e0e11', `--bg=${light.bg} --text=${light.text}`);

    // ================================================ 8 移动端
    console.log('\n=== 8. 移动端布局 ===');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 400, height: 780, deviceScaleFactor: 2, mobile: true });
    await cdp.send('Page.navigate', { url: BASE + '/' });
    await sleep(2200);
    const mobile = await evaluate(cdp, `
      (function(){
        return {
          docW: document.documentElement.scrollWidth,
          winW: window.innerWidth,
          overflow: document.documentElement.scrollWidth > window.innerWidth + 2,
          searchW: (document.querySelector('#editorContent')||{}).getBoundingClientRect ? Math.round(document.querySelector('#editorContent').getBoundingClientRect().width) : 0,
        };
      })()
    `);
    check('移动端无横向溢出', !mobile.overflow, `doc=${mobile.docW} win=${mobile.winW}`);
    check('移动端搜索框可见', mobile.searchW > 0, `宽 ${mobile.searchW}px`);

    // ================================================ 9 404 页
    console.log('\n=== 9. 404 页 ===');
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    cdp.events.length = 0;
    await cdp.send('Page.navigate', { url: BASE + '/this-page-does-not-exist' });
    await sleep(1800);
    const notFound = await evaluate(cdp, `({ title: document.title, hasStyle: !!document.querySelector('link[rel=stylesheet]') })`);
    const nfErrors = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown').length;
    check('404 页有样式', notFound.hasStyle);
    check('404 页无 JS 异常', nfErrors === 0);

    cdp.close();

    console.log('\n' + '='.repeat(48));
    console.log(`  UI 质检：通过 ${pass} / ${pass + fail}`);
    if (fail) { console.log('\n  失败项：'); failures.forEach((f) => console.log('    - ' + f)); }
    console.log('='.repeat(48) + '\n');

    await cleanupAll();
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.log('UI 质检异常:', e && e.stack);
    try { await cleanupAll(); } catch { cleanup(); }
    process.exit(1);
  }
})();
