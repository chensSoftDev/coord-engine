import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { main, parseArgs } from '../../lib/coordination/cli.mjs';
import { GitCoordinationStore } from '../../lib/coordination/git-store.mjs';
import { acquireLease } from '../../lib/coordination/leases.mjs';
import {
  bindRequirementVersion,
  claimRequirement,
} from '../../lib/coordination/requirements.mjs';
import { initializeSession } from '../../lib/coordination/worktrees.mjs';
import { createGitFixture, createMemoryIo, runGit } from './fixtures.mjs';

// I-113 Task 3 (CLI slice): `coord freeze enter/show` wires the existing
// freezes.mjs state machine into the pnpm coord CLI. The contract is
// deliberately narrow: a single dev resource, stable JSON on stdout/stderr,
// and the existing error code + exit code mapping. accept/reject/release,
// guard integration and release approval are out of scope for this slice.
//
// deploymentSnapshot follows the repository's existing convention for complex
// payloads (`deployment record --snapshot <path>`,
// `requirement apply-completion --plan <path>`): it is passed as a JSON file
// path, never as inline argv JSON.

function createStore(cwd, tempRoot, clock) {
  return new GitCoordinationStore({
    cwd,
    remote: 'origin',
    branch: 'coordination',
    tempRoot,
    clock,
  });
}

async function setupFreezeCliFixture(t, { initialNow = '2026-08-14T00:00:00.000Z' } = {}) {
  const fixture = createGitFixture(t);
  const clock = () => new Date(initialNow);
  const store = createStore(fixture.clientA, fixture.tempRoot, clock);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const claimed = await claimRequirement({
    store,
    type: 'I',
    title: 'Freeze CLI requirement',
    profile: 'runtime',
    backlogText: '| I-001 | fixture |\n',
  });
  await bindRequirementVersion({ store, id: claimed.id, version: 'v0.9.1' });
  const branch = 'feature/v0.9.1/freeze-cli-requirement';
  await store.update({
    operation: `bind branch for ${claimed.id}`,
    mutate(snapshot) {
      const path = `requirements/${claimed.id}.json`;
      snapshot.writeJson(path, { ...snapshot.readJson(path), branch });
    },
  });
  runGit(fixture.clientA, ['switch', '-c', branch]);
  const session = initializeSession({
    cwd: fixture.clientA, agent: 'kimi', user: 'developer', host: 'host-a', clock,
  });
  const env = {
    COORD_CWD: fixture.clientA,
    COORD_REMOTE: 'origin',
    COORD_BRANCH: 'coordination',
    COORD_TEMP_ROOT: fixture.tempRoot,
    COORD_SESSION_ID: session.sessionId,
  };
  return { fixture, store, id: claimed.id, branch, session, env, clock };
}

async function runCli(argv, context) {
  const memory = createMemoryIo();
  const exitCode = await main(argv, {
    ...memory.io,
    env: context.env,
    clock: context.clock,
  });
  return { exitCode, memory };
}

function stderrJson(memory) {
  return JSON.parse(memory.stderr.join(''));
}

function stdoutJson(memory) {
  return JSON.parse(memory.stdout.join(''));
}

function writeDeploymentSnapshot(cwd, value, name = 'freeze-snapshot.json') {
  const path = join(cwd, name);
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  return path;
}

function enterArgv(context, overrides = {}) {
  const args = {
    resource: 'dev',
    requirement: context.id,
    candidate: `candidate-${context.id}-abc123`,
    evidence: 'b'.repeat(64),
    snapshotPath: writeDeploymentSnapshot(context.fixture.clientA, {
      environment: 'dev',
      commit: runGit(context.fixture.clientA, ['rev-parse', 'HEAD']),
    }),
    ...overrides,
  };
  return [
    'freeze', 'enter', args.resource,
    '--requirement', args.requirement,
    '--candidate', args.candidate,
    '--evidence', args.evidence,
    '--deployment-snapshot', args.snapshotPath,
    '--json',
  ];
}

async function acquireDevLease(context) {
  return acquireLease({
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'dev',
    requirementId: context.id,
    ttl: '8h',
    session: context.session,
    clock: context.clock,
  });
}

