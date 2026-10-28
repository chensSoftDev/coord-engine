import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { GitCoordinationStore } from '../../lib/coordination/git-store.mjs';
import { claimRequirement, bindRequirementVersion } from '../../lib/coordination/requirements.mjs';
import { initializeSession } from '../../lib/coordination/worktrees.mjs';
import { recordUxApproval, revokeUxApproval, evaluateUxReadiness } from '../../lib/coordination/ux-approvals.mjs';
import { evaluateTransitionPrecheck } from '../../lib/coordination/lifecycle.mjs';
import { createGitFixture, runGit } from './fixtures.mjs';
import { createMemoryIo } from './fixtures.mjs';
import { main } from '../../lib/coordination/cli.mjs';

async function setup(t, { confirmed = true } = {}) {
  const fixture = createGitFixture(t);
  const clock = () => new Date('2026-10-15T00:00:00.000Z');
  const store = new GitCoordinationStore({ cwd: fixture.clientA, remote: 'origin', branch: 'coordination', tempRoot: fixture.tempRoot, clock });
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const claim = await claimRequirement({ store, type: 'I', title: 'Task UX', profile: 'runtime', uxImpact: 'admin-ui', backlogText: '| I-001 | fixture |\n' });
  await bindRequirementVersion({ store, id: claim.id, version: 'v0.9.1' });
  if (confirmed) {
    await store.update({
      operation: 'confirm fixture requirement',
      mutate(snapshot) {
        const path = `requirements/${claim.id}.json`;
        const requirement = snapshot.readJson(path);
        snapshot.writeJson(path, { ...requirement, lifecycle: 'req_confirmed',
          lifecycleHistory: [...(requirement.lifecycleHistory ?? []), { type: 'advance', from: 'reviewing', to: 'req_confirmed', at: clock().toISOString() }] });
      },
    });
  }
  const dir = join(fixture.clientA, `docs/product/current/${claim.id}-task`);
  const scene = join(fixture.clientA, `apps/ux-prototype/src/scenarios/${claim.id}`);
  mkdirSync(dir, { recursive: true });
  mkdirSync(scene, { recursive: true });
  mkdirSync(join(fixture.clientA, 'apps/ux-prototype/src/shell'), { recursive: true });
  writeFileSync(join(dir, 'UX_SPEC.md'), [
    '岗位与证据', '关键任务', '操作流程', '页面与信息层级',
    '交互与文案', '状态矩阵', '原型与试用任务', '评审决定',
  ].map((name, i) => `## ${i + 1}. ${name}\n\nOperator finishes T01 on S01 and sees result.\n`).join('\n'));
  writeFileSync(join(scene, 'metadata.json'), JSON.stringify({ requirementId: claim.id, role: 'Operator', taskId: 'T01', title: 'Task', screens: [{ id: 'S01', title: 'Entry' }], fixtures: [{ id: 'typical', label: 'Typical' }], entryState: 'typical' }));
  writeFileSync(join(scene, 'manifest.ts'), 'export const task = TaskScreen;\n');
  writeFileSync(join(fixture.clientA, 'apps/ux-prototype/src/scenarios/index.ts'), `import { task } from './${claim.id}/manifest';\nexport const scenarios = [task];\n`);
  writeFileSync(join(scene, 'TaskScreen.tsx'), 'export const TaskScreen = () => <button>Save</button>;\n');
  writeFileSync(join(fixture.clientA, 'apps/ux-prototype/src/shell/Shell.tsx'), 'export const Shell = () => null;\n');
  writeFileSync(join(fixture.clientA, 'apps/ux-prototype/package.json'), '{}\n');
  runGit(fixture.clientA, ['add', '.']);
  runGit(fixture.clientA, ['commit', '-m', 'test: UX artifacts']);
  const session = initializeSession({ cwd: fixture.clientA, agent: 'test', user: 'owner', host: 'host', clock });
  return { fixture, store, id: claim.id, session, clock };
}

test('approval cannot be recorded before requirement confirmation', async (t) => {
  const { fixture, store, id, session, clock } = await setup(t, { confirmed: false });
  await assert.rejects(recordUxApproval({
    store, cwd: fixture.clientA, id, authorizedBy: 'owner',
    instructionRef: 'user-message:20261015-approval', session, clock,
  }), { code: 'UX_APPROVAL_BEFORE_REQ_CONFIRMED' });
});

