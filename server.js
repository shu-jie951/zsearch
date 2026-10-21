'use strict';

const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// 启动前置检查（在 require 任何第三方模块之前）
//
// 目的：把「依赖没装」这种最常见的新机器事故，从一屏看不懂的 stack trace
// 变成一句能照做的话。直接 `node server.js` / `npm start` 而没装依赖时，
// 原生报错是：
//     Error: Cannot find module 'express'
//        at Function._resolveFilename (node:internal/modules/cjs/loader:1386:15)
//        ...（十几行内部栈）
// 用户看到这个只会以为程序坏了。
// ---------------------------------------------------------------------------
(function preflight() {
  const need = ['express'];
  const missing = [];
  for (const m of need) {
    try { require.resolve(m, { paths: [__dirname] }); }
    catch { missing.push(m); }
  }
  if (missing.length) {
    const line = '='.repeat(58);
    console.error('');
    console.error(line);
    console.error('  启动失败：缺少运行依赖');
    console.error(line);
    console.error('');
    console.error('  缺少的模块：' + missing.join(', '));
    console.error('');
    console.error('  解决办法（在本目录下执行其一）：');
    console.error('    1) 双击 启动.bat          —— 会自动装依赖并启动');
    console.error('    2) npm install            —— 手动装依赖');
    console.error('    3) npm install --omit=dev —— 只装运行依赖（推荐）');
    console.error('');
    console.error('  注意：npm install 需要联网，第一次大约 10 秒。');
    console.error('  如果你在没有网络的环境：请把已有 node_modules 一并复制过来。');
    console.error(line);
    console.error('');
    process.exit(2);   // 2 = 配置/环境问题，不是崩溃
  }

  // Node 版本下限检查（package.json engines 声明 >=18，但 npm 不强制）
  const major = Number(process.versions.node.split('.')[0]);
  if (Number.isFinite(major) && major < 18) {
    console.error('');
    console.error(`  启动失败：Node 版本过低（当前 v${process.versions.node}，需要 >= 18）。`);
    console.error('  请到 https://nodejs.org/ 安装 LTS 版本后重试。');
    console.error('');
    process.exit(2);
  }
})();

const express = require('express');

const config = require('./config');
const upstream = require('./lib/upstream');
const resolver = require('./lib/resolver');
const aggregator = require('./lib/aggregator');
const sourcesMeta = require('./lib/sources');
const security = require('./lib/security');
// 注意：lib/fallback.js 仍在 upstream.js 里承担 zreso 上游不可用时的降级，
// 但搜索主链路已不再用它伪装结果（见 /api/search 里的说明）。

const app = express();
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------------------------------------------------------------------------
// 安全响应头（防挂马 / 防点击劫持 / 防 MIME 嗅探 / 防 XSS 外带）
//
// 必须放在**所有路由之前**：响应头一旦被路由里的 res.send 发出去就没机会补了。
// 也放在 express.static 之前，保证静态资源同样带上这些头。
//
// CSP 说明（最重要的两条）：
//   - script-src 只允许 'self'：**任何外部脚本源都被拒绝**。
//     这是防挂马的核心 —— 即使某个上游数据被投毒，也无法让页面加载第三方 JS。
//     （磁力页/风险页有内联脚本，那几个路由单独放宽，见 securityHeaders 的参数）
//   - object-src 'none' + frame-src 'none'：直接封死 <object>/<embed>/<iframe>
//     这类传统挂马入口。
//
// 注意：/go 之下以及 /unavailable 这些由服务端拼的 HTML 里带内联 <script>
// （复制磁力链接、自动跳转倒计时），它们走的是另一套 CSP（放宽 inline script，
// 但仍然 script-src 'self' —— 也就是**只允许内联，不允许任何外部脚本源**）。
// 这些页面顶部全部有 meta 级兜底，见 security.inlinePageHeaders。
// ---------------------------------------------------------------------------
if (config.security.enabled && config.security.headers) {
  app.use(security.securityHeaders({ allowFrame: false, allowInlineScript: false }));
}

// ---------------------------------------------------------------------------
// 进程级容错：**服务绝不能因为一个漏 catch 的异步错误就整体退出**
//
// 本项目的上游天然不稳定（PanSou 超时/限流、zreso 风控 429），任何一个
// 源适配器里没接住的 rejection 都会让 Node 直接退出并拖垮整个服务。
// 这里兜住并记录，让坏掉的那次请求失败，而不是让站点消失。
// ---------------------------------------------------------------------------
process.on('unhandledRejection', (reason) => {
  console.error('[process] 未处理的 Promise rejection（已兜住，服务继续）:', (reason && reason.message) || reason);
});
process.on('uncaughtException', (err) => {
  console.error('[process] 未捕获异常（已兜住，服务继续）:', (err && err.stack) || err);
});

app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

// ---------------------------------------------------------------------------
// 访问日志
//
// 没有访问日志时，排查只能靠"复现 + 猜"；有了之后一次搜索的耗时、结果条数、
// 命中的源分布、缓存是否生效，在终端里一行就看得到。
//
// 两个刻意的设计：
//   1. 挂在 res 的 'finish' 事件上 —— 那时 statusCode 和耗时都已经确定，
//      不会出现"先打日志后改状态码"的错位。
//   2. 慢请求单独打 WARN 前缀。日志里最容易被淹掉的就是"这条其实很慢"，
//      加个前缀之后扫一眼就能定位。
//
// 关掉：LOG=0。慢请求阈值：LOG_SLOW_MS（默认 1500）。
// ---------------------------------------------------------------------------
if (config.log && config.log.access) {
  app.use((req, res, next) => {
    const t0 = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
      const now = new Date();
      const hh = String(now.getHours()).padStart(2, '0');
      const mm = String(now.getMinutes()).padStart(2, '0');
      const ss = String(now.getSeconds()).padStart(2, '0');
      const slow = ms >= (config.log.slowMs || 1500);
      const tag = res.statusCode >= 500 ? 'ERROR' : slow ? 'WARN ' : 'INFO ';
      // 查询串里可能有超长输入，截断避免刷屏
      const qs = req.originalUrl.length > 120 ? req.originalUrl.slice(0, 117) + '...' : req.originalUrl;
      let line = `${hh}:${mm}:${ss} ${tag} ${res.statusCode} ${req.method} ${qs} ${ms}ms`;
      // /api/search 额外带上结果条数与来源，日志才有分析价值
      const si = res.locals && res.locals.searchInfo;
      if (si) {
        line += ` | 结果=${si.count} 来源=${si.source}${si.cloud && si.cloud !== 'all' ? ' 筛选=' + si.cloud : ''}` +
          `${si.fast ? ' 快速阶段' : ''}`;
      }
      const out = slow || res.statusCode >= 500 ? console.warn : console.log;
      out('[access] ' + line);
    });
    next();
  });
}

