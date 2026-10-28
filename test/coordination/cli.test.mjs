import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  COMMANDS,
  EXIT,
  CoordinationError,
  createGuardStore,
  executeBuiltin,
  main,
  parseArgs,
} from '../../lib/coordination/cli.mjs';
import { GitCoordinationStore } from '../../lib/coordination/git-store.mjs';
import { claimRequirement } from '../../lib/coordination/requirements.mjs';
import { initializeSession } from '../../lib/coordination/worktrees.mjs';
import { createGitFixture, createMemoryIo, runGit } from './fixtures.mjs';

test('exit codes are stable', () => {
  assert.deepEqual(EXIT, {
    OK: 0,
    OCCUPIED: 10,
    STALE: 11,
    INVALID_TRANSITION: 12,
    REMOTE_ERROR: 13,
    GATE_FAILED: 14,
    UNCERTAIN: 15,
  });
});

test('recognizes every planned top-level command', () => {
  assert.deepEqual([...COMMANDS].sort(), [
    'candidate',
    'deployment',
    'doctor',
    'environment',
    'evidence',
    'freeze',
    'gate',
    'guard',
    'init',
    'lifecycle',
    'lock',
    'manifest',
    'migrate-schema',
    'migration',
    'plan',
    'reconcile',
    'regression',
    'release-approval',
    'requirement',
    'review',
    'session',
    'status',
    'telemetry',
    'test',
    'ux',
    'what-next',
    'worktree',
  ]);
});

test('accepts global --json before or after status', () => {
  assert.deepEqual(parseArgs(['--json', 'status']), {
    command: 'status',
    positionals: [],
    options: {},
    json: true,
    help: false,
  });
  assert.deepEqual(parseArgs(['status', '--json']), {
    command: 'status',
    positionals: [],
    options: {},
    json: true,
    help: false,
  });
});

test('parses positionals, valued options, and boolean options', () => {
  assert.deepEqual(
    parseArgs([
      'requirement',
      'claim',
      '--type',
      'I',
      '--title',
      'Cross-agent coordination',
      '--profile=tooling',
      '--force',
    ]),
    {
      command: 'requirement',
      positionals: ['claim'],
      options: {
        type: 'I',
        title: 'Cross-agent coordination',
        profile: 'tooling',
        force: true,
      },
      json: false,
      help: false,
    },
  );
});

test('rejects unknown commands and missing option values', () => {
  assert.throws(
    () => parseArgs(['unknown']),
    (error) => error instanceof CoordinationError
      && error.code === 'CLI_USAGE'
      && error.exitCode === EXIT.GATE_FAILED,
  );
  assert.throws(
    () => parseArgs(['requirement', 'claim', '--type']),
    /option requires a value: --type/,
  );
});

test('help is available without a command', () => {
  assert.deepEqual(parseArgs(['--help']), {
    command: null,
    positionals: [],
    options: {},
    json: false,
    help: true,
  });
});

test('main returns machine-readable success for status', async () => {
  const memory = createMemoryIo();
  const exitCode = await main(['status', '--json'], {
    ...memory.io,
    env: {},
    execute: async () => ({
      ok: true,
      code: 'OK',
      exitCode: 0,
      message: 'coordination state is not initialized',
      data: { initialized: false },
    }),
  });

  assert.equal(exitCode, EXIT.OK);
  assert.deepEqual(JSON.parse(memory.stdout.join('')), {
    ok: true,
    code: 'OK',
    exitCode: 0,
    message: 'coordination state is not initialized',
    data: { initialized: false },
  });
  assert.equal(memory.stderr.join(''), '');
});

