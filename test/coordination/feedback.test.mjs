import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createGitFixture, runGit } from './fixtures.mjs';

const protocol = await import('../../lib/coordination/feedback.mjs').catch(() => ({}));
const doc = 'docs/product/current/I-002-task';
function seed(cwd, { decision = 'accepted' } = {}) {
  mkdirSync(join(cwd, doc), { recursive: true });
  const feedback = { schemaVersion: 1, requirementId: 'I-002', items: [{ id: 'FB-001', source: 'user-message:task-feedback', decision, expected: 'Saving shows the persisted value.' }] };
  const traceability = { schemaVersion: 1, requirementId: 'I-002', items: [{ feedbackId: 'FB-001', design: [`${doc}/TECH_DESIGN.md`], implementation: ['task.mjs'], verification: ['task.test.mjs'] }] };
  writeFileSync(join(cwd, doc, 'FEEDBACK.json'), JSON.stringify(feedback));
  writeFileSync(join(cwd, doc, 'TRACEABILITY.json'), JSON.stringify(traceability));
  writeFileSync(join(cwd, doc, 'TECH_DESIGN.md'), '# Task design\n');
  writeFileSync(join(cwd, 'task.mjs'), 'export const save = () => true;\n');
  writeFileSync(join(cwd, 'task.test.mjs'), '// save contract\n');
  commit(cwd);
  return { feedback, traceability };
}
function commit(cwd) { runGit(cwd, ['add', '.']); runGit(cwd, ['commit', '-m', 'test: feedback artifacts']); }
const requirement = { id: 'I-002', workflowVersion: 2 };

test('accepted feedback requires stage mappings and every accepted ID in review coverage', (t) => {
  assert.equal(typeof protocol.evaluateFeedbackReadiness, 'function', 'feedback readiness evaluator is implemented');
  const { clientA: cwd } = createGitFixture(t);
  const { traceability } = seed(cwd);
  const input = { cwd, requirement, stage: 'implementation' };
  assert.equal(protocol.evaluateFeedbackReadiness({ ...input, report: { feedbackIds: ['FB-001'] } }).ok, true);
  assert.equal(protocol.evaluateFeedbackReadiness({ ...input, report: { feedbackIds: [] } }).missing.some((m) => m.code === 'FEEDBACK_REVIEW_COVERAGE_MISSING'), true);
  traceability.items[0].implementation = [];
  writeFileSync(join(cwd, doc, 'TRACEABILITY.json'), JSON.stringify(traceability)); commit(cwd);
  assert.equal(protocol.evaluateFeedbackReadiness(input).missing.some((m) => m.code === 'FEEDBACK_MAPPING_MISSING'), true);
});

test('feedback definitions alone determine the UX fingerprint; changing mappings does not', (t) => {
  assert.equal(typeof protocol.inspectFeedbackArtifacts, 'function');
  const { clientA: cwd } = createGitFixture(t);
  const { feedback, traceability } = seed(cwd);
  const first = protocol.inspectFeedbackArtifacts({ cwd, id: requirement.id });
  assert.equal(first.ok, true);
  assert.deepEqual(first.definitionPaths, [`${doc}/FEEDBACK.json`]);
  traceability.items[0].implementation.push('README.md');
  writeFileSync(join(cwd, doc, 'TRACEABILITY.json'), JSON.stringify(traceability)); commit(cwd);
  assert.equal(protocol.inspectFeedbackArtifacts({ cwd, id: requirement.id }).fingerprint, first.fingerprint);
  writeFileSync(join(cwd, doc, 'FEEDBACK.json'), JSON.stringify(feedback, null, 2)); commit(cwd);
  assert.equal(protocol.inspectFeedbackArtifacts({ cwd, id: requirement.id }).fingerprint, first.fingerprint);
  feedback.items[0].expected = 'Saving displays a success receipt.';
  writeFileSync(join(cwd, doc, 'FEEDBACK.json'), JSON.stringify(feedback)); commit(cwd);
  assert.notEqual(protocol.inspectFeedbackArtifacts({ cwd, id: requirement.id }).fingerprint, first.fingerprint);
});