// ---------------------------------------------------------------------------
// 静态资源
//
// 缓存策略：**用协商缓存，不用强缓存**。
// 曾经这里写的是 maxAge:'7d'，结果是改完 CSS/JS 之后浏览器死活还是旧界面 ——
// 7 天强缓存期间浏览器根本不回服务端问，改多少遍都看不到效果（这是最典型的
// "我改了代码但页面没变"事故）。改成 etag/Last-Modified 协商：
//   - 内容没变 → 304，依然省流量
//   - 内容变了 → 立刻拿到新版
// 生产环境要上强缓存的话，正确做法是给文件名加内容哈希（index-a1b2c3.css），
// 而不是靠 maxAge 赌。
// ---------------------------------------------------------------------------

// 这个中间件必须注册在 express.static **之前** —— 否则请求已经被 static 处理
// 并响应完了，后面的 setHeader 根本没机会执行（踩过一次）。
// HTML 一律禁缓存：宁可每次重新校验，也不要让用户看到旧页面。
app.use((req, res, next) => {
  const isHtmlLike = /\.html?$/.test(req.path) || req.path === '/' || !path.extname(req.path);
  if (isHtmlLike) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

app.use(
  '/static',
  express.static(path.join(PUBLIC_DIR, 'static'), {
    etag: true,
    lastModified: true,
    cacheControl: true,
    maxAge: 0,                      // 不走强缓存，每次带校验
  })
);
app.use(
  express.static(PUBLIC_DIR, {
    extensions: ['html'],
    etag: true,
    lastModified: true,
    maxAge: 0,                      // HTML 更不能缓存，否则连新链接都拿不到
  })
);

// ---------------------------------------------------------------------------
// /api/search —— 多源聚合搜索
//   并发问所有启用的数据源 → 合并去重 → 统一排序 → 打上来源归属
//   全部源都空 → 退化成本地演示数据（保持原有降级行为）
// ---------------------------------------------------------------------------

/**
 * 查询归一化。
 *
 * 为什么要有这一步（实测出来的）：把 `<script>alert(1)</script>` 或 80 个 a
 * 这种输入原样丢给上游，pansou 会一直转到自己的 20 秒超时，然后回 0 条 ——
 * 也就是说污染输入能白白占住一次完整的搜索预算，期间源还被大量消耗。
 * 这些输入本来就不可能是资源关键词，没有理由让它上网。
 *
 * 三步：
 *   1. 摘掉标签、控制字符，折叠空白
 *   2. 截到 80 字（原有上限）
 *   3. 判断"这压根不是一个搜索词" → 由调用方直接短路返回
 *
 * 有效性判据刻意宽松：有中日韩字符就算数（中文单字也是有效搜索词），
 * 否则至少要两个字母数字。唯一"激进"的一条是「无中日韩、无空格、超过 40 字」，
 * 那种长串 ASCII 只会出现在乱按键盘或脚本探测里。
 */
function normalizeQuery(raw) {
  let s = typeof raw === 'string' ? raw : '';
  s = s.replace(/<[^>]{0,120}>/g, ' ');
  s = s.replace(/[\u0000-\u001f\u007f]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.slice(0, 80);

  const hasCJK = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(s);
  const alnum = (s.match(/[A-Za-z0-9]/g) || []).length;
  const longAsciiBlob = !hasCJK && !/\s/.test(s) && s.length > 40;

  return { q: s, valid: !longAsciiBlob && (hasCJK || alnum >= 2) };
}

app.get('/api/search', async (req, res) => {
  const norm = normalizeQuery(req.query.q);
  const q = norm.q;
  const sort = req.query.sort === 'oldest' ? 'oldest' : 'latest';
  const cloud = ['all', 'quark', 'baidu', 'uc', 'xunlei'].includes(req.query.cloud)
    ? req.query.cloud
    : 'all';

  // 两阶段搜索的第一阶段：6 秒上限内谁先回来先给谁看。
  //
  // 源清单的演变（2026-10 实测）：
  //   原先只放 hunhepan + zreso —— 那时它们还能回结果。现在两个都挂了
  //   （hunhepan 稳定 8 秒超时 0 条，zreso 108ms 直接 no-data），第一阶段
  //   永远是空的，用户只能对着骨架屏干等 8 秒。
  //   所以现在把 pansou 也放进来：它快的查询 1~5 秒就回（三体 953ms、
  //   甄嬛传 4970ms），慢的下沉到第二阶段，靠 pansou 的 in-flight 复用来
  //   避免重复请求上游。
  const fast = req.query.fast === '1';
  const FAST_SOURCES = ['pansou', 'hunhepan', 'zreso'];

  if (!q.trim()) {
    res.set('Cache-Control', 'no-store');
    return res.json({
      ok: true,
      data: { results: [], source: 'empty', query: q, sort, cloud, providers: [] },
    });
  }

  // 不是搜索词：立刻返回，不占上游预算（也避免 20 秒白等）
  if (!norm.valid) {
    res.set('Cache-Control', 'no-store');
    res.locals.searchInfo = { count: 0, source: 'invalid', cloud, fast };
    return res.json({
      ok: true,
      data: {
        results: [],
        source: 'invalid',
        reason: '看起来不是一个搜索词',
        query: q,
        sort,
        cloud,
        providers: [],
        suggest: ['换个具体一点的词试试', '试试作品名、课程名或软件名'],
      },
    });
  }

  try {
    // 6.5 秒是实测出来的分界：pansou 常见查询在 1~5 秒内回
    // （三体 0.95s / 甄嬛传 4.97s / 考研 12s），前两档能在第一阶段就显示。
    const agg = fast
      ? await aggregator.search(q, { sort, cloud, only: FAST_SOURCES, timeoutMs: 6500 })
      : await aggregator.search(q, { sort, cloud });

    let results = agg.items;
    let source = agg.source;
    let reason = agg.reason;

    // 所有源都没给出结果 → 不再用本地演示数据冒充结果。
    //
    // 原先是 buildFallback(q, cloud) 塞 6 条模板生成的条目，target 全是
    // /unavailable。用户看到「量子力学 全套资源合集（持续更新中）」以为搜到了，
    // 点开却是「资源不可用」—— 白跑一趟，比直接告诉他没找到更伤信任。
    // 现在返回空列表 + 查询变体建议，由前端呈现空状态。
    if (!results.length) {
      source = 'no-result';
      reason = reason || 'all-sources-empty';

      // 「等超时了」和「确实没有」必须分开说。
      // 实测 Python 这类超高频词，pansou 自己要 20s 才回来，被硬超时掐掉后
      // 用户看到的是「没有找到相关资源」—— 他下次就不会再来了，因为以为这站没货。
      // 真相是上游太慢，过几秒重试往往就有：这种时候要给「重试」，不是给「换词」。
      const anyTimedOut = (agg.providers || []).some(
        (p) => p.timedOut || p.error === 'timeout'
      );
      if (anyTimedOut) reason = 'upstream-timeout';
    }

    // 挂掉的源如实上报，不装死
    //
    // error 要往下传，否则前端只知道「失败」不知道为什么失败，只能统一说
    // 「没找到」。只放安全枚举，绝不回传上游原文（里面可能带域名 / 内部路径）。
    const SAFE_PROVIDER_ERRORS = ['timeout', 'cooling', 'no-data', 'unknown-source', 'error'];
    const safeErr = (p) => {
      if (!p.error) return null;
      if (p.timedOut || p.error === 'timeout') return 'timeout';
      if (p.skipped || p.error === 'cooling') return 'cooling';
      if (p.error === 'no-data') return 'no-data';
      if (p.error === 'unknown-source') return 'unknown-source';
      return SAFE_PROVIDER_ERRORS.includes(p.error) ? p.error : 'error';
    };
    const providers = (agg.providers || []).map((p) => ({
      id: p.id,
      count: p.count,
      ms: p.ms,
      ok: p.ok && p.count > 0,
      error: safeErr(p),
    }));

    // 把上游的 /api/wash?t=xxx 换成本站 /go/<hash> 形式，点击时再解析；
    // 已经是真实直链的（PanSou / j-so）同样走 /go，由 /go 直接 302。
    for (const item of results) {
      if (item._fallback) {
        item.target = '/unavailable';
        item.first_url = item.target;
        continue;
      }
      item.target = buildGoTarget(item);
      item.first_url = item.target;
    }

    // -----------------------------------------------------------------------
    // 安全标注：给每条结果打上风险等级，前端据此显示徽章/告警。
    // 只输出「结论 + 可读原因」，绝不输出目标 URL 原文
    //（否则等于把 /go 的白名单校验和风险页一起绕过）。
    // -----------------------------------------------------------------------
    if (config.security.enabled && config.security.annotateResults) {
      for (const item of results) {
        if (item._fallback) continue;
        try {
          const a = security.assessItem(item);
          if (!config.security.fileWarnings) {
            a.fileWarnings = [];
            a.titleWarnings = [];
            a.warnings = a.urlReasons.length ? a.urlReasons.slice() : [];
          }
          item.sec = {
            level: a.level,
            score: a.score,
            safe: a.safe,
            host: a.host,
            fileKind: a.fileKind,
            fileExt: a.fileExt,
            warnings: a.warnings.slice(0, 4),
          };
        } catch {
          // 安全标注失败绝不能影响搜索本身
          item.sec = { level: 'safe', score: 0, safe: true, warnings: [] };
        }
      }
    }

    // 只把前端真正需要的字段发出去。
    // raw_url（真实网盘直链）必须留在服务端：
    //   1. 白名单校验在 /go 里做，若把原始 URL 下发，等于把校验绕过去；
    //   2. 上游一旦返回恶意域名，前端拿到 raw_url 就可能被直接用来跳转。
    // first_url / target 都是本站的 /go/<hash> 短链（前端用 first_url 取链接），
    // 不含真实地址，可以下发。origin / _providers 等内部字段则没必要暴露。
    const PUBLIC_FIELDS = [
      'title', 'date', 'datetime', 'note', 'tags',
      'cloud_type', 'cloud_type_name', 'icon',
      'status', 'password', 'images',
      'provider', 'target', 'first_url', '_fallback', '_dupes',
      // 安全标注（结论级，不含目标 URL）
      'sec',
    ];
    const publicResults = results.map((it) => {
      const out = {};
      for (const k of PUBLIC_FIELDS) {
        if (it[k] !== undefined) out[k] = it[k];
      }
      return out;
    });

    res.set('Cache-Control', 'no-store');
    // 给访问日志留分析素材：条数 / 来源 / 筛选，这样终端里那一行才有用
    res.locals.searchInfo = {
      count: publicResults.length,
      source,
      cloud,
      fast,
    };
    res.json({
      ok: true,
      data: {
        results: publicResults,
        source,
        reason,
        query: q,
        sort,
        cloud,
        providers,
        degraded: agg.degraded || [],
        elapsedMs: agg.elapsedMs || 0,
        deduped: agg.deduped || 0,
        // 无结果时的查询变体建议（去年份 / 缩短 / 取核心词）
        suggest: agg.suggest || [],
      },
    });
  } catch (err) {
    console.error('[api/search]', err);
    res.status(500).json({ ok: false, error: 'SEARCH_FAILED' });
  }
});

/**
 * 归一化 URL，用于生成一个稳定的 hash 作为 /go 的短标识。
 */
function normalizeWash(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  // 磁力/电驴不是 URL，原样保留
  if (/^(magnet:|ed2k:)/i.test(s)) return s;
  if (s.startsWith('http')) {
    try {
      const parsed = new URL(s);
      return parsed.pathname + parsed.search;
    } catch {
      return s;
    }
  }
  return s;
}

function shortHash(str) {
  // 与前端 fallback 一致的 32 位 FNV-1a
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// 内存映射：hash -> 上游中转路径或真实链接。重启即失效，可接受。
const goMap = new Map();
const GO_MAP_MAX = 5000;

function buildGoTarget(item) {
  // 优先用真实直链（PanSou / j-so 直接给），否则用上游中转路径（zreso）
  const direct = String(item.raw_url || '').trim();
  const raw = direct || normalizeWash(item.first_url);
  if (!raw) return '';
  const h = shortHash(raw);
  const entry = goMap.get(h);
  if (entry) {
    entry.title = item.title || entry.title;
    if (direct) entry.real = direct;
    return '/go/' + h;
  }
  goMap.set(h, {
    raw,
    // 判断是否本身即真实链接（http 或 magnet/ed2k）
    real: /^https?:\/\//i.test(raw) || /^(magnet:|ed2k:)/i.test(raw) ? raw : '',
    title: item.title || '',
  });
  if (goMap.size > GO_MAP_MAX) {
    // 简单淘汰：删最早插入的
    goMap.delete(goMap.keys().next().value);
  }
  return '/go/' + h;
}

async function expandInPlace(results) {
  const concurrency = Math.max(1, config.upstream.resolveConcurrency);
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, results.length) }, async () => {
    while (idx < results.length) {
      const cur = results[idx++];
      const real = await resolver.resolveWash(normalizeWash(cur.first_url), config.upstream.base);
      if (real) {
        cur.first_url = real;
        cur.resolved = true;
      }
    }
  });
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// /go/:hash —— 跳转前安全把关 + 跳真实网盘链接
//
// 流程改造（防病毒 / 防钓鱼的核心）：
//   旧行为：命中白名单就直接 302 —— 用户根本没机会看清要去哪儿。
//   新行为：
//     1. 解析出目标地址；
//     2. 用 security.assessUrl 做域名信誉评估（仿冒/裸IP/可疑后缀/同形字）；
//     3. high 风险 → 直接拦截页（不给继续按钮）；
//     4. safe/low  → 风险页（1 秒后自动跳）；medium → 风险页且需手动确认；
//     5. 用户点「继续访问」→ 带 ?confirm=1 回到本路由，此时才真正 302。
//
//   ⚠️ 关键设计：真实 URL **从不写进 HTML**。
//   风险页只显示域名（给用户看），"继续"按钮指向本路由的 ?confirm=1，
//   由服务端完成 302。这样即使有人抓取风险页 HTML，也拿不到真实直链。
// ---------------------------------------------------------------------------
app.get('/go/:hash', async (req, res) => {
  const h = String(req.params.hash || '');
  if (!/^[0-9a-f]{1,16}$/i.test(h)) return res.status(400).send('bad hash');

  const entry = goMap.get(h);
  if (!entry) {
    return security.sendHtmlPage(
      res, 404,
      renderNotice('链接已过期', '本站中转映射会随服务重启清空。请返回搜索页重新搜索该资源。')
    );
  }

  const raw = entry.raw;
  const target = entry.real || raw;
  const confirmed = req.query.confirm === '1';
  const secOn = config.security.enabled;

  // 磁力 / 电驴：浏览器无法 302 接管，渲染风险页 + 可点击按钮，交给本地下载工具
  if (resolver.isMagnetLike(target)) {
    if (secOn && !confirmed) {
      // 磁力链接同样过风险页（磁力常被用来分发盗版/恶意种子）
      const risk = security.assessUrl('https://' + guessHostFromTitle(entry.title));
      return security.sendHtmlPage(res, 200, security.renderRiskPage({
        target: 'magnet:',
        goHash: '/go/' + h,
        title: entry.title,
        risk: risk.level === 'safe' ? { level: 'low', score: 0, reasons: [], notes: ['磁力链接本身不含文件名信息，请核对来源后再下载'] } : risk,
        magnet: target,
      }));
    }
    return security.sendHtmlPage(res, 200, renderMagnetPage(entry.title, target));
  }

  // 已经是真实网盘链接
  if (/^https?:\/\//i.test(target)) {
    // 白名单之外 —— 一律拦截
    if (!resolver.isAllowedUrl(target)) {
      return security.sendHtmlPage(
        res, 400,
        renderNotice('非受信任的链接', '该结果指向的域名不在支持列表内，已被拦截。')
      );
    }

    if (!secOn) return res.redirect(302, target);

    const risk = security.assessUrl(target);

    // 高风险：直接拦，不给跳
    if (risk.level === 'high' && config.security.blockHighRisk) {
      return security.sendHtmlPage(
        res, 200,
        security.renderBlockedPage(risk.host, risk.reasons, entry.title)
      );
    }

    // 已确认 → 真跳
    if (confirmed) return res.redirect(302, target);

    // 低风险且不要全量过页 → 直接跳（保持速度）
    if (!config.security.riskPageForAll && (risk.level === 'safe' || risk.level === 'low')) {
      return res.redirect(302, target);
    }

    // 否则渲染风险页（低风险 1 秒自动跳 / 中风险手动确认）
    return security.sendHtmlPage(res, 200, security.renderRiskPage({
      target,
      goHash: '/go/' + h,
      title: entry.title,
      risk,
      cloud: '',
    }));
  }

  // 还是上游中转路径：解析出 raw_url 后再走同一套把关
  const real = await resolver.resolveWash(raw, config.upstream.base);
  if (real && resolver.isAllowedUrl(real)) {
    if (!secOn) return res.redirect(302, real);

    const risk = security.assessUrl(real);
    if (risk.level === 'high' && config.security.blockHighRisk) {
      return security.sendHtmlPage(
        res, 200,
        security.renderBlockedPage(risk.host, risk.reasons, entry.title)
      );
    }
    if (confirmed) return res.redirect(302, real);
    if (!config.security.riskPageForAll && (risk.level === 'safe' || risk.level === 'low')) {
      return res.redirect(302, real);
    }
    return security.sendHtmlPage(res, 200, security.renderRiskPage({
      target: real,
      goHash: '/go/' + h,
      title: entry.title,
      risk,
    }));
  }

  // 解析失败：退化为跳到上游中转页（用户仍可自己完成剩余步骤）
  if (config.upstream.base) {
    const fallbackUrl = new URL(raw, config.upstream.base).toString();
    return security.sendHtmlPage(
      res, 200,
      renderNotice('无法直接跳转', '自动解析失败，正在打开资源页…', fallbackUrl)
    );
  }

  return security.sendHtmlPage(
    res, 503,
    renderNotice('链接不可用', '当前处于离线模式，资源链接无法解析。')
  );
});

/**
 * 从标题里粗略猜一个"看起来像域名"的字符串，仅用于磁力链接的风险评估展示。
 * 猜不出就返回一个中立域名，让风险评估走默认分支。
 */
function guessHostFromTitle(title) {
  const m = String(title || '').match(/\b([a-z0-9-]+\.)+[a-z]{2,}\b/i);
  return m ? m[0].toLowerCase() : 'example.invalid';
}

// ---------------------------------------------------------------------------
// /unavailable —— 演示数据的说明页
// ---------------------------------------------------------------------------
app.get('/unavailable', (req, res) => {
  security.sendHtmlPage(
    res, 200,
    renderNotice(
      '演示数据，无真实链接',
      '当前上游数据源暂不可用，此条为本地演示数据，仅用于界面展示，不指向真实资源。请稍后重新搜索，或访问上游站点查看。'
    )
  );
});

/**
 * 磁力 / 电驴链接的展示页。
 * 浏览器对 magnet: 协议不会自动跳转，需要用户点击，且由系统唤起本地下载工具。
 */
function renderMagnetPage(title, magnet) {
  const safeTitle = escapeHtml(title || '磁力链接');
  const safeMagnet = escapeHtml(magnet);
  const short = escapeHtml(magnet.length > 96 ? magnet.slice(0, 96) + '…' : magnet);
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeTitle}</title>
<style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
background:#fbfaf9;color:#18181b;padding:24px}
.card{max-width:520px;text-align:center;width:100%}
h1{font-size:17px;font-weight:600;margin:0 0 8px;letter-spacing:-.02em}
p{font-size:13.5px;line-height:1.65;color:#71717a;margin:0 0 18px}
code{display:block;font-size:11.5px;line-height:1.6;color:#52525b;background:rgba(0,0,0,.045);
padding:12px 14px;border-radius:10px;text-align:left;word-break:break-all;margin-bottom:18px;
font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;max-height:120px;overflow:auto}
.btn{display:inline-block;font-size:13.5px;color:#fff;background:#18181b;text-decoration:none;
border:none;padding:10px 22px;border-radius:9999px;cursor:pointer;transition:opacity .15s ease;
font-family:inherit}
.btn:hover{opacity:.85}
.btn.ghost{background:transparent;color:#18181b;border:1px solid rgba(0,0,0,.14);margin-left:8px}
.hint{font-size:12px;color:#a1a1aa;margin-top:16px}
@media (prefers-color-scheme:dark){
body{background:#121212;color:#f4f4f5}
p{color:#a1a1aa}
code{color:#d4d4d8;background:rgba(255,255,255,.07)}
.btn{background:#f4f4f5;color:#18181b}
.btn.ghost{background:transparent;color:#f4f4f5;border-color:rgba(255,255,255,.16)}
.hint{color:#71717a}
}
</style></head><body><div class="card">
<h1>${safeTitle}</h1>
<p>这是一个磁力 / 电驴链接，需要由本地下载工具接管。</p>
<code id="m">${short}</code>
<a class="btn" id="open" href="${safeMagnet}" rel="noopener noreferrer">唤起下载工具</a>
<button class="btn ghost" id="copy">复制链接</button>
<p class="hint">若没有反应，请手动复制上方链接到 qBittorrent / 迅雷 / 比特彗星等。</p>
</div><script>
var full = ${JSON.stringify(magnet)};
document.getElementById('copy').addEventListener('click', function () {
  var b = this;
  navigator.clipboard.writeText(full).then(function () {
    b.textContent = '已复制'; setTimeout(function () { b.textContent = '复制链接'; }, 1500);
  });
});
</script></body></html>`;
}

function renderNotice(title, desc, redirectTo) {
  const safeTitle = escapeHtml(title);
  const safeDesc = escapeHtml(desc);
  const meta = redirectTo
    ? `<meta http-equiv="refresh" content="1;url=${escapeHtml(redirectTo)}">`
    : '';
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeTitle}</title>${meta}
<style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
background:#fbfaf9;color:#18181b;padding:24px}
.card{max-width:420px;text-align:center}
h1{font-size:18px;font-weight:600;margin:0 0 10px;letter-spacing:-.02em}
p{font-size:13.5px;line-height:1.6;color:#71717a;margin:0}
a{display:inline-block;margin-top:20px;font-size:13.5px;color:#18181b;
text-decoration:none;border:1px solid rgba(0,0,0,.12);padding:9px 18px;border-radius:9999px;
transition:all .15s ease}
a:hover{background:rgba(0,0,0,.05)}
@media (prefers-color-scheme:dark){
body{background:#121212;color:#f4f4f5}
p{color:#a1a1aa}
a{color:#f4f4f5;border-color:rgba(255,255,255,.14)}
a:hover{background:rgba(255,255,255,.08)}
}
</style></head><body><div class="card">
<h1>${safeTitle}</h1><p>${safeDesc}</p>
<a href="/">返回搜索</a>
</div></body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------------------------------------------------------------------------
// /api/suggest —— 智能搜索联想
//   三路来源，按可信度排序：
//     1) 动态热词：用户真实搜过「且有结果」的词（aggregator 记录，最强信号）
//     2) 本地词库：按品类分组的高频词
//   匹配规则：前缀命中优先于包含命中（"考研" 输 "考" 时，考研数学 应排在
//   四级真题 前面——虽然后者也"包含"考字）。
// ---------------------------------------------------------------------------
const HOT_WORDS = [
  // 考试学习
  '考研', '考研数学', '考研英语', '考研政治', '四级真题', '六级真题',
  '公务员考试', '教师资格证', '会计中级', '法考', '二级建造师', '雅思', '托福',
  '高考真题', '专升本', '注册会计师',
  // 教程技能
  'Python 教程', 'PS 教程', 'Excel 教程', 'PR 教程', 'AE 教程', '剪辑教程',
  '前端教程', 'Java 教程', 'CAD 教程', '吉他教程', '摄影教程', '钢琴教程',
  // 影视
  '电影天堂', '美剧', '韩剧', '纪录片', '动漫', '国漫', '日漫', '短剧',
  '豆瓣 Top250', '奥本海默', '周星驰', '漫威', '甄嬛传',
  // 音乐
  '周杰伦', '无损音乐', '车载音乐', '钢琴曲', '陈奕迅', '林俊杰', '经典老歌',
  // 软件
  'Office 2021', 'Adobe 全家桶', 'Windows 11', '虚拟机', 'PS 安装包', '剪映',
  // 书籍文档
  '电子书', 'Kindle', '小说合集', '豆瓣高分', '三体', '古籍', '杂志',
];

app.get('/api/suggest', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ ok: true, data: [] });

  const lq = q.toLowerCase();
  // 前缀命中 > 包含命中；动态热词 > 本地词库
  const score = (w) => {
    const lw = w.toLowerCase();
    if (lw === lq) return -1; // 与输入完全相同没意义
    if (lw.startsWith(lq)) return 2;
    if (lw.includes(lq)) return 1;
    return 0;
  };

  const seen = new Set();
  const out = [];

  // 动态热词优先（真实验证过有结果的查询）
  for (const w of aggregator.getHotQueries(60)) {
    if (out.length >= 6) break;
    if (score(w) > 0 && !seen.has(w.toLowerCase())) {
      seen.add(w.toLowerCase());
      out.push(w);
    }
  }
  // 本地词库补齐，前缀优先
  const local = HOT_WORDS
    .map((w) => ({ w, s: score(w) }))
    .filter((x) => x.s > 0 && !seen.has(x.w.toLowerCase()))
    .sort((a, b) => b.s - a.s || a.w.length - b.w.length);
  for (const x of local) {
    if (out.length >= 8) break;
    seen.add(x.w.toLowerCase());
    out.push(x.w);
  }

  res.json({ ok: true, data: out });
});

// ---------------------------------------------------------------------------
// /api/link/check-batch —— 链接状态批量探测（真正去问网盘）
//
// 早期版本这里只回 'unknown'（查 goMap 有没有 ok 标记），等于什么都没做，
// 前端"批量探活"点下去一片灰点。现在改成真调 lib/linkCheck，并按 hash 缓存：
//   - 单条结果 10 分钟内复用，重复点"重新探活"不会把网盘打爆；
//   - 并发固定 4：夸克 token 接口对突发并发敏感，8 以上开始大量超时；
//   - 前端按 8 条一批串行调本接口，配合这里的 4 并发，实际峰值并发就是 4。
//
// 判定能力（实测，见 lib/linkCheck.js 头部）：
//   夸克 / UC → 真判断（有效 / 失效）
//   百度 / 迅雷 / 磁力 / 其他 → unknown（无登录态或纯前端渲染，不猜）
//
// 入参：{ hashes: ['a1b2c3d4', ...] }（也接受 '/go/a1b2c3d4' 形式，前端省一次处理）
// 出参：{ ok, data: { <hash>: { status, message, cached } } }
//   status ∈ valid | invalid | unknown
// ---------------------------------------------------------------------------
const CHECK_CACHE_TTL = 10 * 60 * 1000;
const CHECK_CONCURRENCY = 4;

app.post('/api/link/check-batch', async (req, res) => {
  const input = Array.isArray(req.body && req.body.hashes) ? req.body.hashes : [];

  const hashes = [];
  for (const raw of input) {
    const s = String(raw || '').trim().replace(/^\/go\//i, '');
    if (!/^[0-9a-f]{1,16}$/i.test(s)) continue;
    if (!hashes.includes(s)) hashes.push(s);
    if (hashes.length >= 24) break;   // 单次上限，防止有人拿来当扫描器
  }

  res.set('Cache-Control', 'no-store');
  if (!hashes.length) return res.json({ ok: true, data: {} });

  const linkCheck = require('./lib/linkCheck');
  const out = {};
  let cursor = 0;

  const worker = async () => {
    while (cursor < hashes.length) {
      const h = hashes[cursor++];
      const entry = goMap.get(h);

      if (!entry) {
        out[h] = { status: 'unknown', message: '中转映射已过期（服务重启会清空），请重新搜索' };
        continue;
      }

      // 命中缓存
      if (entry.check && Date.now() - entry.check.at < CHECK_CACHE_TTL) {
        out[h] = { status: entry.check.status, message: entry.check.message || '', cached: true };
        continue;
      }

      const target = entry.real || entry.raw;
      if (!/^https?:\/\//i.test(target) && !/^(magnet:|ed2k:)/i.test(target)) {
        out[h] = { status: 'unknown', message: '该来源不支持有效性检测' };
        continue;
      }

      try {
        const r = await linkCheck.check(target);
        const status = ['valid', 'invalid'].includes(r.status) ? r.status : 'unknown';
        entry.check = { status, message: r.message || '', at: Date.now() };
        out[h] = { status, message: r.message || '', kind: r.kind };
      } catch (err) {
        out[h] = { status: 'unknown', message: err.message };
      }
    }
  };

  try {
    await Promise.all(
      Array.from({ length: Math.min(CHECK_CONCURRENCY, hashes.length) }, worker)
    );
  } catch (err) {
    console.error('[api/link/check-batch]', err);
  }

  return res.json({ ok: true, data: out });
});

// ---------------------------------------------------------------------------
// /api/link/check —— 单条链接有效性检测（按需触发，不批量预取）
//   与批量接口共用 lib/linkCheck 与同一份缓存，避免两条路径结论不一致。
// ---------------------------------------------------------------------------
app.get('/api/link/check', async (req, res) => {
  const h = String(req.query.h || '').trim();
  if (!/^[0-9a-f]{1,16}$/i.test(h)) {
    return res.status(400).json({ ok: false, error: 'BAD_HASH' });
  }
  const entry = goMap.get(h);
  if (!entry) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });

  const target = entry.real || entry.raw;
  if (!/^https?:\/\//i.test(target) && !/^(magnet:|ed2k:)/i.test(target)) {
    return res.json({ ok: true, data: { status: 'unknown', message: '该来源暂不支持检测' } });
  }

  res.set('Cache-Control', 'no-store');

  if (entry.check && Date.now() - entry.check.at < CHECK_CACHE_TTL) {
    return res.json({
      ok: true,
      data: { status: entry.check.status, message: entry.check.message || '', cached: true },
    });
  }

  try {
    const r = await require('./lib/linkCheck').check(target);
    const status = ['valid', 'invalid'].includes(r.status) ? r.status : 'unknown';
    entry.check = { status, message: r.message || '', at: Date.now() };
    return res.json({ ok: true, data: { status, message: r.message || '', kind: r.kind } });
  } catch (err) {
    return res.json({ ok: true, data: { status: 'unknown', message: err.message } });
  }
});

// ---------------------------------------------------------------------------
// /favicon.ico —— 浏览器会自动请求根路径的 favicon，即使页面已声明 SVG 图标。
// 不处理的话每次访问都会在控制台留一条 404，看着像 bug。这里 302 到 SVG。
// （必须在 404 兜底之前注册，否则会被兜底吃掉）
// ---------------------------------------------------------------------------
app.get('/favicon.ico', (req, res) => {
  res.redirect(302, '/static/favicon.svg');
});

// ---------------------------------------------------------------------------
// /api/security/check —— 按需评估一条链接/标题的风险（不返回目标 URL 原文）
//
// 用途：前端在结果卡片上做「风险详情」展开；也供自检脚本验证规则。
// 入参：h=/go 的 hash（推荐，走服务端映射，前端从不持有真实 URL）
//       title= 可选标题（用于文件类型/风险词判定）
// ---------------------------------------------------------------------------
app.get('/api/security/check', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!config.security.enabled) {
    return res.json({ ok: false, error: 'SECURITY_DISABLED' });
  }
  const h = String(req.query.h || '').trim();
  const title = String(req.query.title || '').slice(0, 200);

  let url = '';
  if (h) {
    if (!/^[0-9a-f]{1,16}$/i.test(h)) {
      return res.status(400).json({ ok: false, error: 'BAD_HASH' });
    }
    const entry = goMap.get(h);
    if (!entry) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
    url = entry.real || entry.raw;
    if (!/^https?:\/\//i.test(url)) url = '';
  }

  const urlRisk = url ? security.assessUrl(url) : { level: 'safe', score: 0, host: '', reasons: [], notes: [] };
  const fileKind = security.assessFileKind(title);
  const titleRisk = security.assessTitle(title);

  return res.json({
    ok: true,
    data: {
      level: urlRisk.level,
      score: urlRisk.score,
      host: urlRisk.host,
      reasons: urlRisk.reasons,
      notes: urlRisk.notes,
      fileKind: fileKind.kind,
      fileExt: fileKind.ext,
      fileLabel: fileKind.label,
      titleRisk: titleRisk.risky ? titleRisk.reason : '',
    },
  });
});

// ---------------------------------------------------------------------------
// /api/sources —— 当前启用的数据源与各自的运行统计
// ---------------------------------------------------------------------------
app.get('/api/sources', (req, res) => {
  res.json({ ok: true, data: { list: sourcesMeta.describe(), stats: sourcesMeta.stats() } });
});

// ---------------------------------------------------------------------------
// /api/status —— 运行状态，方便排查
// ---------------------------------------------------------------------------
app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    data: {
      brand: config.BRAND,
      offlineMode: !config.upstream.base,
      upstream: config.upstream.base || '(offline)',
      sources: sourcesMeta.describe(),
      // 各源健康度：连续失败会进冷却，冷却期内直接跳过（耗时 0ms）
      sourceHealth: require('./lib/sourceHealth').snapshot(),
      aggregateStats: aggregator.getStats(),
      upstreamStats: upstream.getStats(),
      resolverStats: resolver.getStats(),
      goMapSize: goMap.size,
      allowedHosts: resolver.ALLOWED_HOSTS,
      // 安全防护状态：把"开了哪些防护"如实暴露，便于排查与自证
      security: {
        enabled: config.security.enabled,
        headers: !!(config.security.enabled && config.security.headers),
        riskPage: !!(config.security.enabled && config.security.riskPageForAll),
        blockHighRisk: !!(config.security.enabled && config.security.blockHighRisk),
        annotateResults: !!(config.security.enabled && config.security.annotateResults),
        fileWarnings: !!(config.security.enabled && config.security.fileWarnings),
        brands: security.BRANDS.map((b) => b.host),
        dangerousExt: Array.from(security.DANGEROUS_EXT),
        suspiciousTlds: Array.from(security.SUSPICIOUS_TLDS),
        note: '浏览器内不做真实病毒扫描；此处为跳转前风险拦截 + 域名信誉识别 + 危险文件类型标注',
      },
      // 进程级指标：长跑/压测时用来观察是否内存失控
      processStats: (() => {
        const m = process.memoryUsage();
        const toMB = (n) => Math.round((n / 1024 / 1024) * 10) / 10;
        return {
          pid: process.pid,
          uptimeSec: Math.round(process.uptime()),
          rssMB: toMB(m.rss),
          heapUsedMB: toMB(m.heapUsed),
          heapTotalMB: toMB(m.heapTotal),
          externalMB: toMB(m.external),
          node: process.version,
          platform: process.platform,
        };
      })(),
    },
  });
});

// ---------------------------------------------------------------------------
// 页面路由
// ---------------------------------------------------------------------------
app.get('/search', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'search.html')));
app.get('/disclaimer', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'disclaimer.html')));

// 程序化优雅停止（回环限定）。必须注册在下面的 404 兜底**之前**。
app.post('/__shutdown', handleShutdownRequest);

app.use((req, res) => {
  res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'));
});

// 显式绑定 0.0.0.0。
// Express 省略 host 时默认就是 0.0.0.0，但部署到容器 / 云平台时，
// 只要哪天有人补上一个 '127.0.0.1'（比如为了"更安全"），外部就再也访问不到，
// 而本地测试完全正常 —— 这种问题排查成本极高。写死在这里，一眼可见。
const server = app.listen(config.PORT, '0.0.0.0', () => {
  const b = config.BRAND;
  const srcs = sourcesMeta.describe().filter((s) => s.enabled);
  console.log('');
  console.log(`  ${b.en} · ${b.zh}  ——  ${b.tagline}`);
  console.log(`  本地地址:  http://localhost:${config.PORT}`);
  console.log(`  数据源:    ${srcs.length ? srcs.map((s) => `${s.label}(${s.id})`).join(' + ') : '无（离线演示数据）'}`);
  console.log(`  上游:      ${config.upstream.base ? 'zreso → ' + config.upstream.base : '未启用'}`);
  console.log('');
});

// 端口被占 / 无权限时给出明确原因，而不是抛一堆栈让人猜。
// 退出码 2 = "配置问题，别自动重启"（启动.bat 识别这个码后直接停下），
// 否则端口不会自己空出来，自动重启会变成死循环。
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error('');
    console.error(`  [启动失败] 端口 ${config.PORT} 已被占用。`);
    console.error('  处理方式二选一：');
    console.error('    1) 关掉占用该端口的旧进程（任务管理器 / 资源监视器找 node.exe）');
    console.error(`    2) 换端口启动：  set PORT=5179 && npm start`);
    console.error('');
    process.exit(2);
  }
  console.error('[启动失败]', (err && err.stack) || err);
  process.exit(2);
});

// ---------------------------------------------------------------------------
// 优雅退出
// ---------------------------------------------------------------------------
// ⚠️ Windows 平台注意（已实测，别再被坑）：
//   Node 在 Windows 上「注册」SIGINT/SIGTERM 是允许的，但只有**真实控制台**
//   里的 Ctrl+C / Ctrl+Break 才会把信号投递到 JS。任何走
//   `process.kill(pid, sig)` / `child.kill(sig)` / `Stop-Process` 的调用，
//   底层是 TerminateProcess —— 进程立刻死，JS handler **一次都不会执行**。
//   实测：`child.kill('SIGTERM')` → exit { code: null, signal: 'SIGTERM' }，
//         日志里没有任何 handler 输出；而 HTTP 通道 → { code: 0 }，日志完整。
//
//   所以本服务提供两条停止路径：
//     1) 手动：在 启动.bat 的控制台窗口按 Ctrl+C（信号可达，走 handler）
//     2) 程序化：本地回环 POST /__shutdown（见下方路由），供脚本/运维/测试使用
//
//   `启动.bat` 跑在前台，正是为了让路径 1 可用；关窗口同样能停。

const shutdown = (sig, code = 0) => {
  console.log(`\n[process] 收到 ${sig}，关闭服务…`);
  server.close(() => process.exit(code));
  // 兜底：2s 内没关干净也退出，避免挂住窗口
  setTimeout(() => process.exit(code), 2000).unref();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
// Windows 特有：控制台 Ctrl+Break / 关窗口
process.on('SIGBREAK', () => shutdown('SIGBREAK'));

// 程序化停止通道：只监听回环地址，只接受本机请求。
// 存在意义：Windows 下 SIGTERM 不可捕获，脚本没有任何办法优雅停服，
// 只能强杀（留下半截 socket / 未 flush 的日志）。有这条通道，
// 自动化里就可以 `curl -X POST http://127.0.0.1:<port>/__shutdown` 干净收尾。
//
// 注意：这里只声明 handler 函数，注册（app.post）必须放在 404 兜底路由**之前**，
// 否则会被 catch-all 吃掉。见下方路由区。
function handleShutdownRequest(req, res) {
  const ip = (req.socket && req.socket.remoteAddress) || '';
  const isLoopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLoopback) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
  res.json({ ok: true, closing: true });
  // 先把响应 flush 出去，再关服务
  res.on('finish', () => setTimeout(() => shutdown('HTTP /__shutdown'), 60));
}
