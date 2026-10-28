import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CoordinationSnapshot } from '../../lib/coordination/git-store.mjs';
import { initializeSession } from '../../lib/coordination/worktrees.mjs';
import { createGitFixture, runGit } from './fixtures.mjs';

const protocol = await import('../../lib/coordination/reviews.mjs').catch(() => ({}));
const doc = 'docs/product/current/I-002-task';
function setup(t) {
  assert.equal(typeof protocol.recordReview, 'function', 'review recording is implemented');
  const { clientA: cwd, clientB: peer } = createGitFixture(t);
  mkdirSync(join(cwd, doc), { recursive: true });
  const feedback = { schemaVersion: 1, requirementId: 'I-002', items: [{ id: 'FB-001', source: 'user-message:task-feedback', decision: 'accepted', expected: 'Save returns the persisted value.' }] };
  writeFileSync(join(cwd, doc, 'FEEDBACK.json'), JSON.stringify(feedback));
  writeFileSync(join(cwd, doc, 'TRACEABILITY.json'), JSON.stringify({ schemaVersion: 1, requirementId: 'I-002', items: [{ feedbackId: 'FB-001', design: [`${doc}/TECH_DESIGN.md`], implementation: ['task.mjs'], verification: ['task.test.mjs'] }] }));
  for (const file of ['REQUIREMENT.md', 'TECH_DESIGN.md', 'IMPLEMENTATION_PLAN.md']) writeFileSync(join(cwd, doc, file), '# Saved task\n');
  writeFileSync(join(cwd, doc, 'ACCEPTANCE.md'), '# Acceptance\n\n## Plan\nSaving persists.\n\n## 本地验收结果\nPending.\n');
  writeFileSync(join(cwd, 'task.mjs'), 'export const save = () => true;\n');
  writeFileSync(join(cwd, 'task.test.mjs'), '// save contract\n');
  writeFileSync(join(cwd, 'BACKLOG.md'), '| I-002 | Task | 否 | 🔨 In Dev | v0.9.1 | pending |\n');
  commit(cwd);
  const requirement = { id: 'I-002', workflowVersion: 2, workflowEpoch: 0, version: 'v0.9.1', branch: 'main' };
  const snapshot = new CoordinationSnapshot({ sha: 'coord-sha', files: new Map([[`requirements/${requirement.id}.json`, JSON.stringify(requirement)]]) });
  const store = { readSnapshot: async () => snapshot, update: async ({ mutate }) => { mutate(snapshot); return { sha: 'updated-sha' }; } };
  const session = initializeSession({ cwd, agent: 'review-test', user: 'owner', host: 'host' });
  const args = { cwd, store, id: requirement.id, session, stage: 'implementation' };
  const report = (findings = [], verdict = findings.length ? 'needs-fix' : 'pass') => ({ schemaVersion: 1, requirementId: requirement.id, stage: args.stage,
    subjectFingerprint: protocol.prepareReview({ cwd, snapshot, requirement, stage: args.stage }).subjectFingerprint,
    verdict, feedbackIds: ['FB-001'], findings });
  return { cwd, peer, requirement, snapshot, store, args, report };
}
function commit(cwd) { runGit(cwd, ['add', '.']); runGit(cwd, ['commit', '-m', 'test: review subject']); }
const finding = { id: 'F-001', priority: 'P1', message: 'Save must persist the value.', paths: ['task.mjs'] };

