'use strict';

/**
 * 给 HTML 里的 css/js 引用自动加上内容哈希版本号。
 *
 *   /static/css/base.css   ->   /static/css/base.css?v=a1b2c3d4
 *
 * 为什么需要：
 *   浏览器会强缓存静态资源。只在服务端改 maxAge 是治不住的 —— 用户浏览器里
 *   那份旧缓存还在有效期内，就不会来问服务端，页面永远显示旧界面。
 *   把内容哈希写进 URL，文件一变 URL 就变，浏览器**必然**重新拉取。
 *
 * 用法：
 *   node _stamp.js          # 给所有 HTML 打版本号
 *   node _stamp.js --check  # 只检查是否有过期版本号（CI/自检用），不写文件
 *
 * 幂等：重复运行只会更新哈希，不会叠加 ?v= 参数。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PUBLIC_DIR = path.join(__dirname, 'public');
const CHECK_ONLY = process.argv.includes('--check');

// 匹配 href="/static/..." / src="/static/..."，可选已有 ?v=xxx
// 注意 oldVer 用 [^"]* 而不是 [a-f0-9]+：手写过占位版本号（如 ?v=wb1）时
// 若限定十六进制就匹配不上，整条引用会被**跳过**，表现为"跑了 stamp 却没更新"。
const ATTR_RE = /(\b(?:href|src)\s*=\s*")(\/static\/[^"?]+)(\?v=[^"]*)?(")/g;

function hashFile(abs) {
  if (!fs.existsSync(abs)) return null;
  const buf = fs.readFileSync(abs);
  return crypto.createHash('sha1').update(buf).digest('hex').slice(0, 8);
}

const htmlFiles = fs
  .readdirSync(PUBLIC_DIR)
  .filter((f) => f.endsWith('.html'))
  .map((f) => path.join(PUBLIC_DIR, f));

let changed = 0;
let stale = 0;

for (const file of htmlFiles) {
  const src = fs.readFileSync(file, 'utf8');
  const out = src.replace(ATTR_RE, (m, pre, urlPath, oldVer, post) => {
    // urlPath 形如 /static/css/base.css —— 去掉开头的 / 映射到磁盘
    const abs = path.join(PUBLIC_DIR, urlPath.replace(/^\//, ''));
    const h = hashFile(abs);
    if (!h) {
      // 文件不存在，保留原样但给出警告（多半是路径写错了）
      console.warn(`  [warn] 引用指向的文件不存在: ${urlPath}  (in ${path.basename(file)})`);
      return m;
    }
    const ver = `?v=${h}`;
    if (oldVer !== ver) {
      if (CHECK_ONLY) stale++;
      else changed++;
    }
    return pre + urlPath + ver + post;
  });

  if (!CHECK_ONLY && out !== src) {
    fs.writeFileSync(file, out);
    console.log(`  更新 ${path.basename(file)}`);
  }
}

if (CHECK_ONLY) {
  if (stale) {
    console.log(`  发现 ${stale} 处版本号已过期，请运行: node _stamp.js`);
    process.exit(1);
  }
  console.log('  所有静态资源版本号均为最新');
} else {
  console.log(changed ? `  完成，共更新 ${changed} 处引用` : '  无需改动（版本号已是最新）');
}
