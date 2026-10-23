/**
 * _gh_push.js —— 走 GitHub REST API 推送，用于 https://github.com 被阻断、但
 * api.github.com 仍可访问的网络环境。
 *
 * 用法: node _gh_push.js [--dry]
 *
 * 为什么需要它：
 *   这台机器上 github.com:443 完全连不上（`git push` 21 秒后报
 *   "Could not connect to server"），而 api.github.com 直连 200 / 0.4 秒。
 *   两者是不同域名、不同线路，所以 git 的 smart HTTP 传输全废，但 Git Data API
 *   （blobs / trees / commits / refs）是可用的 —— 那套接口足够把一次提交推上去。
 *
 * 做的事情（和 `git push` 等价，只是换了传输层）：
 *   1. 读远程 main 的 commit sha 与根 tree sha
 *   2. `git diff --name-status <remote> HEAD` 算出要改哪些文件
 *   3. 每个新增/修改的文件 → POST /git/blobs（base64），拿到 blob sha
 *      删除的文件 → tree 条目里 sha 置 null
 *   4. POST /git/trees（base_tree=远程 tree，只带变更条目）
 *   5. POST /git/commits（parents=[远程 sha]，message 用本地那次提交的原文）
 *   6. PATCH /git/refs/heads/main
 *
 * ⚠️ 不落盘 token：每次运行时用 `git credential fill` 现场取，用完即弃。
 * ⚠️ 二进制文件必须走 Buffer，不能让 execSync 按 utf8 解码 —— 壁纸 webp 会当场损坏。
 */
'use strict';

const path = require('path');
const { execSync, spawnSync } = require('child_process');

const CWD = __dirname;
const REPO = 'shu-jie951/zsearch';
const BRANCH = 'main';
const DRY = process.argv.includes('--dry');

function sh(cmd) {
  return execSync(cmd, { cwd: CWD, maxBuffer: 1 << 28 }).toString();
}

function readToken() {
  const r = spawnSync('git', ['credential', 'fill'], {
    cwd: CWD,
    input: 'protocol=https\nhost=github.com\n\n',
  });
  const out = (r.stdout || Buffer.alloc(0)).toString();
  const m = /^password=(.+)$/m.exec(out);
  if (!m) throw new Error('凭据里没有 password 字段，无法取 token');
  return m[1].trim();
}

const TOKEN = readToken();

