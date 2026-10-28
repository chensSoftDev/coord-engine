import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { GitCoordinationStore } from '../../lib/coordination/git-store.mjs';
import { main } from '../../lib/coordination/cli.mjs';
import {
  advanceLifecycle,
  advanceLifecycleBatch,
  evaluateTransitionPrecheck,
  failLifecycle,
  failTransition,
  lifecycleContextFromRepository,
  reconcileLifecycle,
  successorState,
  transition,
} from '../../lib/coordination/lifecycle.mjs';
import {
  bindRequirementVersion,
  claimRequirement,
  importExistingRequirement,
  startRequirement,
} from '../../lib/coordination/requirements.mjs';
import { createGitFixture, createMemoryIo, runGit } from './fixtures.mjs';

const CURRENT_COMMIT = '1111111111111111111111111111111111111111';
const EVIDENCE_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const DEV_LEASE = {
  requirementId: 'I-002',
  holder: { kind: 'requirement', id: 'I-002' },
  version: 'v0.2.32',
  sessionId: '00000000-0000-4000-8000-000000000002',
  branch: 'feature/v0.2.32/lifecycle',
  commit: CURRENT_COMMIT,
  expiresAt: '2026-07-17T01:00:00.000Z',
};
const DEV_SNAPSHOT = { commit: CURRENT_COMMIT, version: 'v0.2.32' };
const READY = {
  hasVersion: true,
  version: 'v0.2.32',
  hasManifest: true,
  migrationResolved: true,
  requiresMigration: true,
  hasMigrationDraft: true,
  hasDevLease: true,
  devLease: DEV_LEASE,
  devSnapshot: DEV_SNAPSHOT,
  hasProdLease: true,
  prodSnapshot: { commit: CURRENT_COMMIT, version: 'v0.2.32' },
  testEvidence: {
    outcome: 'passed',
    environment: { devLease: DEV_LEASE, devSnapshot: DEV_SNAPSHOT },
  },
  testedCommit: CURRENT_COMMIT,
  currentCommit: CURRENT_COMMIT,
  mergeStatus: 'merged',
  mergedCommit: CURRENT_COMMIT,
  completionFactPresent: true,
};

test('all profiles retain the review, confirmation, design, and development stages', () => {
  const path = ['todo', 'reviewing', 'req_confirmed', 'tech_design', 'in_dev'];
  for (const profile of ['runtime', 'tooling', 'governance']) {
    for (let index = 1; index < path.length; index += 1) {
      const result = transition({
        profile,
        from: path[index - 1],
        to: path[index],
        context: READY,
      });
      assert.equal(result.allowed, true, `${profile}: ${path[index - 1]} -> ${path[index]}`);
    }
  }
});

test('reviewing cannot advance while migration assessment is unresolved', () => {
  const result = transition({
    profile: 'tooling',
    from: 'reviewing',
    to: 'req_confirmed',
    context: { ...READY, migrationResolved: false },
  });

  assert.equal(result.allowed, false);
  assert.deepEqual(result.requiredActions, ['resolve_migration']);
  assert.deepEqual(result.failures, [{
    code: 'resolve_migration',
    message: 'resolve BACKLOG migration to 是 or 否',
  }]);
});

test('migration assessment fails closed when repository context omits resolution', () => {
  const result = transition({
    profile: 'tooling',
    from: 'reviewing',
    to: 'req_confirmed',
    context: { hasVersion: true },
  });

  assert.equal(result.allowed, false);
  assert.deepEqual(result.requiredActions, ['resolve_migration']);
});

test('runtime profile follows the complete deploy, test, and production path', () => {
  const path = [
    'in_dev',
    'dev_deployed',
    'testing',
    'test_passed',
    'prod_planning',
    'prod_deployed',
    'done',
  ];
  for (let index = 1; index < path.length; index += 1) {
    const result = transition({
      profile: 'runtime',
      from: path[index - 1],
      to: path[index],
      context: READY,
    });
    assert.equal(result.allowed, true);
    assert.equal(result.nextState, path[index]);
    assert.deepEqual(result.requiredActions, []);
  }
});

test('tooling and governance retain Testing but skip runtime deployments', () => {
  const path = ['in_dev', 'testing', 'test_passed', 'merged', 'done'];
  for (const profile of ['tooling', 'governance']) {
    for (let index = 1; index < path.length; index += 1) {
      const result = transition({
        profile,
        from: path[index - 1],
        to: path[index],
        context: READY,
      });
      assert.equal(result.allowed, true, `${profile}: ${path[index - 1]} -> ${path[index]}`);
      assert.equal(result.nextState, path[index]);
    }
  }
});

test('every profile rejects skipping directly from in_dev to test_passed', () => {
  for (const profile of ['runtime', 'tooling', 'governance']) {
    assert.throws(
      () => transition({ profile, from: 'in_dev', to: 'test_passed', context: READY }),
      (error) => error.code === 'INVALID_TRANSITION' && error.exitCode === 12,
    );
  }
});

test('gate predicates return structured actions without advancing state', () => {
  const result = transition({
    profile: 'runtime',
    from: 'dev_deployed',
    to: 'testing',
    context: {
      hasVersion: true,
      hasManifest: false,
      migrationResolved: true,
      requiresMigration: true,
      hasMigrationDraft: false,
      hasDevLease: false,
      currentCommit: CURRENT_COMMIT,
    },
  });

  // I-131 (E3): runtime already required the manifest at dev_deployed, so
  // testing no longer re-checks it — only the lease/deployment gates remain.
  assert.equal(result.allowed, false);
  assert.equal(result.nextState, 'dev_deployed');
  assert.deepEqual(result.requiredActions, [
    'acquire_dev_lease',
    'deploy_current_commit_to_dev',
  ]);
  assert.deepEqual(result.failures.map(({ code }) => code), result.requiredActions);
});

// I-131 (E3): the manifest and migration draft attach where they are
// consumed — runtime at dev_deployed, tooling/governance at testing — and
// stay out of the design/implementation stages.
test('E3: runtime requires the manifest and migration draft at dev_deployed, not before in_dev', () => {
  const withoutManifest = {
    hasVersion: true,
    hasManifest: false,
    migrationResolved: true,
    requiresMigration: true,
    hasMigrationDraft: false,
    currentCommit: CURRENT_COMMIT,
  };
  const intoDev = transition({
    profile: 'runtime',
    from: 'tech_design',
    to: 'in_dev',
    context: withoutManifest,
  });
  assert.equal(intoDev.allowed, true, JSON.stringify(intoDev.failures));
  assert.deepEqual(intoDev.requiredActions, []);

  const toDevDeployed = transition({
    profile: 'runtime',
    from: 'in_dev',
    to: 'dev_deployed',
    context: {
      ...READY,
      hasManifest: false,
      requiresMigration: true,
      hasMigrationDraft: false,
    },
  });
  assert.equal(toDevDeployed.allowed, false);
  assert.deepEqual(toDevDeployed.requiredActions, [
    'create_manifest',
    'create_migration_draft',
  ]);
});

test('E3: tooling and governance require the manifest and migration draft at testing', () => {
  for (const profile of ['tooling', 'governance']) {
    const intoDev = transition({
      profile,
      from: 'tech_design',
      to: 'in_dev',
      context: {
        hasVersion: true,
        hasManifest: false,
        migrationResolved: true,
        requiresMigration: true,
        hasMigrationDraft: false,
      },
    });
    assert.equal(intoDev.allowed, true, `${profile} tech_design -> in_dev`);

    const toTesting = transition({
      profile,
      from: 'in_dev',
      to: 'testing',
      context: {
        ...READY,
        hasManifest: false,
        requiresMigration: true,
        hasMigrationDraft: false,
      },
    });
    assert.equal(toTesting.allowed, false, `${profile} in_dev -> testing`);
    assert.deepEqual(toTesting.requiredActions, [
      'create_manifest',
      'create_migration_draft',
    ]);

    const withManifest = transition({
      profile,
      from: 'in_dev',
      to: 'testing',
      context: READY,
    });
    assert.equal(withManifest.allowed, true, `${profile} with manifest`);
  }
});

