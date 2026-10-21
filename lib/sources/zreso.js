'use strict';

/**
 * 数据源：zreso（原站）
 *   站点：https://zreso.cn
 *
 * 机制特点：
 *   - GET /api/search?q=&sort=&cloud=  返回 JSON
 *   - 返回的 first_url 是**中转链接** /api/wash?t=<uuid>，需要二次请求才能拿到
 *     真实的 raw_url → 这是它和 PanSou / j-so 最大的区别
 *   - 有 Cloudflare Turnstile 风控：被识别时返回 429 + {"error":"TURNSTILE_REQUIRED"}
 *
 * 本适配器只负责「把上游结果转成统一结构」，缓存/限速/熔断/降级仍由
 * lib/upstream.js 负责（那一层是 zreso 专属的策略层）。
 */

const cloudmap = require('./_cloudmap');

// 上游 status 字段归一化
function statusToKind(s) {
  const t = String(s || '').toLowerCase();
  if (t === 'normal' || t === 'valid') return 'valid';
  if (t === 'invalid' || t === 'expired') return 'invalid';
  if (t === 'fast' || t === 'fast_acquire') return 'fast_acquire';
  return t;
}

/**
 * 把 zreso 的响应体转成统一结构。
 * 上游结构：{ data: { results: [ { title, date, datetime, tags, links[],
 *   first_url, url_hash, cloud_type_name, status } ] } }
 */
function normalize(payload) {
  const raw =
    payload && payload.data && Array.isArray(payload.data.results) ? payload.data.results : [];
  return raw.map((item) => {
    const link = Array.isArray(item.links) && item.links.length ? item.links[0] : null;
    const firstUrl = item.first_url || (link && link.url) || '';
    const key = cloudmap.normalize((link && link.type) || item.cloud_type || '', firstUrl);
    return {
      title: item.title || '',
      date: item.date || '',
      datetime: item.datetime || '',
      tags: Array.isArray(item.tags) && item.tags.length ? item.tags : null,
      cloud_type: key,
      cloud_type_name: item.cloud_type_name || cloudmap.displayName(key),
      icon: cloudmap.iconName(key) || null,
      status: statusToKind(item.status),
      url_hash: item.url_hash || '',
      // 上游给的是 /api/wash?t=xxx 中转链接，后续由 /go 拦截解析
      raw_url: '',
      first_url: firstUrl,
      provider: 'zreso',
      _fallback: false,
    };
  });
}

module.exports = { normalize, id: 'zreso', label: '原站索引' };
