'use strict';

/**
 * 数据源注册表。
 *
 * 每个源的职责边界：
 *   - 输入关键词，输出**统一结构**的结果数组
 *   - 自己处理超时，失败时返回 [] 而不是抛异常（保证不拖垮聚合）
 *   - 不碰缓存 / 限速 / 熔断（那是 aggregator 和 upstream 的事）
 *
 * 开关在 config.js 的 sources 段里控制，改完重启生效。
 */

const config = require('../../config');
const pansou = require('./pansou');
const jso = require('./jso');
const hunhepan = require('./hunhepan');

/**
 * zreso 是特殊情况：它有一整套缓存/限速/熔断策略，
 * 由 lib/upstream.js 统一实现，这里只做一层薄包装，让它和其他源同构。
 */
const zresoAdapter = {
  id: 'zreso',
  label: '原站索引',
  async search(query, opts) {
    const upstream = require('../upstream');
    const r = await upstream.search(query, opts);
    const data = (r && r.data) || null;

    // 关键：upstream.js 在上游失败 / 熔断 / 限流时，会返回本地兜底演示数据
    // （payload.source === 'fallback'）。那些不是真实资源，混进列表就是
    // 假链接，用户点开必然打不开。这里直接丢弃，并显式告诉聚合层
    // 「本次没有真实数据」，让它计入健康度 —— 否则 zreso 会永远占着位置
    // 却不贡献任何东西（实测被 Turnstile 风控后一直如此）。
    if (!data || data.source === 'fallback') {
      return { items: [], unavailable: true };
    }

    return { items: Array.isArray(data.results) ? data.results : [], meta: data };
  },
};

const REGISTRY = {
  pansou: {
    id: 'pansou',
    label: '盘搜聚合',
    search: (q, o) => pansou.search(q, o).then((items) => ({ items })),
  },
  jso: {
    id: 'jso',
    label: '珈珈搜索',
    search: (q, o) => jso.search(q, o).then((items) => ({ items })),
  },
  hunhepan: {
    id: 'hunhepan',
    label: '混沌搜',
    search: (q, o) => hunhepan.search(q, o).then((items) => ({ items })),
  },
  zreso: zresoAdapter,
};

/** 返回配置里启用且已知的源 id 列表 */
function enabledIds() {
  const cfg = (config.sources && config.sources.enabled) || [];
  return cfg.filter((id) => Boolean(REGISTRY[id]));
}

/** 按 id 取源实现 */
function get(id) {
  return REGISTRY[id] || null;
}

/** 所有已注册源的元信息（给 /api/status 用） */
function describe() {
  const enabled = new Set(enabledIds());
  return Object.values(REGISTRY).map((s) => ({
    id: s.id,
    label: s.label,
    enabled: enabled.has(s.id),
  }));
}

/** 各源的独立运行统计 */
function stats() {
  return {
    pansou: pansou.getStats(),
    jso: jso.getStats(),
    hunhepan: hunhepan.getStats(),
  };
}

module.exports = { enabledIds, get, describe, stats, REGISTRY };