test('runtime Testing rejects a dev snapshot from another version', () => {
  const result = transition({
    profile: 'runtime',
    from: 'dev_deployed',
    to: 'testing',
    context: {
      ...READY,
      devSnapshot: { commit: CURRENT_COMMIT, version: 'v0.2.31' },
    },
  });
  assert.equal(result.allowed, false);
  assert.deepEqual(result.requiredActions, ['deploy_current_commit_to_dev']);
});

// I-130 (D1): the dev gate anchors on the immutable deployment snapshot
// commit, not on the floating lease commit — a redeployed HEAD passes even
// when the lease was acquired on an older commit. devRevisionMatches is only
// consulted when the snapshot commit drifts from HEAD (review fix), so an
// exact anchor ignores its value.
test('runtime dev gate ignores devRevisionMatches when the deployment snapshot anchors HEAD exactly', () => {
  const result = transition({
    profile: 'runtime',
    from: 'dev_deployed',
    to: 'testing',
    context: {
      ...READY,
      devLease: { ...DEV_LEASE, commit: '9999999999999999999999999999999999999999' },
      devRevisionMatches: false,
    },
  });
  assert.equal(result.allowed, true);
  assert.deepEqual(result.requiredActions, []);
});

// I-130 (D1): lease evidence identity is the version-level tuple (version,
// branch, session) — a drifted commit still matches, a different version
// never does.
test('runtime Test Passed matches lease evidence on version, branch and session, not commit', () => {
  const driftedCommit = transition({
    profile: 'runtime',
    from: 'testing',
    to: 'test_passed',
    context: {
      ...READY,
      testEvidence: {
        outcome: 'passed',
        environment: {
          devLease: { ...DEV_LEASE, commit: '9999999999999999999999999999999999999999' },
          devSnapshot: DEV_SNAPSHOT,
        },
      },
    },
  });
  assert.equal(driftedCommit.allowed, true, JSON.stringify(driftedCommit.failures));

  const mismatchedVersion = transition({
    profile: 'runtime',
    from: 'testing',
    to: 'test_passed',
    context: {
      ...READY,
      testEvidence: {
        outcome: 'passed',
        environment: {
          devLease: { ...DEV_LEASE, version: 'v0.2.33' },
          devSnapshot: DEV_SNAPSHOT,
        },
      },
    },
  });
  assert.equal(mismatchedVersion.allowed, false);
  assert.deepEqual(mismatchedVersion.requiredActions, ['run_required_tests']);
});

test('runtime Prod Deployed requires the matching prod lease and deployment snapshot', () => {
  const result = transition({
    profile: 'runtime',
    from: 'prod_planning',
    to: 'prod_deployed',
    context: {
      ...READY,
      hasProdLease: false,
      prodSnapshot: null,
    },
  });
  assert.equal(result.allowed, false);
  assert.deepEqual(result.requiredActions, [
    'acquire_prod_lease',
    'deploy_current_commit_to_prod',
  ]);
});

test('runtime Test Passed rechecks the active dev lease and deployment inside the transition', () => {
  const result = transition({
    profile: 'runtime',
    from: 'testing',
    to: 'test_passed',
    context: {
      ...READY,
      hasDevLease: false,
      devLease: null,
      devSnapshot: null,
    },
  });
  assert.equal(result.allowed, false);
  assert.deepEqual(result.requiredActions, [
    'acquire_dev_lease',
    'deploy_current_commit_to_dev',
    'run_required_tests',
  ]);
});

// I-113 Task 3 (lifecycle slice): after machine verification the dev lease is
// atomically converted into a durable awaiting_human freeze fact. Advancing
// to Test Passed must therefore accept a matching freeze fact as the machine
// verification evidence instead of requiring the (now consumed) dev lease.
test('runtime Test Passed accepts a matching freeze fact as machine verification evidence', () => {
  const freeze = {
    schemaVersion: 1,
    resource: 'dev',
    state: 'awaiting_human',
    requirementId: 'I-002',
    version: 'v0.2.32',
    candidateId: 'candidate-I-002-abc123',
    deploymentSnapshot: DEV_SNAPSHOT,
    machineVerificationEvidence: EVIDENCE_SHA,
    branch: 'feature/v0.2.32/lifecycle',
    commit: CURRENT_COMMIT,
    frozenAt: '2026-07-17T00:00:00.000Z',
    actor: { sessionId: '00000000-0000-4000-8000-000000000002' },
  };
  const result = transition({
    profile: 'runtime',
    from: 'testing',
    to: 'test_passed',
    context: {
      ...READY,
      hasDevLease: false,
      devLease: null,
      devSnapshot: null,
      hasFreezeEvidence: true,
      freeze,
      freezeEvidenceMatches: true,
    },
  });
  assert.equal(result.allowed, true, JSON.stringify(result.failures));
  assert.deepEqual(result.requiredActions, []);
});

// The freeze fact only substitutes for the lease when it belongs to the same
// requirement and its machine verification evidence matches the tested
// evidence; anything else must keep failing closed.
test('runtime Test Passed rejects a freeze fact that does not match the tested evidence', () => {
  const result = transition({
    profile: 'runtime',
    from: 'testing',
    to: 'test_passed',
    context: {
      ...READY,
      hasDevLease: false,
      devLease: null,
      devSnapshot: null,
      hasFreezeEvidence: true,
      freeze: {
        schemaVersion: 1,
        resource: 'dev',
        state: 'awaiting_human',
        requirementId: 'I-002',
        version: 'v0.2.32',
        candidateId: 'candidate-I-002-abc123',
        deploymentSnapshot: DEV_SNAPSHOT,
        machineVerificationEvidence: 'b'.repeat(64),
        branch: 'feature/v0.2.32/lifecycle',
        commit: CURRENT_COMMIT,
        frozenAt: '2026-07-17T00:00:00.000Z',
        actor: { sessionId: '00000000-0000-4000-8000-000000000002' },
      },
      freezeEvidenceMatches: false,
    },
  });
  assert.equal(result.allowed, false);
  assert.ok(result.requiredActions.includes('run_required_tests'));
});

// I-130 (review fix): drift between the deployed commit and HEAD is tolerated
// only via the pre-computed devRevisionMatches boolean (the CLI proves the
// whole range is not runtime-affecting: BACKLOG projections, docs,
// evidence-neutral closures). The pure gate only consumes the boolean — true
// tolerates the drift, anything else keeps failing closed.
test('runtime dev gate tolerates non-runtime-affecting drift via devRevisionMatches', () => {
  const projectionHead = '2222222222222222222222222222222222222222';
  const tolerated = transition({
    profile: 'runtime',
    from: 'dev_deployed',
    to: 'testing',
    context: {
      ...READY,
      currentCommit: projectionHead,
      devRevisionMatches: true,
    },
  });
  assert.equal(tolerated.allowed, true, JSON.stringify(tolerated.failures));
  assert.deepEqual(tolerated.requiredActions, []);

  const drifted = transition({
    profile: 'runtime',
    from: 'dev_deployed',
    to: 'testing',
    context: {
      ...READY,
      currentCommit: projectionHead,
      devRevisionMatches: false,
    },
  });
  assert.equal(drifted.allowed, false);
  assert.deepEqual(drifted.requiredActions, ['deploy_current_commit_to_dev']);

  const missing = transition({
    profile: 'runtime',
    from: 'dev_deployed',
    to: 'testing',
    context: { ...READY, currentCommit: projectionHead },
  });
  assert.equal(missing.allowed, false);
  assert.deepEqual(missing.requiredActions, ['deploy_current_commit_to_dev']);
});

