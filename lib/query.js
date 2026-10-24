'use strict';

/**
 * 查询理解 + 相关性评分。
 *
 * 这里的每一处改动都有实测依据，改之前先看注释里的数字。
 *
 * 一条查询要走完四步：
 *   1. normalize  —— 全角转半角、繁转简、标点归一
 *   2. stripFiller—— 剥掉「求 / 有没有 / …的资源」这类口语修饰，
 *                    得到真正该拿去搜的 `core`
 *   3. intent     —— 识别类型（影视/音乐/课程/软件…）、年份、季集、画质
 *   4. variants   —— 主词搜不到时，按「去年份 / 去季集 / 取核心词」退让
 *
 * 为什么去掉口语这么关键（2026-10-24 实测，上游 so.252035.xyz）：
 *   「庆余年」                → 有结果
 *   「有没有庆余年的资源」     → 5.5 秒返回 total=0
 *   上游是按分享标题做子串匹配的，五个字的后缀足以让召回清零。
 *   以前我们把用户输入原样转发，等于让用户自己祈祷措辞正确。
 *
 * 全部是纯函数，无副作用，方便 QA 单测（见 _qa_query.js）。
 */

const intent = require('./intent');

const CJK_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/;

/** 全角 → 半角 + 常见异体标点归一。只处理 ASCII 可见区，避免误伤 CJK。 */
function toHalfWidth(s) {
  return String(s || '')
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ');
}

/** 繁体 → 简体（只转词表里有的字，其余原样保留） */
function toSimplified(s) {
  let out = '';
  for (const ch of String(s || '')) out += intent.T2S.get(ch) || ch;
  return out;
}

