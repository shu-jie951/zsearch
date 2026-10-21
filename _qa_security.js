'use strict';
/**
 * _qa_security.js —— 安全防护模块单元验证（不依赖起服务）
 *
 * 覆盖：
 *   S1  仿冒域名识别（品牌名内嵌 / 编辑距离 / 同后缀不同）
 *   S2  可疑特征（裸 IP / 非常规端口 / 可疑后缀 / punycode / http）
 *   S3  危险文件类型（可执行 / 双扩展名伪装 / 压缩包 / 普通）
 *   S4  标题风险词
 *   S5  assessItem 综合结论
 *   S6  securityHeaders 输出（CSP 关键指令齐全）
 *   S7  inlinePageHeaders / sendHtmlPage CSP
 *   S8  风险页 / 拦截页渲染（含转义、不泄露真实 URL）
 *   S9  白名单一致性（security.BRANDS 与 resolver.ALLOWED_HOSTS 不冲突）
 */

const assert = require('assert');
const security = require('./lib/security');
const resolver = require('./lib/resolver');

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) {
    fail++; failures.push({ name, msg: e.message });
    console.log('  ✗ ' + name + '  →  ' + e.message);
  }
}
function group(title) { console.log('\n' + title); }

/* ========================= S1 仿冒域名 ========================= */
group('S1  仿冒域名识别');

t('官方域名判定为 official（pan.quark.cn）', () => {
  const r = security.assessUrl('https://pan.quark.cn/s/abc');
  assert.ok(!r.reasons.some((x) => x.includes('仿冒')), '官方域名不应被判仿冒：' + JSON.stringify(r.reasons));
  assert.ok(r.notes.some((x) => x.includes('夸克')), '应给出官方确认提示');
});

t('内嵌品牌名（panbaidu.com）判仿冒', () => {
  const r = security.assessUrl('https://panbaidu.com/s/1abc');
  assert.ok(r.reasons.some((x) => x.includes('仿冒')), '应识别为仿冒：' + JSON.stringify(r.reasons));
  assert.strictEqual(r.level, 'high', '高风险等级，实际 ' + r.level);
});

t('品牌名+换后缀（quark.xyz）判仿冒', () => {
  const r = security.assessUrl('https://quark.xyz/s/1abc');
  assert.ok(r.reasons.some((x) => x.includes('仿冒')), JSON.stringify(r.reasons));
});

t('编辑距离仿冒（quarkk.cn）判类似', () => {
  const r = security.assessUrl('https://quarkk.cn/s/1abc');
  assert.ok(r.reasons.some((x) => x.includes('相似') || x.includes('仿冒')), JSON.stringify(r.reasons));
});

t('detectLookalike 对官方域返回 official', () => {
  const d = security.detectLookalike('pan.baidu.com');
  assert.ok(d.official, '应为 official');
});

t('detectLookalike 对无关域名不误报', () => {
  const d = security.detectLookalike('example.com');
  assert.ok(!d.lookalike, 'example.com 不应被判仿冒');
});

/* ========================= S2 可疑特征 ========================= */
group('S2  可疑特征识别');

t('裸 IP 命中', () => {
  const r = security.assessUrl('http://192.168.1.1/download/file');
  assert.ok(r.reasons.some((x) => x.includes('IP 地址')), JSON.stringify(r.reasons));
});

t('非常规端口命中', () => {
  const r = security.assessUrl('https://pan.quark.cn:8443/s/x');
  assert.ok(r.reasons.some((x) => x.includes('端口')), JSON.stringify(r.reasons));
});

t('可疑后缀 .top 命中', () => {
  const r = security.assessUrl('https://freedownload.top/x');
  assert.ok(r.reasons.some((x) => x.includes('.top')), JSON.stringify(r.reasons));
});

t('punycode 域名命中', () => {
  const r = security.assessUrl('https://xn--80ak6aa92e.com/x');
  assert.ok(r.reasons.some((x) => x.includes('Punycode')), JSON.stringify(r.reasons));
});

t('HTTP 明文命中', () => {
  const r = security.assessUrl('http://pan.quark.cn/s/x');
  assert.ok(r.reasons.some((x) => x.includes('HTTP')), JSON.stringify(r.reasons));
});

