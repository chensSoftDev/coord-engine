import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { reworkTransition, reworkLifecycle, reworkLifecycleBatch } from '../../lib/coordination/rework.mjs';
import { createGitFixture, runGit } from './fixtures.mjs';

const reason = 'user acceptance identified a reproducible mismatch';
const instructionRef = 'user-message:20261026-feedback';
const clock = () => new Date('2026-10-26T03:00:00.000Z');

function memoryStore(initial) {
  const values = new Map(Object.entries(initial));
  const snapshot = {
    has: (path) => values.has(path),
    readJson: (path) => structuredClone(values.get(path)),
    writeJson: (path, value) => values.set(path, structuredClone(value)),
    delete: (path) => values.delete(path),
  };
  return { snapshot, update: async ({ mutate }) => {
    mutate(snapshot);
    return { sha: 'a'.repeat(40), operationId: 'op-rework' };
  } };
}

test('classified rework preserves UX on correction and returns scope changes to their decision stage', () => {
  for (const from of ['in_dev', 'dev_deployed', 'testing', 'test_passed', 'prod_planning']) {
    assert.equal(reworkTransition({ from, kind: 'correction', reason, instructionRef }).to, 'in_dev');
    assert.equal(reworkTransition({ from, kind: 'ux', reason, instructionRef }).to, 'req_confirmed');
    assert.equal(reworkTransition({ from, kind: 'requirements', reason, instructionRef }).to, 'reviewing');
  }
  assert.equal(reworkTransition({ from: 'tech_design', kind: 'correction', reason, instructionRef }).to, 'tech_design');
});

test('production and terminal facts cannot be reopened or silently rolled back', () => {
  for (const from of ['prod_deployed', 'merged', 'done', 'cancelled']) {
    assert.throws(() => reworkTransition({ from, kind: 'correction', reason, instructionRef }), { code: 'REWORK_TERMINAL_STATE' });
  }
  assert.throws(() => reworkTransition({ from: 'testing', kind: 'other', reason, instructionRef }), { code: 'INVALID_REWORK_KIND' });
  assert.throws(() => reworkTransition({ from: 'testing', kind: 'ux', reason: 'short', instructionRef }), { code: 'INVALID_REWORK_REASON' });
});

test('correction invalidates evidence and merge facts without resetting the review round or UX approval', async (t) => {
  const fixture = createGitFixture(t);
  writeFileSync(join(fixture.clientA, 'BACKLOG.md'), '| ID | 需求描述 | 需迁移 | 当前状态 | Version | 备注 |\n|----|----------|--------|----------|---------|------|\n| I-002 | task | 否 | ✅ Test Passed | v0.9.1 | fixture |\n');
  runGit(fixture.clientA, ['add', 'BACKLOG.md']);
  runGit(fixture.clientA, ['commit', '-m', 'test: rework backlog']);
  const requirement = { id: 'I-002', lifecycle: 'test_passed', deliveryProfile: 'runtime', version: 'v0.9.1', workflowVersion: 2, workflowEpoch: 4, validationEpoch: 3, mergeStatus: 'merged', mergedCommit: 'b'.repeat(40), mergedAt: 'before' };
  const store = memoryStore({
    'requirements/I-002.json': requirement,
    'ux-approvals/I-002.json': { requirementId: 'I-002', revoked: false, fingerprint: 'approved' },
    'release-approvals/I-002.json': { requirementId: 'I-002', revoked: false },
    'environments/I-002/mixed-dev.json': { identitySha256: 'snapshot', invalidated: false },
  });
  const result = await reworkLifecycle({ store, cwd: fixture.clientA, id: 'I-002', kind: 'correction', reason, instructionRef, clock });
  assert.equal(result.lifecycle, 'in_dev');
  const updated = store.snapshot.readJson('requirements/I-002.json');
  assert.equal(updated.workflowEpoch, 4);
  assert.equal(updated.validationEpoch, 4);
  assert.equal(updated.mergeStatus, null);
  assert.equal(updated.mergedCommit, null);
  assert.equal(store.snapshot.readJson('ux-approvals/I-002.json').revoked, false);
  assert.equal(store.snapshot.readJson('release-approvals/I-002.json').revoked, true);
  assert.equal(store.snapshot.readJson('environments/I-002/mixed-dev.json').invalidated, true);
});

test('UX scope rework archives approval validity and starts an explicit new review epoch', async (t) => {
  const fixture = createGitFixture(t);
  writeFileSync(join(fixture.clientA, 'BACKLOG.md'), '| ID | 需求描述 | 需迁移 | 当前状态 | Version | 备注 |\n|----|----------|--------|----------|---------|------|\n| I-002 | task | 否 | 🧪 Testing | v0.9.1 | fixture |\n');
  const store = memoryStore({
    'requirements/I-002.json': { id: 'I-002', lifecycle: 'testing', workflowVersion: 2, workflowEpoch: 1 },
    'ux-approvals/I-002.json': { requirementId: 'I-002', revoked: false, fingerprint: 'previous' },
  });
  await reworkLifecycle({ store, cwd: fixture.clientA, id: 'I-002', kind: 'ux', reason, instructionRef, clock });
  assert.equal(store.snapshot.readJson('requirements/I-002.json').workflowEpoch, 2);
  assert.equal(store.snapshot.readJson('requirements/I-002.json').lifecycle, 'req_confirmed');
  assert.equal(store.snapshot.readJson('ux-approvals/I-002.json').revoked, true);
  assert.equal(store.snapshot.readJson('ux-approvals/I-002.json').fingerprint, 'previous');
});

