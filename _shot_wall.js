/**
 * 壁纸系统专项截图 + 自检。
 * 用法: node _shot_wall.js
 *
 * 除截图外，顺带断言两件容易静默出错的事：
 *   1. 固定定位是否被 backdrop-filter 的包含块吃掉（offsetParent 应为 null）
 *   2. 控制台有无报错
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
    http
      .get(u, (r) => {
        let d = '';
        r.on('data', (c) => (d += c));
        r.on('end', () => res(d));
      })
      .on('error', rej);
  });

(async () => {
  const cport = 9700 + Math.floor(Math.random() * 40);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-wall-'));
  const proc = spawn(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--hide-scrollbars',
      '--remote-debugging-port=' + cport,
      '--user-data-dir=' + prof,
      '--window-size=1920,1000',
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
  const consoleErrors = [];

  ws.on('message', (m) => {
    const o = JSON.parse(m);
    if (o.id && pend.has(o.id)) {
      pend.get(o.id)(o);
      pend.delete(o.id);
    }
    if (o.method === 'Runtime.exceptionThrown') {
      const d = o.params.exceptionDetails;
      consoleErrors.push('EXC: ' + (d.exception && d.exception.description ? d.exception.description : d.text));
    }
    if (o.method === 'Runtime.consoleAPICalled' && o.params.type === 'error') {
      consoleErrors.push(
        'CONSOLE: ' + o.params.args.map((a) => a.value || a.description || '').join(' ')
      );
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
  await send(
    'Emulation.setEmulatedMedia',
    { features: [{ name: 'prefers-color-scheme', value: 'light' }] },
    sid
  );

  async function evalJs(expr) {
    const r = await send(
      'Runtime.evaluate',
      { expression: expr, returnByValue: true, awaitPromise: true },
      sid
    );
    if (r.result && r.result.exceptionDetails) {
      return { error: r.result.exceptionDetails.text };
    }
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

  /* ---- 1. 打开首页 ---- */
  await setSize(1440, 900);
  await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' }, sid);
  await sleep(2800);

  const boot = await evalJs(`(() => {
    const d = document.querySelector('.wall-drawer');
    const dock = document.querySelector('.wall-dock');
    const stage = document.querySelector('.wall-stage');
    const onLayer = document.querySelector('.wall-layer.is-on');
    return {
      壁纸已启用: document.documentElement.dataset.wall,
      tone: document.documentElement.dataset.wallTone,
      舞台存在: !!stage,
      当前层背景: onLayer ? (onLayer.style.backgroundImage || '').slice(0, 80) : '(无)',
      抽屉fixed正常: d ? d.offsetParent === null : '抽屉未创建',
      胶囊fixed正常: dock ? dock.offsetParent === null : '胶囊未创建',
      缩略图数量: dock ? dock.querySelectorAll('.wall-thumb').length : 0,
      抽屉卡片数: d ? d.querySelectorAll('.wall-card').length : 0,
      body背景: getComputedStyle(document.body).backgroundColor,
      文字色: getComputedStyle(document.body).color
    };
  })()`);
  console.log('\n=== 启动自检 ===');
  console.log(JSON.stringify(boot, null, 2));

  await shot('_wall_home_light.png');

  /* ---- 2. 切到暗色壁纸（星月夜） ---- */
  await evalJs("window.ZSearchWall && window.ZSearchWall.set('w05')");
  await sleep(1900);
  const dark = await evalJs(`(() => {
    return {
      tone: document.documentElement.dataset.wallTone,
      文字色: getComputedStyle(document.body).color,
      卡片背景: getComputedStyle(document.querySelector('.chat-editor-content')).backgroundColor
    };
  })()`);
  console.log('\n=== 切换暗壁纸后 ===');
  console.log(JSON.stringify(dark, null, 2));
  await shot('_wall_home_dark.png');

  /* ---- 3. 打开抽屉 ---- */
  await evalJs('window.ZSearchWall && window.ZSearchWall.open()');
  await sleep(1500);
  const drawerState = await evalJs(`(() => {
    const d = document.querySelector('.wall-drawer');
    const r = d.getBoundingClientRect();
    return {
      抽屉可见: d.classList.contains('is-open'),
      抽屉右边界: Math.round(r.right),
      视口宽: window.innerWidth,
      抽屉位置正确: Math.round(r.right) <= window.innerWidth + 1
    };
  })()`);
  console.log('\n=== 抽屉 ===');
  console.log(JSON.stringify(drawerState, null, 2));
  await shot('_wall_drawer.png');

  /* ---- 4. 结果页（保持同一壁纸，验证跨页一致性） ---- */
  await setSize(1440, 900);
  await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/search?q=' + encodeURIComponent('考研') }, sid);
  await sleep(13000);
  const results = await evalJs(`(() => {
    const items = document.querySelectorAll('.result-item');
    const first = items[0];
    const trigger = document.querySelector('.wall-trigger');
    const dock = document.querySelector('.wall-dock');
    const dockRect = dock ? dock.getBoundingClientRect() : null;
    return {
      tone: document.documentElement.dataset.wallTone,
      结果条数: items.length,
      首条背景: first ? getComputedStyle(first).backgroundColor : '(无)',
      首条文字色: first ? getComputedStyle(first.querySelector('.result-title') || first).color : '(无)',
      外观按钮已挂载: !!trigger,
      壁纸层仍在: !!document.querySelector('.wall-layer.is-on'),
      胶囊存在: !!dock,
      胶囊矩形: dockRect ? {
        top: Math.round(dockRect.top), bottom: Math.round(dockRect.bottom),
        left: Math.round(dockRect.left), right: Math.round(dockRect.right)
      } : null,
      视口高: window.innerHeight,
      胶囊被遮挡: dock ? (() => {
        const r = dock.getBoundingClientRect();
        const cx = Math.round(r.left + r.width / 2);
        const cy = Math.round(r.top + r.height / 2);
        const el = document.elementFromPoint(cx, cy);
        return el ? (el.closest('.wall-dock') ? false : el.className || el.tagName) : '无元素';
      })() : '无胶囊'
    };
  })()`);
  console.log('\n=== 结果页 ===');
  console.log(JSON.stringify(results, null, 2));
  await shot('_wall_results.png');

  /* ---- 5. 移动端 ---- */
  await evalJs('window.ZSearchWall && window.ZSearchWall.close()');
  await evalJs("window.ZSearchWall && window.ZSearchWall.set('w07')");
  await sleep(1800);
  await setSize(420, 860);
  await sleep(900);
  const mobile = await evalJs(`(() => {
    const dock = document.querySelector('.wall-dock');
    const r = dock.getBoundingClientRect();
    return {
      胶囊不超出视口: r.left >= -1 && r.right <= window.innerWidth + 1,
      胶囊宽度: Math.round(r.width),
      视口: window.innerWidth
    };
  })()`);
  console.log('\n=== 移动端 ===');
  console.log(JSON.stringify(mobile, null, 2));
  await shot('_wall_home_mobile.png');

  console.log('\n=== 控制台错误 ===');
  console.log(consoleErrors.length ? consoleErrors.join('\n') : '无');

  ws.close();
  proc.kill();
  try {
    fs.rmSync(prof, { recursive: true, force: true });
  } catch (e) {}
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
