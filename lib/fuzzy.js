'use strict';

/**
 * 容错匹配。
 *
 * 三种「用户打偏了」的情况，各有一把工具：
 *
 *   打错一个字   庆余午 → 庆余年      minWindowDistance()  窗口编辑距离 ≤1
 *   少打中间的字 庆年   → 庆余年      subseqRatio()        有序子序列覆盖率
 *   用拼音/首字母 qyn  → 庆余年      lib/pinyin.js        标题转拼音再比对
 *
 * 全部是纯函数。刻意不引入 fuzzysort / fuse.js：
 *   它们是为「几万条候选里做模糊排序」设计的（建索引、打分、阈值），
 *   我们这里每条结果只算一次、候选集只有几百条，自己写更小也更好解释。
 */

/** 有序子序列判定：needle 的每个字按顺序出现在 hay 里（可以跳字） */
function isSubsequence(needle, hay) {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) {
    if (hay[j] === needle[i]) i++;
  }
  return i === needle.length;
}

/**
 * 子序列覆盖率 = 最长公共子序列长度 / needle 长度。
 * 用于「用户少打了中间的字」：庆年 对 庆余年 覆盖率 = 1.0。
 */
function subseqRatio(needle, hay) {
  const n = needle.length;
  const m = hay.length;
  if (!n) return 0;
  if (!m) return 0;
  if (n > m + 1) return 0; // 长度差太多不可能高覆盖，提前退出
  if (hay.includes(needle)) return 1;

  // 经典 LCS，二维滚动数组。n/m 都在几十的量级，直接算不吃亏。
  let prev = new Int32Array(m + 1);
  let cur = new Int32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    const c = needle[i - 1];
    for (let j = 1; j <= m; j++) {
      cur[j] = c === hay[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const t = prev;
    prev = cur;
    cur = t;
    cur.fill(0);
  }
  return prev[m] / n;
}

/**
 * 编辑距离（带提前退出）。
 */
function editDistance(a, b, max) {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  let prev = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    let cur = [i];
    let rowMin = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[lb];
}

/**
 * 在 hay 里找一个与 needle 编辑距离 ≤ max 的「窗口」，返回最小距离。
 *
 * 这就是「打错一个字」的判据：标题里有一段和查询几乎一样（差 1 个字符）。
 * 单纯对整条标题算编辑距离没用 —— 标题通常长得多，距离必然很大。
 *
 * @param {string} hay   标题（已 squash）
 * @param {string} needle 查询词（已 squash）
 * @param {number} max
 * @returns {number} 距离；> max 表示没有近似窗口
 */
function minWindowDistance(hay, needle, max = 1) {
  const n = needle.length;
  const m = hay.length;
  if (!n || !m) return max + 1;
  if (m < n - max) return max + 1;

  // 便宜的前置过滤：needle 的字有多少在 hay 里出现。
  // 差一个字符的话，至少有 n-max 个不同的字得出现，否则连窗口都不用试。
  const set = new Set(hay);
  let have = 0;
  const seen = new Set();
  for (const ch of needle) {
    if (seen.has(ch)) continue;
    seen.add(ch);
    if (set.has(ch)) have++;
  }
  if (have < Math.max(1, seen.size - max)) return max + 1;

  let best = max + 1;
  // 窗口长度取 n-1 / n / n+1（漏字或错字各一种）
  for (let len = Math.max(1, n - max); len <= n + max; len++) {
    for (let start = 0; start + len <= m; start++) {
      const d = editDistance(needle, hay.slice(start, start + len), max);
      if (d < best) {
        best = d;
        if (best === 0) return 0;
      }
    }
  }
  return best;
}

/** 看起来像拼音/首字母输入（纯字母，2~20 位） */
function looksLikeLatinWord(s) {
  return /^[a-z]{2,20}$/.test(String(s || '').toLowerCase());
}

module.exports = { isSubsequence, subseqRatio, editDistance, minWindowDistance, looksLikeLatinWord };