test('a pass is bound to current committed inputs, covers feedback, and rejects dirty subject', async (t) => {
  const s = setup(t);
  await assert.rejects(protocol.recordReview({ ...s.args, report: { ...s.report(), feedbackIds: [] } }), { code: 'FEEDBACK_REVIEW_COVERAGE_MISSING' });
  await assert.rejects(protocol.recordReview({ ...s.args, report: s.report([finding], 'pass') }), { code: 'REVIEW_OPEN_BLOCKERS' });
  const fact = await protocol.recordReview({ ...s.args, report: s.report() });
  assert.equal(fact.round, 1); assert.equal(fact.actor.sessionId, s.args.session.sessionId); assert.match(fact.reportHash, /^[0-9a-f]{64}$/);
  assert.equal(protocol.evaluateReviewReadiness({ ...s, stage: 'implementation' }).ok, true);
  writeFileSync(join(s.cwd, 'task.mjs'), 'export const save = () => false;\n');
  assert.equal(protocol.evaluateReviewReadiness({ ...s, stage: 'implementation' }).ok, false);
  await assert.rejects(protocol.recordReview({ ...s.args, report: s.report() }), { code: 'REVIEW_SUBJECT_INVALID' });
  commit(s.cwd);
  assert.equal(protocol.evaluateReviewReadiness({ ...s, stage: 'implementation' }).missing.some((m) => m.code === 'REVIEW_STALE'), true);
});

test('a needs-fix review may record missing traceability while the stage stays blocked', async (t) => {
  const s = setup(t);
  writeFileSync(join(s.cwd, doc, 'TRACEABILITY.json'), JSON.stringify({ schemaVersion: 1, requirementId: s.requirement.id, items: [] }));
  commit(s.cwd);
  const missingMap = { id: 'F-TRACE', priority: 'P1', message: 'Accepted feedback lacks implementation mapping.', paths: [`${doc}/TRACEABILITY.json`] };
  const fact = await protocol.recordReview({ ...s.args, report: s.report([missingMap]) });
  assert.equal(fact.report.verdict, 'needs-fix');
  assert.equal(protocol.evaluateReviewReadiness({ ...s, stage: s.args.stage }).ok, false);
  await assert.rejects(protocol.recordReview({ ...s.args, report: s.report() }), { code: 'FEEDBACK_MAPPING_MISSING' });
});

test('two needs-fix rounds survive commits and sessions; one targeted verification can close round two', async (t) => {
  const s = setup(t);
  await protocol.recordReview({ ...s.args, report: s.report([finding]) });
  writeFileSync(join(s.cwd, 'task.mjs'), 'export const save = () => "partial";\n'); commit(s.cwd);
  const second = await protocol.recordReview({ ...s.args, report: s.report([finding]) });
  assert.equal(second.round, 2);
  await assert.rejects(protocol.recordReview({ ...s.args, report: s.report() }), { code: 'REVIEW_ROUND_LIMIT' });
  writeFileSync(join(s.cwd, 'task.mjs'), 'export const save = () => "persisted";\n'); commit(s.cwd);
  const verification = { schemaVersion: 1, requirementId: s.requirement.id, stage: s.args.stage, subjectFingerprint: s.report().subjectFingerprint,
    reviewId: second.reviewId, closedFindingIds: ['F-001'], remainingFindingIds: [], feedbackIds: ['FB-001'] };
  await protocol.verifyReview({ ...s.args, report: verification });
  assert.equal(protocol.evaluateReviewReadiness({ ...s, stage: s.args.stage }).ok, true);
  await assert.rejects(protocol.verifyReview({ ...s.args, report: verification }), { code: 'REVIEW_VERIFICATION_EXISTS' });
});

test('later reviews cannot omit prior blockers and targeted verification cannot omit known findings', async (t) => {
  const s = setup(t);
  const first = await protocol.recordReview({ ...s.args, report: s.report([finding]) });
  await assert.rejects(protocol.recordReview({ ...s.args, report: s.report() }), { code: 'REVIEW_FINDING_OMITTED' });
  const report = { schemaVersion: 1, requirementId: s.requirement.id, stage: s.args.stage, subjectFingerprint: s.report().subjectFingerprint,
    reviewId: first.reviewId, closedFindingIds: [], remainingFindingIds: [], feedbackIds: ['FB-001'] };
  await assert.rejects(protocol.verifyReview({ ...s.args, report }), { code: 'REVIEW_FINDING_OMITTED' });
});

