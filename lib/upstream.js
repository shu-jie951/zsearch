'use strict';

const config = require('../config');
const { TtlCache, SlidingWindowLimiter } = require('./cache');
const { buildFallback } = require('./fallback');

const cache = new TtlCache({
  ttlMs: config.upstream.cacheTtlMs,
  max: config.upstream.cacheMax,
});

const limiter = new SlidingWindowLimiter({
  windowMs: config.upstream.rateLimit.windowMs,
  max: config.upstream.rateLimit.max,
});

// 熔断状态
const breaker = {
  fails: 0,
  openUntil: 0,
};

const stats = {
  hits: 0,
  misses: 0,
  upstreamOk: 0,
  upstreamFail: 0,
  fallbackServed: 0,
  rateLimited: 0,
  breakerTripped: 0,
};

function breakerIsOpen() {
  return Date.now() < breaker.openUntil;
}

function recordFail(reason) {
  stats.upstreamFail++;
  breaker.fails++;
  if (breaker.fails >= config.upstream.circuitBreaker.failThreshold) {
    breaker.openUntil = Date.now() + config.upstream.circuitBreaker.cooldownMs;
    breaker.fails = 0;
    stats.breakerTripped++;
    console.warn(
      `[upstream] 连续失败达到阈值(${reason})，熔断 ${config.upstream.circuitBreaker.cooldownMs / 1000}s`
    );
  }
}

function recordOk() {
  stats.upstreamOk++;
  breaker.fails = 0;
}

/**
 * 统一上游返回的字段，方便前端消费。
 * 上游实际结构：{ data: { results: [ { title, date, tags, links[], first_url,
 *   url_hash, cloud_type_name, status } ] } }
 */
function normalize(payload) {
  const raw = payload && payload.data && Array.isArray(payload.data.results) ? payload.data.results : [];
  return raw.map((item) => {
    const link = Array.isArray(item.links) && item.links.length ? item.links[0] : null;
    return {
      title: item.title || '',
      date: item.date || '',
      datetime: item.datetime || '',
      tags: Array.isArray(item.tags) && item.tags.length ? item.tags : null,
      cloud_type: (link && link.type) || item.cloud_type || '',
      cloud_type_name: item.cloud_type_name || '',
      status: item.status === 'normal' ? 'valid' : item.status || '',
      url_hash: item.url_hash || '',
      // 上游给的是 /api/wash?t=xxx 中转链接，这里改为走本地直跳接口
      first_url: item.first_url || (link && link.url) || '',
      _fallback: false,
    };
  });
}

/**
 * 请求上游搜索接口。
 * @returns {Promise<{results:Array, source:string}>}
 */
async function fetchUpstream(query, sort, cloud) {
  const url = new URL(config.upstream.searchPath, config.upstream.base);
  url.searchParams.set('q', query);
  url.searchParams.set('sort', sort || 'latest');
  url.searchParams.set('cloud', cloud || 'all');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.upstream.timeoutMs);

  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: config.upstream.headers,
      signal: ac.signal,
      redirect: 'follow',
    });

    if (!res.ok) {
      // 403/429 常见于人机验证或限速
      const err = new Error(`upstream ${res.status}`);
      err.status = res.status;
      throw err;
    }

    const text = await res.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      // 返回了 HTML（多半是 Turnstile 拦截页）
      const err = new Error('upstream returned non-JSON (likely turnstile)');
      err.status = 403;
      throw err;
    }

    if (payload && payload.ok === false) {
      const err = new Error(payload.error || 'upstream error');
      err.status = 403;
      throw err;
    }

    const results = normalize(payload);
    return { results, source: 'upstream' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 对外主入口：带缓存、限速、熔断、降级。
 */
async function search(query, { sort = 'latest', cloud = 'all' } = {}) {
  const q = String(query || '').trim();
  if (!q) {
    return { ok: true, data: { results: [], source: 'empty', query: q } };
  }

  const cacheKey = `${q}||${sort}||${cloud}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    stats.hits++;
    return { ok: true, data: { ...cached, cached: true } };
  }
  stats.misses++;

  // 离线模式：配置里没给上游地址，直接降级
  if (!config.upstream.base) {
    stats.fallbackServed++;
    const results = buildFallback(q, cloud);
    const payload = { results, source: 'fallback', reason: 'offline-mode', query: q, sort, cloud };
    cache.set(cacheKey, payload);
    return { ok: true, data: payload };
  }

  // 熔断中，跳过上游
  if (breakerIsOpen()) {
    stats.fallbackServed++;
    const results = buildFallback(q, cloud);
    const payload = { results, source: 'fallback', reason: 'circuit-open', query: q, sort, cloud };
    cache.set(cacheKey, payload);
    return { ok: true, data: payload };
  }

  // 限速
  if (!limiter.tryAcquire()) {
    stats.rateLimited++;
    stats.fallbackServed++;
    const results = buildFallback(q, cloud);
    const payload = { results, source: 'fallback', reason: 'rate-limited', query: q, sort, cloud };
    // 限速的结果只做短缓存，不打长缓存以免污染
    return { ok: true, data: payload };
  }

  try {
    const { results, source } = await fetchUpstream(q, sort, cloud);
    recordOk();
    const payload = { results, source, query: q, sort, cloud };
    cache.set(cacheKey, payload);
    return { ok: true, data: payload };
  } catch (err) {
    recordFail(err.message);
    stats.fallbackServed++;
    const results = buildFallback(q, cloud);
    const payload = {
      results,
      source: 'fallback',
      reason: err.status ? `upstream-${err.status}` : 'upstream-unreachable',
      message: err.message,
      query: q,
      sort,
      cloud,
    };
    // 降级结果缓存 60s，给上游留恢复时间
    const savedTtl = cache.ttlMs;
    cache.ttlMs = 60 * 1000;
    cache.set(cacheKey, payload);
    cache.ttlMs = savedTtl;
    return { ok: true, data: payload };
  }
}

function getStats() {
  return {
    ...stats,
    cacheSize: cache.size,
    rateLimitRemaining: limiter.remaining,
    breakerOpen: breakerIsOpen(),
    breakerOpenUntil: breaker.openUntil || null,
  };
}

module.exports = { search, getStats };
