import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

test('a classified downstream rework retains the unchanged upstream review cycle', async (t) => {
  const s = setup(t);
  s.args.stage = 'design';
  await protocol.recordReview({ ...s.args, report: s.report() });
  const next = { ...s.requirement, workflowEpoch: 1, reviewEpochs: { design: 0, implementation: 1 } };
  s.snapshot.writeJson('requirements/I-002.json', next);
  assert.equal(protocol.evaluateReviewReadiness({ ...s, requirement: next, stage: 'design' }).ok, true);
  assert.equal(protocol.evaluateReviewReadiness({ ...s, requirement: next, stage: 'implementation' }).ok, false);
});

test('an immutable acceptance attempt report does not invalidate the verification subject', (t) => {
  const s = setup(t);
  const args = { cwd: s.cwd, snapshot: s.snapshot, requirement: s.requirement, stage: 'verification' };
  const before = protocol.prepareReview(args).subjectFingerprint;
  const folder = join(s.cwd, doc, 'acceptance', 'attempt-1234567890abcdef');
  mkdirSync(join(folder, 'screenshots'), { recursive: true });
  writeFileSync(join(folder, 'UI_ACCEPTANCE.json'), JSON.stringify({ schemaVersion: 1, requirementId: s.requirement.id }));
  writeFileSync(join(folder, 'screenshots', 'actual.png'), 'image'); commit(s.cwd);
  assert.equal(protocol.prepareReview(args).subjectFingerprint, before);
});

test('design review is stable when correction observations and downstream traceability are added', t => {
  const s = setup(t);
  s.requirement.acceptanceWorkflowVersion = 1;
  const input = { cwd: s.cwd, snapshot: s.snapshot, requirement: s.requirement, stage: 'design' };
  const before = protocol.prepareReview(input).subjectFingerprint;
  const feedback = { schemaVersion: 1, requirementId: 'I-002', items: [
    { id: 'FB-001', source: 'user-message:task-feedback', decision: 'accepted', expected: 'Save returns the persisted value.' },
    { id: 'OBS-001', observes: 'FB-001', kind: 'correction', source: 'review:save-check', decision: 'accepted', expected: 'Save returns the persisted value.', actual: 'Returned the stale value.' },
  ] };
  writeFileSync(join(s.cwd, doc, 'FEEDBACK.json'), JSON.stringify(feedback));
  writeFileSync(join(s.cwd, doc, 'TRACEABILITY.json'), JSON.stringify({ schemaVersion: 1, requirementId: 'I-002', items: [
    { feedbackId: 'FB-001', design: [`${doc}/TECH_DESIGN.md`], implementation: ['task.mjs', 'README.md'], verification: ['task.test.mjs'] },
    { feedbackId: 'OBS-001', design: [`${doc}/TECH_DESIGN.md`], implementation: ['task.mjs'], verification: ['task.test.mjs'] },
  ] })); commit(s.cwd);
  assert.equal(protocol.prepareReview(input).subjectFingerprint, before);
});

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

// ============================================================================
// I-247（2026-10-31 生产事故）：其他需求的 BACKLOG 行/状态/备注变化不得挪动
// 本需求的评审指纹；旧算法记录的历史事实在算法切换后凭迁移容差保持有效。
// ============================================================================

test("another requirement's new BACKLOG rows or status/notes changes no longer stale the review (I-247)", async (t) => {
  const s = setup(t);
  await protocol.recordReview({ ...s.args, report: s.report() });
  const ownRow = '| I-002 | Task | 否 | 🔨 In Dev | v0.9.1 | pending |';
  // 模拟合并 origin/main 带来其他需求（I-252/I-254 形态）的新行。
  writeFileSync(join(s.cwd, 'BACKLOG.md'), `${ownRow}\n| I-252 | Peer work | 否 | 🧪 Testing | v0.31.2 | merged from origin/main |\n`);
  commit(s.cwd);
  assert.equal(protocol.evaluateReviewReadiness({ ...s, stage: s.args.stage }).ok, true);
  // 其他需求的状态/备注变化与更多新行同样不得挪动指纹。
  writeFileSync(join(s.cwd, 'BACKLOG.md'), `${ownRow}\n| I-252 | Peer work | 是 | ⚪ Todo | v0.31.2 | status and notes rewritten |\n| I-254 | Another peer | 否 | 🔨 In Dev | v0.31.3 | second merged row |\n`);
  commit(s.cwd);
  assert.equal(protocol.evaluateReviewReadiness({ ...s, stage: s.args.stage }).ok, true);
});

