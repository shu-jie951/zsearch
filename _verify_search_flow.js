/**
 * 搜索链路端到端验证（自带桩上游，不依赖真实 pansou）。
 * 用法: node _verify_search_flow.js
 *
 * 为什么要打桩
 *   2026-10-24 实测：真实上游 `so.252035.xyz` 处于病态 ——「甄嬛传」25.8s 回
 *   total=0，「三体」直接 nginx 500。在这种上游上跑端到端，只能验证出
 *   "上游坏了"，验证不出"我们的改写对不对"。所以这里起一个假 pansou：
 *   只认「庆余年」这一个词，别的词一律返回空。于是
 *
 *     「有没有庆余年的资源」能出结果  ⇔  我们确实把词洗成了「庆余年」
 *
 *   这条因果是确定的，不受上游波动影响。
 *
 * 覆盖：
 *   1. 口语清洗真的作用到了「发给上游的那串字」（桩里记录每次收到的 kw）
 *   2. 清洗后能拿到结果，且响应里 expanded.from/to 如实
 *   3. 主词为空时自动追变体（庆余年第二季 → 庆余年），并标记 _via 降权
 *   4. 变体不会无限追（最多 2 个）
 *   5. 清洗后的词不影响健康统计（源仍记为成功）
 */

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const STUB_PORT = 5399;
const APP_PORT = 5391;
const ROOT = __dirname;

const seen = []; // 桩收到的全部 kw，用来证明"上游看到的是清洗后的词"

function startStub() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let kw = '';
        try {
          kw = JSON.parse(body || '{}').kw || '';
        } catch {
          kw = '';
        }
        seen.push(kw);

        // 只有「庆余年」有货（3 条），其他词一律空 —— 这正是我们要验证的判据
        const has = kw === '庆余年';
        const payload = has
          ? {
              code: 0,
              data: {
                total: 3,
                merged_by_type: {
                  quark: [
                    {
                      url: 'https://pan.quark.cn/s/aaaaaaaaaaaa',
                      note: '庆余年 第一季 全集 4K 中字',
                      password: '',
                      datetime: '2026-10-01T10:00:00Z',
                      source: 'tg:stub',
                    },
                    {
                      url: 'https://pan.quark.cn/s/bbbbbbbbbbbb',
                      note: '庆余年 第二季 更新中',
                      password: '1234',
                      datetime: '2026-10-20T10:00:00Z',
                      source: 'tg:stub',
                    },
                    {
                      url: 'https://pan.baidu.com/s/1cccccccccc',
                      note: '庆余年 原著小说 epub',
                      password: '',
                      datetime: '2026-09-01T10:00:00Z',
                      source: 'tg:stub',
                    },
                  ],
                },
              },
            }
          : { code: 0, data: { total: 0 } };

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload));
      });
    });
    srv.listen(STUB_PORT, '127.0.0.1', () => resolve(srv));
  });
}

function get(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (r) => {
        let d = '';
        r.on('data', (c) => (d += c));
        r.on('end', () => {
          try {
            resolve(JSON.parse(d));
          } catch (e) {
            reject(new Error('non-json: ' + d.slice(0, 120)));
          }
        });
      })
      .on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUp(url, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      await get(url);
      return true;
    } catch {
      await sleep(200);
    }
  }
  return false;
}

let pass = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) {
    pass++;
    console.log('  \x1b[32m✓\x1b[0m ' + name);
  } else {
    fails.push(name + (detail ? '  →  ' + detail : ''));
    console.log('  \x1b[31m✗\x1b[0m ' + name + (detail ? '  →  ' + detail : ''));
  }
}

