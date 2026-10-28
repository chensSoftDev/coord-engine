import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { GitCoordinationStore } from '../../lib/coordination/git-store.mjs';
import { main } from '../../lib/coordination/cli.mjs';
import lifecycleCommand from '../../lib/coordination/commands/lifecycle.mjs';
import {
  bindRequirementVersion,
  claimRequirement,
} from '../../lib/coordination/requirements.mjs';
import { createGitFixture, createMemoryIo, runGit } from './fixtures.mjs';

// I-132 (F6): --dry-run on the lifecycle advance family runs the full read
// path (probes + context + the F3 precheck) but never writes coordination
// and never publishes BACKLOG. Gate failures exit 14 with the same
// requiredActions the real path reports (a dry run writes no state, so the
// exit-15 reconcile contract does not apply); success exits 0 with
// wouldAdvance: true. Every other command keeps rejecting --dry-run.

async function setupFixture(t, { migration = '否', withManifest = true } = {}) {
  const fixture = createGitFixture(t);
  const clock = () => new Date('2026-07-17T00:00:00.000Z');
  const store = new GitCoordinationStore({
    cwd: fixture.clientA,
    remote: 'origin',
    branch: 'coordination',
    tempRoot: fixture.tempRoot,
    clock,
  });
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const claimed = await claimRequirement({
    store,
    type: 'I',
    title: 'Dry run requirement',
    profile: 'tooling',
    backlogText: '| I-001 | fixture |\n',
  });
  await bindRequirementVersion({ store, id: claimed.id, version: 'v0.2.32' });
  await store.update({
    operation: `prepare ${claimed.id} lifecycle`,
    mutate(snapshot) {
      const path = `requirements/${claimed.id}.json`;
      snapshot.writeJson(path, { ...snapshot.readJson(path), lifecycle: 'in_dev' });
    },
  });
  const rows = [
    '| I-001 | Other requirement | 否 | ⚪ Todo | - | keep unchanged |',
    `| ${claimed.id} | Dry run requirement | ${migration} | 🔨 In Dev | v0.2.32 | fixture |`,
    '',
  ];
  writeFileSync(join(fixture.clientA, 'BACKLOG.md'), rows.join('\n'));
  const tracked = ['BACKLOG.md'];
  if (withManifest) {
    mkdirSync(join(fixture.clientA, 'deploy', 'release-manifests'), { recursive: true });
    writeFileSync(
      join(fixture.clientA, 'deploy', 'release-manifests', 'v0.2.32.env'),
      'RELEASE_VERSION=v0.2.32\nRELEASE_DELIVERY_PROFILE=tooling\nRELEASE_SERVICES=none\n',
    );
    tracked.push('deploy/release-manifests/v0.2.32.env');
  }
  const branch = 'feature/v0.2.32/dry-run';
  runGit(fixture.clientA, ['switch', '-c', branch]);
  runGit(fixture.clientA, ['add', ...tracked]);
  runGit(fixture.clientA, ['commit', '-m', 'test: register dry-run requirement']);
  runGit(fixture.clientA, ['push', '-u', 'origin', branch]);
  await store.update({
    operation: `bind ${claimed.id} branch`,
    mutate(snapshot) {
      const path = `requirements/${claimed.id}.json`;
      snapshot.writeJson(path, { ...snapshot.readJson(path), branch });
    },
  });
  return { fixture, store, id: claimed.id, clock, branch };
}

async function setupBatchFixture(t, { secondVersion }) {
  const context = await setupFixture(t);
  const second = await claimRequirement({
    store: context.store,
    type: 'I',
    title: 'Second batch requirement',
    profile: 'tooling',
    backlogText: '| I-001 | fixture |\n',
  });
  if (secondVersion) {
    await bindRequirementVersion({ store: context.store, id: second.id, version: 'v0.2.32' });
  }
  await context.store.update({
    operation: `prepare ${second.id} lifecycle`,
    mutate(snapshot) {
      const path = `requirements/${second.id}.json`;
      snapshot.writeJson(path, {
        ...snapshot.readJson(path),
        lifecycle: secondVersion ? 'in_dev' : 'reviewing',
      });
    },
  });
  writeFileSync(join(context.fixture.clientA, 'BACKLOG.md'), [
    '| I-001 | Other requirement | 否 | ⚪ Todo | - | keep unchanged |',
    `| ${context.id} | Dry run requirement | 否 | 🔨 In Dev | v0.2.32 | fixture |`,
    `| ${second.id} | Second batch requirement | 否 | ${secondVersion ? '🔨 In Dev' : '🔍 Reviewing'} | ${secondVersion ? 'v0.2.32' : '-'} | fixture |`,
    '',
  ].join('\n'));
  runGit(context.fixture.clientA, ['add', 'BACKLOG.md']);
  runGit(context.fixture.clientA, ['commit', '-m', 'test: register second batch requirement']);
  runGit(context.fixture.clientA, ['push', 'origin', context.branch]);
  await context.store.update({
    operation: `bind ${second.id} branch`,
    mutate(snapshot) {
      const path = `requirements/${second.id}.json`;
      snapshot.writeJson(path, { ...snapshot.readJson(path), branch: context.branch });
    },
  });
  return { ...context, secondId: second.id };
}

