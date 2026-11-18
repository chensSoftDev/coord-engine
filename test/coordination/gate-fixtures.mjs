// Shared fixtures for the gate contract suites (split from gate.test.mjs in I-276
// so the suites run as parallel files instead of one serial file).
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runRequiredTests } from '../../lib/coordination/evidence.mjs';
import { validateRepositoryGate } from '../../lib/coordination/gate.mjs';
import { GitCoordinationStore } from '../../lib/coordination/git-store.mjs';
import { bindRequirementVersion, claimRequirement, declareRequirementResources } from '../../lib/coordination/requirements.mjs';
import { createGitFixture, runGit } from './fixtures.mjs';

export const REQUIREMENT_ID = 'I-002';
export const BRANCH = 'feature/v0.2.32/gate-fixture';

export function replaceBacklogRow(cwd, transform) {
  const path = join(cwd, 'BACKLOG.md');
  const lines = readFileSync(path, 'utf8').split('\n');
  const index = lines.findIndex((line) => line.startsWith(`| ${REQUIREMENT_ID} |`));
  assert.notEqual(index, -1);
  lines[index] = transform(lines[index]);
  writeFileSync(path, lines.join('\n'));
}

export async function setupFeatureGate(t, {
  runtimePath = null,
  manifestRequirements = [REQUIREMENT_ID],
  additionalRequirements = [],
  deliveryProfile = 'tooling',
  manifestServices = 'none',
  uxImpact,
  baseScripts = {},
  featureScripts = { coord: 'node scripts/coordination.mjs' },
  migrationDecl = '否',
  preTestFiles = {},
} = {}) {
  const runtimePaths = [runtimePath].flat().filter(Boolean);
  // runtime fixture 的 changed paths 必须全部可被统一分类器识别（I-113）：
  // 验收脚本走 release tooling 命名，且不改动根 package.json（共享清单会要求全部服务）。
  const runtimeFixture = deliveryProfile === 'runtime';
  const verifyScript = runtimeFixture
    ? 'scripts/test-release-gate-fixture.sh'
    : 'scripts/gate-verify.mjs';
  const verifyArgv = runtimeFixture
    ? ['bash', verifyScript]
    : ['node', verifyScript];
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
  writeFileSync(join(fixture.clientA, 'package.json'), `${JSON.stringify({ private: true, scripts: baseScripts })}\n`);
  runGit(fixture.clientA, ['add', 'package.json']);
  runGit(fixture.clientA, ['commit', '-m', 'test: seed root package metadata']);
  runGit(fixture.clientA, ['push', 'origin', 'main']);
  const claimed = await claimRequirement({
    store,
    type: 'I',
    title: 'Gate fixture',
    profile: deliveryProfile,
    uxImpact,
    backlogText: '| I-001 | fixture |\n',
  });
  assert.equal(claimed.id, REQUIREMENT_ID);
  await bindRequirementVersion({ store, id: REQUIREMENT_ID, version: 'v0.2.32' });
  await declareRequirementResources({
    store,
    id: REQUIREMENT_ID,
    resources: {
      files: [
        'BACKLOG.md',
        'package.json',
        'deploy/release-manifests/v0.2.32.env',
        'docs/**',
        'scripts/**',
        'apps/**',
      ],
    },
  });
  for (const expectedId of additionalRequirements) {
    const additional = await claimRequirement({
      store,
      type: 'I',
      title: `Sibling ${expectedId}`,
      profile: deliveryProfile,
      backlogText: '| I-001 | fixture |\n',
    });
    assert.equal(additional.id, expectedId);
    await bindRequirementVersion({ store, id: expectedId, version: 'v0.2.32' });
  }

  runGit(fixture.clientA, ['switch', '-c', BRANCH]);
  const requirementDir = join(
    fixture.clientA,
    'docs',
    'product',
    'current',
    `${REQUIREMENT_ID}-gate-fixture`,
  );
  mkdirSync(requirementDir, { recursive: true });
  mkdirSync(join(fixture.clientA, 'scripts'), { recursive: true });
  mkdirSync(join(fixture.clientA, 'deploy', 'release-manifests'), { recursive: true });
  writeFileSync(join(requirementDir, 'ACCEPTANCE.md'), [
    '# Gate acceptance',
    '',
    '```coord-required',
    JSON.stringify(verifyArgv),
    '```',
    '',
  ].join('\n'));
  writeFileSync(join(requirementDir, 'TECH_DESIGN.md'), '# Gate design\n');
  writeFileSync(join(fixture.clientA, verifyScript), 'exit 0\n');
  if (!runtimeFixture) {
    writeFileSync(
      join(fixture.clientA, 'package.json'),
      `${JSON.stringify({ private: true, scripts: featureScripts })}\n`,
    );
  }
  for (const path of runtimePaths) {
    mkdirSync(join(fixture.clientA, path, '..'), { recursive: true });
    writeFileSync(join(fixture.clientA, path), 'runtime change\n');
  }
  writeFileSync(
    join(fixture.clientA, 'deploy', 'release-manifests', 'v0.2.32.env'),
    [
      'RELEASE_VERSION=v0.2.32',
      `RELEASE_REQUIREMENTS=${manifestRequirements.join(',')}`,
      `RELEASE_DELIVERY_PROFILE=${deliveryProfile}`,
      `RELEASE_SERVICES=${manifestServices}`,
      '',
    ].join('\n'),
  );
  const baseBacklog = readFileSync(join(fixture.clientA, 'BACKLOG.md'), 'utf8').trimEnd();
  writeFileSync(join(fixture.clientA, 'BACKLOG.md'), [
    baseBacklog,
    `| ${REQUIREMENT_ID} | Gate fixture | ${migrationDecl} | 🧪 Testing | v0.2.32 | tests running |`,
    '',
  ].join('\n'));
  runGit(fixture.clientA, ['add', 'BACKLOG.md', 'docs', verifyScript, 'package.json', 'deploy']);
  for (const path of runtimePaths) runGit(fixture.clientA, ['add', path]);
  // I-272 fixture hook: extra files committed into the tested feature itself
  // (e.g. a pending migration draft for a 是-declaring train member).
  for (const [path, content] of Object.entries(preTestFiles)) {
    mkdirSync(join(fixture.clientA, path, '..'), { recursive: true });
    writeFileSync(join(fixture.clientA, path), content);
    runGit(fixture.clientA, ['add', path]);
  }
  runGit(fixture.clientA, ['commit', '-m', 'test: prepare tested feature']);
  const testedCommit = runGit(fixture.clientA, ['rev-parse', 'HEAD']);
  const runtimeServices = manifestServices === 'none'
    ? []
    : manifestServices.split(',').filter(Boolean).sort();
  const devSnapshot = {
    version: 'v0.2.32',
    commit: testedCommit,
    services: runtimeServices,
  };
  await runRequiredTests({
    cwd: fixture.clientA,
    id: REQUIREMENT_ID,
    requirement: {
      id: REQUIREMENT_ID,
      version: 'v0.2.32',
      deliveryProfile,
    },
    environment: runtimeFixture
      ? { devLease: { requirementId: REQUIREMENT_ID, version: 'v0.2.32', commit: testedCommit }, devSnapshot }
      : undefined,
    runner: async () => ({ exitCode: 0, stdout: 'passed\n', stderr: '' }),
    clock,
  });
  replaceBacklogRow(fixture.clientA, (line) => (
    line.replace('🧪 Testing', '✅ Test Passed').replace('tests running', 'evidence recorded')
  ));
  runGit(fixture.clientA, ['add', 'BACKLOG.md', `docs/product/current/${REQUIREMENT_ID}-gate-fixture/TEST_EVIDENCE.json`]);
  runGit(fixture.clientA, ['commit', '-m', 'test: close evidence']);

  await store.update({
    operation: `prepare ${REQUIREMENT_ID} gate state`,
    mutate(snapshot) {
      const path = `requirements/${REQUIREMENT_ID}.json`;
      snapshot.writeJson(path, {
        ...snapshot.readJson(path),
        branch: BRANCH,
        lifecycle: 'test_passed',
        lifecycleHistory: [
          { type: 'advance', from: 'in_dev', to: 'testing', at: clock().toISOString() },
          { type: 'advance', from: 'testing', to: 'test_passed', at: clock().toISOString() },
        ],
      });
      if (runtimeFixture) snapshot.writeJson('deployments/dev.json', devSnapshot);
    },
  });
  const head = runGit(fixture.clientA, ['rev-parse', 'HEAD']);
  const base = runGit(fixture.clientA, ['rev-parse', 'origin/main']);
  const event = {
    pull_request: {
      head: { ref: BRANCH, sha: head },
      base: { ref: 'main', sha: base },
    },
  };
  return { fixture, store, clock, event, head, base, testedCommit, requirementDir };
}