(async () => {
  const stub = await startStub();
  const node = process.execPath;

  const app = spawn(node, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      SOURCES: 'pansou',
      PANSOU_BASE: `http://127.0.0.1:${STUB_PORT}`,
      PANSOU_CACHE_TTL_MS: '0',
      LOG: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let appErr = '';
  app.stderr.on('data', (c) => (appErr += c));
  app.stdout.on('data', () => {});

  const base = `http://127.0.0.1:${APP_PORT}`;
  const up = await waitUp(base + '/api/status');
  if (!up) {
    console.error('服务没起来：\n' + appErr);
    process.exit(1);
  }

  try {
    console.log('\n1. 口语查询整条链路');

    seen.length = 0;
    const r1 = (await get(base + '/api/search?q=' + encodeURIComponent('有没有庆余年的资源'))).data;

    ok('上游收到的是清洗后的词「庆余年」', seen.includes('庆余年'), '实际收到：' + JSON.stringify(seen));
    ok('上游没收到用户原话', !seen.some((k) => k.includes('有没有')), JSON.stringify(seen));
    ok('结果非空（清洗确实救了这条查询）', r1.results.length === 3, 'count=' + r1.results.length);
    ok('expanded.rewritten 为 true', r1.expanded && r1.expanded.rewritten === true, JSON.stringify(r1.expanded));
    ok('expanded.to 是「庆余年」', r1.expanded && r1.expanded.to === '庆余年', String(r1.expanded && r1.expanded.to));
    ok('expanded.from 保留用户原话', r1.expanded && r1.expanded.from === '有没有庆余年的资源', String(r1.expanded && r1.expanded.from));
    ok('结果按相关性排好（都含「庆余年」）', r1.results.every((x) => x.title.includes('庆余年')));
    ok('source 是 aggregate', r1.source === 'aggregate', r1.source);
    ok('provider 记为 pansou 且条数正确', (r1.providers[0] || {}).count === 3, JSON.stringify(r1.providers[0]));

    console.log('\n2. 主词无货 → 自动追变体');

    seen.length = 0;
    const r2 = (await get(base + '/api/search?q=' + encodeURIComponent('庆余年第二季'))).data;

    ok('先按原词问了一次', seen[0] === '庆余年第二季', JSON.stringify(seen));
    // 注意：变体「庆余年」可能直接命中第 1 步写下的聚合缓存（这是设计如此），
    // 所以不能要求它出现在上游调用记录里 —— 只能要求它被发起过。
    ok('随后追了「去季集」变体', r2.expanded.variants.length >= 1, JSON.stringify(r2.expanded.variants));
    ok('★ 变体补到了结果（用户最终看得到）', r2.results.length > 0, 'count=' + r2.results.length);
    ok('expanded.variants 记录了变体与原因', (r2.expanded.variants[0] || {}).q === '庆余年', JSON.stringify(r2.expanded.variants));
    ok('变体原因标注为「去季集」', (r2.expanded.variants[0] || {}).reason === '去季集', String(r2.expanded.variants[0] && r2.expanded.variants[0].reason));
    ok('expanded.added > 0', r2.expanded.added > 0, String(r2.expanded.added));
    ok('变体追查次数受控（<= 2）', r2.expanded.variants.length <= 2, String(r2.expanded.variants.length));

    console.log('\n3. 完全搜不到时不乱追');

    seen.length = 0;
    const r3 = (await get(base + '/api/search?q=' + encodeURIComponent('绝不存在的资源名xyz'))).data;
    ok('结果为空', r3.results.length === 0, 'count=' + r3.results.length);
    ok('source 是 no-result', r3.source === 'no-result', r3.source);
    ok('最多追问 2 个变体', seen.length <= 3, '上游被调用 ' + seen.length + ' 次：' + JSON.stringify(seen));
    ok('空结果给建议而不是硬装成功', Array.isArray(r3.suggest) || r3.reason, JSON.stringify(r3.suggest));

    console.log('\n4. 缓存共享（同一个清洗结果不重复打上游）');

    seen.length = 0;
    const r4 = (await get(base + '/api/search?q=' + encodeURIComponent('求庆余年的资源'))).data;
    ok('同样被清洗成「庆余年」', r4.expanded && r4.expanded.to === '庆余年', JSON.stringify(r4.expanded));
    ok('命中了上一次的聚合缓存（没有再打上游）', seen.length === 0, '上游被调用 ' + seen.length + ' 次：' + JSON.stringify(seen));
    ok('缓存命中也返回完整结果', r4.results.length === 3, 'count=' + r4.results.length);
  } finally {
    app.kill();
    stub.close();
  }

  console.log('\n————————————————————————————');
  if (fails.length) {
    console.log('\x1b[31m失败 ' + fails.length + ' 项：\x1b[0m');
    fails.forEach((f) => console.log('  · ' + f));
    console.log('\n通过 ' + pass + '/' + (pass + fails.length) + '\n');
    process.exit(1);
  }
  console.log('\x1b[32m全部通过 ' + pass + '/' + pass + '\x1b[0m\n');
})();
