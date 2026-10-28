import assert from 'node:assert/strict';
import test from 'node:test';

import { GitCoordinationStore } from '../../lib/coordination/git-store.mjs';
import {
  recordReleaseApproval,
  revokeReleaseApproval,
  showReleaseApproval,
} from '../../lib/coordination/approvals.mjs';
import {
  bindRequirementVersion,
  claimRequirement,
} from '../../lib/coordination/requirements.mjs';
import { initializeSession } from '../../lib/coordination/worktrees.mjs';
import { createGitFixture } from './fixtures.mjs';

// I-113 Task 3 (approval slice): release approval is a durable audit fact
// that only records an explicit user instruction authorizing
// auto_after_machine_verification. The record entry must be disabled in
// CI/scheduled contexts, reject missing instruction references and any scope
// other than `requirement`, and prod guard consumers must fail closed when
// the fact is missing, revoked, or mismatched.

function createStore(cwd, tempRoot, clock) {
  return new GitCoordinationStore({
    cwd,
    remote: 'origin',
    branch: 'coordination',
    tempRoot,
    clock,
  });
}

async function setupApprovalFixture(t, { initialNow = '2026-08-14T00:00:00.000Z' } = {}) {
  const fixture = createGitFixture(t);
  const clock = () => new Date(initialNow);
  const store = createStore(fixture.clientA, fixture.tempRoot, clock);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const claimed = await claimRequirement({
    store,
    type: 'I',
    title: 'Approval requirement',
    profile: 'runtime',
    backlogText: '| I-001 | fixture |\n',
  });
  await bindRequirementVersion({ store, id: claimed.id, version: 'v0.9.1' });
  const session = initializeSession({
    cwd: fixture.clientA, agent: 'kimi', user: 'developer', host: 'host-a', clock,
  });
  return { fixture, store, id: claimed.id, session, clock };
}

test('recordReleaseApproval writes a durable audit fact for an explicit user instruction', async (t) => {
  const context = await setupApprovalFixture(t);

  const recorded = await recordReleaseApproval({
    store: context.store,
    cwd: context.fixture.clientA,
    requirementId: context.id,
    authorizedBy: 'chensheng',
    instructionRef: 'user said: 测试后直接上线',
    session: context.session,
    clock: context.clock,
    env: {},
  });

  assert.equal(recorded.schemaVersion, 1);
  assert.equal(recorded.mode, 'auto_after_machine_verification');
  assert.equal(recorded.requirementId, context.id);
  assert.equal(recorded.authorizedBy, 'chensheng');
  assert.equal(recorded.instructionRef, 'user said: 测试后直接上线');
  assert.equal(recorded.scope, 'requirement');
  assert.equal(recorded.authorizedAt, '2026-08-14T00:00:00.000Z');
  assert.equal(recorded.actor?.sessionId, context.session.sessionId);

  // The fact is durable on the coordination branch.
  const snapshot = await context.store.readSnapshot();
  const fact = snapshot.readJson(`release-approvals/${context.id}.json`);
  assert.equal(fact.mode, 'auto_after_machine_verification');
  assert.equal(fact.authorizedBy, 'chensheng');

  const shown = await showReleaseApproval({ store: context.store, requirementId: context.id });
  assert.equal(shown.requirementId, context.id);
  assert.equal(shown.instructionRef, 'user said: 测试后直接上线');
});

test('release approval record is disabled in CI and scheduled contexts', async (t) => {
  const context = await setupApprovalFixture(t);

  for (const env of [
    { CI: 'true' },
    { GITHUB_ACTIONS: 'true' },
    { CI: '1' },
  ]) {
    await assert.rejects(
      recordReleaseApproval({
        store: context.store,
        cwd: context.fixture.clientA,
        requirementId: context.id,
        authorizedBy: 'chensheng',
        instructionRef: 'user instruction',
        session: context.session,
        clock: context.clock,
        env,
      }),
      (error) => error.code === 'APPROVAL_DISALLOWED_IN_CI' && error.exitCode === 14,
    );
  }

  const snapshot = await context.store.readSnapshot();
  assert.equal(snapshot.has(`release-approvals/${context.id}.json`), false);
});

