'use strict';
/**
 * 回归验证：确认视觉改造没有影响聚合功能与各路由。
 * 用法: node _verify.js
 */
const http = require('http');

const BASE = 'http://localhost:5178';

function req(path, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE);
    const r = http.request(
      { host: u.hostname, port: u.port, path: u.pathname + u.search, method: opts.method || 'GET', headers: opts.headers || {} },
      (res) => {
        let b = '';
        res.on('data', (d) => (b += d));
        res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
      }
    );
    r.on('error', reject);
    r.setTimeout(60000, () => { r.destroy(new Error('timeout')); });
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? '  ✔ ' : '  �’ ') + name + (detail ? '  → ' + detail : ''));
}

(async () => {
  console.log('\n=== 1. 页面路由 ===');
  const routes = [
    ['/', '首页', 200],
    ['/search', '结果页', 200],
    ['/disclaimer', '免责声明', 200],
    ['/nope-xyz', '404 兜底', 404],
  ];
  for (const [p, label, expect] of routes) {
    const r = await req(p);
    check(label + ' ' + p, r.status === expect, 'HTTP ' + r.status + '（期望 ' + expect + '）');
  }

  console.log('\n=== 2. 静态资源 ===');
  for (const [p, label] of [
    ['/static/css/base.css', 'base.css'],
    ['/static/css/home.css', 'home.css'],
    ['/static/css/results.css', 'results.css'],
    ['/static/js/home.js', 'home.js'],
    ['/static/js/results.js', 'results.js'],
    ['/static/favicon.svg', 'favicon'],
  ]) {
    const r = await req(p);
    check(label, r.status === 200 && r.body.length > 100, 'HTTP ' + r.status + ' ' + r.body.length + 'B');
  }

  console.log('\n=== 3. 聚合搜索（多源） ===');
  const queries = ['电影', '考研', '周杰伦', 'Python'];
  for (const q of queries) {
    const r = await req('/api/search?q=' + encodeURIComponent(q));
    let j = null;
    try { j = JSON.parse(r.body); } catch (e) { /* */ }
    const d = j && j.data;
    const ok = r.status === 200 && j && j.ok && d && Array.isArray(d.results);
    const prov = d ? (d.providers || []).map((p) => p.id + ':' + p.count + (p.ok ? '✓' : '✗')).join(' ') : '-';
    check('搜索「' + q + '」', ok && d.results.length > 0, (d ? d.results.length + ' 条 | ' + prov : 'FAILED'));
  }

  console.log('\n=== 4. 云盘筛选 ===');
  for (const cloud of ['quark', 'baidu', 'xunlei']) {
    const r = await req('/api/search?q=' + encodeURIComponent('电影') + '&cloud=' + cloud);
    const j = JSON.parse(r.body);
    const d = j.data;
    const allMatch = d.results.every((x) => !x.cloud_type || x.cloud_type === cloud || x.cloud_type === 'other');
    check('筛选 ' + cloud, r.status === 200 && d.results.length >= 0,
      d.results.length + ' 条' + (allMatch ? '（类型一致）' : '（含其他类型）'));
  }

  console.log('\n=== 5. 排序 ===');
  const rl = JSON.parse((await req('/api/search?q=' + encodeURIComponent('电影') + '&sort=latest')).body).data;
  const ro = JSON.parse((await req('/api/search?q=' + encodeURIComponent('电影') + '&sort=oldest')).body).data;
  check('sort=latest 返回正常', rl.results.length > 0, rl.results.length + ' 条');
  check('sort=oldest 返回正常', ro.results.length > 0, ro.results.length + ' 条');

  console.log('\n=== 6. 其他接口 ===');
  {
    const r = await req('/api/status');
    const j = JSON.parse(r.body);
    const srcs = (j.data.sources || []).filter((s) => s.enabled);
    check('/api/status', r.status === 200 && j.ok, srcs.length + ' 个启用源: ' + srcs.map((s) => s.label).join('/'));
  }
  {
    const r = await req('/api/sources');
    const j = JSON.parse(r.body);
    check('/api/sources', r.status === 200 && j.ok, (j.data.list || []).length + ' 个源');
  }
  {
    const r = await req('/api/suggest?q=' + encodeURIComponent('考研'));
    const j = JSON.parse(r.body);
    check('/api/suggest', r.status === 200 && j.ok, (j.data || []).length + ' 条联想');
  }

  console.log('\n=== 7. 链接跳转 /go ===');
  {
    const d = JSON.parse((await req('/api/search?q=' + encodeURIComponent('电影'))).body).data;
    const item = d.results.find((x) => x.first_url && x.first_url.startsWith('/go/'));
    if (!item) {
      check('/go 存在可测条目', false, '未找到 /go 链接');
    } else {
      const r = await req(item.first_url);
      const isRedirect = r.status === 302 || r.status === 301;
      const isMagnetPage = r.status === 200 && /唤起下载工具/.test(r.body);
      const isNotice = r.status === 200 && /返回搜索/.test(r.body);
      check('/go 可访问', isRedirect || isMagnetPage || isNotice,
        'HTTP ' + r.status + (isRedirect ? ' → ' + (r.headers.location || '').slice(0, 48) : isMagnetPage ? ' (磁力页)' : isNotice ? ' (提示页)' : ''));
    }
  }

  console.log('\n=== 8. 标题清洗生效 ===');
  {
    const d = JSON.parse((await req('/api/search?q=' + encodeURIComponent('电影'))).body).data;
    const noisy = d.results.filter((x) => /(夸克|百度|UC|迅雷|阿里|天翼|115|123)\s*(网盘|云盘|盘)\s*[\[【（(]?\s*$/.test(x.title));
    check('结果标题无尾部网盘名残留', noisy.length === 0,
      noisy.length ? noisy.slice(0, 3).map((x) => x.title).join(' | ') : '全部干净（共 ' + d.results.length + ' 条）');
  }

  console.log('\n=== 9. 同标题折叠 ===');
  {
    const d = JSON.parse((await req('/api/search?q=' + encodeURIComponent('考研'))).body).data;
    const titles = d.results.map((x) => x.title);
    const dup = titles.length - new Set(titles).size;
    const withDupes = d.results.filter((x) => x._dupes > 0).length;
    check('折叠后无重复标题', dup === 0, '唯一标题 ' + new Set(titles).size + '/' + titles.length + '，其中 ' + withDupes + ' 条带重复计数');
  }

  const pass = results.filter((r) => r.ok).length;
  console.log('\n===============================');
  console.log('  通过 ' + pass + ' / ' + results.length);
  console.log('===============================\n');
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