test('approval binds a user reference, version and committed fingerprint; revoke blocks readiness', async (t) => {
  const { fixture, store, id, session, clock } = await setup(t);
  const before = evaluateUxReadiness({ snapshot: await store.readSnapshot(), cwd: fixture.clientA, requirement: { id, uxImpact: 'admin-ui', version: 'v0.9.1' } });
  assert.deepEqual(before.missing, ['obtain_ux_approval']);
  const transitionBefore = evaluateTransitionPrecheck({
    snapshot: await store.readSnapshot(), cwd: fixture.clientA, id, to: 'tech_design',
    requirement: { id, uxImpact: 'admin-ui', version: 'v0.9.1', lifecycle: 'req_confirmed', deliveryProfile: 'runtime' },
    context: { migrationResolved: true },
  });
  assert.equal(transitionBefore.ok, false);
  assert.equal(transitionBefore.missing.some(({ code }) => code === 'obtain_ux_approval'), true);
  const fact = await recordUxApproval({ store, cwd: fixture.clientA, id, authorizedBy: 'owner', instructionRef: 'user-message:20261015-approval', session, clock });
  assert.equal(fact.version, 'v0.9.1');
  assert.equal(evaluateUxReadiness({ snapshot: await store.readSnapshot(), cwd: fixture.clientA, requirement: { id, uxImpact: 'admin-ui', version: 'v0.9.1' } }).ok, true);
  const transitionAfter = evaluateTransitionPrecheck({
    snapshot: await store.readSnapshot(), cwd: fixture.clientA, id, to: 'tech_design',
    requirement: { id, uxImpact: 'admin-ui', version: 'v0.9.1', lifecycle: 'req_confirmed', deliveryProfile: 'runtime' },
    context: { migrationResolved: true },
  });
  assert.equal(transitionAfter.ok, true);
  await revokeUxApproval({ store, cwd: fixture.clientA, id, reason: 'Needs another review', session, clock });
  assert.deepEqual(evaluateUxReadiness({ snapshot: await store.readSnapshot(), cwd: fixture.clientA, requirement: { id, uxImpact: 'admin-ui', version: 'v0.9.1' } }).missing, ['obtain_ux_approval']);
});

test('CI, weak references and changed UX content cannot create or retain approval', async (t) => {
  const { fixture, store, id, session, clock } = await setup(t);
  const base = { store, cwd: fixture.clientA, id, authorizedBy: 'owner', session, clock };
  await assert.rejects(recordUxApproval({ ...base, instructionRef: 'yes' }), { code: 'INVALID_UX_INSTRUCTION_REF' });
  await assert.rejects(recordUxApproval({ ...base, instructionRef: 'user-message:20261015-approval', env: { CI: 'true' } }), { code: 'UX_APPROVAL_DISALLOWED_IN_CI' });
  await recordUxApproval({ ...base, instructionRef: 'user-message:20261015-approval' });
  assert.deepEqual(evaluateUxReadiness({
    snapshot: await store.readSnapshot(), cwd: fixture.clientA,
    requirement: { id, uxImpact: 'admin-ui', version: 'v0.9.2' },
  }).missing, ['refresh_ux_approval']);
  const shell = join(fixture.clientA, 'apps/ux-prototype/src/shell/Shell.tsx');
  writeFileSync(shell, 'export const Shell = () => <p>new</p>;\n');
  runGit(fixture.clientA, ['add', '.']);
  runGit(fixture.clientA, ['commit', '-m', 'test: change UX']);
  assert.deepEqual(evaluateUxReadiness({ snapshot: await store.readSnapshot(), cwd: fixture.clientA, requirement: { id, uxImpact: 'admin-ui', version: 'v0.9.1' } }).missing, ['refresh_ux_approval']);
});

