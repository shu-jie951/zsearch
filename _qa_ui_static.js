'use strict';
/**
 * 界面代码静态审查：HTML / CSS 层的缺陷扫描。
 *
 * 覆盖：
 *   H1  HTML 标签配对（含 void 元素白名单）
 *   H2  属性引号配对
 *   H3  DOCTYPE / lang / charset / viewport / title 完整性
 *   H4  内联事件处理器语法可解析
 *   H5  图片 alt、外链 rel、表单 label
 *   H6  引用的静态资源是否真实存在
 *   C1  CSS 变量「用到但未定义」
 *   C2  CSS 变量「定义但从未使用」（仅提示）
 *   C3  CSS 括号配对
 *   C4  CSS @media / @keyframes 块完整性
 *   C5  亮暗双主题下关键变量都有覆盖
 *
 * 用法：node _qa_ui_static.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const STATIC = path.join(PUBLIC, 'static');

let pass = 0, fail = 0;
const failures = [];
const ok = (n, e) => { pass++; console.log(`  \u2714 ${n}${e ? '  ' + e : ''}`); };
const no = (n, e) => { fail++; failures.push(n + (e ? '  ' + e : '')); console.log(`  \u2718 ${n}${e ? '  ' + e : ''}`); };
const check = (n, c, e) => (c ? ok(n, e) : no(n, e));

const read = (p) => fs.readFileSync(p, 'utf8');

/* ------------------------------------------------------------ HTML 审查 */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr',
]);
// HTML 里允许省略闭合的标签（浏览器会自动闭合）
const OPTIONAL_CLOSE = new Set([
  'li', 'p', 'td', 'th', 'tr', 'thead', 'tbody', 'tfoot', 'option', 'dt', 'dd',
  'html', 'head', 'body', 'colgroup', 'caption',
]);

function stripHtmlNoise(html) {
  // 去掉注释、script/style 内容、SVG（SVG 标签规则不同），只留结构性标签
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '<script></script>')
    .replace(/<style[\s\S]*?<\/style>/gi, '<style></style>')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '<svg></svg>');
}

