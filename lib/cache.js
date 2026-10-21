'use strict';

/**
 * 简单的 TTL + LRU 内存缓存。
 * 不用依赖，够用就好。
 */
class TtlCache {
  constructor({ ttlMs, max }) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.map = new Map();
  }

  get(key) {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (Date.now() > hit.expireAt) {
      this.map.delete(key);
      return null;
    }
    // LRU：命中后挪到队尾
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expireAt: Date.now() + this.ttlMs });
    while (this.map.size > this.max) {
      this.map.delete(this.map.keys().next().value);
    }
  }

  get size() {
    return this.map.size;
  }

  clear() {
    this.map.clear();
  }
}

/**
 * 滑动窗口限速器。
 * 返回 true 表示放行，false 表示已超限。
 */
class SlidingWindowLimiter {
  constructor({ windowMs, max }) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = [];
  }

  tryAcquire() {
    const now = Date.now();
    this.hits = this.hits.filter((t) => now - t < this.windowMs);
    if (this.hits.length >= this.max) return false;
    this.hits.push(now);
    return true;
  }

  get remaining() {
    const now = Date.now();
    this.hits = this.hits.filter((t) => now - t < this.windowMs);
    return Math.max(0, this.max - this.hits.length);
  }
}

module.exports = { TtlCache, SlidingWindowLimiter };