test('runtime production planning requires the current commit to be merged', () => {
  const result = transition({
    profile: 'runtime',
    from: 'test_passed',
    to: 'prod_planning',
    context: {
      ...READY,
      currentCommit: '2222222222222222222222222222222222222222',
      mergeStatus: 'pending',
    },
  });
  assert.equal(result.allowed, false);
  assert.deepEqual(result.requiredActions, ['merge_tested_commit']);
});

const BATCH_COMMIT = '2222222222222222222222222222222222222222';
const UNRELATED_COMMIT = '3333333333333333333333333333333333333333';

test('runtime prod gates accept a batch release commit containing the merged commit', () => {
  const isAncestor = (ancestor, descendant) => (
    ancestor === CURRENT_COMMIT && descendant === BATCH_COMMIT
  );
  const batchContext = {
    ...READY,
    currentCommit: BATCH_COMMIT,
    mergedCommit: CURRENT_COMMIT,
    prodSnapshot: { commit: BATCH_COMMIT, version: 'v0.2.32' },
    isAncestor,
  };

  const planning = transition({
    profile: 'runtime',
    from: 'test_passed',
    to: 'prod_planning',
    context: batchContext,
  });
  assert.equal(planning.allowed, true);
  assert.deepEqual(planning.requiredActions, []);

  const deployed = transition({
    profile: 'runtime',
    from: 'prod_planning',
    to: 'prod_deployed',
    context: batchContext,
  });
  assert.equal(deployed.allowed, true);
  assert.deepEqual(deployed.requiredActions, []);
});

// A production transition must have test evidence even when a previous merge exists.
test('I-243: prod gates require the merged commit to cover the tested commit', () => {
  const testedCommit = '4444444444444444444444444444444444444444';
  const coveredByMerge = (ancestor, descendant) => (
    ancestor === testedCommit && descendant === CURRENT_COMMIT
  );

  const stale = transition({
    profile: 'runtime',
    from: 'test_passed',
    to: 'prod_planning',
    context: { ...READY, testedCommit, isAncestor: () => false },
  });
  assert.equal(stale.allowed, false);
  assert.deepEqual(stale.requiredActions, ['merge_tested_commit']);

  const staleDeploy = transition({
    profile: 'runtime',
    from: 'prod_planning',
    to: 'prod_deployed',
    context: { ...READY, testedCommit, isAncestor: () => false },
  });
  assert.equal(staleDeploy.allowed, false);
  assert.deepEqual(staleDeploy.requiredActions, ['merge_tested_commit']);

  const normal = transition({
    profile: 'runtime',
    from: 'test_passed',
    to: 'prod_planning',
    context: { ...READY, testedCommit, isAncestor: coveredByMerge },
  });
  assert.equal(normal.allowed, true, JSON.stringify(normal.failures));
  assert.deepEqual(normal.requiredActions, []);

  for (const [from, to] of [
    ['test_passed', 'prod_planning'],
    ['prod_planning', 'prod_deployed'],
  ]) {
    const absent = transition({
      profile: 'runtime',
      from,
      to,
      context: { ...READY, testedCommit: undefined, isAncestor: () => false },
    });
    assert.equal(absent.allowed, false, `${from} -> ${to}`);
    assert.deepEqual(absent.requiredActions, ['run_required_tests']);
  }
});

test('I-243: repository context feeds TEST_EVIDENCE.testedCommit into the Prod Planning precheck', async (t) => {
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
    title: 'Stale merge gate',
    profile: 'runtime',
    backlogText: '| I-001 | fixture |\n',
  });
  await bindRequirementVersion({ store, id: claimed.id, version: 'v0.2.32' });
  const oldMerge = runGit(fixture.clientA, ['rev-parse', 'HEAD']);

  runGit(fixture.clientA, ['switch', '-c', 'feature/v0.2.32/stale-merge-gate']);
  writeFileSync(join(fixture.clientA, 'feature.txt'), 'reworked feature\n');
  runGit(fixture.clientA, ['add', 'feature.txt']);
  runGit(fixture.clientA, ['commit', '-m', 'test: rework after the old merge']);
  const testedCommit = runGit(fixture.clientA, ['rev-parse', 'HEAD']);

  const requirementDir = join(
    fixture.clientA,
    'docs',
    'product',
    'current',
    `${claimed.id}-stale-merge-gate`,
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
    `| ${claimed.id} | Stale merge gate | 否 | ✅ Test Passed | v0.2.32 | fixture |`,
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

  const snapshot = await store.readSnapshot();
  const requirement = snapshot.readJson(`requirements/${claimed.id}.json`);
  const context = lifecycleContextFromRepository({
    cwd: fixture.clientA,
    id: claimed.id,
    version: requirement.version,
  });
  assert.equal(context.testedCommit, testedCommit);

  const stale = evaluateTransitionPrecheck({
    snapshot,
    cwd: fixture.clientA,
    id: claimed.id,
    to: 'prod_planning',
    requirement,
    context,
    clock,
  });
  assert.equal(stale.ok, false);
  assert.deepEqual(
    stale.missing.filter(({ code }) => code === 'merge_tested_commit').length,
    1,
  );

  // A merge fact that covers the tested commit keeps the normal path green.
  await store.update({
    operation: `refresh the merge fact for ${claimed.id}`,
    mutate(snapshotToUpdate) {
      const path = `requirements/${claimed.id}.json`;
      snapshotToUpdate.writeJson(path, {
        ...snapshotToUpdate.readJson(path),
        mergedCommit: testedCommit,
      });
    },
  });
  const refreshedSnapshot = await store.readSnapshot();
  const refreshed = refreshedSnapshot.readJson(`requirements/${claimed.id}.json`);
  const normal = evaluateTransitionPrecheck({
    snapshot: refreshedSnapshot,
    cwd: fixture.clientA,
    id: claimed.id,
    to: 'prod_planning',
    requirement: refreshed,
    context: lifecycleContextFromRepository({
      cwd: fixture.clientA,
      id: claimed.id,
      version: refreshed.version,
    }),
    clock,
  });
  assert.equal(normal.ok, true, JSON.stringify(normal.missing));
  assert.deepEqual(normal.missing, []);

  for (const invalidEvidence of [
    '{invalid JSON',
    JSON.stringify({
      schemaVersion: 1,
      requirement: { id: 'I-999', version: 'v0.2.32', deliveryProfile: 'runtime' },
      outcome: 'passed',
      testedCommit,
    }),
  ]) {
    writeFileSync(join(requirementDir, 'TEST_EVIDENCE.json'), invalidEvidence);
    const invalidContext = lifecycleContextFromRepository({
      cwd: fixture.clientA,
      id: claimed.id,
      version: refreshed.version,
    });
    const rejected = evaluateTransitionPrecheck({
      snapshot: refreshedSnapshot,
      cwd: fixture.clientA,
      id: claimed.id,
      to: 'prod_planning',
      requirement: refreshed,
      context: invalidContext,
      clock,
    });
    assert.equal(rejected.ok, false);
    assert.deepEqual(rejected.result.requiredActions, ['run_required_tests']);
  }
});

test('runtime Prod Deployed accepts a batch snapshot containing the current commit', () => {
  const result = transition({
    profile: 'runtime',
    from: 'prod_planning',
    to: 'prod_deployed',
    context: {
      ...READY,
      prodSnapshot: { commit: BATCH_COMMIT, version: 'v0.2.32' },
      isAncestor: (ancestor, descendant) => (
        ancestor === CURRENT_COMMIT && descendant === BATCH_COMMIT
      ),
    },
  });
  assert.equal(result.allowed, true);
  assert.deepEqual(result.requiredActions, []);
});

