'use strict';

/**
 * 数据源：PanSou（盘搜，开源项目）
 *   站点：https://so.252035.xyz
 *
 * 机制特点（与 zreso 完全不同）：
 *   - 入参用的是 `kw`，不是 `q`
 *   - 返回的是**真实网盘直链**，不是中转链接 → 不需要二次解析
 *   - 结果按网盘类型分组在 data.merged_by_type 下
 *   - 每条带 source（如 tg:xxx / plugin:xxx，说明聚合自哪个 TG 频道或插件）、
 *     note（资源描述）、datetime（发布时间）、password（部分带提取码）
 *   - 背后聚合了上百个 Telegram 频道 + 数十个插件源
 *
 * 支持 POST JSON（注意：GET 会 400，必须 POST）。
 */

const { requestJson } = require('./_http');
const cloudmap = require('./_cloudmap');
const { TtlCache } = require('../cache');

const BASE = process.env.PANSOU_BASE || 'https://so.252035.xyz';
const SEARCH_PATH = '/api/search';
const TIMEOUT_MS = Number(process.env.PANSOU_TIMEOUT_MS) || 20000;

// PanSou 对高频请求会直接 400（看起来是按 IP 的短时限流）。
// 加一层本地缓存 + 退避，避免把上游惹毛。
const CACHE_TTL_MS = Number(process.env.PANSOU_CACHE_TTL_MS) || 5 * 60 * 1000;
const cache = new TtlCache({ ttlMs: CACHE_TTL_MS, max: 200 });

// 连续 400 后退避：退避窗口内直接返回缓存/空，不再打上游
const backoff = { until: 0, level: 0 };
const BACKOFF_STEP_MS = 30 * 1000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;

const stats = { ok: 0, fail: 0, items: 0, cacheHit: 0, backoffSkip: 0, inflightJoin: 0, lastError: null };
let lastError = null;

function keyOf(kw, cloud) {
  return `${kw}||${cloud}`;
}

// 同一 key 的在途请求复用表。
// 为什么需要：两阶段搜索会让"阶段 1（6 秒上限）"和"阶段 2（全量）"几乎同时
// 发起同一个关键词的查询。没有这层去重，上游会被打两次 —— PanSou 是按 IP
// 限流的，重复打直接换回 400，两边都拿不到结果。
// 有了它，阶段 2 会直接 await 阶段 1 那个还在跑的请求，上游只被调用一次。
const inflight = new Map();

/**
 * 查询 PanSou。
 * @param {string} query
 * @param {object} opts { cloud }  仅用于把结果窗口收敛到该类型，减少传输量
 * @returns {Promise<Array>} 统一结构的结果数组；失败时返回 []
 */
async function search(query, { cloud = 'all' } = {}) {
  const kw = String(query || '').trim();
  if (!kw) return [];

  const ck = keyOf(kw, cloud);
  const hit = cache.get(ck);
  if (hit) {
    stats.cacheHit++;
    return hit;
  }

  // 退避窗口内：不打上游，返回空（让别的源顶上）
  if (Date.now() < backoff.until) {
    stats.backoffSkip++;
    return [];
  }

  const running = inflight.get(ck);
  if (running) {
    stats.inflightJoin++;
    return running;
  }

  const p = fetchUpstream(ck, kw, cloud);
  inflight.set(ck, p);
  try {
    return await p;
  } finally {
    inflight.delete(ck);
  }
}

async function fetchUpstream(ck, kw, cloud) {
  const body = { kw, res: 'merge' };
  if (cloud && cloud !== 'all') body.cloud_types = [cloud];

  try {
    const payload = await requestJson(new URL(SEARCH_PATH, BASE).toString(), {
      method: 'POST',
      timeoutMs: TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/plain, */*',
        Referer: BASE + '/',
      },
      body: JSON.stringify(body),
    });

    if (!payload || payload.code !== 0) {
      throw new Error(payload && payload.message ? payload.message : 'bad payload');
    }

    // 成功 → 清退避
    backoff.level = 0;
    backoff.until = 0;

    const grouped = (payload.data && payload.data.merged_by_type) || {};
    const out = [];
    for (const [typeKey, arr] of Object.entries(grouped)) {
      if (!Array.isArray(arr)) continue;
      for (const it of arr) {
        const url = String(it.url || '').trim();
        // 支持 http 链接 + 磁力/电驴（PanSou 的类型键可能是 magnet/ed2k）
        if (!/^https?:\/\//i.test(url) && !/^(magnet:|ed2k:)/i.test(url)) continue;
        const key = cloudmap.normalize(typeKey, url);
        out.push({
          title: cleanTitle(it.note) || (cloudmap.displayName(key) + '资源'),
          date: fmtDate(it.datetime),
          datetime: it.datetime || '',
          note: String(it.note || '').trim(),
          tags: null,
          cloud_type: key,
          cloud_type_name: cloudmap.displayName(key),
          icon: cloudmap.iconName(key) || null,
          status: 'valid', // PanSou 返回的就是可直接打开的直链
          password: String(it.password || '').trim(),
          origin: String(it.source || '').trim(),
          images: Array.isArray(it.images) ? it.images.slice(0, 3) : null,
          raw_url: url, // 真实直链
          first_url: url,
          provider: 'pansou',
          _fallback: false,
        });
      }
    }

    stats.ok++;
    stats.items += out.length;
    cache.set(ck, out);
    return out;
  } catch (err) {
    stats.fail++;
    lastError = err.message;
    stats.lastError = err.message;

    // 400/429 视为被限流 → 指数退避，别再火上浇油
    if (err.status === 400 || err.status === 429) {
      backoff.level = Math.min(backoff.level + 1, 5);
      backoff.until = Date.now() + Math.min(BACKOFF_STEP_MS * backoff.level, BACKOFF_MAX_MS);
      console.warn(
        `[pansou] 被限流(${err.status})，退避 ${Math.round((backoff.until - Date.now()) / 1000)}s`
      );
    } else {
      console.warn('[pansou] fail:', err.message);
    }
    return [];
  }
}

/** note 里常带表情/换行，清一下 */
function cleanTitle(s) {
  return String(s || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 160);
}

/** ISO 时间 -> YYYY-MM-DD */
function fmtDate(s) {
  if (!s) return '';
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

function getStats() {
  return {
    ...stats,
    base: BASE,
    cacheSize: cache.size,
    backoffUntil: backoff.until || null,
    backoffLevel: backoff.level,
    lastError,
  };
}

module.exports = { search, getStats, id: 'pansou', label: '盘搜聚合' };