// ---------------------------------------------------------------------------
// I-272: unified version trains (multiple requirements, one version, one
// branch, merged as a single PR) evaluate coverage, migration attribution,
// resource conflicts and the dev deployment fact per train.
// ---------------------------------------------------------------------------

export const TRAIN_MIGRATION_PATH = 'apps/api/src/database/migrations/1746000000000-i272-train.ts';
export const TRAIN_WEB_PATH = 'apps/web/app/products/page.tsx';
// I-272 correction fixture: a co-member-owned path landing after the other
// member's test run (the cross-member closure case).
export const TRAIN_LATE_MEMBER_PATH = 'apps/web/app/products/late-member-change.tsx';

export async function setupJointTrain(t, { overlapDeclarations = false } = {}) {
  const context = await setupFeatureGate(t, {
    uxImpact: 'none',
    deliveryProfile: 'runtime',
    manifestServices: 'api,web',
    manifestRequirements: [REQUIREMENT_ID, 'I-003'],
    additionalRequirements: ['I-003'],
    migrationDecl: '是',
    runtimePath: [TRAIN_MIGRATION_PATH, TRAIN_WEB_PATH],
    preTestFiles: {
      'docs/releases/PENDING/MIGRATION-I-002.md': '# I-002 pending migration\n',
    },
  });
  const { fixture, store, clock, testedCommit } = context;
  // Partition the declarations: the migration owner keeps its own scope plus
  // the process files; the rider owns only its web delta. With overlap mode
  // both declare the whole tree (mutual-overlap train bookkeeping).
  await declareRequirementResources({
    store,
    id: REQUIREMENT_ID,
    resources: {
      files: overlapDeclarations
        ? ['package.json', 'deploy/release-manifests/v0.2.32.env', 'scripts/test-release-gate-fixture.sh', 'docs/releases/PENDING/**', 'apps/**']
        : [
          'package.json',
          'deploy/release-manifests/v0.2.32.env',
          'scripts/test-release-gate-fixture.sh',
          'docs/releases/PENDING/MIGRATION-I-002.md',
          TRAIN_MIGRATION_PATH,
        ],
    },
  });
  // Co-member I-003: its BACKLOG row must already read Test Passed at its own
  // evidence anchor, so the row lands before the sibling evidence is generated.
  const siblingDir = join(fixture.clientA, 'docs', 'product', 'current', 'I-003-sibling');
  mkdirSync(siblingDir, { recursive: true });
  writeFileSync(join(siblingDir, 'ACCEPTANCE.md'), [
    '# Sibling acceptance',
    '',
    '```coord-required',
    JSON.stringify(['bash', 'scripts/test-release-gate-fixture.sh']),
    '```',
    '',
  ].join('\n'));
  const backlogPath = join(fixture.clientA, 'BACKLOG.md');
  writeFileSync(backlogPath, [
    readFileSync(backlogPath, 'utf8').trimEnd(),
    '| I-003 | Sibling I-003 | 否 | ✅ Test Passed | v0.2.32 | evidence recorded |',
    '',
  ].join('\n'));
  runGit(fixture.clientA, ['add', siblingDir, 'BACKLOG.md']);
  runGit(fixture.clientA, ['commit', '-m', 'test: prepare train sibling']);
  // I-272 correction: the rider lands its own delta after the owner's tested
  // commit — the rider's evidence below anchors this head, the owner's does not.
  writeFileSync(join(fixture.clientA, TRAIN_LATE_MEMBER_PATH), 'late member change\n');
  runGit(fixture.clientA, ['add', TRAIN_LATE_MEMBER_PATH]);
  runGit(fixture.clientA, ['commit', '-m', 'test: rider lands its delta after owner testing']);
  const siblingResult = await runRequiredTests({
    cwd: fixture.clientA,
    id: 'I-003',
    requirement: { id: 'I-003', version: 'v0.2.32', deliveryProfile: 'runtime' },
    environment: {
      // The rider's evidence anchors the current train head (which already
      // contains the owner's tested commit).
      devLease: { requirementId: 'I-003', version: 'v0.2.32', commit: runGit(fixture.clientA, ['rev-parse', 'HEAD']) },
      devSnapshot: {
        version: 'v0.2.32',
        commit: runGit(fixture.clientA, ['rev-parse', 'HEAD']),
        services: ['api', 'web'],
      },
    },
    runner: async () => ({ exitCode: 0, stdout: 'passed\n', stderr: '' }),
    clock,
  });
  runGit(fixture.clientA, ['add', siblingResult.path]);
  runGit(fixture.clientA, ['commit', '-m', 'test: close train sibling evidence']);
  await store.update({
    operation: 'prepare I-003 train state',
    mutate(snapshot) {
      const path = 'requirements/I-003.json';
      snapshot.writeJson(path, {
        ...snapshot.readJson(path),
        branch: BRANCH,
        lifecycle: 'test_passed',
        lifecycleHistory: [
          { type: 'advance', from: 'in_dev', to: 'testing', at: clock().toISOString() },
          { type: 'advance', from: 'testing', to: 'test_passed', at: clock().toISOString() },
        ],
        resources: { files: overlapDeclarations ? ['apps/**'] : [TRAIN_WEB_PATH, TRAIN_LATE_MEMBER_PATH] },
      });
      // One authoritative dev record, recorded under the rider's evidence and
      // shared with the whole train (identical snapshot content).
      snapshot.writeJson('deployments/dev.json', siblingResult.evidence.environment.devSnapshot);
    },
  });
  const head = runGit(fixture.clientA, ['rev-parse', 'HEAD']);
  return {
    ...context,
    head,
    event: {
      pull_request: {
        head: { ref: BRANCH, sha: head },
        base: { ref: 'main', sha: context.base },
      },
    },
  };
}