test('targeted verification rejects unrelated repairs, stale reports, forged rounds and traversal', async (t) => {
  const s = setup(t);
  await assert.rejects(protocol.recordReview({ ...s.args, report: { ...s.report(), round: 0 } }), { code: 'REVIEW_REPORT_INVALID' });
  await assert.rejects(protocol.recordReview({ ...s.args, report: s.report([{ ...finding, paths: ['../secret'] }]) }), { code: 'REVIEW_REPORT_INVALID' });
  const first = await protocol.recordReview({ ...s.args, report: s.report([finding]) });
  const old = s.report();
  writeFileSync(join(s.cwd, 'README.md'), '# Unrelated change\n'); commit(s.cwd);
  await assert.rejects(protocol.recordReview({ ...s.args, report: old }), { code: 'REVIEW_REPORT_STALE' });
  await assert.rejects(protocol.verifyReview({ ...s.args, report: { schemaVersion: 1, requirementId: s.requirement.id, stage: s.args.stage,
    subjectFingerprint: s.report().subjectFingerprint, reviewId: first.reviewId, closedFindingIds: ['F-001'], remainingFindingIds: [], feedbackIds: ['FB-001'] } }), { code: 'REVIEW_REPAIR_SCOPE_EXCEEDED' });
});

test('result-only evidence and BACKLOG commits retain the review, unrelated tracked inputs invalidate it', async (t) => {
  const s = setup(t);
  await protocol.recordReview({ ...s.args, report: s.report() });
  writeFileSync(join(s.cwd, 'BACKLOG.md'), '| I-002 | Task | 否 | 🧪 Testing | v0.9.1 | reviewed |\n');
  writeFileSync(join(s.cwd, doc, 'TEST_EVIDENCE.json'), '{"result":"pass"}\n');
  writeFileSync(join(s.cwd, doc, 'ACCEPTANCE.md'), '# Acceptance\n\n## Plan\nSaving persists.\n\n## 本地验收结果\nAll tests passed.\n');
  commit(s.cwd);
  assert.equal(protocol.evaluateReviewReadiness({ ...s, stage: s.args.stage }).ok, true);
  writeFileSync(join(s.cwd, doc, 'ACCEPTANCE.md'), '# Acceptance\n\n## Plan\nSaving only validates.\n\n## 本地验收结果\nAll tests passed.\n'); commit(s.cwd);
  assert.equal(protocol.evaluateReviewReadiness({ ...s, stage: s.args.stage }).ok, false);
});

test('rebasing over unrelated origin/main work preserves the feature review', async (t) => {
  const s = setup(t);
  const fact = await protocol.recordReview({ ...s.args, report: s.report() });
  writeFileSync(join(s.peer, 'README.md'), '# Unrelated main update\n');
  runGit(s.peer, ['add', 'README.md']);
  runGit(s.peer, ['commit', '-m', 'docs: unrelated main update']);
  runGit(s.peer, ['push', 'origin', 'main']);
  runGit(s.cwd, ['fetch', 'origin', 'main']);
  runGit(s.cwd, ['rebase', 'origin/main']);
  assert.notEqual(runGit(s.cwd, ['rev-parse', 'HEAD']), fact.subjectCommit);
  assert.equal(protocol.prepareReview({ cwd: s.cwd, snapshot: s.snapshot, requirement: s.requirement, stage: 'implementation' }).subjectFingerprint, fact.subjectFingerprint);
  assert.equal(protocol.evaluateReviewReadiness({ ...s, stage: 'implementation' }).ok, true);
});

test('rework epoch is explicit and legacy requirements do not need fabricated reviews', async (t) => {
  const s = setup(t);
  await protocol.recordReview({ ...s.args, report: s.report([finding]) });
  await protocol.recordReview({ ...s.args, report: s.report([finding]) });
  s.requirement.workflowEpoch = 1; s.snapshot.writeJson(`requirements/${s.requirement.id}.json`, s.requirement);
  const newCycle = await protocol.recordReview({ ...s.args, report: s.report() });
  assert.equal(newCycle.round, 1); assert.equal(newCycle.workflowEpoch, 1);
  assert.deepEqual(protocol.evaluateReviewReadiness({ ...s, requirement: { id: s.requirement.id }, stage: s.args.stage }), { ok: true, exempt: 'legacy', missing: [] });
});

