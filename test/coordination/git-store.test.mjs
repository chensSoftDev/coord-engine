import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  GitCoordinationStore,
  GitStoreError,
} from '../../lib/coordination/git-store.mjs';
import { createGitFixture, runGit } from './fixtures.mjs';

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

function assertNoStoreTemps(tempRoot) {
  const leftovers = readdirSync(tempRoot)
    .filter((name) => name.startsWith('luggage-coordination-'));
  assert.deepEqual(leftovers, []);
}

function concurrentMutations(entries) {
  let arrivals = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });

  return entries.map(([path, value]) => {
    let firstAttempt = true;
    return async (snapshot) => {
      snapshot.writeJson(path, value);
      if (!firstAttempt) return;
      firstAttempt = false;
      arrivals += 1;
      if (arrivals === entries.length) release();
      await gate;
    };
  });
}

test('initializes an orphan coordination branch and reads its snapshot', async (t) => {
  const fixture = createGitFixture(t);
  const store = createStore(fixture.clientA, fixture.tempRoot);
  const originalBranch = runGit(fixture.clientA, ['branch', '--show-current']);

  const initialized = await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const repeated = await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const snapshot = await store.readSnapshot();

  assert.equal(initialized.created, true);
  assert.equal(repeated.created, false);
  assert.match(initialized.sha, /^[0-9a-f]{40}$/);
  assert.deepEqual(snapshot.readJson('schema.json'), {
    schemaVersion: 2,
    initializedAt: '2026-07-17T00:00:00.000Z',
  });
  assert.equal(snapshot.readText('baseline/BACKLOG.md'), '| I-001 | fixture |\n');
  assert.equal(runGit(fixture.clientA, ['branch', '--show-current']), originalBranch);
  assertNoStoreTemps(fixture.tempRoot);
});

test('updates state without checking out coordination in the caller worktree', async (t) => {
  const fixture = createGitFixture(t);
  const storeA = createStore(fixture.clientA, fixture.tempRoot);
  const storeB = createStore(fixture.clientB, fixture.tempRoot);
  await storeA.initialize();
  const originalBranch = runGit(fixture.clientA, ['branch', '--show-current']);

  const result = await storeA.update({
    operation: 'create requirement I-057',
    operationId: 'operation-create-i-057',
    mutate(snapshot) {
      snapshot.writeJson('requirements/I-057.json', {
        schemaVersion: 1,
        id: 'I-057',
      });
    },
  });
  const remoteSnapshot = await storeB.readSnapshot();

  assert.equal(result.attempts, 1);
  assert.equal(result.recovered, false);
  assert.deepEqual(remoteSnapshot.readJson('requirements/I-057.json'), {
    schemaVersion: 1,
    id: 'I-057',
  });
  assert.equal(
    remoteSnapshot.readJson('operations/last.json').operationId,
    'operation-create-i-057',
  );
  assert.equal(runGit(fixture.clientA, ['branch', '--show-current']), originalBranch);
  assertNoStoreTemps(fixture.tempRoot);
});

test('rejects one stale writer when retries are disabled', async (t) => {
  const fixture = createGitFixture(t);
  const storeA = createStore(fixture.clientA, fixture.tempRoot, { maxRetries: 0 });
  const storeB = createStore(fixture.clientB, fixture.tempRoot, { maxRetries: 0 });
  await storeA.initialize();
  const [mutateA, mutateB] = concurrentMutations([
    ['requirements/I-057.json', { schemaVersion: 1, id: 'I-057' }],
    ['requirements/I-058.json', { schemaVersion: 1, id: 'I-058' }],
  ]);

  const results = await Promise.allSettled([
    storeA.update({ operation: 'writer A', operationId: 'writer-a', mutate: mutateA }),
    storeB.update({ operation: 'writer B', operationId: 'writer-b', mutate: mutateB }),
  ]);

  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  const rejected = results.find(({ status }) => status === 'rejected');
  assert.ok(rejected.reason instanceof GitStoreError);
  assert.equal(rejected.reason.code, 'STALE_COORDINATION_REF');
  assert.equal(rejected.reason.exitCode, 11);
  const snapshot = await storeA.readSnapshot();
  const written = [
    snapshot.has('requirements/I-057.json'),
    snapshot.has('requirements/I-058.json'),
  ].filter(Boolean);
  assert.equal(written.length, 1);
  assertNoStoreTemps(fixture.tempRoot);
});