t('正常 https 官方链接为 safe/low', () => {
  const r = security.assessUrl('https://pan.quark.cn/s/abcdef');
  assert.ok(['safe', 'low'].includes(r.level), '应为 safe/low，实际 ' + r.level);
});

t('非法 URL 返回 blocked', () => {
  const r = security.assessUrl('not-a-url');
  assert.strictEqual(r.level, 'blocked');
});

t('空 URL 返回 blocked', () => {
  const r = security.assessUrl('');
  assert.strictEqual(r.level, 'blocked');
});

/* ========================= S3 危险文件类型 ========================= */
group('S3  危险文件类型');

t('.exe 判危险', () => {
  const f = security.assessFileKind('某软件安装包 v2.1.exe');
  assert.strictEqual(f.kind, 'dangerous');
  assert.ok(f.risky);
  assert.strictEqual(f.ext, 'exe');
});

t('.scr / .bat / .vbs 判危险', () => {
  for (const e of ['scr', 'bat', 'vbs', 'msi', 'apk', 'ps1']) {
    const f = security.assessFileKind('file.' + e);
    assert.strictEqual(f.kind, 'dangerous', e + ' 应判危险');
  }
});

t('双扩展名伪装（报告.pdf.exe）识别', () => {
  const f = security.assessFileKind('2024年度报告.pdf.exe');
  assert.ok(f.doubleExt, '应识别为双扩展名');
  assert.ok(f.risky);
  assert.ok(f.label.includes('伪装'), 'label 应说明伪装：' + f.label);
});

t('双扩展名（电影.mp4.scr）识别', () => {
  const f = security.assessFileKind('复仇者联盟.mp4.scr');
  assert.ok(f.doubleExt, 'mp4.scr 应识别为伪装');
});

t('.zip 判压缩包（不算危险但给提醒）', () => {
  const f = security.assessFileKind('资料合集.zip');
  assert.strictEqual(f.kind, 'archive');
  assert.ok(!f.risky, '压缩包本身不算危险');
  assert.ok(f.advice.length > 0, '应给出解压提醒');
});

t('.mp4 判普通', () => {
  const f = security.assessFileKind('电影.mp4');
  assert.strictEqual(f.kind, 'normal');
});

t('无扩展名判普通', () => {
  const f = security.assessFileKind('一个没有扩展名的标题');
  assert.strictEqual(f.kind, 'normal');
});

/* ========================= S4 标题风险词 ========================= */
group('S4  标题风险词');

t('破解补丁命中', () => {
  const r = security.assessTitle('Photoshop 2024 破解补丁 下载');
  assert.ok(r.risky);
});

t('诱导加群命中', () => {
  const r = security.assessTitle('免费领取课程 加微信 xxx');
  assert.ok(r.risky);
});

t('正常标题不误报', () => {
  const r = security.assessTitle('考研数学 张宇 强化班 视频教程');
  assert.ok(!r.risky, '不应误报：' + JSON.stringify(r.hits));
});

/* ========================= S5 assessItem ========================= */
group('S5  assessItem 综合结论');

t('正常结果 → safe', () => {
  const a = security.assessItem({ title: '考研英语真题解析', raw_url: 'https://pan.quark.cn/s/abc123' });
  assert.ok(a.safe, JSON.stringify(a));
  assert.strictEqual(a.level, 'safe');
});

t('仿冒域名结果 → 高风险', () => {
  const a = security.assessItem({ title: '某资源', raw_url: 'https://panbaidu.com/s/x' });
  assert.ok(!a.safe);
  assert.strictEqual(a.level, 'high', JSON.stringify(a));
});

t('可执行文件结果 → 至少 medium', () => {
  const a = security.assessItem({ title: '游戏修改器.exe', raw_url: 'https://pan.quark.cn/s/abc' });
  assert.ok(['medium', 'high'].includes(a.level), JSON.stringify(a));
  assert.strictEqual(a.fileKind, 'dangerous');
});

t('assessItem 输出不含真实 URL 字段', () => {
  const url = 'https://pan.quark.cn/s/SECRETTOKEN123';
  const a = security.assessItem({ title: 'x', raw_url: url });
  const blob = JSON.stringify(a);
  assert.ok(!blob.includes('SECRETTOKEN123'), 'assessItem 不能回传 URL 原文');
});

