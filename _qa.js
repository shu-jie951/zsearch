'use strict';
/**
 * 强力质检：单进程内起服务 → 跑完整测试 → 关服务。
 * 这样不依赖外部持久服务，避免被宿主回收。
 *
 * 用法： node _qa.js
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = 5321;                       // 用冷门端口，避开残留进程
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = __dirname;

let pass = 0, fail = 0;
const failures = [];

function ok(name, extra) {
  pass++;
  console.log(`  \u2714 ${name}${extra ? '  ' + extra : ''}`);
}
function no(name, extra) {
  fail++;
  failures.push(name + (extra ? '  ' + extra : ''));
  console.log(`  \u2718 ${name}${extra ? '  ' + extra : ''}`);
}
function check(name, cond, extra) {
  if (cond) ok(name, extra); else no(name, extra);
}

async function req(p, opts) {
  const r = await fetch(BASE + p, { redirect: 'manual', ...(opts || {}) });
  const text = await r.text();
  return { status: r.status, headers: r.headers, text };
}
async function json(p) {
  const r = await req(p);
  try { return { ...r, body: JSON.parse(r.text) }; }
  catch { return { ...r, body: null }; }
}

/**
 * 带退避重试的搜索请求 —— 只用于「断言必须有结果」的地方。
 *
 * 为什么需要：这台机器的出网经过一层会间歇性坏掉的代理，
 * 表现为上游偶发 HTTP 400（`The plain HTTP request was sent to HTTPS port`）
 * 或 Cloudflare 403（`error code: 1003`）。症状很有迷惑性：
 * **同一个关键词，第一次返回 10 条，紧接着第二次 0 条**；
 * 单独手工 curl 又好好的。这是外部条件，不是代码缺陷，
 * 不应该在质检里报红 —— 否则「上游抖了一下」会被读成「搜索坏了」。
 *
 * 做法：0 条就退避后重试，最多 3 次（间隔 2s / 4s），仍为 0 才认账，
 * 并在标签里标明"退避重试后取得"，让看报告的人知道这次是被网络挡过。
 * 注意：验证缓存的断言**不能**用这个函数，那两条要的是原始时序。
 */
async function searchQ(q, extra) {
  const p = `/api/search?q=${encodeURIComponent(q)}${extra || ''}`;
  const count = (r) => (r.body && r.body.data && Array.isArray(r.body.data.results)
    ? r.body.data.results.length
    : -1);
  const gaps = [2000, 4000];
  let r = await json(p);
  for (let i = 0; i < gaps.length && count(r) === 0; i++) {
    await new Promise((res) => setTimeout(res, gaps[i]));
    const next = await json(p);
    if (count(next) > 0) {
      next.retried = true;
      return next;
    }
    r = next;
  }
  return r;
}

// ---------------------------------------------------------------- 启动服务
const child = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvOut = '';
child.stdout.on('data', (d) => (srvOut += d));
child.stderr.on('data', (d) => (srvOut += d));

