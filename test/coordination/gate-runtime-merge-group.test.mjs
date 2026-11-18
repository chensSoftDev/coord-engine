import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { runRequiredTests } from '../../lib/coordination/evidence.mjs';
import { validateRepositoryGate } from '../../lib/coordination/gate.mjs';
import { declareRequirementResources } from '../../lib/coordination/requirements.mjs';
import { runGit } from './fixtures.mjs';
import { REQUIREMENT_ID, setupFeatureGate, expectGateFailure } from './gate-fixtures.mjs';

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
