'use strict';

/**
 * 构建期工具：生成「拼音 → 汉字」字表（lib/data/pinyin.js）。
 *
 * 为什么要生成而不是运行时依赖 pinyin-pro：
 *   这个项目刻意保持「只有 express 一个运行时依赖」。生成一份静态表，
 *   运行时零依赖、零启动开销，也不怕上游库改 API。
 *
 * 用法：node _build_pinyin.js
 * 产物：lib/data/pinyin.js（约 60KB，按音节分组：'qing': '庆清轻情...'）
 *
 * 表里只收 CJK 基本区（U+4E00–U+9FFF）。扩展 B 区的生僻字在资源名里
 * 基本不出现，收进来会让文件大 3 倍。
 */

const fs = require('fs');
const path = require('path');

let pinyin;
try {
  ({ pinyin } = require('pinyin-pro'));
} catch (err) {
  console.error('缺少构建依赖 pinyin-pro。先执行：');
  console.error('  npm i pinyin-pro --prefix C:/Users/<you>/.workbuddy/binaries/node/workspace');
  process.exit(1);
}

const START = 0x4e00;
const END = 0x9fff;

const groups = new Map(); // syllable -> chars[]
let total = 0;

for (let cp = START; cp <= END; cp++) {
  const ch = String.fromCodePoint(cp);
  let py = '';
  try {
    py = pinyin(ch, { toneType: 'none', type: 'string' });
  } catch {
    py = '';
  }
  // 只保留纯字母音节（多音字/非汉字会返回原字符或带空格）
  if (!py || !/^[a-z]+$/.test(py)) continue;
  if (!groups.has(py)) groups.set(py, []);
  groups.get(py).push(ch);
  total++;
}

// 按音节字母序输出，方便 diff 与人工抽查
const keys = Array.from(groups.keys()).sort();

const lines = [];
lines.push("'use strict';");
lines.push('');
lines.push('/**');
lines.push(' * 拼音 → 汉字表（构建产物，勿手改）。');
lines.push(' *');
lines.push(' * 生成脚本：_build_pinyin.js（依赖 pinyin-pro，仅构建期使用）。');
lines.push(' * 用途：把**结果标题**转成拼音/首字母，从而支持「qyn」「qingyunian」这类');
lines.push(' * 拼音输入命中中文标题 —— 用户打拼音、打首字母、打错一个音节都能搜到。');
lines.push(' *');
lines.push(' * 只收 CJK 基本区（U+4E00–U+9FFF）。多音字取最常见读音。');
lines.push(' * 共 ' + total + ' 字 / ' + keys.length + ' 个音节。');
lines.push(' */');
lines.push('');
lines.push('module.exports = {');
for (const k of keys) {
  lines.push('  ' + k + ": '" + groups.get(k).join('') + "',");
}
lines.push('};');
lines.push('');

const out = path.join(__dirname, 'lib', 'data', 'pinyin.js');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, lines.join('\n'), 'utf8');

const kb = (fs.statSync(out).size / 1024).toFixed(1);
console.log('✓ 生成 ' + path.relative(__dirname, out) + '  ' + total + ' 字 / ' + keys.length + ' 音节 / ' + kb + 'KB');
