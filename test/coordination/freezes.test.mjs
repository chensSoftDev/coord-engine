import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { GitCoordinationStore } from '../../lib/coordination/git-store.mjs';
import {
  acquireLease,
  assertLease,
  breakLease,
  reconcileLeaseOperation,
  releaseLease,
} from '../../lib/coordination/leases.mjs';
import {
  acceptFreeze,
  enterFreeze,
  rejectFreeze,
  releaseFreeze,
  showFreeze,
  unfreezeFact,
} from '../../lib/coordination/freezes.mjs';
import {
  bindRequirementVersion,
  claimRequirement,
} from '../../lib/coordination/requirements.mjs';
import { gitCommonDir, initializeSession } from '../../lib/coordination/worktrees.mjs';
import { createGitFixture, runGit } from './fixtures.mjs';

dirname(fileURLToPath(import.meta.url));

// I-113 Task 3: an active dev lease converts atomically into a durable
// awaiting_human freeze fact bound to candidateId, the dev deployment
// snapshot and the machine-verification evidence; all three are mandatory.
// The lease slot is released in the same coordination update and the freeze
// fact itself carries no TTL.

function createStore(cwd, tempRoot, clock) {
  return new GitCoordinationStore({
    cwd,
    remote: 'origin',
    branch: 'coordination',
    tempRoot,
    clock,
  });
}

async function setupFreezeFixture(t, { initialNow = '2026-08-14T00:00:00.000Z' } = {}) {
  const fixture = createGitFixture(t);
  let now = new Date(initialNow);
  const clock = () => new Date(now);
  const setNow = (value) => {
    now = value instanceof Date ? value : new Date(value);
  };
  const store = createStore(fixture.clientA, fixture.tempRoot, clock);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const claimed = await claimRequirement({
    store,
    type: 'I',
    title: 'Freeze requirement',
    profile: 'runtime',
    backlogText: '| I-001 | fixture |\n',
  });
  await bindRequirementVersion({ store, id: claimed.id, version: 'v0.9.1' });
  const branch = 'feature/v0.9.1/freeze-requirement';
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
  return { fixture, store, id: claimed.id, branch, session, clock, setNow };
}

test('workflow v2 refuses to freeze arbitrary claimed evidence without current review and machine verification', async (t) => {
  const context = await setupFreezeFixture(t);
  const acquired = await acquireLease({ store: context.store, cwd: context.fixture.clientA, resource: 'dev',
    requirementId: context.id, ttl: '8h', session: context.session, clock: context.clock });
  await context.store.update({ operation: 'enroll fixture workflow', mutate(snapshot) {
    const path = `requirements/${context.id}.json`;
    snapshot.writeJson(path, { ...snapshot.readJson(path), workflowVersion: 2, validationEpoch: 0 });
  } });
  await assert.rejects(enterFreeze({ store: context.store, cwd: context.fixture.clientA,
    requirementId: context.id, candidateId: 'unverified-candidate', deploymentSnapshot: { environment: 'dev', commit: acquired.commit },
    machineVerificationEvidence: 'b'.repeat(64), session: context.session, clock: context.clock }), { code: 'FREEZE_VERIFICATION_REQUIRED' });
  assert.equal((await context.store.readSnapshot()).has('freezes/dev.json'), false);
});

test('workflow v2 acceptance requires a direct human message reference and approving identity', async (t) => {
  const context = await setupFreezeFixture(t);
  const acquired = await acquireLease({ store: context.store, cwd: context.fixture.clientA, resource: 'dev',
    requirementId: context.id, ttl: '8h', session: context.session, clock: context.clock });
  await enterFreeze({ store: context.store, cwd: context.fixture.clientA, requirementId: context.id,
    candidateId: 'legacy-candidate', deploymentSnapshot: { environment: 'dev', commit: acquired.commit },
    machineVerificationEvidence: 'b'.repeat(64), session: context.session, clock: context.clock });
  await context.store.update({ operation: 'enroll current frozen fixture', mutate(snapshot) {
    const path = `requirements/${context.id}.json`;
    snapshot.writeJson(path, { ...snapshot.readJson(path), workflowVersion: 2, validationEpoch: 0 });
    const freezePath = 'freezes/dev.json';
    snapshot.writeJson(freezePath, { ...snapshot.readJson(freezePath), validationEpoch: 0 });
  } });
  const args = { store: context.store, cwd: context.fixture.clientA, requirementId: context.id,
    reason: 'The user accepted this current candidate', session: context.session, clock: context.clock };
  await assert.rejects(acceptFreeze(args), { code: 'FREEZE_ACCEPTANCE_AUTHORIZATION_REQUIRED' });
  const accepted = await acceptFreeze({ ...args, authorizedBy: 'owner', instructionRef: 'user-message:20261026-accepted' });
  assert.equal(accepted.acceptance.authorizedBy, 'owner');
  assert.equal(accepted.acceptance.instructionRef, 'user-message:20261026-accepted');
});

