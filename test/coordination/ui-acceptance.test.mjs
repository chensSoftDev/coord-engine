import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGitFixture, runGit } from './fixtures.mjs';
import { uiAcceptanceRequired, validateUiAcceptanceReport } from '../../lib/coordination/ui-acceptance.mjs';
import { humanAcceptanceReadiness } from '../../lib/coordination/workflow-policy.mjs';
import { CoordinationSnapshot } from '../../lib/coordination/git-store.mjs';
import { initializeSession } from '../../lib/coordination/worktrees.mjs';
import { unfreezeFact } from '../../lib/coordination/freezes.mjs';
import * as acceptance from '../../lib/coordination/ui-acceptance.mjs';
import { prepareReview, recordReview } from '../../lib/coordination/reviews.mjs';

const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');
// B-248: the validator rejects identical baseline/actual content, so the
// fixture needs two distinct (still valid-signature) images.
const distinctImage = Buffer.concat([image, Buffer.from([0x00, 0x01])]);
function setup(t) {
  const { clientA: cwd } = createGitFixture(t);
  const root = 'docs/product/current/I-002-ui-acceptance';
  const imageRoot = `${root}/reviews/screenshots`;
  mkdirSync(join(cwd, imageRoot), { recursive: true });
  writeFileSync(join(cwd, root, 'UX_SPEC.md'), '# Approved UX\n');
  writeFileSync(join(cwd, imageRoot, 'prototype.png'), image);
  writeFileSync(join(cwd, imageRoot, 'actual.png'), distinctImage);
  const freeze = { candidateId: 'candidate-1', machineVerificationEvidence: 'a'.repeat(64), mixedEnvironmentIdentity: 'b'.repeat(64) };
  const requirement = { id: 'I-002', version: 'v0.9.1', validationEpoch: 0, workflowVersion: 2, deliveryProfile: 'runtime', uxImpact: 'admin-ui', resources: { services: ['admin'] } };
  const report = { schemaVersion: 1, requirementId: requirement.id, candidateId: freeze.candidateId,
    machineVerificationEvidence: freeze.machineVerificationEvidence, frontendIdentity: freeze.mixedEnvironmentIdentity,
    baselineSource: `${root}/UX_SPEC.md`,
    interactions: [{ id: 'INT-001', scenario: 'Save', expected: 'Saved value appears', observed: 'Saved value appeared', outcome: 'pass' }],
    visualComparisons: [{ id: 'VIS-001', scenario: 'Form layout', expected: 'Matches approved prototype', observed: 'Matches approved prototype', outcome: 'match',
      baselineScreenshot: `${imageRoot}/prototype.png`, actualScreenshot: `${imageRoot}/actual.png` }] };
  const path = join(cwd, root, 'UI_ACCEPTANCE.json');
  writeFileSync(path, `${JSON.stringify(report)}\n`);
  runGit(cwd, ['add', '.']); runGit(cwd, ['commit', '-m', 'test: record interactive visual evidence']);
  return { cwd, path, report, requirement, freeze };
}

test('UI acceptance requires committed interactive cases and screenshot comparison bound to the frozen candidate', t => {
  const s = setup(t);
  assert.equal(uiAcceptanceRequired({ requirement: s.requirement }), true);
  assert.match(validateUiAcceptanceReport(s).evidenceSha256, /^[0-9a-f]{64}$/);
  writeFileSync(s.path, `${JSON.stringify({ ...s.report, candidateId: 'different' })}\n`);
  assert.throws(() => validateUiAcceptanceReport(s), { code: 'UI_ACCEPTANCE_REPORT_REQUIRED' });
});

test('visual differences cannot be accepted as a match and backend-only work remains exempt', t => {
  const s = setup(t);
  writeFileSync(s.path, `${JSON.stringify({ ...s.report, visualComparisons: [{ ...s.report.visualComparisons[0], outcome: 'difference' }] })}\n`);
  runGit(s.cwd, ['add', '.']); runGit(s.cwd, ['commit', '-m', 'test: visual mismatch']);
  assert.throws(() => validateUiAcceptanceReport(s), { code: 'UI_ACCEPTANCE_DIFFERENCE_OPEN' });
  assert.equal(uiAcceptanceRequired({ requirement: { ...s.requirement, uxImpact: 'none', resources: { services: ['api'] } } }), false);
});

test('B-248: a copied screenshot presented as both baseline and actual is rejected', t => {
  const s = setup(t);
  writeFileSync(join(s.cwd, `${'docs/product/current/I-002-ui-acceptance'}/reviews/screenshots/actual.png`), image);
  runGit(s.cwd, ['add', '.']); runGit(s.cwd, ['commit', '-m', 'test: copied screenshot']);
  assert.throws(() => validateUiAcceptanceReport(s), { code: 'UI_ACCEPTANCE_IDENTICAL_SCREENSHOTS' });
});

