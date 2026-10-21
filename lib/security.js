'use strict';

/**
 * 安全防护层（防病毒 / 防钓鱼 / 防挂马）
 *
 * ⚠️ 先把边界说清楚，避免过度承诺 ——
 * 浏览器里**没有办法**对下载到本地的文件做真正的病毒扫描（没有文件系统、
 * 没有杀毒引擎、也不该有）。真正杀毒必须由本机杀毒软件完成。
 *
 * 本模块能做的、也确实有价值的三件事：
 *
 *   1. 跳转前风险拦截（pre-redirect guard）
 *      在用户被 302 带走之前，先把目标域名摊开给用户看，可疑就拦下。
 *      绝大多数「网盘搜索 → 挂马站」的链路，死在这一步。
 *
 *   2. 域名信誉 / 仿冒识别（lookalike detection）
 *      识别 pane-quark.com、panbaidu.com、quark-cn.xyz 这类"蹭大厂名字"的
 *      仿冒域名，以及裸 IP、非常规端口、超长随机串、punycode 同形字等特征。
 *      → 返回 risk 等级 + 可读原因，交给前端/跳转页告警。
 *
 *   3. 危险文件类型标注
 *      从标题 / 链接里识别 .exe/.scr/.bat/.vbs/.js/.msi/.apk 等可执行载荷，
 *      在结果卡片和跳转页上明示"这是可执行文件，下载后请先杀毒"。
 *
 * 不做的：不抓取、不执行、不下载任何文件。
 */

const config = require('../config');

// ---------------------------------------------------------------------------
// 一、可信网盘主域名（用于仿冒识别）
//
// 与 resolver.ALLOWED_HOSTS 的区别：
//   ALLOWED_HOSTS 决定「能不能跳转」（安全边界，只收叶子域名，从严）；
//   BRANDS 决定「是不是大厂品牌」（用于识别蹭名仿冒，收品牌本身即可）。
// 两者用途不同，不要合并。
// ---------------------------------------------------------------------------
const BRANDS = [
  { host: 'quark.cn', name: '夸克网盘' },
  { host: 'baidu.com', name: '百度网盘' },
  { host: 'uc.cn', name: 'UC 网盘' },
  { host: 'xunlei.com', name: '迅雷网盘' },
  { host: '189.cn', name: '天翼云盘' },
  { host: 'aliyundrive.com', name: '阿里云盘' },
  { host: 'alipan.com', name: '阿里云盘' },
  { host: '123pan.com', name: '123 网盘' },
  { host: '123pan.cn', name: '123 网盘' },
  { host: '139.com', name: '移动云盘' },
  { host: 'mypikpak.com', name: 'PikPak' },
  { host: 'pikpak.com', name: 'PikPak' },
  { host: '115.com', name: '115 网盘' },
  { host: 'guangyapan.com', name: '光雅盘' },
  { host: 'drive.google.com', name: 'Google Drive' },
  { host: 'mega.nz', name: 'MEGA' },
  { host: 'dropbox.com', name: 'Dropbox' },
  { host: 'mediafire.com', name: 'MediaFire' },
];

// 常见「大厂顶级域」—— 这些顶级域下若出现非官方子域，风险显著升高
const BIG_TLDS = [
  'baidu.com', 'uc.cn', 'xunlei.com', '189.cn', '139.com', '115.com',
  'google.com', 'microsoft.com', 'apple.com', 'qq.com', 'weixin.qq.com',
  'taobao.com', 'alipay.com', 'jd.com', 'alibaba.com', 'aliyun.com',
];

// ---------------------------------------------------------------------------
// 二、危险文件扩展名（可能携带可执行载荷）
// ---------------------------------------------------------------------------
const DANGEROUS_EXT = new Set([
  'exe', 'msi', 'scr', 'com', 'pif', 'bat', 'cmd', 'ps1', 'psm1',
  'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta', 'jar', 'lnk', 'reg',
  'apk', 'dmg', 'app', 'run', 'bin', 'iso', 'img', 'vhd',
  'dll', 'sys', 'cpl', 'ocx', 'gadget', 'application',
]);