test('freeze is discoverable through help and the argument parser', async () => {
  const memory = createMemoryIo();
  const exitCode = await main(['--help'], { ...memory.io, env: {} });
  assert.equal(exitCode, 0);
  assert.match(memory.stdout.join(''), /^\s+freeze\s+/m);

  assert.deepEqual(parseArgs(['freeze', 'show', 'dev']), {
    command: 'freeze',
    positionals: ['show', 'dev'],
    options: {},
    json: false,
    help: false,
  });
});

test('freeze show reports a stable JSON null fact when dev is not frozen', async (t) => {
  const context = await setupFreezeCliFixture(t);

  const { exitCode, memory } = await runCli(['freeze', 'show', 'dev', '--json'], context);

  assert.equal(exitCode, 0, memory.stderr.join(''));
  assert.equal(memory.stderr.join(''), '');
  const result = stdoutJson(memory);
  assert.equal(result.ok, true);
  assert.equal(result.code, 'OK');
  assert.equal(result.exitCode, 0);
  assert.equal(result.data.freeze, null);
});

test('freeze enter converts the active dev lease and returns a stable JSON fact', async (t) => {
  const context = await setupFreezeCliFixture(t);
  const acquired = await acquireDevLease(context);
  const candidateId = `candidate-${context.id}-abc123`;
  const evidence = 'b'.repeat(64);
  const snapshotPath = writeDeploymentSnapshot(context.fixture.clientA, {
    environment: 'dev',
    commit: acquired.commit,
  });

  const { exitCode, memory } = await runCli([
    'freeze', 'enter', 'dev',
    '--requirement', context.id,
    '--candidate', candidateId,
    '--evidence', evidence,
    '--deployment-snapshot', snapshotPath,
    '--json',
  ], context);

  assert.equal(exitCode, 0, memory.stderr.join(''));
  assert.equal(memory.stderr.join(''), '');
  const result = stdoutJson(memory);
  assert.equal(result.ok, true);
  assert.equal(result.code, 'OK');
  assert.equal(result.data.schemaVersion, 1);
  assert.equal(result.data.resource, 'dev');
  assert.equal(result.data.state, 'awaiting_human');
  assert.equal(result.data.requirementId, context.id);
  // I-130 (D1): the freeze fact carries the lease's bound version.
  assert.equal(result.data.version, 'v0.9.1');
  assert.equal(result.data.candidateId, candidateId);
  assert.deepEqual(result.data.deploymentSnapshot, {
    environment: 'dev',
    commit: acquired.commit,
  });
  assert.equal(result.data.machineVerificationEvidence, evidence);
  assert.equal(result.data.branch, context.branch);
  assert.equal(result.data.commit, acquired.commit);
  assert.equal(result.data.expiresAt, undefined);
  assert.equal(typeof result.data.operationId, 'string');
  assert.equal(typeof result.data.coordinationSha, 'string');

  const shown = await runCli(['freeze', 'show', 'dev', '--json'], context);
  assert.equal(shown.exitCode, 0, shown.memory.stderr.join(''));
  const fact = stdoutJson(shown.memory).data.freeze;
  assert.equal(fact.state, 'awaiting_human');
  assert.equal(fact.candidateId, candidateId);

  // The lease slot is released by the same atomic conversion.
  const snapshot = await context.store.readSnapshot();
  assert.equal(snapshot.readJson('locks/dev.json').active, null);
});

