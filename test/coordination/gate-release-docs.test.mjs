import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { validateRepositoryGate } from '../../lib/coordination/gate.mjs';
import { runGit } from './fixtures.mjs';
import { REQUIREMENT_ID, replaceBacklogRow, setupFeatureGate, expectGateFailure, mergeFeatureToMain, setupReleaseDocsGate } from './gate-fixtures.mjs';

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

// I-257：终态需求（main 已含 COMPLETION.json，或 coordination 启用前即 ✔️ Done 的老需求）
// 的文档目录维护不检出 id，按零 id 纯文档放行；终态只认 base 事实，否则照旧检出。
