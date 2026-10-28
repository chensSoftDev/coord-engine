import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { runRequiredTests } from '../../lib/coordination/evidence.mjs';
import {
  preflightRepositoryGate,
  uxPathsOwnedByRequirement,
  validateRepositoryGate,
} from '../../lib/coordination/gate.mjs';
import { GitCoordinationStore } from '../../lib/coordination/git-store.mjs';
import { main } from '../../lib/coordination/cli.mjs';
import {
  applyCompletionPatch,
  bindRequirementVersion,
  claimRequirement,
  declareRequirementResources,
  reconcileMergedRequirements,
} from '../../lib/coordination/requirements.mjs';
import { createGitFixture, createMemoryIo, runGit } from './fixtures.mjs';

const REQUIREMENT_ID = 'I-002';
const BRANCH = 'feature/v0.2.32/gate-fixture';

function replaceBacklogRow(cwd, transform) {
  const path = join(cwd, 'BACKLOG.md');
  const lines = readFileSync(path, 'utf8').split('\n');
  const index = lines.findIndex((line) => line.startsWith(`| ${REQUIREMENT_ID} |`));
  assert.notEqual(index, -1);
  lines[index] = transform(lines[index]);
  writeFileSync(path, lines.join('\n'));
}

async function setupFeatureGate(t, {
  runtimePath = null,
  manifestRequirements = [REQUIREMENT_ID],
  additionalRequirements = [],
  deliveryProfile = 'tooling',
  manifestServices = 'none',
  uxImpact,
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
  writeFileSync(join(fixture.clientA, 'package.json'), '{"private":true,"scripts":{}}\n');
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
      profile: 'tooling',
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
      '{"private":true,"scripts":{"coord":"node scripts/coordination.mjs"}}\n',
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
    `| ${REQUIREMENT_ID} | Gate fixture | 否 | 🧪 Testing | v0.2.32 | tests running |`,
    '',
  ].join('\n'));
  runGit(fixture.clientA, ['add', 'BACKLOG.md', 'docs', verifyScript, 'package.json', 'deploy']);
  for (const path of runtimePaths) runGit(fixture.clientA, ['add', path]);
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

test('Ready rejects a new admin-ui requirement without a current UX approval', async (t) => {
  const context = await setupFeatureGate(t, { uxImpact: 'admin-ui' });
  await expectGateFailure(context, 'UX_APPROVAL_NOT_CURRENT');
});

test('Ready rejects none when the change includes an employee-visible admin page', async (t) => {
  const context = await setupFeatureGate(t, {
    uxImpact: 'none', runtimePath: 'apps/admin/app/production/page.tsx',
  });
  await expectGateFailure(context, 'UX_IMPACT_MISMATCH');
});

test('B-248: Ready rejects a no-migration declaration when migration-like paths change', async (t) => {
  const context = await setupFeatureGate(t, {
    uxImpact: 'none',
    runtimePath: 'apps/api/src/database/migrations/1746000000000-b248-fixture.ts',
  });
  await expectGateFailure(context, 'MIGRATION_IMPACT_MISMATCH');
});

test('B-248: Ready rejects none when admin behavior-shaping (review-bucket) paths change', async (t) => {
  const context = await setupFeatureGate(t, {
    uxImpact: 'none', runtimePath: 'apps/admin/hooks/use-table.ts',
  });
  await expectGateFailure(context, 'UX_IMPACT_REVIEW_UNRESOLVED');
});

test('B-248: a recorded ux review override carries the review-bucket paths', async (t) => {
  // A runtime profile is required: tooling profiles reject apps/** paths
  // outright (PROFILE_PATH_MISMATCH) before the ux review check runs.
  const context = await setupFeatureGate(t, {
    uxImpact: 'none',
    deliveryProfile: 'runtime',
    manifestServices: 'admin',
    runtimePath: 'apps/admin/hooks/use-table.ts',
  });
  await context.store.update({
    operation: 'record ux review override',
    mutate(snapshot) {
      const path = `requirements/${REQUIREMENT_ID}.json`;
      snapshot.writeJson(path, {
        ...snapshot.readJson(path),
        uxReviewOverrides: [{
          paths: ['apps/admin/hooks/use-table.ts'],
          reason: 'pure typing refactor, no employee-visible behavior',
          actor: 'b248-agent',
          at: context.clock().toISOString(),
        }],
      });
    },
  });
  // The override resolves the review failure; the remaining gate verdict must
  // not contain UX_IMPACT_REVIEW_UNRESOLVED anymore (this fixture has no other
  // failing conditions).
  await assert.doesNotReject(validateRepositoryGate({
    cwd: context.fixture.clientA,
    store: context.store,
    event: context.event,
    head: context.head,
    base: 'origin/main',
  }));
});

test('batch changes attribute employee UI paths to the declaring requirement', () => {
  const paths = ['BACKLOG.md', 'apps/admin/components/TaskForm.tsx', 'scripts/none-change.mjs'];
  const noneRequirement = { resources: { files: ['BACKLOG.md', 'scripts/none-change.mjs'] } };
  assert.deepEqual(uxPathsOwnedByRequirement({ changedPaths: paths, requirement: noneRequirement }),
    ['BACKLOG.md', 'scripts/none-change.mjs']);
});