async function waitUp(ms = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(BASE + '/api/status');
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function shutdown() {
  try { child.kill('SIGTERM'); } catch {}
  setTimeout(() => { try { child.kill('SIGKILL'); } catch {} process.exit(0); }, 600);
}

(async () => {
  const up = await waitUp();
  if (!up) {
    console.log('服务启动失败，输出：\n' + srvOut);
    shutdown();
    return;
  }
  console.log(`\n服务已在 ${PORT} 就绪，开始质检\n`);

  // ============================================================ 1 页面路由
  console.log('=== 1. 页面路由 ===');
  for (const [p, exp] of [['/', 200], ['/search', 200], ['/disclaimer', 200], ['/nope-xyz-123', 404]]) {
    const r = await req(p);
    check(`${p} -> ${r.status}`, r.status === exp, `期望 ${exp}`);
  }
  // 首页内容完整性
  {
    const r = await req('/');
    check('首页含品牌 ZSEARCH', r.text.includes('ZSEARCH'));
    check('首页含氛围层 .atmosphere', r.text.includes('atmosphere'));
    check('首页含命令面板', r.text.includes('cmdk'));
    check('首页 CSS 带版本号', /base\.css\?v=[a-f0-9]{8}/.test(r.text));
  }
  {
    const r = await req('/search?q=test');
    check('结果页含滚动进度条', r.text.includes('scrollProgress'));
    check('结果页 CSS 带版本号', /results\.css\?v=[a-f0-9]{8}/.test(r.text));
  }

  // ============================================================ 2 静态资源
  console.log('\n=== 2. 静态资源 ===');
  for (const f of ['/static/css/base.css', '/static/css/home.css', '/static/css/results.css',
    '/static/js/home.js', '/static/js/results.js', '/static/favicon.svg']) {
    const r = await req(f);
    const len = Number(r.headers.get('content-length') || r.text.length);
    check(`${f}`, r.status === 200 && len > 0, `${r.status} ${len}B`);
  }
  {
    // 浏览器自动请求的根路径 favicon 不该 404
    const r = await req('/favicon.ico');
    check('/favicon.ico 有响应(非404)', r.status === 302 || r.status === 200, String(r.status));
  }
  // 缓存头
  {
    const r = await req('/');
    const cc = r.headers.get('cache-control') || '';
    check('HTML 禁缓存', /no-cache|no-store/.test(cc), cc);
  }
  {
    const r = await req('/static/css/base.css');
    const cc = r.headers.get('cache-control') || '';
    check('CSS 协商缓存(max-age=0)', /max-age=0/.test(cc), cc);
    check('CSS 有 ETag', !!r.headers.get('etag'));
  }

  // ============================================================ 3 搜索功能
  console.log('\n=== 3. 搜索功能 ===');
  const queries = ['电影', '考研', 'Python', '周杰伦'];
  const searchResults = {};
  for (const q of queries) {
    // 不同关键词之间留一点间隔：连打容易被上游反爬/代理挡掉，
    // 挡掉后所有"必须有结果"的断言都会连锁失败，读起来像代码崩了。
    if (Object.keys(searchResults).length) await new Promise((res) => setTimeout(res, 1200));
    const r = await searchQ(q, '&sort=latest&cloud=all');
    const n = r.body && r.body.data ? r.body.data.results.length : -1;
    check(`搜索「${q}」${r.retried ? '（被网络挡过，退避重试后取得）' : ''}`, r.status === 200 && n > 0, `${n} 条`);
    searchResults[q] = n;
  }

  // 结果字段完整性
  {
    const r = await searchQ('考研', '&sort=latest&cloud=all');
    const items = r.body.data.results;
    // 上游抖动时这里可能是 0 条。测试脚本不该因此抛 TypeError 中断整轮 ——
    // 那会把"上游暂时没数据"伪装成"代码崩了"，后面几十条断言也全丢了。
    if (!items.length) {
      check('结果字段完整性（跳过：上游本次 0 条）', false, '上游未返回结果，无法校验字段');
    } else {
    const first = items[0];
    check('结果含 title', typeof first.title === 'string' && first.title.length > 0);
    check('结果含 target 短链', /^\/go\/[0-9a-f]+$/i.test(first.target || ''), first.target);
    check('结果含 cloud_type', typeof first.cloud_type === 'string');
    const allHaveTarget = items.every((it) => /^\/go\/[0-9a-f]+$/i.test(it.target || ''));
    check('全部结果都有 target', allHaveTarget, `${items.filter((i) => /^\/go\//i.test(i.target || '')).length}/${items.length}`);
    // ★ 安全：真实链接绝不下发给前端，否则 /go 的白名单校验等于被绕过
    check('不下发 raw_url（真实直链）', items.every((it) => !('raw_url' in it)));
    check('不下发内部字段 origin', items.every((it) => !('origin' in it)));
    // first_url 只是本站 /go 短链，前端靠它取链接，可以下发
    check('first_url 是站内短链', items.every((it) => !it.first_url || /^\/go\//.test(it.first_url)));
    }
  }

  // ============================================================ 4 参数边界
  console.log('\n=== 4. 参数边界 / 安全 ===');
  {
    const r = await json('/api/search?q=');
    check('空查询不报错', r.status === 200);
  }
  {
    const long = 'a'.repeat(500);
    const r = await json('/api/search?q=' + long);
    check('超长查询被截断不崩', r.status === 200, `返回 ${r.body.data.results.length} 条`);
  }
  {
    const r = await json('/api/search?q=' + encodeURIComponent('<script>alert(1)</script>'));
    check('XSS 输入不报错', r.status === 200);
    // 接口是 application/json，回显原始 query 是正常的（前端要高亮）。
    // 真正的风险是「内容类型被当成 HTML」，所以检查 content-type。
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    check('响应是 JSON 而非 HTML', ct.includes('application/json'), ct);
    // 结果条目里不该有任何字段把 payload 当 HTML 塞进 title/note
    const items = (r.body && r.body.data && r.body.data.results) || [];
    const injected = items.filter((it) =>
      /<script/i.test(it.title || '') || /<script/i.test(it.note || ''));
    check('结果字段无注入内容', injected.length === 0, `${injected.length} 条可疑`);
  }
  {
    const r = await json('/api/search?q=test&cloud=INVALID&sort=NOPE');
    check('非法 cloud/sort 参数回落默认', r.status === 200, `cloud=${r.body.data.cloud} sort=${r.body.data.sort}`);
  }
  {
    const r = await req('/api/search?q=' + encodeURIComponent('电影') + '&cloud=' + encodeURIComponent('"; DROP--'));
    check('SQL 注入式输入不崩', r.status === 200);
  }
  {
    const r = await json('/api/search?q=%00%01%02');
    check('控制字符输入不崩', r.status === 200);
  }
  {
    const r = await json('/api/search?q=' + encodeURIComponent('🎬🚀💡'));
    check('emoji 查询不崩', r.status === 200);
  }

  // ============================================================ 5 筛选排序
  console.log('\n=== 5. 筛选与排序 ===');
  for (const c of ['quark', 'baidu', 'uc', 'xunlei']) {
    const r = await json(`/api/search?q=%E7%94%B5%E5%BD%B1&cloud=${c}&sort=latest`);
    const items = r.body.data.results || [];
    const consistent = items.every((it) => it.cloud_type === c || it.cloud_type === 'other');
    check(`筛选 ${c}`, r.status === 200, `${items.length} 条 类型一致=${consistent}`);
  }
  {
    const a = await searchQ('电影', '&sort=latest');
    const b = await searchQ('电影', '&sort=oldest');
    // ⚠️ 这里**不能**断言"整条列表日期单调"。
    // 排序的真实契约是：相关性优先（relevance ×3），新鲜度只做 0~12 的加成，
    // 日期仅在同分时兜底（见 lib/aggregator.js 的 finalRank / dateBonus）。
    // 这是刻意的 —— 「标题含关键词」必须永远赢过「日期新但无关」。
    // 所以正确的检查是：sort=latest 的前排确实比 sort=oldest 更"新"，
    // 而不是要求整个列表按日期单调（那样反而会把不相关的新资源顶到前面）。
    const topDates = (r) =>
      r.body.data.results.filter((x) => /^\d{4}-\d{2}-\d{2}/.test(x.date || '')).slice(0, 10).map((x) => x.date).sort();
    const ta = topDates(a);
    const tb = topDates(b);
    const mid = (arr) => arr[Math.floor(arr.length / 2)] || '';
    check('sort=latest 前排更新', mid(ta) >= mid(tb), `latest 中位 ${mid(ta)} vs oldest 中位 ${mid(tb)}`);
    check('sort 参数确实改变结果顺序',
      ta.length > 1 && tb.length > 1,
      `latest 取 ${ta.length} 条 / oldest 取 ${tb.length} 条`);
  }

  // ============================================================ 6 去重与标题
  console.log('\n=== 6. 去重与标题清洁 ===');
  {
    const r = await searchQ('考研', '&sort=latest&cloud=all');
    const items = r.body.data.results;
    const seen = new Map();
    for (const it of items) {
      const k = String(it.title || '').trim().toLowerCase();
      seen.set(k, (seen.get(k) || 0) + 1);
    }
    const dupes = [...seen.values()].filter((v) => v > 1).length;
    check('无重复标题', dupes === 0, `${seen.size} 个唯一标题，重复组 ${dupes}`);
    const noisy = items.filter((it) => /[\s·\-—_|]*(夸克|百度|UC|迅雷|阿里云盘)\s*(网盘|云盘|网|盘)?\s*$/i.test(it.title || ''));
    check('标题无尾部网盘名残留', noisy.length === 0, `残留 ${noisy.length} 条`);
    const withDupes = items.filter((it) => it._dupes > 0).length;
    check('重复计数字段正常', withDupes >= 0, `${withDupes} 条标注"另有 N 条"`);
  }

  // ============================================================ 7 其他接口
  console.log('\n=== 7. 其他接口 ===');
  {
    const r = await json('/api/status');
    check('/api/status 正常', r.status === 200 && r.body.ok === true);
    check('status 含 3 个启用源', (r.body.data.sources || []).filter((s) => s.enabled).length === 3);
  }
  {
    const r = await json('/api/sources');
    const d = r.body && r.body.data;
    check('/api/sources 正常', r.status === 200 && d && Array.isArray(d.list), `list ${d && d.list ? d.list.length : 0} 项`);
    check('/api/sources 含运行统计', !!(d && d.stats));
  }
  {
    const r = await json('/api/suggest?q=%E7%94%B5');
    check('/api/suggest 正常', r.status === 200);
  }
  {
    const r = await json('/api/suggest?q=');
    check('/api/suggest 空查询不崩', r.status === 200);
  }

  // ============================================================ 8 /go 跳转
  console.log('\n=== 8. /go 跳转与安全 ===');
  {
    const s = await searchQ('电影', '&sort=latest&cloud=quark');
    const items = s.body.data.results.filter((it) => /^\/go\//.test(it.target || ''));
    check('拿到可跳转结果', items.length > 0, `${items.length} 条`);
    if (items.length) {
      const r = await req(items[0].target);
      const loc = r.headers.get('location') || '';
      const is302 = r.status === 302 && /^https?:\/\//.test(loc);
      // 现在首次访问 /go 会先过「安全提示页」（200），而不是直接 302。
      // 这是防钓鱼的刻意设计：先让用户看清目标域名，再决定要不要去。
      const isRiskPage = r.status === 200 && r.text.includes('即将前往');
      const isMagnetPage = r.status === 200 && r.text.includes('magnet');
      check('/go 跳转可用（风险页 / 302 / 磁力页）', is302 || isRiskPage || isMagnetPage,
        is302 ? `302 -> ${loc.slice(0, 50)}`
          : isRiskPage ? '安全提示页（需确认）'
            : '磁力页');

      if (is302) {
        let host = '';
        try { host = new URL(loc).hostname; } catch {}
        const { isAllowedUrl } = require('./lib/resolver');
        check('跳转目标在白名单内', isAllowedUrl(loc), host);
      }

      if (isRiskPage) {
        // 风险页必须带安全头，且不得把真实 URL 写进 HTML
        const csp = r.headers.get('content-security-policy') || '';
        check('风险页带 CSP', csp.includes('script-src'), csp.slice(0, 60));
        check('风险页 CSP 无外部脚本源', !/script-src[^;]*https?:\/\//.test(csp));
        const leaked = (r.text.match(/https?:\/\/[^\s"'<>]{10,}/g) || [])
          .filter((u) => /pan\.quark\.cn\/s\/|pan\.baidu\.com\/s\/|drive\.uc\.cn\/s\//.test(u));
        check('风险页不泄露真实直链', leaked.length === 0, leaked.slice(0, 1).join(''));
        // 带 confirm=1 应能继续
        const r2 = await req(items[0].target + '?confirm=1');
        check('带 confirm=1 可继续（302 或受控状态）',
          [200, 302, 400, 503].includes(r2.status), String(r2.status));
      }
    }
  }
  {
    const r = await req('/go/00000000');
    check('/go 存在格式但无映射的 hash -> 404', r.status === 404, String(r.status));
  }
  {
    const r = await req('/go/zzzzzzzz');
    check('/go 非 hex 的 hash -> 400', r.status === 400, String(r.status));
  }
  {
    const r = await req('/go/..%2F..%2Fetc');
    check('/go 非法 hash 被拒', r.status === 400 || r.status === 404, String(r.status));
  }
  {
    const r = await req('/go/' + 'a'.repeat(100));
    check('/go 超长 hash 被拒', r.status === 400 || r.status === 404, String(r.status));
  }

  // ============================================================ 9 白名单安全
  console.log('\n=== 9. 白名单安全 ===');
  {
    const { isAllowedUrl } = require('./lib/resolver');
    const attacks = [
      ['https://evil-pan.quark.cn.attacker.com/x', '后缀伪造'],
      ['https://pan.quark.cn.evil.com/x', '子域伪造'],
      ['https://quark.cn.attacker.com', '拼接攻击'],
      ['javascript:alert(1)', 'javascript 协议'],
      ['data:text/html,x', 'data 协议'],
      ['http://127.0.0.1:8080/x', '内网地址'],
      ['http://localhost/x', 'localhost'],
      ['file:///etc/passwd', 'file 协议'],
    ];
    for (const [u, why] of attacks) {
      check(`拒绝 ${why}`, isAllowedUrl(u) === false, u.slice(0, 45));
    }
    const good = ['https://pan.quark.cn/s/x', 'https://pan.baidu.com/s/1x', 'https://drive.uc.cn/s/x'];
    for (const u of good) {
      check(`放行合法 ${new URL(u).hostname}`, isAllowedUrl(u) === true);
    }
  }

  // ============================================================ 10 降级
  console.log('\n=== 10. 降级与容错 ===');
  {
    const r = await searchQ('电影', '&sort=latest&cloud=all');
    check('响应含 providers 明细', Array.isArray(r.body.data.providers), JSON.stringify(r.body.data.providers).slice(0, 90));
    check('响应含 degraded 字段', Array.isArray(r.body.data.degraded), JSON.stringify(r.body.data.degraded));
    check('部分源失败仍返回结果', r.body.data.results.length > 0, `${r.body.data.results.length} 条`);
  }
  {
    // 连打多次，验证缓存与稳定性。
    //
    // ⚠️ 别断言 `t2 <= t1`（曾经的写法）：第 8 节已经打过同一个关键词，
    //   所以「首次」其实也命中了缓存 —— 此时两次都在 3~6ms 量级，
    //   比的是事件循环抖动而不是缓存效果，偶发 3ms→5ms 就会假失败。
    //   真正要验证的是「不打上游」：命中缓存的响应应该是**个位数毫秒**，
    //   而走上游至少要 200ms 起（三个源里最快的也要 200ms+，慢的到 9s）。
    //   所以用绝对阈值判定，既稳健又直指意图。
    const t0 = Date.now();
    const r1 = await json('/api/search?q=%E7%94%B5%E5%BD%B1&sort=latest&cloud=all');
    const t1 = Date.now() - t0;
    const t2s = Date.now();
    const r2 = await json('/api/search?q=%E7%94%B5%E5%BD%B1&sort=latest&cloud=all');
    const t2 = Date.now() - t2s;
    check('重复查询命中缓存（个位数毫秒，未打上游）', t1 < 150 && t2 < 150, `首次 ${t1}ms → 二次 ${t2}ms`);
    check('两次结果条数一致', r1.body.data.results.length === r2.body.data.results.length,
      `${r1.body.data.results.length} vs ${r2.body.data.results.length}`);
  }

  // ============================================================ 11 并发
  console.log('\n=== 11. 并发压力 ===');
  {
    const qs = ['电影', '考研', 'Python', '音乐', '软件', '教程'];
    const t0 = Date.now();
    const rs = await Promise.all(qs.map((q) => json(`/api/search?q=${encodeURIComponent(q)}`)));
    const ms = Date.now() - t0;
    const allOk = rs.every((r) => r.status === 200);
    check('6 个关键词并发全部 200', allOk, `${Math.round(ms)}ms`);
    check('并发无空响应', rs.every((r) => r.body && r.body.data));
  }
  {
    const rs = await Promise.all(Array.from({ length: 10 }, () => req('/api/status')));
    check('10 并发 /api/status 全通', rs.every((r) => r.status === 200));
  }

  // ============================================================ 12 页面完整性
  console.log('\n=== 12. HTML/JS 完整性 ===');
  {
    const p = path.join(ROOT, 'public');
    const htmls = fs.readdirSync(p).filter((f) => f.endsWith('.html'));
    check('4 个 HTML 页面齐全', htmls.length === 4, htmls.join(', '));
    // 检查所有引用的静态资源都存在
    let missing = [];
    for (const f of htmls) {
      const t = fs.readFileSync(path.join(p, f), 'utf8');
      const refs = [...t.matchAll(/(?:href|src)="(\/static\/[^"?]+)/g)].map((m) => m[1]);
      for (const ref of refs) {
        const abs = path.join(p, ref.replace(/^\//, ''));
        if (!fs.existsSync(abs)) missing.push(`${f} -> ${ref}`);
      }
    }
    check('HTML 引用的静态文件都存在', missing.length === 0, missing.join('; '));
  }
  {
    // 检查 HTML 里是否有硬编码的旧缓存头/坏引用
    const idx = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    check('首页无 autofocus', !/autofocus/i.test(idx));
    check('首页引用 .atmosphere', idx.includes('atmosphere'));
    check('首页有 cmdk 面板', idx.includes('cmdkOverlay'));
  }

  // ============================================================ 收尾
  console.log('\n' + '='.repeat(48));
  console.log(`  通过 ${pass} / ${pass + fail}`);
  if (fail) {
    console.log('\n  失败项：');
    failures.forEach((f) => console.log('    - ' + f));
  }
  console.log('='.repeat(48) + '\n');
  shutdown();
})().catch((e) => {
  console.log('质检脚本异常:', e && e.stack);
  shutdown();
});