export async function expectEvidenceFailure(context, nestedCode, requirementId = REQUIREMENT_ID) {
  await assert.rejects(
    validateRepositoryGate({
      cwd: context.fixture.clientA,
      store: context.store,
      event: context.event,
      head: context.head,
      base: 'origin/main',
    }),
    (error) => (
      error.code === 'GATE_FAILED'
      && error.data.failures.some((item) => item.code === 'TEST_EVIDENCE_INVALID'
        && item.requirementId === requirementId
        && (item.evidenceFailures ?? []).some((nested) => nested.code === nestedCode))
    ),
  );
}

export async function expectGateFailure(context, code) {
  await assert.rejects(
    validateRepositoryGate({
      cwd: context.fixture.clientA,
      store: context.store,
      event: context.event,
      head: context.head,
      base: 'origin/main',
    }),
    (error) => (
      error.code === 'GATE_FAILED'
      && error.exitCode === 14
      && error.data.failures.some((item) => item.code === code)
    ),
  );
}

export async function gateFailureCodes(context) {
  try {
    await validateRepositoryGate({
      cwd: context.fixture.clientA,
      store: context.store,
      event: context.event,
      head: context.head,
      base: 'origin/main',
    });
  } catch (error) {
    assert.equal(error.code, 'GATE_FAILED');
    return error.data.failures.map((failure) => failure.code);
  }
  assert.fail('expected repository gate failure');
}