test('runtime prod gates still reject commits not covered by the merged or deployed commit', () => {
  const planning = transition({
    profile: 'runtime',
    from: 'test_passed',
    to: 'prod_planning',
    context: {
      ...READY,
      currentCommit: UNRELATED_COMMIT,
      isAncestor: () => false,
    },
  });
  assert.equal(planning.allowed, false);
  assert.deepEqual(planning.requiredActions, ['merge_tested_commit']);

  const deployed = transition({
    profile: 'runtime',
    from: 'prod_planning',
    to: 'prod_deployed',
    context: {
      ...READY,
      prodSnapshot: { commit: UNRELATED_COMMIT, version: 'v0.2.32' },
      isAncestor: () => false,
    },
  });
  assert.equal(deployed.allowed, false);
  assert.deepEqual(deployed.requiredActions, ['deploy_current_commit_to_prod']);
});

// I-160：版本列车逐条 record+advance 时 BACKLOG 投影 commit 领先已部署 commit（tag），
// CLI 预计算 prodRevisionMatches=true（区间非 runtime-affecting）即容忍，与 dev 门禁同政策。
test('runtime Prod Deployed tolerates projection drift when prodRevisionMatches is proven', () => {
  const result = transition({
    profile: 'runtime',
    from: 'prod_planning',
    to: 'prod_deployed',
    context: {
      ...READY,
      currentCommit: BATCH_COMMIT,
      prodSnapshot: { commit: CURRENT_COMMIT, version: 'v0.2.32' },
      isAncestor: (ancestor, descendant) => (
        ancestor === CURRENT_COMMIT && descendant === BATCH_COMMIT
      ),
      prodRevisionMatches: true,
    },
  });
  assert.equal(result.allowed, true);
  assert.deepEqual(result.requiredActions, []);
});

test('runtime Prod Deployed stays fail-closed when drift is runtime-affecting', () => {
  const result = transition({
    profile: 'runtime',
    from: 'prod_planning',
    to: 'prod_deployed',
    context: {
      ...READY,
      currentCommit: BATCH_COMMIT,
      prodSnapshot: { commit: CURRENT_COMMIT, version: 'v0.2.32' },
      isAncestor: (ancestor, descendant) => (
        ancestor === CURRENT_COMMIT && descendant === BATCH_COMMIT
      ),
      prodRevisionMatches: false,
    },
  });
  assert.equal(result.allowed, false);
  assert.deepEqual(result.requiredActions, ['deploy_current_commit_to_prod']);
});

test('failure loops require reason and evidence SHA and preserve their audit data', () => {
  for (const from of ['testing', 'test_passed', 'prod_planning']) {
    const result = failTransition({
      profile: 'runtime',
      from,
      reason: 'required coordination test failed',
      evidenceSha: EVIDENCE_SHA,
    });
    assert.equal(result.nextState, 'in_dev');
    assert.equal(result.event.reason, 'required coordination test failed');
    assert.equal(result.event.evidenceSha, EVIDENCE_SHA);
  }

  assert.throws(
    () => failTransition({
      profile: 'runtime', from: 'in_dev', reason: 'not a failure loop', evidenceSha: EVIDENCE_SHA,
    }),
    (error) => error.code === 'INVALID_TRANSITION' && error.exitCode === 12,
  );
});

// I-243 review：返工失败必须清空旧合并事实，否则下一次 Prod Planning 会把
// 返工前那次 merge 当成返工后已合并（I-243 的实际事故）。
test('I-243: failing test_passed/prod_planning clears the stale merge fact', async (t) => {
  const context = await setupLifecycleFixture(t);
  for (const from of ['test_passed', 'prod_planning']) {
    await context.store.update({
      operation: `park ${context.id} at ${from} with a merge fact`,
      mutate(snapshot) {
        const path = `requirements/${context.id}.json`;
        snapshot.writeJson(path, {
          ...snapshot.readJson(path),
          lifecycle: from,
          mergeStatus: 'merged',
          mergedCommit: '1'.repeat(40),
          mergedAt: '2026-07-16T00:00:00.000Z',
        });
      },
    });

    await failLifecycle({
      store: context.store,
      cwd: context.fixture.clientA,
      id: context.id,
      reason: 'review found a stale merge fact after rework',
      evidenceSha: EVIDENCE_SHA,
      clock: context.clock,
    });

    const requirement = (await context.store.readSnapshot())
      .readJson(`requirements/${context.id}.json`);
    assert.equal(requirement.lifecycle, 'in_dev', from);
    assert.equal(requirement.mergeStatus, null, from);
    assert.equal(requirement.mergedCommit, null, from);
    assert.equal(requirement.mergedAt, null, from);
  }
});

async function setupLifecycleFixture(t) {
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
    title: 'Lifecycle requirement',
    profile: 'tooling',
    backlogText: '| I-001 | fixture |\n',
  });
  await bindRequirementVersion({ store, id: claimed.id, version: 'v0.2.32' });
  await store.update({
    operation: `prepare ${claimed.id} lifecycle`,
    mutate(snapshot) {
      const path = `requirements/${claimed.id}.json`;
      snapshot.writeJson(path, {
        ...snapshot.readJson(path),
        lifecycle: 'in_dev',
      });
    },
  });
  const targetRow = `| ${claimed.id} | Lifecycle requirement | 否 | 🔨 In Dev | v0.2.32 | fixture |`;
  writeFileSync(join(fixture.clientA, 'BACKLOG.md'), [
    '| I-001 | Other requirement | 否 | ⚪ Todo | - | keep unchanged |',
    targetRow,
    '',
  ].join('\n'));
  mkdirSync(join(fixture.clientA, 'deploy', 'release-manifests'), { recursive: true });
  writeFileSync(
    join(fixture.clientA, 'deploy', 'release-manifests', 'v0.2.32.env'),
    'RELEASE_VERSION=v0.2.32\nRELEASE_DELIVERY_PROFILE=tooling\nRELEASE_SERVICES=none\n',
  );
  return { fixture, store, id: claimed.id, targetRow, clock };
}

async function prepareLifecycleBranch(context) {
  const branch = 'feature/v0.2.32/lifecycle';
  runGit(context.fixture.clientA, ['switch', '-c', branch]);
  runGit(context.fixture.clientA, ['add', 'BACKLOG.md', 'deploy/release-manifests/v0.2.32.env']);
  runGit(context.fixture.clientA, ['commit', '-m', 'test: register lifecycle requirement']);
  runGit(context.fixture.clientA, ['push', '-u', 'origin', branch]);
  await context.store.update({
    operation: `bind ${context.id} lifecycle branch`,
    mutate(snapshot) {
      const path = `requirements/${context.id}.json`;
      snapshot.writeJson(path, { ...snapshot.readJson(path), branch });
    },
  });
  return branch;
}

test('advance updates coordination first and projects only the exact BACKLOG row', async (t) => {
  const context = await setupLifecycleFixture(t);
  const before = readFileSync(join(context.fixture.clientA, 'BACKLOG.md'), 'utf8').split('\n')[0];

  const result = await advanceLifecycle({
    store: context.store,
    cwd: context.fixture.clientA,
    id: context.id,
    to: 'testing',
    context: READY,
    clock: context.clock,
  });

  assert.equal(result.lifecycle, 'testing');
  const requirement = (await context.store.readSnapshot())
    .readJson(`requirements/${context.id}.json`);
  assert.equal(requirement.lifecycle, 'testing');
  const backlog = readFileSync(join(context.fixture.clientA, 'BACKLOG.md'), 'utf8');
  assert.equal(backlog.split('\n')[0], before);
  assert.match(backlog, new RegExp(`\\| ${context.id} .*\\| 🧪 Testing \\|`));
});

