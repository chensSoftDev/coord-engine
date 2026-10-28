import assert from 'node:assert/strict';
import test from 'node:test';
import { workflowReviewStage, humanAcceptanceReadiness, evaluateWorkflowReadiness } from '../../lib/coordination/workflow-policy.mjs';

test('each completion boundary consumes its own review and does not require future-stage artifacts', () => {
  assert.equal(workflowReviewStage({ deliveryProfile: 'runtime', uxImpact: 'admin-ui' }, 'req_confirmed'), 'requirements');
  assert.equal(workflowReviewStage({ deliveryProfile: 'runtime', uxImpact: 'admin-ui' }, 'tech_design'), 'ux');
  assert.equal(workflowReviewStage({ deliveryProfile: 'runtime', uxImpact: 'none' }, 'tech_design'), null);
  assert.equal(workflowReviewStage({}, 'in_dev'), 'design');
  assert.equal(workflowReviewStage({ deliveryProfile: 'tooling' }, 'testing'), 'implementation');
  assert.equal(workflowReviewStage({ deliveryProfile: 'runtime' }, 'testing'), null);
  assert.equal(workflowReviewStage({}, 'test_passed'), 'verification');
  assert.equal(workflowReviewStage({}, 'prod_deployed'), 'release');
  assert.equal(workflowReviewStage({}, 'done'), 'closure');
});

function snapshotWith(entries) {
  const values = new Map(Object.entries(entries));
  return { has: (path) => values.has(path), readJson: (path) => values.get(path) };
}
const requirement = { id: 'I-002', version: 'v0.9.1', deliveryProfile: 'runtime', workflowVersion: 2, validationEpoch: 2 };
const commit = 'a'.repeat(40);

test('test success is not a human acceptance and stale accepted epochs cannot release a candidate', () => {
  assert.equal(humanAcceptanceReadiness({ snapshot: snapshotWith({}), requirement, currentCommit: commit }).ok, false);
  const freeze = { requirementId: 'I-002', version: 'v0.9.1', commit, validationEpoch: 2,
    acceptance: { instructionRef: 'user-message:20261026-accepted', authorizedBy: 'owner', acceptedAt: '2026-10-26T03:00:00Z' } };
  assert.equal(humanAcceptanceReadiness({ snapshot: snapshotWith({ 'freezes/dev.json': freeze }), requirement, currentCommit: commit }).ok, true);
  assert.equal(humanAcceptanceReadiness({ snapshot: snapshotWith({ 'freezes/dev.json': { ...freeze, validationEpoch: 1 } }), requirement, currentCommit: commit }).ok, false);
});

test('mixed acceptance binds exactly the environment that was frozen', () => {
  const freeze = { requirementId: 'I-002', version: 'v0.9.1', commit, validationEpoch: 2, mixedEnvironmentIdentity: 'first',
    acceptance: { instructionRef: 'user-message:20261026-accepted', authorizedBy: 'owner', acceptedAt: '2026-10-26T03:00:00Z' } };
  const snapshot = snapshotWith({ 'freezes/dev.json': freeze, 'environments/I-002/mixed-dev.json': { identitySha256: 'second' } });
  assert.equal(humanAcceptanceReadiness({ snapshot, requirement, currentCommit: commit }).ok, false);
});

test('mixed candidate requires explicit human acceptance even if generic auto release is authorized', () => {
  const approval = { schemaVersion: 1, mode: 'auto_after_machine_verification', requirementId: 'I-002',
    authorizedBy: 'owner', authorizedAt: '2026-10-26T03:00:00Z', instructionRef: 'user-message:auto-release',
    scope: 'requirement', actor: { sessionId: 'session-one' }, validationEpoch: 2 };
  assert.equal(humanAcceptanceReadiness({ snapshot: snapshotWith({ 'release-approvals/I-002.json': approval }), requirement, currentCommit: commit }).ok, true);
  assert.equal(humanAcceptanceReadiness({ snapshot: snapshotWith({ 'release-approvals/I-002.json': approval,
    'environments/I-002/mixed-dev.json': { mode: 'mixed-dev', identitySha256: 'candidate' } }), requirement, currentCommit: commit }).ok, false);
});

test('legacy requirements remain exempt without fabricated records', () => {
  assert.deepEqual(evaluateWorkflowReadiness({ snapshot: snapshotWith({}), requirement: { id: 'I-002' }, to: 'in_dev' }), { ok: true, missing: [], exempt: 'legacy' });
});
