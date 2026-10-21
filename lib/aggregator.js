'use strict';

/**
 * 聚合层。
 *
 * 职责：
 *   1. 并发问所有启用的数据源（各自独立超时，互不拖累）
 *   2. 合并 + 去重（按归一化后的网盘链接 URL）
 *   3. 统一排序、统一打上 provider 归属
 *   4. 记录每个源的耗时/条数，供 /api/status 排查
 *
 * 设计原则：**部分成功优于全失败**。哪怕只有一个源活着，也要把结果给用户，
 * 并把挂掉的源如实告诉前端（降级但不装死）。
 */

const config = require('../config');
const sources = require('./sources');
const cloudmap = require('./sources/_cloudmap');
const queryUtil = require('./query');
const health = require('./sourceHealth');
const { TtlCache } = require('./cache');

// 聚合结果缓存：短时间内重复搜索直接命中，不给任何上游添压力
const aggCache = new TtlCache({
  ttlMs: Number(process.env.AGG_CACHE_TTL_MS) || 3 * 60 * 1000,
  max: 200,
});

// 真实查询热词表：记录「用户搜过且确实返回了结果」的关键词，
// 供 /api/suggest 动态联想——只推荐验证过有结果的词，不做空洞联想。
const HOT_QUERY_MAX = 200;
const hotQueries = new Map(); // q -> { hits, at }

function recordHotQuery(q, count) {
  if (!q || !count) return;
  const k = q.trim().toLowerCase();
  if (!k || k.length > 60) return;
  const prev = hotQueries.get(k);
  hotQueries.set(k, { hits: (prev ? prev.hits : 0) + 1, count, at: Date.now() });
  if (hotQueries.size > HOT_QUERY_MAX) {
    hotQueries.delete(hotQueries.keys().next().value);
  }
}

/** 动态热词（按命中次数排序），给 suggest 用 */
function getHotQueries(limit) {
  return Array.from(hotQueries.entries())
    .sort((a, b) => b[1].hits - a[1].hits || b[1].at - a[1].at)
    .slice(0, limit || 30)
    .map(([q]) => q);
}

const stats = {
  totalCalls: 0,
  cacheHit: 0,
  partialServes: 0,
  allFailed: 0,
  lastRun: null,
};

/**
 * 链接归一化，作为去重键。
 * 同一条夸克链接可能被不同源用不同形式给出（带 ?public=1 / 带尾斜杠 /
 * http vs https），这里统一到"域名+路径"级别再比。
 */
function dedupeKey(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  if (/^(magnet|ed2k):/i.test(s)) return s.toLowerCase();
  try {
    const u = new URL(s);
    let host = u.hostname.toLowerCase().replace(/^www\./, '');
    let path = u.pathname.replace(/\/+$/, '');
    // 夸克/UC 这类分享链接路径就是唯一标识，query 大多是跟踪参数
    return host + path;
  } catch {
    return s.toLowerCase();
  }
}

/** 结果质量打分，用于同一条链接多个源都命中时决定保留哪条 */
function score(item) {
  let s = 0;
  if (item.raw_url) s += 40; // 拿到真实直链的最值钱
  if (item.title) s += Math.min(item.title.length, 40) / 2;
  if (item.note) s += 10;
  if (item.date) s += 6;
  if (item.status === 'valid') s += 12;
  if (item.status === 'fast_acquire') s += 8;
  if (item.status === 'invalid') s -= 20;
  if (item.cloud_type && item.cloud_type !== 'other') s += 4;
  return s;
}

/**
 * 清洗标题（保守版）。
 *
 * 上游源的标题里常把网盘名 + 复制粘贴残留拼在结尾，例如：
 *   "美国电影《狂飙对决》（2025）… 豆瓣5.3夸克网盘["
 *   "英国电影《大侠无敌》（2023）夸克网盘"
 *   "周杰伦无损音乐合集【迅雷云盘】"
 *
 * 设计原则：**只清「明确可识别」的噪音，绝不碰括号类字符的内容**。
 * 早期版本试图自动配对剥离括号，结果把 "（2023）" 的闭括号或 "《书名》"
 * 的右书名号当成尾标点吃掉，标题被毁。所以现在改成：
 *   1) 先把尾部**成对的网盘名括号块**整体去掉（括号名成对出现才动）；
 *   2) 再去掉尾部裸围的网盘名；
 *   3) 再去掉尾部孤立的开括号 / 纯标点 / emoji。
 * 全程不删除任何闭括号、右书名号。
 */
const CLOUD_ALT = '夸克|百度|UC|迅雷|阿里云盘|阿里|天翼|123|115|移动|彩云|PikPak';

