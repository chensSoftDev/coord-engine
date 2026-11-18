import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { GitCoordinationStore } from '../../lib/coordination/git-store.mjs';
import { cleanupFixtureRoot, createGitFixture, runGit } from './fixtures.mjs';

// I-255 回归测试：spawnSync 的 stdout 默认 maxBuffer 只有 1MB，协调分支变大后
// `ls-tree -r -z`（快照读取）与 `show HEAD:BACKLOG.md`（baseline 采集）都会超过
// 1MB，git-store 的 runGit/runGitBuffer 一旦缺失 maxBuffer 就会以 ENOBUFS 中断，
// 协调读写整体瘫痪。两个用例分别驱动这两条路径，并在数据规模上断言确实超过 1MB，
// 保证「去掉 maxBuffer 修复后测试必须红」。
const SPAWN_SYNC_DEFAULT_BYTES = 1024 * 1024;

function createStore(cwd, tempRoot, overrides = {}) {
  return new GitCoordinationStore({
    cwd,
    remote: 'origin',
    branch: 'coordination',
    tempRoot,
    clock: () => new Date('2026-07-17T00:00:00.000Z'),
    ...overrides,
  });
}

// Each tracked entry in `ls-tree -r -z` costs ~54 bytes of metadata plus the
// full path, so deep nesting with long component names is the cheapest way to
// push the listing past 1MB (3000 × ~470B ≈ 1.4MB) without a huge worktree.
function largeTreePath(index) {
  const digits = String(index).padStart(4, '0');
  const segments = [...digits, index % 7, (index * 3) % 11, (index * 5) % 13]
    .map((part) => `segment-${String(part).padStart(36, '0')}`);
  return ['tree', ...segments, `payload-${digits}-${'y'.repeat(30)}.json`].join('/');
}

test('enoobufs: snapshot reads survive a coordination tree whose ls-tree output exceeds the 1MB spawnSync default', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'luggage-coordination-enoobufs-'));
  t.after(async () => { await cleanupFixtureRoot(root); });
  const repo = join(root, 'repo');
  const tempRoot = join(root, 'temps');
  mkdirSync(tempRoot, { recursive: true });

  runGit(root, ['init', '--initial-branch=coordination', repo]);
  runGit(repo, ['config', 'user.name', 'Coordination Test']);
  runGit(repo, ['config', 'user.email', 'coordination-test@example.invalid']);
  runGit(repo, ['config', 'maintenance.auto', 'false']);
  runGit(repo, ['config', 'gc.auto', '0']);

  const fileCount = 3000;
  const payloads = new Map();
  for (let index = 0; index < fileCount; index += 1) {
    const relative = largeTreePath(index);
    const target = join(repo, relative);
    mkdirSync(dirname(target), { recursive: true });
    // ~400B per blob so the `cat-file --batch` response also crosses 1MB.
    const payload = `enoobufs payload ${index}\n${'x'.repeat(400)}\n`;
    writeFileSync(target, payload);
    payloads.set(relative, payload);
  }
  runGit(repo, ['add', '-A']);
  // --quiet: the 3000-line "create mode" summary itself exceeds 1MB of stdout.
  runGit(repo, ['commit', '--quiet', '-m', 'test: oversized coordination tree']);
  const sha = runGit(repo, ['rev-parse', 'HEAD']);

  // Precondition: the exact command readSnapshotFiles runs really is >1MB.
  const listing = execFileSync('git', ['ls-tree', '-r', '-z', sha], {
    cwd: repo,
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.ok(listing.length > SPAWN_SYNC_DEFAULT_BYTES, `ls-tree -r -z output must exceed 1MB (got ${listing.length} bytes)`);

  const store = createStore(repo, tempRoot);
  const files = store.readSnapshotFiles(sha);

  assert.equal(files.length, fileCount);
  const sample = largeTreePath(1234);
  assert.equal(files.find(([path]) => path === sample)?.[1], payloads.get(sample));
});

test('enoobufs: initialize captures a >1MB BACKLOG baseline without ENOBUFS', async (t) => {
  const fixture = createGitFixture(t);

  // Oversize BACKLOG.md so `git show HEAD:BACKLOG.md` (runGit) exceeds 1MB.
  const baseline = `# I-255 enoobufs baseline\n${'z'.repeat(120)}\n`.repeat(9000);
  assert.ok(Buffer.byteLength(baseline) > SPAWN_SYNC_DEFAULT_BYTES);
  writeFileSync(join(fixture.clientA, 'BACKLOG.md'), baseline);
  runGit(fixture.clientA, ['add', 'BACKLOG.md']);
  runGit(fixture.clientA, ['commit', '-m', 'test: grow BACKLOG baseline past 1MB']);
  runGit(fixture.clientA, ['push', 'origin', 'main']);

  const store = createStore(fixture.clientA, fixture.tempRoot);
  const initialized = await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const snapshot = await store.readSnapshot();

  assert.equal(initialized.created, true);
  assert.equal(snapshot.readText('baseline/BACKLOG.md'), baseline);
  assert.deepEqual(snapshot.readJson('schema.json'), {
    schemaVersion: 2,
    initializedAt: '2026-07-17T00:00:00.000Z',
  });
});
