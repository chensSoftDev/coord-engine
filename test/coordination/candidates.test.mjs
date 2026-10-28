import assert from 'node:assert/strict';
import test from 'node:test';

import { GitCoordinationStore } from '../../lib/coordination/git-store.mjs';
import {
  assertCandidateRef,
  assertCandidateMergeEquivalent,
  candidateId,
  voidCandidate,
  showCandidate,
  recordCandidate,
} from '../../lib/coordination/candidates.mjs';
import {
  bindRequirementVersion,
  claimRequirement,
} from '../../lib/coordination/requirements.mjs';
import { createGitFixture, runGit } from './fixtures.mjs';

// I-113 Task 4 (candidate slice): candidates identify an immutable source
// commit bound to a coordination requirement. The candidate ref must be a
// full commit reachable from the requirement's bound feature branch; fix
// iterations never create SemVer tags. Candidate facts are stored on the
// coordination branch and can be voided without deleting history.

function createStore(cwd, tempRoot, clock) {
  return new GitCoordinationStore({
    cwd,
    remote: 'origin',
    branch: 'coordination',
    tempRoot,
    clock,
  });
}

async function setupCandidateFixture(t, { initialNow = '2026-08-14T00:00:00.000Z' } = {}) {
  const fixture = createGitFixture(t);
  const clock = () => new Date(initialNow);
  const store = createStore(fixture.clientA, fixture.tempRoot, clock);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const claimed = await claimRequirement({
    store,
    type: 'I',
    title: 'Candidate requirement',
    profile: 'runtime',
    backlogText: '| I-001 | fixture |\n',
  });
  await bindRequirementVersion({ store, id: claimed.id, version: 'v0.9.1' });
  const branch = 'feature/v0.9.1/candidate-requirement';
  await store.update({
    operation: `bind branch for ${claimed.id}`,
    mutate(snapshot) {
      const path = `requirements/${claimed.id}.json`;
      snapshot.writeJson(path, { ...snapshot.readJson(path), branch });
    },
  });
  runGit(fixture.clientA, ['switch', '-c', branch]);
  runGit(fixture.clientA, ['push', '--set-upstream', 'origin', `HEAD:refs/heads/${branch}`]);
  return { fixture, store, id: claimed.id, branch, clock };
}

function fullCommit(cwd) {
  return runGit(cwd, ['rev-parse', 'HEAD']);
}

