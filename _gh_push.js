/**
 * _gh_push.js —— 走 GitHub REST API 推送，用于 https://github.com 被阻断、但
 * api.github.com 仍可访问的网络环境。
 *
 * 用法: node _gh_push.js [--dry]
 *
 * 为什么需要它：
 *   这台机器上 github.com:443 连不上（`git push` 报 "CONNECT tunnel failed"），
 *   而 api.github.com 直连正常。两者是不同域名、不同线路，所以 git 的 smart
 *   HTTP 传输全废，但 Git Data API（blobs / trees / commits / refs）可用 ——
 *   那套接口足够把提交推上去。
 *
 * 做的事情（和 `git push` 等价，只是换了传输层）：
 *   1. 读远程 main 的 commit sha 与根 tree sha
 *   2. `git rev-list --reverse <remote>..HEAD` 列出每一个待推提交
 *   3. **逐个**提交推送：每个提交 `git diff <parent> <sha>` 算出自己的增量，
 *      POST /git/blobs（base64，二进制走 Buffer）→ POST /git/trees
 *      （base_tree = 上一层 tree）→ POST /git/commits（parents = 上一层 sha，
 *      message / author / committer 全部照抄本地那次提交）
 *   4. 最后一次 PATCH /git/refs/heads/main
 *
 *   早先的版本把 `git diff <remote> HEAD` 的净变更合成一个 commit，多个本地
 *   提交会被压平、只剩最后一条说明 —— 历史就失真了。现在逐提交走，推完远程
 *   的提交数、说明、时间与本地一致。
 *
 * ⚠️ 不落盘 token：每次运行时用 `git credential fill` 现场取，用完即弃。
 * ⚠️ 二进制文件必须走 Buffer，不能让 execSync 按 utf8 解码 —— 壁纸 webp 会当场损坏。
 * ⚠️ ref 更新带 force:false：期间若有人推过，这里会失败而不是覆盖他人提交。
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

/* 取某个提交里某个文件的原始字节。encoding:'buffer' 是关键，否则 webp 会被 utf8 破坏。 */
function showAt(rev, file) {
  const r = spawnSync('git', ['show', rev + ':' + file], { cwd: CWD, maxBuffer: 1 << 28 });
  if (r.status !== 0) {
    throw new Error('git show 失败: ' + rev + ':' + file + ' ' + (r.stderr || '').toString());
  }
  return r.stdout;
}

/* 取某个提交里某个文件的 git mode（100644 / 100755 / 120000） */
function modeAt(rev, file) {
  const r = spawnSync('git', ['ls-tree', rev, '--', file], { cwd: CWD });
  const line = (r.stdout || Buffer.alloc(0)).toString().trim();
  if (!line) return '100644';
  return line.split(/\s+/)[0];
}

/* 原样搬运本地提交的说明与作者/时间，别让 GitHub 改写成"现在 + token 用户" */
function metaOf(sha) {
  const fmt = '%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B';
  const out = sh(`git log -1 --format=${fmt} ${sha}`);
  const [an, ae, ai, cn, ce, ci, body] = out.split('\x00');
  return {
    author: { name: an, email: ae, date: ai },
    committer: { name: cn, email: ce, date: ci },
    message: (body || '').trim(),
  };
}

