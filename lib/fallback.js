'use strict';

/**
 * 本地降级数据。
 * 当上游不可用（超时 / 403 / 人机验证 / 限速 / 熔断）时使用，
 * 保证前端界面永远有东西可渲染，不会白屏。
 */

const MOCK = {
  考研: [
    { title: '25考研政治资源合辑（含肖秀荣/徐涛/腿姐全套课程）', cloud: 'quark', days: 0, status: 'fast_acquire', tags: ['考研', '政治', '网课'] },
    { title: '「《新东方考研英语词汇词根+联想记忆法》乱序版配有录音[pdf]」', cloud: 'quark', days: 0, status: 'valid', tags: ['考研', '英语', '词汇'] },
    { title: '2025考研数学张宇强化班+1000题讲解（完整版）', cloud: 'baidu', days: 1, status: 'valid', tags: ['考研', '数学', '张宇'] },
    { title: '25考研专业课全套资料【实时动态更新·无水印】', cloud: 'quark', days: 1, status: 'fast_acquire', tags: ['考研', '专业课'] },
    { title: '考研英语真题 1998-2024 解析版合集（黄皮书）', cloud: 'baidu', days: 3, status: 'valid', tags: ['考研', '英语', '真题'] },
    { title: '腿姐技巧班·冲刺背诵手册 PDF 合辑', cloud: 'uc', days: 5, status: 'valid', tags: ['考研', '政治'] },
    { title: '徐涛核心考案强化班笔记整理（手写扫描版）', cloud: 'xunlei', days: 8, status: 'invalid', tags: ['考研', '政治', '笔记'] },
    { title: '考研复试英语口语模板 + 常考问题 200 问', cloud: 'quark', days: 12, status: 'valid', tags: ['考研', '复试', '口语'] },
  ],
  电影: [
    { title: '【4K HDR】2025 年度高分电影合集 蓝光原盘收藏版', cloud: 'quark', days: 0, status: 'fast_acquire', tags: ['电影', '4K', '合集'] },
    { title: '奥本海默 Oppenheimer 2023 国英双语中字 2160p', cloud: 'quark', days: 2, status: 'valid', tags: ['电影', '传记'] },
    { title: '沙丘2 Dune Part Two 杜比视界 内封中字', cloud: 'baidu', days: 3, status: 'valid', tags: ['电影', '科幻'] },
    { title: '宫崎骏动画电影全集 24 部 1080P 国日双语', cloud: 'quark', days: 7, status: 'fast_acquire', tags: ['电影', '动画', '合集'] },
    { title: '豆瓣 Top250 全部收录 蓝光收藏版', cloud: 'uc', days: 15, status: 'valid', tags: ['电影', '合集', '经典'] },
  ],
  音乐: [
    { title: '周杰伦全专辑无损 FLAC 合集（2000-2024）', cloud: 'quark', days: 0, status: 'fast_acquire', tags: ['音乐', '无损', '华语'] },
    { title: '2025 华语新歌榜 TOP500 高音质合集', cloud: 'quark', days: 1, status: 'valid', tags: ['音乐', '新歌'] },
    { title: '欧美经典老歌 1000 首 320K 车载音乐包', cloud: 'baidu', days: 4, status: 'valid', tags: ['音乐', '车载', '欧美'] },
    { title: '久石让作品全集 FLAC 无损（含交响乐版）', cloud: 'xunlei', days: 9, status: 'valid', tags: ['音乐', '纯音乐'] },
  ],
  电影天堂: [
    { title: '电影天堂资源索引 2025 年度合集', cloud: 'quark', days: 0, status: 'fast_acquire', tags: ['影视', '合集'] },
    { title: '美剧全集打包 更新至最新季（双语字幕）', cloud: 'baidu', days: 2, status: 'valid', tags: ['美剧', '合集'] },
    { title: '纪录片 BBC 精选 100 部 1080P 中字', cloud: 'quark', days: 6, status: 'valid', tags: ['纪录片', 'BBC'] },
  ],
  ps: [
    { title: 'Photoshop 2025 v26 直装版（含神经滤镜）', cloud: 'quark', days: 0, status: 'fast_acquire', tags: ['软件', 'Adobe'] },
    { title: 'Adobe 全家桶 2025 一键安装包 Win/Mac', cloud: 'baidu', days: 1, status: 'valid', tags: ['软件', 'Adobe', '设计'] },
    { title: 'PS 设计素材合集 笔刷/插件/预设 50G', cloud: 'quark', days: 5, status: 'valid', tags: ['素材', '设计'] },
  ],
};

// 通用兜底：任何关键词都有结果
const GENERIC = [
  { title: '{q} 全套资源合集（持续更新中）', cloud: 'quark', days: 0, status: 'fast_acquire', tags: ['合集'] },
  { title: '{q} 高清完整版打包下载', cloud: 'baidu', days: 1, status: 'valid', tags: ['下载'] },
  { title: '{q} 精选资料整理 2025 最新版', cloud: 'quark', days: 2, status: 'valid', tags: ['最新'] },
  { title: '【合集】{q} 相关资源大礼包', cloud: 'uc', days: 4, status: 'valid', tags: ['合集', '礼包'] },
  { title: '{q} 电子书 + 配套资料（PDF/EPUB）', cloud: 'xunlei', days: 7, status: 'valid', tags: ['电子书'] },
  { title: '{q} 教程视频合集 从入门到精通', cloud: 'quark', days: 11, status: 'invalid', tags: ['教程', '视频'] },
];

const CLOUD_META = {
  quark: { name: '夸克网盘', icon: '/static/quark.png' },
  baidu: { name: '百度网盘', icon: '/static/baidu.png' },
  uc: { name: 'UC网盘', icon: '/static/uc.png' },
  xunlei: { name: '迅雷云盘', icon: '/static/xunlei.png' },
};

function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function dateStr(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 生成降级结果集。
 * @param {string} query 关键词
 * @param {string} cloud 网盘筛选：all|quark|baidu|uc|xunlei
 * @returns {Array} 统一格式的结果数组
 */
function buildFallback(query, cloud = 'all') {
  const q = String(query || '').trim();
  let seed = MOCK[q];
  if (!seed) {
    // 模糊匹配：关键词包含某个预置 key
    const key = Object.keys(MOCK).find((k) => q.includes(k) || k.includes(q));
    seed = key ? MOCK[key] : null;
  }
  const rows = seed
    ? seed
    : GENERIC.map((r) => ({ ...r, title: r.title.replace(/\{q\}/g, q || '热门') }));

  let results = rows.map((r, i) => {
    const meta = CLOUD_META[r.cloud] || CLOUD_META.quark;
    return {
      title: r.title,
      date: dateStr(r.days),
      datetime: dateStr(r.days) + 'T00:00:00Z',
      tags: r.tags || null,
      cloud_type: r.cloud,
      cloud_type_name: meta.name,
      status: r.status,
      url_hash: hash32(q + i + r.title),
      first_url: '',
      _fallback: true,
    };
  });

  if (cloud && cloud !== 'all') {
    results = results.filter((r) => r.cloud_type === cloud);
  }

  return results;
}

module.exports = { buildFallback, CLOUD_META };