test('an approval commit outside the current branch cannot authorize Tech Design', async (t) => {
  const { fixture, store, id, session, clock } = await setup(t);
  await recordUxApproval({
    store, cwd: fixture.clientA, id, authorizedBy: 'owner',
    instructionRef: 'user-message:20261015-approval', session, clock,
  });
  await store.update({
    operation: 'test unreachable UX approval commit',
    mutate(snapshot) {
      const path = `ux-approvals/${id}.json`;
      snapshot.writeJson(path, { ...snapshot.readJson(path), approvedCommit: 'a'.repeat(40) });
    },
  });
  assert.deepEqual(evaluateUxReadiness({
    snapshot: await store.readSnapshot(), cwd: fixture.clientA,
    requirement: { id, uxImpact: 'admin-ui', version: 'v0.9.1' },
  }).missing, ['refresh_ux_approval']);
});

test('workflow v2 UX approval binds feedback definitions but allows traceability to grow', async (t) => {
  const { fixture, store, id, session, clock } = await setup(t);
  const cwd = fixture.clientA;
  const dir = join(cwd, `docs/product/current/${id}-task`);
  writeFileSync(join(dir, 'FEEDBACK.json'), JSON.stringify({ schemaVersion: 1, requirementId: id, items: [
    { id: 'FB-001', source: 'user-message:feedback-001', decision: 'accepted', expected: 'Save keeps entered data.' },
  ] }));
  runGit(cwd, ['add', '.']); runGit(cwd, ['commit', '-m', 'test: feedback definitions']);
  await store.update({ operation: 'enable v2 fixture', mutate(snapshot) {
    const path = `requirements/${id}.json`;
    snapshot.writeJson(path, { ...snapshot.readJson(path), workflowVersion: 2, workflowEpoch: 0 });
  } });
  const requirement = { id, workflowVersion: 2, uxImpact: 'admin-ui', version: 'v0.9.1' };
  await recordUxApproval({ store, cwd, id, authorizedBy: 'owner', instructionRef: 'user-message:20261015-approval', session, clock });
  assert.equal(evaluateUxReadiness({ snapshot: await store.readSnapshot(), cwd, requirement }).ok, true);
  writeFileSync(join(dir, 'TRACEABILITY.json'), JSON.stringify({ schemaVersion: 1, requirementId: id, items: [
    { feedbackId: 'FB-001', design: [], implementation: [], verification: [] },
  ] }));
  runGit(cwd, ['add', '.']); runGit(cwd, ['commit', '-m', 'test: add tracing']);
  assert.equal(evaluateUxReadiness({ snapshot: await store.readSnapshot(), cwd, requirement }).ok, true);
  writeFileSync(join(dir, 'FEEDBACK.json'), JSON.stringify({ schemaVersion: 1, requirementId: id, items: [
    { id: 'FB-001', source: 'user-message:feedback-001', decision: 'accepted', expected: 'Save keeps entered data and shows a toast.' },
  ] }));
  runGit(cwd, ['add', '.']); runGit(cwd, ['commit', '-m', 'test: change feedback decision']);
  assert.deepEqual(evaluateUxReadiness({ snapshot: await store.readSnapshot(), cwd, requirement }).missing, ['refresh_ux_approval']);
});

test('ux prepare, approve and show work through the CLI registry', async (t) => {
  const { fixture, id, session } = await setup(t);
  const env = {
    COORD_CWD: fixture.clientA, COORD_REMOTE: 'origin',
    COORD_TEMP_ROOT: fixture.tempRoot, COORD_SESSION_ID: session.sessionId,
  };
  const invoke = async (args) => {
    const memory = createMemoryIo();
    const exit = await main([...args, '--json'], { env, ...memory.io });
    assert.equal(exit, 0, memory.stderr.join(''));
    return JSON.parse(memory.stdout.join('')).data;
  };
  const prepared = await invoke(['ux', 'prepare', id]);
  assert.equal(prepared.scenario.role, 'Operator');
  assert.equal(prepared.command, 'pnpm ux:prototype');
  const approved = await invoke([
    'ux', 'approve', id, '--authorized-by', 'owner',
    '--instruction-ref', 'user-message:20261015-approval',
  ]);
  assert.equal(approved.requirementId, id);
  const shown = await invoke(['ux', 'show', id]);
  assert.equal(shown.readiness.ok, true);
});