test('retries a stale writer without overwriting the winning commit', async (t) => {
  const fixture = createGitFixture(t);
  const storeA = createStore(fixture.clientA, fixture.tempRoot, { maxRetries: 1 });
  const storeB = createStore(fixture.clientB, fixture.tempRoot, { maxRetries: 1 });
  await storeA.initialize();
  const [mutateA, mutateB] = concurrentMutations([
    ['requirements/I-057.json', { schemaVersion: 1, id: 'I-057' }],
    ['requirements/I-058.json', { schemaVersion: 1, id: 'I-058' }],
  ]);

  const results = await Promise.all([
    storeA.update({ operation: 'writer A', operationId: 'retry-a', mutate: mutateA }),
    storeB.update({ operation: 'writer B', operationId: 'retry-b', mutate: mutateB }),
  ]);
  const snapshot = await storeA.readSnapshot();

  assert.deepEqual(results.map(({ attempts }) => attempts).sort(), [1, 2]);
  assert.equal(snapshot.readJson('requirements/I-057.json').id, 'I-057');
  assert.equal(snapshot.readJson('requirements/I-058.json').id, 'I-058');
  assertNoStoreTemps(fixture.tempRoot);
});

test('recovers when the push succeeded but its client result was lost', async (t) => {
  const fixture = createGitFixture(t);
  let loseResult = true;
  const store = createStore(fixture.clientA, fixture.tempRoot, {
    afterPush() {
      if (loseResult) {
        loseResult = false;
        throw new Error('simulated connection reset after receive');
      }
    },
  });
  await store.initialize();

  const result = await store.update({
    operation: 'recover result',
    operationId: 'recover-operation',
    mutate(snapshot) {
      snapshot.writeJson('requirements/I-057.json', {
        schemaVersion: 1,
        id: 'I-057',
      });
    },
  });

  await store.update({
    operation: 'later operation',
    operationId: 'later-operation',
    mutate(snapshot) {
      snapshot.writeJson('requirements/I-058.json', {
        schemaVersion: 1,
        id: 'I-058',
      });
    },
  });

  assert.equal(result.recovered, true);
  assert.equal((await store.reconcileOperation('recover-operation')).applied, true);
  assert.equal((await store.reconcileOperation('different-operation')).applied, false);
  assertNoStoreTemps(fixture.tempRoot);
});

test('doctor removes only abandoned coordination temp directories', async (t) => {
  const fixture = createGitFixture(t);
  const store = createStore(fixture.clientA, fixture.tempRoot);
  const abandoned = join(fixture.tempRoot, 'luggage-coordination-abandoned');
  const active = join(fixture.tempRoot, 'luggage-coordination-active');
  mkdirSync(abandoned);
  mkdirSync(active);
  mkdirSync(join(fixture.tempRoot, 'keep-me'));
  utimesSync(abandoned, new Date('2026-07-16T23:30:00.000Z'), new Date('2026-07-16T23:30:00.000Z'));
  utimesSync(active, new Date('2026-07-16T23:55:00.000Z'), new Date('2026-07-16T23:55:00.000Z'));

  const result = await store.doctor();

  assert.deepEqual(result.removed, ['luggage-coordination-abandoned']);
  assert.deepEqual(
    readdirSync(fixture.tempRoot).sort(),
    ['keep-me', 'luggage-coordination-active'],
  );
});

test('rejects operation ids that cannot be used as safe audit paths', async (t) => {
  const fixture = createGitFixture(t);
  const store = createStore(fixture.clientA, fixture.tempRoot);
  await store.initialize();

  await assert.rejects(
    store.update({
      operation: 'unsafe operation id',
      operationId: '../escape',
      mutate(snapshot) {
        snapshot.writeJson('requirements/I-057.json', {
          schemaVersion: 1,
          id: 'I-057',
        });
      },
    }),
    /invalid operation id/,
  );
  assertNoStoreTemps(fixture.tempRoot);
});

