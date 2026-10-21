'use strict';

/**
 * 数据源：珈珈搜索 j-so
 *   站点：https://j-so.com
 *
 * 机制特点（与 zreso / PanSou 都不同）：
 *   - 没有 JSON API，是**服务端渲染的 HTML 页面**
 *   - 路径形式：/s/<urlencode(关键词)>
 *   - 默认返回的是骨架屏（给浏览器首屏用），需要带 `?__full=1`
 *     **并且**请求头 `X-Search-Full: 1`，才会吐完整结果 HTML
 *   - 真实直链直接写在 `data-real-link="https://pan.quark.cn/s/xxx"` 属性里
 *     → 也不需要二次解析
 *   - 带一个链接检测接口 /api/check_cloud.php?url=&t=<unix秒>，用于标「有效/失效」
 *
 * 容错策略：HTML 结构是最脆的，任何一步解析不出内容都直接返回 []，
 * 绝不能因为正则没匹配上就把整个聚合请求搞挂。
 */

const { requestText, stripTags } = require('./_http');
const cloudmap = require('./_cloudmap');
const { TtlCache } = require('../cache');

const BASE = process.env.JSO_BASE || 'https://j-so.com';
const TIMEOUT_MS = Number(process.env.JSO_TIMEOUT_MS) || 9000;
const CHECK_TIMEOUT_MS = 5000;

// 页面是 SSR 的，同一关键词结果短时间内不会变，缓存能显著降负载
const CACHE_TTL_MS = Number(process.env.JSO_CACHE_TTL_MS) || 5 * 60 * 1000;
const cache = new TtlCache({ ttlMs: CACHE_TTL_MS, max: 200 });

const stats = { ok: 0, fail: 0, items: 0, parsedEmpty: 0, cacheHit: 0, lastError: null };
let lastError = null;