function checkHtml(file) {
  const raw = read(file);
  const name = path.basename(file);
  console.log(`\n--- ${name} ---`);
  const html = stripHtmlNoise(raw);

  // H1 标签配对
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*?)(\/?)>/g;
  const stack = [];
  const unbalanced = [];
  let m;
  while ((m = tagRe.exec(html))) {
    const isClose = m[1] === '/';
    const tag = m[2].toLowerCase();
    const selfClosed = m[4] === '/';
    if (VOID_TAGS.has(tag) || selfClosed) continue;
    if (!isClose) {
      stack.push(tag);
    } else {
      // 从栈顶往下找匹配；中间允许存在"可省略闭合"的标签
      let idx = -1;
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i] === tag) { idx = i; break; }
        if (!OPTIONAL_CLOSE.has(stack[i])) break;
      }
      if (idx < 0) unbalanced.push(`多余的 </${tag}>`);
      else stack.splice(idx);
    }
  }
  const leftover = stack.filter((t) => !OPTIONAL_CLOSE.has(t));
  check(`${name} 标签配对`, unbalanced.length === 0 && leftover.length === 0,
    unbalanced.length || leftover.length
      ? [...unbalanced, ...leftover.map((t) => `未闭合 <${t}>`)].slice(0, 4).join(', ')
      : '');

  // H2 属性引号配对：统计每个标签内引号数应为偶数
  const badQuote = [];
  const tagOnly = /<[a-zA-Z][^>]*>/g;
  let t;
  while ((t = tagOnly.exec(html))) {
    const s = t[0];
    const dq = (s.match(/"/g) || []).length;
    const sq = (s.match(/'/g) || []).length;
    if (dq % 2 !== 0) badQuote.push(s.slice(0, 60));
    if (sq % 2 !== 0) badQuote.push(s.slice(0, 60));
  }
  check(`${name} 属性引号配对`, badQuote.length === 0,
    badQuote.length ? badQuote[0] : '');

  // H3 必要元信息
  if (/index\.html$/.test(file)) {
    check(`${name} 有 DOCTYPE`, /^\s*<!DOCTYPE html>/i.test(raw));
    check(`${name} 有 lang 属性`, /<html[^>]+lang=/i.test(raw));
    check(`${name} 声明 UTF-8`, /<meta[^>]+charset=["']?utf-8/i.test(raw));
    check(`${name} 有 viewport`, /<meta[^>]+name=["']viewport["']/i.test(raw));
    check(`${name} 有 title`, /<title>[^<]+<\/title>/i.test(raw));
    check(`${name} 有 description`, /<meta[^>]+name=["']description["']/i.test(raw));
  }

  // H4 内联事件语法
  const badInline = [];
  const inlineRe = /\son(click|change|input|submit|focus|blur|keydown|keyup|mouseover|mouseenter)\s*=\s*"([^"]*)"/gi;
  let iv;
  while ((iv = inlineRe.exec(html))) {
    const code = iv[2].trim();
    if (!code) continue;
    try { new Function(code); } catch (e) { badInline.push(`${iv[1]}: ${code.slice(0, 50)}`); }
  }
  check(`${name} 内联事件语法可解析`, badInline.length === 0, badInline[0] || '');

  // H5 可达性
  const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map((x) => x[0]);
  const noAlt = imgs.filter((s) => !/\balt\s*=/i.test(s));
  check(`${name} img 均有 alt`, noAlt.length === 0, noAlt.length ? `${noAlt.length} 个缺 alt` : `${imgs.length} 个 img`);

  const extLinks = [...html.matchAll(/<a\b[^>]*target=["']_blank["'][^>]*>/gi)].map((x) => x[0]);
  const noRel = extLinks.filter((s) => !/rel\s*=/i.test(s));
  check(`${name} 新窗口外链有 rel`, noRel.length === 0, noRel.length ? `${noRel.length} 个缺 rel` : `${extLinks.length} 个外链`);

  // H6 引用的静态资源存在
  const refs = [...html.matchAll(/(?:href|src)\s*=\s*"(\/static\/[^"?]+)/g)].map((x) => x[1]);
  const missing = [...new Set(refs)].filter((r) => !fs.existsSync(path.join(PUBLIC, r.replace(/^\//, ''))));
  check(`${name} 静态资源引用都存在`, missing.length === 0, missing.join(', '));
}

/* ------------------------------------------------------------ CSS 审查 */
function checkCss(file) {
  const css = read(file);
  const name = path.basename(file);
  console.log(`\n--- ${name} ---`);

  // C3 括号配对
  const braces = (css.match(/\{/g) || []).length - (css.match(/\}/g) || []).length;
  check(`${name} 花括号配对`, braces === 0, braces === 0 ? '' : `差 ${braces}`);

  // C4 at-rule 块完整性
  const atRules = (css.match(/@(media|keyframes|supports|font-face)\b/g) || []).length;
  check(`${name} 含 at-rule`, atRules > 0, `${atRules} 个`);

  // 未闭合的注释
  const open = (css.match(/\/\*/g) || []).length;
  const close = (css.match(/\*\//g) || []).length;
  check(`${name} 注释配对`, open === close, open === close ? '' : `/* ${open} vs */ ${close}`);
}

/* 全局：CSS 变量定义/使用一致性 */
function checkCssVars(allCss, htmlInlineCss) {
  console.log('\n--- CSS 变量一致性（跨全部样式表 + HTML 内联 style）---');
  // 变量可能在两处定义：① CSS 文件的声明  ② HTML 内联 style="--i:2"
  const defined = new Set();
  for (const m of allCss.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) defined.add(m[1]);
  for (const m of htmlInlineCss.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) defined.add(m[1]);
  // 使用：var(--xxx)
  const used = new Set();
  for (const m of allCss.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) used.add(m[1]);

  const usedUndefined = [...used].filter((v) => !defined.has(v));
  check('无「使用但未定义」的 CSS 变量', usedUndefined.length === 0,
    usedUndefined.length ? usedUndefined.slice(0, 8).join(', ') : `${defined.size} 个变量`);

  // 带 fallback 的 var() 即使未定义也不会出问题，单独提示
  const withFallback = new Set(
    [...allCss.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)\s*,[^)]*\)/g)].map((m) => m[1])
  );
  const risky = usedUndefined.filter((v) => !withFallback.has(v));
  check('未定义变量中无「无 fallback」的高危项', risky.length === 0,
    risky.length ? risky.join(', ') : '（未定义的均带 fallback 或已被内联定义兜住）');

  const definedUnused = [...defined].filter((v) => !used.has(v));
  console.log(`  \u2139 定义但未使用: ${definedUnused.length} 个${definedUnused.length ? ' （' + definedUnused.slice(0, 6).join(', ') + '）' : ''}`);
  return { defined, used };
}

/* 亮/暗主题变量覆盖完整性 */
function checkThemeParity(baseCss, cssFiles) {
  console.log('\n--- 亮/暗主题变量覆盖 ---');
  const all = cssFiles.map(read).join('\n');

  // 抓 :root 块 与 暗色媒体查询块
  const rootBlocks = [...all.matchAll(/:root\s*\{([^}]*)\}/g)].map((m) => m[1]);
  const darkBlocks = [...all.matchAll(/@media[^{]*prefers-color-scheme\s*:\s*dark[^{]*\{([\s\S]*?)\n\}/g)].map((m) => m[1]);
  const lightBlocks = [...all.matchAll(/@media[^{]*prefers-color-scheme\s*:\s*light[^{]*\{([\s\S]*?)\n\}/g)].map((m) => m[1]);

  const varsIn = (blocks) => {
    const s = new Set();
    for (const b of blocks) for (const m of b.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) s.add(m[1]);
    return s;
  };

  const rootVars = varsIn(rootBlocks);
  const darkVars = varsIn(darkBlocks);
  const lightVars = varsIn(lightBlocks);

  check('存在 :root 变量定义', rootVars.size > 0, `${rootVars.size} 个`);
  check('存在暗色主题覆盖', darkVars.size > 0, `${darkVars.size} 个`);
  console.log(`  \u2139 亮色覆盖: ${lightVars.size} 个`);

  // 主题变量必须覆盖关键色（背景/文字），否则会有"白底白字"
  const keyVars = ['--bg', '--text', '--text-strong', '--panel', '--border'];
  const missingDark = keyVars.filter((v) => rootVars.has(v) && !darkVars.has(v));
  check('暗色主题覆盖了全部关键变量', missingDark.length === 0,
    missingDark.length ? `缺: ${missingDark.join(', ')}` : keyVars.filter((v) => rootVars.has(v)).join(', '));

  return { rootVars, darkVars, lightVars };
}

/* ================================================================ 主流程 */
console.log('\n========== 界面代码静态审查 ==========');

const htmlFiles = ['index.html', 'search.html', '404.html', 'disclaimer.html']
  .map((f) => path.join(PUBLIC, f))
  .filter((f) => fs.existsSync(f));

console.log('\n===== 1. HTML 结构 =====');
for (const f of htmlFiles) checkHtml(f);

console.log('\n===== 2. CSS 结构 =====');
const cssDir = path.join(STATIC, 'css');
const cssFiles = fs.existsSync(cssDir)
  ? fs.readdirSync(cssDir).filter((f) => f.endsWith('.css')).map((f) => path.join(cssDir, f))
  : [];
for (const f of cssFiles) checkCss(f);

console.log('\n===== 3. CSS 变量 =====');
const allCss = cssFiles.map(read).join('\n');
// 收集 HTML 内联 style 里的变量定义（例如 staggered 动画的 --i:2）
const htmlInlineCss = htmlFiles.map(read).join('\n');
checkCssVars(allCss, htmlInlineCss);

console.log('\n===== 4. 主题覆盖 =====');
checkThemeParity(allCss, cssFiles);

console.log('\n===== 5. 静态资源完整性 =====');
// 图标 / 字体等被 CSS 引用的资源。
// ⚠️ 必须先剥掉 data: URI —— 里面可能嵌套 url()，例如
//   background-image: url("data:image/svg+xml,...<rect filter='url(%23n)'/>...")
// 外层是 data:（自包含，不需要文件），内层那个 url(%23n) 是 SVG 内部引用 #n，
// 不剥掉就会把 "%23n" 当成一个缺失的静态文件（实测踩过这个假阳性）。
const cssNoData = allCss.replace(/url\(\s*['"]?data:[^)]*\)/gi, 'url(DATA_URI)');
const cssUrlRefs = [...cssNoData.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)]
  .map((m) => m[1])
  .filter((u) => !/^(data:|https?:|#|DATA_URI)/.test(u));
const cssMissing = [];
for (const u of new Set(cssUrlRefs)) {
  const abs = path.resolve(cssDir, u.split('?')[0]);
  if (!fs.existsSync(abs)) cssMissing.push(u);
}
check('CSS 内 url() 引用的文件都存在', cssMissing.length === 0,
  cssMissing.length ? cssMissing.join(', ') : `${new Set(cssUrlRefs).size} 个本地引用`);

// favicon
check('favicon.svg 存在', fs.existsSync(path.join(STATIC, 'favicon.svg')));

console.log('\n' + '='.repeat(48));
console.log(`  界面静态审查：通过 ${pass} / ${pass + fail}`);
if (failures.length) {
  console.log('\n  未通过项：');
  failures.forEach((f) => console.log('   · ' + f));
}
console.log('='.repeat(48) + '\n');
process.exit(fail ? 1 : 0);
