/**
 * 壁纸切换「运行时降级」的确定性验证。
 * 用法: node _verify_fade.js
 *
 * _perf_wall.js 量的是时间，而时间在这台机器上会被环境（无头 SwiftShader /
 * 窗口被遮住时的 rAF 节流）带偏。这个脚本不量时间，只断言"切换途中"和
 * "切换结束后"两套计算样式是否符合预期 —— 这是确定的、可重复的。
 *
 * 断言矩阵：
 *   途中   卡片/顶栏 backdrop-filter = none       （降级生效）
 *   途中   壁纸层 will-change = opacity           （提升为合成层）
 *   途中   噪点层 opacity = 0                     （混合模式停摆）
 *   途中   html[data-wall-fading] 存在
 *   结束后 上述三项全部复原
 *   全程   壁纸层 transition 只含 opacity，不含 filter / transform
 *   全程   控制台无报错
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

let pass = 0;
let fail = 0;
const ok = (cond, label, extra) => {
  if (cond) {
    pass++;
    console.log('  ✓ ' + label);
  } else {
    fail++;
    console.log('  ✗ ' + label + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
  }
};

(async () => {
  const cport = 9900 + Math.floor(Math.random() * 60);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-fade-'));
  const proc = spawn(
    EDGE,
    [
      '--headless=new',
      '--no-first-run',
      '--hide-scrollbars',
      '--remote-debugging-port=' + cport,
      '--user-data-dir=' + prof,
      '--window-size=1440,900',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  let ver = null;
  for (let i = 0; i < 80; i++) {
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
  const errs = [];
  ws.on('message', (m) => {
    const o = JSON.parse(m);
    if (o.id && pend.has(o.id)) {
      pend.get(o.id)(o);
      pend.delete(o.id);
    }
    if (o.method === 'Runtime.exceptionThrown') {
      const d = o.params.exceptionDetails;
      errs.push('EXC ' + (d.exception ? d.exception.description : d.text));
    }
    if (o.method === 'Runtime.consoleAPICalled' && o.params.type === 'error') {
      errs.push('CONSOLE ' + o.params.args.map((a) => a.value || a.description || '').join(' '));
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
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid);
    if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
    return r.result && r.result.result ? r.result.result.value : undefined;
  }
  async function shot(out) {
    const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sid);
    fs.writeFileSync(out, Buffer.from(s.result.data, 'base64'));
  }

  await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' }, sid);
  await sleep(3200);

  const SAMPLE = `(() => {
    const cs = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el) : null; };
    const card = cs('.chat-editor-content');
    const pill = cs('.status-pill');
    const layers = [...document.querySelectorAll('.wall-layer')].map(el => {
      const s = getComputedStyle(el);
      return { wc: s.willChange, tr: s.transition.split(',')[0].trim(), trAll: s.transition, flt: s.filter };
    });
    const grain = cs('.wall-grain');
    const bd = cs('body');
    return {
      fading: document.documentElement.dataset.wallFading || null,
      cardBd: card ? (card.backdropFilter || card.webkitBackdropFilter) : '(no el)',
      pillBd: pill ? (pill.backdropFilter || pill.webkitBackdropFilter) : '(no el)',
      grainOpacity: grain ? grain.opacity : '(no el)',
      grainBlend: grain ? grain.mixBlendMode : '(no el)',
      layers,
      bodyTransition: bd ? bd.transition : ''
    };
  })()`;

  const rest = await evalJs(SAMPLE);

  console.log('\n【静止态】');
  ok(rest.fading === null, '没有 data-wall-fading 残留');
  // 2026-10-21 需求变更：全站去掉玻璃特效，改为雾面实色。
  // 断言从"有模糊"翻转为"任何状态下都没有模糊" —— 这条现在比以前更严：
  // 以前只要求静止态有 blur，现在要求静止/切换/结束三态都必须是 none。
  ok(rest.cardBd === 'none', '搜索框没有 backdrop-filter（已改雾面实色）', rest.cardBd);
  ok(rest.pillBd === 'none', '顶栏胶囊没有 backdrop-filter', rest.pillBd);
  ok(Math.abs(parseFloat(rest.grainOpacity) - 0.05) < 0.02, '噪点层 opacity ≈ 0.05（压到几乎不可见）', rest.grainOpacity);
  ok(rest.grainBlend === 'overlay', '噪点层保持 overlay 混合', rest.grainBlend);
  ok(rest.layers[0].wc !== 'opacity', '壁纸层平时不留 will-change', rest.layers[0].wc);
  ok(
    rest.layers.every((l) => /opacity/.test(l.trAll) && !/filter/.test(l.trAll) && !/transform/.test(l.trAll)),
    '壁纸层 transition 只含 opacity',
    rest.layers.map((l) => l.trAll)
  );
  // 注意不能用 /\bcolor\b/ 判：background-color 里的 color 前面就是连字符，
  // 词边界照样成立，会误报。只认「逗号后 / 开头」的独立 color 项。
  ok(!/(^|,\s*)color\s/.test(rest.bodyTransition), 'body 不再过渡 color', rest.bodyTransition);
  ok(
    rest.layers.every((l) => !/blur\(/.test(l.flt)),
    '模糊为 0 时 filter 链里不含 blur()',
    rest.layers.map((l) => l.flt)
  );
  ok(
    rest.layers.every((l) => /saturate/.test(l.flt) && /brightness/.test(l.flt)),
    '调色链仍在（saturate + brightness）',
    rest.layers.map((l) => l.flt)
  );

  /* ---- 模糊滑杆 > 0 时，blur() 必须回到 filter 链里 ---- */
  const blurOn = await evalJs(`(() => {
    const box = document.querySelector('.wall-drawer');
    const sl = document.querySelector('#wallBlur');
    if (!sl) return { err: 'no #wallBlur' };
    sl.value = String(8);
    sl.dispatchEvent(new Event('input', { bubbles: true }));
    return { val: sl.value };
  })()`);
  await sleep(120);
  const withBlur = await evalJs(SAMPLE);
  ok(/blur\(8px\)/.test(withBlur.layers[0].flt), '模糊滑杆拉到 8 时 filter 含 blur(8px)', withBlur.layers[0].flt);

  // 复位，避免影响后面的截图与连点测试
  await evalJs(`(() => {
    const sl = document.querySelector('#wallBlur');
    if (sl) { sl.value = '0'; sl.dispatchEvent(new Event('input', { bubbles: true })); }
    return 1;
  })()`);
  await sleep(120);
  const reset = await evalJs(SAMPLE);
  ok(!/blur\(/.test(reset.layers[0].flt), '模糊复位后 blur() 已从 filter 链移除', reset.layers[0].flt);

  /* ---- 切到 w07（与当前 w02 跨 tone），在淡入途中采样 ---- */
  console.log('\n【切换途中（+420ms）】');
  await evalJs("window.ZSearchWall.set('w07'); 1");
  await sleep(420);
  const mid = await evalJs(SAMPLE);
  ok(mid.fading === '1', 'data-wall-fading 已挂上', mid.fading);
  ok(mid.cardBd === 'none', '搜索框切换途中依然没有 backdrop-filter', mid.cardBd);
  ok(mid.pillBd === 'none', '顶栏胶囊切换途中依然没有 backdrop-filter', mid.pillBd);
  ok(mid.grainOpacity === '0', '噪点层已淡到 0', mid.grainOpacity);
  ok(mid.grainBlend === 'overlay', '混合模式未改（只动 opacity）', mid.grainBlend);
  ok(mid.layers.every((l) => l.wc === 'opacity'), '壁纸层已提升为合成层', mid.layers.map((l) => l.wc));
  await shot(path.join(__dirname, 'preview-fade-mid.png'));

  /* ---- 淡入结束后必须完全复原 ---- */
  console.log('\n【切换结束后（+1800ms）】');
  await sleep(1800);
  const after = await evalJs(SAMPLE);
  ok(after.fading === null, 'data-wall-fading 已摘除', after.fading);
  ok(after.cardBd === 'none', '结束后仍未引入 backdrop-filter（不会"恢复"出玻璃）', after.cardBd);
  ok(Math.abs(parseFloat(after.grainOpacity) - 0.05) < 0.02, '噪点层已恢复（0.05）', after.grainOpacity);
  ok(after.layers.every((l) => l.wc !== 'opacity'), '壁纸层已释放 will-change', after.layers.map((l) => l.wc));
  await shot(path.join(__dirname, 'preview-fade-done.png'));

  /* ---- 连点：快速切三次，确认不会把降级状态漏掉 ---- */
  console.log('\n【快速连点三次】');
  await evalJs(
    "window.ZSearchWall.set('w03'); setTimeout(() => window.ZSearchWall.set('w08'), 90);" +
      "setTimeout(() => window.ZSearchWall.set('w05'), 180); 1"
  );
  await sleep(240);
  const rapid = await evalJs(SAMPLE);
  ok(rapid.fading === '1', '连点期间降级仍开着', rapid.fading);
  await sleep(1700);
  const settled = await evalJs(SAMPLE);
  ok(settled.fading === null, '连点结束后降级已摘除', settled.fading);
  const finalWall = await evalJs(
    "(() => { const el = document.querySelector('.wall-layer.is-on'); return el ? el.style.backgroundImage : ''; })()"
  );
  ok(/05\.webp/.test(finalWall), '最终停在最后点的那张（w05）', finalWall);

  console.log('\n控制台报错:', errs.length ? errs : '无');
  ok(errs.length === 0, '控制台零报错');

  console.log('\n===== ' + pass + '/' + (pass + fail) + ' =====');
  ws.close();
  proc.kill();
  setTimeout(() => process.exit(fail ? 1 : 0), 200);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
