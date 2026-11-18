import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { CoordinationSnapshot } from '../../lib/coordination/git-store.mjs';
import { acquireLease } from '../../lib/coordination/leases.mjs';
import { resumeFreeze, unfreezeFact } from '../../lib/coordination/freezes.mjs';
import { initializeSession } from '../../lib/coordination/worktrees.mjs';
import * as policy from '../../lib/coordination/workflow-policy.mjs';
import { createGitFixture, runGit } from './fixtures.mjs';

function setup(t) {
  const { clientA: cwd } = createGitFixture(t);
  const clock = () => new Date('2026-11-04T00:00:00Z');
  const requirement = { id: 'I-002', version: 'v0.9.1', branch: 'main', lifecycle: 'user_acceptance',
    workflowVersion: 2, acceptanceWorkflowVersion: 1, validationEpoch: 0, deliveryProfile: 'runtime',
    uxImpact: 'admin-ui', resources: { services: ['admin'] } };
  const deployment = { schemaVersion: 2, stage: 'dev', requirementId: requirement.id, version: requirement.version,
    commit: runGit(cwd, ['rev-parse', 'HEAD']), services: ['admin'], manifest: { sha256: 'b'.repeat(64) },
    sourceSnapshot: { sha256: 'c'.repeat(64) }, artifacts: { admin: { imageId: `sha256:${'d'.repeat(64)}`, imageTag: 'v0.9.1' } } };
  const evidence = { outcome: 'passed', requirement: { id: requirement.id, version: requirement.version, validationEpoch: 0 },
    environment: { kind: 'shared-dev', devSnapshot: deployment, targets: { adminBaseUrl: 'https://admin-dev.hongli-ruian.com' } } };
  const root = join(cwd, 'docs/product/current/I-002-resume');
  mkdirSync(root, { recursive: true });
  const bytes = JSON.stringify(evidence);
  writeFileSync(join(root, 'TEST_EVIDENCE.json'), bytes);
  runGit(cwd, ['add', '.']); runGit(cwd, ['commit', '-m', 'test: preserve verified shared candidate']);
  const candidate = { schemaVersion: 1, resource: 'dev', state: 'awaiting_human', requirementId: requirement.id,
    version: requirement.version, validationEpoch: 0, branch: 'main', commit: runGit(cwd, ['rev-parse', 'HEAD']),
    candidateId: 'candidate-resume', attemptId: 'attempt-0123456789abcdef', deploymentSnapshot: deployment,
    machineVerificationEvidence: createHash('sha256').update(bytes).digest('hex'), frozenAt: clock().toISOString(), actor: { sessionId: 'original' } };
  const snapshot = new CoordinationSnapshot({ sha: 'fixture', files: new Map([
    ['requirements/I-002.json', JSON.stringify(requirement)], ['deployments/dev.json', JSON.stringify(deployment)],
    ['freezes/dev.json', JSON.stringify(candidate)], [`acceptance/I-002/${candidate.attemptId}.json`, JSON.stringify(candidate)],
    ['acceptance/I-002/current.json', JSON.stringify({ schemaVersion: 1, requirementId: requirement.id, attemptId: candidate.attemptId, state: 'active' })],
  ]) });
  const store = { readSnapshot: async () => snapshot, update: async ({ mutate }) => { await mutate(snapshot); return { sha: 'updated', operationId: 'fixture' }; } };
  const session = initializeSession({ cwd, agent: 'test', user: 'owner', host: 'fixture', clock });
  const args = { cwd, store, requirementId: requirement.id, session, clock, baseUrl: 'https://admin-dev.hongli-ruian.com' };
  const pause = () => unfreezeFact({ ...args, outcome: 'paused', reason: 'Pause the unchanged candidate while the owner is away' });
  const acquire = () => acquireLease({ ...args, resource: 'dev', ttl: '8h' });
  return { cwd, requirement, deployment, candidate, snapshot, store, args, pause, acquire };
}

test('shared-dev resumes the same paused candidate only after lease and frontend health validation', async t => {
  const s = setup(t); await s.pause();
  await assert.rejects(resumeFreeze(s.args), { code: 'NOT_LEASE_HOLDER' });
  await s.acquire();
  const requests = [];
  const result = await resumeFreeze({ ...s.args, fetcher: async (url, options) => {
    requests.push(url); assert.equal(options.redirect, 'error'); return { ok: true, json: async () => ({ status: 'ok' }) };
  } });
  assert.deepEqual(requests, ['https://admin-dev.hongli-ruian.com/api/health']);
  assert.equal(result.attemptId, s.candidate.attemptId);
  assert.equal(result.machineVerificationEvidence, s.candidate.machineVerificationEvidence);
  assert.equal(s.snapshot.readJson('acceptance/I-002/current.json').state, 'active');
  assert.equal(s.snapshot.readJson('locks/dev.json').active, null);
});