const ARCHIVE_EXT = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'cab', 'arj', 'lzh', 'z']);

// 伪装型双扩展名：report.pdf.exe / 电影.mp4.scr / 图片.jpg.vbs
const DOUBLE_EXT_RE = /\.([a-z0-9]{2,5})\.(exe|scr|bat|cmd|vbs|js|jse|wsf|hta|com|pif|ps1)$/i;

const DANGEROUS_WORDS = [
  { re: /激活工具|破解补丁|注册机|keygen|crack|破解版/i, label: '破解/激活工具', weight: 30 },
  { re: /外挂|辅助工具|刷\d+|秒杀软件/i, label: '外挂/辅助类工具', weight: 40 },
  { re: /免费领|扫码领|加微信|加QQ|进群|客服领取/i, label: '诱导加群/加好友', weight: 35 },
  { re: /解压密码|密码在|关注后|转存后|提取码在/i, label: '诱导关注/转存', weight: 15 },
  { re: /秒传|破解会员|vip破解|会员共享账号/i, label: '破解会员类', weight: 25 },
];

// ---------------------------------------------------------------------------
// 三、可疑域名特征
// ---------------------------------------------------------------------------
const SUSPICIOUS_TLDS = new Set([
  'top', 'xyz', 'buzz', 'click', 'loan', 'work', 'date', 'men', 'review',
  'country', 'stream', 'gdn', 'racing', 'win', 'bid', 'download', 'trade',
  'party', 'wang', 'ren', 'kim', 'science', 'cam', 'rest', 'monster',
  'quest', 'cyou', 'sbs', 'icu',
]);

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/** punycode / 同形字：xn-- 开头的域名可能是视觉仿冒 */
function hasPunycode(host) {
  return /(^|\.)xn--/i.test(host);
}

/** 去掉 www. 前缀，取"主域"（最后两段，或常见三级） */
function rootDomain(host) {
  const h = String(host).toLowerCase().replace(/^www\./, '');
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  // 处理 xxx.com.cn / xxx.co.uk 这类两段后缀
  const two = parts.slice(-2).join('.');
  const three = parts.slice(-3).join('.');
  const MULTI = ['com.cn', 'net.cn', 'org.cn', 'gov.cn', 'co.uk', 'com.hk', 'com.tw', 'co.jp'];
  if (MULTI.includes(two)) return three;
  return two;
}

/** 轻量 Levenshtein（带早停），用于仿冒域名的编辑距离判断 */
function levenshtein(a, b, max = 3) {
  if (a === b) return 0;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  let prev = new Array(lb + 1);
  let cur = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= lb; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    const t = prev; prev = cur; cur = t;
  }
  return prev[lb];
}

/**
 * 仿冒域名识别：把可疑域名与品牌域名做对比。
 * 例：panbaidu.com（缺分隔符）、pan-quark.com（多分隔符）、
 *     quarkcn.net（品牌名 + 换后缀）、pane-quark.com（插入字符）。
 *
 * ⚠️ 例外：同一个品牌可能**合法拥有多个后缀**（123pan.com 与 123pan.cn
 *    都是官方）。所以"同名不同后缀"这条规则必须先排除"该后缀本身也在
 *    BRANDS 里"的情况，否则 123pan.cn 会被自己的兄弟域名误判成仿冒
 *    （这个误报实测出现过，见 _qa_security.js S9）。
 */
