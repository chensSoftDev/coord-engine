import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { GitCoordinationStore } from '../../lib/coordination/git-store.mjs';
import { main } from '../../lib/coordination/cli.mjs';
import {
  bindRequirementVersion,
  claimRequirement,
} from '../../lib/coordination/requirements.mjs';
import { createGitFixture, createMemoryIo, runGit } from './fixtures.mjs';

// I-132 (F3): what-next is a read-only diagnostic — it reports the unique
// successor, the advance command and every missing prerequisite, and it must
// never change coordination state, BACKLOG.md or the checked-out branch.

async function setupFixture(t, { profile = 'tooling', migration = '否', lifecycle = 'in_dev' } = {}) {
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
    title: 'Diagnostic requirement',
    profile,
    backlogText: '| I-001 | fixture |\n',
  });
  await bindRequirementVersion({ store, id: claimed.id, version: 'v0.2.32' });
  await store.update({
    operation: `prepare ${claimed.id} lifecycle`,
    mutate(snapshot) {
      const path = `requirements/${claimed.id}.json`;
      snapshot.writeJson(path, { ...snapshot.readJson(path), lifecycle });
    },
  });
  const statusByState = { in_dev: '🔨 In Dev', testing: '🧪 Testing', done: '✔️ Done' };
  const targetRow = `| ${claimed.id} | Diagnostic requirement | ${migration} | ${statusByState[lifecycle]} | v0.2.32 | fixture |`;
  writeFileSync(join(fixture.clientA, 'BACKLOG.md'), [
    '| I-001 | Other requirement | 否 | ⚪ Todo | - | keep unchanged |',
    targetRow,
    '',
  ].join('\n'));
  const branch = 'feature/v0.2.32/diagnostic';
  runGit(fixture.clientA, ['switch', '-c', branch]);
  runGit(fixture.clientA, ['add', 'BACKLOG.md']);
  runGit(fixture.clientA, ['commit', '-m', 'test: register diagnostic requirement']);
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

