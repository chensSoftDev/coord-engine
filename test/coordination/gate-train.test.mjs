import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { validateRepositoryGate } from '../../lib/coordination/gate.mjs';
import { bindRequirementVersion, claimRequirement, declareRequirementResources } from '../../lib/coordination/requirements.mjs';
import { runGit } from './fixtures.mjs';
import { REQUIREMENT_ID, BRANCH, replaceBacklogRow, TRAIN_MIGRATION_PATH, setupJointTrain, expectEvidenceFailure, expectGateFailure } from './gate-fixtures.mjs';

test('I-272: a partitioned version train passes Ready with per-member declarations', async (t) => {
  const context = await setupJointTrain(t);
  // Without train semantics every member must alone cover the full diff; with
  // partitioned declarations only the union covers it.
  await assert.doesNotReject(validateRepositoryGate({
    cwd: context.fixture.clientA,
    store: context.store,
    event: context.event,
    head: context.head,
    base: 'origin/main',
  }));
});

test('I-272: a post-tested path owned by nobody still trips UNTESTED_CHANGES', async (t) => {
  const context = await setupJointTrain(t);
  const orphan = 'apps/web/app/products/orphan-late-change.tsx';
  writeFileSync(join(context.fixture.clientA, orphan), 'orphan\n');
  runGit(context.fixture.clientA, ['add', orphan]);
  runGit(context.fixture.clientA, ['commit', '-m', 'test: unowned late change']);
  const head = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  context.head = head;
  context.event.pull_request.head.sha = head;
  await expectGateFailure(context, 'UNTESTED_CHANGES');
});

test('I-272: mutually overlapping train declarations no longer deadlock on conflicts', async (t) => {
  const context = await setupJointTrain(t, { overlapDeclarations: true });
  await assert.doesNotReject(validateRepositoryGate({
    cwd: context.fixture.clientA,
    store: context.store,
    event: context.event,
    head: context.head,
    base: 'origin/main',
  }));
});

test('I-272: a same-version requirement outside the PR still conflicts', async (t) => {
  const context = await setupJointTrain(t);
  const { store } = context;
  // I-004 shares the version but has no row/docs in this PR — it is not a
  // detected co-member, so its overlap must still be serialized.
  await declareRequirementResources({
    store: context.store,
    id: REQUIREMENT_ID,
    resources: {
      files: [
        'package.json',
        'deploy/release-manifests/v0.2.32.env',
        'scripts/test-release-gate-fixture.sh',
        TRAIN_MIGRATION_PATH,
      ],
    },
  });
  const claimed = await claimRequirement({
    store,
    type: 'I',
    title: 'Off-train sibling',
    profile: 'runtime',
    backlogText: '| I-001 | fixture |\n',
  });
  await bindRequirementVersion({ store, id: claimed.id, version: 'v0.2.32' });
  await declareRequirementResources({
    store,
    id: claimed.id,
    resources: { files: [TRAIN_MIGRATION_PATH] },
  });
  await expectGateFailure(context, 'RESOURCE_CONFLICT_UNRESOLVED');
});

test('I-272: a no-migration member owning train migration paths still fails (B-248 guard)', async (t) => {
  const context = await setupJointTrain(t);
  // Nobody declares the migration path any more and the 是 owner flips to 否:
  // the B-248 protection must stay fail-closed for the owning member.
  const { store } = context;
  await declareRequirementResources({
    store,
    id: REQUIREMENT_ID,
    resources: {
      files: [
        'package.json',
        'deploy/release-manifests/v0.2.32.env',
        'scripts/test-release-gate-fixture.sh',
      ],
    },
  });
  replaceBacklogRow(context.fixture.clientA, (line) => line.replace('| 是 |', '| 否 |'));
  runGit(context.fixture.clientA, ['add', 'BACKLOG.md']);
  runGit(context.fixture.clientA, ['commit', '-m', 'test: owner flips to no-migration']);
  const head = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  await assert.rejects(
    validateRepositoryGate({
      cwd: context.fixture.clientA,
      store: context.store,
      event: {
        pull_request: {
          head: { ref: BRANCH, sha: head },
          base: { ref: 'main', sha: context.base },
        },
      },
      head,
      base: 'origin/main',
    }),
    (error) => (
      error.code === 'GATE_FAILED'
      && error.data.failures.some((item) => item.code === 'MIGRATION_IMPACT_MISMATCH' && item.requirementId === REQUIREMENT_ID)
    ),
  );
});

test('I-272: a same-version authoritative deployment carrying the tested commit relaxes the fact check', async (t) => {
  const context = await setupJointTrain(t);
  // dev.json equals the rider's evidence snapshot (same-version, same commit).
  // The pass test above already proves the rider passes strictly and the owner
  // passes via the relaxation. Now break the version: strict mismatch returns.
  const { store } = context;
  await store.update({
    operation: 'break dev record version',
    mutate(snapshot) {
      const record = snapshot.readJson('deployments/dev.json');
      snapshot.writeJson('deployments/dev.json', { ...record, version: 'v0.2.31' });
    },
  });
  await expectEvidenceFailure(context, 'DEPLOYMENT_FACT_MISMATCH');
});

test('I-272: a same-version record without the tested commit stays strict', async (t) => {
  const context = await setupJointTrain(t);
  // Point dev.json at a bookkeeping commit parented on the base (same tree,
  // different history) — it does not contain the tested commits, so the
  // relaxation must not apply and the strict fact check fires.
  const baseTree = runGit(context.fixture.clientA, ['rev-parse', `${context.base}^{tree}`]);
  const divergent = runGit(context.fixture.clientA, [
    'commit-tree', baseTree, '-p', context.base, '-m', 'test: divergent record commit',
  ]).trim();
  const { store } = context;
  await store.update({
    operation: 'point dev record at divergent commit',
    mutate(snapshot) {
      const record = snapshot.readJson('deployments/dev.json');
      snapshot.writeJson('deployments/dev.json', { ...record, commit: divergent });
    },
  });
  await expectEvidenceFailure(context, 'DEPLOYMENT_FACT_MISMATCH');
});