test('I-268: a new-policy handoff cannot certify one interaction while its designed business journey was never checked', t => {
  const s = setup(t);
  s.requirement.scenarioAcceptanceVersion = 1;
  assert.throws(() => validateUiAcceptanceReport(s), { code: 'ACCEPTANCE_SCENARIOS_REQUIRED' });
});

test('Testing UI acceptance is current only while the approved visual evidence hash matches', t => {
  const s = setup(t);
  const commit = runGit(s.cwd, ['rev-parse', 'HEAD']);
  const freeze = { ...s.freeze, requirementId: s.requirement.id, version: s.requirement.version, validationEpoch: 0, commit,
    acceptance: { authorizedBy: 'owner', instructionRef: 'user-message:accepted-ui', acceptedAt: '2026-10-26T03:00:00Z',
      uiEvidenceSha256: validateUiAcceptanceReport(s).evidenceSha256 } };
  const entries = new Map([['freezes/dev.json', freeze], [`environments/${s.requirement.id}/mixed-dev.json`, { mode: 'mixed-dev', identitySha256: freeze.mixedEnvironmentIdentity }]]);
  const snapshot = { has: path => entries.has(path), readJson: path => entries.get(path) };
  assert.equal(humanAcceptanceReadiness({ snapshot, cwd: s.cwd, requirement: s.requirement, currentCommit: commit }).ok, true);
  entries.set('freezes/dev.json', { ...freeze, acceptance: { ...freeze.acceptance, uiEvidenceSha256: '0'.repeat(64) } });
  assert.equal(humanAcceptanceReadiness({ snapshot, cwd: s.cwd, requirement: s.requirement, currentCommit: commit }).ok, false);
});

test('freeze acceptance records the committed visual evidence only with direct user authorization', async t => {
  const s = setup(t);
  const commit = runGit(s.cwd, ['rev-parse', 'HEAD']);
  const frozen = { schemaVersion: 1, resource: 'dev', state: 'awaiting_human', requirementId: s.requirement.id,
    version: s.requirement.version, validationEpoch: 0, candidateId: s.freeze.candidateId,
    machineVerificationEvidence: s.freeze.machineVerificationEvidence, mixedEnvironmentIdentity: s.freeze.mixedEnvironmentIdentity,
    deploymentSnapshot: {}, branch: 'main', commit, frozenAt: '2026-10-26T03:00:00Z', actor: { sessionId: 'earlier-session' } };
  const snapshot = new CoordinationSnapshot({ sha: 'fixture-sha', files: new Map([
    [`requirements/${s.requirement.id}.json`, JSON.stringify(s.requirement)],
    ['freezes/dev.json', JSON.stringify(frozen)],
    [`environments/${s.requirement.id}/mixed-dev.json`, JSON.stringify({ identitySha256: frozen.mixedEnvironmentIdentity })],
  ]) });
  const store = { update: async ({ mutate }) => { mutate(snapshot); return { operationId: 'accepted', sha: 'updated' }; } };
  const session = initializeSession({ cwd: s.cwd, agent: 'ui-test', user: 'owner', host: 'fixture' });
  const result = await unfreezeFact({ outcome: 'accepted', store, cwd: s.cwd, requirementId: s.requirement.id,
    reason: 'User compared the saved state and approved layout', authorizedBy: 'owner', instructionRef: 'user-message:accepted-ui', session });
  assert.equal(result.acceptance.uiEvidenceSha256, validateUiAcceptanceReport({ cwd: s.cwd, requirement: s.requirement, freeze: frozen }).evidenceSha256);
});

test('enrolled candidates use immutable per-attempt reports without overwriting the previous acceptance', t => {
  const s = setup(t);
  const root = 'docs/product/current/I-002-ui-acceptance';
  const previous = runGit(s.cwd, ['show', `HEAD:${root}/UI_ACCEPTANCE.json`]);
  s.requirement.acceptanceWorkflowVersion = 1;
  s.freeze.attemptId = 'attempt-0123456789abcdef';
  const report = { ...s.report, attemptId: s.freeze.attemptId, machineVerificationEvidence: 'c'.repeat(64) };
  s.freeze.machineVerificationEvidence = report.machineVerificationEvidence;
  mkdirSync(join(s.cwd, root, 'acceptance', s.freeze.attemptId), { recursive: true });
  writeFileSync(join(s.cwd, root, 'acceptance', s.freeze.attemptId, 'UI_ACCEPTANCE.json'), JSON.stringify(report));
  runGit(s.cwd, ['add', '.']); runGit(s.cwd, ['commit', '-m', 'record second immutable acceptance attempt']);
  const validated = validateUiAcceptanceReport(s);
  assert.equal(validated.reportPath, `${root}/acceptance/${s.freeze.attemptId}/UI_ACCEPTANCE.json`);
  assert.equal(runGit(s.cwd, ['show', `HEAD:${root}/UI_ACCEPTANCE.json`]), previous);
});