test('freeze enter maps missing bindings to stable error codes and exit codes', async (t) => {
  const context = await setupFreezeCliFixture(t);
  await acquireDevLease(context);

  // A whitespace-only candidate passes argv parsing but is rejected by the
  // state machine's binding validation before any coordination write.
  const blankCandidate = await runCli(enterArgv(context, { candidate: '   ' }), context);
  assert.equal(blankCandidate.exitCode, 14);
  assert.equal(stderrJson(blankCandidate.memory).code, 'MISSING_FREEZE_BINDING');

  // A snapshot file whose JSON is not a plain object is a missing binding.
  const nullSnapshot = writeDeploymentSnapshot(
    context.fixture.clientA, 'null', 'freeze-snapshot-null.json',
  );
  const nullResult = await runCli(
    enterArgv(context, { snapshotPath: nullSnapshot }),
    context,
  );
  assert.equal(nullResult.exitCode, 14);
  assert.equal(stderrJson(nullResult.memory).code, 'MISSING_FREEZE_BINDING');

  // Missing required options are usage errors.
  const missingOption = await runCli([
    'freeze', 'enter', 'dev',
    '--requirement', context.id,
    '--candidate', 'candidate-x',
    '--evidence', 'b'.repeat(64),
    '--json',
  ], context);
  assert.equal(missingOption.exitCode, 14);
  const usage = stderrJson(missingOption.memory);
  assert.equal(usage.code, 'CLI_USAGE');
  assert.match(usage.message, /missing required option: --deployment-snapshot/);

  // An unreadable or non-JSON snapshot file fails closed without touching
  // coordination state.
  const invalidJson = writeDeploymentSnapshot(
    context.fixture.clientA, '{not json', 'freeze-snapshot-broken.json',
  );
  for (const snapshotPath of [invalidJson, join(context.fixture.clientA, 'absent.json')]) {
    const failed = await runCli(enterArgv(context, { snapshotPath }), context);
    assert.equal(failed.exitCode, 14);
    assert.equal(stderrJson(failed.memory).code, 'INVALID_FREEZE_SNAPSHOT');
  }

  // None of the rejected attempts wrote a freeze fact or consumed the lease.
  const snapshot = await context.store.readSnapshot();
  assert.equal(snapshot.has('freezes/dev.json'), false);
  assert.notEqual(snapshot.readJson('locks/dev.json').active, null);
});

test('freeze enter/show reject resources other than dev', async (t) => {
  const context = await setupFreezeCliFixture(t);
  await acquireDevLease(context);

  const shown = await runCli(['freeze', 'show', 'prod', '--json'], context);
  assert.equal(shown.exitCode, 14);
  assert.equal(stderrJson(shown.memory).code, 'INVALID_FREEZE_RESOURCE');

  const entered = await runCli(enterArgv(context, { resource: 'prod' }), context);
  assert.equal(entered.exitCode, 14);
  assert.equal(stderrJson(entered.memory).code, 'INVALID_FREEZE_RESOURCE');

  const snapshot = await context.store.readSnapshot();
  assert.equal(snapshot.has('freezes/dev.json'), false);
  assert.notEqual(snapshot.readJson('locks/dev.json').active, null);
});

test('a second freeze enter fails with FREEZE_EXISTS and exit code 10', async (t) => {
  const context = await setupFreezeCliFixture(t);
  await acquireDevLease(context);

  const first = await runCli(enterArgv(context), context);
  assert.equal(first.exitCode, 0, first.memory.stderr.join(''));

  const second = await runCli(enterArgv(context), context);
  assert.equal(second.exitCode, 10);
  const error = stderrJson(second.memory);
  assert.equal(error.ok, false);
  assert.equal(error.code, 'FREEZE_EXISTS');
  assert.equal(error.exitCode, 10);
});

// ============================================================================
// I-113 Task 3 (accept/reject/release CLI slice): `coord freeze
// accept/reject/release` wire the human decision paths into the CLI with the
// same stable-JSON contract and error-code mapping as enter/show. All three
// require --requirement and --reason; decisions for a missing or
// other-requirement freeze fail closed.
// ============================================================================

async function enterViaCli(context) {
  const acquired = await acquireDevLease(context);
  const entered = await runCli(enterArgv(context), context);
  assert.equal(entered.exitCode, 0, entered.memory.stderr.join(''));
  return acquired;
}