/** 归一化：全角→半角、繁→简、标点→空格、折叠空白、转小写 */
function normalize(raw) {
  return toHalfWidth(raw)
    // 先处理全角标点，再处理半角 —— toHalfWidth 会把「，」变成「,」，
    // 如果只匹配全角那一批，逗号会留在字符串里把词切开（实测踩过）
    .replace(/[，。！？；：、（）【】《》〈〉「」『』·…—～]/g, ' ')
    .replace(/[,.;:!?()[\]{}<>"'`~*|/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * 剥掉口语修饰。
 *
 * 循环剥（最多 6 轮）：`有没有庆余年的资源` 需要先去掉中间的「的资源」，
 * 才能露出开头的「有没有」，一次替换搞不定。
 *
 * 安全阀：剥完剩不到 2 个有效字符，就退回原词 —— 宁可搜不到，
 * 也不能把「求资源」这种用户真实输入剥成空字符串。
 */
function stripFiller(s) {
  const src = String(s || '').trim();
  if (!src) return '';
  let t = src;
  for (let i = 0; i < 6; i++) {
    const before = t;
    t = t
      .replace(intent.MID_FILLER, ' ')
      .replace(intent.LEAD_FILLER, '')
      .replace(intent.TAIL_FILLER, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (t === before) break;
  }
  const solid = (t.match(/[\p{L}\p{N}]/gu) || []).length;
  if (solid < 2) return src;
  return t;
}

/** 识别类型（多规则命中取 weight 最高的那个） */
function detectType(s) {
  let best = null;
  for (const rule of intent.TYPE_RULES) {
    if (rule.test.test(s) && (!best || rule.weight > best.weight)) {
      best = { type: rule.type, weight: rule.weight };
    }
  }
  return best ? best.type : 'general';
}

/** 抽出年份（资源语境里是强约束：2024考研 ≠ 2023考研） */
function detectYear(s) {
  const m = String(s || '').match(/\b(19\d{2}|20\d{2})\b/);
  return m ? m[1] : null;
}

/** 抽出季集（第二季 / S02 / Season 2 / 第12集 / 全24集） */
function detectSeason(s) {
  const m = String(s || '').match(intent.SEASON_RE);
  return m ? m[0].replace(/\s+/g, '') : null;
}

/** 抽出画质/语言/版本标签（去重，保留出现顺序） */
function detectQuality(s) {
  const out = [];
  const str = String(s || '');
  intent.QUALITY_RE.lastIndex = 0;
  let m;
  while ((m = intent.QUALITY_RE.exec(str))) {
    const v = m[0].toLowerCase();
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * 去掉某一类修饰词，用于生成「退让版」查询。
 * @param {string} s
 * @param {'year'|'season'|'quality'} kind
 */
function stripTag(s, kind) {
  let t = String(s || '');
  // 年份后面常紧跟一个「年」：「考研2025年真题」去年份后不能剩下「年真题」
  if (kind === 'year') t = t.replace(/\b(19\d{2}|20\d{2})\s*年?/g, ' ');
  if (kind === 'season') t = t.replace(intent.SEASON_RE, ' ');
  if (kind === 'quality') {
    intent.QUALITY_RE.lastIndex = 0;
    t = t.replace(intent.QUALITY_RE, ' ');
  }
  return t.replace(/\s+/g, ' ').trim();
}

/**
 * 查询预处理：一条原始输入 → 该搜什么 + 备选怎么搜。
 *
 * @param {string} raw
 * @returns {{
 *   raw:string, norm:string, core:string, upstream:string,
 *   changed:boolean, intent:{type:string,year:string|null,season:string|null,quality:string[]},
 *   variants:Array<{q:string,reason:string}>
 * }}
 */
function prepare(raw) {
  const original = String(raw || '').trim();
  // ★ 必须先转简体再归一：上游的分享标题基本是简体，繁体查询会整条召回清零。
  //   顺序反了（先剥修饰再转）就会出现「資源」这种繁体后缀剥不掉的情况。
  const norm = normalize(toSimplified(original));
  const core = stripFiller(norm);

  // 剥完如果短得没法用，就退回归一化原文（core 为空的极端情况已在 stripFiller 里兜住，
  // 这里再兜一次单字符：搜「剧」不该被当成噪音）
  const usable = (t) => (t.match(/[\p{L}\p{N}]/gu) || []).length >= 2;
  const upstream = usable(core) ? core : norm;

  const year = detectYear(norm);
  const season = detectSeason(norm);
  const quality = detectQuality(norm);
  const type = detectType(norm);

  const variants = [];
  const push = (q, reason) => {
    const v = String(q || '').replace(/\s+/g, ' ').trim();
    if (!usable(v) || v === upstream) return;
    if (variants.some((x) => x.q === v)) return;
    variants.push({ q: v, reason });
  };

  // 1) 去口语后的主词（normalize 只做了标点/繁简，stripFiller 才去修饰）
  if (upstream !== norm) push(upstream, '去口语修饰');

  // 2) 去季集：搜「庆余年第二季」经常漏掉「庆余年」的整季包
  if (season) push(stripTag(upstream, 'season'), '去季集');

  // 3) 去年份：年份是最常见的「搜太死」原因
  if (year) push(stripTag(upstream, 'year'), '去年份');

  // 4) 去画质标签：4K/1080p 这类词在标题里写法极不统一
  if (quality.length) push(stripTag(upstream, 'quality'), '去画质标签');

  // 5) 多段查询退化到最长的中文段（用户常把整句粘进来）
  const parts = upstream.split(' ').filter(Boolean);
  if (parts.length >= 2) {
    const cjk = parts.filter((p) => CJK_RE.test(p)).sort((a, b) => b.length - a.length);
    if (cjk.length) push(cjk[0], '取核心词');
  }

  // 6) 繁体再转一次（normalize 已转，这里兜住「去修饰后才露出繁体」的情况）
  const simp = toSimplified(upstream);
  if (simp !== upstream) push(simp, '转简体');

  return {
    raw: original,
    norm,
    core,
    upstream,
    changed: upstream !== norm,
    intent: { type, year, season, quality },
    variants: variants.slice(0, 4),
  };
}

/**
 * 词元化（保留旧签名，内部走 prepare）。
 * @param {string} raw
 * @returns {{q:string, core:string, tokens:string[], year:string|null, latin:string[], intent:object}}
 */
function analyze(raw) {
  const p = prepare(raw);
  const base = p.core || p.norm;

  const latin = [];
  const tokens = new Set();

  for (const part of base.split(' ')) {
    if (!part) continue;
    if (CJK_RE.test(part)) {
      // 中日韩：整段作为一个 token，同时拆 2-gram 提高覆盖
      if (part.length >= 2) tokens.add(part);
      for (let i = 0; i + 2 <= part.length; i++) {
        const g = part.slice(i, i + 2);
        if (/[぀-ヿ㐀-䶿一-鿿豈-﫿a-z0-9]{2}/i.test(g)) tokens.add(g);
      }
      if (part.length === 1) tokens.add(part);
    } else if (/^[a-z0-9.+-]+$/i.test(part)) {
      latin.push(part);
      tokens.add(part);
    }
  }

  // 整词（去掉空格后）也是最强匹配项。
  // 只在单段查询时启用：「周杰伦 无损」拼成「周杰伦无损」并不成词，
  // 当成 token 会白白拉低覆盖率（多一个必然不命中的项）。
  const whole = base.replace(/\s+/g, '');
  if (whole.length >= 2 && !base.includes(' ')) tokens.add(whole);

  return {
    q: p.norm,
    core: base,
    tokens: Array.from(tokens),
    year: p.intent.year,
    latin,
    intent: p.intent,
  };
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
 *
 * 分档（满分约 110）：
 *   主词精确命中标题   +45   「周杰伦」完整出现在标题里
 *   标题以主词开头     +25   最强信号
 *   词元覆盖率         +0~25
 *   描述/note 命中     +8
 *   交叉验证           +0~6  （多源同时收录，在聚合层加）
 *   意图一致           +0~10 类型 / 画质 / 季集命中
 *   年份命中 +10 / 冲突 -15
 *   泛词堆砌           -8    （标题只有「合集/大全/福利」里那些词）
 *   模糊（编辑距离≤1）  +6    只在没有精确命中时给，防错字
 */
function relevance(item, analyzed) {
  if (!analyzed || !(analyzed.core || analyzed.q)) return 0;
  const title = normText(item.title);
  const note = normText(item.note);
  if (!title && !note) return 0;

  const core = analyzed.core || analyzed.q;
  const qWhole = core.replace(/\s+/g, '');
  const titleSquash = title.replace(/\s+/g, '');
  const noteSquash = note.replace(/\s+/g, '');

  let score = 0;
  let exactHit = false;

  // 主词精确命中（最强信号）
  if (qWhole.length >= 2 && titleSquash.includes(qWhole)) {
    exactHit = true;
    score += 45;
    if (titleSquash.startsWith(qWhole)) score += 25;
    else {
      const pos = titleSquash.indexOf(qWhole);
      score += Math.max(0, 5 - Math.floor(pos / 8));
    }
  }

  // 词元覆盖率。
  //
  // 注意这里分成两级，不能只看 2-gram：
  //   「周杰伦 无损」的标题是「周杰伦全部专辑 FLAC 无损」——整串当然不连续，
  //   但两个词都在，就是强命中。只按 2-gram 算会把它压到 20 分左右，
  //   排在一堆日期新的无关条目后面（这是实测踩过的坑）。
  const parts = core.split(' ').filter((p) => p.length >= 2);
  let partHit = 0;
  for (const p of parts) {
    const ps = p.replace(/\s+/g, '');
    if (titleSquash.includes(ps)) partHit++;
    else if (noteSquash.includes(ps)) partHit += 0.5;
  }
  const allParts = parts.length >= 2 && partHit >= parts.length - 0.001;

  if (allParts) {
    score += 60; // 查询里每个词都在标题里（顺序无关）—— 仅次于整串命中
  } else if (parts.length) {
    score += Math.round((partHit / Math.max(1, parts.length)) * 30);
  }

  if (!exactHit && !allParts) {
    let covered = 0;
    let considered = 0;
    for (const t of analyzed.tokens) {
      if (t.length < 2) continue; // 单字/单字符噪音太大，不计
      considered++;
      if (titleSquash.includes(t)) covered++;
      else if (noteSquash.includes(t)) covered += 0.5;
    }
    if (considered) score += Math.round((covered / considered) * 15);
  }

  // 描述命中整词
  if (qWhole.length >= 2 && noteSquash.includes(qWhole)) score += 8;

  // 意图一致：标题里也有同类词 → 说明这份资源和用户要找的是同一类东西
  const it = analyzed.intent || {};
  if (it.type && it.type !== 'general') {
    const rule = intent.TYPE_RULES.find((r) => r.type === it.type);
    if (rule && rule.test.test(title)) score += 4;
  }
  if (Array.isArray(it.quality) && it.quality.length) {
    const hitQ = it.quality.filter((v) => titleSquash.includes(v.replace(/\s+/g, ''))).length;
    if (hitQ) score += Math.min(8, hitQ * 4);
  }
  if (it.season) {
    const s = it.season.replace(/\s+/g, '');
    if (titleSquash.includes(s)) score += 6;
  }

  // 年份约束
  if (analyzed.year) {
    const y = analyzed.year;
    if (title.includes(y) || note.includes(y)) score += 10;
    else if (exactHit) score -= 15;
  }

  // 泛词堆砌：标题只有「合集/大全/福利」这类词，又没命中主词 → 大概率是大杂烩
  if (!exactHit && intent.GENERIC_WORDS.test(titleSquash)) score -= 8;

  // 模糊命中（只对拉丁词做，CJK 滑窗代价太高）
  if (!exactHit && qWhole.length >= 3) {
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
 * 无结果时的查询变体建议（给空状态里的「试试：」chips）。
 * @returns {string[]} 去重后的变体（不含原查询）
 */
function suggestVariants(raw) {
  const p = prepare(raw);
  const out = p.variants.map((v) => v.q);
  // 用户把整句粘贴进来时，取前半截往往立刻有结果
  const parts = p.upstream.split(' ').filter(Boolean);
  if (parts.length >= 3) {
    const head = parts.slice(0, Math.max(1, Math.ceil(parts.length / 2))).join(' ');
    if (head !== p.upstream && !out.includes(head)) out.push(head);
  }
  return Array.from(new Set(out)).slice(0, 3);
}

module.exports = {
  prepare,
  analyze,
  relevance,
  suggestVariants,
  editDistance,
  // 下面几个导出主要给 QA 脚本与以后的调试页面用
  normalize,
  stripFiller,
  toSimplified,
  stripTag,
  detectType,
  detectYear,
  detectSeason,
  detectQuality,
};
