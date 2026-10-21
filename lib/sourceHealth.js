'use strict';

/**
 * 数据源健康与熔断。
 *
 * 为什么需要这一层
 *   各源自己只负责「超时就返回空数组」，这不抛异常，于是聚合器看到的是
 *   ok:true、count:0 —— 界面不报错，但每次搜索都要白等满超时。实测 jso
 *   已经死了，仍然稳定吃掉 9 秒；hunhepan 时好时坏，也一样拖慢整次搜索。
 *
 * 判定「失败」不只是抛异常，还包括：
 *   跑满接近超时的耗时，却一条都没返回 —— 这是挂掉的典型特征。
 *   而正常搜不到结果的源是秒回 0 条，两者不能混为一谈。
 *
 * 策略
 *   连续 failThreshold 次失败 → 进入冷却，冷却期内直接跳过（耗时 0ms）。
 *   冷却结束自动放行一次试探；成功即复位，失败则继续冷却。
 */

const config = require('../config');

const cfg = (config.sources && config.sources.health) || {};
const FAIL_THRESHOLD = Number(cfg.failThreshold) || 3;
const COOLDOWN_MS = Number(cfg.cooldownMs) || 10 * 60 * 1000;

// 超过这个耗时且 0 条，视为「疑似挂掉」而不是「真的没有结果」
const SLOW_EMPTY_MS = Number(cfg.slowEmptyMs) || 6000;

const book = new Map();

function entry(id) {
  if (!book.has(id)) {
    book.set(id, {
      ok: 0,
      fail: 0,
      streak: 0,
      skip: 0,
      slowEmpty: 0,
      openUntil: 0,
      lastError: null,
      lastMs: 0,
      lastCount: 0,
      lastFailAt: null,
      lastOkAt: null,
      trips: 0,
    });
  }
  return book.get(id);
}

/** 冷却到期就自动复位，不需要外部定时器 */
function refresh(id) {
  const e = entry(id);
  if (e.openUntil && Date.now() >= e.openUntil) {
    e.openUntil = 0;
    e.streak = 0;
  }
  return e;
}

/** 当前是否可打。不可打时会计一次 skip，便于在状态页看到「省下了多少次」 */
function isAvailable(id) {
  const e = refresh(id);
  if (e.openUntil && Date.now() < e.openUntil) {
    e.skip++;
    return false;
  }
  return true;
}

/**
 * 记录一次调用结果。
 * @param {string} id
 * @param {{ok:boolean, ms:number, count:number, error?:string}} r
 */
function record(id, r) {
  const e = entry(id);
  e.lastMs = Number(r.ms) || 0;
  e.lastCount = Number(r.count) || 0;

  if (r.ok) {
    e.ok++;
    e.streak = 0;
    e.lastError = null;
    e.lastOkAt = Date.now();
    return { tripped: false };
  }

  e.fail++;
  e.streak++;
  e.lastError = r.error || 'unknown';
  e.lastFailAt = Date.now();
  if (r.error === 'slow-empty') e.slowEmpty++;

  if (e.streak >= FAIL_THRESHOLD) {
    e.openUntil = Date.now() + COOLDOWN_MS;
    e.streak = 0;
    e.trips++;
    console.warn(
      `[health] ${id} 连续失败 ${FAIL_THRESHOLD} 次（${e.lastError}），冷却 ${Math.round(COOLDOWN_MS / 1000)}s`
    );
    return { tripped: true };
  }
  return { tripped: false };
}

/**
 * 判定一次调用是否算成功。给聚合器用，避免每个源各写一遍。
 * @param {{error?:string, ms:number, items:number}} p
 */
function judge(p) {
  if (p.error) return { ok: false, error: p.error };
  const slowEmpty = p.items === 0 && p.ms >= SLOW_EMPTY_MS;
  if (slowEmpty) return { ok: false, error: 'slow-empty' };
  return { ok: true, error: null };
}

/** 手动复位（状态页的「重试」按钮、或改配置后热启） */
function reset(id) {
  if (id) {
    book.delete(id);
    return;
  }
  book.clear();
}

function snapshot() {
  const out = {};
  for (const id of book.keys()) {
    const e = refresh(id);
    out[id] = {
      ok: e.ok,
      fail: e.fail,
      streak: e.streak,
      skip: e.skip,
      slowEmpty: e.slowEmpty,
      trips: e.trips,
      cooling: Boolean(e.openUntil && Date.now() < e.openUntil),
      cooldownLeftMs: e.openUntil ? Math.max(0, e.openUntil - Date.now()) : 0,
      lastError: e.lastError,
      lastMs: e.lastMs,
      lastCount: e.lastCount,
      lastOkAt: e.lastOkAt,
      lastFailAt: e.lastFailAt,
    };
  }
  return out;
}

module.exports = {
  isAvailable,
  record,
  judge,
  reset,
  snapshot,
  FAIL_THRESHOLD,
  COOLDOWN_MS,
  SLOW_EMPTY_MS,
};
