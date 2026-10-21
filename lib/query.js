'use strict';

/**
 * 查询理解 + 相关性评分。
 *
 * 解决的核心问题：聚合层原来只按「日期 + 链接质量分」排序，
 * 完全不管结果跟关键词有多相关——经常出现标题根本不含关键词的条目
 * 因为日期新而排在最前面。
 *
 * 这里做三件事：
 *   1. tokenize —— 把查询拆成「词元」（中文按 2-gram 切、拉丁按空格切），
 *      同时识别出年份（2024/2025）这类强约束数字。
 *   2. relevance —— 给单条结果打相关性分，分级思路借鉴 LunaTV 的
 *      智能排序：整词精确命中 > 前缀命中 > 包含命中 > 词元覆盖率 > 编辑距离模糊，
 *      年份命中/冲突单独加减分。
 *   3. suggestVariants —— 无结果时生成查询变体（去年份、拆空格、去标点），
 *      供空状态提示「要不要试试：xxx」。
 *
 * 全部是纯函数，无副作用，方便 QA 单测。
 */

const CJK_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/;

/**
 * 查询归一化 + 词元化。
 * @param {string} raw
 * @returns {{q:string, tokens:string[], year:string|null, latin:string[]}}
 */
function analyze(raw) {
  let q = String(raw || '')
    .replace(/[　]/g, ' ')
    .replace(/[，。！？；：、（）【】《》〈〉「」『』·…—～]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  if (!q) return { q: '', tokens: [], year: null, latin: [] };

  // 年份：19xx / 20xx（资源语境里年份是强约束：2024考研 ≠ 2023考研）
  let year = null;
  const ym = q.match(/\b(19\d{2}|20\d{2})\b/);
  if (ym) year = ym[1];

  const latin = [];
  const tokens = new Set();

  for (const part of q.split(' ')) {
    if (!part) continue;
    if (CJK_RE.test(part)) {
      // 中日韩：整段作为一个 token，同时拆 2-gram 提高覆盖
      if (part.length >= 2) tokens.add(part);
      for (let i = 0; i + 2 <= part.length; i++) {
        const g = part.slice(i, i + 2);
        // 跳过纯标点组合（归一化后已少见）
        if (/[぀-ヿ㐀-䶿一-鿿豈-﫿a-z0-9]{2}/i.test(g)) tokens.add(g);
      }
      if (part.length === 1) tokens.add(part);
    } else if (/^[a-z0-9.+-]+$/i.test(part)) {
      latin.push(part);
      tokens.add(part);
    }
  }

  // 整词（去掉空格后）也是最强匹配项
  const whole = q.replace(/\s+/g, '');
  if (whole.length >= 2) tokens.add(whole);

  return { q, tokens: Array.from(tokens), year, latin };
}

/** 编辑距离（早退版：超过 max 直接返回 max+1，够用于模糊判断） */
function editDistance(a, b, max) {
  if (a === b) return 0;
  const la = a.length, lb = b.length;
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

/** 归一化标题/描述，供匹配 */
function normText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[　，。！？；：、（）()【】\[\]《》〈〉「」『』·…—～\-_|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 相关性评分（越高越相关）。
 * 满分大约 100：
 *   整词精确命中标题   +40   （"周杰伦" 完整出现在标题里）
 *   标题以前缀开头     +25   （标题以查询词开头，最强信号）
 *   查询词元覆盖率     +0~25 （所有词元都命中标题 → 25；部分按比例）
 *   标题首尾位置加成   +0~5  （命中越靠前越好）
 *   描述/note 命中     +8
 *   年份命中           +10 / 年份冲突 -15
 *   模糊（编辑距离≤1） +6    （只在没有精确命中时给，防错字）
 *   完全不相关          0~2   （什么都不沾，给个底分避免负数）
 */
function relevance(item, analyzed) {
  if (!analyzed || !analyzed.q) return 0;
  const title = normText(item.title);
  const note = normText(item.note);
  if (!title && !note) return 0;

  const q = analyzed.q;
  const qWhole = q.replace(/\s+/g, '');
  const titleSquash = title.replace(/\s+/g, '');
  const noteSquash = note.replace(/\s+/g, '');

  let score = 0;
  let exactHit = false;

  // 整词精确命中（最强信号）
  if (qWhole.length >= 2 && titleSquash.includes(qWhole)) {
    exactHit = true;
    score += 40;
    if (titleSquash.startsWith(qWhole)) score += 25; // 前缀命中
    else {
      // 命中位置越靠前越好：0 偏移 ~ +5，靠后递减
      const pos = titleSquash.indexOf(qWhole);
      score += Math.max(0, 5 - Math.floor(pos / 8));
    }
  }

  // 词元覆盖率（整词没命中时的主要依据）
  let covered = 0;
  let considered = 0;
  for (const t of analyzed.tokens) {
    if (t.length < 2) continue; // 单字/单字符噪音太大，不计
    considered++;
    if (titleSquash.includes(t)) covered++;
    else if (noteSquash.includes(t)) { covered += 0.5; }
  }
  if (considered) {
    score += Math.round((covered / considered) * 25);
  }

  // 描述命中整词
  if (qWhole.length >= 2 && noteSquash.includes(qWhole)) score += 8;

  // 年份约束
  if (analyzed.year) {
    const y = analyzed.year;
    if (title.includes(y) || note.includes(y)) score += 10;
    else if (exactHit) score -= 15; // 标题明确不是这一年 → 强降权
  }

  // 模糊命中（标题与查询词元编辑距离 ≤1，只在无精确命中时启用）
  if (!exactHit && qWhole.length >= 3) {
    // 对标题取与查询等长的滑动窗口代价太高；只对拉丁词做轻量模糊
    let fuzzy = false;
    for (const w of analyzed.latin) {
      if (w.length < 3) continue;
      for (const tw of title.split(' ')) {
        if (Math.abs(tw.length - w.length) > 1) continue;
        if (editDistance(tw, w, 1) <= 1) { fuzzy = true; break; }
      }
      if (fuzzy) break;
    }
    if (fuzzy) score += 6;
  }

  return score;
}

/**
 * 无结果时的查询变体建议。
 * @returns {string[]} 去重后的变体（不含原查询）
 */
function suggestVariants(raw) {
  const a = analyze(raw);
  const out = [];
  if (!a.q) return out;

  // 1) 去掉年份再试（年份是最常见的"搜太死"原因）
  if (a.year) {
    const noYear = a.q.replace(/\b(19\d{2}|20\d{2})\b/, '').replace(/\s+/g, ' ').trim();
    if (noYear && noYear !== a.q) out.push(noYear);
  }

  // 2) 空格拆开太长时，取前半（用户常把整句粘贴进来）
  const parts = a.q.split(' ').filter(Boolean);
  if (parts.length >= 3) {
    const head = parts.slice(0, Math.max(1, Math.ceil(parts.length / 2))).join(' ');
    if (head !== a.q) out.push(head);
  }

  // 3) 多个词元时退化为最核心的那个（最长的 CJK 段）
  if (parts.length >= 2) {
    const cjkParts = parts.filter((p) => CJK_RE.test(p)).sort((x, y) => y.length - x.length);
    if (cjkParts.length && cjkParts[0] !== a.q) out.push(cjkParts[0]);
  }

  return Array.from(new Set(out)).slice(0, 3);
}

module.exports = { analyze, relevance, suggestVariants, editDistance };
