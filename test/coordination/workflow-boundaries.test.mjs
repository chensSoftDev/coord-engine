import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CoordinationSnapshot } from '../../lib/coordination/git-store.mjs';
import { initializeSession } from '../../lib/coordination/worktrees.mjs';
import { evaluateTransitionPrecheck, BACKLOG_STATUSES } from '../../lib/coordination/lifecycle.mjs';
import { reworkLifecycle } from '../../lib/coordination/rework.mjs';
import { prepareReview, recordReview, verifyReview } from '../../lib/coordination/reviews.mjs';
import { runRequiredTests } from '../../lib/coordination/evidence.mjs';
import { validateRepositoryGate } from '../../lib/coordination/gate.mjs';
import { createGitFixture, runGit } from './fixtures.mjs';

const id = 'I-002';
const version = 'v0.9.1';
const branch = 'feature/v0.9.1/workflow-boundaries';
const directory = `docs/product/current/${id}-workflow-boundaries`;
const taskPath = 'scripts/boundary-task.mjs';
const verifyPath = 'scripts/boundary-verify.mjs';
const clock = () => new Date('2026-10-26T03:00:00.000Z');
const reason = 'user acceptance identified a reproducible persisted-value mismatch';
const instructionRef = 'user-message:20261026-boundary-feedback';

function commit(cwd) { runGit(cwd, ['add', '.']); runGit(cwd, ['commit', '--allow-empty', '-m', 'test: workflow boundary subject']); }
function setup(t, { profile = 'tooling' } = {}) {
  const { clientA: cwd } = createGitFixture(t);
  writeFileSync(join(cwd, 'package.json'), '{"private":true,"scripts":{}}\n');
  writeFileSync(join(cwd, 'BACKLOG.md'), '| ID | 需求描述 | 需迁移 | 当前状态 | Version | 备注 |\n|----|----------|--------|----------|---------|------|\n| I-001 | seed | 否 | ✔️ Done | v0.1.0 | fixture |\n');
  commit(cwd); runGit(cwd, ['push', 'origin', 'main']);
  runGit(cwd, ['checkout', '-b', branch]);
  mkdirSync(join(cwd, directory), { recursive: true });
  mkdirSync(join(cwd, 'scripts'), { recursive: true });
  mkdirSync(join(cwd, 'deploy/release-manifests'), { recursive: true });
  writeFileSync(join(cwd, taskPath), 'export const task = { enabled: true, version: 1 };\n');
  writeFileSync(join(cwd, verifyPath), "import assert from 'node:assert/strict';\nimport { task } from './boundary-task.mjs';\nassert.equal(task.enabled, true);\n");
  for (const file of ['REQUIREMENT.md', 'TECH_DESIGN.md', 'IMPLEMENTATION_PLAN.md']) writeFileSync(join(cwd, directory, file), '# Task enabled state persists.\n');
  writeFileSync(join(cwd, directory, 'ACCEPTANCE.md'), `# Boundary acceptance\n\n\`\`\`coord-required\n["node","${verifyPath}"]\n\`\`\`\n\n## 本地验收结果\n`);
  writeFileSync(join(cwd, directory, 'FEEDBACK.json'), JSON.stringify({ schemaVersion: 1, requirementId: id,
    items: [{ id: 'FB-001', source: instructionRef, decision: 'accepted', expected: 'The enabled state is returned by the task.' }] }));
  writeFileSync(join(cwd, directory, 'TRACEABILITY.json'), JSON.stringify({ schemaVersion: 1, requirementId: id,
    items: [{ feedbackId: 'FB-001', design: [`${directory}/TECH_DESIGN.md`], implementation: [taskPath], verification: [verifyPath] }] }));
  writeFileSync(join(cwd, `deploy/release-manifests/${version}.env`), `RELEASE_VERSION=${version}\nRELEASE_REQUIREMENTS=${id}\nRELEASE_DELIVERY_PROFILE=${profile}\nRELEASE_SERVICES=${profile === 'runtime' ? 'api' : 'none'}\n`);
  writeFileSync(join(cwd, 'BACKLOG.md'), `${readFileSync(join(cwd, 'BACKLOG.md'), 'utf8')}| ${id} | Boundary task | 否 | 🔨 In Dev | ${version} | fixture |\n`);
  commit(cwd);
  const requirement = { schemaVersion: 1, id, version, branch, lifecycle: 'in_dev', deliveryProfile: profile,
    uxImpact: 'none', workflowVersion: 2, workflowEpoch: 0, validationEpoch: 0,
    resources: { files: ['BACKLOG.md', 'docs/**', 'scripts/**', `deploy/release-manifests/${version}.env`] }, lifecycleHistory: [] };
  const snapshot = new CoordinationSnapshot({ sha: 'fixture-coordination', files: new Map([[`requirements/${id}.json`, JSON.stringify(requirement)]]) });
  const store = { readSnapshot: async () => snapshot, update: async ({ mutate }) => { await mutate(snapshot); return { sha: 'updated-coordination', operationId: 'workflow-boundary' }; } };
  const session = initializeSession({ cwd, agent: 'workflow-boundary', user: 'owner', host: 'fixture', clock });
  const current = () => snapshot.readJson(`requirements/${id}.json`);
  const review = async (stage, { findings = [], verdict = findings.length ? 'needs-fix' : 'pass' } = {}) => recordReview({ store, cwd, id, stage, session, clock,
    report: { schemaVersion: 1, requirementId: id, stage, subjectFingerprint: prepareReview({ snapshot, cwd, requirement: current(), stage }).subjectFingerprint,
      verdict, findings, feedbackIds: ['FB-001'] } });
  const setLifecycle = (lifecycle) => {
    snapshot.writeJson(`requirements/${id}.json`, { ...current(), lifecycle,
      lifecycleHistory: [...current().lifecycleHistory, { type: 'advance', from: current().lifecycle, to: lifecycle, at: clock().toISOString() }] });
    writeFileSync(join(cwd, 'BACKLOG.md'), readFileSync(join(cwd, 'BACKLOG.md'), 'utf8').split('\n').map((line) => {
      if (!line.startsWith(`| ${id} |`)) return line;
      const cells = line.split('|'); cells[4] = ` ${BACKLOG_STATUSES[lifecycle]} `; return cells.join('|');
    }).join('\n'));
    commit(cwd);
  };
  return { cwd, snapshot, store, session, current, review, setLifecycle };
}
const finding = { id: 'R-001', priority: 'P1', message: 'The persisted value is not reliably returned.', paths: [taskPath] };

