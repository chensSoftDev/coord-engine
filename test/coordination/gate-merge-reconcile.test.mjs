import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { GitCoordinationStore } from '../../lib/coordination/git-store.mjs';
import { main } from '../../lib/coordination/cli.mjs';
import { applyCompletionPatch, bindRequirementVersion, claimRequirement, reconcileMergedRequirements } from '../../lib/coordination/requirements.mjs';
import { createGitFixture, createMemoryIo, runGit } from './fixtures.mjs';
import { REQUIREMENT_ID, setupFeatureGate, mergeFeatureToMain } from './gate-fixtures.mjs';

test('feature merge records mergedCommit and replays a pending tooling completion plan', async (t) => {
  const context = await setupFeatureGate(t);
  const mergedCommit = mergeFeatureToMain(context);

  const first = await reconcileMergedRequirements({
    store: context.store,
    cwd: context.fixture.clientA,
    commit: mergedCommit,
  });
  assert.equal(first.action, 'open-completion-pr');
  assert.equal(first.completions.length, 1);
  assert.equal(first.completions[0].requirementId, REQUIREMENT_ID);
  assert.match(first.completions[0].backlog.before, /✅ Test Passed/);
  assert.match(first.completions[0].backlog.after, /✔️ Done/);
  assert.equal(first.completions[0].evidence.document.mergedCommit, mergedCommit);

  const state = (await context.store.readSnapshot())
    .readJson(`requirements/${REQUIREMENT_ID}.json`);
  assert.equal(state.lifecycle, 'merged');
  assert.equal(state.mergedCommit, mergedCommit);
  assert.equal(state.completion.status, 'pending');

  const shaBeforeReplay = (await context.store.readSnapshot()).sha;
  writeFileSync(join(context.fixture.clientA, 'README.md'), '# unrelated main update\n');
  runGit(context.fixture.clientA, ['add', 'README.md']);
  runGit(context.fixture.clientA, ['commit', '-m', 'docs: unrelated update after merge']);
  const replayCommit = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  const replay = await reconcileMergedRequirements({
    store: context.store,
    cwd: context.fixture.clientA,
    commit: replayCommit,
  });
  assert.equal(replay.action, 'open-completion-pr');
  assert.equal(replay.completions.length, 1);
  assert.equal(replay.completions[0].evidence.document.mergedCommit, mergedCommit);
  assert.equal((await context.store.readSnapshot()).sha, shaBeforeReplay);
});

test('a later main push recovers a skipped feature-merge reconciliation', async (t) => {
  const context = await setupFeatureGate(t);
  const mergedCommit = mergeFeatureToMain(context);
  writeFileSync(join(context.fixture.clientA, 'README.md'), '# later main update\n');
  runGit(context.fixture.clientA, ['add', 'README.md']);
  runGit(context.fixture.clientA, ['commit', '-m', 'docs: wake completion reconciliation']);
  const laterCommit = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);

  const result = await reconcileMergedRequirements({
    store: context.store,
    cwd: context.fixture.clientA,
    commit: laterCommit,
  });
  assert.equal(result.action, 'open-completion-pr');
  assert.equal(result.completions[0].evidence.document.mergedCommit, mergedCommit);
  const state = (await context.store.readSnapshot())
    .readJson(`requirements/${REQUIREMENT_ID}.json`);
  assert.equal(state.lifecycle, 'merged');
  assert.equal(state.mergedCommit, mergedCommit);
});

test('runtime merge records durable merge facts without opening a completion PR', async (t) => {
  const context = await setupFeatureGate(t);
  await context.store.update({
    operation: `make ${REQUIREMENT_ID} runtime`,
    mutate(snapshot) {
      const path = `requirements/${REQUIREMENT_ID}.json`;
      snapshot.writeJson(path, {
        ...snapshot.readJson(path),
        deliveryProfile: 'runtime',
      });
    },
  });
  const mergedCommit = mergeFeatureToMain(context);

  const result = await reconcileMergedRequirements({
    store: context.store,
    cwd: context.fixture.clientA,
    commit: mergedCommit,
  });
  assert.equal(result.action, 'mark-merged');
  assert.equal(result.completions.length, 0);
  const state = (await context.store.readSnapshot())
    .readJson(`requirements/${REQUIREMENT_ID}.json`);
  assert.equal(state.lifecycle, 'test_passed');
  assert.equal(state.mergeStatus, 'merged');
  assert.equal(state.mergedCommit, mergedCommit);
});