// 「网盘」二字的各种写法：网盘 / 云盘 / 盘 / 空
const PAN_SUFFIX = '(?:网盘|云盘|网|盘)?';

// 尾部「网盘名」的四种写法：裸写 / 圆括号 / 方括号 / 书名号
const TAIL_CLOUD_PATTERNS = [
  new RegExp('[\\s·\\-—_|]*(?:' + CLOUD_ALT + ')\\s*' + PAN_SUFFIX + '\\s*$', 'i'),
  new RegExp('[\\s·\\-—_|]*[（(]\\s*(?:' + CLOUD_ALT + ')\\s*' + PAN_SUFFIX + '\\s*[）)]\\s*$', 'i'),
  new RegExp('[\\s·\\-—_|]*[【\\[]\\s*(?:' + CLOUD_ALT + ')\\s*' + PAN_SUFFIX + '\\s*[】\\]]\\s*$', 'i'),
  new RegExp('[\\s·\\-—_|]*《\\s*(?:' + CLOUD_ALT + ')\\s*' + PAN_SUFFIX + '\\s*》\\s*$', 'i'),
];

// 尾部孤立开括号（上游截断留下的半个括号）
const TAIL_LONE_OPEN = /[\s·\-—_|]*[（(【\[]\s*$/u;
// 尾部 emoji / 装饰符号
const TAIL_EMOJI =
  /[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{20E3}\u{200D}\u2500-\u27BF]+$/gu;
// 尾部纯标点（不含任何右括号 / 右书名号 / 右方括号）
const TAIL_PUNCT = /[\s·•\-—_|,，.。;；:：!！?？~～*＊#＃]+$/u;

function cleanTitle(title) {
  const original = String(title || '').trim();
  if (!original) return '';

  let t = original;
  let guard = 0;
  let changed = true;

  while (changed && t.length > 3 && ++guard < 10) {
    const before = t;

    for (const re of TAIL_CLOUD_PATTERNS) t = t.replace(re, '');
    t = t.replace(TAIL_LONE_OPEN, '');
    t = t.replace(TAIL_EMOJI, '');
    t = t.replace(TAIL_PUNCT, '');
    t = t.trim();

    changed = t !== before;
  }

  // 剥完后不能出现"闭括号多于开括号"——那说明切掉了左半，属于切坏。
  // 开括号多于闭括号只是尾巴上留了半个括号，无害。
  const imbalance = (s, open, close) => {
    let n = 0;
    for (const ch of s) {
      if (ch === open) n++;
      else if (ch === close) n--;
    }
    return n;
  };
  const noDanglingClose =
    imbalance(t, '（', '）') >= 0 &&
    imbalance(t, '(', ')') >= 0 &&
    imbalance(t, '【', '】') >= 0 &&
    imbalance(t, '[', ']') >= 0 &&
    imbalance(t, '《', '》') >= 0;

  if (!noDanglingClose || t.length < 3) return original;
  return t;
}

/** 把两个源的同一资源合并：保留更优的那条，但把来源都记下来 */
function mergeInto(kept, incoming) {
  if (score(incoming) > score(kept)) {
    // incoming 更优 → 让 incoming 继承已有的来源列表
    const providers = kept._providers || [kept.provider];
    incoming._providers = providers.includes(incoming.provider)
      ? providers
      : [...providers, incoming.provider];
    if (!incoming.note && kept.note) incoming.note = kept.note;
    if (!incoming.date && kept.date) incoming.date = kept.date;
    if (!incoming.raw_url && kept.raw_url) {
      incoming.raw_url = kept.raw_url;
      incoming.first_url = kept.first_url;
    }
    return incoming;
  }
  kept._providers = kept._providers || [kept.provider];
  if (!kept._providers.includes(incoming.provider)) kept._providers.push(incoming.provider);
  if (!kept.note && incoming.note) kept.note = incoming.note;
  if (!kept.raw_url && incoming.raw_url) {
    kept.raw_url = incoming.raw_url;
    kept.first_url = incoming.first_url;
  }
  if (!kept.status && incoming.status) kept.status = incoming.status;
  return kept;
}

/**
 * 排序：相关性优先，日期新鲜度其次，质量分兜底。
 *
 * 旧实现只看日期，标题根本不含关键词的条目会凭「日期新」霸屏。
 * 现在融合三路信号：
 *   relevance  —— 与查询词的匹配度（lib/query.js，0~100）
 *   日期新鲜度 —— 保留 sort=latest/oldest 语义，但折算成小权重加成
 *   质量分     —— 直链/字段完整度（score()），同样小权重
 *
 * relevance 权重 ×3，保证"标题含关键词"永远赢过"日期新但无关"。
 */
function dateBonus(item, sort) {
  const d = String(item.date || item.datetime || '');
  if (!/^\d{4}-\d{2}-\d{2}/.test(d)) return 0;
  const ageDays = (Date.now() - new Date(d.slice(0, 10)).getTime()) / 86400000;
  if (!Number.isFinite(ageDays) || ageDays < 0) return 0;
  let b;
  if (ageDays <= 30) b = 12;
  else if (ageDays <= 180) b = 7;
  else if (ageDays <= 730) b = 3;
  else b = 1;
  return sort === 'oldest' ? 12 - b : b;
}

function finalRank(item, analyzed, sort) {
  return (item._rel || 0) * 3 + dateBonus(item, sort) + Math.min(score(item), 60) * 0.25;
}

function sortResults(items, sort, analyzed) {
  return items.sort((a, b) => {
    const ra = finalRank(a, analyzed, sort);
    const rb = finalRank(b, analyzed, sort);
    if (ra !== rb) return rb - ra;
    // 完全同分时退回原语义：日期倒/正序
    const da = a.date || a.datetime || '';
    const db = b.date || b.datetime || '';
    const dir = sort === 'oldest' ? 1 : -1;
    if (da && db && da !== db) return da < db ? -1 * dir : 1 * dir;
    if (da && !db) return -1;
    if (!da && db) return 1;
    return score(b) - score(a);
  });
}

/**
 * 并发查询所有启用源并合并。
 *
 * 「两阶段」是这里的核心设计：pansou 是夸克资源的主要来源，但它是聚合器，
 * 要并发查上百个 TG 频道，实测 8~40 秒不等。用统一的 9 秒硬超时砍它，
 * 结果就是「大部分词搜不到夸克」—— 上游明明有 15 条，全被砍没了。
 *
 * 所以拆成两次调用：
 *   fast 阶段：only=['hunhepan','zreso'] + timeoutMs≈3500，先把能立刻拿到的给用户
 *   full 阶段：全部源 + pansou 单独放宽到 25s，到了再合并覆盖
 * 用户 3 秒看到首批结果，10 秒内看到夸克补齐，而不是干等 20 秒。
 *
 * @param {string} query
 * @param {object} opts { sort, cloud, only: string[], timeoutMs: number }
 * @returns {Promise<{items:Array, providers:Array, source:string, reason?:string}>}
 */
async function search(query, { sort = 'latest', cloud = 'all', only = null, timeoutMs = null } = {}) {
  const q = String(query || '').trim();
  if (!q) return { items: [], providers: [], source: 'empty' };

  const picked = Array.isArray(only) && only.length ? only : null;
  const ids = (picked || sources.enabledIds()).filter((id) => Boolean(sources.get(id)));
  if (!ids.length) {
    return { items: [], providers: [], source: 'no-source', reason: 'no-source-enabled' };
  }

  // 缓存键必须带阶段标记，否则 fast 的残缺结果会把 full 的完整结果顶掉
  const scope = picked ? picked.join('+') : 'all';
  const cacheKey = `${q}||${sort}||${cloud}||${scope}`;
  const cached = aggCache.get(cacheKey);
  if (cached) {
    stats.cacheHit++;
    return { ...cached, fromCache: true };
  }

  /**
   * 云盘筛选优先吃「全量缓存」。
   *
   * 为什么要有这一步（实测数据）：
   *   全量搜「甄嬛传」8.1s 出 60 条，其中夸克一大把；
   *   但加 cloud=quark 重新问上游，pansou 的 cloud_types 过滤反而更慢，
   *   20s 超时后回 0 条 —— 用户点了「夸克」筛选，等 20 秒拿到"没有结果"，
   *   比不筛还糟，而且和刚才明明看到过的夸克资源自相矛盾。
   *
   * 只要全量结果还在缓存里，就地过滤就够了：0ms、条数正确、和列表里看到的一致。
   * 缓存过期才会真的按 cloud 去打上游（那时至少语义正确）。
   */
  if (cloud && cloud !== 'all' && !picked) {
    const full = aggCache.get(`${q}||${sort}||all||all`);
    if (full && Array.isArray(full.items)) {
      stats.cacheHit++;
      stats.localFilter = (stats.localFilter || 0) + 1;
      const filtered = full.items.filter((it) => cloudmap.matchesTab(it.cloud_type, cloud));
      return { ...full, items: filtered, deduped: full.deduped, fromCache: true, filteredLocally: true };
    }
  }

  stats.totalCalls++;
  const t0 = Date.now();

  // 每个源独立跑，谁挂都不影响别人。
  // 冷却中的源直接跳过（0ms），不再让一个死源把整次搜索拖到 9 秒。
  const baseMs = Number(timeoutMs) || Number(config.sources && config.sources.perSourceTimeoutMs) || 9000;
  const perSourceMs = (config.sources && config.sources.sourceTimeoutMs) || {};

  /**
   * 硬超时上限。
   * - 没传 timeoutMs：按源各自的覆盖值（pansou 25s），没有就 baseMs。
   * - 传了 timeoutMs（两阶段搜索的第一阶段）：它是**全员上限**，
   *   所以 pansou 的开发 25s 覆盖也必须被压到 6s —— 否则第一阶段白等 25s，
   *   比不分阶段还慢（这个坑踩过）。
   */
  const capMs = Number(timeoutMs) ? Number(timeoutMs) : 0;
  const hardMsFor = (id) => {
    const own = Number(perSourceMs[id]) || baseMs;
    return capMs ? Math.min(own, capMs) : own;
  };

  const runOne = async (id) => {
    const impl = sources.get(id);
    if (!impl) return { id, items: [], ms: 0, ok: false, error: 'unknown-source' };

    if (!health.isAvailable(id)) {
      return { id, items: [], ms: 0, ok: false, skipped: true, error: 'cooling' };
    }

    const start = Date.now();
    const hardMs = hardMsFor(id);

    // 真·兜底超时。
    // 各源自己的超时是「它乐意等多久」——pansou 内部给到 20s。
    // config 里的 perSourceTimeoutMs 此前从未落实到代码，聚合器只是一句裸 await，
    // 于是冷查询能被单个慢源拖到 20 秒。这里用 Promise.race 硬砍。
    // 被砍掉的源仍在后台跑完并写入它自己的缓存，下次搜索就是命中。
    const task = impl
      .search(q, { sort, cloud })
      .then((r) => ({ settledOk: true, r }))
      .catch((err) => ({ settledOk: false, err }));

    let timer = null;
    const guard = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), hardMs);
    });

    let raced;
    try {
      raced = await Promise.race([task, guard]);
    } finally {
      if (timer) clearTimeout(timer);
    }

    const ms = Date.now() - start;

    if (raced === null) {
      // ⚠️ 这里**不记健康失败**。
      // 硬超时只是"我们选择不等了"，不代表源坏了 —— 被砍掉的那个请求还在
      // 后台跑，跑完照样写进它自己的缓存。若在这里记一笔失败，两阶段搜索的
      // 第一阶段每次都砍在 6 秒，连续三次就能把唯一可用的 pansou 送进 10 分钟
      // 冷却，整个站瞬间"什么都搜不到"。真正坏掉的源会通过它自己的内部超时
      // 或报错落到下面的分支，照样能被熔断识别。
      return { id, items: [], ms, ok: false, error: 'timeout', timedOut: true };
    }

    if (!raced.settledOk) {
      health.record(id, { ok: false, ms, count: 0, error: raced.err.message });
      return { id, items: [], ms, ok: false, error: raced.err.message };
    }

    const r = raced.r;
    const items = Array.isArray(r) ? r : (r && r.items) || [];

    // 源自己声明「这次没拿到真实数据」（如 zreso 被风控后只给了兜底假数据），
    // 也算失败 —— 否则它会永远占着位置却不贡献任何真实资源。
    const noData = !Array.isArray(r) && r && r.unavailable === true;
    const verdict = health.judge({ ms, items: items.length, error: noData ? 'no-data' : null });
    health.record(id, { ok: verdict.ok, ms, count: items.length, error: verdict.error });

    return { id, items, ms, ok: true, degraded: !verdict.ok };
  };

  const settled = await Promise.all(ids.map(runOne));

  // 合并去重
  const bucket = new Map();
  const providers = [];
  let totalRaw = 0;
  const cap = (config.sources && config.sources.maxPerSource) || 120;

  for (const r of settled) {
    // 单源截断：防止某个源用几百条把其他源挤没
    const limited = r.items.length > cap ? r.items.slice(0, cap) : r.items;
    providers.push({
      id: r.id,
      count: limited.length,
      rawCount: r.items.length,
      ms: r.ms,
      ok: r.ok,
      error: r.error || null,
      // 「是我们不等了」和「它真的没数据」是两件事，必须能区分：
      // 前者多半等几秒再来就有，后者换词才有用。前端要按这个分文案。
      timedOut: Boolean(r.timedOut),
      skipped: Boolean(r.skipped),
      degraded: Boolean(r.degraded),
    });
    totalRaw += limited.length;

    for (const it of limited) {
      const key = dedupeKey(it.raw_url || it.first_url);
      if (!key) continue;
      // 标题 / 描述尾部的噪音（网盘名、emoji）在入桶前统一清掉
      it.title = cleanTitle(it.title);
      if (it.note) it.note = cleanTitle(it.note);
      const prev = bucket.get(key);
      bucket.set(key, prev ? mergeInto(prev, it) : it);
    }
  }

  let items = Array.from(bucket.values());

  // 类型过滤（'all' 直接放行；其余按标准 key 匹配）
  if (cloud && cloud !== 'all') {
    items = items.filter((it) => cloudmap.matchesTab(it.cloud_type, cloud));
  }

  // 相关性打分：标题/描述与查询词的匹配度，之后参与排序
  const analyzed = queryUtil.analyze(q);
  for (const it of items) {
    it._rel = queryUtil.relevance(it, analyzed);
  }

  sortResults(items, sort, analyzed);

  // 同标题折叠：不同分享链接常常指向同一个资源，标题一模一样。
  // 保留质量最高的一条，把重复条数挂在 _dupes 上（前端可展示 "另有 N 条"）。
  //
  // 阈值为什么是 5：标题**完全一致**本身就意味着资源名一致，折叠几乎不会误伤
  // （实测 4 字的「考研合集」、6 字的「25考研资料」各自唯一，互不冲突）。
  // 阈值设太高反而会让真重复漏网 —— 比如「、22考研数学」只有 7 字，
  // 两条不同分享链接指向同一资源，却因为 <8 被判为"太短不能折叠"而并排出现。
  // 仍然要防的是**信息量过低的标题**：纯数字（"2024"）、纯标点、或只有一两个字
  // 的泛称（"资料"、"合集"）——这些可能被不同人用来命名完全不同的东西，折叠会骗人。
  {
    const isMeaningfulTitle = (t) => {
      if (t.length < 4) return false;          // 太短，无法判断，不动
      if (!/[\p{L}\p{Script=Han}]/u.test(t)) return false;  // 无任何文字（纯数字/纯符号）
      const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
      const latin = (t.match(/[a-z]/g) || []).length;
      return cjk + latin >= 4;                 // 至少 4 个实义字符
    };
    const byTitle = new Map();
    const collapsed = [];
    for (const it of items) {
      const t = String(it.title || '').trim().toLowerCase();
      if (!isMeaningfulTitle(t)) {
        collapsed.push(it);
        continue;
      }
      const prev = byTitle.get(t);
      if (!prev) {
        byTitle.set(t, it);
        it._dupes = 0;
        collapsed.push(it);
      } else {
        prev._dupes = (prev._dupes || 0) + 1;
        // 重复条目也可能带来更优的链接 / 状态，补进去
        if (!prev.raw_url && it.raw_url) {
          prev.raw_url = it.raw_url;
          prev.first_url = it.first_url;
        }
        if (!prev.status && it.status) prev.status = it.status;
        if (!prev.note && it.note) prev.note = it.note;
      }
    }
    items = collapsed;
  }

  const capTotal = (config.sources && config.sources.maxTotal) || 300;
  if (items.length > capTotal) items = items.slice(0, capTotal);

  const alive = providers.filter((p) => p.ok && p.count > 0).length;
  const failed = providers.filter((p) => !p.ok || p.count === 0);

  const result = {
    items,
    providers,
    totalRaw,
    deduped: totalRaw - items.length,
    elapsedMs: Date.now() - t0,
    // 全部源都没结果 → 交给上层走本地降级数据；同时给出查询变体建议
    source: alive > 0 ? 'aggregate' : 'aggregate-empty',
    reason: alive === 0 ? 'all-sources-empty' : undefined,
    degraded: failed.length > 0 ? failed.map((f) => f.id) : undefined,
    suggest: alive === 0 ? queryUtil.suggestVariants(q) : undefined,
  };

  if (alive > 0 && failed.length > 0) stats.partialServes++;
  if (alive === 0) stats.allFailed++;
  if (items.length) recordHotQuery(q, items.length);
  stats.lastRun = {
    query: q,
    providers: providers.map((p) => ({ id: p.id, count: p.count, ms: p.ms, ok: p.ok })),
    final: items.length,
    elapsedMs: result.elapsedMs,
    at: new Date().toISOString(),
  };

  // 只在有结果时缓存，避免把"全员失败"也缓存住导致长时间无法恢复
  if (items.length) aggCache.set(cacheKey, result);

  return result;
}

function getStats() {
  return { ...stats, cacheSize: aggCache.size, sources: sources.stats() };
}

module.exports = { search, getStats, dedupeKey, score, cleanTitle, getHotQueries, sortResults };