function cliEnv(context) {
  return {
    ...process.env,
    COORD_CWD: context.fixture.clientA,
    COORD_REMOTE: 'origin',
    COORD_BRANCH: 'coordination',
    COORD_TEMP_ROOT: context.fixture.tempRoot,
  };
}

async function runCli(argv, context) {
  const memory = createMemoryIo();
  const exitCode = await main(argv, {
    env: cliEnv(context),
    clock: context.clock,
    ...memory.io,
  });
  return { exitCode, memory };
}

function workspaceState(context) {
  return {
    head: runGit(context.fixture.clientA, ['rev-parse', 'HEAD']),
    backlog: readFileSync(join(context.fixture.clientA, 'BACKLOG.md'), 'utf8'),
  };
}

test('dry-run next reports gate failures with the real path requiredActions and changes nothing', async (t) => {
  const context = await setupFixture(t, { migration: '是', withManifest: false });
  const before = workspaceState(context);
  const shaBefore = (await context.store.readSnapshot()).sha;

  const dryRun = await runCli(['lifecycle', 'next', context.id, '--dry-run', '--json'], context);

  assert.equal(dryRun.exitCode, 14);
  const failure = JSON.parse(dryRun.memory.stderr.join(''));
  assert.equal(failure.code, 'LIFECYCLE_GATE_FAILED');
  assert.equal(failure.data.dryRun, true);
  assert.equal(failure.data.ok, false);
  assert.equal(failure.data.id, context.id);
  assert.equal(failure.data.from, 'in_dev');
  assert.equal(failure.data.to, 'testing');
  assert.deepEqual(failure.data.requiredActions, ['create_manifest', 'create_migration_draft']);
  assert.deepEqual(failure.data.missing, [
    {
      code: 'create_manifest',
      message: 'create a valid release manifest',
      remediation: 'pnpm coord manifest init v0.2.32 --json',
    },
    {
      code: 'create_migration_draft',
      message: 'create the pending migration draft',
      remediation: `pnpm coord migration draft ${context.id} --json`,
    },
  ]);

  // Zero state drift: coordination sha, HEAD and BACKLOG are all untouched.
  assert.equal((await context.store.readSnapshot()).sha, shaBefore);
  assert.deepEqual(workspaceState(context), before);
  assert.equal(
    (await context.store.readSnapshot()).readJson(`requirements/${context.id}.json`).lifecycle,
    'in_dev',
  );

  // The real path rejects with the identical requiredActions.
  const real = await runCli(['lifecycle', 'next', context.id, '--json'], context);
  assert.equal(real.exitCode, 14);
  const rejection = JSON.parse(real.memory.stderr.join(''));
  assert.equal(rejection.code, 'LIFECYCLE_GATE_FAILED');
  assert.deepEqual(rejection.data.requiredActions, failure.data.requiredActions);
});

test('dry-run next on a ready requirement reports wouldAdvance and changes nothing', async (t) => {
  const context = await setupFixture(t);
  const before = workspaceState(context);
  const shaBefore = (await context.store.readSnapshot()).sha;

  const { exitCode, memory } = await runCli(
    ['lifecycle', 'next', context.id, '--dry-run', '--json'],
    context,
  );

  assert.equal(exitCode, 0, memory.stderr.join(''));
  const result = JSON.parse(memory.stdout.join(''));
  assert.equal(result.message, `would advance ${context.id} from in_dev to testing (dry run)`);
  assert.deepEqual(result.data, {
    dryRun: true,
    id: context.id,
    from: 'in_dev',
    to: 'testing',
    ok: true,
    wouldAdvance: true,
  });
  assert.equal((await context.store.readSnapshot()).sha, shaBefore);
  assert.deepEqual(workspaceState(context), before);
});