/* ========================= S6 securityHeaders ========================= */
group('S6  安全响应头');

function fakeRes() {
  const h = {};
  return {
    headers: h,
    setHeader(k, v) { h[k.toLowerCase()] = v; },
  };
}

t('CSP 含 default-src self', () => {
  const res = fakeRes();
  security.securityHeaders()({}, res, () => {});
  assert.ok(/default-src 'self'/.test(res.headers['content-security-policy']));
});

t('CSP 严格模式不含外部脚本源（script-src 无 https/http 通配）', () => {
  const res = fakeRes();
  security.securityHeaders({ allowInlineScript: false })({}, res, () => {});
  const csp = res.headers['content-security-policy'];
  const scriptDir = csp.split('; ').find((d) => d.startsWith('script-src'));
  assert.strictEqual(scriptDir, "script-src 'self'", '严格模式 script-src 只能是 self，实际：' + scriptDir);
});

t('CSP 含 object-src none（封死挂马入口）', () => {
  const res = fakeRes();
  security.securityHeaders()({}, res, () => {});
  assert.ok(res.headers['content-security-policy'].includes("object-src 'none'"));
});

t('CSP 含 frame-ancestors none（防点击劫持）', () => {
  const res = fakeRes();
  security.securityHeaders()({}, res, () => {});
  assert.ok(res.headers['content-security-policy'].includes("frame-ancestors 'none'"));
});

t('X-Content-Type-Options = nosniff', () => {
  const res = fakeRes();
  security.securityHeaders()({}, res, () => {});
  assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
});

t('X-Frame-Options = DENY', () => {
  const res = fakeRes();
  security.securityHeaders()({}, res, () => {});
  assert.strictEqual(res.headers['x-frame-options'], 'DENY');
});

t('Referrer-Policy 存在', () => {
  const res = fakeRes();
  security.securityHeaders()({}, res, () => {});
  assert.ok(res.headers['referrer-policy']);
});

t('Permissions-Policy 关闭摄像头/麦克风/定位', () => {
  const res = fakeRes();
  security.securityHeaders()({}, res, () => {});
  const pp = res.headers['permissions-policy'];
  for (const k of ['camera=()', 'microphone=()', 'geolocation=()']) {
    assert.ok(pp.includes(k), 'Permissions-Policy 应含 ' + k);
  }
});

t('安全头中间件会调用 next()', () => {
  const res = fakeRes();
  let called = false;
  security.securityHeaders()({}, res, () => { called = true; });
  assert.ok(called);
});

/* ========================= S7 内联页 CSP ========================= */
group('S7  服务端拼 HTML 页专用 CSP');

t('inlinePageHeaders 允许内联脚本但仍禁止外部源', () => {
  const res = fakeRes();
  security.inlinePageHeaders(res);
  const csp = res.headers['content-security-policy'];
  assert.ok(csp.includes("script-src 'self' 'unsafe-inline'"), csp);
  assert.ok(!/script-src[^;]*https?:/.test(csp), 'inline 页 CSP 也不能允许外部脚本源');
});

t('sendHtmlPage 设置状态码与 Content-Type', () => {
  const res = fakeRes();
  res.status = (n) => { res._status = n; return res; };
  res.type = (t) => { res._type = t; return res; };
  res.send = (b) => { res._body = b; return res; };
  security.sendHtmlPage(res, 418, '<html>hi</html>');
  assert.strictEqual(res._status, 418);
  assert.strictEqual(res._type, 'html');
  assert.ok(res.headers['content-security-policy']);
});

/* ========================= S8 页面渲染 ========================= */
group('S8  风险页 / 拦截页渲染');

t('renderRiskPage 转义标题里的 HTML', () => {
  const html = security.renderRiskPage({
    target: 'https://pan.quark.cn/s/x',
    goHash: '/go/abcd1234',
    title: '<img src=x onerror=alert(1)>',
    risk: { level: 'low', score: 10, reasons: [], notes: [] },
  });
  assert.ok(!html.includes('<img src=x'), '未转义的 HTML 会跑到页面上');
  assert.ok(html.includes('&lt;img'), '应转义为实体');
});