test('pending decisions block design and legacy requirements are exempt', (t) => {
  assert.equal(typeof protocol.evaluateFeedbackReadiness, 'function');
  const { clientA: cwd } = createGitFixture(t); seed(cwd, { decision: 'pending' });
  assert.equal(protocol.evaluateFeedbackReadiness({ cwd, requirement, stage: 'design' }).missing.some((m) => m.code === 'FEEDBACK_DECISION_PENDING'), true);
  assert.deepEqual(protocol.evaluateFeedbackReadiness({ cwd, requirement: { id: 'I-002' }, stage: 'design' }), { ok: true, exempt: 'legacy', missing: [] });
});

test('dirty definitions, duplicate IDs, traversal, nonexistent and symlink references fail closed', (t) => {
  assert.equal(typeof protocol.evaluateFeedbackReadiness, 'function');
  const { clientA: cwd } = createGitFixture(t);
  const { feedback, traceability } = seed(cwd);
  const input = { cwd, requirement, stage: 'design' };
  writeFileSync(join(cwd, doc, 'FEEDBACK.json'), JSON.stringify({ ...feedback, dirty: true }));
  assert.equal(protocol.evaluateFeedbackReadiness(input).ok, false);
  feedback.items.push({ ...feedback.items[0] });
  writeFileSync(join(cwd, doc, 'FEEDBACK.json'), JSON.stringify(feedback)); commit(cwd);
  assert.equal(protocol.evaluateFeedbackReadiness(input).ok, false);
  feedback.items.pop(); writeFileSync(join(cwd, doc, 'FEEDBACK.json'), JSON.stringify(feedback));
  traceability.items[0].design = ['../outside', 'missing.md'];
  writeFileSync(join(cwd, doc, 'TRACEABILITY.json'), JSON.stringify(traceability)); commit(cwd);
  assert.equal(protocol.evaluateFeedbackReadiness(input).ok, false);
  symlinkSync('README.md', join(cwd, 'linked.md'));
  traceability.items[0].design = ['linked.md'];
  writeFileSync(join(cwd, doc, 'TRACEABILITY.json'), JSON.stringify(traceability)); commit(cwd);
  assert.equal(protocol.evaluateFeedbackReadiness(input).ok, false);
});

test('scope removal requires a reason and attributable decision reference', (t) => {
  const { clientA: cwd } = createGitFixture(t);
  const { feedback } = seed(cwd, { decision: 'deferred' });
  const input = { cwd, requirement, stage: 'design' };
  assert.equal(protocol.evaluateFeedbackReadiness(input).ok, false);
  feedback.items[0].reason = 'Deferred by the owner to a later iteration.';
  feedback.items[0].decisionSource = 'user-message:defer-20261026';
  writeFileSync(join(cwd, doc, 'FEEDBACK.json'), JSON.stringify(feedback)); commit(cwd);
  assert.equal(protocol.evaluateFeedbackReadiness(input).ok, true);
  feedback.items[0].source = 'someone said this';
  writeFileSync(join(cwd, doc, 'FEEDBACK.json'), JSON.stringify(feedback)); commit(cwd);
  assert.equal(protocol.evaluateFeedbackReadiness(input).ok, false);
});

test('mapping problems are separated from UX definition validity', (t) => {
  const { clientA: cwd } = createGitFixture(t); seed(cwd);
  writeFileSync(join(cwd, 'task.mjs'), '// dirty implementation\n');
  const artifacts = protocol.inspectFeedbackArtifacts({ cwd, id: requirement.id });
  assert.equal(artifacts.ok, false);
  assert.equal(artifacts.definitionsOk, true);
  assert.deepEqual(artifacts.definitionMissing, []);
});

test('an untracked duplicate feedback definition blocks UX definition readiness', (t) => {
  const { clientA: cwd } = createGitFixture(t); const { feedback } = seed(cwd);
  mkdirSync(join(cwd, 'docs/product/current/I-002-duplicate'), { recursive: true });
  writeFileSync(join(cwd, 'docs/product/current/I-002-duplicate/FEEDBACK.json'), JSON.stringify(feedback));
  assert.equal(protocol.inspectFeedbackArtifacts({ cwd, id: requirement.id }).definitionsOk, false);
});