// I-243 review：返工后的 testedCommit 首次真正合入 main 时，旧 merge 事实必须
// 被刷新到本次 main commit；已覆盖 testedCommit 的事实保持不动（幂等 replay）。
test('I-243: reconcile refreshes a stale merge fact once main contains the tested commit', async (t) => {
  const fixture = createGitFixture(t);
  const clock = () => new Date('2026-07-17T00:00:00.000Z');
  const store = new GitCoordinationStore({
    cwd: fixture.clientA,
    remote: 'origin',
    branch: 'coordination',
    tempRoot: fixture.tempRoot,
    clock,
  });
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const claimed = await claimRequirement({
    store,
    type: 'I',
    title: 'Stale merge requirement',
    profile: 'runtime',
    backlogText: '| I-001 | fixture |\n',
  });
  await bindRequirementVersion({ store, id: claimed.id, version: 'v0.2.32' });
  const oldMerge = runGit(fixture.clientA, ['rev-parse', 'HEAD']);

  const branch = 'feature/v0.2.32/stale-merge';
  runGit(fixture.clientA, ['switch', '-c', branch]);
  writeFileSync(join(fixture.clientA, 'feature.txt'), 'reworked feature\n');
  runGit(fixture.clientA, ['add', 'feature.txt']);
  runGit(fixture.clientA, ['commit', '-m', 'test: rework after the old merge']);
  const testedCommit = runGit(fixture.clientA, ['rev-parse', 'HEAD']);

  const requirementDir = join(
    fixture.clientA,
    'docs',
    'product',
    'current',
    `${claimed.id}-stale-merge`,
  );
  mkdirSync(requirementDir, { recursive: true });
  writeFileSync(join(requirementDir, 'TEST_EVIDENCE.json'), `${JSON.stringify({
    schemaVersion: 1,
    requirement: { id: claimed.id, version: 'v0.2.32', deliveryProfile: 'runtime' },
    outcome: 'passed',
    testedCommit,
  }, null, 2)}\n`);
  writeFileSync(join(fixture.clientA, 'BACKLOG.md'), [
    '| I-001 | Other requirement | 否 | ⚪ Todo | - | fixture |',
    `| ${claimed.id} | Stale merge requirement | 否 | ✅ Test Passed | v0.2.32 | fixture |`,
    '',
  ].join('\n'));
  runGit(fixture.clientA, ['add', 'docs', 'BACKLOG.md']);
  runGit(fixture.clientA, ['commit', '-m', 'test: record evidence after rework']);

  await store.update({
    operation: `record the pre-rework merge fact for ${claimed.id}`,
    mutate(snapshot) {
      const path = `requirements/${claimed.id}.json`;
      snapshot.writeJson(path, {
        ...snapshot.readJson(path),
        lifecycle: 'test_passed',
        mergeStatus: 'merged',
        mergedCommit: oldMerge,
        mergedAt: '2026-07-16T00:00:00.000Z',
      });
    },
  });

  runGit(fixture.clientA, ['switch', 'main']);
  runGit(fixture.clientA, ['merge', '--ff-only', branch]);
  const mergeCommit = runGit(fixture.clientA, ['rev-parse', 'HEAD']);
  assert.notEqual(mergeCommit, oldMerge);

  const result = await reconcileMergedRequirements({
    store,
    cwd: fixture.clientA,
    commit: mergeCommit,
  });
  const transition = result.transitions.find(({ requirementId, mergeStatus }) => (
    requirementId === claimed.id && mergeStatus === 'refreshed'
  ));
  assert.ok(transition, JSON.stringify(result.transitions));
  assert.equal(transition.previousMergedCommit, oldMerge);
  assert.equal(transition.mergedCommit, mergeCommit);
  assert.equal(transition.testedCommit, testedCommit);

  const state = (await store.readSnapshot()).readJson(`requirements/${claimed.id}.json`);
  assert.equal(state.mergeStatus, 'merged');
  assert.equal(state.mergedCommit, mergeCommit);
  assert.equal(state.mergeHistory.at(-1).testedCommit, testedCommit);
  assert.equal(state.mergeHistory.at(-1).from, oldMerge);

  // Replaying the same main commit is a read-only no-op: the refreshed fact
  // now covers testedCommit, so it must not be rewritten again.
  const shaBefore = (await store.readSnapshot()).sha;
  const replay = await reconcileMergedRequirements({
    store,
    cwd: fixture.clientA,
    commit: mergeCommit,
  });
  assert.equal(replay.action, 'none');
  assert.equal((await store.readSnapshot()).sha, shaBefore);
});