test('rejects an unsupported root schema before pushing it', async (t) => {
  const fixture = createGitFixture(t);
  const store = createStore(fixture.clientA, fixture.tempRoot);
  await store.initialize();

  await assert.rejects(
    store.update({
      operation: 'write unsupported schema',
      operationId: 'unsupported-schema',
      mutate(snapshot) {
        snapshot.writeJson('schema.json', {
          schemaVersion: 3,
          initializedAt: '2026-07-17T00:00:00.000Z',
        });
      },
    }),
    /unsupported schema version/,
  );
  assert.equal((await store.readSnapshot()).readJson('schema.json').schemaVersion, 2);
  assertNoStoreTemps(fixture.tempRoot);
});

test('initialization cannot read a backlog outside the repository root', async (t) => {
  const fixture = createGitFixture(t);
  const store = createStore(fixture.clientA, fixture.tempRoot);
  writeFileSync(join(fixture.root, 'outside.env'), 'TOKEN=do-not-commit\n');

  await assert.rejects(
    store.initialize({ fromBacklog: '../outside.env' }),
    /fromBacklog must be BACKLOG.md at the repository root/,
  );
  assertNoStoreTemps(fixture.tempRoot);
});

// I-127: the batch loader (ls-tree -z + cat-file --batch) must reproduce the
// old per-file `git show` results exactly, including multibyte content whose
// byte length differs from its UTF-16 length.
test('batch snapshot loading matches git show byte-for-byte', async (t) => {
  const fixture = createGitFixture(t);
  const store = createStore(fixture.clientA, fixture.tempRoot);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  await store.update({
    operation: 'write multibyte state',
    operationId: 'multibyte-state',
    mutate(snapshot) {
      snapshot.writeText('requirements/I-127.json', '{"id":"I-127","title":"快照批量加载 🚀"}\n');
      snapshot.writeText('notes/empty.txt', '');
      snapshot.writeText('notes/no-trailing-newline.txt', 'end-without-newline');
    },
  });

  const snapshot = await store.readSnapshot();
  assert.ok(snapshot.paths().length >= 5);
  for (const path of snapshot.paths()) {
    const expected = execFileSync('git', ['show', `${snapshot.sha}:${path}`], {
      cwd: fixture.clientA,
      encoding: 'utf8',
    });
    assert.equal(snapshot.readText(path), expected, `content mismatch for ${path}`);
  }
  assert.equal(snapshot.readText('notes/empty.txt'), '');
  assertNoStoreTemps(fixture.tempRoot);
});

// I-127: a second fetchSha within the TTL must not hit the remote; a fresh
// call must. Breaking the remote URL makes any real fetch fail loudly.
test('fetchSha reuses the process-local ref within the TTL and refreshes on demand', async (t) => {
  const fixture = createGitFixture(t);
  const store = createStore(fixture.clientA, fixture.tempRoot, { fetchTtlMs: 60_000 });
  await store.initialize();

  const sha = store.fetchSha();
  runGit(fixture.clientA, ['remote', 'set-url', 'origin', join(fixture.root, 'gone.git')]);

  assert.equal(store.fetchSha(), sha);
  assert.throws(() => store.fetchSha({ fresh: true }), /failed to fetch/);
  assertNoStoreTemps(fixture.tempRoot);
});

// I-127: after a successful push the process cache already points at the new
// ref, so a follow-up readSnapshot needs neither another fetch nor the remote.
test('a successful update keeps the process cache consistent with the pushed ref', async (t) => {
  const fixture = createGitFixture(t);
  const store = createStore(fixture.clientA, fixture.tempRoot, { fetchTtlMs: 60_000 });
  await store.initialize();
  const update = await store.update({
    operation: 'cache-aware write',
    operationId: 'cache-aware-write',
    mutate(snapshot) {
      snapshot.writeJson('requirements/I-127.json', { schemaVersion: 1, id: 'I-127' });
    },
  });
  runGit(fixture.clientA, ['remote', 'set-url', 'origin', join(fixture.root, 'gone.git')]);

  const snapshot = await store.readSnapshot();
  assert.equal(snapshot.sha, update.sha);
  assert.equal(snapshot.readJson('requirements/I-127.json').id, 'I-127');
  assertNoStoreTemps(fixture.tempRoot);
});

