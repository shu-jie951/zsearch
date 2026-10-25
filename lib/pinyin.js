'use strict';

/**
 * 汉字 → 拼音（运行时，零依赖）。
 *
 * 数据来自 lib/data/pinyin.js（构建期由 _build_pinyin.js 用 pinyin-pro 生成）。
 * 这里只做三件事：建反向表、转全拼、转首字母，外加一层结果缓存。
 *
 * 为什么方向是「标题 → 拼音」而不是「查询 → 拼音」：
 *   用户打 `qyn` / `qingyunian` 时，我们没法把拼音确定地还原成某个中文词
 *   （qyn 可以是 庆余年 / 千与千寻 / 倩女幽魂）。但把**标题**转成拼音再比对，
 *   是确定性的、无歧义的 —— 命中就是命中，不会把用户送到完全无关的资源上。
 */

const GROUPS = require('./data/pinyin');

// 音节 → 汉字串；同时建 汉字 → 音节 的反向表
const charToSyllable = new Map();
for (const [syl, chars] of Object.entries(GROUPS)) {
  for (const ch of chars) charToSyllable.set(ch, syl);
}

const CJK = /[\u4e00-\u9fff]/;

// 标题级缓存：同一批结果里标题长度不一，但重复率高（折叠前尤其明显）。
// 上限 4000 条，超出直接清空（比实现 LRU 简单，且这里没有热点倾斜问题）。
const CACHE_MAX = 4000;
const fullCache = new Map();
const initialCache = new Map();

function trimCache(map) {
  if (map.size > CACHE_MAX) map.clear();
}

/**
 * 单字拼音。非汉字返回 null。
 * @param {string} ch
 * @returns {string|null}
 */
function syllableOf(ch) {
  return charToSyllable.get(ch) || null;
}

/**
 * 整串转全拼：汉字转音节，字母数字原样保留（小写），其余丢弃。
 * 「庆余年4K」→「qingyunian4k」
 */
function toFull(s) {
  const src = String(s || '');
  const hit = fullCache.get(src);
  if (hit !== undefined) return hit;

  let out = '';
  for (const ch of src) {
    if (CJK.test(ch)) {
      out += charToSyllable.get(ch) || '';
    } else if (/[a-z0-9]/i.test(ch)) {
      out += ch.toLowerCase();
    }
    // 空格/标点直接丢弃：拼音匹配里它们是噪音
  }
  trimCache(fullCache);
  fullCache.set(src, out);
  return out;
}

/**
 * 整串转首字母：「庆余年」→「qyn」；字母数字原样接上。
 * 单字没有音节表时（生僻字）跳过，避免把 undefined 拼进去。
 */
function toInitials(s) {
  const src = String(s || '');
  const hit = initialCache.get(src);
  if (hit !== undefined) return hit;

  let out = '';
  for (const ch of src) {
    if (CJK.test(ch)) {
      const syl = charToSyllable.get(ch);
      if (syl) out += syl[0];
    } else if (/[a-z0-9]/i.test(ch)) {
      out += ch.toLowerCase();
    }
  }
  trimCache(initialCache);
  initialCache.set(src, out);
  return out;
}

/** 这串里有多少汉字是我们认识的（用于判断拼音匹配是否可信） */
function coverage(s) {
  let known = 0;
  let cjk = 0;
  for (const ch of String(s || '')) {
    if (!CJK.test(ch)) continue;
    cjk++;
    if (charToSyllable.has(ch)) known++;
  }
  return cjk ? known / cjk : 0;
}

module.exports = { toFull, toInitials, syllableOf, coverage, size: charToSyllable.size };
