'use strict';

/**
 * 链接解析层。
 *
 * 上游搜索接口给的是中转链接 /api/wash?t=<uuid>，
 * 请求该接口会返回 JSON，里面 raw_url 才是真实的网盘分享链接。
 * 本模块负责把中转链接展开成真实链接，并做 TTL 缓存。
 *
 * 注意：这只是「把上游已经公开返回的数据转发一次」，不涉及任何绕过。
 * 若上游失效 / 触发人机验证，会退化为直接跳转中转链接。
 */

const config = require('../config');
const { TtlCache } = require('./cache');

// 真实链接很少变，缓存久一点
const resolveCache = new TtlCache({ ttlMs: 6 * 60 * 60 * 1000, max: 500 });

const stats = { resolved: 0, resolveFail: 0, cacheHit: 0 };

/** 上游中转链接的形状校验，避免被当成任意 URL 代理（SSRF） */
const WASH_RE = /^\/api\/wash\?t=[0-9a-fA-F-]{8,64}$/;

function isUpstreamWashPath(p) {
  return typeof p === 'string' && WASH_RE.test(p);
}

/**
 * 把上游中转路径展开为真实网盘链接。
 * @param {string} washPath 形如 /api/wash?t=xxxx
 * @param {string} base 上游根地址
 * @returns {Promise<string>} 真实链接；失败时返回空串
 */
async function resolveWash(washPath, base) {
  if (!isUpstreamWashPath(washPath)) return '';
  if (!base) return '';

  const cacheKey = base + washPath;
  const hit = resolveCache.get(cacheKey);
  if (hit) {
    stats.cacheHit++;
    return hit;
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.upstream.timeoutMs);
  try {
    const res = await fetch(new URL(washPath, base).toString(), {
      method: 'GET',
      headers: {
        ...config.upstream.headers,
        Accept: 'application/json, text/plain, */*',
      },
      signal: ac.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`wash ${res.status}`);
    const text = await res.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error('wash non-JSON');
    }
    const raw = payload && typeof payload.raw_url === 'string' ? payload.raw_url : '';
    if (!/^https?:\/\//i.test(raw)) throw new Error('no raw_url');
    resolveCache.set(cacheKey, raw);
    stats.resolved++;
    console.log('[resolver] ok', washPath.slice(0, 28), '->', raw);
    return raw;
  } catch (err) {
    stats.resolveFail++;
    stats.lastError = `${err.message} (${washPath.slice(0, 24)})`;
    console.warn('[resolver] fail', washPath.slice(0, 28), err.message);
    return '';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 判断一个链接是否属于可信的网盘域名白名单。
 * 只对白名单域名做 302 跳转，防止变成开放重定向。
 *
 * ── 收录原则（安全边界，改动前请先读）────────────────────────────
 * 匹配规则是 `host === h || host.endsWith('.' + h)`，也就是「本身或任意子域」。
 * 因此**只收录本身就承载分享内容的「叶子域名」**；
 * 不要收录 baidu.com / uc.cn / xunlei.com / 189.cn / 115.com / 139.com 这类
 * 「大厂顶级域」——它们下面挂着搜索、贴吧、邮箱、广告等海量与网盘无关的子域，
 * 一旦上游数据被污染（或上游本身被投毒），就能把用户 302 到任意页面，
 * 等于把开放重定向的口子开在自家门口。
 * 若将来确有某个子域需要放行，请精确写那个子域，不要退回顶级域。
 */
const ALLOWED_HOSTS = [
  // 夸克
  'pan.quark.cn',
  'quark.cn',
  // 百度网盘
  'pan.baidu.com',
  'yun.baidu.com',
  'eyun.baidu.com',
  // UC 网盘
  'drive.uc.cn',
  'fast.uc.cn',
  'share.uc.cn',
  // 迅雷网盘
  'pan.xunlei.com',
  'share.xunlei.com',
  // 天翼云盘
  'cloud.189.cn',
  'h5.cloud.189.cn',
  // 阿里云盘
  'www.aliyundrive.com',
  'aliyundrive.com',
  'www.alipan.com',
  'alipan.com',
  // 115
  '115.com',
  '115cdn.com',
  'anxia.com',
  // 123 网盘（含各 CDN 子域，用后缀匹配覆盖）
  '123pan.com',
  '123pan.cn',
  '123684.com',
  '123865.com',
  '123912.com',
  '123957.com',
  // 移动云盘
  'caiyun.139.com',
  'yun.139.com',
  // PikPak
  'mypikpak.com',
  'toapp.mypikpak.com',
  'pikpak.com',
  // 光雅盘
  'guangyapan.com',
  'www.guangyapan.com',
  // 其他常见
  'drive.google.com',
  'mega.nz',
  'onedrive.live.com',
  '1drv.ms',
  'dropbox.com',
  'mediafire.com',
];

function isAllowedUrl(u) {
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const host = parsed.hostname.toLowerCase();
    return ALLOWED_HOSTS.some((h) => host === h || host.endsWith('.' + h));
  } catch {
    return false;
  }
}

/**
 * 磁力 / 电驴链接不是 http，不能走 302（浏览器不会接管）。
 * 这类链接单独放行，由 /go 渲染一个可点击的跳转页交给本地下载工具。
 */
function isMagnetLike(u) {
  return /^(magnet:\?|ed2k:\/\/)/i.test(String(u || '').trim());
}

function getStats() {
  return { ...stats, cacheSize: resolveCache.size };
}

module.exports = {
  resolveWash,
  isAllowedUrl,
  isMagnetLike,
  isUpstreamWashPath,
  getStats,
  ALLOWED_HOSTS,
};