// I-127: coordination trees only ever contain text blobs; a gitlink (or any
// non-blob entry) means state corruption and must fail loudly instead of
// silently dropping the entry.
test('rejects coordination trees containing non-blob entries', async (t) => {
  const fixture = createGitFixture(t);
  const store = createStore(fixture.clientA, fixture.tempRoot);
  await store.initialize();

  // initialize() commits from a temp clone, so fetch the objects into clientA
  // before crafting the corrupt tree.
  runGit(fixture.clientA, [
    'fetch', 'origin', '+refs/heads/coordination:refs/remotes/origin/coordination',
  ]);
  const schemaBlob = runGit(fixture.clientA, ['rev-parse', 'origin/coordination:schema.json']);
  const mainCommit = runGit(fixture.clientA, ['rev-parse', 'HEAD']);
  const tree = runGit(fixture.clientA, ['mktree'], {
    input: `100644 blob ${schemaBlob}\tschema.json\n160000 commit ${mainCommit}\tlinked\n`,
    stdio: ['pipe', 'pipe', 'pipe'], // fixture runGit defaults stdin to ignore
  });
  const corrupt = runGit(fixture.clientA, ['commit-tree', tree, '-m', 'corrupt coordination tree']);
  runGit(fixture.clientA, ['push', '--force', 'origin', `${corrupt}:refs/heads/coordination`]);

  await assert.rejects(
    store.readSnapshot(),
    (error) => {
      assert.equal(error.code, 'INVALID_STATE_TREE');
      assert.match(error.message, /linked/);
      return true;
    },
  );
  assertNoStoreTemps(fixture.tempRoot);
});