test('shared-dev resume rejects changed deployment identity before probing and preserves the paused candidate', async t => {
  const s = setup(t); await s.pause(); await s.acquire();
  s.snapshot.writeJson('deployments/dev.json', { ...s.deployment, recordedAt: 'replacement' });
  let probed = false;
  await assert.rejects(resumeFreeze({ ...s.args, fetcher: async () => { probed = true; } }), { code: 'ACCEPTANCE_DEPLOYMENT_CHANGED' });
  assert.equal(probed, false); assert.equal(s.snapshot.has('freezes/dev.json'), false);
  assert.equal(s.snapshot.readJson('acceptance/I-002/current.json').state, 'paused');
});

test('shared-dev resume requires live health and rejects a deployment changed during the probe', async t => {
  const s = setup(t); await s.pause(); await s.acquire();
  await assert.rejects(resumeFreeze({ ...s.args, fetcher: async () => ({ ok: false }) }), { code: 'ACCEPTANCE_FRONTEND_UNHEALTHY' });
  await assert.rejects(resumeFreeze({ ...s.args, fetcher: async () => {
    s.snapshot.writeJson('deployments/dev.json', { ...s.deployment, recordedAt: 'concurrent replacement' });
    return { ok: true, json: async () => ({ status: 'ok' }) };
  } }), { code: 'FREEZE_EVIDENCE_MISMATCH' });
  assert.equal(s.snapshot.has('freezes/dev.json'), false);
  assert.ok(s.snapshot.readJson('locks/dev.json').active);
});

test('shared-dev resume refuses a different frontend origin and dirty candidate sources', async t => {
  const s = setup(t); await s.pause(); await s.acquire();
  const fetcher = async () => { throw new Error('unexpected network request'); };
  await assert.rejects(resumeFreeze({ ...s.args, baseUrl: 'https://web-dev.hongli-ruian.com', fetcher }), { code: 'ACCEPTANCE_FRONTEND_IDENTITY_CHANGED' });
  writeFileSync(join(s.cwd, 'README.md'), '# changed source\n');
  await assert.rejects(resumeFreeze({ ...s.args, fetcher }), { code: 'FREEZE_DIRTY_SOURCES' });
});

test('released pending candidates require a classified feedback batch instead of resume', async t => {
  const s = setup(t);
  await unfreezeFact({ ...s.args, outcome: 'released', reason: 'The owner abandoned this candidate before acceptance' });
  assert.equal(s.snapshot.readJson('acceptance/I-002/current.json').state, 'released');
  await assert.rejects(resumeFreeze(s.args), { code: 'ACCEPTANCE_RESUME_INVALID' });
  const recovery = policy.acceptanceRecovery({ snapshot: s.snapshot, requirement: s.requirement });
  assert.equal(recovery.state, 'released'); assert.match(recovery.command, /lifecycle rework-batch I-002/);
});

test('acceptance recovery distinguishes active, paused, accepted and reworked candidates', async t => {
  const s = setup(t);
  let recovery = policy.acceptanceRecovery({ snapshot: s.snapshot, requirement: s.requirement });
  assert.equal(recovery.state, 'active'); assert.match(recovery.command, /freeze unfreeze dev --requirement I-002 --outcome accepted/);
  assert.equal(recovery.requiresHumanDecision, true);
  await s.pause();
  recovery = policy.acceptanceRecovery({ snapshot: s.snapshot, requirement: s.requirement });
  assert.equal(recovery.state, 'paused'); assert.match(recovery.command, /freeze resume dev --requirement I-002/);
  assert.match(recovery.preparationCommands[0], /lock acquire dev --requirement I-002/);
  s.snapshot.writeJson(`acceptance/I-002/${s.candidate.attemptId}-decision.json`, { outcome: 'accepted', acceptance: { authorizedBy: 'owner' } });
  s.snapshot.writeJson('acceptance/I-002/current.json', { schemaVersion: 1, requirementId: 'I-002', attemptId: s.candidate.attemptId, state: 'accepted' });
  recovery = policy.acceptanceRecovery({ snapshot: s.snapshot, requirement: { ...s.requirement, lifecycle: 'test_passed' } });
  assert.equal(recovery.state, 'accepted'); assert.doesNotMatch(recovery.command, /lock acquire|freeze resume|unfreeze/);
  s.snapshot.writeJson('acceptance/I-002/current.json', { ...s.snapshot.readJson('acceptance/I-002/current.json'), invalidated: true });
  recovery = policy.acceptanceRecovery({ snapshot: s.snapshot, requirement: { ...s.requirement, lifecycle: 'in_dev' } });
  assert.equal(recovery.state, 'reworked'); assert.doesNotMatch(recovery.command, /freeze resume|unfreeze/);
});