test('freeze accept records the acceptance through the CLI with stable JSON', async (t) => {
  const context = await setupFreezeCliFixture(t);
  await enterViaCli(context);

  const { exitCode, memory } = await runCli([
    'freeze', 'accept', 'dev',
    '--requirement', context.id,
    '--reason', 'user accepted the candidate',
    '--json',
  ], context);

  assert.equal(exitCode, 0, memory.stderr.join(''));
  assert.equal(memory.stderr.join(''), '');
  const result = stdoutJson(memory);
  assert.equal(result.ok, true);
  assert.equal(result.data.state, 'awaiting_human');
  assert.equal(result.data.requirementId, context.id);
  assert.equal(result.data.acceptance.reason, 'user accepted the candidate');
  assert.equal(typeof result.data.acceptance.acceptedAt, 'string');
  assert.equal(result.data.acceptance.acceptedBy.sessionId, context.session.sessionId);

  // The freeze fact persists with the acceptance recorded.
  const shown = await runCli(['freeze', 'show', 'dev', '--json'], context);
  const fact = stdoutJson(shown.memory).data.freeze;
  assert.equal(fact.state, 'awaiting_human');
  assert.equal(fact.acceptance.reason, 'user accepted the candidate');
  const snapshot = await context.store.readSnapshot();
  assert.equal(snapshot.readJson('locks/dev.json').active, null);
});

test('freeze reject converts the freeze back into a machine_verifying lease via the CLI', async (t) => {
  const context = await setupFreezeCliFixture(t);
  const acquired = await enterViaCli(context);

  const { exitCode, memory } = await runCli([
    'freeze', 'reject', 'dev',
    '--requirement', context.id,
    '--reason', 'user rejected the candidate',
    '--json',
  ], context);

  assert.equal(exitCode, 0, memory.stderr.join(''));
  assert.equal(memory.stderr.join(''), '');
  const result = stdoutJson(memory);
  assert.equal(result.ok, true);
  assert.equal(result.data.requirementId, context.id);
  assert.equal(result.data.reason, 'user rejected the candidate');
  assert.equal(result.data.lease.holder.id, context.id);
  assert.equal(result.data.lease.version, 'v0.9.1');
  assert.equal(result.data.lease.commit, acquired.commit);
  assert.equal(result.data.previousFreeze.state, 'awaiting_human');

  // The fact is gone and the slot is re-occupied by the same requirement.
  const snapshot = await context.store.readSnapshot();
  assert.equal(snapshot.has('freezes/dev.json'), false);
  assert.equal(snapshot.readJson('locks/dev.json').active.holder.id, context.id);
  assert.equal(snapshot.readJson('locks/dev.json').active.version, 'v0.9.1');
  assert.equal(snapshot.readJson('locks/dev.json').lastEvent.type, 'reject');
});

test('freeze release clears the freeze and returns dev to available via the CLI', async (t) => {
  const context = await setupFreezeCliFixture(t);
  await enterViaCli(context);

  const { exitCode, memory } = await runCli([
    'freeze', 'release', 'dev',
    '--requirement', context.id,
    '--reason', 'user released the candidate',
    '--json',
  ], context);

  assert.equal(exitCode, 0, memory.stderr.join(''));
  const result = stdoutJson(memory);
  assert.equal(result.ok, true);
  assert.equal(result.data.released, true);
  assert.equal(result.data.reason, 'user released the candidate');

  const snapshot = await context.store.readSnapshot();
  assert.equal(snapshot.has('freezes/dev.json'), false);
  assert.equal(snapshot.readJson('locks/dev.json').active, null);
});

test('freeze accept/reject/release fail closed on missing reason or unknown freeze', async (t) => {
  const context = await setupFreezeCliFixture(t);
  await acquireDevLease(context);

  // Without a freeze fact, every decision path fails with FREEZE_NOT_FOUND.
  for (const action of ['accept', 'reject', 'release']) {
    const failed = await runCli([
      'freeze', action, 'dev',
      '--requirement', context.id,
      '--reason', 'user decision',
      '--json',
    ], context);
    assert.equal(failed.exitCode, 14, action);
    assert.equal(stderrJson(failed.memory).code, 'FREEZE_NOT_FOUND', action);
  }

  // Enter the freeze using the lease acquired above.
  const entered = await runCli(enterArgv(context), context);
  assert.equal(entered.exitCode, 0, entered.memory.stderr.join(''));

  // Missing --reason is a usage-level fail closed.
  for (const action of ['accept', 'reject', 'release']) {
    const failed = await runCli([
      'freeze', action, 'dev',
      '--requirement', context.id,
      '--json',
    ], context);
    assert.equal(failed.exitCode, 14, action);
    assert.equal(stderrJson(failed.memory).code, 'CLI_USAGE', action);
    assert.match(stderrJson(failed.memory).message, /missing required option: --reason/);
  }

  // A decision for a different requirement is rejected without touching the fact.
  const frozen = JSON.stringify((await context.store.readSnapshot()).readJson('freezes/dev.json'));
  const mismatched = await runCli([
    'freeze', 'accept', 'dev',
    '--requirement', 'I-999',
    '--reason', 'user decision',
    '--json',
  ], context);
  assert.equal(mismatched.exitCode, 14);
  assert.equal(stderrJson(mismatched.memory).code, 'FREEZE_REQUIREMENT_MISMATCH');
  const snapshot = await context.store.readSnapshot();
  assert.equal(JSON.stringify(snapshot.readJson('freezes/dev.json')), frozen);
});

