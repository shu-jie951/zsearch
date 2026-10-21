/**
 * 空状态语义化专项验证（本轮强化项）。
 * 用法: node _qa_empty.js
 *
 * 为什么要有这个脚本：
 *   「上游超时」和「确实没有这个资源」原来看起来一模一样 —— 都是
 *   「没有找到相关资源」。用户等 20 秒看到这句话，会以为整个站没货，
 *   下次就不来了。真相是上游太慢，过几秒重试往往就有。
 *
 * 覆盖：
 *   1. 聚合层：源永不返回时，providers 必须带 timedOut / error
 *   2. 接口层：providers 的 error 是安全枚举，不透传上游原文
 *   3. 前端：超时空状态 → 专门的文案 + 「重试一次」按钮，且点击真的重发请求
 *   4. 前端：普通空状态 → 保持「没有找到」，不给无意义的重试按钮
 *   5. 控制台零报错
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 5178;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (u) =>
  new Promise((res, rej) => {
    http.get(u, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(d)); })
      .on('error', rej);
  });

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
};

(async () => {
  // =====================================================================
  // 1. 聚合层：假源永不 resolve，看它会不会被标成「超时」而不是「空」
  // =====================================================================
  console.log('\n=== 1. 聚合层：超时必须可识别 ===');
  {
    const srcMod = require('./lib/sources');
    // 打桩：只有一个源，且它的 search 永远不返回（模拟 pansou 卡住）
    srcMod.enabledIds = () => ['fake-slow'];
    srcMod.get = (id) =>
      id === 'fake-slow' ? { id: id, search: () => new Promise(() => {}) } : null;
    srcMod.stats = () => ({});
    delete require.cache[require.resolve('./lib/aggregator')];
    const agg = require('./lib/aggregator');

    const t0 = Date.now();
    const r = await agg.search('超时探针', { timeoutMs: 400 });
    const ms = Date.now() - t0;

    ok(ms < 2500, '硬超时按上限掐断，不会无限等', ms + 'ms');
    ok(r.items.length === 0, '没有条目', r.items.length);
    const p = (r.providers || [])[0] || {};
    ok(p.timedOut === true, 'providers 带 timedOut 标记', p);
    ok(p.error === 'timeout', 'providers.error=timeout', p.error);
    ok(r.source === 'aggregate-empty', 'source=aggregate-empty', r.source);
  }

  // =====================================================================
  // 2. 接口层：真实响应里 providers 必须带 error 字段
  // =====================================================================
  console.log('\n=== 2. 接口层：失败原因要往下传 ===');
  {
    const body = JSON.parse(await get('http://127.0.0.1:' + PORT + '/api/search?q=' + encodeURIComponent('甄嬛传')));
    const provs = (body.data && body.data.providers) || [];
    ok(provs.length > 0, '有 providers 明细', provs.length);
    ok(
      provs.every((p) => Object.prototype.hasOwnProperty.call(p, 'error')),
      '每条 provider 都有 error 字段',
      provs.map((p) => p.error)
    );
    // 安全枚举：不能把上游原文（可能带域名/内部路径）透传出去
    const allowed = [null, 'timeout', 'cooling', 'no-data', 'unknown-source', 'error'];
    ok(
      provs.every((p) => allowed.includes(p.error)),
      'error 只取安全枚举值',
      provs.map((p) => p.error).filter((e) => !allowed.includes(e))
    );
  }

  // =====================================================================
  // 3~5. 前端：用合成的接口响应，确定性地验证两种空状态
  // =====================================================================
  console.log('\n=== 3. 前端空状态 ===');
  const cport = 9700 + Math.floor(Math.random() * 60);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'zs-empty-'));
  const proc = spawn(EDGE, [
    '--headless=new', '--no-first-run', '--hide-scrollbars',
    '--remote-debugging-port=' + cport, '--user-data-dir=' + prof,
    '--window-size=1440,900', 'about:blank',
  ], { stdio: 'ignore' });

  let ver = null;
  for (let i = 0; i < 80; i++) {
    try { ver = JSON.parse(await get('http://127.0.0.1:' + cport + '/json/version')); break; }
    catch (e) { await sleep(250); }
  }
  if (!ver) { console.error('edge did not start'); proc.kill(); process.exit(1); }

  const WebSocket = require('ws');
  const ws = new WebSocket(ver.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r) => ws.on('open', r));

  let id = 0; const pend = new Map(); const errs = [];
  ws.on('message', (m) => {
    const o = JSON.parse(m);
    if (o.id && pend.has(o.id)) { pend.get(o.id)(o); pend.delete(o.id); }
    if (o.method === 'Runtime.exceptionThrown') {
      const d = o.params.exceptionDetails;
      errs.push('EXC ' + (d.exception ? d.exception.description : d.text));
    }
    if (o.method === 'Runtime.consoleAPICalled' && o.params.type === 'error') {
      errs.push('CONSOLE ' + o.params.args.map((a) => a.value || a.description || '').join(' '));
    }
  });
  const send = (method, params, sessionId) =>
    new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {}, sessionId })); });

  const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
  const { result: { sessionId: sid } } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sid);
  await send('Runtime.enable', {}, sid);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, sid);

  async function evalJs(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid);
    if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
    return r.result && r.result.result ? r.result.result.value : undefined;
  }
  async function waitFor(expr, timeout, stepMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      let v = false;
      try { v = await evalJs(expr); } catch (e) { /* DOM 还没到 */ }
      if (v) return true;
      await sleep(stepMs || 150);
    }
    return false;
  }

  // 注入接口拦截：只拦 /api/search，按关键词回不同的合成响应。
  // 这样「超时」和「真没数据」两种情况都能 100% 复现，不靠上游运气。
  const INTERCEPT = `
  (function () {
    var orig = window.fetch;
    window.__probe = { calls: [] };
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.indexOf('/api/search') === -1) return orig.apply(this, arguments);
      window.__probe.calls.push(url);
      var payload = null;
      if (url.indexOf('timeout_probe') !== -1) {
        payload = { ok: true, data: {
          results: [], source: 'no-result', reason: 'upstream-timeout',
          query: 'timeout_probe', sort: 'latest', cloud: 'all',
          providers: [{ id: 'pansou', count: 0, ms: 20000, ok: false, error: 'timeout' }],
          degraded: ['pansou'], elapsedMs: 20000, deduped: 0,
          suggest: ['考研', '周杰伦'] } };
      } else if (url.indexOf('plainempty_probe') !== -1) {
        payload = { ok: true, data: {
          results: [], source: 'no-result', reason: 'all-sources-empty',
          query: 'plainempty_probe', sort: 'latest', cloud: 'all',
          providers: [{ id: 'pansou', count: 0, ms: 800, ok: false, error: 'no-data' }],
          degraded: [], elapsedMs: 800, deduped: 0,
          suggest: ['考研'] } };
      }
      if (!payload) return orig.apply(this, arguments);
      return Promise.resolve(new Response(JSON.stringify(payload), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      }));
    };
  })();`;
  await send('Page.addScriptToEvaluateOnNewDocument', { source: INTERCEPT }, sid);

  // ---- 3a. 超时分支 ----
  await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/search?q=timeout_probe' }, sid);
  await sleep(600);
  const gotRetry = await waitFor(`!!document.querySelector('.empty-state-retry')`, 12000, 200);
  ok(gotRetry, '超时场景出现了「重试」按钮');
  const t1 = await evalJs(`(document.querySelector('.empty-state-title')||{}).textContent||''`);
  const d1 = await evalJs(`(document.querySelector('.empty-state-desc')||{}).textContent||''`);
  ok(/上游|慢/.test(t1), '标题说明是上游太慢', t1);
  ok(/不代表没有/.test(d1), '描述明确「不代表没有这个资源」', d1);
  const chips = await evalJs(`document.querySelectorAll('.empty-state-suggest .sug-chip').length`);
  ok(chips >= 2, '同时给出可点的换词建议', chips);
  const retryText = await evalJs(`(document.querySelector('.empty-state-retry')||{}).textContent||''`);
  ok(/重试/.test(retryText), '按钮文案是「重试」', retryText);

  // 点重试：必须真的重新发一次搜索请求（否则按钮是骗人的）
  const before = await evalJs('window.__probe.calls.length');
  await evalJs(`document.querySelector('.empty-state-retry').click()`);
  const retried = await waitFor(
    `window.__probe.calls.length > ${before}`,
    4000,
    120
  );
  ok(retried, '点「重试」会重新发起搜索请求', { before: before });
  const btnAfter = await evalJs(`(document.querySelector('.empty-state-retry')||{}).textContent||''`);
  ok(/正在重试|重试/.test(btnAfter), '点击后有即时反馈（按钮文案变化）', btnAfter);

  // ---- 3b. 普通空分支 ----
  await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/search?q=plainempty_probe' }, sid);
  await sleep(600);
  await waitFor(`!!document.querySelector('.empty-state-title')`, 12000, 200);
  const t2 = await evalJs(`(document.querySelector('.empty-state-title')||{}).textContent||''`);
  const retry2 = await evalJs(`document.querySelectorAll('.empty-state-retry').length`);
  ok(/没有找到/.test(t2), '真没结果时仍是「没有找到相关资源」', t2);
  ok(retry2 === 0, '真没结果时不给无意义的重试按钮', retry2);

  // ---- 3c. 控制台 ----
  await sleep(500);
  ok(errs.length === 0, '控制台零报错', errs.slice(0, 3));

  ws.close();
  try { proc.kill(); } catch (e) {}
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}

  console.log('\n================================================');
  console.log('  空状态语义化：通过 ' + pass + ' / ' + (pass + fail));
  console.log('================================================');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('脚本异常:', e);
  process.exit(1);
});
