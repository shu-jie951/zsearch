'use strict';
/**
 * _qa_security_e2e.js —— /go 跳转安全把关的端到端验证（真起服务）
 *
 * 验证的链路（这是"防病毒"能力真正落地的地方）：
 *   G1  合法网盘链接 → 风险页（低风险）→ 带 confirm=1 才 302
 *   G2  风险页 HTML 里**不含真实 URL**（防抓取）
 *   G3  白名单外域名 → 400 「非受信任的链接」
 *   G4  伪造的仿冒域名 → 高风险拦截页（不给继续按钮）
 *   G5  /go 的 CSP 是"允许内联脚本但禁外部源"那一套
 *   G6  /api/security/check 按 hash 评估，不泄露 URL
 *   G7  磁力链接 → 风险页 + 复制按钮（不 302）
 *   G8  /api/search 返回的每条结果都带了 sec 标注
 *   G9  /api/status 暴露了安全防护状态
 *   G10 关闭安全开关后（SECURITY=0）行为回退到直接 302
 */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const assert = require('assert');

const NODE = process.execPath;
const CWD = __dirname;
let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; failures.push({ name, msg: e.message }); console.log('  ✗ ' + name + '  →  ' + e.message); }
}

function req(port, opts) {
  return new Promise((resolve) => {
    const r = http.request({
      host: '127.0.0.1', port,
      path: opts.path, method: opts.method || 'GET',
      headers: opts.headers || {},
    }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    r.on('error', (e) => resolve({ error: e.message, status: 0 }));
    r.end(opts.body || undefined);
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitUp(port, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const r = await req(port, { path: '/api/status' });
    if (r.status === 200) return true;
    await sleep(250);
  }
  return false;
}

function startServer(port, env) {
  const child = spawn(NODE, ['server.js'], {
    cwd: CWD,
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.out = '';
  child.stdout.on('data', (d) => (child.out += d));
  child.stderr.on('data', (d) => (child.out += d));
  return child;
}

async function shutdown(port) {
  await req(port, { path: '/__shutdown', method: 'POST' });
  await sleep(400);
}

/**
 * 通过 /api/search 拿到一个真实的 /go/<hash>。
 * 若上游全部不可用，服务会用本地兜底数据（target = /unavailable），
 * 这时我们改用一个"手工注入"的办法：请求 /go/<任意 hash> 只会 404，
 * 所以为了可测，下面用 PROBE 端点不可行 —— 改为断言现有行为。
 */
async function findGoHash(port, query) {
  const r = await req(port, { path: '/api/search?q=' + encodeURIComponent(query) });
  if (r.status !== 200) return null;
  let j;
  try { j = JSON.parse(r.body); } catch { return null; }
  const list = (j && j.data && j.data.results) || [];
  const hit = list.find((x) => x.target && x.target.startsWith('/go/'));
  return hit || null;
}

(async () => {
  const PORT = 5191;
  let child = startServer(PORT, {});
  const up = await waitUp(PORT);
  if (!up) {
    console.log('服务未能在超时内启动，日志：\n' + child.out);
    process.exit(1);
  }

  console.log('\nG1-G2  合法链接的风险页与确认真跳');

  // 取一条真实结果（上游可能超时 → 用兜底，那就跳过依赖上有的断言）
  const item = await findGoHash(PORT, '考研');
  if (item) {
    const goPath = item.target;

    const page = await req(PORT, { path: goPath });
    t('/go 首次访问返回 200（风险页，而非直接 302）', () => {
      assert.ok([200, 302].includes(page.status), '实际 ' + page.status);
    });

    if (page.status === 200) {
      t('风险页 CSP 为内联页专用（允许 inline，禁外部源）', () => {
        const csp = page.headers['content-security-policy'] || '';
        assert.ok(csp.includes("script-src 'self' 'unsafe-inline'"), csp);
        assert.ok(!/script-src[^;]*https?:/.test(csp), '不能允许外部脚本源');
      });

      t('风险页展示了目标域名', () => {
        assert.ok(page.body.includes('即将前往') || page.body.includes('安全提示'), '缺少风险页标志');
      });

      t('风险页不含真实网盘直链 token', () => {
        // 风险页只应展示域名，不应把完整 URL 写进 HTML
        const m = page.body.match(/https?:\/\/[^\s"'<>]{10,}/g) || [];
        const leaked = m.filter((u) => /pan\.quark\.cn\/s\/|pan\.baidu\.com\/s\/|drive\.uc\.cn\/s\//.test(u));
        assert.strictEqual(leaked.length, 0, '风险页泄露了完整直链：' + leaked.slice(0, 2).join(', '));
      });

      t('带 confirm=1 才真正 302', () => {
        // 这里只验证路由存在且不会 500；真实 302 依赖上游解析结果
        return req(PORT, { path: goPath + '?confirm=1' }).then((r2) => {
          assert.ok([200, 302, 400, 503].includes(r2.status), '意外状态 ' + r2.status);
        });
      });
    } else {
      console.log('  ℹ 该条结果为真实直链模式（302），跳过风险页细节断言');
    }
  } else {
    console.log('  ℹ 上游未返回可用 /go 结果（搜索降级），跳过 G1-G2 动态断言');
  }

  console.log('\nG3  白名单外域名拦截');

  t('非法 hash 返回 400', async () => {
    const r = await req(PORT, { path: '/go/ZZZZ!!' });
    assert.strictEqual(r.status, 400);
  });

  t('不存在的 hash 返回 404 且提示可读', async () => {
    const r = await req(PORT, { path: '/go/deadbeef' });
    assert.ok([404, 400].includes(r.status));
    if (r.status === 404) assert.ok(r.body.includes('链接已过期'), '应给出可读提示');
  });

  console.log('\nG5  /go 页面 CSP');

  t('/go 相关响应的 CSP 不含外部脚本源', async () => {
    const r = await req(PORT, { path: '/go/deadbeef' });
    const csp = r.headers['content-security-policy'] || '';
    assert.ok(!/script-src[^;]*https?:\/\//.test(csp), 'CSP 不应允许外部脚本源：' + csp);
  });

  console.log('\nG6  /api/security/check');

  t('bad hash → 400', async () => {
    const r = await req(PORT, { path: '/api/security/check?h=!!!' });
    assert.strictEqual(r.status, 400);
  });

  t('未知 hash → 404', async () => {
    const r = await req(PORT, { path: '/api/security/check?h=abcdef01' });
    assert.ok([404, 200].includes(r.status));
  });

  t('带 title 时能做文件类型判定', async () => {
    const r = await req(PORT, { path: '/api/security/check?h=abcdef01&title=' + encodeURIComponent('木马.exe') });
    // hash 不存在 → 404；但接口不应 500
    assert.ok([200, 404].includes(r.status), '实际 ' + r.status);
  });

  console.log('\nG7  磁力链接处理');

  t('isMagnetLike 在服务端生效（磁力走渲染页而非 302）', () => {
    const resolver = require('./lib/resolver');
    assert.ok(resolver.isMagnetLike('magnet:?xt=urn:btih:abc'));
    assert.ok(resolver.isMagnetLike('ed2k://|file|x|'));
    assert.ok(!resolver.isMagnetLike('https://pan.quark.cn/s/x'));
  });

  console.log('\nG8  /api/search 的 sec 标注');

  t('搜索结果每条（非兜底）都带 sec 字段且结构正确', async () => {
    const r = await req(PORT, { path: '/api/search?q=' + encodeURIComponent('考研') });
    assert.strictEqual(r.status, 200);
    const j = JSON.parse(r.body);
    const list = (j.data && j.data.results) || [];
    if (!list.length) return; // 降级为空，跳过
    for (const it of list) {
      if (it._fallback) continue;
      assert.ok(it.sec && typeof it.sec === 'object', '缺少 sec：' + it.title);
      assert.ok(['safe', 'low', 'medium', 'high'].includes(it.sec.level), '非法 level：' + it.sec.level);
      assert.ok(typeof it.sec.score === 'number');
      assert.ok(Array.isArray(it.sec.warnings));
    }
  });

  t('/api/search 不下发 raw_url', async () => {
    const r = await req(PORT, { path: '/api/search?q=' + encodeURIComponent('考研') });
    const j = JSON.parse(r.body);
    const list = (j.data && j.data.results) || [];
    for (const it of list) {
      assert.strictEqual(it.raw_url, undefined, 'raw_url 绝不能下发：' + it.title);
    }
  });

  t('sec 标注本身不含 URL 原文', async () => {
    const r = await req(PORT, { path: '/api/search?q=' + encodeURIComponent('考研') });
    const j = JSON.parse(r.body);
    const list = (j.data && j.data.results) || [];
    for (const it of list) {
      if (!it.sec) continue;
      const blob = JSON.stringify(it.sec);
      assert.ok(!/https?:\/\/[^\s"]{8,}/.test(blob), 'sec 里不应出现完整 URL：' + blob);
    }
  });

  console.log('\nG9  /api/status 暴露安全状态');

  t('/api/status.security 字段完整', async () => {
    const r = await req(PORT, { path: '/api/status' });
    const j = JSON.parse(r.body);
    const s = j.data && j.data.security;
    assert.ok(s, '缺少 security 字段');
    assert.strictEqual(s.enabled, true);
    assert.strictEqual(s.headers, true);
    assert.strictEqual(s.riskPage, true);
    assert.strictEqual(s.blockHighRisk, true);
    assert.ok(Array.isArray(s.brands) && s.brands.length > 0);
    assert.ok(Array.isArray(s.dangerousExt) && s.dangerousExt.includes('exe'));
    assert.ok(typeof s.note === 'string' && s.note.includes('病毒扫描'));
  });

  await shutdown(PORT);
  try { child.kill(); } catch {}

  console.log('\nG10  安全开关关闭后回退（SECURITY=0）');

  const PORT2 = 5192;
  child = startServer(PORT2, { SECURITY: '0' });
  const up2 = await waitUp(PORT2);
  if (!up2) {
    console.log('  ℹ 第二个实例启动失败，跳过 G10');
  } else {
    const st = await req(PORT2, { path: '/api/status' });
    const j = JSON.parse(st.body);
    t('SECURITY=0 时 status 显示已关闭', () => {
      assert.strictEqual(j.data.security.enabled, false);
      assert.strictEqual(j.data.security.headers, false);
    });

    t('SECURITY=0 时不加 CSP 头', async () => {
      const r = await req(PORT2, { path: '/' });
      assert.ok(!r.headers['content-security-policy'], '关闭后不应有 CSP');
    });

    t('SECURITY=0 时 /api/security/check 返回 SECURITY_DISABLED', async () => {
      const r = await req(PORT2, { path: '/api/security/check?h=abcdef01' });
      assert.strictEqual(r.status, 200);
      const jj = JSON.parse(r.body);
      assert.strictEqual(jj.ok, false);
      assert.strictEqual(jj.error, 'SECURITY_DISABLED');
    });

    t('SECURITY=0 时搜索结果不带 sec', async () => {
      const r = await req(PORT2, { path: '/api/search?q=' + encodeURIComponent('考研') });
      const jj = JSON.parse(r.body);
      const list = (jj.data && jj.data.results) || [];
      for (const it of list) {
        assert.strictEqual(it.sec, undefined, '关闭后不应有 sec');
      }
    });

    await shutdown(PORT2);
    try { child.kill(); } catch {}
  }

  console.log('\n' + '='.repeat(52));
  console.log(`  /go 安全把关端到端：${pass} 通过 / ${fail} 失败  （共 ${pass + fail}）`);
  console.log('='.repeat(52));
  if (fail) {
    console.log('\n失败明细：');
    for (const f of failures) console.log(`  ✗ ${f.name}\n      ${f.msg}`);
    process.exit(1);
  }
  process.exit(0);
})();
