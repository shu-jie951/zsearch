'use strict';

/**
 * 数据源：混沌搜（hunhepan）
 *   站点：https://hunhepan.com
 *
 * 机制特点：
 *   - 开放 JSON 接口：POST /open/search/disk
 *   - 请求体只吃 {q, page, size} 三个字段（多传任何字段直接「参数错误」）
 *   - 每页**固定返回 10 条**（size 无效），所以并发翻 3 页凑 30 条
 *   - code=417 表示「没有搜索结果」——按空结果处理，不是错误
 *   - 返回真实直链（link 字段），无需二次解析
 *   - disk_name / files 里关键词被 <em> 包裹（高亮），入库前剥掉
 *   - 附带 tags（资源标签）与 files（文件清单），字段质量很高
 *   - 必须带 Referer / Origin，否则被拦
 *
 * disk_type 映射在 _cloudmap.js 里统一处理（QUARK→quark、BDY→baidu 等）。
 */

const { requestJson, stripTags } = require('./_http');
const cloudmap = require('./_cloudmap');
const { TtlCache } = require('../cache');

const BASE = process.env.HUNHEPAN_BASE || 'https://hunhepan.com';
const SEARCH_PATH = '/open/search/disk';
const TIMEOUT_MS = Number(process.env.HUNHEPAN_TIMEOUT_MS) || 8000;

// 每页固定 10 条，翻几页凑量（3 页 = 30 条，已够聚合用）
const PAGES = Math.max(1, Math.min(5, Number(process.env.HUNHEPAN_PAGES) || 3));

const CACHE_TTL_MS = Number(process.env.HUNHEPAN_CACHE_TTL_MS) || 5 * 60 * 1000;
const cache = new TtlCache({ ttlMs: CACHE_TTL_MS, max: 200 });

// 400/429 限流指数退避（与 pansou 同一套策略）
const backoff = { until: 0, level: 0 };
const BACKOFF_STEP_MS = 30 * 1000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;

const stats = { ok: 0, fail: 0, items: 0, cacheHit: 0, backoffSkip: 0, lastError: null };
let lastError = null;

/** 拉单页，失败返回 {items:[], full:false}（软失败，不影响其他页与其他源）
 *  full = 原始返回是否满 10 条（判断还有没有下一页的依据，不能用过滤后条数，
 *         否则第一页恰好被过滤掉 1 条就会误判"没有下一页"而少拉 2 页）。 */
async function fetchPage(kw, page) {
  const payload = await requestJson(BASE + SEARCH_PATH, {
    method: 'POST',
    timeoutMs: TIMEOUT_MS,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      Referer: BASE + '/',
      Origin: BASE,
    },
    body: JSON.stringify({ q: kw, page, size: 30 }),
  });

  // 417 = 没有搜索结果，软空
  if (!payload || payload.code === 417) return { items: [], full: false };
  if (payload.code !== 200) {
    throw new Error(payload.message || payload.msg || 'bad payload code ' + payload.code);
  }

  const list = (payload.data && Array.isArray(payload.data.list) && payload.data.list) || [];
  const out = [];
  for (const it of list) {
    const url = String(it.link || '').trim();
    if (!/^https?:\/\//i.test(url) && !/^(magnet:|ed2k:)/i.test(url)) continue;

    const key = cloudmap.normalize(it.disk_type, url);
    const title = stripTags(it.disk_name || '').slice(0, 120);

    // files 是 "\n" 分隔的文件清单，取前几行当补充描述（比标题信息量大）
    const files = stripTags(it.files || '');
    const note = files
      ? files.split('\n').filter(Boolean).slice(0, 3).join('；').slice(0, 160)
      : '';

    const tags = Array.isArray(it.tags)
      ? it.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 5)
      : null;

    out.push({
      title: title || cloudmap.displayName(key) + '资源',
      date: fmtDate(it.update_time || it.shared_time),
      datetime: String(it.update_time || it.shared_time || ''),
      note,
      tags,
      cloud_type: key,
      cloud_type_name: cloudmap.displayName(key),
      icon: cloudmap.iconName(key) || null,
      status: 'valid',
      password: '',
      origin: '混沌搜',
      raw_url: url,
      first_url: url,
      provider: 'hunhepan',
      _fallback: false,
    });
  }
  return { items: out, full: list.length >= 10 };
}

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

  if (Date.now() < backoff.until) {
    stats.backoffSkip++;
    return [];
  }

  try {
    // 第一页必须先成功；后续页并行，失败的页直接丢（部分成功优于全失败）
    const first = await fetchPage(kw, 1);
    let rest = [];
    if (first.full && PAGES > 1) {
      const others = await Promise.allSettled(
        Array.from({ length: PAGES - 1 }, (_, i) => fetchPage(kw, i + 2))
      );
      rest = others
        .filter((r) => r.status === 'fulfilled')
        .flatMap((r) => r.value.items);
    }

    const out = first.items.concat(rest);

    // 成功 → 清退避
    backoff.level = 0;
    backoff.until = 0;

    stats.ok++;
    stats.items += out.length;
    cache.set(kw, out);
    return out;
  } catch (err) {
    stats.fail++;
    lastError = err.message;
    stats.lastError = err.message;

    if (err.status === 400 || err.status === 429) {
      backoff.level = Math.min(backoff.level + 1, 5);
      backoff.until = Date.now() + Math.min(BACKOFF_STEP_MS * backoff.level, BACKOFF_MAX_MS);
      console.warn(
        `[hunhepan] 被限流(${err.status})，退避 ${Math.round((backoff.until - Date.now()) / 1000)}s`
      );
    } else {
      console.warn('[hunhepan] fail:', err.message);
    }
    return [];
  }
}

/** "2026-08-31 09:33:59" -> "2026-08-31" */
function fmtDate(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
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

module.exports = { search, getStats, id: 'hunhepan', label: '混沌搜' };