function cliEnv(context) {
  return {
    ...process.env,
    // Fixtures own their session pointer. An ambient operator session belongs
    // to the repository running the tests, not to this isolated fixture.
    COORD_SESSION_ID: undefined,
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

test('what-next rejects an unclaimed requirement', async (t) => {
  const context = await setupFixture(t);
  const { exitCode, memory } = await runCli(['what-next', 'I-999', '--json'], context);

  assert.equal(exitCode, 14);
  assert.equal(JSON.parse(memory.stderr.join('')).code, 'REQUIREMENT_NOT_FOUND');
});

test('what-next reports a terminal state with next null', async (t) => {
  const context = await setupFixture(t, { lifecycle: 'done' });
  const { exitCode, memory } = await runCli(['what-next', context.id, '--json'], context);

  assert.equal(exitCode, 0, memory.stderr.join(''));
  const result = JSON.parse(memory.stdout.join(''));
  assert.equal(result.message, 'already at terminal state');
  assert.equal(result.data.next, null);
  assert.deepEqual(result.data.missing, []);
  assert.equal(result.data.lifecycle, 'done');
});

test('what-next lists the missing manifest and migration draft with generator remediations', async (t) => {
  const context = await setupFixture(t, { migration: '是' });
  const headBefore = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  const shaBefore = (await context.store.readSnapshot()).sha;

  const { exitCode, memory } = await runCli(['what-next', context.id, '--json'], context);

  assert.equal(exitCode, 0, memory.stderr.join(''));
  const result = JSON.parse(memory.stdout.join(''));
  assert.equal(result.data.id, context.id);
  assert.equal(result.data.profile, 'tooling');
  assert.equal(result.data.version, 'v0.2.32');
  assert.equal(result.data.lifecycle, 'in_dev');
  assert.equal(result.data.lifecycleLabel, '🔨 In Dev');
  assert.deepEqual(result.data.next, {
    state: 'testing',
    command: `pnpm coord lifecycle next ${context.id}`,
    dryRunCommand: `pnpm coord lifecycle next ${context.id} --dry-run`,
  });
  assert.deepEqual(result.data.missing, [
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
  assert.match(result.message, /2 blocker\(s\) before testing/);

  // Read-only: no coordination write, no commit, no BACKLOG change.
  assert.equal((await context.store.readSnapshot()).sha, shaBefore);
  assert.equal(runGit(context.fixture.clientA, ['rev-parse', 'HEAD']), headBefore);
  assert.equal(runGit(context.fixture.clientA, ['status', '--porcelain']), '');
});

test('what-next missing items equal the advance gate rejections', async (t) => {
  const context = await setupFixture(t, { migration: '是' });

  const whatNext = await runCli(['what-next', context.id, '--json'], context);
  assert.equal(whatNext.exitCode, 0, whatNext.memory.stderr.join(''));
  const missingCodes = JSON.parse(whatNext.memory.stdout.join(''))
    .data.missing.map(({ code }) => code);

  const advance = await runCli(
    ['lifecycle', 'advance', context.id, '--to', 'testing', '--json'],
    context,
  );
  assert.equal(advance.exitCode, 14);
  const rejection = JSON.parse(advance.memory.stderr.join(''));
  assert.equal(rejection.code, 'LIFECYCLE_GATE_FAILED');
  assert.deepEqual(missingCodes, rejection.data.requiredActions);
});

test('what-next reports all gates satisfied', async (t) => {
  const context = await setupFixture(t);
  mkdirSync(join(context.fixture.clientA, 'deploy', 'release-manifests'), { recursive: true });
  writeFileSync(
    join(context.fixture.clientA, 'deploy', 'release-manifests', 'v0.2.32.env'),
    'RELEASE_VERSION=v0.2.32\nRELEASE_DELIVERY_PROFILE=tooling\nRELEASE_SERVICES=none\n',
  );

  const { exitCode, memory } = await runCli(['what-next', context.id, '--json'], context);

  assert.equal(exitCode, 0, memory.stderr.join(''));
  const result = JSON.parse(memory.stdout.join(''));
  assert.equal(result.message, `${context.id} can advance to testing`);
  assert.deepEqual(result.data.missing, []);
  assert.deepEqual(result.data.hints, ['all gates are satisfied; run the next command to advance']);
});

test('what-next collects a dirty BACKLOG projection and keeps evaluating', async (t) => {
  const context = await setupFixture(t);
  writeFileSync(
    join(context.fixture.clientA, 'BACKLOG.md'),
    `${readFileSync(join(context.fixture.clientA, 'BACKLOG.md'), 'utf8')}dirty\n`,
  );

  const { exitCode, memory } = await runCli(['what-next', context.id, '--json'], context);

  assert.equal(exitCode, 0, memory.stderr.join(''));
  const result = JSON.parse(memory.stdout.join(''));
  assert.equal(result.data.missing[0].code, 'BACKLOG_PROJECTION_DIRTY');
  // Gate evaluation still ran: the missing manifest is reported as well.
  assert.ok(result.data.missing.some(({ code }) => code === 'create_manifest'));
});

test('what-next collects a branch mismatch and skips checkout-dependent gates', async (t) => {
  const context = await setupFixture(t);
  runGit(context.fixture.clientA, ['switch', 'main']);

  const { exitCode, memory } = await runCli(['what-next', context.id, '--json'], context);

  assert.equal(exitCode, 0, memory.stderr.join(''));
  const result = JSON.parse(memory.stdout.join(''));
  assert.deepEqual(result.data.missing, [{
    code: 'BRANCH_MISMATCH',
    message: `cannot publish ${context.id} from main; expected ${context.branch}`,
    remediation: `switch to the requirement branch: git switch ${context.branch}`,
  }]);
});

test('what-next collects a missing lease for runtime without failing', async (t) => {
  const context = await setupFixture(t, { profile: 'runtime', migration: '是' });
  const { exitCode, memory } = await runCli(['what-next', context.id, '--json'], context);

  assert.equal(exitCode, 0, memory.stderr.join(''));
  const result = JSON.parse(memory.stdout.join(''));
  assert.equal(result.data.next.state, 'dev_deployed');
  const codes = result.data.missing.map(({ code }) => code);
  assert.deepEqual(codes, [
    'LEASE_MISSING',
    'create_manifest',
    'create_migration_draft',
    'acquire_dev_lease',
    'deploy_current_commit_to_dev',
  ]);
  // No local session exists in the fixture, so the remediation is session
  // init, not lock acquire (I-132 review N3).
  const lease = result.data.missing.find(({ code }) => code === 'LEASE_MISSING');
  assert.equal(lease.remediation, 'pnpm coord session init --agent <name> --user <name> --json');
});

test('what-next points at lock acquire when a session exists but the lease is missing', async (t) => {
  const inheritedSessionId = process.env.COORD_SESSION_ID;
  process.env.COORD_SESSION_ID = '11111111-1111-4111-8111-111111111111';
  t.after(() => {
    if (inheritedSessionId === undefined) delete process.env.COORD_SESSION_ID;
    else process.env.COORD_SESSION_ID = inheritedSessionId;
  });
  const context = await setupFixture(t, { profile: 'runtime', migration: '是' });
  const sessionInit = await runCli(
    ['session', 'init', '--agent', 'test-agent', '--user', 'tester', '--json'],
    context,
  );
  assert.equal(sessionInit.exitCode, 0, sessionInit.memory.stderr.join(''));

  const { exitCode, memory } = await runCli(['what-next', context.id, '--json'], context);

  assert.equal(exitCode, 0, memory.stderr.join(''));
  const result = JSON.parse(memory.stdout.join(''));
  const lease = result.data.missing.find(({ code }) => code === 'LEASE_MISSING');
  assert.match(lease.remediation, new RegExp(`^pnpm coord lock acquire dev --requirement ${context.id}`));
});

test('what-next collects the test_passed blockers for runtime without failing', async (t) => {
  const context = await setupFixture(t, { profile: 'runtime', lifecycle: 'testing' });
  const headBefore = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  const shaBefore = (await context.store.readSnapshot()).sha;

  const { exitCode, memory } = await runCli(['what-next', context.id, '--json'], context);

  assert.equal(exitCode, 0, memory.stderr.join(''));
  const result = JSON.parse(memory.stdout.join(''));
  assert.equal(result.data.next.state, 'test_passed');
  // Collect mode (I-132 F3): the lease assertion and the evidence
  // validation failures are collected in one pass, then the precheck
  // appends the same gate failures the advance path would report.
  const codes = result.data.missing.map(({ code }) => code);
  assert.deepEqual(codes, [
    'LEASE_MISSING',
    'REQUIREMENT_DOCUMENTS_NOT_FOUND',
    'acquire_dev_lease',
    'deploy_current_commit_to_dev',
    'run_required_tests',
  ]);
  const lease = result.data.missing.find(({ code }) => code === 'LEASE_MISSING');
  assert.equal(lease.remediation, 'pnpm coord session init --agent <name> --user <name> --json');
  const evidence = result.data.missing.find(({ code }) => code === 'REQUIREMENT_DOCUMENTS_NOT_FOUND');
  assert.match(evidence.message, /requirement document directory is missing/);
  assert.match(
    evidence.remediation,
    new RegExp(`pnpm coord evidence validate ${context.id} --head HEAD --base origin/main --json$`),
  );
  const tests = result.data.missing.find(({ code }) => code === 'run_required_tests');
  assert.match(tests.remediation, /^run all required tests at the current commit/);

  // Read-only: no coordination write, no commit, no BACKLOG change.
  assert.equal((await context.store.readSnapshot()).sha, shaBefore);
  assert.equal(runGit(context.fixture.clientA, ['rev-parse', 'HEAD']), headBefore);
  assert.equal(runGit(context.fixture.clientA, ['status', '--porcelain']), '');
});

test('what-next rejects an invalid requirement id', async (t) => {
  const context = await setupFixture(t);
  const { exitCode, memory } = await runCli(['what-next', 'I-57', '--json'], context);

  assert.equal(exitCode, 14);
  const error = JSON.parse(memory.stderr.join(''));
  assert.equal(error.code, 'INVALID_REQUIREMENT_ID');
  assert.match(error.message, /invalid requirement id: I-57/);
});

test('what-next rejects stray positionals and undeclared options', async (t) => {
  const context = await setupFixture(t);

  const stray = await runCli(['what-next', context.id, 'extra', '--json'], context);
  assert.equal(stray.exitCode, 14);
  assert.equal(JSON.parse(stray.memory.stderr.join('')).code, 'CLI_USAGE');

  const option = await runCli(['what-next', context.id, '--force', '--json'], context);
  assert.equal(option.exitCode, 14);
  const error = JSON.parse(option.memory.stderr.join(''));
  assert.equal(error.code, 'CLI_USAGE');
  assert.match(error.message, /what-next does not accept option\(s\): --force/);
});