// I-130 (D5): both push sites must pass --no-verify. A PATH shim records the
// exact argv of every git invocation, so the assertion covers initialize()
// (fresh temp clone) and update() (temp worktree) alike.
test('pushes coordination refs with --no-verify', async (t) => {
  const fixture = createGitFixture(t);
  const shimDir = join(fixture.root, 'git-shim');
  mkdirSync(shimDir);
  const logPath = join(fixture.root, 'git-argv.log');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  writeFileSync(
    join(shimDir, 'git'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${logPath}'\nexec '${realGit}' "$@"\n`,
    { mode: 0o755 },
  );
  const originalPath = process.env.PATH;
  process.env.PATH = `${shimDir}:${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; });

  const store = createStore(fixture.clientA, fixture.tempRoot);
  await store.initialize();
  const result = await store.update({
    operation: 'record shimmed push',
    operationId: 'shimmed-push',
    mutate(snapshot) {
      snapshot.writeJson('requirements/I-130.json', { schemaVersion: 1, id: 'I-130' });
    },
  });

  assert.equal(result.changed, true);
  const pushes = readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('push '));
  assert.equal(pushes.length, 2);
  for (const line of pushes) {
    assert.match(line, /^push --no-verify --force-with-lease=refs\/heads\/coordination/);
    assert.match(line, /HEAD:refs\/heads\/coordination$/);
  }
  assertNoStoreTemps(fixture.tempRoot);
});

// I-130 (D5): the production failure mode — the repo's local pre-push hook
// (product CI) fires for pushes from the update() temp worktree, which shares
// the main repo's hooks directory, and previously surfaced as
// UNCERTAIN_PUSH_RESULT on every write. --no-verify must bypass it.
test('a failing local pre-push hook does not block coordination updates', async (t) => {
  const fixture = createGitFixture(t);
  writeFileSync(
    join(fixture.clientA, '.git', 'hooks', 'pre-push'),
    '#!/bin/sh\necho "product CI refuses temp worktrees" >&2\nexit 1\n',
    { mode: 0o755 },
  );

  const store = createStore(fixture.clientA, fixture.tempRoot);
  await store.initialize();
  const result = await store.update({
    operation: 'write behind a failing pre-push hook',
    operationId: 'pre-push-hook-bypass',
    mutate(snapshot) {
      snapshot.writeJson('requirements/I-130.json', { schemaVersion: 1, id: 'I-130' });
    },
  });

  assert.equal(result.changed, true);
  assert.equal(
    (await store.readSnapshot()).readJson('requirements/I-130.json').id,
    'I-130',
  );
  assertNoStoreTemps(fixture.tempRoot);
});

// ============================================================================
// I-131 (E6): --reuse-sha——首次 fetchSha 短路不发 fetch；写安全由
// force-with-lease CAS + 重试真实 fetch 保证。
// ============================================================================

function installFetchCountingShim(t, fixture) {
  const shimDir = join(fixture.root, 'git-shim');
  mkdirSync(shimDir);
  const logPath = join(fixture.root, 'git-argv.log');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  writeFileSync(
    join(shimDir, 'git'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${logPath}'\nexec '${realGit}' "$@"\n`,
    { mode: 0o755 },
  );
  const originalPath = process.env.PATH;
  process.env.PATH = `${shimDir}:${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; });
  return () => readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('fetch '));
}

test('reuse-sha short-circuits the first fetch and reads the reused snapshot', async (t) => {
  const fixture = createGitFixture(t);
  const writer = createStore(fixture.clientA, fixture.tempRoot);
  await writer.initialize();
  const written = await writer.update({
    operation: 'seed reuse sha state',
    mutate(snapshot) {
      snapshot.writeJson('requirements/I-131.json', { schemaVersion: 1, id: 'I-131' });
    },
  });
  const fetchLines = installFetchCountingShim(t, fixture);

  const reader = createStore(fixture.clientA, fixture.tempRoot, { reuseSha: written.sha });
  const snapshot = await reader.readSnapshot();

  assert.equal(snapshot.sha, written.sha);
  assert.equal(snapshot.readJson('requirements/I-131.json').id, 'I-131');
  assert.deepEqual(fetchLines(), []);
});

test('a stale reuse-sha write retries through the CAS path with one real fetch', async (t) => {
  const fixture = createGitFixture(t);
  const storeA = createStore(fixture.clientA, fixture.tempRoot);
  await storeA.initialize();
  const base = await storeA.readSnapshot();
  await storeA.update({
    operation: 'advance the remote tip past the reused sha',
    mutate(snapshot) {
      snapshot.writeJson('requirements/I-001.json', { schemaVersion: 1, id: 'I-001' });
    },
  });
  const fetchLines = installFetchCountingShim(t, fixture);

  const storeB = createStore(fixture.clientA, fixture.tempRoot, { reuseSha: base.sha });
  const result = await storeB.update({
    operation: 'write from a stale reuse sha',
    mutate(snapshot) {
      snapshot.writeJson('requirements/I-002.json', { schemaVersion: 1, id: 'I-002' });
    },
  });

  assert.equal(result.changed, true);
  assert.equal(result.attempts, 2);
  // Exactly one real fetch: the retry path's fresh fetch after the CAS
  // rejection; the first attempt consumed the reuse sha without fetching.
  assert.equal(fetchLines().length, 1);
  const snapshot = await storeA.readSnapshot();
  assert.equal(snapshot.readJson('requirements/I-001.json').id, 'I-001');
  assert.equal(snapshot.readJson('requirements/I-002.json').id, 'I-002');
  assertNoStoreTemps(fixture.tempRoot);
});

test('an invalid reuseSha is rejected at construction', (t) => {
  const fixture = createGitFixture(t);
  assert.throws(
    () => createStore(fixture.clientA, fixture.tempRoot, { reuseSha: 'not-a-sha' }),
    (error) => error.code === 'INVALID_REUSE_SHA' && error.exitCode === 14,
  );
});

// I-131 (E6 review fix): initialize() must always touch the remote to decide
// whether the coordination branch exists — a reuse sha never fakes that.
test('reuse-sha does not short-circuit initialize', async (t) => {
  const fixture = createGitFixture(t);
  const fetchLines = installFetchCountingShim(t, fixture);

  const store = createStore(fixture.clientA, fixture.tempRoot, {
    reuseSha: 'a'.repeat(40),
  });
  const result = await store.initialize();

  assert.equal(result.created, true);
  assert.ok(fetchLines().length >= 1, 'initialize must really fetch');
});
