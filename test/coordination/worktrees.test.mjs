import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { main } from '../../lib/coordination/cli.mjs';
import { GitCoordinationStore } from '../../lib/coordination/git-store.mjs';
import {
  bindRequirementVersion,
  claimRequirement,
} from '../../lib/coordination/requirements.mjs';
import {
  createRequirementWorktree,
  gitCommonDir,
  initializeSession,
  joinRequirementWorktree,
  loadSession,
  readWorkstreamBinding,
} from '../../lib/coordination/worktrees.mjs';
import { createGitFixture, createMemoryIo, runGit } from './fixtures.mjs';

function createStore(cwd, tempRoot) {
  return new GitCoordinationStore({
    cwd,
    remote: 'origin',
    branch: 'coordination',
    tempRoot,
    clock: () => new Date('2026-07-17T00:00:00.000Z'),
  });
}

async function claimBoundRequirement(store, title, version = 'v0.2.32') {
  const claimed = await claimRequirement({
    store,
    type: 'I',
    title,
    profile: 'tooling',
    backlogText: '| I-001 | fixture |\n',
  });
  await bindRequirementVersion({ store, id: claimed.id, version });
  return claimed.id;
}

test('stores tool-neutral sessions in the Git common dir only', async (t) => {
  const fixture = createGitFixture(t);
  const before = runGit(fixture.clientA, ['status', '--short']);

  for (const agent of ['codex', 'kimi', 'claude-code']) {
    const session = initializeSession({
      cwd: fixture.clientA,
      agent,
      user: 'developer',
      host: 'workstation',
      clock: () => new Date('2026-07-17T00:00:00.000Z'),
    });
    assert.match(session.sessionId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(loadSession({ cwd: fixture.clientA, sessionId: session.sessionId }), session);
    assert.equal(JSON.stringify(session).includes('token'), false);
  }

  assert.equal(runGit(fixture.clientA, ['status', '--short']), before);
});

test('session init and show expose stable JSON through the CLI', async (t) => {
  const fixture = createGitFixture(t);
  const initializedIo = createMemoryIo();
  const initializedExit = await main([
    'session', 'init', '--agent', 'codex', '--user', 'developer', '--json',
  ], {
    ...initializedIo.io,
    env: {
      COORD_CWD: fixture.clientA,
      COORD_HOST: 'workstation',
    },
    clock: () => new Date('2026-07-17T00:00:00.000Z'),
  });
  assert.equal(initializedExit, 0, initializedIo.stderr.join(''));
  const initialized = JSON.parse(initializedIo.stdout.join(''));

  const shownIo = createMemoryIo();
  const shownExit = await main(['session', 'show', '--json'], {
    ...shownIo.io,
    env: {
      COORD_CWD: fixture.clientA,
      COORD_SESSION_ID: initialized.data.sessionId,
    },
  });
  assert.equal(shownExit, 0, shownIo.stderr.join(''));
  assert.deepEqual(JSON.parse(shownIo.stdout.join('')).data, initialized.data);
});

test('creates a bound feature worktree without switching the caller branch', async (t) => {
  const fixture = createGitFixture(t);
  const store = createStore(fixture.clientA, fixture.tempRoot);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const id = await claimBoundRequirement(store, 'Worktree requirement');
  const session = initializeSession({
    cwd: fixture.clientA,
    agent: 'codex',
    user: 'developer',
    host: 'workstation',
  });
  const originalBranch = runGit(fixture.clientA, ['branch', '--show-current']);

  const result = await createRequirementWorktree({
    cwd: fixture.clientA,
    store,
    id,
    topic: 'cross-agent-coordination',
    session,
  });

  assert.equal(result.branch, 'feature/v0.2.32/cross-agent-coordination');
  assert.equal(existsSync(result.path), true);
  assert.equal(runGit(result.path, ['branch', '--show-current']), result.branch);
  assert.equal(runGit(fixture.clientA, ['branch', '--show-current']), originalBranch);
  assert.equal((await store.readSnapshot()).readJson(`requirements/${id}.json`).branch, result.branch);
  assert.deepEqual(readWorkstreamBinding({ cwd: fixture.clientA, id }).sessions, [session.sessionId]);
  assert.match(
    readFileSync(`${result.path}/BACKLOG.md`, 'utf8'),
    new RegExp(`\\| ${id} \\| Worktree requirement \\| 待评审 \\| ⚪ Todo \\| v0\\.2\\.32 \\|`),
  );
  assert.equal(
    runGit(result.path, ['rev-parse', '--abbrev-ref', '@{upstream}']),
    `origin/${result.branch}`,
  );
  assert.equal(runGit(result.path, ['show', '--format=', '--name-only', 'HEAD']), 'BACKLOG.md');
});

test('reentering the same requirement worktree does not duplicate registration', async (t) => {
  const fixture = createGitFixture(t);
  const store = createStore(fixture.clientA, fixture.tempRoot);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const id = await claimBoundRequirement(store, 'Recoverable worktree');
  const session = initializeSession({
    cwd: fixture.clientA, agent: 'codex', user: 'developer', host: 'workstation',
  });
  const created = await createRequirementWorktree({
    cwd: fixture.clientA, store, id, topic: 'recoverable', session,
  });
  const firstHead = runGit(created.path, ['rev-parse', 'HEAD']);

  const recovered = await createRequirementWorktree({
    cwd: fixture.clientA, store, id, topic: 'recoverable', session,
  });

  assert.equal(recovered.path, created.path);
  assert.equal(runGit(recovered.path, ['rev-parse', 'HEAD']), firstHead);
  const backlog = readFileSync(`${recovered.path}/BACKLOG.md`, 'utf8');
  assert.equal(backlog.split('\n').filter((line) => line.startsWith(`| ${id} |`)).length, 1);
});

test('recovers a worktree created before coordination and local binding were written', async (t) => {
  const fixture = createGitFixture(t);
  const store = createStore(fixture.clientA, fixture.tempRoot);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const id = await claimBoundRequirement(store, 'Crash window worktree');
  const session = initializeSession({
    cwd: fixture.clientA, agent: 'codex', user: 'developer', host: 'workstation',
  });
  const topic = 'crash-window';
  const branch = `feature/v0.2.32/${topic}`;
  const path = join(fixture.clientA, '.worktrees', `${id}-${topic}`);
  runGit(fixture.clientA, ['fetch', 'origin', 'main']);
  runGit(fixture.clientA, ['worktree', 'add', '-b', branch, path, 'origin/main']);

  const recovered = await createRequirementWorktree({
    cwd: fixture.clientA, store, id, topic, session,
  });

  assert.equal(recovered.path, realpathSync(path));
  assert.equal(readWorkstreamBinding({ cwd: fixture.clientA, id }).branch, branch);
  assert.equal((await store.readSnapshot()).readJson(`requirements/${id}.json`).branch, branch);
  assert.match(runGit(path, ['show', `origin/${branch}:BACKLOG.md`]), new RegExp(`\\| ${id} \\|`));
});

test('creates a requirement worktree from the latest remote main, not stale local main', async (t) => {
  const fixture = createGitFixture(t);
  const store = createStore(fixture.clientA, fixture.tempRoot);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const id = await claimBoundRequirement(store, 'Fresh main requirement');
  const session = initializeSession({
    cwd: fixture.clientA,
    agent: 'codex',
    user: 'developer',
    host: 'workstation',
  });
  const staleLocalMain = runGit(fixture.clientA, ['rev-parse', 'main']);
  writeFileSync(`${fixture.clientB}/REMOTE_MAIN.md`, '# latest main\n');
  runGit(fixture.clientB, ['add', 'REMOTE_MAIN.md']);
  runGit(fixture.clientB, ['commit', '-m', 'test: advance remote main']);
  runGit(fixture.clientB, ['push', 'origin', 'main']);
  const latestRemoteMain = runGit(fixture.clientB, ['rev-parse', 'HEAD']);
  assert.notEqual(staleLocalMain, latestRemoteMain);

  const result = await createRequirementWorktree({
    cwd: fixture.clientA,
    store,
    id,
    topic: 'fresh-main',
    session,
  });

  assert.equal(runGit(result.path, ['rev-parse', 'HEAD^']), latestRemoteMain);
  assert.equal(runGit(fixture.clientA, ['rev-parse', 'main']), staleLocalMain);
});

test('different requirements use different worktrees and cannot reuse a path', async (t) => {
  const fixture = createGitFixture(t);
  const store = createStore(fixture.clientA, fixture.tempRoot);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const firstId = await claimBoundRequirement(store, 'First worktree');
  const secondId = await claimBoundRequirement(store, 'Second worktree');
  const session = initializeSession({
    cwd: fixture.clientA, agent: 'codex', user: 'developer', host: 'workstation',
  });
  const first = await createRequirementWorktree({
    cwd: fixture.clientA, store, id: firstId, topic: 'first', session,
  });
  const second = await createRequirementWorktree({
    cwd: fixture.clientA, store, id: secondId, topic: 'second', session,
  });

  assert.notEqual(first.path, second.path);
  assert.notEqual(first.branch, second.branch);
  await assert.rejects(
    joinRequirementWorktree({
      cwd: fixture.clientA,
      store,
      id: secondId,
      path: first.path,
      session,
    }),
    /worktree is already bound to/,
  );
});

test('a second agent session can explicitly join the same requirement workstream', async (t) => {
  const fixture = createGitFixture(t);
  const store = createStore(fixture.clientA, fixture.tempRoot);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const id = await claimBoundRequirement(store, 'Shared workstream');
  const primary = initializeSession({
    cwd: fixture.clientA, agent: 'codex', user: 'developer', host: 'workstation',
  });
  const secondary = initializeSession({
    cwd: fixture.clientA, agent: 'kimi', user: 'developer', host: 'workstation',
  });
  const created = await createRequirementWorktree({
    cwd: fixture.clientA, store, id, topic: 'shared', session: primary,
  });

  const joined = await joinRequirementWorktree({
    cwd: fixture.clientA,
    store,
    id,
    path: created.path,
    session: secondary,
  });

  assert.equal(joined.path, created.path);
  assert.deepEqual(
    readWorkstreamBinding({ cwd: fixture.clientA, id }).sessions.sort(),
    [primary.sessionId, secondary.sessionId].sort(),
  );
});

test('rejects unsafe worktree topics', async (t) => {
  const fixture = createGitFixture(t);
  const store = createStore(fixture.clientA, fixture.tempRoot);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const id = await claimBoundRequirement(store, 'Unsafe topic');
  const session = initializeSession({
    cwd: fixture.clientA, agent: 'codex', user: 'developer', host: 'workstation',
  });

  await assert.rejects(
    createRequirementWorktree({
      cwd: fixture.clientA, store, id, topic: '../escape', session,
    }),
    /invalid worktree topic/,
  );
});

// I-128 (H1): the sessions/current pointer is the default identity; an
// explicitly empty id stays invalid, and a missing/corrupt pointer fails with
// an actionable message.
test('session current pointer provides the default identity', async (t) => {
  const fixture = createGitFixture(t);
  const session = initializeSession({
    cwd: fixture.clientA,
    agent: 'kimi',
    user: 'developer',
    host: 'workstation',
  });

  assert.equal(loadSession({ cwd: fixture.clientA }).sessionId, session.sessionId);
  assert.throws(() => loadSession({ cwd: fixture.clientA, sessionId: '' }), /invalid session id/);

  assert.throws(
    () => loadSession({ cwd: fixture.clientB }),
    (error) => error.code === 'INVALID_SESSION_ID' && /session init/.test(error.message),
  );

  const sessionsDir = join(gitCommonDir(fixture.clientB), 'coordination', 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(sessionsDir, 'current'), 'not-a-session-id\n');
  assert.throws(() => loadSession({ cwd: fixture.clientB }), /invalid session id/);
});

// ============================================================================
// I-130 (D3): `requirement start` CLI——单命令完成 claim + 版本绑定/注册 +
// branch 绑定 + worktree 创建；BACKLOG 迁移列由 migrationAssessment 投影，
// lifecycle 根据 UX impact 落 todo 或 in_dev。
// ============================================================================

test('requirement start CLI composes claim, version binding, branch and worktree', async (t) => {
  const fixture = createGitFixture(t);
  const store = createStore(fixture.clientA, fixture.tempRoot);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const session = initializeSession({
    cwd: fixture.clientA, agent: 'codex', user: 'developer', host: 'workstation',
  });
  const env = {
    COORD_CWD: fixture.clientA,
    COORD_REMOTE: 'origin',
    COORD_BRANCH: 'coordination',
    COORD_TEMP_ROOT: fixture.tempRoot,
    COORD_SESSION_ID: session.sessionId,
    COORD_AGENT: 'codex',
    COORD_USER: 'developer',
  };
  const memory = createMemoryIo();

  const exitCode = await main([
    'requirement', 'start',
    '--type', 'I',
    '--title', 'CLI started requirement',
    '--profile', 'runtime',
    '--ux-impact', 'none',
    '--version', 'v0.9.0',
    '--topic', 'cli-start',
    '--migration', 'yes',
    '--json',
  ], { env, ...memory.io });

  assert.equal(exitCode, 0, memory.stderr.join(''));
  const data = JSON.parse(memory.stdout.join('')).data;
  assert.equal(data.id, 'I-002');
  assert.equal(data.version, 'v0.9.0');
  assert.equal(data.branch, 'feature/v0.9.0/cli-start');
  assert.equal(data.migrationAssessment, '是');
  assert.equal(data.worktree.branch, 'feature/v0.9.0/cli-start');

  const snapshot = await store.readSnapshot();
  const requirement = snapshot.readJson('requirements/I-002.json');
  // I-131 (E2): start lands directly at in_dev with one honest start event.
  assert.equal(requirement.lifecycle, 'in_dev');
  assert.equal(requirement.lifecycleHistory.length, 1);
  assert.deepEqual(
    { ...requirement.lifecycleHistory[0], at: undefined },
    { type: 'start', from: null, to: 'in_dev', actor: 'codex', at: undefined },
  );
  assert.equal(requirement.migrationAssessment, '是');
  assert.equal(requirement.version, 'v0.9.0');
  assert.equal(requirement.branch, 'feature/v0.9.0/cli-start');
  assert.deepEqual(snapshot.readJson('versions/v0.9.0.json').requirements, ['I-002']);

  assert.equal(existsSync(data.worktree.path), true);
  assert.equal(
    runGit(data.worktree.path, ['branch', '--show-current']),
    'feature/v0.9.0/cli-start',
  );
  // The BACKLOG row projects the declared migration assessment and the in_dev
  // landing state (E2) — neither 待评审 nor ⚪ Todo.
  assert.match(
    readFileSync(join(data.worktree.path, 'BACKLOG.md'), 'utf8'),
    /\| I-002 \| CLI started requirement \| 是 \| 🔨 In Dev \| v0\.9\.0 \|/,
  );
  assert.deepEqual(readWorkstreamBinding({ cwd: fixture.clientA, id: 'I-002' }).sessions, [
    session.sessionId,
  ]);
});

test('admin-ui start projects a Todo BACKLOG row and cannot skip UX review', async (t) => {
  const fixture = createGitFixture(t);
  const store = createStore(fixture.clientA, fixture.tempRoot);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const session = initializeSession({ cwd: fixture.clientA, agent: 'codex', user: 'developer', host: 'workstation' });
  const memory = createMemoryIo();
  const exitCode = await main([
    'requirement', 'start', '--type', 'I', '--title', 'Admin screen',
    '--profile', 'runtime', '--ux-impact', 'admin-ui', '--version', 'v0.9.0',
    '--topic', 'admin-screen', '--migration', 'no', '--json',
  ], {
    env: {
      COORD_CWD: fixture.clientA, COORD_REMOTE: 'origin', COORD_BRANCH: 'coordination',
      COORD_TEMP_ROOT: fixture.tempRoot, COORD_SESSION_ID: session.sessionId,
      COORD_AGENT: 'codex', COORD_USER: 'developer',
    },
    ...memory.io,
  });
  assert.equal(exitCode, 0, memory.stderr.join(''));
  const data = JSON.parse(memory.stdout.join('')).data;
  assert.equal(data.lifecycle, 'todo');
  assert.equal((await store.readSnapshot()).readJson('requirements/I-002.json').uxImpact, 'admin-ui');
  assert.match(readFileSync(join(data.worktree.path, 'BACKLOG.md'), 'utf8'), /\| I-002 \|[^\n]*⚪ Todo/);
});

test('requirement start CLI validates migration and version mode as usage errors', async (t) => {
  const fixture = createGitFixture(t);
  const store = createStore(fixture.clientA, fixture.tempRoot);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const session = initializeSession({
    cwd: fixture.clientA, agent: 'codex', user: 'developer', host: 'workstation',
  });
  const env = {
    COORD_CWD: fixture.clientA,
    COORD_REMOTE: 'origin',
    COORD_BRANCH: 'coordination',
    COORD_TEMP_ROOT: fixture.tempRoot,
    COORD_SESSION_ID: session.sessionId,
  };
  const baseArgs = [
    'requirement', 'start',
    '--type', 'I',
    '--title', 'Invalid start',
    '--profile', 'tooling',
    '--topic', 'invalid-start',
  ];

  const run = async (args) => {
    const memory = createMemoryIo();
    const exitCode = await main([...baseArgs, ...args, '--json'], { env, ...memory.io });
    return { exitCode, stderr: memory.stderr.join('') };
  };

  for (const args of [
    ['--version', 'v0.1.0'], // --migration missing
    ['--version', 'v0.1.0', '--migration', 'maybe'],
    ['--version', 'v0.1.0', '--bump', 'patch', '--migration', 'yes'],
    ['--migration', 'no'], // no version mode
  ]) {
    const { exitCode, stderr } = await run(args);
    assert.equal(exitCode, 14, `${args.join(' ')}: ${stderr}`);
    assert.equal(JSON.parse(stderr).code, 'CLI_USAGE', args.join(' '));
  }

  // Usage rejections happen before any coordination write.
  const snapshot = await store.readSnapshot();
  assert.equal(snapshot.has('requirements/I-002.json'), false);
  assert.equal(snapshot.has('versions/v0.1.0.json'), false);
});

// The old four-step path (claim -> bind-version -> worktree create) stays
// available and keeps the 待评审 fallback: requirements without a declared
// migrationAssessment project 待评审 into the BACKLOG migration column.
test('worktree create keeps the 待评审 fallback without migrationAssessment', async (t) => {
  const fixture = createGitFixture(t);
  const store = createStore(fixture.clientA, fixture.tempRoot);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const id = await claimBoundRequirement(store, 'Legacy claim path');
  const session = initializeSession({
    cwd: fixture.clientA, agent: 'codex', user: 'developer', host: 'workstation',
  });

  const requirement = (await store.readSnapshot()).readJson(`requirements/${id}.json`);
  assert.equal(requirement.migrationAssessment, undefined);

  const created = await createRequirementWorktree({
    cwd: fixture.clientA, store, id, topic: 'legacy-claim', session,
  });

  assert.match(
    readFileSync(join(created.path, 'BACKLOG.md'), 'utf8'),
    new RegExp(`\\| ${id} \\| Legacy claim path \\| 待评审 \\| ⚪ Todo \\| v0\\.2\\.32 \\|`),
  );
});