export function commitMutation(context, path, message) {
  runGit(context.fixture.clientA, ['add', path]);
  runGit(context.fixture.clientA, ['commit', '-m', message]);
  context.head = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  context.event.pull_request.head.sha = context.head;
}

export function gateDecision(result) {
  return {
    valid: result.valid,
    event: result.event,
    kind: result.kind,
    head: result.head,
    base: result.base,
    requirements: result.requirements,
    evidenceClosures: result.evidenceClosures,
  };
}

export async function setupCompletionGate(t) {
  const context = await setupFeatureGate(t);
  runGit(context.fixture.clientA, ['switch', 'main']);
  runGit(context.fixture.clientA, ['merge', '--ff-only', context.head]);
  runGit(context.fixture.clientA, ['push', 'origin', 'main']);
  const base = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  const branch = `automation/${REQUIREMENT_ID}-complete`;
  runGit(context.fixture.clientA, ['switch', '-c', branch]);
  replaceBacklogRow(context.fixture.clientA, (line) => line.replace('✅ Test Passed', '✔️ Done'));
  writeFileSync(join(context.requirementDir, 'COMPLETION.json'), JSON.stringify({
    schemaVersion: 1,
    requirementId: REQUIREMENT_ID,
    deliveryProfile: 'tooling',
    mergedCommit: base,
  }, null, 2));
  runGit(context.fixture.clientA, ['add', 'BACKLOG.md', `docs/product/current/${REQUIREMENT_ID}-gate-fixture/COMPLETION.json`]);
  runGit(context.fixture.clientA, ['commit', '-m', 'test: complete requirement']);
  await context.store.update({
    operation: `mark ${REQUIREMENT_ID} merged`,
    mutate(snapshot) {
      const path = `requirements/${REQUIREMENT_ID}.json`;
      snapshot.writeJson(path, {
        ...snapshot.readJson(path),
        lifecycle: 'merged',
        mergedCommit: base,
      });
    },
  });
  const head = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  return {
    ...context,
    head,
    base,
    event: {
      pull_request: {
        head: { ref: branch, sha: head },
        base: { ref: 'main', sha: base },
      },
    },
  };
}