// ---------------------------------------------------------------------------
// 结果块解析
// ---------------------------------------------------------------------------
const ARTICLE_RE = /<article\b[^>]*class="[^"]*\bresult-item\b[^"]*"[^>]*>([\s\S]*?)<\/article>/gi;
const REAL_LINK_RE = /data-real-link="([^"]+)"/i;
const TITLE_RE = /<h2\b[^>]*class="[^"]*\bresult-title\b[^"]*"[^>]*>([\s\S]*?)<\/h2>/i;
const ICON_RE = /<img\b[^>]*class="[^"]*\bpan-result-icon\b[^"]*"[^>]*>/i;
const ICON_SRC_RE = /src="([^"]+)"/i;
const ICON_ALT_RE = /alt="([^"]*)"/i;
const DATE_RE = /class="[^"]*\bmeta-item\b[^"]*"[^>]*>[\s\S]*?<\/svg>\s*([^<]*)</i;
// <span class="result-status checking"><span class="dot"></span>等待检测</span>
const STATUS_RE = /class="[^"]*\bresult-status\b[^"]*"[^>]*>[\s\S]*?<\/span>\s*([^<]*)<\//i;

function parseItems(html) {
  const out = [];
  if (!html || typeof html !== 'string') return out;

  // 有些返回会把结果块里的标签写成单引号，统一一下再匹配
  const norm = html.replace(/class='/g, 'class="').replace(/'/g, '"');

  let m;
  ARTICLE_RE.lastIndex = 0;
  while ((m = ARTICLE_RE.exec(norm)) !== null) {
    const block = m[1];

    const linkM = block.match(REAL_LINK_RE);
    const raw = linkM ? linkM[1].trim() : '';
    if (!raw || !/^https?:\/\//i.test(raw)) continue;

    const titleM = block.match(TITLE_RE);
    const title = titleM ? stripTags(titleM[1]) : '';

    let iconName = null;
    let iconAlt = '';
    const iconM = block.match(ICON_RE);
    if (iconM) {
      const srcM = iconM[0].match(ICON_SRC_RE);
      const altM = iconM[0].match(ICON_ALT_RE);
      if (srcM) iconName = srcM[1];
      if (altM) iconAlt = altM[1];
    }

    const key = cloudmap.normalize(iconAlt || iconName, raw);

    const dateM = block.match(DATE_RE);
    const date = dateM ? String(dateM[1]).trim() : '';

    const statusM = block.match(STATUS_RE);
    const statusText = statusM ? String(statusM[1]).trim() : '';

    out.push({
      title: title || cloudmap.displayName(key) + '资源',
      date,
      datetime: '',
      tags: null,
      cloud_type: key,
      cloud_type_name: cloudmap.displayName(key),
      icon: cloudmap.iconName(key) || null,
      // j-so 页面自带"等待检测"占位，映射成前端认识的 kind
      status: statusToKind(statusText),
      status_text: statusText || '',
      origin: '',
      raw_url: raw,
      first_url: raw,
      provider: 'jso',
      _fallback: false,
    });
  }
  return out;
}

/** j-so 的中文状态文案 -> 前端 badge kind */
function statusToKind(text) {
  const t = String(text || '');
  if (t.includes('有效') || t.includes('正常')) return 'valid';
  if (t.includes('失效') || t.includes('违规') || t.includes('不存在')) return 'invalid';
  if (t.includes('检测中') || t.includes('等待')) return ''; // 未知，不显示 badge
  return '';
}

// ---------------------------------------------------------------------------
// 主查询
// ---------------------------------------------------------------------------
/**
 * @param {string} query
 * @returns {Promise<Array>} 统一结构数组；失败返回 []
 */
async function search(query) {
  const kw = String(query || '').trim();
  if (!kw) return [];

  const hit = cache.get(kw);
  if (hit) {
    stats.cacheHit++;
    return hit;
  }

  const url = `${BASE}/s/${encodeURIComponent(kw)}?__full=1`;

  try {
    const html = await requestText(url, {
      timeoutMs: TIMEOUT_MS,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'X-Search-Full': '1', // 关键：不带这个头只会拿到骨架屏
        Referer: BASE + '/',
      },
    });

    const items = parseItems(html);
    if (!items.length) {
      // 可能是被风控 / 结构变了 / 真的没结果，都当软失败，不影响其他源
      stats.parsedEmpty++;
      console.warn('[jso] 未解析到结果（长度 %d）', html.length);
      return [];
    }

    stats.ok++;
    stats.items += items.length;
    cache.set(kw, items);
    return items;
  } catch (err) {
    stats.fail++;
    lastError = err.message;
    stats.lastError = err.message;
    console.warn('[jso] fail:', err.message);
    return [];
  }
}

/**
 * 单链接有效性检测（复用 j-so 的 check_cloud.php）。
 * 注意 t 是 unix 秒；缺参会返回「请求已过期」。
 * 该接口是逐条外部请求，只在用户显式点击"检测"时按需调用，绝不批量预取。
 * @returns {Promise<{status:'valid'|'invalid'|'unknown', message:string}>}
 */
async function checkLink(link) {
  const u = String(link || '').trim();
  if (!/^https?:\/\//i.test(u)) return { status: 'unknown', message: '链接格式不支持' };

  const t = Math.floor(Date.now() / 1000);
  const url = `${BASE}/api/check_cloud.php?url=${encodeURIComponent(u)}&t=${t}`;
  try {
    const text = await requestText(url, {
      timeoutMs: CHECK_TIMEOUT_MS,
      headers: { Accept: 'application/json, text/plain, */*', Referer: BASE + '/' },
    });
    const payload = JSON.parse(text);
    const ok = String(payload.status || '').toLowerCase() === 'success';
    return { status: ok ? 'valid' : 'invalid', message: String(payload.message || '') };
  } catch (err) {
    lastError = err.message;
    return { status: 'unknown', message: err.message };
  }
}

function getStats() {
  return { ...stats, base: BASE, cacheSize: cache.size, lastError };
}

module.exports = { search, checkLink, getStats, id: 'jso', label: '珈珈搜索' };