test('release approval fails closed on missing instruction ref, unknown requirement, or wrong scope', async (t) => {
  const context = await setupApprovalFixture(t);

  // A missing instruction reference is not an auditable user instruction.
  await assert.rejects(
    recordReleaseApproval({
      store: context.store,
      cwd: context.fixture.clientA,
      requirementId: context.id,
      authorizedBy: 'chensheng',
      session: context.session,
      clock: context.clock,
      env: {},
    }),
    (error) => error.code === 'MISSING_APPROVAL_INSTRUCTION' && error.exitCode === 14,
  );

  // An unknown requirement cannot be approved.
  await assert.rejects(
    recordReleaseApproval({
      store: context.store,
      cwd: context.fixture.clientA,
      requirementId: 'I-999',
      authorizedBy: 'chensheng',
      instructionRef: 'user instruction',
      session: context.session,
      clock: context.clock,
      env: {},
    }),
    (error) => error.code === 'REQUIREMENT_NOT_FOUND' && error.exitCode === 14,
  );

  // Scope is strictly `requirement`; anything else fails closed.
  await assert.rejects(
    recordReleaseApproval({
      store: context.store,
      cwd: context.fixture.clientA,
      requirementId: context.id,
      authorizedBy: 'chensheng',
      instructionRef: 'user instruction',
      scope: 'organization',
      session: context.session,
      clock: context.clock,
      env: {},
    }),
    (error) => error.code === 'INVALID_APPROVAL_SCOPE' && error.exitCode === 14,
  );

  // None of the rejected attempts wrote a fact.
  const snapshot = await context.store.readSnapshot();
  assert.equal(snapshot.has(`release-approvals/${context.id}.json`), false);
});

test('revokeReleaseApproval invalidates the fact and show returns null', async (t) => {
  const context = await setupApprovalFixture(t);
  await recordReleaseApproval({
    store: context.store,
    cwd: context.fixture.clientA,
    requirementId: context.id,
    authorizedBy: 'chensheng',
    instructionRef: 'user said: 测试后直接上线',
    session: context.session,
    clock: context.clock,
    env: {},
  });

  const revoked = await revokeReleaseApproval({
    store: context.store,
    cwd: context.fixture.clientA,
    requirementId: context.id,
    reason: 'user changed their mind',
    session: context.session,
    clock: context.clock,
  });
  assert.equal(revoked.requirementId, context.id);
  assert.equal(revoked.revoked, true);
  assert.equal(revoked.reason, 'user changed their mind');

  // The revocation is durable and the fact is no longer an active approval.
  const snapshot = await context.store.readSnapshot();
  const fact = snapshot.readJson(`release-approvals/${context.id}.json`);
  assert.equal(fact.revoked, true);
  assert.equal(fact.revokedAt, '2026-08-14T00:00:00.000Z');
  assert.equal(fact.revokedBy?.sessionId, context.session.sessionId);

  const shown = await showReleaseApproval({ store: context.store, requirementId: context.id });
  assert.equal(shown, null);

  // Revoking an absent approval fails closed.
  await assert.rejects(
    revokeReleaseApproval({
      store: context.store,
      cwd: context.fixture.clientA,
      requirementId: 'I-999',
      reason: 'no approval exists',
      session: context.session,
      clock: context.clock,
    }),
    (error) => error.code === 'APPROVAL_NOT_FOUND' && error.exitCode === 14,
  );
});

test('a malformed or revoked approval fact fails closed when read', async (t) => {
  const context = await setupApprovalFixture(t);

  for (const [name, fact] of [
    ['malformed', { schemaVersion: 1, mode: 'auto_after_machine_verification' }],
    ['wrong-mode', {
      schemaVersion: 1,
      mode: 'manual',
      requirementId: context.id,
      authorizedBy: 'chensheng',
      instructionRef: 'ref',
      scope: 'requirement',
    }],
    ['missing-instruction', {
      schemaVersion: 1,
      mode: 'auto_after_machine_verification',
      requirementId: context.id,
      authorizedBy: 'chensheng',
      scope: 'requirement',
    }],
  ]) {
    await context.store.update({
      operation: `inject ${name} approval`,
      mutate(snapshot) {
        snapshot.writeJson(`release-approvals/${context.id}.json`, fact);
      },
    });
    await assert.rejects(
      showReleaseApproval({ store: context.store, requirementId: context.id }),
      (error) => error.code === 'INVALID_APPROVAL_STATE' && error.exitCode === 14,
    );
  }
});