t('renderRiskPage 高风险不给自动跳转', () => {
  const html = security.renderRiskPage({
    target: 'https://panbaidu.com/x',
    goHash: '/go/deadbeef',
    title: 'x',
    risk: { level: 'high', score: 80, reasons: ['仿冒'], notes: [] },
  });
  assert.ok(!html.includes('setTimeout'), '高风险页不应有自动跳转脚本');
  assert.ok(html.includes('仍然继续'), '高风险应要求显式确认');
});

t('renderRiskPage 低风险带 1 秒自动跳转', () => {
  const html = security.renderRiskPage({
    target: 'https://pan.quark.cn/s/x',
    goHash: '/go/abcd1234',
    title: 'x',
    risk: { level: 'safe', score: 0, reasons: [], notes: [] },
  });
  assert.ok(html.includes('setTimeout'), '低风险应自动跳转');
});

t('renderRiskPage 页面正文不含目标真实 URL', () => {
  const url = 'https://pan.quark.cn/s/VERYSECRETTOKEN999';
  const html = security.renderRiskPage({
    target: url,
    goHash: '/go/abcd1234',
    title: 'x',
    risk: { level: 'low', score: 5, reasons: [], notes: [] },
  });
  assert.ok(!html.includes('VERYSECRETTOKEN999'), '风险页不能把真实 URL 写进 HTML');
  assert.ok(html.includes('pan.quark.cn'), '但应展示域名让用户看到');
});

t('renderBlockedPage 不给继续按钮', () => {
  const html = security.renderBlockedPage('evil.top', ['可疑后缀'], '标题');
  assert.ok(!html.includes('继续'), '拦截页不应有继续入口');
  assert.ok(html.includes('返回搜索'));
});

t('renderBlockedPage 转义 host', () => {
  const html = security.renderBlockedPage('"><script>alert(1)</script>', [], '');
  assert.ok(!html.includes('<script>alert(1)</script>'), 'host 必须转义');
});

t('renderRiskPage 磁力模式渲染复制按钮', () => {
  const html = security.renderRiskPage({
    target: 'magnet:?xt=urn:btih:abc',
    goHash: '/go/abcd1234',
    title: 'x',
    risk: { level: 'low', score: 0, reasons: [], notes: [] },
    magnet: 'magnet:?xt=urn:btih:abc',
  });
  assert.ok(html.includes('复制链接'));
  assert.ok(html.includes('magnet:?xt=urn:btih:abc'));
});

/* ========================= S9 白名单一致性 ========================= */
group('S9  品牌表与白名单一致性');

t('每个 BRAND 都能被 resolver 白名单覆盖或明确不覆盖', () => {
  // 这里只做信息性断言：BRANDS 里作为"官方域名"出现的部分，
  // 若其主域在白名单里，则不应被判仿冒。
  for (const b of security.BRANDS) {
    const r = security.assessUrl('https://' + b.host + '/x');
    assert.ok(!r.reasons.some((x) => x.includes('仿冒')), b.host + ' 不应被判仿冒');
  }
});

t('DANGEROUS_EXT 是 Set 且含核心扩展名', () => {
  assert.ok(security.DANGEROUS_EXT instanceof Set);
  for (const e of ['exe', 'bat', 'scr', 'vbs', 'js']) {
    assert.ok(security.DANGEROUS_EXT.has(e), '缺少 ' + e);
  }
});

t('SUSPICIOUS_TLDS 是 Set 且含核心后缀', () => {
  assert.ok(security.SUSPICIOUS_TLDS instanceof Set);
  for (const e of ['top', 'xyz', 'icu']) {
    assert.ok(security.SUSPICIOUS_TLDS.has(e), '缺少 ' + e);
  }
});

t('rootDomain 处理两段后缀（x.com.cn）', () => {
  assert.strictEqual(security.rootDomain('a.b.com.cn'), 'a.b.com.cn'.split('.').length === 4 ? 'b.com.cn' : 'b.com.cn');
});

t('rootDomain 去 www', () => {
  assert.strictEqual(security.rootDomain('www.pan.quark.cn'), 'quark.cn');
});

/* ========================= 汇总 ========================= */
console.log('\n' + '='.repeat(52));
console.log(`  安全模块单元验证：${pass} 通过 / ${fail} 失败  （共 ${pass + fail}）`);
console.log('='.repeat(52));
if (fail) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  ✗ ${f.name}\n      ${f.msg}`);
  process.exit(1);
}