// ============================================================================
// I-113 Task 3 (release approval CLI slice): `coord release-approval
// record/show/revoke` record the durable auto_after_machine_verification
// audit fact. The record entry is disabled in CI contexts, requires an
// explicit user instruction reference, and the prod guard consumes the fact
// fail closed — no fact means the manual acceptance path stays mandatory.
// ============================================================================

test('release-approval record/show/revoke expose stable JSON through the CLI', async (t) => {
  const context = await setupFreezeCliFixture(t);

  const recorded = await runCli([
    'release-approval', 'record', context.id,
    '--authorized-by', 'chensheng',
    '--instruction-ref', 'user said: 测试后直接上线',
    '--json',
  ], context);
  assert.equal(recorded.exitCode, 0, recorded.memory.stderr.join(''));
  assert.equal(recorded.memory.stderr.join(''), '');
  const record = stdoutJson(recorded.memory);
  assert.equal(record.ok, true);
  assert.equal(record.data.mode, 'auto_after_machine_verification');
  assert.equal(record.data.requirementId, context.id);
  assert.equal(record.data.authorizedBy, 'chensheng');
  assert.equal(record.data.instructionRef, 'user said: 测试后直接上线');
  assert.equal(record.data.scope, 'requirement');

  const shown = await runCli(['release-approval', 'show', context.id, '--json'], context);
  assert.equal(shown.exitCode, 0, shown.memory.stderr.join(''));
  const show = stdoutJson(shown.memory);
  assert.equal(show.data.approval.requirementId, context.id);
  assert.equal(show.data.approval.authorizedBy, 'chensheng');

  const revoked = await runCli([
    'release-approval', 'revoke', context.id,
    '--reason', 'user changed their mind',
    '--json',
  ], context);
  assert.equal(revoked.exitCode, 0, revoked.memory.stderr.join(''));
  assert.equal(stdoutJson(revoked.memory).data.revoked, true);

  const afterRevoke = await runCli(['release-approval', 'show', context.id, '--json'], context);
  assert.equal(afterRevoke.exitCode, 0, afterRevoke.memory.stderr.join(''));
  assert.equal(stdoutJson(afterRevoke.memory).data.approval, null);
});

test('release-approval CLI fails closed in CI, without instruction ref, or without an approval', async (t) => {
  const context = await setupFreezeCliFixture(t);

  const ci = await runCli([
    'release-approval', 'record', context.id,
    '--authorized-by', 'chensheng',
    '--instruction-ref', 'user instruction',
    '--json',
  ], {
    ...context,
    env: { ...context.env, CI: 'true' },
  });
  assert.equal(ci.exitCode, 14);
  assert.equal(stderrJson(ci.memory).code, 'APPROVAL_DISALLOWED_IN_CI');

  const missingRef = await runCli([
    'release-approval', 'record', context.id,
    '--authorized-by', 'chensheng',
    '--json',
  ], context);
  assert.equal(missingRef.exitCode, 14);
  assert.equal(stderrJson(missingRef.memory).code, 'CLI_USAGE');

  const missingApproval = await runCli([
    'release-approval', 'revoke', context.id,
    '--reason', 'no approval to revoke',
    '--json',
  ], context);
  assert.equal(missingApproval.exitCode, 14);
  assert.equal(stderrJson(missingApproval.memory).code, 'APPROVAL_NOT_FOUND');

  const snapshot = await context.store.readSnapshot();
  assert.equal(snapshot.has(`release-approvals/${context.id}.json`), false);
});