test('candidateId is deterministic and embeds requirement, commit, and fingerprint', () => {
  const id = candidateId({
    requirementId: 'I-001',
    sourceCommit: 'a'.repeat(40),
    fingerprint: 'b'.repeat(64),
  });
  assert.equal(id, 'candidate-I-001-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
});

test('assertCandidateRef accepts a full commit reachable from the bound branch', async (t) => {
  const context = await setupCandidateFixture(t);
  const commit = fullCommit(context.fixture.clientA);
  const result = await assertCandidateRef({
    store: context.store,
    cwd: context.fixture.clientA,
    requirementId: context.id,
    ref: commit,
  });
  assert.equal(result.commit, commit);
  assert.equal(result.branch, context.branch);
});

test('assertCandidateRef rejects short refs, foreign commits, and unreachable commits', async (t) => {
  const context = await setupCandidateFixture(t);
  const commit = fullCommit(context.fixture.clientA);

  // Short refs are not immutable candidate identities.
  await assert.rejects(
    assertCandidateRef({
      store: context.store,
      cwd: context.fixture.clientA,
      requirementId: context.id,
      ref: commit.slice(0, 7),
    }),
    (error) => error.code === 'INVALID_CANDIDATE_REF' && error.exitCode === 14,
  );

  // A commit on a different branch is not reachable from the bound branch.
  runGit(context.fixture.clientA, ['switch', '-c', 'feature/v0.9.1/unrelated-branch']);
  runGit(context.fixture.clientA, ['commit', '--allow-empty', '-m', 'unrelated commit']);
  const foreign = fullCommit(context.fixture.clientA);
  await assert.rejects(
    assertCandidateRef({
      store: context.store,
      cwd: context.fixture.clientA,
      requirementId: context.id,
      ref: foreign,
    }),
    (error) => error.code === 'CANDIDATE_REF_UNREACHABLE' && error.exitCode === 14,
  );

  // An unknown requirement has no bound branch.
  await assert.rejects(
    assertCandidateRef({
      store: context.store,
      cwd: context.fixture.clientA,
      requirementId: 'I-999',
      ref: commit,
    }),
    (error) => error.code === 'REQUIREMENT_NOT_FOUND' && error.exitCode === 14,
  );
});

test('recordCandidate persists immutable candidate facts with inputs and test set', async (t) => {
  const context = await setupCandidateFixture(t);
  const commit = fullCommit(context.fixture.clientA);
  const fingerprint = 'c'.repeat(64);

  const recorded = await recordCandidate({
    store: context.store,
    cwd: context.fixture.clientA,
    requirementId: context.id,
    sourceCommit: commit,
    services: ['api', 'web'],
    runtimeInputs: { api: fingerprint, web: fingerprint },
    buildArgs: { api: { registry: 'mirror' } },
    requiredTestSet: [['pnpm', 'test:coordination']],
    session: null,
    clock: context.clock,
  });

  assert.equal(recorded.schemaVersion, 1);
  assert.equal(recorded.requirementId, context.id);
  assert.equal(recorded.sourceCommit, commit);
  assert.equal(recorded.branch, context.branch);
  assert.match(recorded.candidateId, /^candidate-I-\d+-[a-f0-9]{40}-[a-f0-9]{64}$/);
  assert.deepEqual(recorded.services.sort(), ['api', 'web']);
  assert.equal(recorded.runtimeInputs.api, fingerprint);
  assert.deepEqual(recorded.requiredTestSet, [['pnpm', 'test:coordination']]);
  assert.equal(recorded.status, 'active');
  assert.equal(recorded.voidedAt, undefined);

  // The fact is durable on the coordination branch under candidates/<id>/.
  const snapshot = await context.store.readSnapshot();
  const path = `candidates/${context.id}/${recorded.candidateId}.json`;
  assert.equal(snapshot.has(path), true);
  assert.equal(snapshot.readJson(path).sourceCommit, commit);

  const shown = await showCandidate({
    store: context.store,
    requirementId: context.id,
    candidateId: recorded.candidateId,
  });
  assert.equal(shown.candidateId, recorded.candidateId);
  assert.equal(shown.status, 'active');
});

test('recordCandidate rejects an immutable source commit that is not the current branch head or its descendant', async (t) => {
  const context = await setupCandidateFixture(t);
  const commit = fullCommit(context.fixture.clientA);
  runGit(context.fixture.clientA, ['commit', '--allow-empty', '-m', 'fix iteration']);

  // A stale commit that is an ancestor of HEAD is still a valid candidate
  // source (fix iterations build older candidates), but a commit outside the
  // branch's history is not.
  runGit(context.fixture.clientA, ['switch', '-c', 'feature/v0.9.1/other-branch']);
  runGit(context.fixture.clientA, ['commit', '--allow-empty', '-m', 'foreign']);
  const foreign = fullCommit(context.fixture.clientA);
  await assert.rejects(
    recordCandidate({
      store: context.store,
      cwd: context.fixture.clientA,
      requirementId: context.id,
      sourceCommit: foreign,
      services: ['api'],
      runtimeInputs: {},
      buildArgs: {},
      requiredTestSet: [],
      session: null,
      clock: context.clock,
    }),
    (error) => error.code === 'CANDIDATE_REF_UNREACHABLE' && error.exitCode === 14,
  );
  assert.equal(commit.length, 40);
});

test('voidCandidate marks the candidate void and keeps the fact for audit', async (t) => {
  const context = await setupCandidateFixture(t);
  const commit = fullCommit(context.fixture.clientA);
  const recorded = await recordCandidate({
    store: context.store,
    cwd: context.fixture.clientA,
    requirementId: context.id,
    sourceCommit: commit,
    services: ['api'],
    runtimeInputs: {},
    buildArgs: {},
    requiredTestSet: [],
    session: null,
    clock: context.clock,
  });

  const voided = await voidCandidate({
    store: context.store,
    cwd: context.fixture.clientA,
    requirementId: context.id,
    candidateId: recorded.candidateId,
    reason: 'runtime inputs changed after verification',
    session: null,
    clock: context.clock,
  });
  assert.equal(voided.status, 'voided');
  assert.equal(voided.voidReason, 'runtime inputs changed after verification');
  assert.equal(voided.voidedAt, '2026-08-14T00:00:00.000Z');

  const snapshot = await context.store.readSnapshot();
  const fact = snapshot.readJson(`candidates/${context.id}/${recorded.candidateId}.json`);
  assert.equal(fact.status, 'voided');
  assert.equal(fact.voidReason, 'runtime inputs changed after verification');

  // Voiding an unknown candidate fails closed.
  await assert.rejects(
    voidCandidate({
      store: context.store,
      cwd: context.fixture.clientA,
      requirementId: context.id,
      candidateId: `candidate-${context.id}-${'d'.repeat(40)}-${'e'.repeat(64)}`,
      reason: 'test',
      session: null,
      clock: context.clock,
    }),
    (error) => error.code === 'CANDIDATE_NOT_FOUND' && error.exitCode === 14,
  );
});

// I-113 Task 4 (merge equivalence slice): after a feature merges into main,
// the release tooling recomputes the per-service runtime input fingerprint of
// the releaseCommit and compares it with the accepted candidate. Only an
// identical fingerprint may associate the prebuilt digest with the release
// commit; any runtime input change invalidates the candidate (ACCEPTANCE E).
test('assertCandidateMergeEquivalent accepts an unchanged merge and rejects changed runtime inputs', async (t) => {
  const context = await setupCandidateFixture(t);
  const commit = fullCommit(context.fixture.clientA);
  const fingerprint = 'c'.repeat(64);

  const recorded = await recordCandidate({
    store: context.store,
    cwd: context.fixture.clientA,
    requirementId: context.id,
    sourceCommit: commit,
    services: ['api'],
    runtimeInputs: { api: fingerprint },
    buildArgs: {},
    requiredTestSet: [],
    session: null,
    clock: context.clock,
  });

  // A release commit whose runtime inputs are unchanged stays equivalent.
  const equivalent = await assertCandidateMergeEquivalent({
    store: context.store,
    cwd: context.fixture.clientA,
    requirementId: context.id,
    candidateId: recorded.candidateId,
    releaseCommit: commit,
    runtimeInputs: { api: fingerprint },
  });
  assert.equal(equivalent.requirementId, context.id);
  assert.equal(equivalent.candidateId, recorded.candidateId);
  assert.equal(equivalent.equivalent, true);
  assert.equal(equivalent.releaseCommit, commit);

  // A runtime input change (e.g. a merge that touched apps/api) fails closed.
  await assert.rejects(
    assertCandidateMergeEquivalent({
      store: context.store,
      cwd: context.fixture.clientA,
      requirementId: context.id,
      candidateId: recorded.candidateId,
      releaseCommit: commit,
      runtimeInputs: { api: 'd'.repeat(64) },
    }),
    (error) => error.code === 'CANDIDATE_RUNTIME_INPUT_MISMATCH' && error.exitCode === 11,
  );

  // A voided candidate can never be promoted even with matching inputs.
  await voidCandidate({
    store: context.store,
    cwd: context.fixture.clientA,
    requirementId: context.id,
    candidateId: recorded.candidateId,
    reason: 'superseded',
    session: null,
    clock: context.clock,
  });
  await assert.rejects(
    assertCandidateMergeEquivalent({
      store: context.store,
      cwd: context.fixture.clientA,
      requirementId: context.id,
      candidateId: recorded.candidateId,
      releaseCommit: commit,
      runtimeInputs: { api: fingerprint },
    }),
    (error) => error.code === 'CANDIDATE_VOIDED' && error.exitCode === 14,
  );

  // An unknown candidate fails closed.
  await assert.rejects(
    assertCandidateMergeEquivalent({
      store: context.store,
      cwd: context.fixture.clientA,
      requirementId: context.id,
      candidateId: `candidate-${context.id}-${'d'.repeat(40)}-${'e'.repeat(64)}`,
      releaseCommit: commit,
      runtimeInputs: { api: fingerprint },
    }),
    (error) => error.code === 'CANDIDATE_NOT_FOUND' && error.exitCode === 14,
  );
});