test('an active dev lease converts atomically into a durable awaiting_human freeze fact', async (t) => {
  const context = await setupFreezeFixture(t);
  const acquired = await acquireLease({
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'dev',
    requirementId: context.id,
    ttl: '8h',
    session: context.session,
    clock: context.clock,
  });

  const candidateId = 'candidate-I-001-abc123';
  const deploymentSnapshot = { environment: 'dev', commit: acquired.commit };
  const machineVerificationEvidence = 'b'.repeat(64);

  const freeze = await enterFreeze({
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'dev',
    requirementId: context.id,
    candidateId,
    deploymentSnapshot,
    machineVerificationEvidence,
    session: context.session,
    clock: context.clock,
  });

  assert.equal(freeze.schemaVersion, 1);
  assert.equal(freeze.resource, 'dev');
  assert.equal(freeze.state, 'awaiting_human');
  assert.equal(freeze.requirementId, context.id);
  // I-130 (D1): the freeze fact carries the lease's bound version.
  assert.equal(freeze.version, 'v0.9.1');
  assert.equal(freeze.candidateId, candidateId);
  assert.deepEqual(freeze.deploymentSnapshot, deploymentSnapshot);
  assert.equal(freeze.machineVerificationEvidence, machineVerificationEvidence);
  assert.equal(freeze.branch, context.branch);
  assert.equal(freeze.commit, acquired.commit);
  // Durable: no automatic TTL on the freeze fact itself.
  assert.equal(freeze.expiresAt, undefined);
  assert.equal(freeze.frozenAt, '2026-08-14T00:00:00.000Z');
  assert.equal(freeze.actor?.sessionId, context.session.sessionId);

  // Atomic conversion: the lease slot is empty in the same final state and
  // the freeze fact is persisted verbatim on the coordination branch.
  const snapshot = await context.store.readSnapshot();
  const lock = snapshot.readJson('locks/dev.json');
  assert.equal(lock.active, null, 'lease slot must be released by the freeze conversion');
  assert.equal(lock.lastEvent?.type, 'freeze');
  assert.equal(lock.lastEvent?.previous?.ownerToken, acquired.ownerToken);
  const fact = snapshot.readJson('freezes/dev.json');
  assert.equal(fact.state, 'awaiting_human');
  assert.equal(fact.requirementId, context.id);
  assert.equal(fact.candidateId, candidateId);
  assert.deepEqual(fact.deploymentSnapshot, deploymentSnapshot);
  assert.equal(fact.machineVerificationEvidence, machineVerificationEvidence);
  assert.equal(fact.expiresAt, undefined);
});

test('breakLease cannot clear a frozen dev resource', async (t) => {
  const context = await setupFreezeFixture(t);
  const acquired = await acquireLease({
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'dev',
    requirementId: context.id,
    ttl: '8h',
    session: context.session,
    clock: context.clock,
  });
  await enterFreeze({
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'dev',
    requirementId: context.id,
    candidateId: 'candidate-I-001-abc123',
    deploymentSnapshot: { environment: 'dev', commit: acquired.commit },
    machineVerificationEvidence: 'b'.repeat(64),
    session: context.session,
    clock: context.clock,
  });

  // An ordinary break — even forced — must not remove the durable freeze
  // fact; only accept/reject/release paths may clear it.
  await assert.rejects(
    breakLease({
      store: context.store,
      cwd: context.fixture.clientA,
      resource: 'dev',
      reason: 'operator cleanup attempt while frozen',
      force: true,
      session: context.session,
      clock: context.clock,
    }),
    (error) => error.code === 'FREEZE_ACTIVE',
  );

  const snapshot = await context.store.readSnapshot();
  const fact = snapshot.readJson('freezes/dev.json');
  assert.equal(fact.state, 'awaiting_human', 'freeze fact must survive breakLease');
  assert.equal(fact.requirementId, context.id);
});

// I-113 Task 3: the freeze fact has no TTL — it survives past the original
// lease's 8h expiry and still blocks any lease break (including force) until
// a human accept/reject/release clears it.
test('a durable freeze fact outlives the original lease TTL and blocks force breaks', async (t) => {
  const context = await setupFreezeFixture(t);
  const acquired = await acquireLease({
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'dev',
    requirementId: context.id,
    ttl: '8h',
    session: context.session,
    clock: context.clock,
  });

  const candidateId = 'candidate-I-001-def456';
  const deploymentSnapshot = { environment: 'dev', commit: acquired.commit };
  const machineVerificationEvidence = 'c'.repeat(64);
  await enterFreeze({
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'dev',
    requirementId: context.id,
    candidateId,
    deploymentSnapshot,
    machineVerificationEvidence,
    session: context.session,
    clock: context.clock,
  });

  // Advance well past the original lease's 8h TTL.
  context.setNow('2026-08-14T12:00:00.000Z');

  const shown = await showFreeze({ store: context.store, resource: 'dev' });
  assert.equal(shown.candidateId, candidateId);
  assert.equal(shown.state, 'awaiting_human');
  assert.equal(shown.expiresAt, undefined);

  await assert.rejects(
    breakLease({
      store: context.store,
      cwd: context.fixture.clientA,
      resource: 'dev',
      reason: 'attempting to break a frozen resource',
      force: true,
      session: context.session,
      clock: context.clock,
    }),
    (error) => {
      assert.equal(error.name, 'LeaseError');
      assert.equal(error.code, 'FREEZE_ACTIVE');
      assert.equal(error.exitCode, 10);
      return true;
    },
  );

  // The freeze fact is unchanged by the rejected break.
  const fact = (await context.store.readSnapshot()).readJson('freezes/dev.json');
  assert.equal(fact.state, 'awaiting_human');
  assert.equal(fact.requirementId, context.id);
  assert.equal(fact.candidateId, candidateId);
  assert.deepEqual(fact.deploymentSnapshot, deploymentSnapshot);
  assert.equal(fact.machineVerificationEvidence, machineVerificationEvidence);
  assert.equal(fact.expiresAt, undefined);
});