test('reconcile-merged and apply-completion CLI emit stable JSON and exact files', async (t) => {
  const context = await setupFeatureGate(t);
  const mergedCommit = mergeFeatureToMain(context);
  const memory = createMemoryIo();
  const env = {
    ...process.env,
    COORD_CWD: context.fixture.clientA,
    COORD_REMOTE: 'origin',
    COORD_BRANCH: 'coordination',
    COORD_TEMP_ROOT: context.fixture.tempRoot,
  };
  const reconcileExit = await main([
    'requirement', 'reconcile-merged',
    '--commit', mergedCommit,
    '--json',
  ], { env, ...memory.io });
  assert.equal(reconcileExit, 0, memory.stderr.join(''));
  const result = JSON.parse(memory.stdout.join(''));
  assert.equal(result.data.action, 'open-completion-pr');

  const planPath = join(context.fixture.root, 'completion-plan.json');
  writeFileSync(planPath, JSON.stringify(result));
  const applyMemory = createMemoryIo();
  const applyExit = await main([
    'requirement', 'apply-completion',
    '--plan', planPath,
    '--requirement', REQUIREMENT_ID,
    '--json',
  ], { env, ...applyMemory.io });
  assert.equal(applyExit, 0, applyMemory.stderr.join(''));
  assert.deepEqual(
    JSON.parse(applyMemory.stdout.join('')).data.paths,
    ['BACKLOG.md', result.data.completions[0].evidence.path],
  );
  assert.match(readFileSync(join(context.fixture.clientA, 'BACKLOG.md'), 'utf8'), /✔️ Done/);
  assert.equal(existsSync(join(
    context.fixture.clientA,
    result.data.completions[0].evidence.path,
  )), true);
});

test('completion merge marks tooling done and never creates another completion branch', async (t) => {
  const context = await setupFeatureGate(t);
  const mergedCommit = mergeFeatureToMain(context);
  const planned = await reconcileMergedRequirements({
    store: context.store,
    cwd: context.fixture.clientA,
    commit: mergedCommit,
  });
  applyCompletionPatch({
    cwd: context.fixture.clientA,
    plan: planned,
    requirementId: REQUIREMENT_ID,
  });
  runGit(context.fixture.clientA, ['add', 'BACKLOG.md', planned.completions[0].evidence.path]);
  runGit(context.fixture.clientA, [
    'commit', '-m', `chore(repo): complete ${REQUIREMENT_ID} [coord-completion:${REQUIREMENT_ID}]`,
  ]);
  runGit(context.fixture.clientA, ['push', 'origin', 'main']);
  const completionCommit = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  writeFileSync(join(context.fixture.clientA, 'README.md'), '# post-completion update\n');
  runGit(context.fixture.clientA, ['add', 'README.md']);
  runGit(context.fixture.clientA, ['commit', '-m', 'docs: wake completion finalization']);
  const reconcileCommit = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);

  const completed = await reconcileMergedRequirements({
    store: context.store,
    cwd: context.fixture.clientA,
    commit: reconcileCommit,
  });
  assert.equal(completed.action, 'mark-merged');
  assert.equal(completed.transitions[0].to, 'done');
  const state = (await context.store.readSnapshot())
    .readJson(`requirements/${REQUIREMENT_ID}.json`);
  assert.equal(state.lifecycle, 'done');
  assert.equal(state.completion.status, 'done');
  assert.equal(state.completion.completedCommit, completionCommit);

  const replay = await reconcileMergedRequirements({
    store: context.store,
    cwd: context.fixture.clientA,
    commit: reconcileCommit,
  });
  assert.equal(replay.action, 'none');
});