async function expectGateFailure(context, code) {
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

async function gateFailureCodes(context) {
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

function commitMutation(context, path, message) {
  runGit(context.fixture.clientA, ['add', path]);
  runGit(context.fixture.clientA, ['commit', '-m', message]);
  context.head = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  context.event.pull_request.head.sha = context.head;
}

function gateDecision(result) {
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

test('gate preflight returns the same decision as a pull request event', async (t) => {
  const context = await setupFeatureGate(t);
  const pullRequest = await validateRepositoryGate({
    cwd: context.fixture.clientA,
    store: context.store,
    event: context.event,
    head: context.head,
    base: context.base,
  });
  const preflight = await preflightRepositoryGate({
    cwd: context.fixture.clientA,
    store: context.store,
    head: context.head,
    base: context.base,
  });

  assert.deepEqual(gateDecision(preflight), gateDecision(pullRequest));

  const memory = createMemoryIo();
  const exitCode = await main([
    'gate', 'preflight',
    '--head', context.head,
    '--base', context.base,
    '--json',
  ], {
    env: {
      ...process.env,
      COORD_CWD: context.fixture.clientA,
      COORD_REMOTE: 'origin',
      COORD_BRANCH: 'coordination',
      COORD_TEMP_ROOT: context.fixture.tempRoot,
    },
    ...memory.io,
  });
  assert.equal(exitCode, 0, memory.stderr.join(''));
  assert.deepEqual(
    gateDecision(JSON.parse(memory.stdout.join('')).data),
    gateDecision(pullRequest),
  );
});

test('valid feature PR accepts an evidence-only closure commit', async (t) => {
  const context = await setupFeatureGate(t);
  let result;
  try {
    result = await validateRepositoryGate({
      cwd: context.fixture.clientA,
      store: context.store,
      event: context.event,
      head: context.head,
      base: 'origin/main',
    });
  } catch (error) {
    assert.fail(JSON.stringify(error.data, null, 2));
  }
  assert.equal(result.valid, true);
  assert.equal(result.kind, 'feature');
  assert.deepEqual(result.requirements, [REQUIREMENT_ID]);
  assert.equal(result.evidenceClosures[0].testedCommit, context.testedCommit);

  const eventPath = join(context.fixture.root, 'pull-request-event.json');
  writeFileSync(eventPath, JSON.stringify(context.event));
  const memory = createMemoryIo();
  const exitCode = await main([
    'gate', 'validate',
    '--event', eventPath,
    '--head', context.head,
    '--base', 'origin/main',
    '--json',
  ], {
    env: {
      ...process.env,
      COORD_CWD: context.fixture.clientA,
      COORD_REMOTE: 'origin',
      COORD_BRANCH: 'coordination',
      COORD_TEMP_ROOT: context.fixture.tempRoot,
    },
    ...memory.io,
  });
  assert.equal(exitCode, 0, memory.stderr.join(''));
  assert.equal(JSON.parse(memory.stdout.join('')).data.valid, true);
});

test('feature gate does not import sibling requirements from a shared manifest', async (t) => {
  const context = await setupFeatureGate(t, {
    manifestRequirements: [REQUIREMENT_ID, 'I-003'],
    additionalRequirements: ['I-003'],
  });

  const result = await validateRepositoryGate({
    cwd: context.fixture.clientA,
    store: context.store,
    event: context.event,
    head: context.head,
    base: 'origin/main',
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.requirements, [REQUIREMENT_ID]);
});

test('feature gate still requires the current requirement in its manifest', async (t) => {
  const context = await setupFeatureGate(t);
  writeFileSync(
    join(context.fixture.clientA, 'deploy', 'release-manifests', 'v0.2.32.env'),
    [
      'RELEASE_VERSION=v0.2.32',
      'RELEASE_REQUIREMENTS=I-003',
      'RELEASE_DELIVERY_PROFILE=tooling',
      'RELEASE_SERVICES=none',
      '',
    ].join('\n'),
  );
  commitMutation(
    context,
    'deploy/release-manifests/v0.2.32.env',
    'test: remove current requirement from manifest',
  );
  await expectGateFailure(context, 'MANIFEST_REQUIREMENT_MISMATCH');
});

test('feature gate accepts requirement closure documents changed after testing', async (t) => {
  const context = await setupFeatureGate(t);
  const requirementRelative = `docs/product/current/${REQUIREMENT_ID}-gate-fixture`;
  writeFileSync(join(context.requirementDir, 'CHECKLIST.md'), [
    '# Gate checklist',
    '',
    '- [x] P4 testing closed',
    '',
  ].join('\n'));
  writeFileSync(
    join(context.requirementDir, 'ACCEPTANCE.md'),
    `${readFileSync(join(context.requirementDir, 'ACCEPTANCE.md'), 'utf8')}\n## 证据记录\n\n已闭包。\n`,
  );
  const siblingDir = join(context.fixture.clientA, 'docs', 'product', 'current', 'batch-notes');
  mkdirSync(siblingDir, { recursive: true });
  writeFileSync(join(siblingDir, 'CHECKLIST.md'), '# batch closure checklist\n');
  writeFileSync(join(siblingDir, 'TEST_EVIDENCE.json'), '{"outcome":"passed"}\n');
  runGit(context.fixture.clientA, ['add', 'docs']);
  runGit(context.fixture.clientA, ['commit', '-m', 'test: close requirement documents']);
  context.head = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  context.event.pull_request.head.sha = context.head;

  const result = await validateRepositoryGate({
    cwd: context.fixture.clientA,
    store: context.store,
    event: context.event,
    head: context.head,
    base: 'origin/main',
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.evidenceClosures[0].closurePaths.sort(), [
    'BACKLOG.md',
    'docs/product/current/batch-notes/CHECKLIST.md',
    'docs/product/current/batch-notes/TEST_EVIDENCE.json',
    `${requirementRelative}/ACCEPTANCE.md`,
    `${requirementRelative}/CHECKLIST.md`,
    `${requirementRelative}/TEST_EVIDENCE.json`,
  ].sort());
});

test('feature gate still rejects requirement design changes after testing', async (t) => {
  const context = await setupFeatureGate(t);
  writeFileSync(
    join(context.requirementDir, 'TECH_DESIGN.md'),
    '# Gate design\n\nChanged after testing.\n',
  );
  commitMutation(
    context,
    `docs/product/current/${REQUIREMENT_ID}-gate-fixture/TECH_DESIGN.md`,
    'test: change design after testing',
  );
  await expectGateFailure(context, 'UNTESTED_CHANGES');
});

test('feature gate accepts an additive epoch review report but rejects a later edit', async t => {
  const context = await setupFeatureGate(t);
  const relative = `docs/product/current/${REQUIREMENT_ID}-gate-fixture/reviews/verification-epoch-1-round-1.json`;
  mkdirSync(join(context.requirementDir, 'reviews'), { recursive: true });
  writeFileSync(join(context.fixture.clientA, relative), `${JSON.stringify({ schemaVersion: 1,
    requirementId: REQUIREMENT_ID, stage: 'verification', subjectFingerprint: 'a'.repeat(64),
    feedbackIds: [], verdict: 'pass', findings: [] })}\n`);
  commitMutation(context, relative, 'test: add epoch verification result');
  assert.equal((await validateRepositoryGate({ cwd: context.fixture.clientA, store: context.store,
    event: context.event, head: context.head, base: 'origin/main' })).valid, true);
  writeFileSync(join(context.fixture.clientA, relative), '{"changed":true}\n');
  commitMutation(context, relative, 'test: edit epoch verification result');
  await expectGateFailure(context, 'UNTESTED_CHANGES');
});

test('feature gate accepts additive interaction and visual results but rejects screenshot replacement', async t => {
  const context = await setupFeatureGate(t);
  const root = `docs/product/current/${REQUIREMENT_ID}-gate-fixture`;
  const imageRoot = join(context.requirementDir, 'reviews/screenshots');
  mkdirSync(imageRoot, { recursive: true });
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');
  for (const name of ['baseline.png', 'actual.png']) writeFileSync(join(imageRoot, name), image);
  const reportPath = `${root}/UI_ACCEPTANCE.json`;
  writeFileSync(join(context.fixture.clientA, reportPath), `${JSON.stringify({ schemaVersion: 1,
    requirementId: REQUIREMENT_ID, candidateId: 'fixture-candidate' })}\n`);
  runGit(context.fixture.clientA, ['add', reportPath, `${root}/reviews/screenshots`]);
  runGit(context.fixture.clientA, ['commit', '-m', 'test: add UI acceptance artifacts']);
  context.head = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  context.event.pull_request.head.sha = context.head;
  assert.equal((await validateRepositoryGate({ cwd: context.fixture.clientA, store: context.store,
    event: context.event, head: context.head, base: 'origin/main' })).valid, true);
  writeFileSync(join(imageRoot, 'actual.png'), Buffer.concat([image, Buffer.from('changed')]));
  commitMutation(context, `${root}/reviews/screenshots/actual.png`, 'test: replace accepted screenshot');
  await expectGateFailure(context, 'UNTESTED_CHANGES');
});

test('feature gate rejects runtime paths under a tooling profile', async (t) => {
  const context = await setupFeatureGate(t, { runtimePath: 'apps/api/src/unsafe.ts' });
  await expectGateFailure(context, 'PROFILE_PATH_MISMATCH');
});

test('feature gate allows only root script additions for a tooling profile', async (t) => {
  const context = await setupFeatureGate(t);
  writeFileSync(
    join(context.fixture.clientA, 'package.json'),
    '{"private":true,"name":"smuggled-runtime-metadata","scripts":{"coord":"node scripts/coordination.mjs"}}\n',
  );
  commitMutation(context, 'package.json', 'test: smuggle package metadata');
  await expectGateFailure(context, 'PROFILE_PATH_MISMATCH');
});

// I-113：runtime 需求只改 release tooling 脚本时，统一分类器 affectedServices 为空，
// RELEASE_SERVICES=none 应通过；当前 gate 内重复的 requiredServices 会错误要求全部五服务。
test('runtime gate accepts release-tooling-only changes with RELEASE_SERVICES=none (I-113)', async (t) => {
  const context = await setupFeatureGate(t, {
    deliveryProfile: 'runtime',
    runtimePath: 'scripts/release.sh',
  });
  const result = await validateRepositoryGate({
    cwd: context.fixture.clientA,
    store: context.store,
    event: context.event,
    head: context.head,
    base: 'origin/main',
  });
  assert.equal(result.valid, true);
});

test('runtime gate requires only the web service for apps/web changes', async (t) => {
  const context = await setupFeatureGate(t, {
    deliveryProfile: 'runtime',
    manifestServices: 'web',
    runtimePath: 'apps/web/src/app/page.tsx',
  });
  const result = await validateRepositoryGate({
    cwd: context.fixture.clientA,
    store: context.store,
    event: context.event,
    head: context.head,
    base: 'origin/main',
  });
  assert.equal(result.valid, true);
});

test('runtime gate rejects a manifest missing either of api and gateway (I-113)', async (t) => {
  await t.test('missing gateway', async (subtest) => {
    const context = await setupFeatureGate(subtest, {
      deliveryProfile: 'runtime',
      manifestServices: 'api',
      runtimePath: ['apps/api/src/changed.ts', 'apps/gateway-api/src/changed.ts'],
    });
    await expectGateFailure(context, 'SERVICE_COVERAGE_MISMATCH');
  });
  await t.test('missing api', async (subtest) => {
    const context = await setupFeatureGate(subtest, {
      deliveryProfile: 'runtime',
      manifestServices: 'gateway',
      runtimePath: ['apps/api/src/changed.ts', 'apps/gateway-api/src/changed.ts'],
    });
    await expectGateFailure(context, 'SERVICE_COVERAGE_MISMATCH');
  });
});

test('merge_group validates the same feature evidence against its queue head', async (t) => {
  const context = await setupFeatureGate(t);
  const event = {
    merge_group: {
      head_sha: context.head,
      base_sha: context.base,
      head_ref: 'refs/heads/gh-readonly-queue/main/pr-2',
      base_ref: 'refs/heads/main',
    },
  };
  const result = await validateRepositoryGate({
    cwd: context.fixture.clientA,
    store: context.store,
    event,
    head: context.head,
    base: 'origin/main',
  });
  assert.equal(result.valid, true);
  assert.equal(result.event, 'merge_group');
});

test('merge_group separates unrelated main advancement from feature closure files', async (t) => {
  const context = await setupFeatureGate(t);
  runGit(context.fixture.clientB, ['pull', '--ff-only', 'origin', 'main']);
  mkdirSync(join(context.fixture.clientB, 'docs'), { recursive: true });
  writeFileSync(join(context.fixture.clientB, 'docs', 'main-advanced.md'), 'unrelated main docs\n');
  runGit(context.fixture.clientB, ['add', 'docs/main-advanced.md']);
  runGit(context.fixture.clientB, ['commit', '-m', 'test: advance main independently']);
  runGit(context.fixture.clientB, ['push', 'origin', 'main']);
  runGit(context.fixture.clientA, ['fetch', 'origin', 'main']);
  runGit(context.fixture.clientA, ['merge', '--no-edit', 'origin/main']);
  const head = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  const base = runGit(context.fixture.clientA, ['rev-parse', 'origin/main']);
  const event = {
    merge_group: {
      head_sha: head,
      base_sha: base,
      head_ref: 'refs/heads/gh-readonly-queue/main/pr-2-updated',
      base_ref: 'refs/heads/main',
    },
  };

  const result = await validateRepositoryGate({
    cwd: context.fixture.clientA,
    store: context.store,
    event,
    head,
    base: 'origin/main',
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.evidenceClosures[0].requiredActions, ['rerun_local_ci']);
});

test('merge_group validates multiple requirements with union coverage and isolated evidence', async (t) => {
  const siblingId = 'I-003';
  const context = await setupFeatureGate(t, {
    manifestRequirements: [REQUIREMENT_ID, siblingId],
    additionalRequirements: [siblingId],
  });
  await declareRequirementResources({
    store: context.store,
    id: REQUIREMENT_ID,
    resources: {
      files: [
        'BACKLOG.md',
        'package.json',
        'deploy/release-manifests/v0.2.32.env',
        `docs/product/current/${REQUIREMENT_ID}-gate-fixture/**`,
        'scripts/gate-verify.mjs',
      ],
    },
  });
  const siblingDir = join(
    context.fixture.clientA,
    'docs',
    'product',
    'current',
    `${siblingId}-gate-sibling`,
  );
  mkdirSync(siblingDir, { recursive: true });
  writeFileSync(join(siblingDir, 'ACCEPTANCE.md'), [
    '# Sibling acceptance',
    '',
    '```coord-required',
    '["node", "scripts/gate-verify-sibling.mjs"]',
    '```',
    '',
  ].join('\n'));
  writeFileSync(join(siblingDir, 'TECH_DESIGN.md'), '# Sibling design\n');
  writeFileSync(
    join(context.fixture.clientA, 'scripts', 'gate-verify-sibling.mjs'),
    'process.exitCode = 0;\n',
  );
  const backlogPath = join(context.fixture.clientA, 'BACKLOG.md');
  writeFileSync(backlogPath, [
    readFileSync(backlogPath, 'utf8').trimEnd(),
    `| ${siblingId} | Gate sibling | 否 | 🧪 Testing | v0.2.32 | tests running |`,
    '',
  ].join('\n'));
  runGit(context.fixture.clientA, ['add', 'BACKLOG.md', 'docs', 'scripts/gate-verify-sibling.mjs']);
  runGit(context.fixture.clientA, ['commit', '-m', 'test: prepare sibling feature']);
  await runRequiredTests({
    cwd: context.fixture.clientA,
    id: siblingId,
    requirement: {
      id: siblingId,
      version: 'v0.2.32',
      deliveryProfile: 'tooling',
    },
    runner: async () => ({ exitCode: 0, stdout: 'passed\n', stderr: '' }),
    clock: context.clock,
  });
  writeFileSync(
    backlogPath,
    readFileSync(backlogPath, 'utf8')
      .replace(
        `| ${siblingId} | Gate sibling | 否 | 🧪 Testing | v0.2.32 | tests running |`,
        `| ${siblingId} | Gate sibling | 否 | ✅ Test Passed | v0.2.32 | evidence recorded |`,
      ),
  );
  runGit(context.fixture.clientA, [
    'add',
    'BACKLOG.md',
    `docs/product/current/${siblingId}-gate-sibling/TEST_EVIDENCE.json`,
  ]);
  runGit(context.fixture.clientA, ['commit', '-m', 'test: close sibling evidence']);
  await declareRequirementResources({
    store: context.store,
    id: siblingId,
    resources: {
      files: [
        'BACKLOG.md',
        `docs/product/current/${siblingId}-gate-sibling/**`,
        'scripts/gate-verify-sibling.mjs',
      ],
    },
  });
  await context.store.update({
    operation: `prepare ${siblingId} merge group state`,
    mutate(snapshot) {
      const path = `requirements/${siblingId}.json`;
      snapshot.writeJson(path, {
        ...snapshot.readJson(path),
        branch: 'feature/v0.2.32/gate-sibling',
        lifecycle: 'test_passed',
        lifecycleHistory: [
          { type: 'advance', from: 'in_dev', to: 'testing', at: context.clock().toISOString() },
          { type: 'advance', from: 'testing', to: 'test_passed', at: context.clock().toISOString() },
        ],
      });
    },
  });
  context.head = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);

  const result = await validateRepositoryGate({
    cwd: context.fixture.clientA,
    store: context.store,
    event: {
      merge_group: {
        head_sha: context.head,
        head_ref: 'refs/heads/gh-readonly-queue/main/pr-2-pr-3',
        base_sha: context.base,
      },
    },
    head: context.head,
    base: context.base,
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.requirements, [REQUIREMENT_ID, siblingId]);
});

test('feature gate rejects every missing or stale delivery fact', async (t) => {
  const cases = [
    ['BACKLOG_MISSING', (context) => {
      const path = join(context.fixture.clientA, 'BACKLOG.md');
      const lines = readFileSync(path, 'utf8').split('\n')
        .filter((line) => !line.startsWith(`| ${REQUIREMENT_ID} |`));
      writeFileSync(path, lines.join('\n'));
      commitMutation(context, 'BACKLOG.md', 'test: remove backlog row');
    }],
    ['VERSION_MISMATCH', (context) => {
      replaceBacklogRow(context.fixture.clientA, (line) => line.replace('v0.2.32', '-'));
      commitMutation(context, 'BACKLOG.md', 'test: remove version');
    }],
    ['MANIFEST_MISSING', (context) => {
      rmSync(join(context.fixture.clientA, 'deploy', 'release-manifests', 'v0.2.32.env'));
      runGit(context.fixture.clientA, ['add', '-u', 'deploy/release-manifests/v0.2.32.env']);
      runGit(context.fixture.clientA, ['commit', '-m', 'test: remove manifest']);
      context.head = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
      context.event.pull_request.head.sha = context.head;
    }],
    ['MIGRATION_DRAFT_MISSING', (context) => {
      replaceBacklogRow(context.fixture.clientA, (line) => line.replace('| 否 |', '| 是 |'));
      commitMutation(context, 'BACKLOG.md', 'test: require migration');
    }],
    ['TEST_EVIDENCE_MISSING', (context) => {
      const relativePath = `docs/product/current/${REQUIREMENT_ID}-gate-fixture/TEST_EVIDENCE.json`;
      rmSync(join(context.fixture.clientA, relativePath));
      runGit(context.fixture.clientA, ['add', '-u', relativePath]);
      runGit(context.fixture.clientA, ['commit', '-m', 'test: remove evidence']);
      context.head = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
      context.event.pull_request.head.sha = context.head;
    }],
    ['UNTESTED_CHANGES', (context) => {
      writeFileSync(join(context.fixture.clientA, 'scripts', 'untested.mjs'), 'export const changed = true;\n');
      commitMutation(context, 'scripts/untested.mjs', 'test: add untested code');
    }],
  ];

  for (const [code, mutate] of cases) {
    await t.test(code, async (subtest) => {
      const context = await setupFeatureGate(subtest);
      mutate(context);
      await expectGateFailure(context, code);
    });
  }
});

test('feature gate rejects branch mismatch, unmerged dependency, and skipped Testing', async (t) => {
  for (const [code, mutate] of [
    ['BRANCH_MISMATCH', async (context) => {
      await context.store.update({
        operation: 'set wrong branch',
        mutate(snapshot) {
          const path = `requirements/${REQUIREMENT_ID}.json`;
          snapshot.writeJson(path, { ...snapshot.readJson(path), branch: 'feature/v0.2.32/other' });
        },
      });
    }],
    ['DEPENDENCY_NOT_MERGED', async (context) => {
      await context.store.update({
        operation: 'add unmerged dependency',
        mutate(snapshot) {
          const path = `requirements/${REQUIREMENT_ID}.json`;
          snapshot.writeJson(path, { ...snapshot.readJson(path), dependsOn: ['I-099'] });
          snapshot.writeJson('requirements/I-099.json', {
            schemaVersion: 1,
            id: 'I-099',
            lifecycle: 'in_dev',
          });
        },
      });
    }],
    ['TESTING_WAS_SKIPPED', async (context) => {
      await context.store.update({
        operation: 'remove testing history',
        mutate(snapshot) {
          const path = `requirements/${REQUIREMENT_ID}.json`;
          const requirement = snapshot.readJson(path);
          snapshot.writeJson(path, {
            ...requirement,
            lifecycleHistory: [{ type: 'advance', from: 'in_dev', to: 'test_passed' }],
          });
        },
      });
    }],
  ]) {
    await t.test(code, async (subtest) => {
      const context = await setupFeatureGate(subtest);
      await mutate(context);
      await expectGateFailure(context, code);
    });
  }
});

test('gate rejects an evaluation base that differs from the event base', async (t) => {
  const context = await setupFeatureGate(t);
  runGit(context.fixture.clientB, ['pull', '--ff-only', 'origin', 'main']);
  writeFileSync(join(context.fixture.clientB, 'README.md'), '# coordination fixture\n\nmain advanced\n');
  runGit(context.fixture.clientB, ['add', 'README.md']);
  runGit(context.fixture.clientB, ['commit', '-m', 'test: advance main beyond event base']);
  runGit(context.fixture.clientB, ['push', 'origin', 'main']);
  runGit(context.fixture.clientA, ['fetch', 'origin', 'main']);

  await expectGateFailure(context, 'EVENT_BASE_MISMATCH');
});

test('gate rejects a base that is not an ancestor of the gate head', async (t) => {
  const context = await setupFeatureGate(t);
  runGit(context.fixture.clientB, ['switch', '--orphan', 'unrelated-base']);
  writeFileSync(join(context.fixture.clientB, 'unrelated.txt'), 'orphan base\n');
  runGit(context.fixture.clientB, ['add', 'unrelated.txt']);
  runGit(context.fixture.clientB, ['commit', '-m', 'test: create orphan base']);
  const unrelatedSha = runGit(context.fixture.clientB, ['rev-parse', 'HEAD']);
  runGit(context.fixture.clientB, ['push', 'origin', 'unrelated-base']);
  runGit(context.fixture.clientA, ['fetch', 'origin', 'unrelated-base']);
  const event = structuredClone(context.event);
  event.pull_request.base.sha = unrelatedSha;

  await assert.rejects(
    validateRepositoryGate({
      cwd: context.fixture.clientA,
      store: context.store,
      event,
      head: context.head,
      base: unrelatedSha,
    }),
    (error) => (
      error.code === 'GATE_FAILED'
      && error.exitCode === 14
      && error.data.failures.some((item) => item.code === 'BASE_NOT_ANCESTOR')
    ),
  );
});

test('feature gate enforces resource coverage and serializes active overlaps', async (t) => {
  await t.test('own requirement records and BACKLOG projection are implicit', async subtest => {
    const context = await setupFeatureGate(subtest);
    await context.store.update({ operation: 'remove implicit resource declarations', mutate(snapshot) {
      const path = `requirements/${REQUIREMENT_ID}.json`;
      const requirement = snapshot.readJson(path);
      snapshot.writeJson(path, { ...requirement, resources: { ...requirement.resources,
        files: requirement.resources.files.filter(file => file !== 'BACKLOG.md' && file !== 'docs/**') } });
    } });
    assert.equal((await validateRepositoryGate({ cwd: context.fixture.clientA, store: context.store,
      event: context.event, head: context.head, base: 'origin/main' })).valid, true);
  });
  await t.test('undeclared changed path', async (subtest) => {
    const context = await setupFeatureGate(subtest);
    await context.store.update({
      operation: 'remove script resource coverage',
      mutate(snapshot) {
        const path = `requirements/${REQUIREMENT_ID}.json`;
        const requirement = snapshot.readJson(path);
        snapshot.writeJson(path, {
          ...requirement,
          resources: { ...requirement.resources, files: ['BACKLOG.md'] },
        });
      },
    });
    await expectGateFailure(context, 'RESOURCE_DECLARATION_INCOMPLETE');
  });

  const prepareOverlap = async (context, {
    currentDependsOn = [],
    siblingDependsOn = [],
    siblingMergeStatus = null,
  } = {}) => {
    await context.store.update({
      operation: 'prepare overlapping active requirement',
      mutate(snapshot) {
        const currentPath = `requirements/${REQUIREMENT_ID}.json`;
        snapshot.writeJson(currentPath, {
          ...snapshot.readJson(currentPath),
          dependsOn: currentDependsOn,
        });
        snapshot.writeJson('requirements/I-099.json', {
          schemaVersion: 1,
          id: 'I-099',
          title: 'Overlapping requirement',
          deliveryProfile: 'runtime',
          lifecycle: siblingMergeStatus === 'merged' ? 'test_passed' : 'in_dev',
          mergeStatus: siblingMergeStatus,
          ...(siblingMergeStatus === 'merged' ? { mergedCommit: '1'.repeat(40) } : {}),
          resources: {
            files: ['scripts/**'],
            services: [],
            databaseTables: [],
            configKeys: [],
            sharedResources: [],
          },
          dependsOn: siblingDependsOn,
        });
      },
    });
  };

  await t.test('unresolved active overlap', async (subtest) => {
    const context = await setupFeatureGate(subtest);
    await prepareOverlap(context);
    await expectGateFailure(context, 'RESOURCE_CONFLICT_UNRESOLVED');
  });

  await t.test('current requirement waits for overlapping dependency', async (subtest) => {
    const context = await setupFeatureGate(subtest);
    await prepareOverlap(context, { currentDependsOn: ['I-099'] });
    const codes = await gateFailureCodes(context);
    assert.equal(codes.includes('DEPENDENCY_NOT_MERGED'), true);
    assert.equal(codes.includes('RESOURCE_CONFLICT_UNRESOLVED'), false);
  });

  await t.test('overlapping requirement waits for current requirement', async (subtest) => {
    const context = await setupFeatureGate(subtest);
    await prepareOverlap(context, { siblingDependsOn: [REQUIREMENT_ID] });
    const result = await validateRepositoryGate({
      cwd: context.fixture.clientA,
      store: context.store,
      event: context.event,
      head: context.head,
      base: 'origin/main',
    });
    assert.equal(result.valid, true);
  });

  await t.test('merged runtime overlap is inactive', async (subtest) => {
    const context = await setupFeatureGate(subtest);
    await prepareOverlap(context, { siblingMergeStatus: 'merged' });
    const result = await validateRepositoryGate({
      cwd: context.fixture.clientA,
      store: context.store,
      event: context.event,
      head: context.head,
      base: 'origin/main',
    });
    assert.equal(result.valid, true);
  });

  await t.test('shared BACKLOG projection does not serialize unrelated business resources', async (subtest) => {
    const context = await setupFeatureGate(subtest);
    await context.store.update({
      operation: 'add unrelated active requirement sharing only BACKLOG',
      mutate(snapshot) {
        snapshot.writeJson('requirements/I-099.json', {
          schemaVersion: 1,
          id: 'I-099',
          deliveryProfile: 'tooling',
          lifecycle: 'in_dev',
          resources: { files: ['BACKLOG.md', 'unrelated/**'] },
          dependsOn: [],
        });
      },
    });
    const result = await validateRepositoryGate({
      cwd: context.fixture.clientA,
      store: context.store,
      event: context.event,
      head: context.head,
      base: context.base,
    });
    assert.equal(result.valid, true);
  });
});

test('feature gate accepts a runtime dependency after its main merge fact is recorded', async (t) => {
  const context = await setupFeatureGate(t);
  await context.store.update({
    operation: 'add merged runtime dependency',
    mutate(snapshot) {
      const path = `requirements/${REQUIREMENT_ID}.json`;
      snapshot.writeJson(path, { ...snapshot.readJson(path), dependsOn: ['I-099'] });
      snapshot.writeJson('requirements/I-099.json', {
        schemaVersion: 1,
        id: 'I-099',
        deliveryProfile: 'runtime',
        lifecycle: 'test_passed',
        mergeStatus: 'merged',
        mergedCommit: '1234567890123456789012345678901234567890',
      });
    },
  });

  const result = await validateRepositoryGate({
    cwd: context.fixture.clientA,
    store: context.store,
    event: context.event,
    head: context.head,
    base: 'origin/main',
  });
  assert.equal(result.valid, true);
});

async function setupCompletionGate(t) {
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

test('completion PR from merged changes only completion facts and passes', async (t) => {
  const context = await setupCompletionGate(t);
  const result = await validateRepositoryGate({
    cwd: context.fixture.clientA,
    store: context.store,
    event: context.event,
    head: context.head,
    base: 'origin/main',
  });
  assert.equal(result.valid, true);
  assert.equal(result.kind, 'completion');
});

test('completion gate rejects code changes and mismatched merge evidence', async (t) => {
  await t.test('COMPLETION_REQUIREMENT_MISMATCH', async (subtest) => {
    const context = await setupCompletionGate(subtest);
    context.event.pull_request.head.ref = 'automation/I-999-complete';
    await expectGateFailure(context, 'COMPLETION_REQUIREMENT_MISMATCH');
  });

  await t.test('COMPLETION_SCOPE_INVALID', async (subtest) => {
    const context = await setupCompletionGate(subtest);
    const releasePath = join(context.fixture.clientA, 'docs', 'releases', 'v0.8.5', 'RELEASE.md');
    mkdirSync(join(releasePath, '..'), { recursive: true });
    writeFileSync(releasePath, '# I-094 release metadata must not enter completion\n');
    commitMutation(context, 'docs/releases/v0.8.5/RELEASE.md', 'test: reproduce PR 69 scope leak');
    await expectGateFailure(context, 'COMPLETION_SCOPE_INVALID');
  });

  for (const badCommit of [
    '7deff3aa57452b0827090894ab510c3e9bc0d47c',
    'ece87cff9ec3e6e4c0b2a3f29b1e6d3c3a9f0b5d',
  ]) {
    await t.test(`COMPLETION_EVIDENCE_INVALID ${badCommit}`, async (subtest) => {
      const context = await setupCompletionGate(subtest);
      writeFileSync(join(context.requirementDir, 'COMPLETION.json'), JSON.stringify({
        schemaVersion: 1,
        requirementId: REQUIREMENT_ID,
        deliveryProfile: 'tooling',
        mergedCommit: badCommit,
      }, null, 2));
      commitMutation(
        context,
        `docs/product/current/${REQUIREMENT_ID}-gate-fixture/COMPLETION.json`,
        'test: reproduce PR 69 merge evidence typo',
      );
      await expectGateFailure(context, 'COMPLETION_EVIDENCE_INVALID');
    });
  }
});

function mergeFeatureToMain(context) {
  runGit(context.fixture.clientA, ['switch', 'main']);
  runGit(context.fixture.clientA, ['merge', '--ff-only', context.head]);
  runGit(context.fixture.clientA, ['push', 'origin', 'main']);
  return runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
}

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







async function setupReleaseDocsGate(t, { tamper = null, keepStatus = false } = {}) {
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

test('release-docs PR passes for prod-stage requirement with docs-only changes', async (t) => {
  const context = await setupReleaseDocsGate(t);
  const result = await validateRepositoryGate({
    cwd: context.fixture.clientA,
    store: context.store,
    event: context.event,
    head: context.head,
    base: 'origin/main',
  });
  assert.equal(result.valid, true);
  assert.equal(result.kind, 'release-docs');
});

test('release-docs PR rejects BACKLOG core field changes', async (t) => {
  const context = await setupReleaseDocsGate(t, {
    tamper: (line) => line.replace('Gate fixture', 'Tampered description'),
  });
  await expectGateFailure(context, 'RELEASE_DOCS_BACKLOG_SCOPE_INVALID');
});

test('release-docs PR allows BACKLOG version correction to the coordination-bound version (I-114)', async (t) => {
  const context = await setupFeatureGate(t);
  mergeFeatureToMain(context);
  // 模拟合并后改绑：coordination 记录版本变为 v0.2.33，新 manifest 直接进 main（不进 PR diff）
  await context.store.update({
    operation: `rebind ${REQUIREMENT_ID} to v0.2.33 after merge`,
    mutate(snapshot) {
      const path = `requirements/${REQUIREMENT_ID}.json`;
      snapshot.writeJson(path, { ...snapshot.readJson(path), lifecycle: 'prod_planning', version: 'v0.2.33' });
    },
  });
  writeFileSync(
    join(context.fixture.clientA, 'deploy', 'release-manifests', 'v0.2.33.env'),
    [
      'RELEASE_VERSION=v0.2.33',
      `RELEASE_REQUIREMENTS=${REQUIREMENT_ID}`,
      'RELEASE_DELIVERY_PROFILE=tooling',
      'RELEASE_SERVICES=none',
      '',
    ].join('\n'),
  );
  runGit(context.fixture.clientA, ['add', 'deploy/release-manifests/v0.2.33.env']);
  runGit(context.fixture.clientA, ['commit', '-m', 'test: rebind manifest on main']);
  runGit(context.fixture.clientA, ['push', 'origin', 'main']);
  // release-docs 分支：BACKLOG 状态推进 + 版本列校正为协调绑定版本
  const branch = 'chore/release-v0.2.33-docs';
  runGit(context.fixture.clientA, ['switch', '-c', branch]);
  const releasesDir = join(context.fixture.clientA, 'docs', 'releases', 'v0.2.33');
  mkdirSync(releasesDir, { recursive: true });
  writeFileSync(join(releasesDir, 'PROD_PLAN.md'), '# prod plan\n');
  replaceBacklogRow(context.fixture.clientA, (line) =>
    line.replace('✅ Test Passed', '📋 Prod Planning').replace('| v0.2.32 |', '| v0.2.33 |'),
  );
  runGit(context.fixture.clientA, ['add', 'BACKLOG.md', 'docs']);
  runGit(context.fixture.clientA, ['commit', '-m', 'test: release planning docs with version correction']);
  const head = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  const result = await validateRepositoryGate({
    cwd: context.fixture.clientA,
    store: context.store,
    event: {
      pull_request: {
        head: { ref: branch, sha: head },
        base: { ref: 'main', sha: runGit(context.fixture.clientA, ['rev-parse', 'main']) },
      },
    },
    head,
    base: 'origin/main',
  });
  assert.equal(result.valid, true);
  assert.equal(result.kind, 'release-docs');
});

test('release-docs PR rejects BACKLOG version drift from coordination (I-114)', async (t) => {
  const context = await setupReleaseDocsGate(t, {
    tamper: (line) => line.replace('| v0.2.32 |', '| v0.2.33 |'),
  });
  // coordination 仍绑定 v0.2.32：版本列被改成与协调事实不一致的值
  await expectGateFailure(context, 'VERSION_MISMATCH');
});

test('release-docs PR rejects a BACKLOG row that does not advance', async (t) => {
  const context = await setupReleaseDocsGate(t, {
    keepStatus: true,
    tamper: (line) => line.replace('evidence recorded', 'release planning notes'),
  });
  await expectGateFailure(context, 'RELEASE_DOCS_STATUS_INVALID');
});

test('release-docs kind does not leak into non-docs changes', async (t) => {
  const context = await setupReleaseDocsGate(t);
  writeFileSync(join(context.fixture.clientA, 'scripts', 'not-docs.mjs'), 'export default true;\n');
  runGit(context.fixture.clientA, ['add', 'scripts/not-docs.mjs']);
  runGit(context.fixture.clientA, ['commit', '-m', 'test: smuggle non-docs change']);
  context.head = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  context.event.pull_request.head.sha = context.head;
  await expectGateFailure(context, 'FEATURE_NOT_TEST_PASSED');
});

test('release-docs PR passes for pure release notes backfill without requirement ids (I-109)', async (t) => {
  const context = await setupFeatureGate(t);
  const merged = mergeFeatureToMain(context);
  const branch = 'chore/release-notes-backfill';
  runGit(context.fixture.clientA, ['switch', '-c', branch]);
  const releasesDir = join(context.fixture.clientA, 'docs', 'releases', 'v0.2.32');
  mkdirSync(releasesDir, { recursive: true });
  writeFileSync(join(releasesDir, 'RELEASE.md'), '# release notes backfill\n');
  runGit(context.fixture.clientA, ['add', 'docs']);
  runGit(context.fixture.clientA, ['commit', '-m', 'docs(release): backfill release notes']);
  const head = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  const result = await validateRepositoryGate({
    cwd: context.fixture.clientA,
    store: context.store,
    event: {
      pull_request: {
        head: { ref: branch, sha: head },
        base: { ref: 'main', sha: merged },
      },
    },
    head,
    base: 'origin/main',
  });
  assert.equal(result.kind, 'release-docs');
  assert.equal(result.valid, true);
});

test('completion accepts prod-stage lifecycle with a Prod Planning backlog base', async (t) => {
  const context = await setupFeatureGate(t);
  replaceBacklogRow(context.fixture.clientA, (line) => line.replace('✅ Test Passed', '📋 Prod Planning'));
  runGit(context.fixture.clientA, ['add', 'BACKLOG.md']);
  runGit(context.fixture.clientA, ['commit', '-m', 'test: mark prod planning on feature']);
  context.head = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  const base = mergeFeatureToMain(context);
  const branch = `automation/${REQUIREMENT_ID}-complete`;
  runGit(context.fixture.clientA, ['switch', '-c', branch]);
  replaceBacklogRow(context.fixture.clientA, (line) => line.replace('📋 Prod Planning', '✔️ Done'));
  writeFileSync(join(context.requirementDir, 'COMPLETION.json'), JSON.stringify({
    schemaVersion: 1,
    requirementId: REQUIREMENT_ID,
    deliveryProfile: 'tooling',
    mergedCommit: base,
  }, null, 2));
  runGit(context.fixture.clientA, ['add', 'BACKLOG.md', `docs/product/current/${REQUIREMENT_ID}-gate-fixture/COMPLETION.json`]);
  runGit(context.fixture.clientA, ['commit', '-m', 'test: complete prod-stage requirement']);
  await context.store.update({
    operation: `mark ${REQUIREMENT_ID} done`,
    mutate(snapshot) {
      const path = `requirements/${REQUIREMENT_ID}.json`;
      snapshot.writeJson(path, {
        ...snapshot.readJson(path),
        lifecycle: 'done',
        mergeStatus: 'merged',
        mergedCommit: base,
      });
    },
  });
  const head = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  const result = await validateRepositoryGate({
    cwd: context.fixture.clientA,
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
  assert.equal(result.valid, true);
  assert.equal(result.kind, 'completion');
});

test('I-119: done requirement docs-only change is treated as zero-id release-docs', async (t) => {
  const context = await setupFeatureGate(t);
  const merged = mergeFeatureToMain(context);
  await context.store.update({
    operation: `mark ${REQUIREMENT_ID} done`,
    mutate(snapshot) {
      const path = `requirements/${REQUIREMENT_ID}.json`;
      snapshot.writeJson(path, {
        ...snapshot.readJson(path),
        lifecycle: 'done',
        mergeStatus: 'merged',
        mergedCommit: merged,
      });
    },
  });
  const branch = 'chore/i-002-docs-final-checkoff';
  runGit(context.fixture.clientA, ['switch', 'main']);
  runGit(context.fixture.clientA, ['switch', '-c', branch]);
  writeFileSync(
    join(context.fixture.clientA, 'docs', 'product', 'current', `${REQUIREMENT_ID}-gate-fixture`, 'CHECKLIST.md'),
    '# final checkoff\n',
  );
  runGit(context.fixture.clientA, ['add', 'docs']);
  runGit(context.fixture.clientA, ['commit', '-m', 'docs: final checklist checkoff']);
  const head = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  const result = await validateRepositoryGate({
    cwd: context.fixture.clientA,
    store: context.store,
    event: {
      pull_request: {
        head: { ref: branch, sha: head },
        base: { ref: 'main', sha: merged },
      },
    },
    head,
    base: 'origin/main',
  });
  assert.equal(result.kind, 'release-docs');
  assert.equal(result.valid, true);
});

test('I-119: done requirement docs change with BACKLOG row edit is still detected', async (t) => {
  const context = await setupFeatureGate(t);
  const merged = mergeFeatureToMain(context);
  await context.store.update({
    operation: `mark ${REQUIREMENT_ID} done`,
    mutate(snapshot) {
      const path = `requirements/${REQUIREMENT_ID}.json`;
      snapshot.writeJson(path, {
        ...snapshot.readJson(path),
        lifecycle: 'done',
        mergeStatus: 'merged',
        mergedCommit: merged,
      });
    },
  });
  const branch = 'chore/i-002-docs-with-row-edit';
  runGit(context.fixture.clientA, ['switch', 'main']);
  runGit(context.fixture.clientA, ['switch', '-c', branch]);
  writeFileSync(
    join(context.fixture.clientA, 'docs', 'product', 'current', `${REQUIREMENT_ID}-gate-fixture`, 'CHECKLIST.md'),
    '# final checkoff\n',
  );
  replaceBacklogRow(context.fixture.clientA, (line) => `${line.slice(0, -1)}（done 备注微调） |`);
  runGit(context.fixture.clientA, ['add', 'docs', 'BACKLOG.md']);
  runGit(context.fixture.clientA, ['commit', '-m', 'docs: checklist + backlog note edit']);
  const head = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  await assert.rejects(
    validateRepositoryGate({
      cwd: context.fixture.clientA,
      store: context.store,
      event: {
        pull_request: {
          head: { ref: branch, sha: head },
          base: { ref: 'main', sha: merged },
        },
      },
      head,
      base: 'origin/main',
    }),
    (error) => error.code === 'GATE_FAILED',
  );
});

test('I-119: non-done requirement docs change still detects the requirement id', async (t) => {
  const context = await setupFeatureGate(t);
  const merged = mergeFeatureToMain(context);
  const branch = 'chore/i-002-docs-not-done';
  runGit(context.fixture.clientA, ['switch', 'main']);
  runGit(context.fixture.clientA, ['switch', '-c', branch]);
  writeFileSync(
    join(context.fixture.clientA, 'docs', 'product', 'current', `${REQUIREMENT_ID}-gate-fixture`, 'CHECKLIST.md'),
    '# not-done docs change\n',
  );
  runGit(context.fixture.clientA, ['add', 'docs']);
  runGit(context.fixture.clientA, ['commit', '-m', 'docs: not-done docs change']);
  const head = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  const result = await validateRepositoryGate({
    cwd: context.fixture.clientA,
    store: context.store,
    event: {
      pull_request: {
        head: { ref: branch, sha: head },
        base: { ref: 'main', sha: merged },
      },
    },
    head,
    base: 'origin/main',
  }).catch((error) => error);
  const kind = result?.data?.kind ?? result?.kind ?? null;
  assert.notEqual(kind, 'release-docs');
});
