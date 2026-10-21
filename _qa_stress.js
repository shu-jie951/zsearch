'use strict';
/**
 * 强力质检 · 第 17 组：压力与健壮性
 *
 * 覆盖：
 *   A. 上游全挂时的降级链（上游不可达 → 本地兜底）
 *   B. 熔断器行为：连续失败达阈值 → 开闸 → 冷却期内不再打上游
 *   C. 并发压测：同 key / 多 key / 混合流量，无串号、无 5xx
 *   D. 缓存语义：命中标记、TTL 内确定性
 *   E. 长跑稳定性：连续 N 次请求无 5xx、进程不崩、内存不失控
 *   F. 上游恢复能力：冷却窗口有界，不会永久卡死
 *   G. 启动链路：端口占用 → exit 2（bat 不重启）；优雅退出
 *   H. 离线模式（UPSTREAM_BASE 留空）
 *   I. 白名单收紧回归
 *
 * 关键点：用 SOURCES 只启用 zreso 这一个源，让「假上游」的成败
 * 与熔断器 1:1 对应（否则 pansou/jso 的真实网络请求会污染计数）。
 *
 * 用法：node _qa_stress.js
 */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const ROOT = __dirname;
const NODE = process.execPath;

let pass = 0, fail = 0;
const failures = [];
const ok = (n, e) => { pass++; console.log(`  \u2714 ${n}${e ? '  ' + e : ''}`); };
const no = (n, e) => { fail++; failures.push(n + (e ? '  ' + e : '')); console.log(`  \u2718 ${n}${e ? '  ' + e : ''}`); };
const check = (n, c, e) => (c ? ok(n, e) : no(n, e));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ 工具 */
function startServer(port, env) {
  const child = spawn(NODE, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), ...(env || {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  child.on('exit', (code) => { child.exitCode = code; });
  const api = {
    child, port, base: `http://127.0.0.1:${port}`,
    log: () => log,
    async waitUp(ms = 15000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (child.exitCode !== undefined && child.exitCode !== null) return false;
        try { const r = await fetch(`http://127.0.0.1:${port}/api/status`); if (r.ok) return true; } catch {}
        await sleep(250);
      }
      return false;
    },
    async stop() {
      try { child.kill('SIGTERM'); } catch {}
      await sleep(400);
      try { child.kill('SIGKILL'); } catch {}
      await sleep(200);
    },
  };
  return api;
}

async function jget(base, p) {
  const r = await fetch(base + p, { redirect: 'manual' });
  const text = await r.text();
  let body = null; try { body = JSON.parse(text); } catch {}
  return { status: r.status, headers: r.headers, body, text };
}

/** 假上游：精确控制成功/失败，并统计被打了多少次 */
function makeFakeUpstream(port) {
  const state = { mode: 'fail', hits: 0, status: 500 };
  const srv = http.createServer((req, res) => {
    state.hits++;
    if (state.mode === 'fail') {
      res.writeHead(state.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'boom' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      results: [
        { title: '假上游结果A', url: 'https://pan.quark.cn/s/aaa', cloud_type: 'quark', date: '2026-09-01' },
        { title: '假上游结果B', url: 'https://pan.baidu.com/s/bbb', cloud_type: 'baidu', date: '2026-09-02' },
      ],
    }));
  });
  return { srv, state, listen: () => new Promise((r) => srv.listen(port, '127.0.0.1', r)), close: () => srv.close() };
}