/* 把一个提交的变更翻译成 tree entries */
async function entriesFor(sha) {
  // 用 ~1 而不是 ^1：execSync 在 Windows 上经 cmd，^ 会被当转义符吞掉。
  const parent = sh(`git rev-parse ${sha}~1`).trim();
  // ⚠️ `-c core.quotepath=false` 不能少。
  // 默认 core.quotepath=true 时，非 ASCII 路径会输出成 `"docs/\344\272\244..."` ——
  // 带引号、非 ASCII 字节被转成八进制转义。那样拿到的字符串不是真实路径，
  // 后面 `git show <sha>:<那个字符串>` 必然报 "path does not exist"。
  // 关掉之后输出的是原始 UTF-8 路径，可以原样传给 git 与 GitHub API。
  const raw = sh(`git -c core.quotepath=false diff --name-status ${parent} ${sha}`).trim();
  const lines = raw ? raw.split('\n').filter(Boolean) : [];
  const entries = [];
  let added = 0, modified = 0, deleted = 0;

  for (const line of lines) {
    const parts = line.split('\t');
    const st = parts[0][0]; // A / M / D / R / T
    if (st === 'D') {
      entries.push({ path: parts[1], mode: '100644', type: 'blob', sha: null });
      deleted++;
      console.log('   - 删除 ' + parts[1]);
      continue;
    }
    if (st === 'R') {
      // git diff 默认不检测重命名，这里兜个底：删旧 + 建新
      entries.push({ path: parts[1], mode: '100644', type: 'blob', sha: null });
      deleted++;
      const newFile = parts[2];
      const blob = await api('POST', `/repos/${REPO}/git/blobs`, {
        content: showAt(sha, newFile).toString('base64'),
        encoding: 'base64',
      });
      entries.push({ path: newFile, mode: modeAt(sha, newFile), type: 'blob', sha: blob.sha });
      added++;
      console.log('   → 重命名 ' + parts[1] + ' → ' + newFile);
      continue;
    }

    const buf = showAt(sha, parts[1]);
    const blob = await api('POST', `/repos/${REPO}/git/blobs`, {
      content: buf.toString('base64'),
      encoding: 'base64',
    });
    entries.push({ path: parts[1], mode: modeAt(sha, parts[1]), type: 'blob', sha: blob.sha });
    if (st === 'A') added++;
    else modified++;
    console.log('   ' + (st === 'A' ? '+' : '~') + ' ' + parts[1] + '  (' + buf.length + ' B)');
  }
  return { entries, added, modified, deleted, total: lines.length };
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

  // 判定本地这条历史与远程是什么关系。两种合法情况：
  //   a) 远程 sha 本地就有，且是 HEAD 的祖先 —— 正常快进
  //   b) 远程 sha 本地没有，但它的 tree 与本地某个提交完全相同 —— 那个提交
  //      是"孪生"：之前通过 REST 推过，内容一致、SHA 因为重建提交而不同。
  //      这时从孪生之后的提交开始推，parent 用远程 sha。
  // 其它情况（远程真有本地没有的提交）一律中止，不覆盖别人的工作。
  const hasRemoteCommit =
    spawnSync('git', ['cat-file', '-e', remoteSha + '^{commit}'], { cwd: CWD }).status === 0;

  let commits;

  if (hasRemoteCommit) {
    const isAncestor = spawnSync('git', ['merge-base', '--is-ancestor', remoteSha, 'HEAD'], { cwd: CWD });
    if (isAncestor.status !== 0) {
      console.error(
        '\n⚠️ 远程 HEAD 不是本地 HEAD 的祖先 —— 远程有本地没有的提交。\n' +
          '   为了不覆盖别人的工作，已中止。请先 git fetch 合并后再推。'
      );
      process.exit(2);
    }
    commits = sh(`git rev-list --reverse ${remoteSha}..HEAD`)
      .trim()
      .split('\n')
      .filter(Boolean);
  } else {
    const chain = sh('git rev-list HEAD').trim().split('\n');
    let twinIdx = -1;
    for (let i = 0; i < chain.length; i++) {
      // `git rev-parse <sha>^{tree}` 里的 ^ 会被 cmd 当转义符吃掉（execSync 在
      // Windows 上走 cmd），所以用 %T 取 tree sha，别再写 ^。
      const t = sh(`git show -s --format=%T ${chain[i]}`).trim();
      if (t === remoteCommit.tree.sha) {
        twinIdx = i;
        break;
      }
    }
    if (twinIdx < 0) {
      console.error(
        '\n⚠️ 远程 HEAD 在本地不存在，且没有任何本地提交与它内容一致。\n' +
          '   说明远程有本地没有的提交，已中止。请先同步远程再推。'
      );
      process.exit(2);
    }
    console.log(
      '  远程 HEAD 与本地 ' + chain[twinIdx].slice(0, 7) + ' 内容一致（tree 相同），按已同步处理'
    );
    // chain 是新 → 旧；待推的是孪生之后（更新）的那些，反转成旧 → 新
    commits = chain.slice(0, twinIdx).reverse();
  }

  console.log('  待推提交: ' + commits.length + ' 个\n');

  let baseTree = remoteCommit.tree.sha;
  let parentSha = remoteSha;
  let lastSha = remoteSha;

  for (let i = 0; i < commits.length; i++) {
    const sha = commits[i];
    const meta = metaOf(sha);
    console.log(`[${i + 1}/${commits.length}] ${sha.slice(0, 7)}  ${meta.message.split('\n')[0]}`);

    const { entries, added, modified, deleted, total } = await entriesFor(sha);
    console.log(`   ${total} 个文件（+${added} ~${modified} -${deleted}）`);
    if (!total) {
      console.log('   （空提交，跳过）');
      continue;
    }

    if (DRY) {
      console.log('   --dry：未创建 tree/commit\n');
      continue;
    }

    const tree = await api('POST', `/repos/${REPO}/git/trees`, {
      base_tree: baseTree,
      tree: entries,
    });
    const commit = await api('POST', `/repos/${REPO}/git/commits`, {
      message: meta.message,
      tree: tree.sha,
      parents: [parentSha],
      author: meta.author,
      committer: meta.committer,
    });
    console.log('   → 远程 commit ' + commit.sha.slice(0, 10) + '\n');

    baseTree = tree.sha;
    parentSha = commit.sha;
    lastSha = commit.sha;
  }

  if (DRY) {
    console.log('--dry：到此为止，没有创建 tree/commit，也没有动 ref。');
    return;
  }

  if (lastSha === remoteSha) {
    console.log('没有需要更新的内容。');
    return;
  }

  // force:false —— 期间若有人推了，这里会失败而不是覆盖
  await api('PATCH', `/repos/${REPO}/git/refs/heads/${BRANCH}`, { sha: lastSha, force: false });
  console.log('已更新 refs/heads/' + BRANCH + ' → ' + lastSha.slice(0, 10));

  // 让本地 origin/main 跟上，后续 diff 才有正确的基准
  spawnSync('git', ['update-ref', 'refs/remotes/origin/' + BRANCH, lastSha], { cwd: CWD });
  console.log('\n✓ 推送完成：https://github.com/' + REPO + '/commits/' + BRANCH);
})().catch((e) => {
  console.error('\n✗ ' + e.message);
  process.exit(1);
});
