import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGitFixture, runGit } from './fixtures.mjs';
import { uiAcceptanceRequired, validateUiAcceptanceReport } from '../../lib/coordination/ui-acceptance.mjs';
import { humanAcceptanceReadiness } from '../../lib/coordination/workflow-policy.mjs';
import { CoordinationSnapshot } from '../../lib/coordination/git-store.mjs';
import { initializeSession } from '../../lib/coordination/worktrees.mjs';
import { unfreezeFact } from '../../lib/coordination/freezes.mjs';

const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');
function setup(t) {
  const { clientA: cwd } = createGitFixture(t);
  const root = 'docs/product/current/I-002-ui-acceptance';
  const imageRoot = `${root}/reviews/screenshots`;
  mkdirSync(join(cwd, imageRoot), { recursive: true });
  writeFileSync(join(cwd, root, 'UX_SPEC.md'), '# Approved UX\n');
  for (const path of ['prototype.png', 'actual.png']) writeFileSync(join(cwd, imageRoot, path), image);
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