test('a failed test run returns to in_dev and persists reason and evidence audit', async (t) => {
  const context = await setupLifecycleFixture(t);
  await advanceLifecycle({
    store: context.store,
    cwd: context.fixture.clientA,
    id: context.id,
    to: 'testing',
    context: READY,
    clock: context.clock,
  });

  const failed = await failLifecycle({
    store: context.store,
    cwd: context.fixture.clientA,
    id: context.id,
    reason: 'required coordination test failed',
    evidenceSha: EVIDENCE_SHA,
    clock: context.clock,
  });
  assert.equal(failed.lifecycle, 'in_dev');
  const requirement = (await context.store.readSnapshot())
    .readJson(`requirements/${context.id}.json`);
  assert.equal(requirement.lifecycle, 'in_dev');
  assert.deepEqual(requirement.lifecycleHistory.at(-1), {
    type: 'fail',
    from: 'testing',
    to: 'in_dev',
    reason: 'required coordination test failed',
    evidenceSha: EVIDENCE_SHA,
    at: '2026-07-17T00:00:00.000Z',
  });
  assert.match(
    readFileSync(join(context.fixture.clientA, 'BACKLOG.md'), 'utf8'),
    new RegExp(`\\| ${context.id} .*\\| 🔨 In Dev \\|`),
  );
});

test('lifecycle advance CLI emits stable JSON and projects Testing', async (t) => {
  const context = await setupLifecycleFixture(t);
  const branch = await prepareLifecycleBranch(context);
  const memory = createMemoryIo();
  const exitCode = await main([
    'lifecycle', 'advance', context.id, '--to', 'testing', '--json',
  ], {
    env: {
      ...process.env,
      COORD_CWD: context.fixture.clientA,
      COORD_REMOTE: 'origin',
      COORD_BRANCH: 'coordination',
      COORD_TEMP_ROOT: context.fixture.tempRoot,
    },
    clock: context.clock,
    ...memory.io,
  });

  assert.equal(exitCode, 0);
  const response = JSON.parse(memory.stdout.join(''));
  assert.equal(response.data.lifecycle, 'testing');
  assert.equal(response.data.published.pushed, true);
  assert.match(
    readFileSync(join(context.fixture.clientA, 'BACKLOG.md'), 'utf8'),
    new RegExp(`\\| ${context.id} .*\\| 🧪 Testing \\|`),
  );
  assert.match(
    runGit(context.fixture.clientA, ['show', `origin/${branch}:BACKLOG.md`]),
    new RegExp(`\\| ${context.id} .*\\| 🧪 Testing \\|`),
  );
});

test('lifecycle CLI refuses a dirty BACKLOG before changing coordination', async (t) => {
  const context = await setupLifecycleFixture(t);
  await prepareLifecycleBranch(context);
  writeFileSync(
    join(context.fixture.clientA, 'BACKLOG.md'),
    readFileSync(join(context.fixture.clientA, 'BACKLOG.md'), 'utf8').replace('fixture |', 'dirty |'),
  );
  const memory = createMemoryIo();

  const exitCode = await main([
    'lifecycle', 'advance', context.id, '--to', 'testing', '--json',
  ], {
    env: {
      ...process.env,
      COORD_CWD: context.fixture.clientA,
      COORD_REMOTE: 'origin',
      COORD_BRANCH: 'coordination',
      COORD_TEMP_ROOT: context.fixture.tempRoot,
    },
    clock: context.clock,
    ...memory.io,
  });

  assert.equal(exitCode, 14);
  assert.equal(JSON.parse(memory.stderr.join('')).code, 'BACKLOG_PROJECTION_DIRTY');
  assert.equal(
    (await context.store.readSnapshot()).readJson(`requirements/${context.id}.json`).lifecycle,
    'in_dev',
  );
});

test('lifecycle CLI rejects the wrong branch before changing coordination', async (t) => {
  const context = await setupLifecycleFixture(t);
  await prepareLifecycleBranch(context);
  runGit(context.fixture.clientA, ['switch', 'main']);
  const memory = createMemoryIo();

  const exitCode = await main([
    'lifecycle', 'advance', context.id, '--to', 'testing', '--json',
  ], {
    env: {
      ...process.env,
      COORD_CWD: context.fixture.clientA,
      COORD_REMOTE: 'origin',
      COORD_BRANCH: 'coordination',
      COORD_TEMP_ROOT: context.fixture.tempRoot,
    },
    clock: context.clock,
    ...memory.io,
  });

  assert.equal(exitCode, 14);
  assert.equal(JSON.parse(memory.stderr.join('')).code, 'BRANCH_MISMATCH');
  assert.equal(
    (await context.store.readSnapshot()).readJson(`requirements/${context.id}.json`).lifecycle,
    'in_dev',
  );
});

test('lifecycle CLI reports remote divergence and reconcile publishes exactly once', async (t) => {
  const context = await setupLifecycleFixture(t);
  const branch = await prepareLifecycleBranch(context);
  runGit(context.fixture.clientB, ['fetch', 'origin', branch]);
  runGit(context.fixture.clientB, ['switch', '-c', branch, '--track', `origin/${branch}`]);
  writeFileSync(join(context.fixture.clientB, 'REMOTE.md'), 'remote\n');
  runGit(context.fixture.clientB, ['add', 'REMOTE.md']);
  runGit(context.fixture.clientB, ['commit', '-m', 'test: diverge lifecycle branch']);
  runGit(context.fixture.clientB, ['push', 'origin', branch]);
  const failedIo = createMemoryIo();

  const failedExit = await main([
    'lifecycle', 'advance', context.id, '--to', 'testing', '--json',
  ], {
    env: {
      ...process.env,
      COORD_CWD: context.fixture.clientA,
      COORD_REMOTE: 'origin',
      COORD_BRANCH: 'coordination',
      COORD_TEMP_ROOT: context.fixture.tempRoot,
    },
    clock: context.clock,
    ...failedIo.io,
  });

  assert.equal(failedExit, 15);
  assert.equal(JSON.parse(failedIo.stderr.join('')).code, 'PROJECTION_UNCERTAIN');
  assert.equal(
    (await context.store.readSnapshot()).readJson(`requirements/${context.id}.json`).lifecycle,
    'testing',
  );

  runGit(context.fixture.clientA, ['rebase', `origin/${branch}`]);
  const reconcileIo = createMemoryIo();
  const reconcileExit = await main(['reconcile', context.id, '--json'], {
    env: {
      ...process.env,
      COORD_CWD: context.fixture.clientA,
      COORD_REMOTE: 'origin',
      COORD_BRANCH: 'coordination',
      COORD_TEMP_ROOT: context.fixture.tempRoot,
    },
    clock: context.clock,
    ...reconcileIo.io,
  });

  assert.equal(reconcileExit, 0, reconcileIo.stderr.join(''));
  runGit(context.fixture.clientA, ['fetch', 'origin', branch]);
  assert.match(
    runGit(context.fixture.clientA, ['show', `origin/${branch}:BACKLOG.md`]),
    new RegExp(`\\| ${context.id} .*\\| 🧪 Testing \\|`),
  );
  assert.equal(
    runGit(context.fixture.clientA, [
      'log', '--format=%s', `origin/${branch}`, '--grep', `project ${context.id} to testing`,
    ]).split('\n').filter(Boolean).length,
    1,
  );
});