export function mergeFeatureToMain(context) {
  runGit(context.fixture.clientA, ['switch', 'main']);
  runGit(context.fixture.clientA, ['merge', '--ff-only', context.head]);
  runGit(context.fixture.clientA, ['push', 'origin', 'main']);
  return runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
}

export async function setupReleaseDocsGate(t, { tamper = null, keepStatus = false } = {}) {
  const context = await setupFeatureGate(t);
  const merged = mergeFeatureToMain(context);
  await context.store.update({
    operation: `move ${REQUIREMENT_ID} to prod_planning`,
    mutate(snapshot) {
      const path = `requirements/${REQUIREMENT_ID}.json`;
      snapshot.writeJson(path, { ...snapshot.readJson(path), lifecycle: 'prod_planning' });
    },
  });
  const branch = 'chore/release-v0.2.32-docs';
  runGit(context.fixture.clientA, ['switch', '-c', branch]);
  const releasesDir = join(context.fixture.clientA, 'docs', 'releases', 'v0.2.32');
  mkdirSync(releasesDir, { recursive: true });
  writeFileSync(join(releasesDir, 'PROD_PLAN.md'), '# prod plan\n');
  replaceBacklogRow(context.fixture.clientA, (line) => {
    let next = keepStatus ? line : line.replace('✅ Test Passed', '📋 Prod Planning');
    if (tamper) next = tamper(next);
    return next;
  });
  runGit(context.fixture.clientA, ['add', 'BACKLOG.md', 'docs']);
  runGit(context.fixture.clientA, ['commit', '-m', 'test: release planning docs']);
  const head = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  return {
    ...context,
    head,
    base: merged,
    event: {
      pull_request: {
        head: { ref: branch, sha: head },
        base: { ref: 'main', sha: merged },
      },
    },
  };
}

export function commitToMain(context, message, prepare) {
  const { clientA } = context.fixture;
  runGit(clientA, ['switch', 'main']);
  prepare(clientA);
  runGit(clientA, ['add', '-A']);
  runGit(clientA, ['commit', '-m', message]);
  runGit(clientA, ['push', 'origin', 'main']);
  return runGit(clientA, ['rev-parse', 'HEAD']);
}

export function appendBacklogRow(cwd, row) {
  const path = join(cwd, 'BACKLOG.md');
  writeFileSync(path, `${readFileSync(path, 'utf8').trimEnd()}\n${row}\n`);
}

export function writeDocument(cwd, path, content) {
  mkdirSync(join(cwd, path, '..'), { recursive: true });
  writeFileSync(join(cwd, path), content);
}

export function docsMaintenanceGate(context, { base, branch, path, prepare }) {
  const { clientA } = context.fixture;
  runGit(clientA, ['switch', 'main']);
  runGit(clientA, ['switch', '-c', branch]);
  writeDocument(clientA, path, '# docs maintenance\n');
  prepare?.(clientA);
  runGit(clientA, ['add', '-A']);
  runGit(clientA, ['commit', '-m', 'docs: maintain a requirement document']);
  const head = runGit(clientA, ['rev-parse', 'HEAD']);
  return validateRepositoryGate({
    cwd: clientA,
    store: context.store,
    event: {
      pull_request: {
        head: { ref: branch, sha: head },
        base: { ref: 'main', sha: base },
      },
    },
    head,
    base: 'origin/main',
  });
}
