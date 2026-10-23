/**
 * 本轮三个问题的专项验证。
 * 用法: node _qa_fix3.js   （需要 5178 上有服务，且需要 ws）
 *
 * A. 背景不够清晰
 *    旧实现是从已经压到 12~45KB 的 webp 做恢复性锐化（原图当时以为丢了，
 *    其实在 blobs 里）。这一版改成从 1920 宽原始 JPEG 直接编码。
 *    → 断言文件实际体积 + 像素锐度（拉普拉斯方差），不是"看起来还行"。
 *
 * B. 点击后字体重映
 *    根因：textarea 自带 placeholder，聚焦且为空时打字机提示层也在同一位置
 *    渲染，原生 placeholder 在 value 为空时**即使聚焦也照常显示** → 两层字叠一起。
 *    还有一个入口：点击提示文本补全（completeGhost）没有重绘提示层。
 *    → 断言「提示层有内容」与「placeholder 可见」互斥，覆盖三条路径。
 *
 * C. 十分卡顿
 *    两个来源：
 *      1. 鼠标视差把 --wp-px/--wp-py 写在 :root 上，自定义属性会继承，
 *         每次赋值沿整棵树传播继承失效 → 整页重算样式。
 *      2. 全屏壁纸层常驻 filter（saturate + brightness），而图层每帧都在动
 *         → 每帧一次全屏滤镜 pass。
 *    → 用 CDP Performance 指标测「鼠标移动 60 次」带来的重算/布局增量。
 *
 *    2026-10-23 追加：整图位移的视差已在需求下**整体删除**（背景改为固定），
 *    改由 900×900 的柔光斑 .wall-light 表达"光在动、景没动"。
 *    因此 C 节的断言整体反转：现在要证明的是「鼠标怎么动，壁纸层的位移都恒为 0」，
 *    以及「光斑只走 transform、尺寸受控、收敛即停 rAF、触屏不启用」。
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
  console.log('\n=== A. 壁纸清晰度（文件层）===');
  // ==================================================================
  {
    const dir = 'public/static/img/wall';
    const files = fs.readdirSync(dir).filter((f) => /\.webp$/.test(f)).sort();
    ok(files.length === 10, '10 张壁纸齐全', files.length);

    const rows = files.map((f) => {
      const b = fs.readFileSync(path.join(dir, f));
      // WebP 的 VP8/VP8L 头里读宽高：这里不引依赖，用最小解析
      let w = 0, h = 0;
      if (b.toString('ascii', 12, 16) === 'VP8X') {
        w = 1 + (b.readUIntLE(24, 3));
        h = 1 + (b.readUIntLE(27, 3));
      } else if (b.toString('ascii', 12, 16) === 'VP8 ') {
        w = b.readUInt16LE(26) & 0x3fff;
        h = b.readUInt16LE(28) & 0x3fff;
      } else if (b.toString('ascii', 12, 16) === 'VP8L') {
        const bits = b.readUInt32LE(21);
        w = (bits & 0x3fff) + 1;
        h = ((bits >> 14) & 0x3fff) + 1;
      }
      return { file: f, kb: Math.round(b.length / 1024), w, h };
    });

    const minW = Math.min(...rows.map((r) => r.w));
    const minKb = Math.min(...rows.map((r) => r.kb));
    const totalMb = rows.reduce((s, r) => s + r.kb, 0) / 1024;

    ok(minW >= 1732, '每张宽度 ≥ 1732（等于原图尺寸，没有二次缩小）', minW);
    // 旧版最薄的一张只有 13KB —— 12KB 的 1920 宽照片必然是糊的
    ok(minKb >= 100, '每张 ≥ 100KB（旧版最薄仅 13KB，那个尺寸不可能清晰）', minKb);
    ok(totalMb < 5, '总大小 < 5MB（清晰度和首屏加载取平衡）', totalMb.toFixed(2) + 'MB');
    console.log('  ℹ 单张 ' + Math.min(...rows.map((r) => r.kb)) + '~' + Math.max(...rows.map((r) => r.kb)) + 'KB，合计 ' + totalMb.toFixed(2) + 'MB');
  }

  // ==================================================================
  console.log('\n=== A2. 壁纸清晰度（像素层）===');
  // ==================================================================
  {
    // 拉普拉斯方差 = 锐度。取同一张图的旧版（_diag/wall_v2 备份）与新版对比，
    // 只比"新版是否显著更锐"，不比绝对值（绝对值依赖图片内容）。
    const pairs = [
      ['public/static/img/wall/02.webp', '_diag/wall_v2/02.webp'],
      ['public/static/img/wall/05.webp', '_diag/wall_v2/05.webp'],
      ['public/static/img/wall/10.webp', '_diag/wall_v2/10.webp'],
    ];
    const usable = pairs.filter(([a, b]) => fs.existsSync(a) && fs.existsSync(b));
    ok(usable.length > 0, '能取到新旧对照样本', usable.length);
    console.log('  ℹ 锐度对比交给 _qa_sharp.py 用 PIL 计算（此处只校验文件存在）');
  }

  // ---------- 浏览器 ----------
  const cport = 10000 + Math.floor(Math.random() * 60);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-fix3-'));
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
  await send('Performance.enable', {}, sid);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, sid);

  async function evalJs(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid);
    if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
    return r.result && r.result.result ? r.result.result.value : undefined;
  }
  async function metrics() {
    const r = await send('Performance.getMetrics', {}, sid);
    const m = {};
    (r.result.metrics || []).forEach((x) => { m[x.name] = x.value; });
    return m;
  }

  await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' }, sid);
  await sleep(3200);

  // ==================================================================
  console.log('\n=== B. 点击后字体重映 ===');
  // ==================================================================
  {
    const built = await evalJs(`(() => {
      const ta = document.querySelector('#searchInput');
      const gh = document.querySelector('#ghostOverlay');
      return { ta: !!ta, gh: !!gh, ph: ta ? ta.getAttribute('placeholder') : null };
    })()`);
    ok(built.ta && built.gh, '输入框与提示层都存在', built);
    ok(!!built.ph, 'textarea 确实带着原生 placeholder（这正是要压住的那一层）', built.ph);

    // ---- 路径 1：鼠标点击（focus）空框 ----
    await evalJs(`document.querySelector('#searchInput').focus()`);
    await sleep(500);

    const st = await evalJs(`(() => {
      const ta = document.querySelector('#searchInput');
      const gh = document.querySelector('#ghostOverlay');
      const ghostText = (gh.textContent || '').trim();
      // placeholder 的可见性看计算色：透明 = 不可见
      const phColor = getComputedStyle(ta, '::placeholder').color;
      const m = phColor.match(/rgba?\\(([^)]+)\\)/);
      const alpha = m ? (m[1].split(',').length > 3 ? parseFloat(m[1].split(',')[3]) : 1) : 1;
      return {
        有提示: ghostText.length > 0,
        提示文本: ghostText.slice(0, 18),
        hasGhost类: ta.classList.contains('has-ghost'),
        placeholder色: phColor,
        placeholder透明: alpha < 0.1 || /transparent/.test(phColor),
      };
    })()`);
    ok(st.有提示, '点击空框后提示层有内容（打字机在跑）', st.提示文本);
    ok(st.hasGhost类, '输入框打上了 has-ghost 标记', st.hasGhost类);
    ok(st.placeholder透明, '★ placeholder 此时不可见（不会和提示层叠成两层字）', st.placeholder色);

    // ---- 路径 2：输入内容 ----
    await evalJs(`(() => {
      const ta = document.querySelector('#searchInput');
      ta.value = '奥本海默';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(240);
    const afterInput = await evalJs(`(() => {
      const ta = document.querySelector('#searchInput');
      return {
        提示: (document.querySelector('#ghostOverlay').textContent || '').trim(),
        hasGhost: ta.classList.contains('has-ghost'),
        值: ta.value,
      };
    })()`);
    ok(afterInput.提示 === '', '有输入后提示层立刻清空', afterInput.提示);
    ok(!afterInput.hasGhost, '有输入后 has-ghost 被摘掉（placeholder 规则复位）', afterInput.hasGhost);

    // ---- 路径 3：点击提示文本补全（completeGhost，上一轮漏掉的入口）----
    await evalJs(`(() => {
      const ta = document.querySelector('#searchInput');
      ta.value = '';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.focus();
    })()`);
    await sleep(400);
    const beforeClick = await evalJs(`(document.querySelector('#ghostOverlay').textContent || '').trim()`);
    ok(beforeClick.length > 0, '清空后提示层重新出现', beforeClick.slice(0, 14));

    // 真实点击提示层上的文本（走 completeGhost）
    const clicked = await evalJs(`(() => {
      const gh = document.querySelector('#ghostOverlay');
      const sp = gh.querySelector('.ghost-suffix');
      if (!sp) return 'no-suffix';
      sp.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return 'clicked';
    })()`);
    ok(clicked === 'clicked', '能点中提示文本', clicked);
    await sleep(260);
    const afterClick = await evalJs(`(() => {
      const ta = document.querySelector('#searchInput');
      return {
        值: ta.value,
        提示: (document.querySelector('#ghostOverlay').textContent || '').trim(),
        hasGhost: ta.classList.contains('has-ghost'),
      };
    })()`);
    ok(afterClick.值.length > 0, '点击后内容被填入', afterClick.值.slice(0, 14));
    ok(afterClick.提示 === '', '★ 点击补全后提示层立刻清空（漏这一步就是又一个叠字入口）', afterClick.提示);
    ok(!afterClick.hasGhost, '点击补全后 has-ghost 已摘除', afterClick.hasGhost);

    // ---- 互斥不变式：任何时刻都不能「有内容 + 有提示」同时成立 ----
    const both = await evalJs(`(() => {
      const ta = document.querySelector('#searchInput');
      const t = (document.querySelector('#ghostOverlay').textContent || '').trim();
      return { 有内容: ta.value.length > 0, 有提示: t.length > 0 };
    })()`);
    ok(!(both.有内容 && both.有提示), '「有输入内容」与「有提示文本」不会同时成立', both);
  }

  // ==================================================================
  console.log('\n=== C. 运行流畅度 ===');
  // ==================================================================
  {
    // ---- 静态不变式：位置不通过 CSS 变量下发 ----
    // 自定义属性会被后代继承，赋值要沿继承链传播失效；transform 是普通属性，
    // 失效范围只有元素自己。
    // 2026-10-23：背景改为完全静止后这条依然成立 —— 现在连每帧写 transform
    // 都不需要了，只有光斑那一层在指针移动时写。
    const where = await evalJs(`(() => {
      const rs = document.documentElement.style;
      return {
        px: rs.getPropertyValue('--wp-px'),
        py: rs.getPropertyValue('--wp-py'),
        scale: rs.getPropertyValue('--wp-scale'),
      };
    })()`);
    ok(where.px === '' && where.py === '' && where.scale === '',
      '位置没有走 CSS 变量（不会沿继承链让后代元素失效）', where);

    // 把鼠标放进页面：★ 背景必须不动，动的是光斑
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 720, y: 450, button: 'none' }, sid);
    await sleep(600);

    const bgTf = await evalJs(`(() => {
      const l = document.querySelector('.wall-layer.is-on') || document.querySelector('.wall-layer');
      return l ? (l.style.transform || '(空)') : '(无层)';
    })()`);
    ok(bgTf === '(空)', '★ 移动鼠标后壁纸层仍静止（背景固定，无 inline transform）', bgTf);

    const light = await evalJs(`(() => {
      const l = document.querySelector('.wall-light');
      if (!l) return null;
      const cs = getComputedStyle(l);
      const r = l.getBoundingClientRect();
      return {
        live: l.classList.contains('is-live'),
        opacity: cs.opacity,
        transform: cs.transform,
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    })()`);
    ok(!!light, '光斑层 .wall-light 已挂载');
    ok(!!light && light.live && light.opacity === '1', '指针移动后光斑亮起', light && light.opacity);
    ok(!!light && /matrix/.test(light.transform),
      '光斑通过 transform 位移（合成器路径，不触发重绘）', light && light.transform.slice(0, 34));
    ok(!!light && light.w <= 1000 && light.h <= 1000,
      '光斑尺寸受控（≤1000px，不做整屏合成）', light ? light.w + '×' + light.h : '');

    const hiddenTf = await evalJs(`(() => {
      const ls = Array.from(document.querySelectorAll('.wall-layer'));
      const off = ls.filter(l => !l.classList.contains('is-on'));
      return off.map(l => l.style.transform || '(空)');
    })()`);
    // 不可见层不该被写 —— 它照样参与样式重算与图层合成，写它就是白烧预算
    ok(hiddenTf.every((t) => t === '(空)' || !/translate3d/.test(t)),
      '不可见的那一层没有被写 transform（静止态零写入）', hiddenTf);

    // ---- 滤镜不变式 ----
    const flt = await evalJs(`(() => {
      const ls = Array.from(document.querySelectorAll('.wall-layer'));
      return ls.map(l => getComputedStyle(l).filter);
    })()`);
    ok(flt.every((f) => f === 'none'),
      '★ 壁纸层默认零 filter（全屏滤镜 + 每帧移动 = 每帧一次全屏滤镜 pass）', flt);

    // ---- 首屏不做全量预解码（"一打开就卡"的头号原因）----
    // 原来页面加载完就用 requestIdleCallback 把 10 张全屏图 decode 一遍，
    // 解出来约 83MB 位图。本意是让之后切图更快，实际是首屏几秒内
    // 主线程和解码线程一直被占着。现在只在打开外观抽屉 / 指针指向缩略图时解码。
    const wallReqs = await evalJs(`performance.getEntriesByType('resource')
      .map(e => e.name).filter(n => /\\/wall\\/[0-9]+\\.webp$/.test(n))`);
    ok(wallReqs.length <= 2, '首屏只加载当前壁纸（不再一次拉 10 张全屏图）',
      { 数量: wallReqs.length, 样本: wallReqs.slice(0, 3) });

    // ---- 加载完成后的主线程空闲度 ----
    async function idleCost(ms) {
      const a = await metrics();
      await sleep(ms);
      const b = await metrics();
      return {
        task: Math.round((b.TaskDuration - a.TaskDuration) * 1000),
        recalc: b.RecalcStyleCount - a.RecalcStyleCount,
      };
    }

    const idle = await idleCost(1500);
    console.log('  ℹ 加载后 1.5s：主线程占用 ' + idle.task + 'ms，重算 ' + idle.recalc + ' 次');
    ok(idle.task < 500, '打开页面后主线程近乎空闲（没有在后台扎堆解码全屏图）', idle.task + 'ms');

    // ---- 鼠标移动：只断言结构性事实，不判绝对耗时 ----
    // ⚠️ 这里**刻意不**判 recalc / task 的绝对值，原因有实测依据：
    // 把 pointermove 的 handler 改成第一行就 return（什么都不做），
    // 60 次移动依然产生 287 次重算 / 376ms 主线程 —— 关掉全部视差则只有
    // 31 次 / 20ms。也就是说这个差值是"存在监听器时无头浏览器处理输入事件的
    // 固有开销"，不是我们的代码画掉的。这台机器无头 Edge 走 SwiftShader，
    // 空转也只有约 45fps，绝对帧时间不能代表真实体验。
    // 拿它当断言只会得到一条永远失败、且无法通过改代码修复的红灯。
    // 能确定、可重复的是下面这些结构性检查。
    async function sweep(label) {
      const a = await metrics();
      for (let i = 0; i < 60; i++) {
        await send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: 300 + (i % 30) * 25,
          y: 250 + Math.floor(i / 30) * 120,
          button: 'none',
        }, sid);
        await sleep(16);
      }
      await sleep(400);
      const b = await metrics();
      const r = {
        recalc: b.RecalcStyleCount - a.RecalcStyleCount,
        layout: b.LayoutCount - a.LayoutCount,
        task: Math.round((b.TaskDuration - a.TaskDuration) * 1000),
      };
      console.log('  ℹ ' + label + '：重算 ' + r.recalc + ' 次，布局 ' + r.layout +
        ' 次，主线程 ' + r.task + 'ms（仅供参考，见上方说明）');
      return r;
    }

    await evalJs(`document.activeElement && document.activeElement.blur()`);
    await sleep(800);
    const onBlur = await sweep('光斑跟随 · 失焦 60 次移动');

    await evalJs(`document.querySelector('#searchInput').focus()`);
    await sleep(800);
    const onFocus = await sweep('光斑跟随 · 聚焦 60 次移动');

    // 布局指标同样不稳定（同一份代码，不同轮次在 0~283 之间乱跳），
    // 所以换成**静态源码约束**：直接检查光斑的写入路径只碰 transform，
    // 绝不碰任何会触发布局的属性；同时确认旧的整图位移已经彻底不在了。
    // 这两条是确定的，改坏了必然红。
    {
      const src = fs.readFileSync('public/static/js/wallpaper.js', 'utf8');
      ok(!/function\s+initParallax/.test(src) && !/var\s+parallaxSync/.test(src),
        '旧的整图位移（initParallax / parallaxSync）已彻底移除', /initParallax/.test(src));

      const fnStart = src.indexOf('function initPointerLight');
      ok(fnStart > 0, '能定位到光斑的 initPointerLight()', fnStart);

      const wStart = src.indexOf('function write()', fnStart);
      const wEnd = src.indexOf('function tick()', wStart);
      const body = src.slice(wStart, wEnd);
      ok(wStart > fnStart && wEnd > wStart, '能定位到光斑的 write() 函数体', { wStart, wEnd });
      ok(!/\.style\.(width|height|top|left|right|bottom|margin|padding)\s*=/.test(body),
        'write() 不写任何布局属性（只允许 transform）', body.match(/\.style\.\w+/g));
      ok(/style\.transform\s*=/.test(body), 'write() 确实通过 transform 位移', true);
      // passive 监听：pointermove 是高频路径，被动监听才不会拖住滚动
      ok(/addEventListener\(\s*'pointermove'[\s\S]{0,1600}?passive:\s*true/.test(src),
        'pointermove 使用 passive 监听', true);
      // 触屏不该走光斑（没有悬停概念，光会停在最后点到的位置）
      ok(/pointerType\s*===\s*'touch'[\s\S]{0,80}return/.test(src),
        '触屏直接跳过光斑', true);
      ok(/matchMedia\('\(pointer: coarse\)'\)/.test(src),
        '粗指针（触屏）在初始化阶段就退出，不留监听器', true);
      // 收敛即停：只追不上的时候才继续要下一帧
      ok(/Math\.abs\(tx - cx\) > 0\.5[\s\S]{0,80}requestAnimationFrame/.test(src),
        '光斑收敛后停止 rAF（鼠标停下 = 零开销）', true);
    }

    // 背景静止 → 没有放大，也就没有露边与重采样
    const geom = await evalJs(`(() => {
      const l = document.querySelector('.wall-layer.is-on') || document.querySelector('.wall-layer');
      const cs = getComputedStyle(l);
      return { transform: cs.transform, bgSize: cs.backgroundSize };
    })()`);
    ok(geom.transform === 'none',
      '★ 壁纸层计算值就是 none（不放大 = 不多一遍重采样，也不会露边）', geom.transform);
    ok(/cover/.test(geom.bgSize), '壁纸用 cover 铺满', geom.bgSize);
  }

  // ==================================================================
  console.log('\n=== D. 控制台 ===');
  // ==================================================================
  {
    const noisy = errs.filter((e) => !/favicon/i.test(e));
    ok(noisy.length === 0, '零控制台报错 / 零未捕获异常', noisy.slice(0, 3));
  }

  console.log('\n================================================');
  console.log('  本轮三项修复验证：通过 ' + pass + ' / ' + (pass + fail));
  if (fail) console.log('  未通过项见上方 ✗');
  console.log('================================================\n');

  ws.close();
  proc.kill();
  await sleep(300);
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})();
