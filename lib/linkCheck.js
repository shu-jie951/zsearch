'use strict';

/**
 * 分享链接有效性探测。
 *
 * 为什么不用上游的检测接口
 *   原先 /api/link/check 走的是 j-so 的 /api/check_cloud.php。那个站已经变成
 *   博彩 SPA 外壳（2026-10 实测），接口返回的不是 JSON，解析必抛异常，于是
 *   每一条都落到 unknown —— 界面上"批量探活"点完一片灰，等于没做。
 *
 * 实测可行的只有两条路（2026-10 逐条验证过）
 *   夸克 / UC —— 两者同一套网盘后端，有一个「取分享 token」的开放接口：
 *       POST https://drive-pc.quark.cn/1/clouddrive/share/sharepage/token
 *       body {"pwd_id":"<分享id>","passcode":""}
 *     有效：HTTP 200 + code 0（并回 stoken）
 *     失效：HTTP 404 + code 41006「分享不存在」
 *     要提取码：code 41010 —— 分享还在，属于有效
 *   这条接口不需要登录态，判定干净，所以夸克能做到"真判断"。
 *
 *   百度 —— pan.baidu.com/api/shorturlinfo 在无 cookie 时一律回 errno 140
 *     （风控/需登录），三条不同的真实链接全是 140，说明它不区分链接死活。
 *   迅雷 —— 分享页是 296KB 的纯前端 SPA，正文里没有任何"已失效"文案可抓。
 *
 * 所以百度 / 迅雷 / 其他未知网盘一律如实返回 unknown，而不是猜。
 * 「不知道」比「猜错」有用：猜成失效会让用户错过好资源。
 */

const https = require('https');
const { URL } = require('url');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const TIMEOUT_MS = Number(process.env.CHECK_TIMEOUT_MS) || 8000;

// 明确表示"分享不在了"的业务码。其他码一律 unknown —— 宁可不说，也不误杀
const INVALID_CODES = new Set([41004, 41006, 41008, 41009, 41011, 41012, 41013]);
// 需要提取码：分享本身存在
const NEED_PASSCODE_CODES = new Set([41010]);

/* --------------------------------------------------------------------------
   识别链接归属
   -------------------------------------------------------------------------- */

const PATTERNS = [
  { kind: 'quark', re: /^https?:\/\/(?:pan|drive)\.quark\.cn\/s\/([0-9a-z_-]+)/i },
  { kind: 'uc', re: /^https?:\/\/(?:drive|fastdl|share)\.uc\.cn\/s\/([0-9a-z_-]+)/i },
  { kind: 'baidu', re: /^https?:\/\/pan\.baidu\.com\/s\/([0-9a-z_-]+)/i },
  { kind: 'xunlei', re: /^https?:\/\/pan\.xunlei\.com\/s\/([0-9a-z_-]+)/i },
];

/**
 * @param {string} raw
 * @returns {{kind:string, id:string, passcode:string}}
 */
function classify(raw) {
  const s = String(raw || '').trim();
  if (!s) return { kind: 'other', id: '', passcode: '' };

  let passcode = '';
  try {
    const u = new URL(s);
    passcode = u.searchParams.get('pwd') || u.searchParams.get('passcode') || '';
  } catch {
    /* 不是合法 URL，走 other */
  }

  for (const p of PATTERNS) {
    const m = s.match(p.re);
    if (m) return { kind: p.kind, id: m[1], passcode };
  }

  if (/^(magnet:|ed2k:)/i.test(s)) return { kind: 'magnet', id: '', passcode: '' };
  return { kind: 'other', id: '', passcode: '' };
}

/* --------------------------------------------------------------------------
   最小 HTTP 客户端（不引依赖，只发一次 POST 拿 JSON）
   -------------------------------------------------------------------------- */

function postJSON(urlStr, body, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch {
      resolve({ ok: false, error: 'bad-url' });
      return;
    }

    const payload = JSON.stringify(body);
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };

    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Accept: 'application/json, text/plain, */*',
          'User-Agent': UA,
          Referer: 'https://pan.quark.cn/',
          Origin: 'https://pan.quark.cn',
        },
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          // 防御：上游异常时可能吐巨大响应，超过 64KB 直接截断丢弃
          if (buf.length < 65536) buf += c;
        });
        res.on('end', () => finish({ ok: true, status: res.statusCode, body: buf }));
      }
    );

    req.on('timeout', () => {
      req.destroy();
      finish({ ok: false, error: 'timeout' });
    });
    req.on('error', (err) => finish({ ok: false, error: err.message }));
    req.write(payload);
    req.end();
  });
}

/* --------------------------------------------------------------------------
   夸克 / UC —— 同一个后端，只是域名和 pr 参数不同
   -------------------------------------------------------------------------- */

const TOKEN_API = {
  quark: 'https://drive-pc.quark.cn/1/clouddrive/share/sharepage/token?pr=ucpro&fr=pc',
  uc: 'https://pc-api.uc.cn/1/clouddrive/share/sharepage/token?pr=UCBrowser&fr=pc',
};

async function checkCloudDrive(kind, id, passcode) {
  const base = TOKEN_API[kind];
  const url = base + '&__dt=' + Date.now() + '&__t=' + Date.now();

  const r = await postJSON(url, { pwd_id: id, passcode: passcode || '' }, TIMEOUT_MS);
  if (!r.ok) return { status: 'unknown', message: '检测请求失败：' + r.error };

  let json;
  try {
    json = JSON.parse(r.body);
  } catch {
    return { status: 'unknown', message: '检测接口返回了非 JSON（可能被风控）' };
  }

  const code = Number(json && json.code);
  if (code === 0) return { status: 'valid', message: '分享有效' };
  if (NEED_PASSCODE_CODES.has(code)) {
    return { status: 'valid', message: '分享有效（需要提取码）' };
  }
  if (INVALID_CODES.has(code)) {
    return { status: 'invalid', message: String(json.message || '分享已失效') };
  }

  // 其余一律不敢下结论
  return {
    status: 'unknown',
    message: code ? 'code ' + code + ' ' + (json.message || '') : '未识别的响应',
  };
}

/* --------------------------------------------------------------------------
   对外
   -------------------------------------------------------------------------- */

/**
 * 探测单条链接。**永远 resolve**，绝不抛异常 —— 探活失败不该让整批请求挂掉。
 * @param {string} url
 * @returns {Promise<{status:'valid'|'invalid'|'unknown', message:string, kind:string}>}
 */
async function check(url) {
  const { kind, id, passcode } = classify(url);

  if (kind === 'quark' || kind === 'uc') {
    if (!id) return { status: 'unknown', message: '识别不出分享 ID', kind };
    try {
      const r = await checkCloudDrive(kind, id, passcode);
      return { ...r, kind };
    } catch (err) {
      return { status: 'unknown', message: err.message, kind };
    }
  }

  if (kind === 'baidu') {
    return { status: 'unknown', message: '百度需要登录态才能查分享状态，本站不代登录', kind };
  }
  if (kind === 'xunlei') {
    return { status: 'unknown', message: '迅雷分享页由前端渲染，无法从服务端判定', kind };
  }
  if (kind === 'magnet') {
    return { status: 'unknown', message: '磁力链接没有"失效"概念，取决于做种', kind };
  }

  return { status: 'unknown', message: '该网盘暂不支持有效性检测', kind };
}

module.exports = { check, classify, TIMEOUT_MS };
