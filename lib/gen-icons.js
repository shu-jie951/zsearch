'use strict';
/**
 * 生成四个网盘来源的占位图标（PNG）。
 * 这些是简化标识，仅用于界面来源标注；正式上线请替换为各平台授权素材。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function makePng(size, draw) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = draw(x, y, size);
      raw[p++] = r; raw[p++] = g; raw[p++] = b; raw[p++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const R = (size) => size * 0.22; // 圆角半径

function roundedAlpha(x, y, size) {
  const r = R(size);
  const cx = Math.min(Math.max(x, r), size - r);
  const cy = Math.min(Math.max(y, r), size - r);
  const dx = x - cx, dy = y - cy;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d <= r) return 1;
  if (d <= r + 1) return Math.max(0, r + 1 - d);
  return 0;
}

const ICONS = {
  // 夸克 · 蓝色
  'quark.png': { bg: [24, 116, 255], glyph: 'K' },
  // UC · 橙红
  'uc.png': { bg: [255, 106, 0], glyph: 'U' },
  // 迅雷 · 青蓝
  'xunlei.png': { bg: [0, 168, 224], glyph: 'X' },
  // 百度 · 蓝
  'baidu.ico': { bg: [41, 98, 255], glyph: 'B' },
};

const size = 64;
const outDir = path.join(__dirname, '..', 'public', 'static');

for (const [file, cfg] of Object.entries(ICONS)) {
  const [br, bg_, bb] = cfg.bg;
  const png = makePng(size, (x, y, s) => {
    const a = roundedAlpha(x, y, s);
    if (a <= 0) return [0, 0, 0, 0];
    // 中心白色圆点，作为简约来源标识
    const cx = s / 2, cy = s / 2;
    const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
    if (d < s * 0.17) return [255, 255, 255, Math.round(255 * a)];
    if (d < s * 0.17 + 1.2) {
      const t = (s * 0.17 + 1.2 - d) / 1.2;
      return [255, 255, 255, Math.round(255 * a * t) + Math.round(((br + bg_ + bb) / 3) * a * (1 - t))];
    }
    return [br, bg_, bb, Math.round(255 * a)];
  });
  fs.writeFileSync(path.join(outDir, file.replace('.ico', '.png')), png);
  console.log('wrote', file.replace('.ico', '.png'));
}