// 旧 canonical 未导出（private），这里按切换前的实现等价重算 implementation
// 阶段指纹：路径集 = featurePaths ∪ {BACKLOG.md} ∪ <root>/，BACKLOG 用旧投影
// （保留其他需求行），ACCEPTANCE 投影两代相同，其余文件取 blob oid。
function legacyImplementationFingerprint(cwd, requirement) {
  const sha256 = (value) => createHash('sha256').update(value).digest('hex');
  const show = (path) => execFileSync('git', ['show', `HEAD:${path}`], { cwd, encoding: 'utf8' });
  const head = runGit(cwd, ['rev-parse', 'HEAD']);
  const base = runGit(cwd, ['merge-base', 'HEAD', 'origin/main']);
  const feature = new Set(runGit(cwd, ['diff', '--name-only', '-z', '--no-renames', base, head]).split('\0').filter(Boolean));
  const entries = new Map(runGit(cwd, ['ls-tree', '-r', 'HEAD']).split('\n').filter(Boolean).map((row) => {
    const [metadata, path] = row.split('\t');
    const [mode, , oid] = metadata.split(' ');
    return [path, { mode, oid }];
  }));
  const root = [...entries.keys()]
    .find((path) => path.startsWith(`docs/product/current/${requirement.id}-`) && path.endsWith('/FEEDBACK.json'))
    ?.slice(0, -'/FEEDBACK.json'.length);
  const paths = [...entries.keys()]
    .filter((path) => feature.has(path) || path === 'BACKLOG.md' || path.startsWith(`${root}/`))
    .sort();
  const legacyBacklog = (source) => source.split(/\r?\n/).map((line) => {
    const cells = line.split('|');
    if (!/^(I|F|B)-\d{3,}$/.test(cells[1]?.trim() ?? '')) return line;
    if (cells.length > 4) cells[4] = ' <status projection> ';
    if (cells[1].trim() === requirement.id && cells.length > 6) cells[6] = ' <notes projection> ';
    return cells.join('|');
  }).join('\n');
  const digest = (path) => {
    if (path === 'BACKLOG.md') return sha256(legacyBacklog(show(path)));
    if (path === `${root}/ACCEPTANCE.md`) return sha256(show(path).split(/^## 本地验收结果\s*$/m)[0].trimEnd());
    return entries.get(path).oid;
  };
  const scope = Object.fromEntries(['id', 'workflowVersion', 'workflowEpoch', 'version', 'uxImpact', 'deliveryProfile', 'services', 'migrationRequired']
    .map((key) => [key, key === 'workflowEpoch' ? (requirement.workflowEpoch ?? 0) : requirement[key]]));
  const stableJson = (value) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
  return sha256(stableJson({ stage: 'implementation', scope, input: paths.map((path) => [path, entries.get(path).mode, digest(path)]) }));
}

test('a legacy-fingerprint review stays current when only the canonical algorithm changed (I-247)', async (t) => {
  const s = setup(t);
  const ownRow = '| I-002 | Task | 否 | 🔨 In Dev | v0.9.1 | pending |';
  // subjectCommit 的 BACKLOG 同场包含其他需求（I-252）的行：旧算法把它计入
  // 指纹，这正是 I-247 事故里 legacy 事实的形态。
  writeFileSync(join(s.cwd, 'BACKLOG.md'), `${ownRow}\n| I-252 | Peer work | 否 | 🧪 Testing | v0.31.2 | notes from origin/main |\n`);
  commit(s.cwd);
  const subjectCommit = runGit(s.cwd, ['rev-parse', 'HEAD']);
  const legacyFingerprint = legacyImplementationFingerprint(s.cwd, s.requirement);
  assert.match(legacyFingerprint, /^[0-9a-f]{64}$/);
  const report = { schemaVersion: 1, requirementId: s.requirement.id, stage: s.args.stage,
    subjectFingerprint: legacyFingerprint, verdict: 'pass', feedbackIds: ['FB-001'], findings: [] };
  const stableJson = (value) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
  const fact = { schemaVersion: 1, requirementId: s.requirement.id, stage: s.args.stage, workflowEpoch: 0,
    version: s.requirement.version, round: 1, reviewId: `${s.requirement.id}:${s.args.stage}:0:1`,
    actor: { sessionId: s.args.session.sessionId }, recordedAt: '2026-10-31T00:00:00.000Z',
    subjectCommit, subjectFingerprint: legacyFingerprint,
    reportHash: createHash('sha256').update(stableJson(report)).digest('hex'), report };
  s.snapshot.writeJson(`reviews/${s.requirement.id}/${s.args.stage}/epoch-0/round-1.json`, fact);
  // HEAD 再合并进另一条其他需求的行（I-247 事故形态）：新算法下主体未变，
  // 迁移容差应把该 legacy 事实判为仍然有效。
  writeFileSync(join(s.cwd, 'BACKLOG.md'), `${ownRow}\n| I-252 | Peer work | 否 | 🧪 Testing | v0.31.2 | notes from origin/main |\n| I-254 | Another peer | 是 | ⚪ Todo | v0.31.3 | merged row |\n`);
  commit(s.cwd);
  // 指纹确实不匹配（legacy 把 I-252 行计入、新算法丢弃），ok:true 只能来自
  // 迁移容差而不是恰好相等。
  const preparedNow = protocol.prepareReview({ cwd: s.cwd, snapshot: s.snapshot, requirement: s.requirement, stage: s.args.stage });
  assert.notEqual(legacyFingerprint, preparedNow.subjectFingerprint);
  const readiness = protocol.evaluateReviewReadiness({ ...s, stage: s.args.stage });
  assert.equal(readiness.ok, true, JSON.stringify(readiness.missing));
  // 本需求自身行（标题列不投影）变化仍是主体变化：不容差，保持 REVIEW_STALE。
  writeFileSync(join(s.cwd, 'BACKLOG.md'), `${ownRow.replace('| Task |', '| Retitled task |')}\n| I-252 | Peer work | 否 | 🧪 Testing | v0.31.2 | notes from origin/main |\n| I-254 | Another peer | 是 | ⚪ Todo | v0.31.3 | merged row |\n`);
  commit(s.cwd);
  const drifted = protocol.evaluateReviewReadiness({ ...s, stage: s.args.stage });
  assert.equal(drifted.ok, false);
  assert.equal(drifted.missing.some((item) => item.code === 'REVIEW_STALE'), true);
});

// ============================================================================
// I-259（2026-11-02）：评审 pass 后 subject 输入漂移须有定向重核验出口。
// 旧规则 verify 只认 needs-fix，pass 后任何 subject 变化都永久卡死阶段门禁
// （I-256 形态：round2 pass → 两笔文档修正 → REVIEW_STALE 无解）。pass 轮
// 现在允许一次重核验（reaffirmation）；范围锚点经 I-261 修正为「pass 后
// 自有提交」，见下方 I-261 分节说明。
// ============================================================================

// pass 重核验报告：沿用 verify schema，pass 无 findings，closed/remaining 空。
function reaffirmReport(s, reviewId, extra = {}) {
  return { schemaVersion: 1, requirementId: s.requirement.id, stage: s.args.stage,
    subjectFingerprint: protocol.prepareReview({ cwd: s.cwd, snapshot: s.snapshot, requirement: s.requirement, stage: s.args.stage }).subjectFingerprint,
    reviewId, closedFindingIds: [], remainingFindingIds: [], feedbackIds: ['FB-001'], ...extra };
}
// 对齐 origin/main 与 setup 提交：分支本地 diff 只含本测试的后续提交。
function alignOriginMain(s) { runGit(s.cwd, ['push', 'origin', 'main']); }

test('a pass round may be reaffirmed once after in-subject doc drift (I-256 shape, I-259)', async (t) => {
  const s = setup(t);
  s.args.stage = 'design';
  alignOriginMain(s);
  const designFinding = { id: 'D-001', priority: 'P1', message: 'Design must cover the save contract.', paths: [`${doc}/TECH_DESIGN.md`] };
  await protocol.recordReview({ ...s.args, report: s.report([designFinding]) });
  writeFileSync(join(s.cwd, doc, 'TECH_DESIGN.md'), '# Saved task\n\n## Save contract\nPersists the value.\n'); commit(s.cwd);
  const pass = await protocol.recordReview({ ...s.args, report: { ...s.report(), closedFindingIds: ['D-001'] } });
  assert.equal(pass.round, 2);
  assert.equal(pass.report.verdict, 'pass');
  // pass 后 subject 内文档修正：指纹漂移，readiness 判 REVIEW_STALE。
  writeFileSync(join(s.cwd, doc, 'REQUIREMENT.md'), '# Saved task\n\nClarified wording from the external report.\n'); commit(s.cwd);
  const stale = protocol.evaluateReviewReadiness({ ...s, stage: 'design' });
  assert.equal(stale.ok, false);
  assert.equal(stale.missing.some((item) => item.code === 'REVIEW_STALE'), true);
  // pass 无 findings：不能借重核验伪造关闭任何发现。
  await assert.rejects(protocol.verifyReview({ ...s.args, report: reaffirmReport(s, pass.reviewId, { closedFindingIds: ['D-001'] }) }), { code: 'REVIEW_FINDING_OMITTED' });
  await protocol.verifyReview({ ...s.args, report: reaffirmReport(s, pass.reviewId) });
  const readiness = protocol.evaluateReviewReadiness({ ...s, stage: 'design' });
  assert.equal(readiness.ok, true, JSON.stringify(readiness.missing));
  assert.equal(readiness.verification.reviewId, pass.reviewId);
  // 每轮仅一次定向核验，pass 轮同样不可重试。
  await assert.rejects(protocol.verifyReview({ ...s.args, report: reaffirmReport(s, pass.reviewId) }), { code: 'REVIEW_VERIFICATION_EXISTS' });
});

test('pass reaffirmation rejects branch-local changes outside the stage subject (I-259)', async (t) => {
  const s = setup(t);
  s.args.stage = 'design';
  alignOriginMain(s);
  const pass = await protocol.recordReview({ ...s.args, report: s.report() });
  mkdirSync(join(s.cwd, 'apps/web'), { recursive: true });
  writeFileSync(join(s.cwd, 'apps/web/page.tsx'), 'export const Page = () => null;\n');
  mkdirSync(join(s.cwd, 'docs/releases/PENDING'), { recursive: true });
  // 其他需求的迁移草稿同样不在本需求 allowed 集内。
  writeFileSync(join(s.cwd, 'docs/releases/PENDING/MIGRATION-I-252.md'), '# Peer migration draft\n');
  commit(s.cwd);
  await assert.rejects(protocol.verifyReview({ ...s.args, report: reaffirmReport(s, pass.reviewId) }), (error) => {
    assert.equal(error.code, 'REVIEW_REPAIR_SCOPE_EXCEEDED');
    assert.deepEqual(error.data.paths.sort(), ['apps/web/page.tsx', 'docs/releases/PENDING/MIGRATION-I-252.md']);
    return true;
  });
});

test('pass reaffirmation endorses the own-requirement migration draft outside the doc root (I-259)', async (t) => {
  const s = setup(t);
  s.args.stage = 'design';
  alignOriginMain(s);
  const pass = await protocol.recordReview({ ...s.args, report: s.report() });
  mkdirSync(join(s.cwd, 'docs/releases/PENDING'), { recursive: true });
  writeFileSync(join(s.cwd, 'docs/releases/PENDING/MIGRATION-I-002.md'), '# Migration design draft\n'); commit(s.cwd);
  await protocol.verifyReview({ ...s.args, report: reaffirmReport(s, pass.reviewId) });
  assert.equal(protocol.evaluateReviewReadiness({ ...s, stage: 'design' }).ok, true);
});

test('pass reaffirmation new P1 findings keep the stage blocked (I-259)', async (t) => {
  const s = setup(t);
  s.args.stage = 'design';
  alignOriginMain(s);
  const pass = await protocol.recordReview({ ...s.args, report: s.report() });
  writeFileSync(join(s.cwd, doc, 'REQUIREMENT.md'), '# Saved task\n\nClarified wording.\n'); commit(s.cwd);
  const newlyFound = { id: 'D-010', priority: 'P1', message: 'The clarified wording drops the acceptance anchor.', paths: [`${doc}/REQUIREMENT.md`] };
  await protocol.verifyReview({ ...s.args, report: reaffirmReport(s, pass.reviewId, { newFindings: [newlyFound] }) });
  const readiness = protocol.evaluateReviewReadiness({ ...s, stage: 'design' });
  assert.equal(readiness.ok, false);
  assert.equal(readiness.missing.some((item) => item.code === 'REVIEW_BLOCKERS_OPEN'), true);
});

test('merging origin/main traffic before pass reaffirmation stays in scope for branch-local fixes (I-259)', async (t) => {
  const s = setup(t);
  s.args.stage = 'design';
  alignOriginMain(s);
  const pass = await protocol.recordReview({ ...s.args, report: s.report() });
  // 公共列车：其他需求经 origin/main 合入（I-259 引擎修复本身也经此路径到达
  // 首个使用方），合入文件由各自需求的门禁覆盖，不参与本重核验范围检查。
  runGit(s.peer, ['fetch', 'origin', 'main']);
  runGit(s.peer, ['rebase', 'origin/main']);
  writeFileSync(join(s.peer, 'README.md'), '# coordination fixture + train update\n');
  runGit(s.peer, ['add', 'README.md']);
  runGit(s.peer, ['commit', '-m', 'test: train update']);
  runGit(s.peer, ['push', 'origin', 'main']);
  runGit(s.cwd, ['fetch', 'origin', 'main']);
  runGit(s.cwd, ['merge', 'origin/main', '-m', 'test: merge train']);
  // 分支本地仍只有 subject 内文档修正 → 重核验成功。
  writeFileSync(join(s.cwd, doc, 'TECH_DESIGN.md'), '# Saved task\n\nPost-pass doc correction.\n'); commit(s.cwd);
  await protocol.verifyReview({ ...s.args, report: reaffirmReport(s, pass.reviewId) });
  assert.equal(protocol.evaluateReviewReadiness({ ...s, stage: 'design' }).ok, true);
});

test('pass reaffirmation without origin/main still endorses strictly in-subject fixes (I-259)', async (t) => {
  const s = setup(t);
  s.args.stage = 'design';
  alignOriginMain(s);
  const pass = await protocol.recordReview({ ...s.args, report: s.report() });
  writeFileSync(join(s.cwd, doc, 'TECH_DESIGN.md'), '# Saved task\n\nPost-pass doc correction.\n'); commit(s.cwd);
  runGit(s.cwd, ['update-ref', '-d', 'refs/remotes/origin/main']);
  // merge-base 不可用 → 原严格口径（全量 diff）；纯 subject 内修正仍可背书。
  await protocol.verifyReview({ ...s.args, report: reaffirmReport(s, pass.reviewId) });
  assert.equal(protocol.evaluateReviewReadiness({ ...s, stage: 'design' }).ok, true);
});

test('pass reaffirmation falls back to the full diff scope and rejects train content when origin/main is unavailable (I-259)', async (t) => {
  const s = setup(t);
  s.args.stage = 'design';
  alignOriginMain(s);
  const pass = await protocol.recordReview({ ...s.args, report: s.report() });
  runGit(s.peer, ['fetch', 'origin', 'main']);
  runGit(s.peer, ['rebase', 'origin/main']);
  writeFileSync(join(s.peer, 'README.md'), '# coordination fixture + train update\n');
  runGit(s.peer, ['add', 'README.md']);
  runGit(s.peer, ['commit', '-m', 'test: train update']);
  runGit(s.peer, ['push', 'origin', 'main']);
  runGit(s.cwd, ['fetch', 'origin', 'main']);
  runGit(s.cwd, ['merge', 'origin/main', '-m', 'test: merge train']);
  writeFileSync(join(s.cwd, doc, 'TECH_DESIGN.md'), '# Saved task\n\nPost-pass doc correction.\n'); commit(s.cwd);
  runGit(s.cwd, ['update-ref', '-d', 'refs/remotes/origin/main']);
  await assert.rejects(protocol.verifyReview({ ...s.args, report: reaffirmReport(s, pass.reviewId) }), (error) => {
    assert.equal(error.code, 'REVIEW_REPAIR_SCOPE_EXCEEDED');
    assert.equal(error.data.paths.includes('README.md'), true);
    assert.match(error.message, /origin\/main unavailable; fell back to the full diff since the reviewed commit/);
    return true;
  });
});

// ============================================================================
// I-261（2026-11-02）：pass 重核验范围锚点从 merge-base(HEAD, origin/main)
// 改为「pass 后自有提交」。I-259 的锚点在分支合入 main 后等于 main tip，
// diff 覆盖分支全部自有内容，pass 之前各阶段合法产出但不在本阶段 subject
// 内的文件（manifest、共享规范、验收 runner）被误判超范围（I-256 首用实测）。
// ============================================================================

test('pass reaffirmation scope anchors at own post-pass commits, not pre-pass branch artifacts (I-261)', async (t) => {
  const s = setup(t);
  s.args.stage = 'design';
  // pass 前的各阶段合法产物：不在 design subject 内，但属 pass 前已由各自
  // 门禁覆盖的分支内容——重核验不应被它们误伤。
  mkdirSync(join(s.cwd, 'deploy/release-manifests'), { recursive: true });
  writeFileSync(join(s.cwd, 'deploy/release-manifests/v0.001.env'), 'API_IMAGE=x\n');
  mkdirSync(join(s.cwd, 'docs/design'), { recursive: true });
  writeFileSync(join(s.cwd, 'docs/design/ADMIN_UI_SPEC.md'), '# shared spec\n');
  mkdirSync(join(s.cwd, 'scripts'), { recursive: true });
  writeFileSync(join(s.cwd, 'scripts/run-fake-regressions.sh'), '#!/bin/sh\nexit 0\n');
  commit(s.cwd);
  alignOriginMain(s);
  const pass = await protocol.recordReview({ ...s.args, report: s.report() });
  // 公共列车：其他需求经 origin/main 合入，不参与范围检查（I-259 已覆盖，
  // 此处与 pass 前产物叠加构成 I-256 实测形态）。
  runGit(s.peer, ['fetch', 'origin', 'main']);
  runGit(s.peer, ['rebase', 'origin/main']);
  writeFileSync(join(s.peer, 'README.md'), '# coordination fixture + train update\n');
  runGit(s.peer, ['add', 'README.md']);
  runGit(s.peer, ['commit', '-m', 'test: train update']);
  runGit(s.peer, ['push', 'origin', 'main']);
  runGit(s.cwd, ['fetch', 'origin', 'main']);
  runGit(s.cwd, ['merge', 'origin/main', '-m', 'test: merge train']);
  // pass 后仅 subject 内文档修正 → 重核验成功，readiness 恢复。
  writeFileSync(join(s.cwd, doc, 'TECH_DESIGN.md'), '# Saved task\n\nPost-pass doc correction.\n'); commit(s.cwd);
  await protocol.verifyReview({ ...s.args, report: reaffirmReport(s, pass.reviewId) });
  assert.equal(protocol.evaluateReviewReadiness({ ...s, stage: 'design' }).ok, true);
});

test('pass reaffirmation still rejects own post-pass commits outside the stage subject (I-261)', async (t) => {
  const s = setup(t);
  s.args.stage = 'design';
  alignOriginMain(s);
  const pass = await protocol.recordReview({ ...s.args, report: s.report() });
  // pass 后的自有提交触碰 subject 外文件：仍被拒绝（修正只豁免 pass 前内容）。
  mkdirSync(join(s.cwd, 'deploy/release-manifests'), { recursive: true });
  writeFileSync(join(s.cwd, 'deploy/release-manifests/v0.002.env'), 'API_IMAGE=x\n');
  writeFileSync(join(s.cwd, doc, 'TECH_DESIGN.md'), '# Saved task\n\nPost-pass doc correction.\n');
  commit(s.cwd);
  await assert.rejects(protocol.verifyReview({ ...s.args, report: reaffirmReport(s, pass.reviewId) }), (error) => {
    assert.equal(error.code, 'REVIEW_REPAIR_SCOPE_EXCEEDED');
    assert.deepEqual(error.data.paths, ['deploy/release-manifests/v0.002.env']);
    return true;
  });
});