async function api(method, p, body) {
  const res = await fetch('https://api.github.com' + p, {
    method,
    headers: {
      Authorization: 'Bearer ' + TOKEN,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'zsearch-push',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(method + ' ' + p + ' → ' + res.status + '  ' + text.slice(0, 400));
  }
  return text ? JSON.parse(text) : {};
}

/* 取 HEAD 里某个文件的原始字节。encoding:'buffer' 是关键，否则 webp 会被 utf8 破坏。 */
function showAtHead(file) {
  const r = spawnSync('git', ['show', 'HEAD:' + file], { cwd: CWD, maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error('git show 失败: ' + file + ' ' + (r.stderr || '').toString());
  return r.stdout;
}

/* 取 HEAD 里某个文件的 git mode（100644 / 100755 / 120000） */
function modeAtHead(file) {
  const r = spawnSync('git', ['ls-tree', 'HEAD', '--', file], { cwd: CWD });
  const line = (r.stdout || Buffer.alloc(0)).toString().trim();
  if (!line) return '100644';
  return line.split(/\s+/)[0];
}

(async () => {
  console.log('读取远程状态…');
  const ref = await api('GET', `/repos/${REPO}/git/ref/heads/${BRANCH}`);
  const remoteSha = ref.object.sha;
  const remoteCommit = await api('GET', `/repos/${REPO}/git/commits/${remoteSha}`);
  console.log('  远程 HEAD = ' + remoteSha.slice(0, 10) + '  ' + (remoteCommit.message || '').split('\n')[0]);

  const localSha = sh('git rev-parse HEAD').trim();
  console.log('  本地 HEAD = ' + localSha.slice(0, 10));
  if (remoteSha === localSha) {
    console.log('\n远程已经是最新的，无需推送。');
    return;
  }

  // 本地是否真的以远程为祖先 —— 不是的话说明有人往远程推过东西，
  // 这时候硬推会覆盖他人提交。宁可不推，让人来处理。
  const isAncestor = spawnSync('git', ['merge-base', '--is-ancestor', remoteSha, 'HEAD'], { cwd: CWD });
  if (isAncestor.status !== 0) {
    console.error(
      '\n⚠️ 远程 HEAD 不是本地 HEAD 的祖先 —— 远程有本地没有的提交。\n' +
        '   为了不覆盖别人的工作，已中止。请先 git fetch 合并后再推。'
    );
    process.exit(2);
  }

  const raw = sh(`git diff --name-status ${remoteSha} HEAD`).trim();
  const lines = raw ? raw.split('\n').filter(Boolean) : [];
  console.log('  待同步文件: ' + lines.length);

  const entries = [];
  let added = 0,
    modified = 0,
    deleted = 0;

  for (const line of lines) {
    const parts = line.split('\t');
    const st = parts[0][0]; // A / M / D / R / T
    const file = parts[1];
    if (!file) continue;

    if (st === 'D') {
      entries.push({ path: file, mode: '100644', type: 'blob', sha: null });
      deleted++;
      console.log('   - 删除 ' + file);
      continue;
    }
    if (st === 'R') {
      // 重命名：删旧 + 建新
      entries.push({ path: parts[1], mode: '100644', type: 'blob', sha: null });
      deleted++;
      const newFile = parts[2];
      const buf = showAtHead(newFile);
      const blob = await api('POST', `/repos/${REPO}/git/blobs`, {
        content: buf.toString('base64'),
        encoding: 'base64',
      });
      entries.push({ path: newFile, mode: modeAtHead(newFile), type: 'blob', sha: blob.sha });
      added++;
      console.log('   → 重命名 ' + parts[1] + ' → ' + newFile);
      continue;
    }

    const buf = showAtHead(file);
    const blob = await api('POST', `/repos/${REPO}/git/blobs`, {
      content: buf.toString('base64'),
      encoding: 'base64',
    });
    entries.push({ path: file, mode: modeAtHead(file), type: 'blob', sha: blob.sha });
    if (st === 'A') added++;
    else modified++;
    console.log('   ' + (st === 'A' ? '+' : '~') + ' ' + file + '  (' + buf.length + ' B)');
  }

  console.log(`\n新增 ${added} / 修改 ${modified} / 删除 ${deleted}`);

  if (DRY) {
    console.log('\n--dry：到此为止，没有创建 tree/commit。');
    return;
  }

  const tree = await api('POST', `/repos/${REPO}/git/trees`, {
    base_tree: remoteCommit.tree.sha,
    tree: entries,
  });
  console.log('新 tree: ' + tree.sha.slice(0, 10));

  const message = sh('git log -1 --pretty=%B').trim();
  const commit = await api('POST', `/repos/${REPO}/git/commits`, {
    message,
    tree: tree.sha,
    parents: [remoteSha],
  });
  console.log('新 commit: ' + commit.sha.slice(0, 10));

  // force:false —— 期间若有人推了，这里会失败而不是覆盖
  await api('PATCH', `/repos/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: false });
  console.log('已更新 refs/heads/' + BRANCH);

  // 让本地 origin/main 跟上，后续 diff 才有正确的基准
  spawnSync('git', ['update-ref', 'refs/remotes/origin/' + BRANCH, commit.sha], { cwd: CWD });
  console.log('\n✓ 推送完成：https://github.com/' + REPO + '/commit/' + commit.sha);
})().catch((e) => {
  console.error('\n✗ ' + e.message);
  process.exit(1);
});