test('active acceptance freeze must be explicitly rejected before rework mutates any fact', async (t) => {
  const fixture = createGitFixture(t);
  const store = memoryStore({
    'requirements/I-002.json': { id: 'I-002', lifecycle: 'test_passed' },
    'freezes/dev.json': { requirementId: 'I-002', state: 'awaiting_human' },
  });
  await assert.rejects(reworkLifecycle({ store, cwd: fixture.clientA, id: 'I-002', kind: 'correction', reason, instructionRef, clock }), { code: 'REWORK_FROZEN' });
  assert.equal(store.snapshot.readJson('requirements/I-002.json').lifecycle, 'test_passed');
});

test('one feedback batch rejects its exact candidate, routes once and replays without another epoch', async t => {
  const { clientA: cwd } = createGitFixture(t);
  writeFileSync(join(cwd, 'BACKLOG.md'), '| ID | 需求描述 | 需迁移 | 当前状态 | Version | 备注 |\n| I-002 | fixture | 否 | 👤 User Acceptance | v0.9.1 | fixture |\n');
  const requirement = { id: 'I-002', lifecycle: 'user_acceptance', workflowVersion: 2, acceptanceWorkflowVersion: 1,
    workflowEpoch: 2, validationEpoch: 4, version: 'v0.9.1' };
  const store = memoryStore({ 'requirements/I-002.json': requirement,
    'freezes/dev.json': { requirementId: 'I-002', candidateId: 'candidate-1' },
    'ux-approvals/I-002.json': { revoked: false },
  });
  const batch = { schemaVersion: 1, batchId: 'BATCH-001', candidateId: 'candidate-1', reason, instructionRef,
    items: [{ feedbackId: 'FB-001', kind: 'correction' }, { feedbackId: 'FB-002', kind: 'design' }] };
  const result = await reworkLifecycleBatch({ store, cwd, id: 'I-002', batch, clock });
  assert.equal(result.lifecycle, 'tech_design');
  assert.equal(store.snapshot.has('freezes/dev.json'), false);
  assert.equal(store.snapshot.readJson('ux-approvals/I-002.json').revoked, false);
  const before = store.snapshot.readJson('requirements/I-002.json');
  const replay = await reworkLifecycleBatch({ store, cwd, id: 'I-002', batch, clock });
  assert.equal(replay.reused, true);
  assert.deepEqual(store.snapshot.readJson('requirements/I-002.json'), before);
  await assert.rejects(reworkLifecycleBatch({ store, cwd, id: 'I-002', batch: { ...batch, reason: 'A different meaning cannot replace a recorded batch' }, clock }), { code: 'REWORK_BATCH_CONFLICT' });

  // A retry days later must neither re-run its transition nor project its old
  // target over the current state after normal development has continued.
  store.snapshot.writeJson('requirements/I-002.json', { ...before, lifecycle: 'testing' });
  writeFileSync(join(cwd, 'BACKLOG.md'), '| ID | 需求描述 | 需迁移 | 当前状态 | Version | 备注 |\n| I-002 | fixture | 否 | 🧪 Testing | v0.9.1 | fixture |\n');
  const lateReplay = await reworkLifecycleBatch({ store, cwd, id: 'I-002', batch, clock });
  assert.equal(lateReplay.reused, true);
  assert.equal(lateReplay.lifecycle, 'testing');
  assert.match(readFileSync(join(cwd, 'BACKLOG.md'), 'utf8'), /🧪 Testing/);
});

for (const state of ['paused', 'accepted']) test(`a ${state} durable acceptance candidate remains bound to its classified feedback`, async t => {
  const { clientA: cwd } = createGitFixture(t);
  const attemptId = 'attempt-0123456789abcdef';
  const lifecycle = state === 'accepted' ? 'test_passed' : 'user_acceptance';
  writeFileSync(join(cwd, 'BACKLOG.md'), `| ID | 需求描述 | 需迁移 | 当前状态 | Version | 备注 |\n| I-002 | fixture | 否 | ${state === 'accepted' ? '✅ Test Passed' : '👤 User Acceptance'} | v0.9.1 | fixture |\n`);
  const store = memoryStore({
    'requirements/I-002.json': { id: 'I-002', lifecycle, workflowVersion: 2, acceptanceWorkflowVersion: 1 },
    'acceptance/I-002/current.json': { schemaVersion: 1, requirementId: 'I-002', attemptId, state },
    [`acceptance/I-002/${attemptId}.json`]: { requirementId: 'I-002', attemptId, candidateId: 'candidate-durable' },
    ...(state === 'accepted' ? { [`acceptance/I-002/${attemptId}-decision.json`]: { outcome: 'accepted', acceptance: { instructionRef } } } : {}),
  });
  const batch = { schemaVersion: 1, batchId: 'BATCH-DURABLE', candidateId: 'candidate-other', reason, instructionRef,
    items: [{ feedbackId: 'FB-001', kind: 'correction' }] };
  await assert.rejects(reworkLifecycleBatch({ store, cwd, id: 'I-002', batch, clock }), { code: 'REWORK_CANDIDATE_MISMATCH' });
  assert.equal(store.snapshot.readJson('requirements/I-002.json').lifecycle, lifecycle);
  const result = await reworkLifecycleBatch({ store, cwd, id: 'I-002', batch: { ...batch, candidateId: 'candidate-durable' }, clock });
  assert.equal(result.lifecycle, 'in_dev');
  assert.equal(store.snapshot.readJson('acceptance/I-002/current.json').invalidated, true);
});
