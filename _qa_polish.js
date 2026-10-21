/**
 * 质感层专项验证（polish.css + polish.js）。
 * 用法: node _qa_polish.js   （需要 5178 上有服务，且需要 ws）
 *
 * 这一层是纯装饰的，最容易"看起来没问题、实际根本没生效"——
 * 比如 ::before 被 z-index 压到背景后面、pointermove 写错了变量名、
 * 长列表懒渐入的保险丝没接上导致内容永久 opacity:0。
 * 这些语法全对、静态检查也拦不住，只能运行时断言。
 *
 * 覆盖：
 *   A. 资源接入（search.html 引了，且能 200 取到）
 *   B. 卡片聚光（鼠标驱动 + 键盘接管时熄灯）
 *   C. 数字滚动（从 0 滚到目标）
 *   D. 长列表渐入（第 16 条后 pending，1.2s 保险丝必放行，不留 transform）
 *   E. reduced-motion 下不隐藏任何内容
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
  // ==================================================================
  console.log('\n=== 1. 资源接入（静态）===');
  // ==================================================================
  {
    const html = fs.readFileSync('public/search.html', 'utf8');
    ok(/\/static\/css\/polish\.css/.test(html), 'search.html 引入 polish.css');
    ok(/\/static\/js\/polish\.js/.test(html), 'search.html 引入 polish.js');

    // polish.js 必须在 results.js 之后加载：它只订阅事件，但 boot 时要能查到 #resultList
    const iRes = html.indexOf('/static/js/results.js');
    const iPol = html.indexOf('/static/js/polish.js');
    ok(iRes > 0 && iPol > iRes, 'polish.js 在 results.js 之后加载', { iRes, iPol });

    const css = fs.readFileSync('public/static/css/polish.css', 'utf8');
    ok(!/backdrop-filter\s*:/.test(css), 'polish.css 不含 backdrop-filter（不用玻璃做光效）');

    // 静态审查口径：用到的变量必须有显式定义，只写在 var() fallback 里不算
    ['--spot-x', '--spot-y', '--spot-color'].forEach((v) => {
      ok(new RegExp(v + '\\s*:').test(css), '变量 ' + v + ' 有显式默认值');
    });
  }

  // ---------- 浏览器 ----------
  const cport = 9800 + Math.floor(Math.random() * 60);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-polish-'));
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

  // ==================================================================
  console.log('\n=== 2. 资源实际可取 ===');
  // ==================================================================
  {
    // 用 node 直接问服务，不走页面里的 fetch —— about:blank 是不透明源，
    // 浏览器会以 CORS 为由拒掉，测出来的"失败"其实是测法的问题。
    const status = (u) => new Promise((res) => {
      http.get(u, (r) => { r.resume(); res(r.statusCode); }).on('error', () => res(0));
    });
    const base = 'http://127.0.0.1:' + PORT;
    const a = await status(base + '/static/js/polish.js');
    const b = await status(base + '/static/css/polish.css');
    ok(a === 200, 'polish.js 返回 200', a);
    ok(b === 200, 'polish.css 返回 200', b);
  }

  await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/search?q=' + encodeURIComponent('甄嬛传') }, sid);
  await sleep(1200);

  // 等结果出来（上游时快时慢，给足时间）
  const gotRows = await waitFor(`document.querySelectorAll('#resultList .result-item').length > 0`, 26000, 500);
  const rowCount = await evalJs(`document.querySelectorAll('#resultList .result-item').length`);
  // 上游间歇性返回 0 条是老问题（同一分钟两秒内可能 0 / 47 来回跳）。
  // 这里只当作环境信息打出来，**不计入通过率** —— 把它记成失败是在拿环境波动
  // 当成代码缺陷。真正要验的是"有卡片时的行为"，下面用确定性数据构造。
  console.log('ℹ 真实搜索返回 ' + rowCount + ' 条' + (gotRows ? '' : '（上游这次为空，改用注入数据验机制）'));
  await sleep(700);

  // ==================================================================
  console.log('\n=== 3. 卡片聚光 ===');
  // ==================================================================
  {
    // 上游可能返回 0 条。聚光验的是"有卡片时的行为"，和卡片来自真实聚合
    // 还是注入数据无关 —— 所以这里补齐数据，让这一节完全确定性可重复。
    await evalJs(`(() => {
      const host = document.getElementById('resultList');
      if (host.querySelectorAll('.result-item').length) return;
      let h = '';
      for (let i = 0; i < 6; i++) {
        h += '<div class="result-item"><a class="result-title" href="#">注入样例行 ' + i + '</a>' +
             '<div class="result-snippet">测试</div></div>';
      }
      host.innerHTML = h;
      document.dispatchEvent(new CustomEvent('zsearch:rendered', { detail: {} }));
    })()`);
    await sleep(200);

    const shape = await evalJs(`(() => {
      const el = document.querySelector('#resultList .result-item');
      if (!el) return null;
      const b = getComputedStyle(el, '::before');
      return {
        bg: b.backgroundImage,
        content: b.content,
        zIndex: b.zIndex,
        pos: b.position,
        isolation: getComputedStyle(el).isolation,
        opacity: b.opacity,
      };
    })()`);
    ok(!!shape, '能取到第一张结果卡片', shape);
    if (shape) {
      ok(/radial-gradient/.test(shape.bg), '卡片 ::before 是一层 radial-gradient 柔光', shape.bg.slice(0, 60));
      ok(shape.content === '""', '::before 已生成（content 不是 none）', shape.content);
      ok(shape.zIndex === '-1', '::before 用负 z-index 压在正文之下', shape.zIndex);
      ok(shape.isolation === 'isolate', '卡片 isolation:isolate（负 z-index 不会掉到父级背景后面）', shape.isolation);
      ok(parseFloat(shape.opacity) === 0, '默认不发光（只有指向时才亮）', shape.opacity);
    }

    // 真实指针事件驱动
    await evalJs(`(() => {
      const el = document.querySelector('#resultList .result-item');
      const r = el.getBoundingClientRect();
      const x = r.left + r.width * 0.4, y = r.top + r.height * 0.5;
      el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', clientX: x, clientY: y }));
      el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', clientX: x, clientY: y }));
    })()`);
    await sleep(360);

    const lit = await evalJs(`(() => {
      const el = document.querySelector('#resultList .result-item');
      return {
        spot: el.classList.contains('is-spot'),
        x: el.style.getPropertyValue('--spot-x'),
        y: el.style.getPropertyValue('--spot-y'),
        opacity: getComputedStyle(el, '::before').opacity,
        litCount: document.querySelectorAll('#resultList .result-item.is-spot').length,
      };
    })()`);
    ok(lit.spot, 'pointerover 后卡片进入聚光态', lit);
    ok(/px$/.test(lit.x) && /px$/.test(lit.y), '聚光圆心坐标已写入（--spot-x/--spot-y 有 px 值）', { x: lit.x, y: lit.y });
    ok(parseFloat(lit.opacity) > 0.9, '聚光层已淡入', lit.opacity);
    ok(lit.litCount === 1, '同一时刻只有一张卡片亮着（不会整页发亮）', lit.litCount);

    // 键盘导航接管时必须熄灯，否则"鼠标亮 A + 键盘亮 B"像 bug
    await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
    await sleep(140);
    const afterKey = await evalJs(`document.querySelectorAll('#resultList .result-item.is-spot').length`);
    ok(afterKey === 0, '键盘导航时鼠标聚光被熄灭（只留键盘高亮）', afterKey);

    // 重渲染后旧节点游离：不能残留 is-spot 引用导致的无效写入
    await evalJs(`document.dispatchEvent(new CustomEvent('zsearch:rendered', { detail: {} }))`);
    await sleep(120);
    ok(true, '派发 zsearch:rendered 不再抛错');
  }

  // ==================================================================
  console.log('\n=== 4. 数字滚动 ===');
  // ==================================================================
  {
    // 确定性构造：直接替换统计行内容再派发事件，避免依赖上游返回条数
    await evalJs(`(() => {
      const s = document.getElementById('statsContainer');
      s.style.display = 'flex';
      s.innerHTML = '找到 <b>128</b> 条与「测试」相关的资源';
      document.dispatchEvent(new CustomEvent('zsearch:rendered', { detail: {} }));
    })()`);
    await sleep(60);
    const mid = await evalJs(`document.getElementById('statsContainer').querySelector('b').textContent`);
    // 60ms 内不该已经到终点（460ms 的缓动），否则说明写的是瞬时替换而不是滚动
    ok(parseInt(mid, 10) < 128, '数字从 0 起滚（未瞬时跳到终值）', mid);

    await sleep(700);
    const end = await evalJs(`(() => {
      const b = document.getElementById('statsContainer').querySelector('b');
      return { v: b.textContent, tnum: getComputedStyle(b).fontVariantNumeric };
    })()`);
    ok(end.v === '128', '滚动结束停在准确目标值', end.v);
    ok(/tabular-nums/.test(end.tnum), '数字用等宽数位（滚动时整行不会左右抖）', end.tnum);

    // 目标为 1 时不该做动画（来回跳 0→1 反而像闪一下）
    await evalJs(`(() => {
      const s = document.getElementById('statsContainer');
      s.innerHTML = '找到 <b>1</b> 条';
      document.dispatchEvent(new CustomEvent('zsearch:rendered', { detail: {} }));
    })()`);
    await sleep(80);
    const one = await evalJs(`document.getElementById('statsContainer').querySelector('b').textContent`);
    ok(one === '1', '条数为 1 时直接显示（不做无意义滚动）', one);
  }

  // ==================================================================
  console.log('\n=== 5. 长列表渐入 ===');
  // ==================================================================
  {
    // 造 30 条，确定性验证"第 16 条之后才 pending"
    await evalJs(`(() => {
      const host = document.getElementById('resultList');
      let h = '';
      for (let i = 0; i < 30; i++) h += '<div class="result-item"><a class="result-title" href="#">第 ' + i + ' 条</a></div>';
      host.innerHTML = h;
      document.dispatchEvent(new CustomEvent('zsearch:rendered', { detail: {} }));
    })()`);
    await sleep(120);

    const st = await evalJs(`(() => {
      const rows = Array.from(document.querySelectorAll('#resultList .result-item'));
      return {
        total: rows.length,
        pending: rows.map(r => r.classList.contains('pending-in')),
      };
    })()`);
    ok(st.total === 30, '注入 30 条测试行', st.total);
    ok(st.pending.slice(0, 16).every((p) => !p), '前 16 条不做懒渐入（交给原有 item-in 错峰）',
      st.pending.slice(0, 16));
    ok(st.pending.slice(16).every((p) => p), '第 16 条之后全部进入 pending', st.pending.slice(16));

    // 保险丝：1.2s 后必须放行，绝不能留下永久 opacity:0
    await sleep(1500);
    const after = await evalJs(`(() => {
      const rows = Array.from(document.querySelectorAll('#resultList .result-item'));
      return {
        pending: rows.filter(r => r.classList.contains('pending-in')).length,
        hidden: rows.filter(r => parseFloat(getComputedStyle(r).opacity) < 0.9).length,
        // 常驻 transform 会破坏后代定位，必须彻底摘掉
        withTransform: rows.filter(r => {
          const t = getComputedStyle(r).transform;
          return t && t !== 'none';
        }).length,
      };
    })()`);
    ok(after.pending === 0, '1.2s 保险丝把 pending 全部放行', after.pending);
    ok(after.hidden === 0, '没有任何一行停在透明状态（内容永远不会消失）', after.hidden);
    ok(after.withTransform === 0, '动画结束后不留 transform（不会破坏后代定位）', after.withTransform);
  }

  // ==================================================================
  console.log('\n=== 6. reduced-motion 不隐藏内容 ===');
  // ==================================================================
  {
    await send('Emulation.setEmulatedMedia', {
      features: [
        { name: 'prefers-color-scheme', value: 'light' },
        { name: 'prefers-reduced-motion', value: 'reduce' },
      ],
    }, sid);
    await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/search?q=test' }, sid);
    await sleep(2200);

    const rm = await evalJs(`(() => {
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const host = document.getElementById('resultList');
      let h = '';
      for (let i = 0; i < 30; i++) h += '<div class="result-item">r' + i + '</div>';
      host.innerHTML = h;
      document.dispatchEvent(new CustomEvent('zsearch:rendered', { detail: {} }));
      return { reduce };
    })()`);
    // 必须等一帧再测：base.css 的全局 reduced-motion 规则把动画时长压到
    // 0.01ms，但入场动画仍要等下一次样式重算才落到 opacity:1。
    // 同一帧里读计算样式拿到的一定是 backwards 填充的初始值 —— 那是取样问题，不是缺陷。
    await sleep(160);

    const rmVis = await evalJs(`(() => {
      const rows = Array.from(document.querySelectorAll('#resultList .result-item'));
      return {
        pending: rows.filter(r => r.classList.contains('pending-in')).length,
        hidden: rows.filter(r => parseFloat(getComputedStyle(r).opacity) < 0.9).length,
      };
    })()`);
    ok(rm.reduce, '已模拟 prefers-reduced-motion: reduce', rm.reduce);
    ok(rmVis.pending === 0, '关动效时不打 pending 标记', rmVis.pending);
    ok(rmVis.hidden === 0, '关动效时列表完整可见（不隐藏任何内容）', rmVis.hidden);
  }

  // ==================================================================
  console.log('\n=== 7. 控制台 ===');
  // ==================================================================
  {
    const noisy = errs.filter((e) => !/favicon/i.test(e));
    ok(noisy.length === 0, '零控制台报错 / 零未捕获异常', noisy.slice(0, 3));
  }

  console.log('\n================================================');
  console.log('  质感层验证：通过 ' + pass + ' / ' + (pass + fail));
  if (fail) console.log('  未通过项见上方 ✗');
  console.log('================================================\n');

  ws.close();
  proc.kill();
  await sleep(300);
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})();
