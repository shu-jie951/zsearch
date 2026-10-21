'use strict';

/**
 * 配置中心
 * 所有可调开关集中在这里，改完重启即可生效。
 */

module.exports = {
  // 本地服务端口
  PORT: Number(process.env.PORT) || 5178,

  // 站点品牌
  BRAND: {
    en: 'ZSEARCH',
    zh: '瞬时搜',
    tagline: '网盘资源搜索引擎',
    domain: 'zsearch.local',
  },

  // ---------------------------------------------------------------------------
  // 多数据源聚合
  // ---------------------------------------------------------------------------
  // 四个源的机制互不相同、互为补充：
  //   pansou   —— 聚合上百个 TG 频道 + 插件，直接返回真实直链，字段最全（推荐主源，实测最稳）
  //   jso      —— 服务端渲染页面，真实直链内嵌在 HTML 属性里（⚠️ 已于 2026-10 实测失效，见下）
  //   hunhepan —— 开放 JSON 接口（POST /open/search/disk），带 tags/文件清单，夸克+百度为主
  //   zreso    —— 原站，返回中转链接需二次解析，且有 Turnstile 风控（最易失效）
  //
  // 数组顺序不影响优先级（并发查询），去重时按「结果质量分」择优保留。
  // 关掉某个源：从数组里删掉即可；全删则退化为本地演示数据。
  sources: {
    // ⚠️ jso 已移除（2026-10-21 实测）：j-so.com 这个域名早已换了业务，
    //    现在是一个博彩平台的 SPA 外壳。请求稳定超时 9 秒、返回 0 条，
    //    代码是「软失败」所以界面不报错 —— 但用户每次搜索都要白等满 9 秒。
    //    要恢复它，先确认目标站回到旧版 SSR 结构（/s/<kw>?__full=1 + X-Search-Full 头）。
    enabled: (process.env.SOURCES ? process.env.SOURCES.split(',') : ['pansou', 'hunhepan', 'zreso'])
      .map((s) => s.trim())
      .filter(Boolean),

    // 单个数据源整体超时（各源自己还有进程内超时，这是兜底）
    perSourceTimeoutMs: 9000,

    // 一个源返回超过这个条数就截断（防止单个源淹没其他源）
    maxPerSource: 120,

    // 聚合结果总条数上限
    maxTotal: 300,

    // 源健康与熔断：连续失败的源自动冷却，冷却期内直接跳过（耗时 0ms）。
    //   failThreshold —— 连续失败几次进冷却
    //   cooldownMs    —— 冷却时长
    //   slowEmptyMs   —— 跑满这么久还 0 条，判定为「疑似挂掉」而非「真没结果」
    health: {
      failThreshold: 3,
      cooldownMs: 10 * 60 * 1000,
      slowEmptyMs: 6000,
    },

    // 按源覆盖单次超时。
    // pansou 本身是个聚合器，要并发查上百个 TG 频道，实测 8~40 秒；
    // 但它同时是夸克资源的主要来源，砍太狠就直接表现为「搜不到夸克」。
    // 它在两阶段搜索的第二阶段才跑，用户不会干等这个时长，所以放宽到 25s。
    sourceTimeoutMs: {
      pansou: 25000,
    },
  },

  upstream: {
    // 上游站点根地址。
    //   不设该环境变量        → 用默认线上上游
    //   设为 ''              → 强制离线模式，只用本地兜底数据（不打任何上游）
    //   设为 http://...      → 指向自建/镜像上游
    //
    // 注意这里必须用 `in` 判断而不是 `||`：
    //   process.env.UPSTREAM_BASE || 'https://zreso.cn'
    // 会把有意设置的空串 '' 当成"没设置"而回落到默认上游，
    // 导致「离线模式」这个已文档化的能力根本无法通过环境变量触发（已修的 bug）。
    base: ('UPSTREAM_BASE' in process.env)
      ? process.env.UPSTREAM_BASE
      : 'https://zreso.cn',

    // 上游接口路径
    searchPath: '/api/search',

    // 单次请求超时（毫秒）
    timeoutMs: 6000,

    // 缓存 TTL（毫秒）。命中缓存直接返回，不打上游。
    cacheTtlMs: 10 * 60 * 1000,

    // 缓存最大条目数（LRU 淘汰）
    cacheMax: 300,

    // 限速：滑动窗口内最多允许多少次上游请求
    rateLimit: {
      windowMs: 60 * 1000,
      max: 30,
    },

    // 上游连续失败多少次后，进入冷却期（冷却期内直接用降级数据，不再打上游）
    circuitBreaker: {
      failThreshold: 4,
      cooldownMs: 5 * 60 * 1000,
    },

    // 伪装请求头
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      Referer: 'https://zreso.cn/',
      'X-Requested-With': 'XMLHttpRequest',
    },

    // 是否把上游的 /api/wash 中转链接在返回结果时就展开成真实网盘链接。
    // true  = 搜索接口里就地解析（结果列表拿到手就是真链，但每次搜索会多 N 次请求，慢）
    // false = 延迟解析（默认）：前端仍拿到 /go/<hash> 形式的本站链接，
    //         真正点击时才由 /go 接口解析并 302 直跳真实链接。既有缓存又够快。
    expandWashLinks: false,

    // 展开解析时的并发上限
    resolveConcurrency: 6,
  },

  // ---------------------------------------------------------------------------
  // 安全防护（防病毒 / 防钓鱼 / 防挂马）
  //
  // ⚠️ 能力边界：浏览器里做不了真正的病毒扫描。本模块做的是
  //    「跳转前风险拦截 + 域名信誉识别 + 危险文件类型标注」三件事。
  //    真杀毒请交给本机杀毒软件 —— 页面上也会这样提示用户。
  // ---------------------------------------------------------------------------
  security: {
    // 总开关。关掉后：不加安全响应头、不做风险页、不做仿冒拦截。
    //   不设该环境变量 → 默认开启
    //   设为 '0'       → 强制关闭（仅用于排查，不建议）
    // 同样用 `in` 判断，避免空串被误当成"没设置"。
    enabled: ('SECURITY' in process.env)
      ? process.env.SECURITY !== '0'
      : true,

    // 安全响应头（CSP / nosniff / frame-ancestors / permissions-policy …）
    headers: true,

    // 跳转前风险页：
    //   true  = 所有外跳都先过安全页（低风险 1 秒自动跳，中高风险需手动确认）
    //   false = 仅中高风险才过风险页，低风险直接 302（更快，但少了"看清去哪"的机会）
    riskPageForAll: true,

    // 高风险（level === 'high'，风险分 >= 70）直接拦截，不给继续按钮
    blockHighRisk: true,

    // 结果列表里给每条结果打安全标记（前端显示徽章 + 告警）
    annotateResults: true,

    // 危险文件类型 / 风险词提示（可执行文件、破解工具、诱导加群等）
    fileWarnings: true,
  },

  // 允许的网盘来源过滤
  clouds: [
    { key: 'all', label: '全部' },
    { key: 'quark', label: '夸克网盘' },
    { key: 'baidu', label: '百度网盘' },
    { key: 'uc', label: 'UC网盘' },
    { key: 'xunlei', label: '迅雷云盘' },
  ],

  // ---------------------------------------------------------------------------
  // 日志
  // ---------------------------------------------------------------------------
  // 只做一件事：把「谁请求了什么、花了多久、结果怎样」按行打出来。
  // /api/search 那几行还会带上结果条数、来源与筛选条件 —— 这才是能分析的日志，
  // 否则只能看到一堆 200。
  //
  //   关掉全部访问日志：LOG=0
  //   慢请求阈值：LOG_SLOW_MS（默认 1500ms，超过打 WARN 前缀）
  log: {
    access: process.env.LOG === '0' ? false : true,
    slowMs: Number(process.env.LOG_SLOW_MS) || 1500,
  },
};