test('a durable accepted candidate remains available after its environment occupancy is released', () => {
  assert.equal(typeof acceptance.resolveAcceptanceFact, 'function');
  const id = 'I-002', attemptId = 'attempt-0123456789abcdef';
  const entries = new Map([
    [`acceptance/${id}/current.json`, { schemaVersion: 1, requirementId: id, attemptId, state: 'accepted' }],
    [`acceptance/${id}/${attemptId}.json`, { schemaVersion: 1, requirementId: id, attemptId, candidateId: 'candidate-1' }],
    [`acceptance/${id}/${attemptId}-decision.json`, { outcome: 'accepted', acceptance: { authorizedBy: 'owner', instructionRef: 'user-message:current-candidate' } }],
  ]);
  const snapshot = { has: p => entries.has(p), readJson: p => entries.get(p) };
  assert.equal(acceptance.resolveAcceptanceFact(snapshot, id).acceptance.authorizedBy, 'owner');
  entries.set(`acceptance/${id}/current.json`, { ...entries.get(`acceptance/${id}/current.json`), invalidated: true });
  assert.equal(acceptance.resolveAcceptanceFact(snapshot, id), null);
});

test('enrolled acceptance atomically stores the direct decision, advances, releases dev and safely replays', async t => {
  const s = setup(t), root = 'docs/product/current/I-002-ui-acceptance';
  s.requirement = { ...s.requirement, lifecycle: 'user_acceptance', acceptanceWorkflowVersion: 1, branch: 'main', uxImpact: 'none', resources: { services: ['web'] } };
  const attemptId = 'attempt-0123456789abcdef';
  s.freeze = { ...s.freeze, schemaVersion: 1, resource: 'dev', state: 'awaiting_human', requirementId: s.requirement.id,
    version: s.requirement.version, validationEpoch: 0, attemptId, branch: 'main', deploymentSnapshot: {}, frozenAt: '2026-11-04T00:00:00Z', actor: { sessionId: 'fixture' } };
  mkdirSync(join(s.cwd, root, 'acceptance', attemptId), { recursive: true });
  writeFileSync(join(s.cwd, root, 'acceptance', attemptId, 'UI_ACCEPTANCE.json'), JSON.stringify({ ...s.report, attemptId }));
  writeFileSync(join(s.cwd, root, 'FEEDBACK.json'), JSON.stringify({ schemaVersion: 1, requirementId: 'I-002', items: [] }));
  writeFileSync(join(s.cwd, root, 'TRACEABILITY.json'), JSON.stringify({ schemaVersion: 1, requirementId: 'I-002', items: [] }));
  writeFileSync(join(s.cwd, 'BACKLOG.md'), '| ID | 需求描述 | 需迁移 | 当前状态 | Version | 备注 |\n| I-002 | fixture | 否 | 👤 User Acceptance | v0.9.1 | fixture |\n');
  runGit(s.cwd, ['add', '.']); runGit(s.cwd, ['commit', '-m', 'record immutable attempt']);
  s.freeze.commit = runGit(s.cwd, ['rev-parse', 'HEAD']);
  const snapshot = new CoordinationSnapshot({ sha: 'fixture-sha', files: new Map([
    ['requirements/I-002.json', JSON.stringify(s.requirement)], ['freezes/dev.json', JSON.stringify(s.freeze)],
    [`acceptance/I-002/${attemptId}.json`, JSON.stringify(s.freeze)],
    ['acceptance/I-002/current.json', JSON.stringify({ schemaVersion: 1, requirementId: 'I-002', attemptId, state: 'active' })],
    ['environments/I-002/mixed-dev.json', JSON.stringify({ identitySha256: s.freeze.mixedEnvironmentIdentity })],
  ]) });
  const store = { readSnapshot: async () => snapshot, update: async ({ mutate }) => { await mutate(snapshot); return { sha: 'fixture', operationId: 'accept-once' }; } };
  const session = initializeSession({ cwd: s.cwd, agent: 'test', user: 'owner', host: 'fixture' });
  const prepared = prepareReview({ snapshot, cwd: s.cwd, requirement: s.requirement, stage: 'verification' });
  const review = await recordReview({ store, cwd: s.cwd, id: 'I-002', stage: 'verification', session,
    report: { schemaVersion: 1, requirementId: 'I-002', stage: 'verification', subjectFingerprint: prepared.subjectFingerprint, verdict: 'pass', findings: [], feedbackIds: [] } });
  s.freeze.verificationReview = { reviewId: review.reviewId, subjectFingerprint: review.subjectFingerprint, reportHash: review.reportHash };
  snapshot.writeJson('freezes/dev.json', s.freeze);
  snapshot.writeJson(`acceptance/I-002/${attemptId}.json`, s.freeze);
  const args = { outcome: 'accepted', store, cwd: s.cwd, requirementId: 'I-002', reason: 'User directly approved the exact candidate', authorizedBy: 'owner', instructionRef: 'user-message:accept-candidate', session };
  writeFileSync(join(s.cwd, 'pending-code.mjs'), 'export const unverified = true;\n');
  await assert.rejects(unfreezeFact(args), { code: 'FREEZE_DIRTY_SOURCES' });
  rmSync(join(s.cwd, 'pending-code.mjs'));
  snapshot.writeJson('requirements/I-002.json', { ...s.requirement, reviewEpochs: { verification: 1 } });
  await assert.rejects(unfreezeFact(args), { code: 'FREEZE_VERIFICATION_REQUIRED' });
  assert.equal(snapshot.has('freezes/dev.json'), true);
  snapshot.writeJson('requirements/I-002.json', s.requirement);
  const result = await unfreezeFact(args);
  assert.equal(result.acceptance.authorizedBy, 'owner');
  assert.equal(snapshot.has('freezes/dev.json'), false);
  assert.equal(snapshot.readJson('requirements/I-002.json').lifecycle, 'test_passed');
  const replay = await unfreezeFact(args);
  assert.equal(replay.reused, true);
  assert.equal(snapshot.readJson('requirements/I-002.json').lifecycleHistory.length, 1);
  assert.equal(acceptance.resolveAcceptanceFact(snapshot, 'I-002').acceptance.authorizedBy, 'owner');
  const released = await unfreezeFact({ ...args, outcome: 'released' });
  assert.equal(released.released, true);
  assert.equal(acceptance.resolveAcceptanceFact(snapshot, 'I-002').acceptance.authorizedBy, 'owner');

  const acceptedRequirement = snapshot.readJson('requirements/I-002.json');
  snapshot.writeJson('requirements/I-002.json', { ...acceptedRequirement, lifecycle: 'prod_planning' });
  writeFileSync(join(s.cwd, 'BACKLOG.md'), '| ID | 需求描述 | 需迁移 | 当前状态 | Version | 备注 |\n| I-002 | fixture | 否 | 📋 Prod Planning | v0.9.1 | fixture |\n');
  const laterReplay = await unfreezeFact(args);
  assert.equal(laterReplay.reused, true);
  assert.equal(snapshot.readJson('requirements/I-002.json').lifecycle, 'prod_planning');
  assert.match(readFileSync(join(s.cwd, 'BACKLOG.md'), 'utf8'), /📋 Prod Planning/);
});

