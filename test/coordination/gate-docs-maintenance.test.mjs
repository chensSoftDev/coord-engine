import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { validateRepositoryGate } from '../../lib/coordination/gate.mjs';
import { declareRequirementResources } from '../../lib/coordination/requirements.mjs';
import { REQUIREMENT_ID, replaceBacklogRow, setupFeatureGate, expectGateFailure, mergeFeatureToMain, commitToMain, appendBacklogRow, writeDocument, docsMaintenanceGate } from './gate-fixtures.mjs';

test('I-257: pre-coordination Done requirement docs change is treated as zero-id release-docs', async (t) => {
  const context = await setupFeatureGate(t);
  mergeFeatureToMain(context);
  const base = commitToMain(context, 'docs: seed a pre-coordination requirement', (cwd) => {
    appendBacklogRow(cwd, '| F-001 | Legacy fixture | 否 | ✔️ Done | v0.1.0 | released before coordination |');
    writeDocument(cwd, 'docs/product/current/F-001-legacy-fixture/TECH_DESIGN.md', '# legacy design\n');
  });
  const result = await docsMaintenanceGate(context, {
    base,
    branch: 'chore/f-001-legacy-docs',
    path: 'docs/product/current/F-001-legacy-fixture/IMPLEMENTATION_PLAN.md',
  });
  assert.equal(result.kind, 'release-docs');
  assert.equal(result.valid, true);
});

test('I-257: completion fact on main exempts docs changes despite a lagging coordination record', async (t) => {
  const context = await setupFeatureGate(t);
  const merged = mergeFeatureToMain(context);
  // coordination 仍停在 test_passed（I-082 形态），终态由 main 上的 BACKLOG Done 与完成事实证明
  const base = commitToMain(context, 'docs: complete without advancing coordination', (cwd) => {
    replaceBacklogRow(cwd, (line) => line.replace('✅ Test Passed', '✔️ Done'));
    writeDocument(cwd, `docs/product/current/${REQUIREMENT_ID}-gate-fixture/COMPLETION.json`, `${JSON.stringify({
      schemaVersion: 1,
      requirementId: REQUIREMENT_ID,
      deliveryProfile: 'tooling',
      mergedCommit: merged,
    })}\n`);
  });
  const result = await docsMaintenanceGate(context, {
    base,
    branch: 'chore/i-002-lagging-docs',
    path: `docs/product/current/${REQUIREMENT_ID}-gate-fixture/CHECKLIST.md`,
  });
  assert.equal(result.kind, 'release-docs');
  assert.equal(result.valid, true);
});

test('I-257: a requirement absent from coordination without a Done row is still rejected', async (t) => {
  const context = await setupFeatureGate(t);
  mergeFeatureToMain(context);
  const base = commitToMain(context, 'docs: seed an unclaimed in-progress row', (cwd) => {
    appendBacklogRow(cwd, '| F-001 | Unclaimed fixture | 否 | 🔨 In Dev | v0.1.0 | never claimed |');
    writeDocument(cwd, 'docs/product/current/F-001-legacy-fixture/TECH_DESIGN.md', '# design\n');
  });
  await assert.rejects(
    docsMaintenanceGate(context, {
      base,
      branch: 'chore/f-001-unclaimed-docs',
      path: 'docs/product/current/F-001-legacy-fixture/IMPLEMENTATION_PLAN.md',
    }),
    (error) => error.code === 'GATE_FAILED' && error.data.failures.some((item) => (
      item.code === 'REQUIREMENT_NOT_CLAIMED' && item.requirementId === 'F-001'
    )),
  );
});

test('I-257: a Done row without its own completion fact keeps a coordination requirement detected', async (t) => {
  const context = await setupFeatureGate(t);
  mergeFeatureToMain(context);
  const base = commitToMain(context, 'docs: project Done without a matching completion fact', (cwd) => {
    replaceBacklogRow(cwd, (line) => line.replace('✅ Test Passed', '✔️ Done'));
    // 目录内的完成事实属于其他需求，不能替本需求证明终态
    writeDocument(cwd, `docs/product/current/${REQUIREMENT_ID}-gate-fixture/COMPLETION.json`, `${JSON.stringify({
      schemaVersion: 1,
      requirementId: 'I-999',
    })}\n`);
  });
  await assert.rejects(
    docsMaintenanceGate(context, {
      base,
      branch: 'chore/i-002-unproven-done',
      path: `docs/product/current/${REQUIREMENT_ID}-gate-fixture/CHECKLIST.md`,
    }),
    (error) => error.code === 'GATE_FAILED'
      && error.data.failures.some((item) => item.requirementId === REQUIREMENT_ID),
  );
});