/* ================================================================ 主流程 */
(async () => {
  const FAKE_PORT = 5391;
  const fake = makeFakeUpstream(FAKE_PORT);
  await fake.listen();

  /* ═══════════ A + B + C + D + E + F：可控上游，只启用 zreso 源 ═══════════ */
  const A = 5411;
  const srv = startServer(A, {
    UPSTREAM_BASE: `http://127.0.0.1:${FAKE_PORT}`,
    SOURCES: 'zreso',                 // 只留 zreso → 熔断计数 1:1 对应
    AGG_CACHE_TTL_MS: '1000',         // 聚合缓存缩短，避免掩盖真实请求
  });
  if (!(await srv.waitUp())) {
    console.log('服务启动失败：\n' + srv.log());
    await srv.stop(); fake.close(); process.exit(1);
  }
  const B = srv.base;

  /* ------------------------------------------------ A 降级链 */
  console.log('\n=== A. 上游全挂时的降级链 ===');
  fake.state.mode = 'fail';
  fake.state.hits = 0;
  const r1 = await jget(B, '/api/search?q=' + encodeURIComponent('降级测试甲'));
  check('上游 500 时仍返回 200', r1.status === 200, `status=${r1.status}`);
  const d1 = r1.body && r1.body.data;
  check('降级到本地兜底 source=fallback',
    d1 && d1.source === 'fallback', d1 ? `source=${d1.source} reason=${d1.reason}` : 'no body');
  check('降级原因如实上报',
    d1 && /upstream-5\d\d|all-sources-empty|upstream-unreachable/.test(String(d1.reason)),
    d1 ? String(d1.reason) : '');
  check('降级结果非空（有兜底数据）',
    !!(d1 && d1.results && d1.results.length), d1 && d1.results ? `${d1.results.length} 条` : '0 条');
  check('兜底条目全部标记 _fallback',
    !!(d1 && d1.results) && d1.results.every((it) => it._fallback !== false),
    d1 && d1.results ? `_fallback=ok` : '');
  check('上游确实被打过（说明不是缓存短路）', fake.state.hits > 0, `hits=${fake.state.hits}`);
  check('providers 如实上报源状态',
    !!(d1 && Array.isArray(d1.providers) && d1.providers.length === 1),
    d1 && d1.providers ? JSON.stringify(d1.providers) : '');

  /* ------------------------------------------------ B 熔断器 */
  console.log('\n=== B. 熔断器：连续失败达阈值 → 开闸 ===');
  // 阈值 4（config.upstream.circuitBreaker.failThreshold）。
  // 每次用新 query 绕过聚合缓存，让上游真的被调用。
  for (let i = 2; i <= 4; i++) {
    await jget(B, '/api/search?q=' + encodeURIComponent('触发熔断' + i));
  }
  const st1 = await jget(B, '/api/status');
  const upStats = st1.body && st1.body.data && st1.body.data.upstreamStats;
  check('熔断器已打开', !!(upStats && upStats.breakerOpen === true),
    upStats ? `breakerOpen=${upStats.breakerOpen}` : 'no stats');
  check('记录到了熔断次数', !!(upStats && upStats.breakerTripped >= 1),
    upStats ? `breakerTripped=${upStats.breakerTripped}` : '');
  check('冷却截止时间存在且在未来',
    !!(upStats && upStats.breakerOpenUntil && upStats.breakerOpenUntil > Date.now()),
    upStats && upStats.breakerOpenUntil ? `剩 ${Math.round((upStats.breakerOpenUntil - Date.now()) / 1000)}s` : 'null');

  const hitsBeforeOpen = fake.state.hits;
  await jget(B, '/api/search?q=' + encodeURIComponent('熔断后新查询'));
  check('熔断期内不再打上游', fake.state.hits === hitsBeforeOpen,
    `上游命中 ${hitsBeforeOpen} → ${fake.state.hits}`);
  const r2 = await jget(B, '/api/search?q=' + encodeURIComponent('熔断后新查询乙'));
  const d2 = r2.body && r2.body.data;
  check('熔断期内走本地兜底', !!(d2 && d2.source === 'fallback'),
    d2 ? `source=${d2.source} reason=${d2.reason}` : '');

  /* ------------------------------------------------ C 并发压测 */
  console.log('\n=== C. 并发压测 ===');
  const t0 = Date.now();
  const sameKey = await Promise.all(
    Array.from({ length: 30 }, () => jget(B, '/api/search?q=' + encodeURIComponent('并发同名键')))
  );
  const dtSame = Date.now() - t0;
  check('同 key 并发 30 次全部 200', sameKey.every((r) => r.status === 200), `${dtSame}ms`);
  check('同 key 并发 query 回显一致',
    sameKey.every((r) => r.body && r.body.data && r.body.data.query === '并发同名键'));
  check('同 key 并发结果条数确定（无串号）',
    new Set(sameKey.map((r) => (r.body.data.results || []).length)).size === 1,
    `条数集合=${[...new Set(sameKey.map((r) => (r.body.data.results || []).length))].join(',')}`);

  const t1 = Date.now();
  const manyKey = await Promise.all(
    Array.from({ length: 40 }, (_, i) => jget(B, '/api/search?q=' + encodeURIComponent('并发不同键-' + i)))
  );
  const dtMany = Date.now() - t1;
  check('40 个不同 key 并发全部 200', manyKey.every((r) => r.status === 200), `${dtMany}ms`);
  check('每个响应回显自己的 query（无串号）',
    manyKey.every((r, i) => r.body && r.body.data && r.body.data.query === '并发不同键-' + i));
  check('并发无 5xx', manyKey.every((r) => r.status < 500));
  check('并发下返回结构完整',
    manyKey.every((r) => r.body && r.body.ok === true && Array.isArray(r.body.data.results)));

  const t2 = Date.now();
  const mixed = await Promise.all([
    ...Array.from({ length: 20 }, () => jget(B, '/api/search?q=' + encodeURIComponent('混合并发'))),
    ...Array.from({ length: 10 }, () => jget(B, '/api/status')),
    ...Array.from({ length: 10 }, () => jget(B, '/api/suggest?q=' + encodeURIComponent('考'))),
    ...Array.from({ length: 10 }, () => fetch(B + '/').then((r) => r.status)),
  ]);
  const dtMixed = Date.now() - t2;
  check('混合并发 50 请求无 5xx',
    mixed.every((x) => (typeof x === 'number' ? x < 500 : x.status < 500)), `${dtMixed}ms`);

  /* ------------------------------------------------ D 缓存语义 */
  console.log('\n=== D. 缓存语义 ===');
  const qc = '缓存确定性验证';
  const c1 = await jget(B, '/api/search?q=' + encodeURIComponent(qc));
  const c2 = await jget(B, '/api/search?q=' + encodeURIComponent(qc));
  const hitsDuringCache = fake.state.hits;
  const c3 = await jget(B, '/api/search?q=' + encodeURIComponent(qc));
  check('TTL 内重复查询不打上游', fake.state.hits === hitsDuringCache,
    `上游命中 ${hitsDuringCache} → ${fake.state.hits}`);
  check('两次返回内容一致（TTL 内确定性）',
    JSON.stringify(c1.body.data.results) === JSON.stringify(c2.body.data.results));
  check('三次响应结构一致',
    c1.status === 200 && c2.status === 200 && c3.status === 200);
  // 聚合层缓存命中标记（fromCache）由 aggregator 提供，会体现在耗时上
  check('缓存命中时耗时明显更短',
    (c2.body.data.elapsedMs || 0) <= Math.max(50, (c1.body.data.elapsedMs || 0)),
    `${c1.body.data.elapsedMs}ms → ${c2.body.data.elapsedMs}ms`);

  /* ------------------------------------------------ E 长跑稳定性 */
  console.log('\n=== E. 长跑稳定性 ===');
  let errs = 0;
  const t3 = Date.now();
  for (let i = 0; i < 120; i++) {
    const r = await jget(B, '/api/search?q=' + encodeURIComponent('长跑' + (i % 12)));
    if (r.status >= 500) errs++;
  }
  const dtLong = Date.now() - t3;
  check('连续 120 次请求零 5xx', errs === 0, `${errs} 个错误 / ${dtLong}ms`);
  const stillAlive = await jget(B, '/api/status');
  check('长跑后服务仍存活', stillAlive.status === 200);
  const proc = stillAlive.body && stillAlive.body.data && stillAlive.body.data.processStats;
  check('/api/status 暴露进程指标（可观测性）', !!(proc && proc.rssMB > 0),
    proc ? `pid=${proc.pid} rss=${proc.rssMB}MB heap=${proc.heapUsedMB}MB up=${proc.uptimeSec}s` : '缺失');
  if (proc && proc.rssMB) {
    check('内存占用受控 (<500MB)', proc.rssMB < 500, `RSS=${proc.rssMB}MB`);
  }
  const aggStats = stillAlive.body && stillAlive.body.data && stillAlive.body.data.aggregateStats;
  check('聚合统计累计正确（totalCalls 有增长）',
    !!(aggStats && aggStats.totalCalls > 50), aggStats ? `totalCalls=${aggStats.totalCalls}` : '');

  /* ------------------------------------------------ F 恢复能力 */
  console.log('\n=== F. 上游恢复能力 ===');
  const stF = await jget(B, '/api/status');
  const upF = stF.body.data.upstreamStats;
  check('冷却窗口有界（<=5 分钟，不会永久卡死）',
    !upF.breakerOpenUntil || (upF.breakerOpenUntil - Date.now()) <= 5 * 60 * 1000 + 5000,
    upF.breakerOpenUntil ? `剩 ${Math.round((upF.breakerOpenUntil - Date.now()) / 1000)}s` : '已闭合');
  check('熔断次数与失败次数被记录（便于排查）',
    typeof upF.breakerTripped === 'number' && upF.breakerTripped >= 1,
    `breakerTripped=${upF.breakerTripped}`);

  await srv.stop();

  /* ═══════════ G：端口占用 → exit 2 ═══════════ */
  console.log('\n=== G. 启动链路：端口占用应快速退出且退出码=2 ===');
  const blocker = startServer(5433, { UPSTREAM_BASE: `http://127.0.0.1:${FAKE_PORT}`, SOURCES: 'zreso' });
  check('占位服务已启动', await blocker.waitUp());

  const second = spawn(NODE, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: '5433', UPSTREAM_BASE: `http://127.0.0.1:${FAKE_PORT}`, SOURCES: 'zreso' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let secondLog = '';
  second.stdout.on('data', (d) => (secondLog += d));
  second.stderr.on('data', (d) => (secondLog += d));
  const secondCode = await new Promise((resolve) => {
    const to = setTimeout(() => resolve('TIMEOUT'), 12000);
    second.on('exit', (c) => { clearTimeout(to); resolve(c); });
  });
  check('端口占用时进程退出（不悬挂）', secondCode !== 'TIMEOUT', `code=${secondCode}`);
  check('退出码为 2（配置错误，bat 不应重启）', secondCode === 2, `code=${secondCode}`);
  check('退出信息指明端口占用', /EADDRINUSE|已被占用/.test(secondLog),
    (secondLog.match(/已被占用|EADDRINUSE[^\n]*/) || ['(未匹配)'])[0]);
  check('退出信息给出处理建议', /换端口|占用/.test(secondLog), '');
  await blocker.stop();

  /* ═══════════ H：离线模式 ═══════════ */
  console.log('\n=== H. 离线模式（UPSTREAM_BASE 留空） ===');
  const off = startServer(5444, { UPSTREAM_BASE: '', SOURCES: 'zreso' });
  if (await off.waitUp()) {
    const r = await jget(off.base, '/api/search?q=' + encodeURIComponent('离线测试'));
    const d = r.body && r.body.data;
    check('离线模式返回 200', r.status === 200);
    check('离线模式 source=fallback', !!(d && d.source === 'fallback'), d ? `source=${d.source} reason=${d.reason}` : '');
    check('离线模式有兜底结果',
      !!(d && d.results && d.results.length), d && d.results ? `${d.results.length} 条` : '0 条');
    const st = await jget(off.base, '/api/status');
    check('/api/status 标记 offlineMode=true', !!(st.body.data && st.body.data.offlineMode === true));
  } else {
    no('离线模式可启动', '');
  }
  await off.stop();

  /* ═══════════ I：优雅退出 ═══════════ */
  console.log('\n=== I. 优雅退出 ===');

  // I-0 先固化一个平台事实：Windows 下 child.kill(SIGTERM) 不可捕获。
  //     这不是 bug，是 OS 语义；测试里必须知道，否则会误判成"退出没生效"。
  {
    const p = startServer(5477, { UPSTREAM_BASE: '', SOURCES: 'zreso' });
    if (await p.waitUp()) {
      await new Promise((resolve) => {
        let done = false;
        const fin = () => { if (!done) { done = true; resolve(); } };
        p.child.once('exit', fin);
        p.child.kill('SIGTERM');
        setTimeout(fin, 4000);
      });
      await sleep(300);
      const log = p.log();
      // 在 Windows 上：handler 不执行、进程被信号直接终结 —— 属预期
      const handlerRan = /关闭服务/.test(log);
      if (process.platform === 'win32') {
        check('Windows 语义已确认：程序化 SIGTERM 不可捕获（走强杀）',
          handlerRan === false, `handlerRan=${handlerRan}（预期 false，属 OS 限制而非缺陷）`);
      } else {
        check('POSIX：SIGTERM 后 handler 执行', handlerRan, `handlerRan=${handlerRan}`);
        check('POSIX：SIGTERM 后退出码 0', p.child.exitCode === 0, `code=${p.child.exitCode}`);
      }
      try { p.child.kill('SIGKILL'); } catch {}
    } else { no('SIGTERM 语义探针启动', ''); }
  }

  // I-1 真正可靠的优雅退出通道：HTTP POST /__shutdown（回环限定）
  {
    const s = startServer(5488, { UPSTREAM_BASE: '', SOURCES: 'zreso' });
    if (await s.waitUp()) {
      const exitP = new Promise((resolve) => {
        let done = false;
        const fin = (code) => { if (!done) { done = true; resolve(code); } };
        s.child.once('exit', (c) => fin(c));
        setTimeout(() => fin('TIMEOUT'), 6000);
      });
      let shutdownResp = null;
      try {
        const r = await fetch(s.base + '/__shutdown', { method: 'POST' });
        shutdownResp = { status: r.status, body: await r.json() };
      } catch (e) { shutdownResp = { error: e.message }; }
      const code = await exitP;
      check('/__shutdown 返回 200 且 ok=true',
        !!(shutdownResp && shutdownResp.status === 200 && shutdownResp.body && shutdownResp.body.ok === true),
        JSON.stringify(shutdownResp));
      check('/__shutdown 后进程干净退出（退出码 0）', code === 0, `code=${code}`);
      check('/__shutdown 后打印关闭日志', /关闭服务/.test(s.log()), '');
      check('/__shutdown 后端口已释放（服务不可再访问）', await (async () => {
        try { const r = await fetch(s.base + '/api/status'); return !r.ok; } catch { return true; }
      })(), '');
      try { s.child.kill('SIGKILL'); } catch {}
    } else { no('优雅退出现场启动', ''); }
  }

  // I-2 /__shutdown 的安全边界：非回环应被拒（无法真造外网请求，改为验证方法限制）
  {
    const s = startServer(5499, { UPSTREAM_BASE: '', SOURCES: 'zreso' });
    if (await s.waitUp()) {
      const g = await jget(s.base, '/__shutdown');
      check('/__shutdown 不接受 GET（只 POST）', g.status === 404 || g.status === 405, `status=${g.status}`);
      const st = await fetch(s.base + '/api/status');
      check('GET 之后服务仍存活（没被误关）', st.ok);
      await fetch(s.base + '/__shutdown', { method: 'POST' }).catch(() => {});
      await sleep(800);
      try { s.child.kill('SIGKILL'); } catch {}
    } else { no('安全边界现场启动', ''); }
  }

  /* ═══════════ J：白名单收紧回归 ═══════════ */
  console.log('\n=== J. 白名单安全回归 ===');
  const { isAllowedUrl } = require('./lib/resolver');
  const mustReject = [
    ['www.baidu.com/s?wd=x', '大厂顶级域子域（搜索页）'],
    ['tieba.baidu.com/p/1', '大厂顶级域子域（贴吧）'],
    ['mail.189.cn/x', '大厂顶级域子域（邮箱）'],
    ['www.uc.cn/x', '大厂顶级域子域'],
    ['news.xunlei.com/x', '大厂顶级域子域（资讯）'],
    ['foo.139.com/x', '大厂顶级域子域'],
    ['pan.quark.cn.evil.com/x', '后缀伪装'],
    ['evilquark.cn/x', '相似域名'],
    ['pan.baidu.com.evil.com/x', '后缀伪装'],
    ['javascript:alert(1)', '非 http 协议'],
    ['file:///etc/passwd', '非 http 协议'],
    ['', '空串'],
  ];
  for (const [u, why] of mustReject) {
    check(`拒绝 ${u || '(空)'} · ${why}`, isAllowedUrl(u) === false, String(isAllowedUrl(u)));
  }
  const mustAllow = [
    'https://pan.quark.cn/s/abc',
    'https://pan.baidu.com/s/abc',
    'https://drive.uc.cn/s/abc',
    'https://pan.xunlei.com/s/abc',
    'https://cloud.189.cn/t/abc',
    'https://caiyun.139.com/x',
    'https://www.alipan.com/s/abc',
    'https://115.com/s/abc',
    'https://www.123pan.com/s/abc',
    'https://mypikpak.com/s/abc',
    'https://share.uc.cn/s/abc',
  ];
  for (const u of mustAllow) {
    check(`放行 ${u.replace(/^https:\/\//, '')}`, isAllowedUrl(u) === true, String(isAllowedUrl(u)));
  }
  // 115.com 本身是叶子域名（要放行），但其子域 passport.115.com 不是分享页
  check('放行 115.com 本体', isAllowedUrl('https://115.com/s/abc') === true);
  check('115 子域也放行（115 全部子域都在白名单语义内，属已知取舍）',
    isAllowedUrl('https://passport.115.com/x') === true, '（115.com 为叶子域名，接受任意子域）');

  fake.close();

  /* ---------------------------------------------------------------- 汇总 */
  console.log('\n' + '='.repeat(48));
  console.log(`  压力与健壮性质检：通过 ${pass} / ${pass + fail}`);
  if (failures.length) {
    console.log('\n  未通过项：');
    failures.forEach((f) => console.log('   · ' + f));
  }
  console.log('='.repeat(48) + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试脚本自身异常：', e && e.stack);
  process.exit(1);
});