test('lifecycle fail CLI hashes TEST_EVIDENCE.json and records the failure loop', async (t) => {
  const context = await setupLifecycleFixture(t);
  await prepareLifecycleBranch(context);
  const advancedIo = createMemoryIo();
  assert.equal(await main([
    'lifecycle', 'advance', context.id, '--to', 'testing', '--json',
  ], {
    env: {
      ...process.env,
      COORD_CWD: context.fixture.clientA,
      COORD_REMOTE: 'origin',
      COORD_BRANCH: 'coordination',
      COORD_TEMP_ROOT: context.fixture.tempRoot,
    },
    clock: context.clock,
    ...advancedIo.io,
  }), 0, advancedIo.stderr.join(''));
  const requirementDir = join(
    context.fixture.clientA,
    'docs',
    'product',
    'current',
    `${context.id}-lifecycle-requirement`,
  );
  mkdirSync(requirementDir, { recursive: true });
  const evidence = '{"outcome":"failed"}\n';
  writeFileSync(join(requirementDir, 'TEST_EVIDENCE.json'), evidence);
  const expectedSha = createHash('sha256').update(evidence).digest('hex');
  const memory = createMemoryIo();

  const exitCode = await main([
    'lifecycle', 'fail', context.id,
    '--reason', 'required coordination test failed',
    '--json',
  ], {
    env: {
      ...process.env,
      COORD_CWD: context.fixture.clientA,
      COORD_REMOTE: 'origin',
      COORD_BRANCH: 'coordination',
      COORD_TEMP_ROOT: context.fixture.tempRoot,
    },
    clock: context.clock,
    ...memory.io,
  });

  assert.equal(exitCode, 0, memory.stderr.join(''));
  const requirement = (await context.store.readSnapshot())
    .readJson(`requirements/${context.id}.json`);
  assert.equal(requirement.lifecycle, 'in_dev');
  assert.equal(requirement.lifecycleHistory.at(-1).evidenceSha, expectedSha);
});

test('reconcile repairs a failed BACKLOG projection without touching other rows', async (t) => {
  const context = await setupLifecycleFixture(t);
  const backlogPath = join(context.fixture.clientA, 'BACKLOG.md');
  const otherRow = '| I-001 | Other requirement | 否 | ⚪ Todo | - | keep unchanged |';
  writeFileSync(backlogPath, `${otherRow}\n`);

  await assert.rejects(
    advanceLifecycle({
      store: context.store,
      cwd: context.fixture.clientA,
      id: context.id,
      to: 'testing',
      context: READY,
      clock: context.clock,
    }),
    (error) => error.code === 'PROJECTION_UNCERTAIN' && error.exitCode === 15,
  );
  assert.equal(
    (await context.store.readSnapshot()).readJson(`requirements/${context.id}.json`).lifecycle,
    'testing',
  );

  writeFileSync(backlogPath, `${otherRow}\n${context.targetRow}\n`);
  const reconciled = await reconcileLifecycle({
    store: context.store,
    cwd: context.fixture.clientA,
    id: context.id,
  });
  assert.equal(reconciled.reconciled, true);
  const backlog = readFileSync(backlogPath, 'utf8');
  assert.equal(backlog.split('\n')[0], otherRow);
  assert.match(backlog, new RegExp(`\\| ${context.id} .*\\| 🧪 Testing \\|`));
});

test('reconcile refuses to publish unrelated BACKLOG row edits', async (t) => {
  const context = await setupLifecycleFixture(t);
  await prepareLifecycleBranch(context);
  await advanceLifecycle({
    store: context.store,
    cwd: context.fixture.clientA,
    id: context.id,
    to: 'testing',
    context: READY,
    clock: context.clock,
  });
  const backlogPath = join(context.fixture.clientA, 'BACKLOG.md');
  writeFileSync(
    backlogPath,
    readFileSync(backlogPath, 'utf8').replace('keep unchanged', 'must not be committed'),
  );
  const memory = createMemoryIo();

  const exitCode = await main(['reconcile', context.id, '--json'], {
    env: {
      ...process.env,
      COORD_CWD: context.fixture.clientA,
      COORD_REMOTE: 'origin',
      COORD_BRANCH: 'coordination',
      COORD_TEMP_ROOT: context.fixture.tempRoot,
    },
    clock: context.clock,
    ...memory.io,
  });

  assert.equal(exitCode, 14);
  assert.equal(JSON.parse(memory.stderr.join('')).code, 'BACKLOG_PROJECTION_SCOPE_DIRTY');
  assert.equal(
    runGit(context.fixture.clientA, ['log', '-1', '--format=%s']),
    'test: register lifecycle requirement',
  );
});

test('I-118: runtime prod_deployed -> done requires the completion fact', () => {
  const blocked = transition({
    profile: 'runtime',
    from: 'prod_deployed',
    to: 'done',
    context: { ...READY, completionFactPresent: false },
  });
  assert.equal(blocked.allowed, false);
  assert.deepEqual(blocked.requiredActions, ['complete_via_workflow']);
  assert.equal(blocked.failures[0].code, 'complete_via_workflow');

  const allowed = transition({
    profile: 'runtime',
    from: 'prod_deployed',
    to: 'done',
    context: { ...READY, completionFactPresent: true },
  });
  assert.equal(allowed.allowed, true);
  assert.deepEqual(allowed.requiredActions, []);
});

test('I-118: tooling/governance merged -> done does not require completion fact', () => {
  for (const profile of ['tooling', 'governance']) {
    const result = transition({
      profile,
      from: 'merged',
      to: 'done',
      context: { ...READY, completionFactPresent: false },
    });
    assert.equal(result.allowed, true, `${profile} merged -> done`);
  }
});

test('B-246: a pending completion cannot be bypassed by lifecycle next', () => {
  for (const profile of ['tooling', 'governance']) {
    const result = transition({
      profile,
      from: 'merged',
      to: 'done',
      context: { ...READY, completionFactPresent: true, completionStatus: 'pending' },
    });
    assert.equal(result.allowed, false, `${profile} must reconcile the completion merge`);
    assert.deepEqual(result.requiredActions, ['reconcile_completion']);
  }
});

// ============================================================================
// I-131 (E1/E5): lifecycle next 取唯一后继并复用 advance 全路径；
// batch-next 单次 coordination update 原子推进多个同分支需求。
// ============================================================================

test('successorState resolves the unique successor and rejects terminal states', () => {
  const runtimePath = [
    'todo', 'reviewing', 'req_confirmed', 'tech_design', 'in_dev',
    'dev_deployed', 'testing', 'test_passed', 'prod_planning', 'prod_deployed', 'done',
  ];
  for (let index = 0; index < runtimePath.length - 1; index += 1) {
    assert.equal(
      successorState({ profile: 'runtime', from: runtimePath[index] }),
      runtimePath[index + 1],
    );
  }
  assert.equal(successorState({ profile: 'tooling', from: 'in_dev' }), 'testing');
  assert.equal(successorState({ profile: 'governance', from: 'merged' }), 'done');
  for (const terminal of ['done', 'cancelled']) {
    assert.throws(
      () => successorState({ profile: 'runtime', from: terminal }),
      (error) => error.code === 'INVALID_TRANSITION' && error.exitCode === 12,
    );
  }
});

test('lifecycle next CLI advances to the unique successor through the full advance path', async (t) => {
  const context = await setupLifecycleFixture(t);
  const branch = await prepareLifecycleBranch(context);
  const memory = createMemoryIo();

  const exitCode = await main(['lifecycle', 'next', context.id, '--json'], {
    env: {
      ...process.env,
      COORD_CWD: context.fixture.clientA,
      COORD_REMOTE: 'origin',
      COORD_BRANCH: 'coordination',
      COORD_TEMP_ROOT: context.fixture.tempRoot,
    },
    clock: context.clock,
    ...memory.io,
  });

  assert.equal(exitCode, 0, memory.stderr.join(''));
  const response = JSON.parse(memory.stdout.join(''));
  assert.equal(response.data.lifecycle, 'testing');
  assert.equal(response.data.published.pushed, true);
  assert.match(
    readFileSync(join(context.fixture.clientA, 'BACKLOG.md'), 'utf8'),
    new RegExp(`\\| ${context.id} .*\\| 🧪 Testing \\|`),
  );
  assert.match(
    runGit(context.fixture.clientA, ['show', `origin/${branch}:BACKLOG.md`]),
    new RegExp(`\\| ${context.id} .*\\| 🧪 Testing \\|`),
  );
});

