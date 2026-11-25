import assert from 'node:assert/strict';
import test from 'node:test';
import { enableWorkflow, enableAcceptanceWorkflow } from '../../lib/coordination/workflow-facts.mjs';
import { claimRequirement, startRequirement } from '../../lib/coordination/requirements.mjs';
import { CoordinationSnapshot } from '../../lib/coordination/git-store.mjs';

test('new claims and starts activate full scenario handoff without enrolling old requirements', async () => {
  const snapshot = new CoordinationSnapshot({ sha: 'fixture', files: new Map() });
  const store = { clock: () => new Date('2026-11-06T08:00:00Z'), update: async ({ mutate }) => { await mutate(snapshot); return {}; } };
  const args = { store, type: 'I', title: '仓库业务验收', profile: 'runtime', uxImpact: 'admin-ui', workflowVersion: 2, backlogText: '' };
  const claimed = await claimRequirement(args);
  assert.equal(snapshot.readJson(`requirements/${claimed.id}.json`).scenarioAcceptanceVersion, 1);
  const started = await startRequirement({ ...args, title: '采购业务验收', topic: 'procurement-acceptance', migration: 'no', version: 'v0.9.1' });
  assert.equal(snapshot.readJson(`requirements/${started.id}.json`).scenarioAcceptanceVersion, 1);
  assert.equal(snapshot.readJson(`requirements/${claimed.id}.json`).uxItemAcceptanceVersion, 1);
  assert.equal(snapshot.readJson(`requirements/${started.id}.json`).uxItemAcceptanceVersion, 1);
  const tooling = await claimRequirement({ ...args, profile: 'tooling', uxImpact: 'none', title: '协调工具验收' });
  assert.equal(snapshot.readJson(`requirements/${tooling.id}.json`).uxItemAcceptanceVersion, undefined);
  const legacy = await claimRequirement({ ...args, workflowVersion: undefined, title: '既有协议兼容' });
  assert.equal(snapshot.readJson(`requirements/${legacy.id}.json`).scenarioAcceptanceVersion, undefined);
});

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

test('I-268: explicit acceptance upgrade enrolls scenario self-check once and never rewrites a frozen candidate', async () => {
  let fact = { id: 'I-002', lifecycle: 'in_dev', workflowVersion: 2, acceptanceWorkflowVersion: 1 };
  const snapshot = { has: p => p === 'requirements/I-002.json', readJson: () => structuredClone(fact), writeJson: (_p, value) => { fact = value; } };
  const store = { update: async ({ mutate }) => { mutate(snapshot); return {}; } };
  const args = { store, id: 'I-002', reason: 'adopt complete scenario checks before user handoff' };
  await enableAcceptanceWorkflow(args);
  assert.equal(fact.scenarioAcceptanceVersion, 1);
  await enableAcceptanceWorkflow(args);
  assert.equal(fact.workflowHistory.length, 1);
  fact = { ...fact, scenarioAcceptanceVersion: undefined, lifecycle: 'user_acceptance' };
  await assert.rejects(enableAcceptanceWorkflow(args), { code: 'ACCEPTANCE_ENROLLMENT_TOO_LATE' });
});