test('round two may explicitly close prior findings; no pass can downgrade or silently remove them', async (t) => {
  const s = setup(t);
  await protocol.recordReview({ ...s.args, report: s.report([finding]) });
  await assert.rejects(protocol.recordReview({ ...s.args, report: s.report([{ ...finding, priority: 'P3' }], 'pass') }), { code: 'REVIEW_FINDING_CHANGED' });
  const fact = await protocol.recordReview({ ...s.args, report: { ...s.report(), closedFindingIds: ['F-001'] } });
  assert.equal(fact.round, 2);
  assert.equal(protocol.evaluateReviewReadiness({ ...s, stage: s.args.stage }).ok, true);
});

test('one targeted verification retaining a P0/P1 blocker fails closed and cannot be retried', async (t) => {
  const s = setup(t);
  const first = await protocol.recordReview({ ...s.args, report: s.report([finding]) });
  const report = { schemaVersion: 1, requirementId: s.requirement.id, stage: s.args.stage, subjectFingerprint: s.report().subjectFingerprint,
    reviewId: first.reviewId, closedFindingIds: [], remainingFindingIds: ['F-001'], feedbackIds: ['FB-001'] };
  await protocol.verifyReview({ ...s.args, report });
  assert.equal(protocol.evaluateReviewReadiness({ ...s, stage: s.args.stage }).ok, false);
  await assert.rejects(protocol.verifyReview({ ...s.args, report: { ...report, closedFindingIds: ['F-001'], remainingFindingIds: [] } }), { code: 'REVIEW_VERIFICATION_EXISTS' });
});

test('targeted verification records new blockers and round two must carry or close them', async (t) => {
  const s = setup(t);
  const first = await protocol.recordReview({ ...s.args, report: s.report([finding]) });
  const newlyFound = { id: 'F-002', priority: 'P1', message: 'The regression test is missing.', paths: ['task.test.mjs'] };
  const verification = { schemaVersion: 1, requirementId: s.requirement.id, stage: s.args.stage,
    subjectFingerprint: s.report().subjectFingerprint, reviewId: first.reviewId,
    closedFindingIds: ['F-001'], remainingFindingIds: [], newFindings: [newlyFound], feedbackIds: ['FB-001'] };
  await protocol.verifyReview({ ...s.args, report: verification });
  assert.equal(protocol.evaluateReviewReadiness({ ...s, stage: s.args.stage }).ok, false);
  await assert.rejects(protocol.recordReview({ ...s.args, report: s.report() }), { code: 'REVIEW_FINDING_OMITTED' });
  const second = await protocol.recordReview({ ...s.args, report: s.report([newlyFound]) });
  assert.equal(second.round, 2);
});

test('round two new blockers exhaust the review budget, while future exact repair paths are allowed', async (t) => {
  const s = setup(t);
  const future = { ...finding, repairPaths: ['task.regression.test.mjs'] };
  const first = await protocol.recordReview({ ...s.args, report: s.report([future]) });
  writeFileSync(join(s.cwd, 'task.regression.test.mjs'), '// regression\n'); commit(s.cwd);
  await protocol.verifyReview({ ...s.args, report: { schemaVersion: 1, requirementId: s.requirement.id, stage: s.args.stage,
    subjectFingerprint: s.report().subjectFingerprint, reviewId: first.reviewId,
    closedFindingIds: ['F-001'], remainingFindingIds: [], feedbackIds: ['FB-001'] } });
  const second = await protocol.recordReview({ ...s.args, report: s.report([future]) });
  const newFinding = { id: 'F-003', priority: 'P1', message: 'Another blocker appeared.', paths: ['task.test.mjs'] };
  await protocol.verifyReview({ ...s.args, report: { schemaVersion: 1, requirementId: s.requirement.id, stage: s.args.stage,
    subjectFingerprint: s.report().subjectFingerprint, reviewId: second.reviewId,
    closedFindingIds: ['F-001'], remainingFindingIds: [], newFindings: [newFinding], feedbackIds: ['FB-001'] } });
  assert.equal(protocol.evaluateReviewReadiness({ ...s, stage: s.args.stage }).ok, false);
  await assert.rejects(protocol.recordReview({ ...s.args, report: s.report([newFinding]) }), { code: 'REVIEW_ROUND_LIMIT' });
  await assert.rejects(protocol.recordReview({ ...s.args, report: s.report([{ ...finding, repairPaths: ['**/*.mjs'] }]) }), { code: 'REVIEW_REPORT_INVALID' });
});

