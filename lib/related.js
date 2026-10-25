'use strict';

/**
 * 相关词（"搜完这一批，你大概还想搜什么"）。
 *
 * 思路借鉴那批影视/短剧搜索站：它们结果页都有一排「相关搜索」，
 * 但不是词库拼的，而是从**当前结果集的标题**里统计出来的 —— 同一批资源
 * 反复出现的词，往往就是下一个该搜的词（系列名、季数、演员、画质）。
 *
 * 流程：标题切出中文片段 → 统计 2-gram → 过滤噪音 → 按「后一个字投票」向右扩成 3~4 字
 *      → 去掉互为子串的短词 → 按「次数 × 长度权重」排序。
 *
 * 三个必须过滤的东西（不过滤就没法看）：
 *   · 查询词本身（含它的 2-gram）—— 用户刚搜过，再推一次是废话
 *   · 泛词（合集/下载/网盘/资源/更新…）—— 几乎每个标题都有，信息量为零
 *   · 纯数字 —— "2024""1080" 排上去毫无意义
 */

// 泛词：出现在几乎每个标题里，推给用户等于噪音
const NOISE = new Set([
  '合集', '大全', '全集', '完整', '整版', '资源', '下载', '网盘', '云盘', '分享',
  '免费', '最新', '更新', '整理', '打包', '持续', '长期', '拿走', '自取', '版本',
  '高清', '超清', '蓝光', '原盘', '中字', '字幕', '双语', '国语', '粤语', '无删',
  '删除', '未删', '收藏', '推荐', '热门', '精选', '必备', '珍藏', '官方', '中文',
  '链接', '密码', '提取', '文件', '目录', '列表', '说明', '注意', '请看', '暂无',
]);

const CJK_RUN = /[\u4e00-\u9fff]+/g;

/**
 * @param {Array} items 结果列表（标题已清洗）
 * @param {object} analyzed queryUtil.analyze() 的结果
 * @param {number} limit
 * @returns {string[]}
 */
function extract(items, analyzed, limit = 8) {
  const list = Array.isArray(items) ? items : [];
  if (list.length < 3) return [];

  const core = String((analyzed && (analyzed.core || analyzed.q)) || '').replace(/\s+/g, '');
  const coreGrams = new Set();
  for (let i = 0; i + 2 <= core.length; i++) coreGrams.add(core.slice(i, i + 2));

  // 1. 切成中文片段（一条标题可能有多个片段：中文 + 英文混排）
  const runs = [];
  for (const it of list) {
    const t = String((it && it.title) || '');
    if (!t) continue;
    const found = t.match(CJK_RUN);
    if (found) for (const r of found) if (r.length >= 2) runs.push(r);
  }
  if (!runs.length) return [];

  // 2. 统计 2-gram（同一片段内只记一次，避免长标题刷分）
  //
  //    ★ 与查询词**位置重叠**的 gram 直接跳过。
  //      只排除「gram 等于查询的 2-gram」是不够的："考研数学一" 里
  //      "考研" 是查询，但 "研数学" 照样会命中 —— 半个字粘着查询词，
  //      统计出来就是垃圾（实测第一条就是这个坑）。
  const counts = new Map();
  for (const run of runs) {
    // 标记被查询词覆盖的位置
    const banned = new Array(run.length).fill(false);
    for (let s = run.indexOf(core); s >= 0; s = run.indexOf(core, s + 1)) {
      for (let k = s; k < s + core.length && k < run.length; k++) banned[k] = true;
    }
    const seen = new Set();
    for (let i = 0; i + 2 <= run.length; i++) {
      if (banned[i] || banned[i + 1]) continue;
      const g = run.slice(i, i + 2);
      if (seen.has(g)) continue;
      seen.add(g);
      counts.set(g, (counts.get(g) || 0) + 1);
    }
  }

  const minCount = Math.max(2, Math.ceil(runs.length * 0.03));

  // 3. 筛种子
  const seeds = [];
  for (const [g, c] of counts) {
    if (c < minCount) continue;
    if (NOISE.has(g)) continue;
    if (coreGrams.has(g) || core.includes(g)) continue;
    if (/^\d+$/.test(g)) continue;
    seeds.push({ term: g, count: c });
  }
  if (!seeds.length) return [];

  // 4. 向右扩展：统计「片段里 term 后面紧跟的那个字」，票数够多才延长。
  //    这样得到的是真词组（如「庆余年」→「庆余年第二季」），而不是随机拼接。
  const grow = (term, count) => {
    let cur = term;
    let curCount = count;
    while (cur.length < 4) {
      const votes = new Map();
      for (const run of runs) {
        let idx = run.indexOf(cur);
        while (idx >= 0) {
          const next = run[idx + cur.length];
          if (next) votes.set(next, (votes.get(next) || 0) + 1);
          idx = run.indexOf(cur, idx + 1);
        }
      }
      if (!votes.size) break;
      let bestCh = '';
      let bestN = 0;
      for (const [ch, n] of votes) {
        if (n > bestN) { bestCh = ch; bestN = n; }
      }
      // 至少六成的出现都跟着同一个字，才算一个稳定的词组
      if (bestN < Math.max(2, Math.ceil(curCount * 0.6))) break;
      cur += bestCh;
      curCount = bestN;
    }
    return { term: cur, count: curCount };
  };

  const grown = seeds.map((s) => grow(s.term, s.count));

  // 5. 去重：互为子串的只留长的
  grown.sort((a, b) => b.term.length - a.term.length || b.count - a.count);
  const uniq = [];
  for (const e of grown) {
    if (uniq.some((u) => u.term.includes(e.term))) continue;
    uniq.push(e);
  }

  // 6. 排序：出现次数为主，长度给一点加成（3~4 字比 2 字更有信息量）
  uniq.sort(
    (a, b) =>
      b.count * (1 + (b.term.length - 2) * 0.15) - a.count * (1 + (a.term.length - 2) * 0.15)
  );

  return uniq.slice(0, limit).map((u) => u.term);
}

module.exports = { extract };