function freezeArgs(context, acquired, overrides = {}) {
  return {
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'dev',
    requirementId: context.id,
    candidateId: `candidate-${context.id}-${acquired.commit}`,
    deploymentSnapshot: { environment: 'dev', commit: acquired.commit },
    machineVerificationEvidence: 'b'.repeat(64),
    session: context.session,
    clock: context.clock,
    ...overrides,
  };
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

// I-113 Task 3: fail-closed input validation — a missing candidateId, dev
// deployment snapshot or machine-verification evidence must be rejected
// before any coordination write; the lease stays untouched.
test('enterFreeze fails closed when a required binding is missing', async (t) => {
  const context = await setupFreezeFixture(t);
  const acquired = await acquireDevLease(context);

  for (const overrides of [
    { candidateId: undefined },
    { candidateId: '   ' },
    { deploymentSnapshot: undefined },
    { deploymentSnapshot: null },
    { machineVerificationEvidence: undefined },
    { machineVerificationEvidence: '' },
  ]) {
    await assert.rejects(
      enterFreeze(freezeArgs(context, acquired, overrides)),
      (error) => error.code === 'MISSING_FREEZE_BINDING' && error.exitCode === 14,
    );
  }

  const snapshot = await context.store.readSnapshot();
  assert.equal(snapshot.has('freezes/dev.json'), false, 'no freeze fact may be written');
  assert.notEqual(
    snapshot.readJson('locks/dev.json').active,
    null,
    'the lease must stay untouched',
  );
});

// I-113 Task 3: fail-closed identity checks — an unclaimed requirement id
// and an expired lease must both be rejected without writing a freeze fact
// or consuming the lease.
test('enterFreeze fails closed when the lease identity does not match', async (t) => {
  const context = await setupFreezeFixture(t);
  const acquired = await acquireDevLease(context);

  await assert.rejects(
    enterFreeze(freezeArgs(context, acquired, { requirementId: 'I-999' })),
    (error) => error.code === 'REQUIREMENT_NOT_FOUND',
  );

  // Past the 8h lease TTL the conversion must fail closed as well.
  context.setNow('2026-08-14T09:00:00.000Z');
  await assert.rejects(
    enterFreeze(freezeArgs(context, acquired)),
    (error) => error.code === 'LEASE_EXPIRED' && error.exitCode === 11,
  );

  const snapshot = await context.store.readSnapshot();
  assert.equal(snapshot.has('freezes/dev.json'), false);
  assert.notEqual(snapshot.readJson('locks/dev.json').active, null);
});

// I-130 (D1): the freeze conversion is version-level — the lease's bound
// version must equal the requirement's, and an unbound requirement fails
// closed with REQUIREMENT_VERSION_UNBOUND. Neither attempt may consume the
// lease or write a freeze fact.
test('enterFreeze fails closed on a version mismatch or an unbound requirement version', async (t) => {
  const context = await setupFreezeFixture(t);
  const acquired = await acquireDevLease(context);

  await bindRequirementVersion({ store: context.store, id: context.id, version: 'v0.9.2', force: true });
  await assert.rejects(
    enterFreeze(freezeArgs(context, acquired)),
    (error) => (
      error.code === 'LEASE_VERSION_MISMATCH'
      && error.exitCode === 11
      && error.data?.leaseVersion === 'v0.9.1'
      && error.data?.requirementVersion === 'v0.9.2'
    ),
  );

  await context.store.update({
    operation: `unbind version for ${context.id}`,
    mutate(snapshot) {
      const path = `requirements/${context.id}.json`;
      const requirement = snapshot.readJson(path);
      delete requirement.version;
      snapshot.writeJson(path, requirement);
    },
  });
  await assert.rejects(
    enterFreeze(freezeArgs(context, acquired)),
    (error) => error.code === 'REQUIREMENT_VERSION_UNBOUND' && error.exitCode === 12,
  );

  const snapshot = await context.store.readSnapshot();
  assert.equal(snapshot.has('freezes/dev.json'), false, 'no freeze fact may be written');
  assert.notEqual(
    snapshot.readJson('locks/dev.json').active,
    null,
    'the lease must stay untouched',
  );
});

// I-113 Task 3: a second conversion attempt must not overwrite the durable
// freeze fact, and a plain (non-force) break is rejected by the same guard
// as a forced one.
test('enterFreeze fails closed when a freeze already exists and plain breaks are blocked', async (t) => {
  const context = await setupFreezeFixture(t);
  const acquired = await acquireDevLease(context);
  await enterFreeze(freezeArgs(context, acquired));
  const frozenFact = JSON.stringify(
    (await context.store.readSnapshot()).readJson('freezes/dev.json'),
  );

  await assert.rejects(
    enterFreeze(freezeArgs(context, acquired)),
    (error) => error.code === 'FREEZE_EXISTS' && error.exitCode === 10,
  );
  await assert.rejects(
    breakLease({
      store: context.store,
      cwd: context.fixture.clientA,
      resource: 'dev',
      reason: 'plain break attempt while frozen',
      session: context.session,
      clock: context.clock,
    }),
    (error) => error.code === 'FREEZE_ACTIVE' && error.exitCode === 10,
  );

  const after = JSON.stringify(
    (await context.store.readSnapshot()).readJson('freezes/dev.json'),
  );
  assert.equal(after, frozenFact, 'the freeze fact must be byte-identical after rejected writes');
});

async function injectFreezeFact(context, fact) {
  await context.store.update({
    operation: 'inject freeze fact',
    mutate(snapshot) {
      snapshot.writeJson('freezes/dev.json', fact);
    },
  });
}

// I-113 review: a malformed freezes/dev.json must fail closed with
// INVALID_FREEZE_STATE — enterFreeze must never overwrite it and must not
// consume the active lease.
test('enterFreeze fails closed on a malformed freeze fact without touching the lease', async (t) => {
  const malformedFacts = [
    { schemaVersion: 1, resource: 'dev', state: 'released' },
    { schemaVersion: 1, resource: 'dev', state: 'awaiting_human' },
  ];
  for (const malformed of malformedFacts) {
    const context = await setupFreezeFixture(t);
    const acquired = await acquireDevLease(context);
    await injectFreezeFact(context, malformed);
    const before = JSON.stringify(
      (await context.store.readSnapshot()).readJson('freezes/dev.json'),
    );

    await assert.rejects(
      enterFreeze(freezeArgs(context, acquired)),
      (error) => error.code === 'INVALID_FREEZE_STATE',
    );

    const snapshot = await context.store.readSnapshot();
    assert.equal(
      JSON.stringify(snapshot.readJson('freezes/dev.json')),
      before,
      'the malformed freeze fact must not be overwritten',
    );
    assert.notEqual(
      snapshot.readJson('locks/dev.json').active,
      null,
      'the active lease must not be consumed',
    );
  }
});

// I-113 review fix: after a successful enterFreeze, the same
// requirement/session re-acquiring the dev lease must be rejected with
// FREEZE_ACTIVE exit 10, and the freeze fact must stay byte-identical.
test('freeze active blocks acquireLease', async (t) => {
  const context = await setupFreezeFixture(t);
  const acquired = await acquireDevLease(context);
  await enterFreeze(freezeArgs(context, acquired));
  const frozenFact = JSON.stringify(
    (await context.store.readSnapshot()).readJson('freezes/dev.json'),
  );

  await assert.rejects(
    acquireLease({
      store: context.store,
      cwd: context.fixture.clientA,
      resource: 'dev',
      requirementId: context.id,
      ttl: '8h',
      session: context.session,
      clock: context.clock,
    }),
    (error) => error.code === 'FREEZE_ACTIVE' && error.exitCode === 10,
  );

  const snapshot = await context.store.readSnapshot();
  assert.equal(
    JSON.stringify(snapshot.readJson('freezes/dev.json')),
    frozenFact,
    'the freeze fact must be unchanged by the rejected acquire',
  );
  assert.equal(
    snapshot.readJson('locks/dev.json').active,
    null,
    'the rejected acquire must not create a new lease',
  );
});

// I-113 review fix: a corrupt freezes/dev.json (unknown state) must fail
// closed with INVALID_FREEZE_STATE — enterFreeze must not overwrite it or
// consume the active lease, and even a forced breakLease must be rejected
// without writing the lock.
test('malformed freeze fails closed', async (t) => {
  const context = await setupFreezeFixture(t);
  const acquired = await acquireDevLease(context);
  await injectFreezeFact(context, {
    schemaVersion: 1,
    resource: 'dev',
    state: 'corrupt',
  });
  const before = await context.store.readSnapshot();
  const frozenFact = JSON.stringify(before.readJson('freezes/dev.json'));
  const lockBefore = JSON.stringify(before.readJson('locks/dev.json'));

  await assert.rejects(
    enterFreeze(freezeArgs(context, acquired)),
    (error) => error.code === 'INVALID_FREEZE_STATE',
  );

  await assert.rejects(
    breakLease({
      store: context.store,
      cwd: context.fixture.clientA,
      resource: 'dev',
      reason: 'force break attempt on a corrupt freeze fact',
      force: true,
      session: context.session,
      clock: context.clock,
    }),
    (error) => error.code === 'INVALID_FREEZE_STATE',
  );

  const after = await context.store.readSnapshot();
  assert.equal(
    JSON.stringify(after.readJson('freezes/dev.json')),
    frozenFact,
    'the corrupt freeze fact must not be overwritten',
  );
  assert.equal(
    JSON.stringify(after.readJson('locks/dev.json')),
    lockBefore,
    'the lock must stay byte-identical: lease not consumed, no lock write',
  );
  assert.notEqual(
    after.readJson('locks/dev.json').active,
    null,
    'the active lease must not be consumed',
  );
});

// I-113 review: an uncertain push (exit 15) during enterFreeze must leave a
// durable, reconcilable local lease-operation record — exactly like
// acquire/release/break do via updateLeaseState. reconcileLeaseOperation must
// close the record as applied with action 'freeze' and the consumed lease's
// local token must be cleaned up, so an operator can always recover with
// `coord reconcile`.
test('enterFreeze is reconcilable after an uncertain push', async (t) => {
  const context = await setupFreezeFixture(t);
  const acquired = await acquireDevLease(context);

  // Simulate a push that applied remotely but whose client result was lost:
  // the real update succeeds, then the wrapper surfaces exit 15 carrying the
  // durable operationId. enterFreeze only reads the snapshot (pre-flight
  // precedence check) and writes via store.update, so the wrapper implements
  // just those two methods.
  const realStore = context.store;
  const uncertainStore = {
    readSnapshot: () => realStore.readSnapshot(),
    update: async (args) => {
      const applied = await realStore.update(args);
      const error = new Error('simulated uncertain');
      error.code = 'UNCERTAIN_PUSH_RESULT';
      error.exitCode = 15;
      error.data = { operationId: applied.operationId };
      throw error;
    },
  };

  let failed;
  try {
    await enterFreeze(freezeArgs(context, acquired, { store: uncertainStore }));
  } catch (error) {
    failed = error;
  }

  assert.equal(failed?.exitCode, 15, 'an unprovable push result must surface exit 15');
  const operationId = failed?.data?.operationId;
  assert.ok(operationId, 'exit 15 must carry the operationId for later reconcile');

  // The freeze conversion was actually applied on the coordination branch,
  // while the local token cleanup never ran.
  const snapshot = await realStore.readSnapshot();
  assert.equal(snapshot.readJson('freezes/dev.json').state, 'awaiting_human');
  assert.equal(
    snapshot.readJson('locks/dev.json').active,
    null,
    'the lease slot is consumed by the applied freeze',
  );
  const tokenFile = join(
    gitCommonDir(context.fixture.clientA),
    'coordination',
    'lease-tokens',
    `dev-${context.session.sessionId}.json`,
  );
  assert.equal(existsSync(tokenFile), true, 'the local lease token must still exist');

  // The uncertain operation must be durably reconcilable like any lease op,
  // and reconcile must close out the consumed lease's local token.
  const reconciled = await reconcileLeaseOperation({
    store: realStore,
    cwd: context.fixture.clientA,
    operationId,
  });
  assert.equal(reconciled.applied, true);
  assert.equal(reconciled.action, 'freeze');
  assert.equal(existsSync(tokenFile), false, 'the local lease token must be cleaned up');
});

// I-113 review: lifecycle's pure BACKLOG.md projection commits are audit
// closures of the same deployed commit — renewLease already tolerates that
// drift for the dev resource. enterFreeze must apply the same tolerance and
// still bind the lease's verified commit, while any non-BACKLOG drift keeps
// failing closed with LEASE_REVISION_MISMATCH.
test('enterFreeze tolerates a pure BACKLOG projection commit and rejects content drift', async (t) => {
  const context = await setupFreezeFixture(t);
  const acquired = await acquireDevLease(context);

  // A lifecycle BACKLOG-only projection commit lands after the lease was
  // acquired: HEAD moves, but the deployed/verified commit is unchanged.
  writeFileSync(
    join(context.fixture.clientA, 'BACKLOG.md'),
    '| I-001 | fixture |\n| I-002 | lifecycle projection |\n',
  );
  runGit(context.fixture.clientA, ['add', 'BACKLOG.md']);
  runGit(context.fixture.clientA, ['commit', '-m', 'test: backlog projection']);
  assert.notEqual(
    runGit(context.fixture.clientA, ['rev-parse', 'HEAD']),
    acquired.commit,
    'HEAD must actually move for the tolerance to be exercised',
  );

  const freeze = await enterFreeze(freezeArgs(context, acquired));
  assert.equal(freeze.branch, context.branch);
  assert.equal(freeze.commit, acquired.commit, 'the freeze binds the verified lease commit');

  // A non-BACKLOG content change must still fail closed without consuming
  // the lease or writing a freeze fact.
  const drifted = await setupFreezeFixture(t);
  const acquiredDrifted = await acquireDevLease(drifted);
  writeFileSync(join(drifted.fixture.clientA, 'content.txt'), 'content drift\n');
  runGit(drifted.fixture.clientA, ['add', 'content.txt']);
  runGit(drifted.fixture.clientA, ['commit', '-m', 'test: content drift']);
  await assert.rejects(
    enterFreeze(freezeArgs(drifted, acquiredDrifted)),
    (error) => error.code === 'LEASE_REVISION_MISMATCH' && error.exitCode === 11,
  );
  const snapshot = await drifted.store.readSnapshot();
  assert.equal(snapshot.has('freezes/dev.json'), false, 'no freeze fact may be written');
  assert.notEqual(
    snapshot.readJson('locks/dev.json').active,
    null,
    'the lease must stay untouched',
  );
});

// ============================================================================
// I-113 Task 3 (accept/reject/release slice): the durable awaiting_human
// freeze fact can only be cleared by explicit human decision paths. accept
// records the acceptance on the fact (freeze persists until prod success);
// reject atomically converts the fact back into a fresh machine_verifying
// dev lease for the same requirement (no other requirement can grab the slot
// in between); release clears the fact and returns dev to available.
// ============================================================================

async function enterFreezeFor(context) {
  const acquired = await acquireDevLease(context);
  await enterFreeze(freezeArgs(context, acquired));
  return acquired;
}

test('acceptFreeze records the human acceptance and keeps the freeze fact durable', async (t) => {
  const context = await setupFreezeFixture(t);
  await enterFreezeFor(context);

  const accepted = await acceptFreeze({
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'dev',
    requirementId: context.id,
    reason: 'user accepted the candidate',
    session: context.session,
    clock: context.clock,
  });

  assert.equal(accepted.state, 'awaiting_human');
  assert.equal(accepted.requirementId, context.id);
  assert.equal(accepted.acceptance?.reason, 'user accepted the candidate');
  assert.equal(accepted.acceptance?.acceptedAt, '2026-08-14T00:00:00.000Z');
  assert.equal(accepted.acceptance?.acceptedBy?.sessionId, context.session.sessionId);
  assert.ok(accepted.acceptance?.acceptedBy?.agent, 'actor metadata is recorded');

  // The fact persists and still blocks the dev resource.
  const fact = (await context.store.readSnapshot()).readJson('freezes/dev.json');
  assert.equal(fact.state, 'awaiting_human');
  assert.equal(fact.acceptance?.reason, 'user accepted the candidate');
  assert.equal(fact.acceptance?.acceptedAt, '2026-08-14T00:00:00.000Z');
  await assert.rejects(
    acquireLease({
      store: context.store,
      cwd: context.fixture.clientA,
      resource: 'dev',
      requirementId: context.id,
      ttl: '8h',
      session: context.session,
      clock: context.clock,
    }),
    (error) => error.code === 'FREEZE_ACTIVE' && error.exitCode === 10,
  );
});

test('acceptFreeze fails closed when the freeze is missing, owned by another requirement, or has no reason', async (t) => {
  const context = await setupFreezeFixture(t);

  // No freeze fact at all.
  await assert.rejects(
    acceptFreeze({
      store: context.store,
      cwd: context.fixture.clientA,
      resource: 'dev',
      requirementId: context.id,
      reason: 'user accepted',
      session: context.session,
      clock: context.clock,
    }),
    (error) => error.code === 'FREEZE_NOT_FOUND' && error.exitCode === 14,
  );

  await enterFreezeFor(context);
  const before = JSON.stringify((await context.store.readSnapshot()).readJson('freezes/dev.json'));

  // A different requirement cannot accept someone else's freeze.
  await assert.rejects(
    acceptFreeze({
      store: context.store,
      cwd: context.fixture.clientA,
      resource: 'dev',
      requirementId: 'I-999',
      reason: 'user accepted',
      session: context.session,
      clock: context.clock,
    }),
    (error) => error.code === 'FREEZE_REQUIREMENT_MISMATCH' && error.exitCode === 14,
  );

  // An acceptance without a reason is not an auditable human decision.
  await assert.rejects(
    acceptFreeze({
      store: context.store,
      cwd: context.fixture.clientA,
      resource: 'dev',
      requirementId: context.id,
      session: context.session,
      clock: context.clock,
    }),
    (error) => error.code === 'MISSING_FREEZE_REASON' && error.exitCode === 14,
  );

  // None of the rejected attempts changed the fact.
  const after = JSON.stringify((await context.store.readSnapshot()).readJson('freezes/dev.json'));
  assert.equal(after, before);
});

test('rejectFreeze atomically converts the freeze back into a machine_verifying lease', async (t) => {
  const context = await setupFreezeFixture(t);
  const acquired = await enterFreezeFor(context);

  const rejected = await rejectFreeze({
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'dev',
    requirementId: context.id,
    reason: 'user rejected the candidate',
    session: context.session,
    clock: context.clock,
  });

  assert.equal(rejected.requirementId, context.id);
  assert.equal(rejected.reason, 'user rejected the candidate');
  assert.equal(rejected.lease?.holder?.id, context.id);
  // I-130 (D1): the resumed machine_verifying lease backfills the frozen version.
  assert.equal(rejected.lease?.version, 'v0.9.1');
  assert.equal(rejected.lease?.sessionId, context.session.sessionId);
  assert.equal(rejected.lease?.branch, context.branch);
  assert.equal(rejected.lease?.commit, acquired.commit, 'the lease binds the current worktree commit');
  assert.ok(rejected.lease?.ownerToken, 'a fresh owner token is issued');
  assert.ok(rejected.lease?.expiresAt, 'the machine_verifying lease has a TTL again');

  // Atomic: the fact is gone and the slot is occupied in the same state.
  const snapshot = await context.store.readSnapshot();
  assert.equal(snapshot.has('freezes/dev.json'), false, 'the freeze fact is consumed');
  const lock = snapshot.readJson('locks/dev.json');
  assert.notEqual(lock.active, null, 'the dev slot is immediately re-occupied');
  assert.equal(lock.active.holder?.id, context.id);
  assert.equal(lock.active.version, 'v0.9.1');
  assert.equal(lock.schemaVersion, 2);
  assert.equal(lock.lastEvent?.type, 'reject');

  // The same requirement can keep verifying against the shared dev.
  const asserted = await assertLease({
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'dev',
    requirementId: context.id,
    commit: 'HEAD',
    session: context.session,
    clock: context.clock,
  });
  assert.equal(asserted.ownerToken, rejected.lease.ownerToken);
});

test('rejectFreeze fails closed without a freeze, with a mismatched requirement, or without a reason', async (t) => {
  const context = await setupFreezeFixture(t);

  await assert.rejects(
    rejectFreeze({
      store: context.store,
      cwd: context.fixture.clientA,
      resource: 'dev',
      requirementId: context.id,
      reason: 'user rejected',
      session: context.session,
      clock: context.clock,
    }),
    (error) => error.code === 'FREEZE_NOT_FOUND' && error.exitCode === 14,
  );

  await enterFreezeFor(context);
  const frozen = JSON.stringify((await context.store.readSnapshot()).readJson('freezes/dev.json'));

  await assert.rejects(
    rejectFreeze({
      store: context.store,
      cwd: context.fixture.clientA,
      resource: 'dev',
      requirementId: 'I-999',
      reason: 'user rejected',
      session: context.session,
      clock: context.clock,
    }),
    (error) => error.code === 'FREEZE_REQUIREMENT_MISMATCH' && error.exitCode === 14,
  );

  await assert.rejects(
    rejectFreeze({
      store: context.store,
      cwd: context.fixture.clientA,
      resource: 'dev',
      requirementId: context.id,
      session: context.session,
      clock: context.clock,
    }),
    (error) => error.code === 'MISSING_FREEZE_REASON' && error.exitCode === 14,
  );

  const snapshot = await context.store.readSnapshot();
  assert.equal(
    JSON.stringify(snapshot.readJson('freezes/dev.json')),
    frozen,
    'the freeze fact survives every rejected attempt',
  );
  assert.equal(snapshot.readJson('locks/dev.json').active, null, 'no lease is created');
});

test('releaseFreeze clears the freeze and returns dev to available', async (t) => {
  const context = await setupFreezeFixture(t);
  await enterFreezeFor(context);

  const released = await releaseFreeze({
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'dev',
    requirementId: context.id,
    reason: 'user released the candidate',
    session: context.session,
    clock: context.clock,
  });

  assert.equal(released.requirementId, context.id);
  assert.equal(released.reason, 'user released the candidate');
  assert.equal(released.released, true);

  const snapshot = await context.store.readSnapshot();
  assert.equal(snapshot.has('freezes/dev.json'), false, 'the freeze fact is cleared');
  assert.equal(snapshot.readJson('locks/dev.json').active, null, 'dev is available again');

  // A later requirement can now acquire the dev resource.
  const reacquired = await acquireLease({
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'dev',
    requirementId: context.id,
    ttl: '8h',
    session: context.session,
    clock: context.clock,
  });
  assert.equal(reacquired.holder?.id, context.id);
});

test('releaseFreeze fails closed without a freeze, with a mismatched requirement, or without a reason', async (t) => {
  const context = await setupFreezeFixture(t);

  await assert.rejects(
    releaseFreeze({
      store: context.store,
      cwd: context.fixture.clientA,
      resource: 'dev',
      requirementId: context.id,
      reason: 'user released',
      session: context.session,
      clock: context.clock,
    }),
    (error) => error.code === 'FREEZE_NOT_FOUND' && error.exitCode === 14,
  );

  await enterFreezeFor(context);
  const frozen = JSON.stringify((await context.store.readSnapshot()).readJson('freezes/dev.json'));

  await assert.rejects(
    releaseFreeze({
      store: context.store,
      cwd: context.fixture.clientA,
      resource: 'dev',
      requirementId: 'I-999',
      reason: 'user released',
      session: context.session,
      clock: context.clock,
    }),
    (error) => error.code === 'FREEZE_REQUIREMENT_MISMATCH' && error.exitCode === 14,
  );

  await assert.rejects(
    releaseFreeze({
      store: context.store,
      cwd: context.fixture.clientA,
      resource: 'dev',
      requirementId: context.id,
      session: context.session,
      clock: context.clock,
    }),
    (error) => error.code === 'MISSING_FREEZE_REASON' && error.exitCode === 14,
  );

  const snapshot = await context.store.readSnapshot();
  assert.equal(
    JSON.stringify(snapshot.readJson('freezes/dev.json')),
    frozen,
    'the freeze fact survives every rejected attempt',
  );
});

test('an accepted freeze still blocks force breaks until a release or reject clears it', async (t) => {
  const context = await setupFreezeFixture(t);
  await enterFreezeFor(context);
  await acceptFreeze({
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'dev',
    requirementId: context.id,
    reason: 'user accepted',
    session: context.session,
    clock: context.clock,
  });

  await assert.rejects(
    breakLease({
      store: context.store,
      cwd: context.fixture.clientA,
      resource: 'dev',
      reason: 'force break after acceptance',
      force: true,
      session: context.session,
      clock: context.clock,
    }),
    (error) => error.code === 'FREEZE_ACTIVE' && error.exitCode === 10,
  );

  // Rejection after acceptance converts back into a machine_verifying lease.
  const rejected = await rejectFreeze({
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'dev',
    requirementId: context.id,
    reason: 'smoke failed after acceptance, back to machine verification',
    session: context.session,
    clock: context.clock,
  });
  assert.equal(rejected.lease?.holder?.id, context.id);
});

test('releaseLease cannot release the dev resource while a freeze is active', async (t) => {
  const context = await setupFreezeFixture(t);
  const acquired = await acquireDevLease(context);
  await enterFreeze(freezeArgs(context, acquired));

  // Even though the caller's session identity matches the frozen requirement,
  // a plain lease release must not be able to clear the durable freeze fact:
  // the freeze slot owns the dev resource until a human decision path runs.
  await assert.rejects(
    releaseLease({
      store: context.store,
      cwd: context.fixture.clientA,
      resource: 'dev',
      session: context.session,
      clock: context.clock,
    }),
    (error) => error.code === 'FREEZE_ACTIVE' && error.exitCode === 10,
  );

  const snapshot = await context.store.readSnapshot();
  const fact = snapshot.readJson('freezes/dev.json');
  assert.equal(fact.state, 'awaiting_human', 'the freeze fact must survive releaseLease');
  assert.equal(snapshot.readJson('locks/dev.json').active, null);
});

// ============================================================================
// I-134 (F3): unfreezeFact is the single source behind the acceptFreeze /
// rejectFreeze / releaseFreeze wrappers. An unknown outcome fails closed
// before any validation or coordination write; each outcome through
// unfreezeFact is equivalent to its historical wrapper.
// ============================================================================

test('unfreezeFact rejects an invalid outcome before touching coordination state', async (t) => {
  const context = await setupFreezeFixture(t);
  await assert.rejects(
    unfreezeFact({
      outcome: 'maybe',
      store: context.store,
      cwd: context.fixture.clientA,
      resource: 'dev',
      requirementId: context.id,
      reason: 'user decision',
      session: context.session,
      clock: context.clock,
    }),
    (error) => error.code === 'INVALID_UNFREEZE_OUTCOME' && error.exitCode === 14,
  );
  const snapshot = await context.store.readSnapshot();
  assert.equal(snapshot.has('freezes/dev.json'), false);
});

test('unfreezeFact outcomes match the accept/reject/release wrappers', async (t) => {
  const context = await setupFreezeFixture(t);
  await enterFreezeFor(context);

  const accepted = await unfreezeFact({
    outcome: 'accepted',
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'dev',
    requirementId: context.id,
    reason: 'user accepted the candidate',
    session: context.session,
    clock: context.clock,
  });
  assert.equal(accepted.state, 'awaiting_human');
  assert.equal(accepted.acceptance?.reason, 'user accepted the candidate');
  assert.equal(accepted.acceptance?.acceptedBy?.sessionId, context.session.sessionId);

  const rejected = await unfreezeFact({
    outcome: 'rejected',
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'dev',
    requirementId: context.id,
    reason: 'user rejected the candidate',
    session: context.session,
    clock: context.clock,
  });
  assert.equal(rejected.lease.holder.id, context.id);
  assert.equal(rejected.lease.version, 'v0.9.1');
  assert.equal(rejected.previousFreeze.state, 'awaiting_human');
  let snapshot = await context.store.readSnapshot();
  assert.equal(snapshot.has('freezes/dev.json'), false);
  assert.equal(snapshot.readJson('locks/dev.json').lastEvent.type, 'reject');

  // Re-enter through the restored lease, then clear with the released outcome.
  await enterFreezeFor(context);
  const released = await unfreezeFact({
    outcome: 'released',
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'dev',
    requirementId: context.id,
    reason: 'user released the candidate',
    session: context.session,
    clock: context.clock,
  });
  assert.equal(released.released, true);
  assert.equal(released.previousFreeze.state, 'awaiting_human');
  snapshot = await context.store.readSnapshot();
  assert.equal(snapshot.has('freezes/dev.json'), false);
  assert.equal(snapshot.readJson('locks/dev.json').active, null);
});
