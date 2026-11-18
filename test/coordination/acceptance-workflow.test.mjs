import assert from 'node:assert/strict';
import test from 'node:test';
import * as lifecycle from '../../lib/coordination/lifecycle.mjs';
import * as rework from '../../lib/coordination/rework.mjs';
import { invalidateWorkflowFacts } from '../../lib/coordination/workflow-facts.mjs';
import * as facts from '../../lib/coordination/workflow-facts.mjs';
import { workflowReviewStage } from '../../lib/coordination/workflow-policy.mjs';

const ui = { id: 'I-002', lifecycle: 'testing', deliveryProfile: 'runtime', workflowVersion: 2,
  acceptanceWorkflowVersion: 1, uxImpact: 'admin-ui', version: 'v1.0.0', workflowEpoch: 2, validationEpoch: 3 };
const reason = 'User feedback identifies a technical contract correction';
const instructionRef = 'user-message:feedback-batch';

test('only enrolled UI runtime uses the explicit human acceptance state', () => {
  assert.equal(lifecycle.successorState({ profile: 'runtime', from: 'testing', requirement: ui }), 'user_acceptance');
  assert.equal(lifecycle.successorState({ profile: 'runtime', from: 'user_acceptance', requirement: ui }), 'test_passed');
  for (const requirement of [{ ...ui, acceptanceWorkflowVersion: undefined }, { ...ui, uxImpact: 'none', services: ['api'] }, { ...ui, deliveryProfile: 'tooling' }]) {
    assert.equal(lifecycle.successorState({ profile: requirement.deliveryProfile, from: 'testing', requirement }), 'test_passed');
  }
  assert.throws(() => lifecycle.transition({ profile: 'runtime', from: 'testing', to: 'test_passed', requirement: ui }), { code: 'INVALID_TRANSITION' });
});

test('machine verification is a gate before User Acceptance; no extra review stage is invented', () => {
  assert.equal(workflowReviewStage(ui, 'user_acceptance'), 'verification');
  assert.equal(workflowReviewStage(ui, 'test_passed'), 'verification');
  const result = lifecycle.transition({ profile: 'runtime', from: 'testing', to: 'user_acceptance', requirement: ui,
    context: { migrationResolved: true, hasVersion: true, version: ui.version } });
  assert.equal(result.allowed, false);
  assert.ok(result.requiredActions.includes('run_required_tests'));
});

test('a feedback batch chooses the earliest affected stage once and preserves its individual classifications', () => {
  assert.equal(typeof rework.planReworkBatch, 'function');
  const batch = { schemaVersion: 1, batchId: 'FBATCH-001', candidateId: 'candidate-1', instructionRef, reason,
    items: [{ feedbackId: 'FB-1', kind: 'correction' }, { feedbackId: 'FB-2', kind: 'design' }] };
  const plan = rework.planReworkBatch({ requirement: { ...ui, lifecycle: 'user_acceptance' }, batch });
  assert.equal(plan.to, 'tech_design');
  assert.equal(plan.kind, 'design');
  assert.deepEqual(plan.items, batch.items);
  assert.equal(rework.planReworkBatch({ requirement: ui, batch: { ...batch, items: [...batch.items, { feedbackId: 'FB-3', kind: 'ux' }] } }).to, 'req_confirmed');
  assert.equal(rework.planReworkBatch({ requirement: ui, batch: { ...batch, items: [{ feedbackId: 'FB-3', kind: 'requirements' }] } }).to, 'reviewing');
  assert.throws(() => rework.planReworkBatch({ requirement: ui, batch: { ...batch, items: [batch.items[0], batch.items[0]] } }), { code: 'INVALID_REWORK_BATCH' });
});

test('technical design rework retains the approved UX and upstream review epochs', () => {
  const values = new Map([['ux-approvals/I-002.json', { revoked: false }], ['environments/I-002/mixed-dev.json', { invalidated: false }]]);
  const snapshot = { has: p => values.has(p), readJson: p => structuredClone(values.get(p)), writeJson: (p, v) => values.set(p, v) };
  const result = invalidateWorkflowFacts(snapshot, ui.id, ui, { kind: 'design', reason, instructionRef, at: '2026-11-04T00:00:00Z' });
  assert.equal(values.get('ux-approvals/I-002.json').revoked, false);
  assert.equal(result.reviewEpochs.requirements, 2);
  assert.equal(result.reviewEpochs.ux, 2);
  assert.equal(result.reviewEpochs.design, 3);
  assert.equal(result.reviewEpochs.implementation, 3);
  assert.equal(result.validationEpoch, 4);
});

test('explicit enrollment only changes prospective policy and refuses already accepted historical work', async () => {
  assert.equal(typeof facts.enableAcceptanceWorkflow, 'function');
  let requirement = { ...ui, acceptanceWorkflowVersion: undefined };
  const snapshot = { has: p => p === 'requirements/I-002.json', readJson: () => requirement, writeJson: (_p, v) => { requirement = v; } };
  const store = { update: async ({ mutate }) => { mutate(snapshot); return { sha: 'fixture' }; } };
  await facts.enableAcceptanceWorkflow({ store, id: ui.id, reason, actor: 'owner' });
  assert.equal(requirement.acceptanceWorkflowVersion, 1);
  assert.equal(requirement.lifecycle, 'testing');
  requirement = { ...ui, acceptanceWorkflowVersion: undefined, lifecycle: 'test_passed' };
  await assert.rejects(facts.enableAcceptanceWorkflow({ store, id: ui.id, reason }), { code: 'ACCEPTANCE_ENROLLMENT_TOO_LATE' });
});
