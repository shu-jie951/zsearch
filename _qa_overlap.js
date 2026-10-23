/**
 * 重叠 bug 专项验证（本轮修复项）。
 * 用法: node _qa_overlap.js   （需要 5178 上有服务，且需要 ws）
 *
 * 覆盖两个用户报的真实问题：
 *
 * A. 打字框字体重叠
 *    根因：幽灵提示层只在 focus/blur 时重绘，input 事件没调它。
 *    用户一敲字，提示文本留在原地，和真实输入叠成两层。
 *    另外还有个假光标 .ghost-caret 和 textarea 真光标叠在一起。
 *
 * B. 壁纸图片重叠（重影）
 *    根因：交叉淡入时旧层全程 opacity:1，等新层淡满才瞬间归零，
 *    中间 880ms 两张全屏照片是"叠加"而不是"交叉"。
 *
 * 这两类 bug 语法都对、静态检查也拦不住，只能靠运行时采样断言。
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
  // ---------- 静态：确认全站已无玻璃 ----------
  console.log('\n=== 1. 玻璃特效已移除（静态）===');
  {
    const cssDir = 'public/static/css';
    let hits = [];
    for (const fn of fs.readdirSync(cssDir)) {
      if (!fn.endsWith('.css')) continue;
      const lines = fs.readFileSync(path.join(cssDir, fn), 'utf8').split('\n');
      lines.forEach((ln, i) => {
        const s = ln.trim();
        if (/^[^*/]*backdrop-filter\s*:/.test(s) && !s.startsWith('*') && !s.startsWith('/*')) {
          hits.push(fn + ':' + (i + 1) + ' ' + s.slice(0, 50));
        }
      });
    }
    ok(hits.length === 0, 'CSS 里没有任何 backdrop-filter 声明', hits.slice(0, 3));
  }

  // ---------- 浏览器 ----------
  const cport = 9700 + Math.floor(Math.random() * 60);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-overlap-'));
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
  async function waitFor(expr, timeout, step) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { if (await evalJs(expr)) return true; } catch (e) {}
      await sleep(step || 120);
    }
    return false;
  }

  await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' }, sid);
  await sleep(2600);

  // ==================================================================
  console.log('\n=== 2. 打字框字体重叠 ===');
  // ==================================================================
  {
    const built = await evalJs(`(() => {
      const ta = document.querySelector('#searchInput');
      const gh = document.querySelector('#ghostOverlay');
      return { ta: !!ta, gh: !!gh, cls: gh ? gh.className : null };
    })()`);
    ok(built.ta && built.gh, '输入框与提示层都存在', built);

    // 聚焦空框 → 提示层应该出现文本（打字机或首条示例）
    await evalJs(`document.querySelector('#searchInput').focus()`);
    const ghostShown = await waitFor(
      `(document.querySelector('#ghostOverlay').textContent || '').trim().length > 0`,
      4000, 120
    );
    ok(ghostShown, '聚焦空框时提示层有内容（示例提示可用）',
      await evalJs(`(document.querySelector('#ghostOverlay').textContent||'').slice(0,20)`));

    // 假光标必须已经不存在
    const fakeCaret = await evalJs(`document.querySelectorAll('.ghost-caret').length`);
    ok(fakeCaret === 0, '不存在假光标元素（不会和真光标叠在一起）', fakeCaret);

    // 关键断言：一旦有真实输入，提示层必须清空
    await evalJs(`(() => {
      const ta = document.querySelector('#searchInput');
      ta.value = '奥本海默';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(220);
    const ghostAfter = await evalJs(`(document.querySelector('#ghostOverlay').textContent || '').trim()`);
    ok(ghostAfter === '', '有输入时提示层立刻清空（这是叠字的根因）', ghostAfter);

    // 多行输入同样不能留下提示
    await evalJs(`(() => {
      const ta = document.querySelector('#searchInput');
      ta.value = '第一行很长很长的关键词测试文本\\n第二行继续写一些内容\\n第三行';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(220);
    const ghostMulti = await evalJs(`(document.querySelector('#ghostOverlay').textContent || '').trim()`);
    ok(ghostMulti === '', '多行输入时提示层仍为空', ghostMulti);

    // 两层文字不能同时可见：要么提示层为空，要么输入框为空
    const both = await evalJs(`(() => {
      const ta = document.querySelector('#searchInput');
      const gh = document.querySelector('#ghostOverlay');
      const ghTxt = (gh.textContent || '').trim();
      return !!ta.value.trim() && !!ghTxt;
    })()`);
    ok(!both, '「有输入」与「有提示文本」不会同时成立', both);

    // 清空后提示应该能回来（说明不是"一劳永逸地关掉"）
    await evalJs(`(() => {
      const ta = document.querySelector('#searchInput');
      ta.value = '';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.focus();
    })()`);
    await sleep(400);
    const ghostBack = await waitFor(
      `(document.querySelector('#ghostOverlay').textContent || '').trim().length > 0`,
      4000, 120
    );
    ok(ghostBack, '清空后提示层能恢复（功能没被修坏）');

    // 提示层与输入层必须像素级对齐（padding/字号/行高一致），否则看着就是错位
    const align = await evalJs(`(() => {
      const ta = document.querySelector('#searchInput');
      const gh = document.querySelector('#ghostOverlay');
      const a = getComputedStyle(ta), b = getComputedStyle(gh);
      const ra = ta.getBoundingClientRect(), rb = gh.getBoundingClientRect();
      return {
        fontSame: a.fontSize === b.fontSize,
        lineSame: a.lineHeight === b.lineHeight,
        padSame: a.paddingLeft === b.paddingLeft && a.paddingTop === b.paddingTop,
        leftSame: Math.abs(ra.left - rb.left) < 1,
        topSame: Math.abs(ra.top - rb.top) < 1,
        font: a.fontSize, line: a.lineHeight
      };
    })()`);
    ok(align.fontSame && align.lineSame, '提示层与输入层字号/行高一致', align);
    ok(align.padSame && align.leftSame && align.topSame, '两层起始位置完全重合（不会错位）', align);
  }

  // ==================================================================
  console.log('\n=== 3. 壁纸重叠（重影）===');
  // ==================================================================
  {
    const hasLayers = await evalJs(`document.querySelectorAll('.wall-layer').length`);
    ok(hasLayers === 2, '壁纸是双层的（交叉淡入需要）', hasLayers);

    // 取当前壁纸 id，换成另一张
    const before = await evalJs(`(() => {
      const on = Array.from(document.querySelectorAll('.wall-layer')).findIndex(l => l.classList.contains('is-on'));
      const other = document.querySelectorAll('.wall-layer')[1 - on] ? 0 : 0;
      return { on: on };
    })()`);
    ok(before.on >= 0, '切换前有一层处于显示态', before);

    // 触发切换：优先用暴露的接口，退回点缩略图
    const switched = await evalJs(`(() => {
      const list = (window.ZSearchWall && window.ZSearchWall.list) ? window.ZSearchWall.list() : [];
      if (!list.length) return 'no-api';
      const cur = list.find(w => document.querySelector('.wall-dock') && true);
      // 随便挑一张和当前不同的
      const curId = document.documentElement.dataset.wallId || '';
      const target = list.find(w => w.id !== curId) || list[0];
      window.ZSearchWall.set(target.id);
      return target.id;
    })()`);
    ok(switched !== 'no-api', '能触发壁纸切换', switched);

    // 采样中间态：真正的交叉淡入，两层都不该是"满格"
    // 旧写法会在中间出现 old=1（全亮叠加）→ 就是用户看到的重影
    let maxOld = 0, maxNew = 0, samples = [];
    for (let i = 0; i < 8; i++) {
      await sleep(90);
      const s = await evalJs(`(() => {
        const ls = Array.from(document.querySelectorAll('.wall-layer'));
        return ls.map(l => parseFloat(getComputedStyle(l).opacity) || 0);
      })()`);
      if (Array.isArray(s) && s.length === 2) {
        samples.push(s);
        const sorted = s.slice().sort((a, b) => b - a);
        maxOld = Math.max(maxOld, sorted[0]);
        maxNew = Math.max(maxNew, sorted[1]);
      }
    }
    // 中间态里「较亮的那层」不应该一直保持 1（说明旧层在淡出）
    const oldStayedFull = samples.length > 0 && samples.slice(1, 6).every((s) => Math.max(s[0], s[1]) > 0.99);
    ok(!oldStayedFull, '切换过程中旧层确实在淡出（不是全亮叠加）', samples.slice(0, 4));

    // 切换结束后必须只剩一层可见
    await sleep(900);
    const after = await evalJs(`(() => {
      const ls = Array.from(document.querySelectorAll('.wall-layer'));
      return ls.map(l => parseFloat(getComputedStyle(l).opacity) || 0);
    })()`);
    const visible = after.filter((o) => o > 0.5).length;
    ok(visible === 1, '切换结束后只有一层可见（不会残留半透明叠影）', after);
    const halfVisible = after.filter((o) => o > 0.02 && o < 0.98).length;
    ok(halfVisible === 0, '没有卡在中间透明度的层', after);

    // 降级标记必须已经撤掉（否则噪点层一直是关的）
    const fading = await evalJs(`document.documentElement.dataset.wallFading || ''`);
    ok(fading === '', '切换结束后运行时降级已撤销', fading);
  }

  // ==================================================================
  console.log('\n=== 4. 背景固定 / 光斑跟随 ===');
  // ==================================================================
  {
    // 2026-10-23 起：整图随鼠标位移的视差已删除，背景**完全静止**，
    // "动"的职责交给 900×900 的柔光斑（.wall-light）。
    // 所以这一节的断言整体反过来：壁纸层的位移必须**始终为 0**，
    // 能不能"活"由光斑的 transform 来证明。
    const readLayerTf = async () => evalJs(`(() => {
      const l = document.querySelector('.wall-layer.is-on') || document.querySelector('.wall-layer');
      const t = getComputedStyle(l).transform;
      const m = t.match(/matrix\\(([^)]+)\\)/);
      if (!m) return { raw: t, tx: 0, ty: 0 };
      const v = m[1].split(',').map(Number);
      return { raw: t, tx: v.length === 6 ? v[4] : 0, ty: v.length === 6 ? v[5] : 0 };
    })()`);

    const readLightTf = async () => evalJs(`(() => {
      const l = document.querySelector('.wall-light');
      if (!l) return null;
      const cs = getComputedStyle(l);
      const m = cs.transform.match(/matrix\\(([^)]+)\\)/);
      const v = m ? m[1].split(',').map(Number) : null;
      return {
        live: l.classList.contains('is-live'),
        opacity: cs.opacity,
        raw: cs.transform,
        tx: v && v.length === 6 ? v[4] : 0,
        ty: v && v.length === 6 ? v[5] : 0,
      };
    })()`);

    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 200, y: 200, button: 'none' }, sid);
    await sleep(300);
    const b1 = await readLayerTf();
    const l1 = await readLightTf();

    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1300, y: 760, button: 'none' }, sid);
    await sleep(600);
    const b2 = await readLayerTf();
    const l2 = await readLightTf();

    // ★ 核心不变式：背景固定
    ok(b1.raw === b2.raw && b1.tx === 0 && b1.ty === 0 && b2.tx === 0 && b2.ty === 0,
      '★ 鼠标移动不推动背景（壁纸层位移恒为 0）', { b1: b1.raw, b2: b2.raw });

    // 光斑必须真的跟着走，否则"高级感"就成了空话
    ok(!!l2 && l2.live && l2.opacity === '1', '指针移动后光斑亮起', l2 && l2.opacity);
    ok(!!l2 && (l1.tx !== l2.tx || l1.ty !== l2.ty), '光斑随指针移动', { l1: [l1.tx, l1.ty], l2: [l2.tx, l2.ty] });

    // 光斑落点要跟指针同向（是"跟随"，不是"反向视差"）
    ok(!!l2 && l2.tx > l1.tx && l2.ty > l1.ty, '光斑位移方向与指针一致（跟随而非反向）', { l1: [l1.tx, l1.ty], l2: [l2.tx, l2.ty] });

    // 尺寸受控：整屏合成会把这项省下来的性能又还回去
    const size = await evalJs(`(() => {
      const l = document.querySelector('.wall-light');
      if (!l) return null;
      const r = l.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    })()`);
    ok(!!size && size.w <= 1000 && size.h <= 1000, '光斑尺寸受控（≤1000px，不做整屏合成）', size);
  }

  await sleep(300);
  ok(errs.length === 0, '控制台零报错', errs.slice(0, 3));

  ws.close();
  try { proc.kill(); } catch (e) {}
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}

  console.log('\n================================================');
  console.log('  重叠 bug 专项：通过 ' + pass + ' / ' + (pass + fail));
  console.log('================================================');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('脚本异常:', e);
  process.exit(1);
});
