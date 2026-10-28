import assert from 'node:assert/strict';
import test from 'node:test';
import { enableWorkflow } from '../../lib/coordination/workflow-facts.mjs';

test('workflow enrollment is explicit, idempotent and never fabricates historical reviews', async () => {
  let fact = { id: 'I-002', lifecycle: 'in_dev', version: 'v0.9.1', lifecycleHistory: [{ type: 'start', to: 'in_dev' }] };
  const snapshot = { has: () => true, readJson: () => structuredClone(fact), writeJson: (_path, value) => { fact = value; } };
  const store = { update: async ({ mutate }) => { mutate(snapshot); return { sha: 'a'.repeat(40) }; } };
  await enableWorkflow({ store, id: 'I-002', reason: 'adopt the user-approved closed-loop workflow', actor: 'owner' });
  assert.equal(fact.workflowVersion, 2);
  assert.equal(fact.workflowEpoch, 0);
  assert.equal(fact.lifecycle, 'in_dev');
  assert.equal(fact.lifecycleHistory.length, 1);
  assert.equal(fact.workflowHistory.length, 1);
  await enableWorkflow({ store, id: 'I-002', reason: 'repeat the same explicit workflow enrollment', actor: 'owner' });
  assert.equal(fact.workflowHistory.length, 1);
});

test('terminal workflow facts cannot be retroactively enrolled', async () => {
  const snapshot = { has: () => true, readJson: () => ({ id: 'I-002', lifecycle: 'done' }) };
  const store = { update: async ({ mutate }) => mutate(snapshot) };
  await assert.rejects(enableWorkflow({ store, id: 'I-002', reason: 'retroactively adopt the closed-loop workflow' }), { code: 'WORKFLOW_ENROLLMENT_TERMINAL' });
});