test('lifecycle next CLI rejects a terminal state with INVALID_TRANSITION', async (t) => {
  const context = await setupLifecycleFixture(t);
  await prepareLifecycleBranch(context);
  await context.store.update({
    operation: `park ${context.id} at done`,
    mutate(snapshot) {
      const path = `requirements/${context.id}.json`;
      snapshot.writeJson(path, { ...snapshot.readJson(path), lifecycle: 'done' });
    },
  });
  const memory = createMemoryIo();

  const exitCode = await main(['lifecycle', 'next', context.id, '--json'], {
    env: {
      ...process.env,
      COORD_CWD: context.fixture.clientA,
      COORD_REMOTE: 'origin',
      COORD_BRANCH: 'coordination',
      COORD_TEMP_ROOT: context.fixture.tempRoot,
    },
    clock: context.clock,
    ...memory.io,
  });

  assert.equal(exitCode, 12);
  assert.equal(JSON.parse(memory.stderr.join('')).code, 'INVALID_TRANSITION');
});

async function setupBatchFixture(t, { secondLifecycle, secondVersion = true }) {
  const context = await setupLifecycleFixture(t);
  const second = await claimRequirement({
    store: context.store,
    type: 'I',
    title: 'Second batch requirement',
    profile: 'tooling',
    backlogText: '| I-001 | fixture |\n',
  });
  if (secondVersion) {
    await bindRequirementVersion({ store: context.store, id: second.id, version: 'v0.2.32' });
  }
  await context.store.update({
    operation: `prepare ${second.id} at ${secondLifecycle}`,
    mutate(snapshot) {
      const path = `requirements/${second.id}.json`;
      snapshot.writeJson(path, { ...snapshot.readJson(path), lifecycle: secondLifecycle });
    },
  });
  const statusOf = { in_dev: '🔨 In Dev', reviewing: '🔍 Reviewing' }[secondLifecycle];
  writeFileSync(join(context.fixture.clientA, 'BACKLOG.md'), [
    '| I-001 | Other requirement | 否 | ⚪ Todo | - | keep unchanged |',
    `| ${context.id} | Lifecycle requirement | 否 | 🔨 In Dev | v0.2.32 | fixture |`,
    `| ${second.id} | Second batch requirement | 否 | ${statusOf} | ${secondVersion ? 'v0.2.32' : '-'} | fixture |`,
    '',
  ].join('\n'));
  const branch = 'feature/v0.2.32/lifecycle';
  runGit(context.fixture.clientA, ['switch', '-c', branch]);
  runGit(context.fixture.clientA, ['add', 'BACKLOG.md', 'deploy/release-manifests/v0.2.32.env']);
  runGit(context.fixture.clientA, ['commit', '-m', 'test: register batch requirements']);
  runGit(context.fixture.clientA, ['push', '-u', 'origin', branch]);
  await context.store.update({
    operation: 'bind batch lifecycle branch',
    mutate(snapshot) {
      for (const id of [context.id, second.id]) {
        const path = `requirements/${id}.json`;
        snapshot.writeJson(path, { ...snapshot.readJson(path), branch });
      }
    },
  });
  return { ...context, secondId: second.id, branch };
}

function batchCliEnv(context) {
  return {
    ...process.env,
    COORD_CWD: context.fixture.clientA,
    COORD_REMOTE: 'origin',
    COORD_BRANCH: 'coordination',
    COORD_TEMP_ROOT: context.fixture.tempRoot,
  };
}

test('lifecycle batch-next CLI advances co-branch requirements atomically with one projection commit', async (t) => {
  const context = await setupBatchFixture(t, { secondLifecycle: 'in_dev' });
  const memory = createMemoryIo();

  const exitCode = await main([
    'lifecycle', 'batch-next', context.id, context.secondId, '--json',
  ], { env: batchCliEnv(context), clock: context.clock, ...memory.io });

  assert.equal(exitCode, 0, memory.stderr.join(''));
  const response = JSON.parse(memory.stdout.join(''));
  assert.deepEqual(
    response.data.results.map(({ id, lifecycle }) => ({ id, lifecycle })),
    [
      { id: context.id, lifecycle: 'testing' },
      { id: context.secondId, lifecycle: 'testing' },
    ],
  );
  const snapshot = await context.store.readSnapshot();
  assert.equal(snapshot.readJson(`requirements/${context.id}.json`).lifecycle, 'testing');
  assert.equal(snapshot.readJson(`requirements/${context.secondId}.json`).lifecycle, 'testing');
  const backlog = readFileSync(join(context.fixture.clientA, 'BACKLOG.md'), 'utf8');
  assert.match(backlog, new RegExp(`\\| ${context.id} .*\\| 🧪 Testing \\|`));
  assert.match(backlog, new RegExp(`\\| ${context.secondId} .*\\| 🧪 Testing \\|`));
  // One coordination update and one BACKLOG projection commit for the batch.
  assert.match(
    snapshot.readJson('operations/last.json').operation,
    new RegExp(`batch advance ${context.id}, ${context.secondId}`),
  );
  assert.match(
    runGit(context.fixture.clientA, ['log', '-1', '--format=%s']),
    new RegExp(`^docs\\(docs\\): batch project ${context.id} to testing \\[${context.id}\\]; ${context.secondId} to testing \\[${context.secondId}\\]`),
  );
});

test('lifecycle batch-next CLI aborts the whole batch when one ID fails its gates', async (t) => {
  const context = await setupBatchFixture(t, {
    secondLifecycle: 'reviewing',
    secondVersion: false,
  });
  const backlogBefore = readFileSync(join(context.fixture.clientA, 'BACKLOG.md'), 'utf8');
  const memory = createMemoryIo();

  const exitCode = await main([
    'lifecycle', 'batch-next', context.id, context.secondId, '--json',
  ], { env: batchCliEnv(context), clock: context.clock, ...memory.io });

  assert.equal(exitCode, 14, memory.stderr.join(''));
  const error = JSON.parse(memory.stderr.join(''));
  assert.equal(error.code, 'LIFECYCLE_GATE_FAILED');
  const results = Object.fromEntries(error.data.results.map((entry) => [entry.id, entry]));
  assert.equal(results[context.id].allowed, true);
  assert.deepEqual(results[context.id].requiredActions, []);
  assert.equal(results[context.secondId].allowed, false);
  assert.deepEqual(results[context.secondId].requiredActions, ['bind_version']);

  // All-or-nothing: coordination and BACKLOG both stay untouched.
  const snapshot = await context.store.readSnapshot();
  assert.equal(snapshot.readJson(`requirements/${context.id}.json`).lifecycle, 'in_dev');
  assert.equal(snapshot.readJson(`requirements/${context.secondId}.json`).lifecycle, 'reviewing');
  assert.equal(readFileSync(join(context.fixture.clientA, 'BACKLOG.md'), 'utf8'), backlogBefore);
});

test('lifecycle batch-next CLI requires at least one requirement id', async (t) => {
  const context = await setupLifecycleFixture(t);
  const memory = createMemoryIo();

  const exitCode = await main(['lifecycle', 'batch-next', '--json'], {
    env: batchCliEnv(context),
    clock: context.clock,
    ...memory.io,
  });

  assert.equal(exitCode, 14);
  assert.equal(JSON.parse(memory.stderr.join('')).code, 'CLI_USAGE');
});