test('dry-run advance evaluates the explicit target state', async (t) => {
  const context = await setupFixture(t);
  const { exitCode, memory } = await runCli(
    ['lifecycle', 'advance', context.id, '--to', 'testing', '--dry-run', '--json'],
    context,
  );

  assert.equal(exitCode, 0, memory.stderr.join(''));
  const result = JSON.parse(memory.stdout.join(''));
  assert.equal(result.data.dryRun, true);
  assert.equal(result.data.to, 'testing');
  assert.equal(result.data.wouldAdvance, true);
  assert.equal(
    (await context.store.readSnapshot()).readJson(`requirements/${context.id}.json`).lifecycle,
    'in_dev',
  );
});

test('dry-run batch-next reports a full-ready batch', async (t) => {
  const context = await setupBatchFixture(t, { secondVersion: true });
  const shaBefore = (await context.store.readSnapshot()).sha;

  const { exitCode, memory } = await runCli(
    ['lifecycle', 'batch-next', context.id, context.secondId, '--dry-run', '--json'],
    context,
  );

  assert.equal(exitCode, 0, memory.stderr.join(''));
  const result = JSON.parse(memory.stdout.join(''));
  assert.equal(result.data.dryRun, true);
  assert.equal(result.data.ok, true);
  assert.equal(result.data.wouldAdvance, true);
  assert.deepEqual(result.data.results, [
    { id: context.id, from: 'in_dev', to: 'testing' },
    { id: context.secondId, from: 'in_dev', to: 'testing' },
  ]);
  assert.equal((await context.store.readSnapshot()).sha, shaBefore);
});

test('dry-run batch-next aborts like the real batch and changes nothing', async (t) => {
  const context = await setupBatchFixture(t, { secondVersion: false });
  const before = workspaceState(context);
  const shaBefore = (await context.store.readSnapshot()).sha;

  const { exitCode, memory } = await runCli(
    ['lifecycle', 'batch-next', context.id, context.secondId, '--dry-run', '--json'],
    context,
  );

  assert.equal(exitCode, 14);
  const failure = JSON.parse(memory.stderr.join(''));
  assert.equal(failure.code, 'LIFECYCLE_GATE_FAILED');
  assert.equal(failure.data.dryRun, true);
  assert.equal(failure.data.ok, false);
  const results = Object.fromEntries(failure.data.results.map((entry) => [entry.id, entry]));
  assert.equal(results[context.id].allowed, true);
  assert.deepEqual(results[context.id].requiredActions, []);
  assert.equal(results[context.secondId].allowed, false);
  assert.deepEqual(results[context.secondId].requiredActions, ['bind_version']);
  assert.deepEqual(results[context.secondId].missing, [{
    code: 'bind_version',
    message: 'bind the requirement to a release version',
    remediation: `pnpm coord requirement bind-version ${context.secondId} --bump patch --json`,
  }]);
  assert.equal((await context.store.readSnapshot()).sha, shaBefore);
  assert.deepEqual(workspaceState(context), before);
});

test('lifecycle fail still rejects --dry-run through the option whitelist', async (t) => {
  const context = await setupFixture(t);
  const { exitCode, memory } = await runCli(
    ['lifecycle', 'fail', context.id, '--reason', 'dry run is not a failure', '--dry-run', '--json'],
    context,
  );

  assert.equal(exitCode, 14);
  const error = JSON.parse(memory.stderr.join(''));
  assert.equal(error.code, 'CLI_USAGE');
  assert.match(error.message, /lifecycle fail does not accept option\(s\): --dry-run/);
});

test('non-lifecycle commands keep rejecting --dry-run', async (t) => {
  const context = await setupFixture(t);
  const { exitCode, memory } = await runCli(
    ['requirement', 'show', context.id, '--dry-run', '--json'],
    context,
  );

  assert.equal(exitCode, 14);
  const error = JSON.parse(memory.stderr.join(''));
  assert.equal(error.code, 'CLI_USAGE');
  assert.match(error.message, /requirement show does not accept option\(s\): --dry-run/);
});

test('the lifecycle advance family declares supportsDryRun and the dry-run option', () => {
  const byKey = new Map(lifecycleCommand.subcommands.map((subcommand) => [subcommand.key, subcommand]));
  for (const key of ['lifecycle advance', 'lifecycle next', 'lifecycle batch-next']) {
    assert.equal(byKey.get(key).supportsDryRun, true, `${key} must declare supportsDryRun`);
    assert.ok(byKey.get(key).options.includes('dry-run'), `${key} must accept --dry-run`);
  }
  assert.notEqual(byKey.get('lifecycle fail').supportsDryRun, true);
  assert.ok(!byKey.get('lifecycle fail').options.includes('dry-run'));
});