function detectLookalike(host) {
  const root = rootDomain(host);
  const rootName = root.split('.')[0];
  const rootTld = root.split('.').slice(1).join('.');

  // 该 host 本身（或其主域）就是官方登记域名 → 直接放行
  if (BRANDS.some((b) => b.host === host || rootDomain(b.host) === root)) {
    return {
      lookalike: false,
      official: true,
      brand: (BRANDS.find((b) => b.host === host || rootDomain(b.host) === root) || {}).name,
    };
  }

  // "同名不同后缀" 是否属于品牌的另一个官方后缀
  const siblingTlds = new Set(
    BRANDS.filter((b) => rootDomain(b.host).split('.')[0] === rootName)
      .map((b) => rootDomain(b.host).split('.').slice(1).join('.'))
  );

  for (const brand of BRANDS) {
    const brandRoot = rootDomain(brand.host);
    const brandName = brandRoot.split('.')[0];
    const brandTld = brandRoot.split('.').slice(1).join('.');

    // 完全等于官方主域 → 安全
    if (root === brandRoot) return { lookalike: false, brand: brand.name, official: true };

    // 1) 品牌名 + 额外字符（panbaidu、quarkpan、baidupan）
    const compact = host.replace(/[^a-z0-9]/g, '');
    const brandCompact = brandName.replace(/[^a-z0-9]/g, '');
    if (host.includes(brandName) || compact.includes(brandCompact)) {
      // 域名里出现了品牌名，但不是官方域 → 强仿冒信号
      if (brandName.length >= 4 && host.includes(brandName)) {
        return {
          lookalike: true,
          brand: brand.name,
          reason: `域名中包含「${brandName}」但并非官方域名（官方为 ${brandRoot}）`,
        };
      }
    }

    // 2) 编辑距离极小（pane-quark ↔ quark、quarkk）
    const d = levenshtein(root, brandRoot, 2);
    if (d > 0 && d <= 2 && brandName.length >= 4) {
      return {
        lookalike: true,
        brand: brand.name,
        reason: `与官方域名 ${brandRoot} 高度相似（编辑距离 ${d}）`,
      };
    }

    // 3) 品牌名相同但后缀不同（quark.xyz、baidu.top）
    //    例外：若该后缀也是同一品牌的官方后缀（123pan.com ↔ 123pan.cn），放行
    if (rootName === brandName && rootTld !== brandTld && !siblingTlds.has(rootTld)) {
      return {
        lookalike: true,
        brand: brand.name,
        reason: `使用了与官方相同的名称「${brandName}」但后缀为 .${rootTld}（官方为 .${brandTld}）`,
      };
    }
  }
  return { lookalike: false };
}

/**
 * 主入口：评估一个 URL 的风险。
 * @param {string} url
 * @returns {{level:'safe'|'low'|'medium'|'high'|'blocked', score:number,
 *            host:string, brand?:string, reasons:string[], warnings:string[]}}
 */