// I-131 (E2): a started requirement lands at in_dev with a single start
// event; advancing to testing then records a normal advance event, which is
// what gate.mjs's testing-history check (TESTING_WAS_SKIPPED) looks for.
test('a started requirement advances in_dev to testing with a normal advance record', async (t) => {
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
  const started = await startRequirement({
    store,
    type: 'I',
    title: 'Started lifecycle requirement',
    profile: 'tooling',
    topic: 'started-lifecycle',
    migration: 'no',
    version: 'v0.2.32',
    backlogText: '| I-001 | fixture |\n',
    owner: { agent: 'test-agent', user: 'tester', host: 'fixture' },
  });
  writeFileSync(join(fixture.clientA, 'BACKLOG.md'), [
    '| I-001 | Other requirement | 否 | ⚪ Todo | - | keep unchanged |',
    `| ${started.id} | Started lifecycle requirement | 否 | 🔨 In Dev | v0.2.32 | fixture |`,
    '',
  ].join('\n'));

  const result = await advanceLifecycle({
    store,
    cwd: fixture.clientA,
    id: started.id,
    to: 'testing',
    context: READY,
    clock,
  });

  assert.equal(result.lifecycle, 'testing');
  const requirement = (await store.readSnapshot())
    .readJson(`requirements/${started.id}.json`);
  assert.deepEqual(
    requirement.lifecycleHistory.map(({ type, from, to }) => ({ type, from, to })),
    [
      { type: 'start', from: null, to: 'in_dev' },
      { type: 'advance', from: 'in_dev', to: 'testing' },
    ],
  );
  assert.match(
    readFileSync(join(fixture.clientA, 'BACKLOG.md'), 'utf8'),
    new RegExp(`\\| ${started.id} .*\\| 🧪 Testing \\|`),
  );
});

// ============================================================================
// I-131 review 修复：
// 1. reconcile 对 from:null 的 start/import 事件不再死锁；
// 2. batch 投影失败的 error.data 带 ids + 逐 ID reconcile；
// 3. batch-next 拒绝重复 ID；
// 6. lifecycle next 全程恰好一次 coordination fetch。
// ============================================================================

test('reconcile closes over a start event whose from is null', async (t) => {
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
  const started = await startRequirement({
    store,
    type: 'I',
    title: 'Started then reconciled',
    profile: 'tooling',
    topic: 'started-reconcile',
    migration: 'no',
    version: 'v0.2.32',
    backlogText: '| I-001 | fixture |\n',
  });
  writeFileSync(join(fixture.clientA, 'BACKLOG.md'), [
    '| I-001 | Other requirement | 否 | ⚪ Todo | - | keep unchanged |',
    `| ${started.id} | Started then reconciled | 否 | 🔨 In Dev | v0.2.32 | fixture |`,
    '',
  ].join('\n'));

  const reconciled = await reconcileLifecycle({ store, cwd: fixture.clientA, id: started.id });

  assert.equal(reconciled.reconciled, true);
  assert.equal(reconciled.lifecycle, 'in_dev');
  assert.equal(reconciled.projection.changed, false);

  // A row at the wrong status still fails closed (as PROJECTION_UNCERTAIN).
  writeFileSync(join(fixture.clientA, 'BACKLOG.md'), [
    '| I-001 | Other requirement | 否 | ⚪ Todo | - | keep unchanged |',
    `| ${started.id} | Started then reconciled | 否 | ⚪ Todo | v0.2.32 | fixture |`,
    '',
  ].join('\n'));
  await assert.rejects(
    reconcileLifecycle({ store, cwd: fixture.clientA, id: started.id }),
    (error) => error.code === 'PROJECTION_UNCERTAIN' && error.exitCode === 15,
  );
});

test('reconcile closes over an import event whose from is null', async (t) => {
  const fixture = createGitFixture(t);
  const clock = () => new Date('2026-07-17T00:00:00.000Z');
  writeFileSync(join(fixture.clientA, 'BACKLOG.md'), [
    '| ID | 需求描述 | 需迁移 | 当前状态 | Version | 备注 |',
    '|----|----------|--------|----------|---------|------|',
    '| I-057 | Imported requirement | 否 | 🔨 In Dev | v0.2.32 | baseline |',
    '',
  ].join('\n'));
  runGit(fixture.clientA, ['add', 'BACKLOG.md']);
  runGit(fixture.clientA, ['commit', '-m', 'test: seed importable baseline']);
  const store = new GitCoordinationStore({
    cwd: fixture.clientA,
    remote: 'origin',
    branch: 'coordination',
    tempRoot: fixture.tempRoot,
    clock,
  });
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  await importExistingRequirement({
    store,
    id: 'I-057',
    profile: 'tooling',
    branch: 'feature/v0.2.32/imported-requirement',
    backlogText: readFileSync(join(fixture.clientA, 'BACKLOG.md'), 'utf8'),
  });

  const reconciled = await reconcileLifecycle({ store, cwd: fixture.clientA, id: 'I-057' });

  assert.equal(reconciled.reconciled, true);
  assert.equal(reconciled.lifecycle, 'in_dev');
  assert.equal(reconciled.projection.changed, false);
});

test('a mid-batch projection failure reports ids and per-id reconcile actions', async (t) => {
  const context = await setupBatchFixture(t, { secondLifecycle: 'in_dev' });
  // The second requirement's row is missing: the first projection succeeds,
  // the second fails — coordination has already advanced both (uncertain).
  writeFileSync(join(context.fixture.clientA, 'BACKLOG.md'), [
    '| I-001 | Other requirement | 否 | ⚪ Todo | - | keep unchanged |',
    `| ${context.id} | Lifecycle requirement | 否 | 🔨 In Dev | v0.2.32 | fixture |`,
    '',
  ].join('\n'));

  await assert.rejects(
    advanceLifecycleBatch({
      store: context.store,
      cwd: context.fixture.clientA,
      items: [
        { id: context.id, to: 'testing', context: READY },
        { id: context.secondId, to: 'testing', context: READY },
      ],
      clock: context.clock,
    }),
    (error) => {
      assert.equal(error.code, 'PROJECTION_UNCERTAIN');
      assert.equal(error.exitCode, 15);
      assert.deepEqual(error.data.ids, [context.id, context.secondId]);
      assert.deepEqual(error.data.requiredActions, [
        `pnpm coord reconcile ${context.id} --json`,
        `pnpm coord reconcile ${context.secondId} --json`,
      ]);
      return true;
    },
  );
  const snapshot = await context.store.readSnapshot();
  assert.equal(snapshot.readJson(`requirements/${context.id}.json`).lifecycle, 'testing');
  assert.equal(snapshot.readJson(`requirements/${context.secondId}.json`).lifecycle, 'testing');
});

test('lifecycle batch-next CLI rejects duplicate requirement ids as usage errors', async (t) => {
  const context = await setupLifecycleFixture(t);
  const memory = createMemoryIo();

  const exitCode = await main([
    'lifecycle', 'batch-next', context.id, context.id, '--json',
  ], { env: batchCliEnv(context), clock: context.clock, ...memory.io });

  assert.equal(exitCode, 14);
  assert.equal(JSON.parse(memory.stderr.join('')).code, 'CLI_USAGE');
});

test('lifecycle next costs exactly one coordination fetch end to end', async (t) => {
  const context = await setupLifecycleFixture(t);
  await prepareLifecycleBranch(context);
  const shimDir = join(context.fixture.root, 'git-shim');
  mkdirSync(shimDir);
  const logPath = join(context.fixture.root, 'git-argv.log');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  writeFileSync(
    join(shimDir, 'git'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${logPath}'\nexec '${realGit}' "$@"\n`,
    { mode: 0o755 },
  );
  const originalPath = process.env.PATH;
  process.env.PATH = `${shimDir}:${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; });
  const memory = createMemoryIo();

  const exitCode = await main(['lifecycle', 'next', context.id, '--json'], {
    env: batchCliEnv(context),
    clock: context.clock,
    ...memory.io,
  });

  assert.equal(exitCode, 0, memory.stderr.join(''));
  const coordinationFetches = readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('fetch ') && line.includes('coordination'));
  assert.deepEqual(coordinationFetches, [
    'fetch --force --no-tags origin +refs/heads/coordination:refs/remotes/origin/coordination',
  ]);
});