test('B-246: a later main reconciliation repairs Done with a pending completion without duplicate history', async (t) => {
  const context = await setupFeatureGate(t);
  const mergedCommit = mergeFeatureToMain(context);
  const planned = await reconcileMergedRequirements({
    store: context.store,
    cwd: context.fixture.clientA,
    commit: mergedCommit,
  });
  applyCompletionPatch({
    cwd: context.fixture.clientA,
    plan: planned,
    requirementId: REQUIREMENT_ID,
  });
  runGit(context.fixture.clientA, ['add', 'BACKLOG.md', planned.completions[0].evidence.path]);
  runGit(context.fixture.clientA, [
    'commit', '-m', `chore(repo): complete ${REQUIREMENT_ID} [coord-completion:${REQUIREMENT_ID}]`,
  ]);
  runGit(context.fixture.clientA, ['push', 'origin', 'main']);
  const completionCommit = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);

  await context.store.update({
    operation: 'reproduce Done before completion reconciliation',
    mutate(snapshot) {
      const path = `requirements/${REQUIREMENT_ID}.json`;
      const requirement = snapshot.readJson(path);
      snapshot.writeJson(path, {
        ...requirement,
        lifecycle: 'done',
        lifecycleHistory: [
          ...requirement.lifecycleHistory,
          { type: 'advance', from: 'merged', to: 'done', at: '2026-07-17T00:00:00.000Z' },
        ],
      });
    },
  });
  writeFileSync(join(context.fixture.clientA, 'README.md'), '# later main update\n');
  runGit(context.fixture.clientA, ['add', 'README.md']);
  runGit(context.fixture.clientA, ['commit', '-m', 'docs: wake completion repair']);
  const laterCommit = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);

  const repaired = await reconcileMergedRequirements({
    store: context.store,
    cwd: context.fixture.clientA,
    commit: laterCommit,
  });
  const state = (await context.store.readSnapshot())
    .readJson(`requirements/${REQUIREMENT_ID}.json`);
  assert.equal(repaired.changed, true);
  assert.equal(state.lifecycle, 'done');
  assert.equal(state.completion.status, 'done');
  assert.equal(state.completion.completedCommit, completionCommit);
  assert.equal(state.lifecycleHistory.filter((event) => event.to === 'done').length, 1);

  const replay = await reconcileMergedRequirements({
    store: context.store,
    cwd: context.fixture.clientA,
    commit: laterCommit,
  });
  assert.equal(replay.changed, false);
});

test('completion patch rejects plan tampering before writing either file', async (t) => {
  const context = await setupFeatureGate(t);
  const mergedCommit = mergeFeatureToMain(context);
  const planned = await reconcileMergedRequirements({
    store: context.store,
    cwd: context.fixture.clientA,
    commit: mergedCommit,
  });
  const tampered = structuredClone(planned);
  tampered.completions[0].backlog.after += ' injected';
  const backlogBefore = readFileSync(join(context.fixture.clientA, 'BACKLOG.md'), 'utf8');

  assert.throws(() => applyCompletionPatch({
    cwd: context.fixture.clientA,
    plan: tampered,
    requirementId: REQUIREMENT_ID,
  }), (error) => error.code === 'INVALID_COMPLETION_PLAN');
  assert.equal(readFileSync(join(context.fixture.clientA, 'BACKLOG.md'), 'utf8'), backlogBefore);
  assert.equal(existsSync(join(
    context.fixture.clientA,
    planned.completions[0].evidence.path,
  )), false);
});

test('main commit without a requirement is a read-only no-op', async (t) => {
  const fixture = createGitFixture(t);
  const store = new GitCoordinationStore({
    cwd: fixture.clientA,
    remote: 'origin',
    branch: 'coordination',
    tempRoot: fixture.tempRoot,
  });
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  writeFileSync(join(fixture.clientA, 'README.md'), '# unrelated main update\n');
  runGit(fixture.clientA, ['add', 'README.md']);
  runGit(fixture.clientA, ['commit', '-m', 'docs: unrelated update']);
  const commit = runGit(fixture.clientA, ['rev-parse', 'HEAD']);
  const coordinationBefore = (await store.readSnapshot()).sha;

  const result = await reconcileMergedRequirements({
    store,
    cwd: fixture.clientA,
    commit,
  });
  assert.equal(result.action, 'none');
  assert.equal((await store.readSnapshot()).sha, coordinationBefore);
});