test('I-257: pre-coordination Done requirement docs change with a BACKLOG row edit is still detected', async (t) => {
  const context = await setupFeatureGate(t);
  mergeFeatureToMain(context);
  const base = commitToMain(context, 'docs: seed a pre-coordination requirement', (cwd) => {
    appendBacklogRow(cwd, '| F-001 | Legacy fixture | 否 | ✔️ Done | v0.1.0 | released before coordination |');
    writeDocument(cwd, 'docs/product/current/F-001-legacy-fixture/TECH_DESIGN.md', '# legacy design\n');
  });
  await assert.rejects(
    docsMaintenanceGate(context, {
      base,
      branch: 'chore/f-001-docs-with-row-edit',
      path: 'docs/product/current/F-001-legacy-fixture/IMPLEMENTATION_PLAN.md',
      prepare(cwd) {
        const backlog = join(cwd, 'BACKLOG.md');
        writeFileSync(backlog, readFileSync(backlog, 'utf8')
          .replace('released before coordination |', 'released before coordination (note edit) |'));
      },
    }),
    (error) => error.code === 'GATE_FAILED' && error.data.failures.some((item) => (
      item.code === 'REQUIREMENT_NOT_CLAIMED' && item.requirementId === 'F-001'
    )),
  );
});

test('I-257: rewriting a lagging requirement completion fact keeps the requirement detected', async (t) => {
  const context = await setupFeatureGate(t);
  const merged = mergeFeatureToMain(context);
  const completionPath = `docs/product/current/${REQUIREMENT_ID}-gate-fixture/COMPLETION.json`;
  const base = commitToMain(context, 'docs: complete without advancing coordination', (cwd) => {
    replaceBacklogRow(cwd, (line) => line.replace('✅ Test Passed', '✔️ Done'));
    writeDocument(cwd, completionPath, `${JSON.stringify({
      schemaVersion: 1,
      requirementId: REQUIREMENT_ID,
      deliveryProfile: 'tooling',
      mergedCommit: merged,
    })}\n`);
  });
  // 完成事实是机器产物：纯文档 PR 改写它时不适用终态口径，按原规则检出本需求
  await assert.rejects(
    docsMaintenanceGate(context, { base, branch: 'chore/i-002-rewrite-completion', path: completionPath }),
    (error) => error.code === 'GATE_FAILED'
      && error.data.failures.some((item) => item.requirementId === REQUIREMENT_ID),
  );
});

// I-269：E2E 套件与集成测试树是测试基建，不是 runtime 服务面——tooling profile 放行。
test('feature gate accepts E2E suite, integration-test and isolated-compose paths for a tooling profile', async (t) => {
  const context = await setupFeatureGate(t, {
    runtimePath: [
      'apps/admin/e2e/README.md',
      'apps/admin/e2e/i230-responsive-smoke.spec.ts',
      'apps/admin/e2e/helpers/cleanup.ts',
      'apps/api/test-integration/README.md',
      'docker-compose.e2e.yml',
      'scripts/run-b231-isolated-ui-regressions.sh',
      'deploy/mysql-e2e.env.example',
    ],
    baseScripts: { coord: 'node scripts/coordination.mjs', 'test:e2e:local': 'node scripts/local-e2e.mjs --local' },
    featureScripts: { coord: 'node scripts/coordination.mjs' },
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
        'apps/admin/e2e/README.md',
        'apps/admin/e2e/i230-responsive-smoke.spec.ts',
        'apps/admin/e2e/helpers/cleanup.ts',
        'apps/api/test-integration/README.md',
        'docker-compose.e2e.yml',
        'scripts/run-b231-isolated-ui-regressions.sh',
        'deploy/mysql-e2e.env.example',
      ],
    },
  });
  const result = await validateRepositoryGate({ cwd: context.fixture.clientA, store: context.store,
    event: context.event, head: context.head, base: 'origin/main' });
  assert.equal(result.valid, true);
});

// I-269：退役脚本条目属于 scripts-only 变更；test:coordination 仍受保护不可删。
test('tooling gate allows retiring a non-coordination script but still protects test:coordination', async (t) => {
  const baseScripts = { coord: 'node scripts/coordination.mjs', 'test:e2e:local': 'node scripts/local-e2e.mjs --local', 'test:coordination': 'node --test scripts/test/coordination/*.test.mjs' };
  const retire = await setupFeatureGate(t, {
    baseScripts,
    featureScripts: { coord: 'node scripts/coordination.mjs', 'test:coordination': 'node --test scripts/test/coordination/*.test.mjs' },
  });
  assert.equal((await validateRepositoryGate({ cwd: retire.fixture.clientA, store: retire.store,
    event: retire.event, head: retire.head, base: 'origin/main' })).valid, true);
  const gutted = await setupFeatureGate(t, {
    baseScripts,
    featureScripts: { coord: 'node scripts/coordination.mjs', 'test:e2e:local': 'node scripts/local-e2e.mjs --local' },
  });
  await expectGateFailure(gutted, 'PROFILE_PATH_MISMATCH');
});

// I-269：隔离栈 compose 豁免不外溢——dev/prod compose 仍属 runtime 面。
test('feature gate still rejects dev/prod compose files under a tooling profile', async (t) => {
  const context = await setupFeatureGate(t, { runtimePath: ['docker-compose.dev.yml', 'docker-compose.prod.yml'] });
  await expectGateFailure(context, 'PROFILE_PATH_MISMATCH');
});
