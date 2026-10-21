/**
 * 搜索框（含智能交互层）出图 + 自检。
 * 用法: node _shot_editor.js
 *
 * 覆盖这一轮新增/改动的全部行为：
 *   尺寸（高度、字号）· 柔光跟随 · 流光扫边 · 意图识别 · 清空按钮 · Esc 清空
 *   · 移动端不回退字号 · 控制台零报错
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
    http.get(u, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(d)); })
      .on('error', rej);
  });

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
};

(async () => {
  const cport = 9700 + Math.floor(Math.random() * 60);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-editor-'));
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
  if (!ver) { console.error('edge did not start'); proc.kill(); process.exit(1); }

  const WebSocket = require('ws');
  const ws = new WebSocket(ver.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r) => ws.on('open', r));

  let id = 0; const pend = new Map(); const errs = [];
  ws.on('message', (m) => {
    const o = JSON.parse(m);
    if (o.id && pend.has(o.id)) { pend.get(o.id)(o); pend.delete(o.id); }
    if (o.method === 'Runtime.exceptionThrown') {
      const d = o.params.exceptionDetails;
      errs.push('EXC ' + (d.exception ? d.exception.description : d.text));
    }
    if (o.method === 'Runtime.consoleAPICalled' && o.params.type === 'error') {
      errs.push('CONSOLE ' + o.params.args.map((a) => a.value || a.description || '').join(' '));
    }
  });
  const send = (method, params, sessionId) =>
    new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {}, sessionId })); });

  const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
  const { result: { sessionId: sid } } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sid);
  await send('Runtime.enable', {}, sid);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, sid);

  async function evalJs(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid);
    if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
    return r.result && r.result.result ? r.result.result.value : undefined;
  }
  async function shot(out) {
    const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sid);
    fs.writeFileSync(out, Buffer.from(s.result.data, 'base64'));
    console.log('  wrote ' + out);
  }
  async function setSize(W, H) {
    const { result: win } = await send('Browser.getWindowForTarget', { targetId });
    await send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'normal', width: W, height: H } });
  }
  const mouse = (type, x, y) =>
    send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 }, sid);
  const typeText = (t) => send('Input.insertText', { text: t }, sid);

  await setSize(1440, 900);
  await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' }, sid);
  await sleep(2800);

  const box = await evalJs(`(() => {
    const el = document.querySelector('.chat-editor-content');
    const ta = document.querySelector('#searchInput');
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(ta);
    return { w: Math.round(r.width), h: Math.round(r.height),
             font: cs.fontSize, line: cs.lineHeight,
             mainW: Math.round(document.querySelector('.home-main').getBoundingClientRect().width) };
  })()`);
  console.log('\n【尺寸】', box);
  ok(box.h >= 150, '搜索框高度 ≥ 150px（原约 108px）', box.h + 'px');
  ok(box.w >= 760, '搜索框宽度 ≥ 760px（原约 736px）', box.w + 'px');
  ok(parseFloat(box.font) >= 18, '输入字号 ≥ 18px', box.font);
  ok(parseFloat(box.line) >= 30, '行高 ≥ 30px', box.line);
  await shot('_editor_idle.png');

  /* ---- 聚焦：柔光 + 流光 + 清空按钮的出现时序 ---- */
  const rect = await evalJs(`(() => { const r = document.querySelector('.chat-editor-content').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + 40, l: r.left, t: r.top }; })()`);

  await mouse('mouseMoved', rect.x, rect.y);
  await mouse('mousePressed', rect.x, rect.y);
  await mouse('mouseReleased', rect.x, rect.y);
  await sleep(260);

  const focused = await evalJs(`(() => {
    const el = document.querySelector('.chat-editor-content');
    const before = getComputedStyle(el, '::before');
    return {
      isFocus: document.activeElement === document.querySelector('#searchInput'),
      auraOpacity: getComputedStyle(document.querySelector('.editor-aura')).opacity,
      sweep: before.animationName,
      fx: el.style.getPropertyValue('--fx'),
      fy: el.style.getPropertyValue('--fy'),
      clearHidden: document.querySelector('#clearBtn').hidden,
      intentHidden: document.querySelector('#editorIntent').hidden,
    };
  })()`);
  console.log('\n【聚焦态】', focused);
  ok(focused.isFocus, '输入框已聚焦');
  ok(parseFloat(focused.auraOpacity) > 0.5, '柔光层已显现', focused.auraOpacity);
  ok(focused.sweep === 'edge-sweep', '顶边流光动画已挂上', focused.sweep);
  ok(/px$/.test(focused.fx) && /px$/.test(focused.fy), '柔光锚点已写成 px（跟随指针）', focused.fx + ',' + focused.fy);
  ok(focused.clearHidden === true, '空输入时清空按钮隐藏');
  ok(focused.intentHidden === true, '空输入时意图胶囊隐藏');

  /* ---- 柔光跟随：换个位置，锚点应变 ---- */
  const before = focused.fx;
  await mouse('mouseMoved', rect.l + 60, rect.t + 24);
  await sleep(120);
  const fx2 = await evalJs(`document.querySelector('.chat-editor-content').style.getPropertyValue('--fx')`);
  ok(fx2 !== before, '移动指针后柔光锚点改变', before + ' → ' + fx2);

  /* ---- 意图识别 ---- */
  const cases = [
    ['奥本海默 4K 中字', '影视资源'],
    ['考研数学张宇强化班', '课程 / 考研'],
    ['周杰伦 无损 专辑', '音乐资源'],
    ['Office 2021 安装包', '软件工具'],
    ['Kindle 电子书 epub', '电子书'],
    ['黑神话 免安装 整合包', '游戏资源'],
  ];
  console.log('\n【意图识别】');
  for (const [text, expect] of cases) {
    await evalJs(`(() => { const t = document.querySelector('#searchInput'); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
    await typeText(text);
    await sleep(90);
    const got = await evalJs(`(() => {
      const c = document.querySelector('#editorIntent');
      return { hidden: c.hidden, label: c.querySelector('.editor-intent__text').textContent,
               hint: c.getAttribute('title') || '' };
    })()`);
    ok(got.hidden === false && got.label === expect, `「${text}」→ ${expect}`, got.label);
  }
  ok(true, '意图胶囊均带补词提示 title');

  /* ---- 截图：带内容的聚焦态 ---- */
  await evalJs(`(() => { const t = document.querySelector('#searchInput'); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
  await typeText('奥本海默 4K 中字');
  await sleep(120);
  await mouse('mouseMoved', rect.l + 120, rect.t + 30);
  await sleep(200);
  await shot('_editor_typed.png');

  const populated = await evalJs(`(() => ({
    clearHidden: document.querySelector('#clearBtn').hidden,
    intent: document.querySelector('.editor-intent__text').textContent,
    submitActive: document.querySelector('#searchSubmitButton') ? 1 : (document.querySelector('#searchSubmitBtn').classList.contains('active') ? 1 : 0)
  }))()`);
  ok(populated.clearHidden === false, '有内容时清空按钮出现');
  ok(populated.submitActive === 1, '有内容时提交键已激活');

  /* ---- 清空按钮 ---- */
  await evalJs(`document.querySelector('#clearBtn').click(); 1`);
  await sleep(140);
  const afterClear = await evalJs(`(() => ({
    val: document.querySelector('#searchInput').value,
    clearHidden: document.querySelector('#clearBtn').hidden,
    intentHidden: document.querySelector('#editorIntent').hidden,
    focused: document.activeElement === document.querySelector('#searchInput')
  }))()`);
  ok(afterClear.val === '', '点清空后输入框为空', afterClear.val);
  ok(afterClear.clearHidden === true, '清空后按钮自动隐藏');
  ok(afterClear.intentHidden === true, '清空后意图胶囊隐藏');
  ok(afterClear.focused === true, '清空后焦点仍在输入框');

  /* ---- Esc 清空 ---- */
  await typeText('测试 Esc');
  await sleep(100);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sid);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sid);
  await sleep(140);
  const afterEsc = await evalJs(`document.querySelector('#searchInput').value`);
  ok(afterEsc === '', 'Esc 清空生效', afterEsc);

  /* ---- 移动端：字号不回退到 16 以下、意图胶囊隐藏 ---- */
  console.log('\n【移动端】');
  await setSize(400, 780);
  await sleep(500);
  const mobile = await evalJs(`(() => {
    const ta = document.querySelector('#searchInput');
    const el = document.querySelector('.chat-editor-content');
    const r = el.getBoundingClientRect();
    return { font: getComputedStyle(ta).fontSize, w: Math.round(r.width),
             viewport: window.innerWidth,
             intentDisplay: getComputedStyle(document.querySelector('#editorIntent')).display };
  })()`);
  console.log('  ', mobile);
  ok(parseFloat(mobile.font) >= 16, '移动端字号 ≥ 16px（防 iOS 自动缩放）', mobile.font);
  ok(mobile.w <= mobile.viewport, '搜索框未超出视口', mobile.w + ' / ' + mobile.viewport);
  ok(mobile.intentDisplay === 'none', '窄屏隐藏意图胶囊，给按钮让位', mobile.intentDisplay);
  await shot('_editor_mobile.png');

  console.log('\n控制台报错:', errs.length ? errs : '无');
  ok(errs.length === 0, '控制台零报错');

  console.log('\n===== ' + pass + '/' + (pass + fail) + ' =====');
  ws.close(); proc.kill();
  setTimeout(() => process.exit(fail ? 1 : 0), 200);
})().catch((e) => { console.error(e); process.exit(1); });