function assessUrl(url) {
  const reasons = [];   // 高风险理由
  const notes = [];     // 提醒（非风险）
  let score = 0;
  let host = '';

  if (!url) {
    return { level: 'blocked', score: 100, host: '', reasons: ['空链接'], notes: [] };
  }

  try {
    const p = new URL(url);
    host = p.hostname.toLowerCase();

    // 协议
    if (p.protocol === 'http:') {
      reasons.push('使用不加密的 HTTP 连接（内容可能被篡改）');
      score += 15;
    } else if (p.protocol !== 'https:') {
      reasons.push(`非常规协议：${p.protocol}`);
      score += 40;
    }

    // 裸 IP
    if (IPV4_RE.test(host)) {
      reasons.push('直接使用 IP 地址（正规网盘不会这样给链接）');
      score += 45;
    }

    // 非常规端口
    if (p.port && !['80', '443', ''].includes(p.port)) {
      reasons.push(`使用非常规端口 ${p.port}`);
      score += 25;
    }

    // punycode 同形字
    if (hasPunycode(host)) {
      reasons.push('域名含 Punycode 编码（可能是同形字仿冒）');
      score += 35;
    }

    // 可疑后缀
    const tld = host.split('.').pop();
    if (SUSPICIOUS_TLDS.has(tld)) {
      reasons.push(`.${tld} 是钓鱼/垃圾站高发后缀`);
      score += 30;
    }

    // 仿冒识别
    const lk = detectLookalike(host);
    if (lk.lookalike) {
      reasons.push(`疑似仿冒「${lk.brand}」：${lk.reason}`);
      // 仿冒本身即高风险信号：单独就足以把评分推到 high 档（>=70），
      // 不需要靠其他特征"凑分"。钓鱼站往往其它特征都很干净。
      score += 75;
    } else if (lk.official) {
      notes.push(`已验证为${lk.brand}官方域名`);
    }

    // 三级及以上子域 + 大厂顶级域组合
    const bigBrand = BIG_TLDS.find((b) => host === b || host.endsWith('.' + b));
    if (bigBrand && !lk.lookalike) {
      const sub = host.slice(0, host.length - bigBrand.length - 1);
      if (sub && sub.split('.').length >= 1 && sub.length > 24) {
        reasons.push('超长子域路径（常见于跳板/统计劫持）');
        score += 20;
      }
    }

    // 登录/验证类关键词（常见钓鱼）
    const full = url.toLowerCase();
    if (/(login|signin|verify|account|password|passwd|pay|auth)/.test(full) && !lk.official) {
      notes.push('链接含登录/验证类关键词，请确认页面确为官方后再输入任何账号信息');
      score += 10;
    }

    // 中文路径乱码 / 超长随机串
    if (/\/[a-z0-9]{28,}(\/|$|\?)/i.test(p.pathname)) {
      notes.push('链接含超长随机串，多为中转跳转');
      score += 5;
    }
  } catch {
    return { level: 'blocked', score: 100, host: '', reasons: ['链接无法解析'], notes: [] };
  }

  score = Math.min(100, score);
  let level;
  if (score >= 70) level = 'high';
  else if (score >= 40) level = 'medium';
  else if (score >= 15) level = 'low';
  else level = 'safe';

  return { level, score, host, brand: (detectLookalike(host).brand || ''), reasons, notes };
}

/**
 * 从文件名 / 标题里识别危险可执行载荷。
 * @returns {{risky:boolean, kind:'dangerous'|'archive'|'normal', ext:string,
 *            doubleExt:boolean, label:string, advice:string}}
 */