test('main delegates parsed commands to an injected executor', async () => {
  const memory = createMemoryIo();
  let received;

  const exitCode = await main(['status', '--json'], {
    ...memory.io,
    env: { COORD_CWD: '/tmp/repository' },
    execute: async (parsed, context) => {
      received = { parsed, env: context.env };
      return {
        ok: true,
        code: 'OK',
        exitCode: 0,
        message: 'injected executor',
        data: { initialized: true },
      };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(JSON.parse(memory.stdout.join('')).message, 'injected executor');
  assert.equal(received.parsed.command, 'status');
  assert.equal(received.env.COORD_CWD, '/tmp/repository');
});

test('main delegates gate preflight with explicit revisions', async () => {
  const memory = createMemoryIo();
  let received;

  const exitCode = await main([
    'gate', 'preflight', '--head', 'HEAD', '--base', 'origin/main', '--json',
  ], {
    ...memory.io,
    env: { COORD_CWD: '/tmp/repository' },
    execute: async (parsed) => {
      received = parsed;
      return {
        ok: true,
        code: 'OK',
        exitCode: 0,
        message: 'repository coordination gate passed',
        data: { valid: true },
      };
    },
  });

  assert.equal(exitCode, EXIT.OK);
  assert.deepEqual(received.positionals, ['preflight']);
  assert.deepEqual(received.options, { head: 'HEAD', base: 'origin/main' });
});

test('main returns stable JSON errors', async () => {
  const memory = createMemoryIo();
  const exitCode = await main(['unknown', '--json'], {
    ...memory.io,
    env: {},
  });

  assert.equal(exitCode, EXIT.GATE_FAILED);
  assert.deepEqual(JSON.parse(memory.stderr.join('')), {
    ok: false,
    code: 'CLI_USAGE',
    exitCode: 14,
    message: 'unknown command: unknown',
    data: {},
  });
  assert.equal(memory.stdout.join(''), '');
});

test('init creates the coordination branch and is idempotent', async (t) => {
  const fixture = createGitFixture(t);
  const env = {
    COORD_CWD: fixture.clientA,
    COORD_REMOTE: 'origin',
    COORD_BRANCH: 'coordination',
    COORD_TEMP_ROOT: fixture.tempRoot,
  };

  const first = await executeBuiltin(parseArgs(['init']), { env });
  const second = await executeBuiltin(parseArgs(['init']), { env });

  assert.equal(first.data.created, true);
  assert.equal(second.data.created, false);
  assert.equal(first.data.sha, second.data.sha);
});

test('production commands ignore caller-supplied clock overrides', async (t) => {
  const fixture = createGitFixture(t);
  const injectedNow = new Date('2026-07-17T00:00:00.000Z');
  const env = {
    COORD_CWD: fixture.clientA,
    COORD_REMOTE: 'origin',
    COORD_BRANCH: 'coordination',
    COORD_TEMP_ROOT: fixture.tempRoot,
    COORD_NOW: '2099-01-01T00:00:00.000Z',
  };

  await executeBuiltin(parseArgs(['init']), {
    env,
    clock: () => injectedNow,
  });
  const store = new GitCoordinationStore({
    cwd: fixture.clientA,
    remote: 'origin',
    branch: 'coordination',
    tempRoot: fixture.tempRoot,
  });

  assert.equal(
    (await store.readSnapshot()).readJson('schema.json').initializedAt,
    injectedNow.toISOString(),
  );
});

test('doctor removes only stale coordination temp directories', async (t) => {
  const fixture = createGitFixture(t);
  const stale = join(fixture.tempRoot, 'luggage-coordination-stale');
  const active = join(fixture.tempRoot, 'luggage-coordination-active');
  mkdirSync(stale);
  mkdirSync(active);
  utimesSync(stale, new Date('2026-07-16T23:30:00.000Z'), new Date('2026-07-16T23:30:00.000Z'));
  utimesSync(active, new Date('2026-07-16T23:55:00.000Z'), new Date('2026-07-16T23:55:00.000Z'));

  const result = await executeBuiltin(parseArgs(['doctor']), {
    env: {
      COORD_CWD: fixture.clientA,
      COORD_REMOTE: 'origin',
      COORD_BRANCH: 'coordination',
      COORD_TEMP_ROOT: fixture.tempRoot,
    },
    clock: () => new Date('2026-07-17T00:00:00.000Z'),
  });

  assert.deepEqual(result.data.removed, ['luggage-coordination-stale']);
  assert.deepEqual(readdirSync(fixture.tempRoot), ['luggage-coordination-active']);
});

// I-128 (L17): doctor surfaces the local coordination directory (sessions,
// current pointer, lease tokens and operation records), not just temp dirs.
test('doctor reports local coordination state', async (t) => {
  const fixture = createGitFixture(t);
  const store = new GitCoordinationStore({
    cwd: fixture.clientA,
    remote: 'origin',
    branch: 'coordination',
    tempRoot: fixture.tempRoot,
  });
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  initializeSession({ cwd: fixture.clientA, agent: 'kimi', user: 'dev', host: 'host-a' });

  const memory = createMemoryIo();
  const exitCode = await main(['doctor', '--json'], {
    env: {
      COORD_CWD: fixture.clientA,
      COORD_REMOTE: 'origin',
      COORD_BRANCH: 'coordination',
      COORD_TEMP_ROOT: fixture.tempRoot,
    },
    ...memory.io,
  });
  assert.equal(exitCode, 0, memory.stderr.join(''));
  const result = JSON.parse(memory.stdout.join(''));
  assert.equal(result.data.local.sessions.count, 1);
  assert.equal(result.data.local.sessions.hasCurrent, true);
  assert.deepEqual(result.data.local.leaseTokens, []);
  assert.equal(result.data.local.leaseOperations.total, 0);
});

// I-131 (E6): --reuse-sha 是全局选项；非法格式按 usage 惯例拒绝（exit 14）。
test('main rejects a malformed --reuse-sha as a usage error', async () => {
  const memory = createMemoryIo();
  const exitCode = await main(['status', '--reuse-sha', 'abc123', '--json'], {
    ...memory.io,
    env: {},
  });

  assert.equal(exitCode, 14);
  assert.equal(JSON.parse(memory.stderr.join('')).code, 'CLI_USAGE');
});

test('parseArgs plucks --reuse-sha out of the command options', () => {
  const parsed = parseArgs(['status', '--reuse-sha', 'a'.repeat(40), '--json']);
  assert.equal(parsed.reuseSha, 'a'.repeat(40));
  assert.deepEqual(parsed.options, {});
});

// I-131 (E6 review fix): the guard store honors the same global reuse-sha as
// every other store.
test('createGuardStore forwards COORD_REUSE_SHA into the store options', () => {
  const reuseSha = 'b'.repeat(40);
  const store = createGuardStore(null, { COORD_REUSE_SHA: reuseSha }, () => new Date());
  assert.equal(store.reuseSha, reuseSha);

  const trusted = createGuardStore(
    { cwd: '/tmp/unused', remote: 'trust', branch: 'coordination' },
    { COORD_REUSE_SHA: reuseSha },
    () => new Date(),
  );
  assert.equal(trusted.reuseSha, reuseSha);
  assert.equal(trusted.remote, 'trust');
});

// ============================================================================
// I-134 (F7): doctor health — read-only checks for stale leases, orphan
// worktrees and BACKLOG/coordination mismatches. Every check carries a
// remediation hint, and a single failing check never sinks the others.
// ============================================================================

const DOCTOR_CLOCK = () => new Date('2026-07-17T00:00:00.000Z');

async function setupDoctorFixture(t) {
  const fixture = createGitFixture(t);
  const store = new GitCoordinationStore({
    cwd: fixture.clientA,
    remote: 'origin',
    branch: 'coordination',
    tempRoot: fixture.tempRoot,
    clock: DOCTOR_CLOCK,
  });
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  return { fixture, store };
}

async function runDoctor({ fixture }) {
  const memory = createMemoryIo();
  const exitCode = await main(['doctor', '--json'], {
    env: {
      COORD_CWD: fixture.clientA,
      COORD_REMOTE: 'origin',
      COORD_BRANCH: 'coordination',
      COORD_TEMP_ROOT: fixture.tempRoot,
    },
    clock: DOCTOR_CLOCK,
    ...memory.io,
  });
  assert.equal(exitCode, 0, memory.stderr.join(''));
  return JSON.parse(memory.stdout.join('')).data.health;
}

test('doctor health is empty for a clean coordination state', async (t) => {
  const { fixture } = await setupDoctorFixture(t);

  const health = await runDoctor({ fixture });

  assert.deepEqual(health.staleLeases, []);
  assert.deepEqual(health.orphanWorktrees, []);
  assert.deepEqual(health.backlogMismatch, []);
});

test('doctor health reports an active lease whose expiry has passed', async (t) => {
  const { fixture, store } = await setupDoctorFixture(t);
  await store.update({
    operation: 'plant a stale lease',
    mutate(snapshot) {
      snapshot.writeJson('locks/dev.json', {
        schemaVersion: 2,
        resource: 'dev',
        active: {
          holder: { kind: 'requirement', id: 'I-001' },
          version: 'v0.2.32',
          sessionId: 'session-gone',
          branch: 'feature/v0.2.32/gone',
          commit: '1'.repeat(40),
          ownerToken: '11111111-1111-4111-8111-111111111111',
          acquiredAt: '2026-07-16T20:00:00.000Z',
          expiresAt: '2026-07-16T21:00:00.000Z',
        },
        lastEvent: null,
      });
    },
  });

  const health = await runDoctor({ fixture });

  assert.deepEqual(health.staleLeases, [{
    resource: 'dev',
    holder: 'I-001',
    sessionId: 'session-gone',
    expiredAt: '2026-07-16T21:00:00.000Z',
    remediation: 'pnpm coord lock break dev --reason <text> --force --json',
  }]);
  assert.deepEqual(health.orphanWorktrees, []);
  assert.deepEqual(health.backlogMismatch, []);
});

test('doctor health reports orphan worktrees with their reasons', async (t) => {
  const { fixture, store } = await setupDoctorFixture(t);
  mkdirSync(join(fixture.root, '.worktrees'));

  // A worktree on a feature/v* branch no requirement is bound to, never
  // pushed to the remote.
  runGit(fixture.clientA, [
    'worktree', 'add', '-b', 'feature/v0.2.32/orphan', join(fixture.root, 'orphan-wt'),
  ]);

  // A worktree whose requirement already reached a terminal lifecycle.
  const done = await claimRequirement({
    store,
    type: 'I',
    title: 'Done requirement',
    profile: 'tooling',
    backlogText: '| I-001 | fixture |\n',
  });
  await store.update({
    operation: `mark ${done.id} done with a bound branch`,
    mutate(snapshot) {
      const path = `requirements/${done.id}.json`;
      snapshot.writeJson(path, {
        ...snapshot.readJson(path),
        lifecycle: 'done',
        branch: 'feature/v0.2.32/done-topic',
      });
    },
  });
  runGit(fixture.clientA, [
    'worktree', 'add', '-b', 'feature/v0.2.32/done-topic',
    join(fixture.root, '.worktrees', `${done.id}-done-topic`),
  ]);

  // A healthy worktree: active requirement, bound branch, pushed to the
  // remote — it must not be reported.
  const active = await claimRequirement({
    store,
    type: 'I',
    title: 'Active requirement',
    profile: 'tooling',
    backlogText: '| I-001 | fixture |\n',
  });
  await store.update({
    operation: `bind ${active.id} branch`,
    mutate(snapshot) {
      const path = `requirements/${active.id}.json`;
      snapshot.writeJson(path, {
        ...snapshot.readJson(path),
        branch: 'feature/v0.2.32/active-topic',
      });
    },
  });
  runGit(fixture.clientA, [
    'worktree', 'add', '-b', 'feature/v0.2.32/active-topic',
    join(fixture.root, '.worktrees', `${active.id}-active-topic`),
  ]);
  runGit(fixture.clientA, ['push', '--set-upstream', 'origin', 'feature/v0.2.32/active-topic']);

  const health = await runDoctor({ fixture });

  const orphans = health.orphanWorktrees;
  assert.equal(orphans.length, 2);
  const unbound = orphans.find((orphan) => orphan.branch === 'feature/v0.2.32/orphan');
  assert.ok(unbound, 'the unbound worktree is reported');
  assert.equal(unbound.requirementId, null);
  assert.ok(unbound.reasons.some((reason) => reason.includes('no requirement is bound')));
  assert.ok(unbound.reasons.some((reason) => reason.includes('remote branch origin/feature/v0.2.32/orphan is gone')));
  assert.ok(unbound.remediation.includes('git worktree remove'));
  const terminal = orphans.find((orphan) => orphan.branch === 'feature/v0.2.32/done-topic');
  assert.ok(terminal, 'the terminal worktree is reported');
  assert.equal(terminal.requirementId, done.id);
  assert.ok(terminal.reasons.some((reason) => reason.includes(`${done.id} is done`)));
  assert.ok(orphans.every((orphan) => !orphan.branch.includes('active-topic')));
});

test('doctor health reports BACKLOG rows that drifted from coordination state', async (t) => {
  const { fixture, store } = await setupDoctorFixture(t);

  // Non-terminal requirement without a BACKLOG row (the zombie shape).
  const zombie = await claimRequirement({
    store,
    type: 'I',
    title: 'Zombie requirement',
    profile: 'tooling',
    backlogText: '| I-001 | fixture |\n',
  });
  // A row whose emoji status lags the coordination lifecycle.
  const drifted = await claimRequirement({
    store,
    type: 'I',
    title: 'Drifted requirement',
    profile: 'tooling',
    backlogText: '| I-001 | fixture |\n',
  });
  await store.update({
    operation: `advance ${drifted.id} fixture lifecycle`,
    mutate(snapshot) {
      const path = `requirements/${drifted.id}.json`;
      snapshot.writeJson(path, { ...snapshot.readJson(path), lifecycle: 'in_dev' });
    },
  });
  writeFileSync(
    join(fixture.clientA, 'BACKLOG.md'),
    `| I-001 | fixture |\n| ${drifted.id} | Drifted requirement | 待评审 | ⚪ Todo | - | fixture |\n`,
  );

  const health = await runDoctor({ fixture });

  assert.deepEqual(health.backlogMismatch, [
    {
      requirementId: zombie.id,
      coordinationLifecycle: 'todo',
      expectedStatus: '⚪ Todo',
      backlogStatus: null,
      remediation: `pnpm coord reconcile ${zombie.id} --json`,
    },
    {
      requirementId: drifted.id,
      coordinationLifecycle: 'in_dev',
      expectedStatus: '🔨 In Dev',
      backlogStatus: '⚪ Todo',
      remediation: `pnpm coord reconcile ${drifted.id} --json`,
    },
  ]);
  assert.deepEqual(health.staleLeases, []);
});

test('doctor health keeps the other checks when one of them fails', async (t) => {
  const { fixture, store } = await setupDoctorFixture(t);
  await store.update({
    operation: 'plant a stale lease',
    mutate(snapshot) {
      snapshot.writeJson('locks/prod.json', {
        schemaVersion: 2,
        resource: 'prod',
        active: {
          holder: { kind: 'requirement', id: 'I-001' },
          version: 'v0.2.32',
          sessionId: 'session-gone',
          branch: 'feature/v0.2.32/gone',
          commit: '1'.repeat(40),
          ownerToken: '11111111-1111-4111-8111-111111111111',
          acquiredAt: '2026-07-16T20:00:00.000Z',
          expiresAt: '2026-07-16T21:00:00.000Z',
        },
        lastEvent: null,
      });
    },
  });
  // backlogMismatch can no longer read its input.
  rmSync(join(fixture.clientA, 'BACKLOG.md'));

  const health = await runDoctor({ fixture });

  assert.equal(typeof health.backlogMismatch.error, 'string');
  assert.match(health.backlogMismatch.error, /BACKLOG/);
  assert.equal(health.staleLeases.length, 1);
  assert.equal(health.staleLeases[0].resource, 'prod');
  assert.deepEqual(health.orphanWorktrees, []);
});