test('a report on an unreachable commit and a malformed immutable fact never authorize readiness', async (t) => {
  const s = setup(t);
  await protocol.recordReview({ ...s.args, report: s.report() });
  const path = `reviews/${s.requirement.id}/${s.args.stage}/epoch-0/round-1.json`;
  const fact = s.snapshot.readJson(path);
  s.snapshot.writeJson(path, { ...fact, subjectCommit: 'a'.repeat(40) });
  assert.equal(protocol.evaluateReviewReadiness({ ...s, stage: s.args.stage }).ok, false);
  s.snapshot.writeJson(path, { ...fact, round: 0 });
  assert.equal(protocol.evaluateReviewReadiness({ ...s, stage: s.args.stage }).missing[0].code, 'REVIEW_FACT_INVALID');
});

test('invalid JSON values produce report errors and stored cross-round finding omissions fail closed', async (t) => {
  const s = setup(t);
  await assert.rejects(protocol.recordReview({ ...s.args, report: undefined }), { code: 'REVIEW_REPORT_INVALID' });
  await protocol.recordReview({ ...s.args, report: s.report([finding]) });
  const second = await protocol.recordReview({ ...s.args, report: s.report([finding]) });
  const path = `reviews/${s.requirement.id}/${s.args.stage}/epoch-0/round-2.json`;
  const alteredReport = { ...second.report, findings: [], verdict: 'pass' };
  const stableJson = (value) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
  return import('node:crypto').then(({ createHash }) => {
    s.snapshot.writeJson(path, { ...second, report: alteredReport, reportHash: createHash('sha256').update(stableJson(alteredReport)).digest('hex') });
    assert.equal(protocol.evaluateReviewReadiness({ ...s, stage: s.args.stage }).ok, false);
  });
});

function mergeFeature(s) {
  const branch = 'feature/merged-task';
  runGit(s.cwd, ['checkout', '-b', branch]);
  writeFileSync(join(s.cwd, 'task.mjs'), 'export const save = () => "merged";\n'); commit(s.cwd);
  runGit(s.cwd, ['checkout', 'main']); runGit(s.cwd, ['merge', '--no-ff', '-m', 'test: merge task', branch]);
  Object.assign(s.requirement, { branch, mergeStatus: 'merged', mergedCommit: runGit(s.cwd, ['rev-parse', 'HEAD']) });
  s.snapshot.writeJson(`requirements/${s.requirement.id}.json`, s.requirement);
}

test('release and closure reviews may be recorded on named descendants after the real feature merge', async (t) => {
  const s = setup(t); mergeFeature(s);
  s.args.stage = 'release';
  await protocol.recordReview({ ...s.args, report: s.report() });
  runGit(s.cwd, ['checkout', '-b', 'docs/release-v0.9.1']);
  s.args.stage = 'closure';
  const fact = await protocol.recordReview({ ...s.args, report: s.report() });
  assert.equal(fact.stage, 'closure');
});

test('postmerge stage records reject an unrelated revision and premerge stages remain feature-bound', async (t) => {
  const s = setup(t); mergeFeature(s);
  await assert.rejects(protocol.recordReview({ ...s.args, report: s.report() }), { code: 'REVIEW_BRANCH_MISMATCH' });
  s.args.stage = 'closure';
  runGit(s.cwd, ['reset', '--hard', 'HEAD~1']);
  await assert.rejects(protocol.recordReview({ ...s.args, report: s.report() }), { code: 'REVIEW_BRANCH_MISMATCH' });
});