function assessFileKind(text) {
  const s = String(text || '');
  const m = s.match(/\.([a-z0-9]{1,6})(?=[\s"')\]，。;,、]|$)/gi);
  const exts = m ? m.map((x) => x.slice(1).toLowerCase()) : [];
  const last = exts.length ? exts[exts.length - 1] : '';
  const doubleExt = DOUBLE_EXT_RE.test(s);

  if (doubleExt) {
    const dm = s.match(DOUBLE_EXT_RE);
    return {
      risky: true,
      kind: 'dangerous',
      ext: dm ? dm[2].toLowerCase() : last,
      doubleExt: true,
      label: '伪装成普通文件的可执行程序',
      advice: '这是双扩展名伪装（前面看着像文档/视频，实际是可执行程序）。强烈建议不要运行，除非你能确认来源可信。',
    };
  }

  if (DANGEROUS_EXT.has(last)) {
    return {
      risky: true,
      kind: 'dangerous',
      ext: last,
      doubleExt: false,
      label: `可执行文件（.${last}）`,
      advice: '可执行文件可能携带病毒/木马。下载后请先用本机杀毒软件扫描，确认安全再运行。',
    };
  }

  if (ARCHIVE_EXT.has(last)) {
    return {
      risky: false,
      kind: 'archive',
      ext: last,
      doubleExt: false,
      label: `压缩包（.${last}）`,
      advice: '压缩包内可能夹带可执行文件，解压后请留意 .exe/.bat/.scr 等文件。',
    };
  }

  return { risky: false, kind: 'normal', ext: last, doubleExt: false, label: '', advice: '' };
}

/** 标题文本层面的风险词扫描 */
function assessTitle(text) {
  const s = String(text || '');
  const hits = DANGEROUS_WORDS.filter((w) => w.re.test(s));
  if (!hits.length) return { risky: false, hits: [], reason: '' };
  return {
    risky: true,
    hits: hits.map((h) => h.label),
    reason: hits.map((h) => h.label).join('、') + ' —— 这类资源常捆绑恶意程序',
    weight: Math.max(...hits.map((h) => h.weight)),
  };
}

/**
 * 综合评估一条搜索结果。给前端用的精简结构，避免泄露 raw_url。
 */
function assessItem(item) {
  const title = String((item && item.title) || '');
  const url = String((item && item.raw_url) || (item && item.first_url) || '');

  const urlRisk = url && /^https?:/i.test(url) ? assessUrl(url) : { level: 'safe', score: 0, reasons: [], notes: [], host: '' };
  const fileKind = assessFileKind(title);
  const titleRisk = assessTitle(title);

  let score = urlRisk.score || 0;
  // 可执行载荷是"用户真的要把它下到本机运行"的风险，
  // 权重必须够高，否则会出现"官方域名 + .exe"被打成 low 的荒谬结论
  // （实测出现过：pan.quark.cn 的 .exe 只得 30 分 → low）。
  if (fileKind.risky) score += fileKind.doubleExt ? 55 : 45;
  if (titleRisk.risky) score += Math.min(35, titleRisk.weight || 20);

  score = Math.min(100, score);
  let level;
  if (score >= 70) level = 'high';
  else if (score >= 40) level = 'medium';
  else if (score >= 15) level = 'low';
  else level = 'safe';

  const warnings = [];
  if (fileKind.label) warnings.push(`${fileKind.label}：${fileKind.advice}`);
  if (titleRisk.reason) warnings.push(titleRisk.reason);
  if (urlRisk.reasons && urlRisk.reasons.length) warnings.push(...urlRisk.reasons);

  return {
    level,
    score,
    safe: level === 'safe',
    host: urlRisk.host || '',
    urlReasons: urlRisk.reasons || [],
    notes: urlRisk.notes || [],
    fileKind: fileKind.kind,
    fileExt: fileKind.ext || '',
    fileWarnings: fileKind.label ? [fileKind.advice] : [],
    titleWarnings: titleRisk.risky ? [titleRisk.reason] : [],
    warnings,
  };
}

// ---------------------------------------------------------------------------
// 四、安全响应头（防挂马 / 防点击劫持 / 防 XSS 外带）
//
// 说明：CSP 里刻意允许 inline style —— 页面有大量 inline style 属性与
//       <style> 块（皮肤/主题变量）。script-src 只允许 'self' 和本站内联，
//       不允许任何外部脚本源，这是防挂马最关键的一条。
// ---------------------------------------------------------------------------
function securityHeaders(options = {}) {
  const {
    // 是否允许被 iframe 嵌入（默认不允许）
    allowFrame = false,
    // 是否允许 inline script（搜索页/磁力页有内联脚本）
    allowInlineScript = false,
  } = options;

  const csp = [
    "default-src 'self'",
    // 图片：本站 + 上游封面图 + data: URI（图标/占位）
    "img-src 'self' data: https: blob:",
    // 样式：本站 + inline（主题变量/交错动画 inline style）
    "style-src 'self' 'unsafe-inline'",
    // 脚本：只允许本站；磁力页/提示页需要内联
    allowInlineScript ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
    // 不允许任何插件/Flash 类被加载（防挂马入口）
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    allowFrame ? "frame-ancestors 'self'" : "frame-ancestors 'none'",
    // 禁止把本站嵌到别的站
    "frame-src 'none'",
    "worker-src 'self'",
    "manifest-src 'self'",
    'upgrade-insecure-requests',
  ].join('; ');

  return (req, res, next) => {
    res.setHeader('Content-Security-Policy', csp);
    // 禁止 MIME 嗅探（防把 .txt 当脚本执行）
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // 点击劫持
    res.setHeader('X-Frame-Options', allowFrame ? 'SAMEORIGIN' : 'DENY');
    // 不泄露来源页路径给下游站点
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    // 关掉不需要的浏览器能力（摄像头/麦克风/定位/支付/USB 等）
    res.setHeader(
      'Permissions-Policy',
      [
        'accelerometer=()', 'ambient-light-sensor=()', 'autoplay=()',
        'battery=()', 'camera=()', 'display-capture=()', 'document-domain=()',
        'encrypted-media=()', 'execution-while-not-rendered=()',
        'execution-while-out-of-viewport=()', 'fullscreen=(self)',
        'geolocation=()', 'gyroscope=()', 'magnetometer=()',
        'microphone=()', 'midi=()', 'payment=()', 'picture-in-picture=()',
        'publickey-credentials-get=()', 'screen-wake-lock=()',
        'sync-xhr=(self)', 'usb=()', 'xr-spatial-tracking=()',
      ].join(', ')
    );
    // 跨域策略：允许本站资源被本站引用，禁掉被外部站点嵌入资源
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    // 关掉旧浏览器的 XSS 过滤器（现代浏览器已移除，保留可能反而引入漏洞）
    res.setHeader('X-XSS-Protection', '0');
    next();
  };
}

// ---------------------------------------------------------------------------
// 四之二、服务端拼的 HTML 页（磁力页 / 风险页 / 提示页）专用 CSP
//
// 这些页面里有内联 <script>（复制按钮、1 秒自动跳转倒计时），所以全局
// 那条 script-src 'self' 会把自己的脚本也拦掉。这里给它们一套放宽版：
//   script-src 'self' 'unsafe-inline'
// **注意：依然不含任何外部源** —— 放宽的只是"允许本站内联脚本"，
// 外部脚本源（evil.com、cdn.xxx 之类）仍然一律拒绝，防挂马的核心没丢。
// ---------------------------------------------------------------------------
const INLINE_PAGE_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * 给服务端拼的 HTML 响应套上"允许内联脚本"的安全头。
 * 用法：在 res.status(...).type('html') 之后调用，再 .send()。
 */
function inlinePageHeaders(res) {
  res.setHeader('Content-Security-Policy', INLINE_PAGE_CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  return res;
}

/**
 * 一步发送服务端拼的 HTML 页：带状态码 + 专用 CSP。
 * 用它是为了不必在 11 个调用点各写一遍 inlinePageHeaders。
 */
function sendHtmlPage(res, status, html) {
  res.status(status).type('html');
  inlinePageHeaders(res);
  return res.send(html);
}

// ---------------------------------------------------------------------------
// 五、跳转前风险页（安全跳板）
//
// 直接把用户 302 到目标站 = 用户完全没有机会看清去哪儿。
// 改成：先渲染一个 1 秒的过渡页，把目标域名、风险等级、检查结果摊开，
// 用户点了「继续访问」才真跳。低风险才自动跳。
// ---------------------------------------------------------------------------

const RISK_STYLE = `:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
background:#fbfaf9;color:#18181b;padding:24px;-webkit-font-smoothing:antialiased}
.card{max-width:520px;width:100%}
.badge{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;font-weight:600;
padding:4px 10px;border-radius:9999px;letter-spacing:.01em;margin-bottom:14px}
.b-safe{background:rgba(22,163,74,.10);color:#15803d}
.b-low{background:rgba(37,99,235,.10);color:#1d4ed8}
.b-medium{background:rgba(217,119,6,.12);color:#b45309}
.b-high{background:rgba(220,38,38,.10);color:#b91c1c}
h1{font-size:18px;font-weight:600;margin:0 0 8px;letter-spacing:-.02em;line-height:1.35}
p{font-size:13.5px;line-height:1.65;color:#71717a;margin:0 0 14px}
.host{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;
background:rgba(0,0,0,.045);padding:10px 12px;border-radius:8px;word-break:break-all;
margin:0 0 14px;color:#3f3f46}
ul{margin:0 0 14px;padding-left:18px}
li{font-size:12.5px;line-height:1.6;color:#a16207;margin-bottom:5px}
li.warn{color:#b91c1c}
.note{font-size:12.5px;line-height:1.6;color:#0f766e;margin:0 0 14px}
.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.btn{display:inline-block;font-size:13.5px;color:#fff;background:#18181b;text-decoration:none;
padding:10px 22px;border-radius:9999px;border:none;cursor:pointer;font-family:inherit;
transition:opacity .15s ease}
.btn:hover{opacity:.85}
.btn.ghost{background:transparent;color:#18181b;border:1px solid rgba(0,0,0,.14)}
.btn.danger{background:#b91c1c}
.tip{font-size:11.5px;color:#a1a1aa;margin-top:16px;line-height:1.6}
@media (prefers-color-scheme:dark){
body{background:#121212;color:#f4f4f5}
p{color:#a1a1aa}
.host{background:rgba(255,255,255,.07);color:#d4d4d8}
li{color:#fbbf24}
li.warn{color:#f87171}
.note{color:#5eead4}
.btn{background:#f4f4f5;color:#18181b}
.btn.ghost{background:transparent;color:#f4f4f5;border-color:rgba(255,255,255,.16)}
.b-safe{background:rgba(34,197,94,.15);color:#4ade80}
.b-low{background:rgba(59,130,246,.15);color:#60a5fa}
.b-medium{background:rgba(245,158,11,.15);color:#fbbf24}
.b-high{background:rgba(239,68,68,.15);color:#f87171}
.tip{color:#71717a}
}`;

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

const LEVEL_META = {
  safe: { cls: 'b-safe', text: '未发现明显风险', auto: true },
  low: { cls: 'b-low', text: '低风险', auto: true },
  medium: { cls: 'b-medium', text: '中等风险 · 请留意', auto: false },
  high: { cls: 'b-high', text: '高风险 · 建议不要继续', auto: false },
};

/**
 * 渲染跳转前的安全提示页。
 * @param {object} opts
 * @param {string} opts.target      真实目标 URL（会展示域名，但不直接出现在 href 里由服务端再跳一次）
 * @param {string} opts.goHash      /go/<hash>（确认后由服务端完成 302，避免前端拿到真实地址）
 * @param {string} opts.title       资源标题
 * @param {object} opts.risk        assessUrl / assessItem 的结果
 * @param {string} opts.magnet      磁力链接（有则不跳转，交给下载工具）
 * @param {string} opts.cloud       网盘类型名
 */
function renderRiskPage(opts) {
  const {
    target = '', goHash = '', title = '', risk = {}, magnet = '', cloud = '',
  } = opts;

  const meta = LEVEL_META[risk.level] || LEVEL_META.low;
  const autoJump = meta.auto && !risk.reasons?.length;
  let host = '';
  try { host = new URL(target).hostname; } catch { host = target; }

  const reasonsHtml = (risk.reasons && risk.reasons.length)
    ? `<ul>${risk.reasons.map((r) => `<li class="warn">${esc(r)}</li>`).join('')}</ul>`
    : '';
  const notesHtml = (risk.notes && risk.notes.length)
    ? `<ul>${risk.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`
    : '';

  const fileKind = assessFileKind(title);
  const fileHtml = fileKind.label
    ? `<p><strong>${esc(fileKind.label)}</strong><br>${esc(fileKind.advice)}</p>`
    : '';

  const titleRisk = assessTitle(title);
  const titleHtml = titleRisk.risky ? `<p>${esc(titleRisk.reason)}</p>` : '';

  // 目标地址不直接写进 href：点「继续访问」走服务端 /go/<hash>?confirm=1 完成 302，
  // 这样真实链接始终不出现在发送给浏览器的 HTML 里。
  const goHref = goHash ? `${goHash}${goHash.includes('?') ? '&' : '?'}confirm=1` : target;

  const magnetBlock = magnet
    ? `<p>这是磁力 / 电驴链接，需要由本地下载工具接管。</p>
       <div class="actions">
         <a class="btn" href="${esc(magnet)}" rel="noopener noreferrer">唤起下载工具</a>
         <button class="btn ghost" id="copy">复制链接</button>
       </div>
       <p class="tip">若没有反应，请手动复制链接到 qBittorrent / 迅雷 / 比特彗星等。</p>`
    : `<div class="actions">
         <a class="btn${risk.level === 'high' ? ' danger' : ''}" href="${esc(goHref)}" rel="noopener noreferrer">${risk.level === 'high' ? '我已确认，仍然继续' : '继续访问'}</a>
         <a class="btn ghost" href="/search">返回搜索</a>
       </div>
       ${autoJump ? `<p class="tip">未发现明显风险，1 秒后将自动跳转。</p>
       <script>setTimeout(function(){location.href=${JSON.stringify(goHref)}},1000)</script>`
                  : '<p class="tip">已暂停自动跳转。请确认上方信息无误后手动继续。</p>'}`;

  const titleShow = title ? `<h1>${esc(String(title).slice(0, 90))}</h1>` : `<h1>即将离开本站</h1>`;

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>安全提示 · ${esc(host || '跳转确认')}</title>
<style>${RISK_STYLE}</style></head><body><div class="card">
<span class="badge ${meta.cls}">${esc(meta.text)}${risk.score ? ` · 风险分 ${risk.score}` : ''}</span>
${titleShow}
<p>即将前往以下网盘地址${cloud ? `（${esc(cloud)}）` : ''}：</p>
<div class="host">${esc(host)}</div>
${reasonsHtml}${titleHtml}${fileHtml}${notesHtml}
${magnetBlock}
<p class="tip">本站仅做资源索引，不存储任何文件，不对第三方内容的安全性负责。<br>
    下载后可执行文件请先杀毒；遇到要求输入账号密码、支付、安装插件的页面请立即关闭。</p>
</div>${magnet ? `<script>
var full=${JSON.stringify(magnet)};
document.getElementById('copy').addEventListener('click',function(){
  var b=this;navigator.clipboard.writeText(full).then(function(){
    b.textContent='已复制';setTimeout(function(){b.textContent='复制链接';},1500);});
});
</script>` : ''}</body></html>`;
}

/**
 * 强制拦截页（高风险）：不给"继续"按钮，只给返回。
 */
function renderBlockedPage(host, reasons, title) {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>已拦截 · 安全防护</title>
<style>${RISK_STYLE}</style></head><body><div class="card">
<span class="badge b-high">已拦截 · 高风险链接</span>
<h1>${title ? esc(String(title).slice(0, 90)) : '该链接已被安全防护拦截'}</h1>
<p>目标站点 <strong>${esc(host || '未知')}</strong> 触发了安全规则，为避免风险，本站已阻止跳转。</p>
${reasons && reasons.length ? `<ul>${reasons.map((r) => `<li class="warn">${esc(r)}</li>`).join('')}</ul>` : ''}
<div class="actions">
  <a class="btn ghost" href="/search">返回搜索</a>
  <a class="btn ghost" href="/disclaimer">查看免责声明</a>
</div>
<p class="tip">如果你确信该地址安全，可手动复制域名到浏览器地址栏访问。本站不对第三方站点负责。</p>
</div></body></html>`;
}

module.exports = {
  assessUrl,
  assessItem,
  assessFileKind,
  assessTitle,
  securityHeaders,
  inlinePageHeaders,
  sendHtmlPage,
  INLINE_PAGE_CSP,
  renderRiskPage,
  renderBlockedPage,
  detectLookalike,
  rootDomain,
  BRANDS,
  DANGEROUS_EXT,
  SUSPICIOUS_TLDS,
};
