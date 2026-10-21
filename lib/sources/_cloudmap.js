'use strict';

/**
 * 网盘类型归一化。
 *
 * 三个数据源对「网盘类型」的叫法各不相同：
 *   - zreso   : cloud_type 是英文 key（quark/baidu/…），另有 cloud_type_name 中文名
 *   - PanSou  : merged_by_type 的键是英文（quark/aliyun/baidu/uc/xunlei/123/115…）
 *   - j-so    : 只有图标 alt 中文名（"夸克网盘"/"UC网盘"/…）或图标文件名（quark.jpg）
 *
 * 前端只认 4 个 tab：all / quark / baidu / uc / xunlei。
 * 其余类型（阿里/123/115/天翼/移动/PikPak…）统一归到 'other'，在「全部」里可见，
 * 带上各自的显示名，不丢信息。
 */

// 把各种别名指向标准 key
const ALIAS = {
  quark: 'quark',
  '夸克': 'quark',
  '夸克网盘': 'quark',
  quarkpan: 'quark',

  baidu: 'baidu',
  bd: 'baidu',
  bdy: 'baidu',           // 混沌搜 disk_type
  '百度': 'baidu',
  '百度网盘': 'baidu',
  '百度云': 'baidu',

  uc: 'uc',
  'uc网盘': 'uc',
  'UC网盘': 'uc',
  ucpan: 'uc',

  xunlei: 'xunlei',
  thunder: 'xunlei',
  '迅雷': 'xunlei',
  '迅雷网盘': 'xunlei',
  '迅雷云盘': 'xunlei',

  aliyun: 'aliyun',
  aly: 'aliyun',          // 混沌搜 disk_type
  aliyundrive: 'aliyun',
  alipan: 'aliyun',
  ali: 'aliyun',
  '阿里': 'aliyun',
  '阿里云盘': 'aliyun',
  '阿里网盘': 'aliyun',

  '123': '123pan',
  '123pan': '123pan',
  '123网盘': '123pan',

  '115': '115',
  '115网盘': '115',

  tianyi: 'tianyi',
  '189': 'tianyi',
  cloud189: 'tianyi',
  '天翼': 'tianyi',
  '天翼云盘': 'tianyi',

  caiyun: 'caiyun',
  mobile: 'caiyun',       // PanSou / 混沌搜用 mobile 表示移动云盘
  '139': 'caiyun',
  '移动': 'caiyun',
  '移动云盘': 'caiyun',

  pikpak: 'pikpak',
  mypikpak: 'pikpak',

  guangyapan: 'guangyapan',
  gy: 'guangyapan',
  '光雅盘': 'guangyapan',

  magnet: 'magnet',
  ed2k: 'ed2k',
  '磁力': 'magnet',
  '磁力链接': 'magnet',
  '电驴': 'ed2k',
};

// 标准 key -> 中文显示名
const DISPLAY = {
  quark: '夸克网盘',
  baidu: '百度网盘',
  uc: 'UC网盘',
  xunlei: '迅雷云盘',
  aliyun: '阿里云盘',
  '123pan': '123网盘',
  '115': '115网盘',
  tianyi: '天翼云盘',
  caiyun: '移动云盘',
  pikpak: 'PikPak',
  guangyapan: '光雅盘',
  magnet: '磁力链接',
  ed2k: '电驴链接',
  other: '其他',
};

// 前端 tab 支持的类型
const TAB_KEYS = new Set(['quark', 'baidu', 'uc', 'xunlei']);

/** 图标文件名（对齐 public/static 里的 png） */
const ICON = {
  quark: 'quark',
  baidu: 'baidu',
  uc: 'uc',
  xunlei: 'xunlei',
};

/** 从链接直接推断网盘类型（最可靠，优先于源给的标签） */
function fromUrl(u) {
  const s = String(u || '').toLowerCase();
  if (!s) return '';
  if (s.includes('pan.quark.cn') || s.includes('quark.cn')) return 'quark';
  if (s.includes('pan.baidu.com') || s.includes('yun.baidu.com')) return 'baidu';
  if (s.includes('drive.uc.cn') || s.includes('fast.uc.cn') || s.includes('uc.cn')) return 'uc';
  if (s.includes('pan.xunlei.com')) return 'xunlei';
  if (s.includes('aliyundrive.com') || s.includes('alipan.com')) return 'aliyun';
  if (s.includes('123pan.com') || s.includes('123684.com') || s.includes('123865.com')) return '123pan';
  if (s.includes('115.com') || s.includes('115cdn.com')) return '115';
  if (s.includes('cloud.189.cn') || s.includes('189.cn')) return 'tianyi';
  if (s.includes('caiyun.139.com') || s.includes('yun.139.com')) return 'caiyun';
  if (s.includes('mypikpak.com') || s.includes('pikpak.com')) return 'pikpak';
  if (s.includes('guangyapan.com')) return 'guangyapan';
  if (s.startsWith('magnet:')) return 'magnet';
  if (s.startsWith('ed2k:')) return 'ed2k';
  return '';
}

/**
 * 把任意形态的类型标识归一化成标准 key。
 * @param {string} raw 英文 key / 中文名 / 图标文件名
 * @param {string} [urlForHint] 兜底用的链接
 */
function normalize(raw, urlForHint) {
  const hinted = fromUrl(urlForHint);
  if (hinted) return hinted;

  let k = String(raw || '').trim().toLowerCase();
  if (!k) return '';
  // "quark.jpg" / "/ing/quark.jpg" -> "quark"
  k = k.replace(/^.*\//, '').replace(/\.(jpg|jpeg|png|ico|gif|webp)$/i, '');
  // "夸克网盘链接有效" 这种句子，取最大匹配
  if (ALIAS[k]) return ALIAS[k];
  for (const alias of Object.keys(ALIAS)) {
    if (k.includes(alias.toLowerCase())) return ALIAS[alias];
  }
  return 'other';
}

/** 标准 key -> 中文显示名 */
function displayName(key) {
  return DISPLAY[key] || DISPLAY.other;
}

/** 标准 key -> 图标名（无图标返回空，前端走默认样式） */
function iconName(key) {
  return ICON[key] || '';
}

/** 是否被某个 tab 过滤条件接纳 */
function matchesTab(key, tab) {
  if (!tab || tab === 'all') return true;
  return key === tab;
}

/** 该 key 是否是前端有独立 tab 的类型 */
function hasTab(key) {
  return TAB_KEYS.has(key);
}

module.exports = { normalize, displayName, iconName, matchesTab, hasTab, fromUrl, DISPLAY, TAB_KEYS };