// ============================================================================
// I-113 Task 4 (candidate CLI slice): `coord candidate record/show/void` and
// `coord candidate assert-ref` wire the immutable candidate identity into
// the CLI with stable JSON. A candidate ref must be a full commit reachable
// from the requirement's bound branch; fix iterations never create SemVer
// tags.
// ============================================================================

test('candidate record/show/void expose stable JSON through the CLI', async (t) => {
  const context = await setupFreezeCliFixture(t);
  runGit(context.fixture.clientA, ['push', '--set-upstream', 'origin', `HEAD:refs/heads/${context.branch}`]);
  const commit = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);

  const recorded = await runCli([
    'candidate', 'record', context.id,
    '--ref', commit,
    '--service', 'web',
    '--service', 'admin',
    '--json',
  ], context);
  assert.equal(recorded.exitCode, 0, recorded.memory.stderr.join(''));
  assert.equal(recorded.memory.stderr.join(''), '');
  const record = stdoutJson(recorded.memory);
  assert.equal(record.ok, true);
  assert.equal(record.data.requirementId, context.id);
  assert.equal(record.data.sourceCommit, commit);
  assert.equal(record.data.branch, context.branch);
  assert.deepEqual(record.data.services, ['admin', 'web']);
  assert.equal(record.data.status, 'active');
  assert.match(record.data.candidateId, /^candidate-I-\d+-[a-f0-9]{40}-[a-f0-9]{64}$/);

  const shown = await runCli([
    'candidate', 'show', context.id,
    '--candidate', record.data.candidateId,
    '--json',
  ], context);
  assert.equal(shown.exitCode, 0, shown.memory.stderr.join(''));
  assert.equal(stdoutJson(shown.memory).data.candidate.sourceCommit, commit);

  const voided = await runCli([
    'candidate', 'void', context.id,
    '--candidate', record.data.candidateId,
    '--reason', 'runtime inputs changed',
    '--json',
  ], context);
  assert.equal(voided.exitCode, 0, voided.memory.stderr.join(''));
  assert.equal(stdoutJson(voided.memory).data.status, 'voided');

  const afterVoid = await runCli([
    'candidate', 'show', context.id,
    '--candidate', record.data.candidateId,
    '--json',
  ], context);
  assert.equal(stdoutJson(afterVoid.memory).data.candidate.status, 'voided');
});

test('candidate CLI fails closed on short refs, unreachable refs, and unknown candidates', async (t) => {
  const context = await setupFreezeCliFixture(t);
  const commit = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);

  const shortRef = await runCli([
    'candidate', 'record', context.id,
    '--ref', commit.slice(0, 7),
    '--json',
  ], context);
  assert.equal(shortRef.exitCode, 14);
  assert.equal(stderrJson(shortRef.memory).code, 'INVALID_CANDIDATE_REF');

  // A commit on an unrelated branch is unreachable from the bound branch.
  runGit(context.fixture.clientA, ['switch', '-c', 'feature/v0.9.1/other-cli-branch']);
  runGit(context.fixture.clientA, ['commit', '--allow-empty', '-m', 'unrelated']);
  const foreign = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  const unreachable = await runCli([
    'candidate', 'record', context.id,
    '--ref', foreign,
    '--json',
  ], context);
  assert.equal(unreachable.exitCode, 14);
  assert.equal(stderrJson(unreachable.memory).code, 'CANDIDATE_REF_UNREACHABLE');

  const missing = await runCli([
    'candidate', 'void', context.id,
    '--candidate', `candidate-${context.id}-${'d'.repeat(40)}-${'e'.repeat(64)}`,
    '--reason', 'test',
    '--json',
  ], context);
  assert.equal(missing.exitCode, 14);
  assert.equal(stderrJson(missing.memory).code, 'CANDIDATE_NOT_FOUND');
});

// ============================================================================
// I-134 (F3): `coord freeze unfreeze --outcome …` is the single human
// decision entry point. Each outcome is behaviorally identical to the
// historical accept/reject/release subcommands, which stay available as
// deprecated aliases running the same handler.
// ============================================================================