for (const profile of ['tooling', 'runtime']) test(`${profile}: leaving In Dev requires a current implementation review alongside existing prerequisites`, async (t) => {
  const s = setup(t, { profile });
  const to = profile === 'runtime' ? 'dev_deployed' : 'testing';
  const precheck = ({ hasManifest = true } = {}) => {
    const currentCommit = runGit(s.cwd, ['rev-parse', 'HEAD']);
    const lease = { version, requirementId: id, branch, sessionId: s.session.sessionId, ownerToken: 'fixture-token', commit: currentCommit, expiresAt: '2026-10-26T04:00:00.000Z' };
    if (profile === 'runtime') {
      s.snapshot.writeJson('locks/dev.json', { active: lease });
      s.snapshot.writeJson('deployments/dev.json', { requirementId: id, version, commit: currentCommit, services: ['api'] });
    }
    return evaluateTransitionPrecheck({ snapshot: s.snapshot, cwd: s.cwd, id, to, requirement: s.current(), clock,
      context: { currentCommit, migrationResolved: true, hasManifest, assertedDevLease: lease } });
  };
  assert.deepEqual(precheck().missing.map(({ code }) => code), ['REVIEW_MISSING']);
  await s.review('implementation');
  assert.equal(precheck().ok, true);
  assert.deepEqual(precheck({ hasManifest: false }).missing.map(({ code }) => code), ['create_manifest']);
  writeFileSync(join(s.cwd, taskPath), 'export const task = { enabled: true, version: 2 };\n'); commit(s.cwd);
  assert.deepEqual(precheck().missing.map(({ code }) => code), ['REVIEW_STALE']);
  await s.review('implementation');
  assert.equal(precheck().ok, true);
});

test('frontend runtime cannot leave Testing for Test Passed on machine evidence alone', async t => {
  const s = setup(t, { profile: 'runtime' });
  s.setLifecycle('testing');
  s.snapshot.writeJson(`requirements/${id}.json`, { ...s.current(), resources: { ...s.current().resources, services: ['admin'] } });
  await s.review('verification');
  const currentCommit = runGit(s.cwd, ['rev-parse', 'HEAD']);
  const lease = { version, branch, sessionId: s.session.sessionId, ownerToken: 'fixture-token', commit: currentCommit, expiresAt: '2026-10-26T04:00:00.000Z' };
  const deployment = { requirementId: id, version, commit: currentCommit, services: ['api'] };
  s.snapshot.writeJson('locks/dev.json', { active: lease });
  s.snapshot.writeJson('deployments/dev.json', deployment);
  const result = evaluateTransitionPrecheck({ snapshot: s.snapshot, cwd: s.cwd, id, to: 'test_passed', requirement: s.current(), clock,
    context: { currentCommit, testedCommit: currentCommit, testEvidence: { outcome: 'passed', environment: { devLease: lease, devSnapshot: deployment } },
      assertedDevLease: lease, migrationResolved: true, hasManifest: true } });
  assert.equal(result.ok, false);
  assert.ok(result.missing.some(item => item.code === 'HUMAN_ACCEPTANCE_REQUIRED'));
});