for (const outcome of ['paused', 'released']) test(`${outcome} returns a pending candidate's occupancy without manufacturing acceptance`, async t => {
  const s = setup(t), attemptId = 'attempt-0123456789abcdef';
  const requirement = { ...s.requirement, lifecycle: 'user_acceptance', acceptanceWorkflowVersion: 1 };
  const fact = { ...s.freeze, schemaVersion: 1, requirementId: requirement.id, version: requirement.version,
    resource: 'dev', state: 'awaiting_human', attemptId, deploymentSnapshot: {}, branch: 'main',
    commit: runGit(s.cwd, ['rev-parse', 'HEAD']), frozenAt: '2026-11-04T00:00:00Z', actor: { sessionId: 'fixture' } };
  const snapshot = new CoordinationSnapshot({ sha: 'fixture', files: new Map([
    ['requirements/I-002.json', JSON.stringify(requirement)], ['freezes/dev.json', JSON.stringify(fact)],
    [`acceptance/I-002/${attemptId}.json`, JSON.stringify(fact)],
    ['acceptance/I-002/current.json', JSON.stringify({ schemaVersion: 1, requirementId: 'I-002', attemptId, state: 'active' })],
  ]) });
  const store = { readSnapshot: async () => snapshot, update: async ({ mutate }) => { mutate(snapshot); return { sha: 'updated' }; } };
  const session = initializeSession({ cwd: s.cwd, agent: 'test', user: 'owner', host: 'fixture' });
  const args = { outcome, store, cwd: s.cwd, requirementId: 'I-002', session, reason: 'Return dev while the human reviews this preserved candidate' };
  await unfreezeFact(args);
  assert.equal(snapshot.has('freezes/dev.json'), false);
  assert.equal(acceptance.resolveAcceptanceFact(snapshot, 'I-002').windowState, outcome === 'paused' ? 'paused' : 'released');
  assert.equal(acceptance.resolveAcceptanceFact(snapshot, 'I-002').acceptance, undefined);
  assert.equal(snapshot.readJson('requirements/I-002.json').lifecycle, 'user_acceptance');
  assert.equal((await unfreezeFact(args)).reused, true);
});