test('freeze unfreeze with each outcome matches the legacy decision commands', async (t) => {
  const context = await setupFreezeCliFixture(t);
  await enterViaCli(context);

  const accepted = await runCli([
    'freeze', 'unfreeze', 'dev',
    '--requirement', context.id,
    '--outcome', 'accepted',
    '--reason', 'user accepted the candidate',
    '--json',
  ], context);
  assert.equal(accepted.exitCode, 0, accepted.memory.stderr.join(''));
  const acceptedData = stdoutJson(accepted.memory).data;
  assert.equal(acceptedData.state, 'awaiting_human');
  assert.equal(acceptedData.requirementId, context.id);
  assert.equal(acceptedData.acceptance.reason, 'user accepted the candidate');
  assert.equal(acceptedData.acceptance.acceptedBy.sessionId, context.session.sessionId);
  // accepted keeps the fact durable, exactly like the legacy accept command.
  assert.equal((await context.store.readSnapshot()).has('freezes/dev.json'), true);

  const rejected = await runCli([
    'freeze', 'unfreeze', 'dev',
    '--requirement', context.id,
    '--outcome', 'rejected',
    '--reason', 'user rejected the candidate',
    '--json',
  ], context);
  assert.equal(rejected.exitCode, 0, rejected.memory.stderr.join(''));
  const rejectedData = stdoutJson(rejected.memory).data;
  assert.equal(rejectedData.lease.holder.id, context.id);
  assert.equal(rejectedData.lease.version, 'v0.9.1');
  assert.equal(rejectedData.previousFreeze.state, 'awaiting_human');
  let snapshot = await context.store.readSnapshot();
  assert.equal(snapshot.has('freezes/dev.json'), false);
  assert.equal(snapshot.readJson('locks/dev.json').active.holder.id, context.id);
  assert.equal(snapshot.readJson('locks/dev.json').lastEvent.type, 'reject');

  // Re-enter through the restored lease, then clear with released.
  const reentered = await runCli(enterArgv(context), context);
  assert.equal(reentered.exitCode, 0, reentered.memory.stderr.join(''));
  const released = await runCli([
    'freeze', 'unfreeze', 'dev',
    '--requirement', context.id,
    '--outcome', 'released',
    '--reason', 'user released the candidate',
    '--json',
  ], context);
  assert.equal(released.exitCode, 0, released.memory.stderr.join(''));
  assert.equal(stdoutJson(released.memory).data.released, true);
  snapshot = await context.store.readSnapshot();
  assert.equal(snapshot.has('freezes/dev.json'), false);
  assert.equal(snapshot.readJson('locks/dev.json').active, null);
});

test('freeze unfreeze rejects a missing or invalid outcome with CLI_USAGE', async (t) => {
  const context = await setupFreezeCliFixture(t);
  await enterViaCli(context);

  for (const argv of [
    ['freeze', 'unfreeze', 'dev',
      '--requirement', context.id, '--reason', 'user decision', '--json'],
    ['freeze', 'unfreeze', 'dev',
      '--requirement', context.id, '--outcome', 'maybe', '--reason', 'user decision', '--json'],
  ]) {
    const failed = await runCli(argv, context);
    assert.equal(failed.exitCode, 14);
    const error = stderrJson(failed.memory);
    assert.equal(error.code, 'CLI_USAGE');
    assert.match(error.message, /accepted, rejected, released/);
  }

  // The rejected attempts did not touch the freeze fact.
  const snapshot = await context.store.readSnapshot();
  assert.equal(snapshot.readJson('freezes/dev.json').state, 'awaiting_human');
});

test('freeze help lists unfreeze and marks the legacy decision aliases deprecated', async () => {
  const memory = createMemoryIo();
  const exitCode = await main(['freeze', '--help'], { ...memory.io, env: {} });
  assert.equal(exitCode, 0);
  const help = memory.stdout.join('');
  assert.match(help, /freeze unfreeze <resource>/);
  assert.match(help, /deprecated: use unfreeze --outcome accepted/);
  assert.match(help, /deprecated: use unfreeze --outcome rejected/);
  assert.match(help, /deprecated: use unfreeze --outcome released/);
});