test('a downstream correction after a completed implementation review opens an explicit new review epoch', async (t) => {
  const s = setup(t);
  await s.review('implementation'); await s.review('implementation');
  s.setLifecycle('test_passed');
  await reworkLifecycle({ store: s.store, cwd: s.cwd, id, kind: 'correction', reason, instructionRef, actor: 'owner', clock });
  assert.equal(s.current().lifecycle, 'in_dev');
  assert.equal(s.current().workflowEpoch, 1);
  assert.equal(s.current().validationEpoch, 1);
  assert.equal(s.snapshot.has(`reviews/${id}/implementation/epoch-0/round-2.json`), true);
  commit(s.cwd);
  const next = await s.review('implementation');
  assert.equal(next.workflowEpoch, 1); assert.equal(next.round, 1);
});

for (const scenario of [{ lifecycle: 'in_dev', verdict: 'pass' }, { lifecycle: 'testing', verdict: 'needs-fix' }]) {
  test(`correction ${scenario.lifecycle}/${scenario.verdict} cannot reset an exhausted review budget`, async (t) => {
    const s = setup(t);
    const report = scenario.verdict === 'needs-fix' ? { findings: [finding] } : {};
    await s.review('implementation', report); await s.review('implementation', report);
    if (scenario.lifecycle !== 'in_dev') s.setLifecycle(scenario.lifecycle);
    await reworkLifecycle({ store: s.store, cwd: s.cwd, id, kind: 'correction', reason, instructionRef, actor: 'owner', clock });
    assert.equal(s.current().workflowEpoch, 0);
    assert.equal(s.current().validationEpoch, 1);
    commit(s.cwd);
    await assert.rejects(s.review('implementation', report), { code: 'REVIEW_ROUND_LIMIT' });
  });
}

test('a new blocker found during targeted verification cannot reset the review budget by correction', async (t) => {
  const s = setup(t);
  const first = await s.review('implementation', { findings: [finding] });
  await verifyReview({ store: s.store, cwd: s.cwd, id, stage: 'implementation', session: s.session, clock,
    report: { schemaVersion: 1, requirementId: id, stage: 'implementation', reviewId: first.reviewId,
      subjectFingerprint: prepareReview({ snapshot: s.snapshot, cwd: s.cwd, requirement: s.current(), stage: 'implementation' }).subjectFingerprint,
      closedFindingIds: ['R-001'], remainingFindingIds: [], feedbackIds: ['FB-001'],
      newFindings: [{ id: 'R-002', priority: 'P1', message: 'The verification script misses the failure branch.', paths: [verifyPath] }] } });
  s.setLifecycle('testing');
  await reworkLifecycle({ store: s.store, cwd: s.cwd, id, kind: 'correction', reason, instructionRef, actor: 'owner', clock });
  assert.equal(s.current().workflowEpoch, 0);
});

test('Ready rejects missing or stale verification review even when actual tests and all other feature gates pass', async (t) => {
  const s = setup(t); s.setLifecycle('testing');
  const testAndClose = async () => {
    await runRequiredTests({ cwd: s.cwd, id, requirement: s.current(), clock });
    if (s.current().lifecycle !== 'test_passed') s.setLifecycle('test_passed'); else commit(s.cwd);
  };
  const gate = () => {
    const head = runGit(s.cwd, ['rev-parse', 'HEAD']); const base = runGit(s.cwd, ['rev-parse', 'origin/main']);
    return validateRepositoryGate({ cwd: s.cwd, store: s.store, head, base,
      event: { pull_request: { head: { ref: branch, sha: head }, base: { ref: 'main', sha: base } } } });
  };
  const onlyFailure = (expected) => (error) => {
    assert.equal(error.code, 'GATE_FAILED');
    assert.deepEqual(error.data.failures.map(({ code }) => code), [expected]); return true;
  };
  await testAndClose();
  await assert.rejects(gate(), onlyFailure('REVIEW_MISSING'));
  await s.review('verification');
  assert.equal((await gate()).valid, true);
  writeFileSync(join(s.cwd, taskPath), 'export const task = { enabled: true, version: 2 };\n'); commit(s.cwd);
  await testAndClose();
  await assert.rejects(gate(), onlyFailure('REVIEW_STALE'));
  await s.review('verification');
  assert.equal((await gate()).valid, true);
});
