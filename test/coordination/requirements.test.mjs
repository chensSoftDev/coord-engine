import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

import { GitCoordinationStore } from '../../lib/coordination/git-store.mjs';
import { main } from '../../lib/coordination/cli.mjs';
import { acquireLease } from '../../lib/coordination/leases.mjs';
import { BACKLOG_STATUSES } from '../../lib/coordination/lifecycle.mjs';
import {
  applyCompletionPatch,
  bindRequirementBranch,
  bindRequirementVersion,
  cancelRequirement,
  claimRequirement,
  declareRequirementResources,
  inferRequirementResources,
  nextRequirementId,
  planRequirementCompletion,
  readCoordinationStatus,
  showRequirement,
  startRequirement,
} from '../../lib/coordination/requirements.mjs';
import { initializeSession } from '../../lib/coordination/worktrees.mjs';
import { createGitFixture, createMemoryIo, runGit } from './fixtures.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const COORDINATION_SCRIPT = resolve(TEST_DIR, '../../scripts/coordination.mjs');

function createStore(cwd, tempRoot) {
  return new GitCoordinationStore({
    cwd,
    remote: 'origin',
    branch: 'coordination',
    tempRoot,
    clock: () => new Date('2026-07-17T00:00:00.000Z'),
  });
}

function runCoordination(args, env) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [COORDINATION_SCRIPT, ...args], {
      cwd: dirname(COORDINATION_SCRIPT),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolveResult({ status, stdout, stderr }));
  });
}

test('chooses the next global number from backlog and coordination state', async (t) => {
  const fixture = createGitFixture(t);
  const store = createStore(fixture.clientA, fixture.tempRoot);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const snapshot = await store.readSnapshot();

  assert.equal(nextRequirementId({
    type: 'F',
    backlogText: '| I-057 | existing |\n| B-060 | existing |\n',
    snapshot,
  }), 'F-061');
});

test('allows multiple requirements in a version but rejects silent rebinding', async (t) => {
  const fixture = createGitFixture(t);
  const store = createStore(fixture.clientA, fixture.tempRoot);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const backlogText = '| I-001 | fixture |\n';
  const first = await claimRequirement({
    store,
    type: 'I',
    title: 'First',
    profile: 'tooling',
    backlogText,
  });
  const second = await claimRequirement({
    store,
    type: 'F',
    title: 'Second',
    profile: 'runtime',
    backlogText,
  });

  await bindRequirementVersion({ store, id: first.id, version: 'v0.2.32' });
  await bindRequirementVersion({ store, id: second.id, version: 'v0.2.32' });
  await assert.rejects(
    bindRequirementVersion({ store, id: first.id, version: 'v0.2.33' }),
    (error) => error.code === 'VERSION_ALREADY_BOUND' && error.exitCode === 14,
  );

  const snapshot = await store.readSnapshot();
  assert.deepEqual(
    snapshot.readJson('versions/v0.2.32.json').requirements,
    [first.id, second.id].sort(),
  );
  assert.equal(snapshot.has('versions/v0.2.33.json'), false);
});

test('declares resources and warns about explicit overlaps', async (t) => {
  const fixture = createGitFixture(t);
  const store = createStore(fixture.clientA, fixture.tempRoot);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const backlogText = '| I-001 | fixture |\n';
  const first = await claimRequirement({
    store, type: 'I', title: 'First', profile: 'tooling', backlogText,
  });
  const second = await claimRequirement({
    store, type: 'I', title: 'Second', profile: 'tooling', backlogText,
  });
  await declareRequirementResources({
    store,
    id: first.id,
    resources: { files: ['scripts/**'], sharedResources: ['ci'] },
  });

  const result = await declareRequirementResources({
    store,
    id: second.id,
    resources: { files: ['scripts/**', 'docs/ops/**'], sharedResources: ['ci'] },
  });

  assert.deepEqual(result.warnings, [{
    requirementId: first.id,
    overlaps: {
      files: ['scripts/**'],
      sharedResources: ['ci'],
    },
  }]);
});

test('B-248: AGENTS.md is a shared coordination document and never a resource conflict', async (t) => {
  const fixture = createGitFixture(t);
  const store = createStore(fixture.clientA, fixture.tempRoot);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const backlogText = '| I-001 | fixture |\n';
  const first = await claimRequirement({
    store, type: 'I', title: 'Protocol doc editor', profile: 'tooling', backlogText,
  });
  const second = await claimRequirement({
    store, type: 'I', title: 'Another protocol doc editor', profile: 'tooling', backlogText,
  });
  await declareRequirementResources({
    store, id: first.id, resources: { files: ['AGENTS.md', 'scripts/lib/x.mjs'] },
  });
  const result = await declareRequirementResources({
    store, id: second.id, resources: { files: ['AGENTS.md', 'scripts/lib/x.mjs'] },
  });
  // AGENTS.md overlaps are dropped (same exemption as BACKLOG.md); a real
  // shared code path still conflicts.
  assert.equal(
    result.warnings.some((warning) => JSON.stringify(warning.overlaps).includes('AGENTS.md')),
    false,
    'AGENTS.md must never appear in resource overlap warnings',
  );
  assert.equal(
    result.warnings.some((warning) => JSON.stringify(warning.overlaps).includes('scripts/lib/x.mjs')),
    true,
    'non-exempt overlapping files still warn',
  );
});

test('resource warnings ignore requirements whose runtime merge is already recorded', async (t) => {
  const fixture = createGitFixture(t);
  const store = createStore(fixture.clientA, fixture.tempRoot);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const backlogText = '| I-001 | fixture |\n';
  const first = await claimRequirement({
    store, type: 'I', title: 'Merged runtime', profile: 'runtime', backlogText,
  });
  const second = await claimRequirement({
    store, type: 'I', title: 'Current tooling', profile: 'tooling', backlogText,
  });
  await declareRequirementResources({
    store,
    id: first.id,
    resources: { files: ['scripts/**'] },
  });
  await store.update({
    operation: 'record runtime merge fact',
    mutate(snapshot) {
      const path = `requirements/${first.id}.json`;
      snapshot.writeJson(path, {
        ...snapshot.readJson(path),
        lifecycle: 'test_passed',
        mergeStatus: 'merged',
        mergedCommit: '1'.repeat(40),
      });
    },
  });

  const result = await declareRequirementResources({
    store,
    id: second.id,
    resources: { files: ['scripts/**'] },
  });

  assert.deepEqual(result.warnings, []);
});

test('resource warnings keep an invalid merged fact active', async (t) => {
  const fixture = createGitFixture(t);
  const store = createStore(fixture.clientA, fixture.tempRoot);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const backlogText = '| I-001 | fixture |\n';
  const first = await claimRequirement({
    store, type: 'I', title: 'Invalid merged fact', profile: 'runtime', backlogText,
  });
  const second = await claimRequirement({
    store, type: 'I', title: 'Current tooling', profile: 'tooling', backlogText,
  });
  await declareRequirementResources({
    store,
    id: first.id,
    resources: { files: ['scripts/**'] },
  });
  await store.update({
    operation: 'record incomplete runtime merge fact',
    mutate(snapshot) {
      const path = `requirements/${first.id}.json`;
      snapshot.writeJson(path, {
        ...snapshot.readJson(path),
        lifecycle: 'test_passed',
        mergeStatus: 'merged',
      });
    },
  });

  const result = await declareRequirementResources({
    store,
    id: second.id,
    resources: { files: ['scripts/**'] },
  });

  assert.deepEqual(result.warnings.map(({ requirementId }) => requirementId), [first.id]);
});

test('declares requirement dependencies and rejects missing or cyclic edges', async (t) => {
  const fixture = createGitFixture(t);
  const store = createStore(fixture.clientA, fixture.tempRoot);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const first = await claimRequirement({
    store, type: 'I', title: 'Dependency root', profile: 'tooling', backlogText: '| I-001 | fixture |\n',
  });
  const second = await claimRequirement({
    store, type: 'I', title: 'Dependency leaf', profile: 'tooling', backlogText: '| I-001 | fixture |\n',
  });

  await declareRequirementResources({
    store,
    id: second.id,
    resources: { files: ['docs/**'] },
    dependsOn: [first.id],
  });
  assert.deepEqual(
    (await store.readSnapshot()).readJson(`requirements/${second.id}.json`).dependsOn,
    [first.id],
  );

  await assert.rejects(
    declareRequirementResources({
      store,
      id: first.id,
      resources: {},
      dependsOn: ['I-999'],
    }),
    (error) => error.code === 'DEPENDENCY_NOT_FOUND',
  );
  await assert.rejects(
    declareRequirementResources({
      store,
      id: first.id,
      resources: {},
      dependsOn: [second.id],
    }),
    (error) => error.code === 'DEPENDENCY_CYCLE',
  );
});

test('two independent CLI processes claim distinct ids against one remote', async (t) => {
  const fixture = createGitFixture(t);
  const store = createStore(fixture.clientA, fixture.tempRoot);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const commonEnv = {
    COORD_REMOTE: 'origin',
    COORD_BRANCH: 'coordination',
    COORD_TEMP_ROOT: fixture.tempRoot,
    COORD_AGENT: 'test-agent',
    COORD_USER: 'tester',
    COORD_HOST: 'test-host',
  };

  const [first, second] = await Promise.all([
    runCoordination([
      'requirement', 'claim', '--type', 'I', '--title', 'Concurrent A',
      '--profile', 'tooling', '--ux-impact', 'none', '--json',
    ], { ...commonEnv, COORD_CWD: fixture.clientA }),
    runCoordination([
      'requirement', 'claim', '--type', 'I', '--title', 'Concurrent B',
      '--profile', 'tooling', '--ux-impact', 'none', '--json',
    ], { ...commonEnv, COORD_CWD: fixture.clientB }),
  ]);

  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  const ids = [
    JSON.parse(first.stdout).data.requirementId,
    JSON.parse(second.stdout).data.requirementId,
  ].sort();
  assert.deepEqual(ids, ['I-002', 'I-003']);

  const statusResult = await runCoordination(
    ['status', '--json'],
    { ...commonEnv, COORD_CWD: fixture.clientA },
  );
  assert.equal(statusResult.status, 0, statusResult.stderr);
  const status = JSON.parse(statusResult.stdout);
  assert.equal(status.data.initialized, true);
  assert.deepEqual(
    status.data.requirements.map(({ id }) => id).sort(),
    ['I-002', 'I-003'],
  );

  const invalidProfile = await runCoordination([
    'requirement', 'claim', '--type', 'I', '--title', 'Invalid profile',
    '--profile', 'docs', '--ux-impact', 'none', '--json',
  ], { ...commonEnv, COORD_CWD: fixture.clientA });
  assert.equal(invalidProfile.status, 14);
  assert.equal(JSON.parse(invalidProfile.stderr).code, 'INVALID_DELIVERY_PROFILE');
});

test('status exposes requirements, versions, and empty locks', async (t) => {
  const fixture = createGitFixture(t);
  const store = createStore(fixture.clientA, fixture.tempRoot);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const claimed = await claimRequirement({
    store,
    type: 'I',
    title: 'Status item',
    profile: 'governance',
    backlogText: '| I-001 | fixture |\n',
  });
  await bindRequirementVersion({ store, id: claimed.id, version: 'v0.2.32' });

  const status = await readCoordinationStatus(store);

  assert.equal(status.initialized, true);
  assert.equal(status.requirements[0].id, claimed.id);
  assert.deepEqual(status.versions, [{
    version: 'v0.2.32',
    requirements: [claimed.id],
  }]);
  assert.deepEqual(status.locks, {});
});


test('CLI imports an existing active backlog requirement from the initialization baseline', async (t) => {
  const fixture = createGitFixture(t);
  writeFileSync(join(fixture.clientA, 'BACKLOG.md'), [
    '| ID | 需求描述 | 需迁移 | 当前状态 | Version | 备注 |',
    '|----|----------|--------|----------|---------|------|',
    '| I-057 | Bootstrap coordination | 是 | 🔨 In Dev | v0.2.32 | active before coordination |',
    '',
  ].join('\n'));
  runGit(fixture.clientA, ['add', 'BACKLOG.md']);
  runGit(fixture.clientA, ['commit', '-m', 'test: seed existing requirement']);
  const store = createStore(fixture.clientA, fixture.tempRoot);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  writeFileSync(join(fixture.clientA, 'BACKLOG.md'), [
    '| ID | 需求描述 | 需迁移 | 当前状态 | Version | 备注 |',
    '|----|----------|--------|----------|---------|------|',
    '| I-057 | Bootstrap coordination | 是 | 🔨 In Dev | v0.2.32 | active before coordination |',
    '| I-058 | Added after coordination | 否 | 🔨 In Dev | v0.2.32 | must use claim instead |',
    '',
  ].join('\n'));
  const env = {
    COORD_CWD: fixture.clientA,
    COORD_REMOTE: 'origin',
    COORD_BRANCH: 'coordination',
    COORD_TEMP_ROOT: fixture.tempRoot,
    COORD_AGENT: 'codex',
    COORD_USER: 'tester',
    COORD_HOST: 'fixture',
  };

  const imported = await runCoordination([
    'requirement', 'import-existing', 'I-057',
    '--profile', 'tooling',
    '--branch', 'feature/v0.2.32/cross-agent-coordination',
    '--json',
  ], env);

  assert.equal(imported.status, 0, imported.stderr);
  const snapshot = await store.readSnapshot();
  const requirement = snapshot.readJson('requirements/I-057.json');
  assert.equal(requirement.title, 'Bootstrap coordination');
  assert.equal(requirement.lifecycle, 'in_dev');
  assert.equal(requirement.version, 'v0.2.32');
  assert.equal(requirement.deliveryProfile, 'tooling');
  assert.equal(requirement.branch, 'feature/v0.2.32/cross-agent-coordination');
  assert.deepEqual(snapshot.readJson('versions/v0.2.32.json').requirements, ['I-057']);

  const missing = await runCoordination([
    'requirement', 'import-existing', 'I-058',
    '--profile', 'tooling',
    '--branch', 'feature/v0.2.32/not-in-baseline',
    '--json',
  ], env);
  assert.equal(missing.status, 14);
  assert.equal(JSON.parse(missing.stderr).code, 'REQUIREMENT_NOT_IN_BASELINE');
});

// ============================================================================
// I-113（用户合并分支授权）：`bindRequirementBranch` 把 requirement 绑定到
// 指定 feature 分支。已绑定不同分支时默认 fail closed（BRANCH_ALREADY_BOUND），
// `force: true` 允许显式改绑（用于多需求合并到同一分支后统一 gate）。
// ============================================================================

test('bindRequirementBranch binds an unbound requirement and refuses conflicting rebinds', async (t) => {
  const fixture = createGitFixture(t);
  const store = new GitCoordinationStore({
    cwd: fixture.clientA,
    remote: 'origin',
    branch: 'coordination',
    tempRoot: fixture.tempRoot,
    clock: () => new Date('2026-08-14T00:00:00.000Z'),
  });
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const claimed = await claimRequirement({
    store,
    type: 'I',
    title: 'Bind branch requirement',
    profile: 'tooling',
    backlogText: '| I-001 | fixture |\n',
  });

  const bound = await bindRequirementBranch({
    store,
    id: claimed.id,
    branch: 'feature/v0.9.1/merged-branch',
  });
  assert.equal(bound.branch, 'feature/v0.9.1/merged-branch');
  const snapshot = await store.readSnapshot();
  assert.equal(
    snapshot.readJson(`requirements/${claimed.id}.json`).branch,
    'feature/v0.9.1/merged-branch',
  );

  // A conflicting rebind without force fails closed and leaves the binding.
  await assert.rejects(
    bindRequirementBranch({
      store,
      id: claimed.id,
      branch: 'feature/v0.9.1/other-branch',
    }),
    (error) => error.code === 'BRANCH_ALREADY_BOUND' && error.exitCode === 14,
  );
  const after = await store.readSnapshot();
  assert.equal(
    after.readJson(`requirements/${claimed.id}.json`).branch,
    'feature/v0.9.1/merged-branch',
    'the original binding must survive a rejected rebind',
  );

  // An explicit force rebind updates the binding (multi-requirement merge).
  const forced = await bindRequirementBranch({
    store,
    id: claimed.id,
    branch: 'feature/v0.9.1/merged-branch',
    force: true,
  });
  assert.equal(forced.branch, 'feature/v0.9.1/merged-branch');
});

test('bindRequirementBranch rejects invalid branch names and unknown requirements', async (t) => {
  const fixture = createGitFixture(t);
  const store = new GitCoordinationStore({
    cwd: fixture.clientA,
    remote: 'origin',
    branch: 'coordination',
    tempRoot: fixture.tempRoot,
    clock: () => new Date('2026-08-14T00:00:00.000Z'),
  });
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const claimed = await claimRequirement({
    store,
    type: 'I',
    title: 'Bind branch invalid',
    profile: 'tooling',
    backlogText: '| I-001 | fixture |\n',
  });

  for (const branch of ['HEAD', 'abc1234', 'feature with space']) {
    await assert.rejects(
      bindRequirementBranch({ store, id: claimed.id, branch }),
      (error) => error.code === 'INVALID_REQUIREMENT_BRANCH' && error.exitCode === 14,
    );
  }
  await assert.rejects(
    bindRequirementBranch({ store, id: 'I-999', branch: 'feature/v0.9.1/x' }),
    (error) => error.code === 'REQUIREMENT_NOT_FOUND' && error.exitCode === 14,
  );
});


// I-128 (M7): status must show every blocking fact in one call, and a single
// requirement must be queryable without pulling the full status document.
test('status aggregates blocking facts and requirement show reads one requirement', async (t) => {
  const fixture = createGitFixture(t);
  const store = createStore(fixture.clientA, fixture.tempRoot);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const claimed = await claimRequirement({
    store,
    type: 'I',
    title: 'Status requirement',
    profile: 'tooling',
    backlogText: '| I-001 | fixture |\n',
  });
  await store.update({
    operation: 'seed status facts',
    mutate(snapshot) {
      snapshot.writeJson('locks/prod-build.json', { schemaVersion: 1, active: null, lastEvent: null });
      snapshot.writeJson('freezes/dev.json', {
        schemaVersion: 1,
        requirementId: claimed.id,
        state: 'awaiting_human',
      });
      snapshot.writeJson('regressions/red.json', { schemaVersion: 1, classification: 'infra_flaky' });
      snapshot.writeJson(`release-approvals/${claimed.id}.json`, {
        schemaVersion: 1,
        requirementId: claimed.id,
        revoked: false,
      });
    },
  });

  const status = await readCoordinationStatus(store);
  assert.equal(status.freeze.requirementId, claimed.id);
  assert.equal(status.regression.classification, 'infra_flaky');
  assert.ok('prod-build' in status.locks);
  assert.equal(status.releaseApprovals[claimed.id].requirementId, claimed.id);

  const shown = await showRequirement({ store, id: claimed.id });
  assert.equal(shown.id, claimed.id);
  assert.equal(shown.title, 'Status requirement');
  await assert.rejects(showRequirement({ store, id: 'I-999' }), /requirement is not claimed/);
});

// ============================================================================
// I-130 (D2): 版本自动计算——bind-version 支持 --bump / --join-version /
// 精确版本三种互斥模式，versions/ 注册表写入统一走 registerVersionMembership。
// ============================================================================

async function claimAndBind(store, title, version) {
  const claimed = await claimRequirement({
    store,
    type: 'I',
    title,
    profile: 'tooling',
    backlogText: '| I-001 | fixture |\n',
  });
  await bindRequirementVersion({ store, id: claimed.id, version });
  return claimed.id;
}

test('bind-version --bump computes from the numeric semver maximum, not lexicographic', async (t) => {
  const fixture = createGitFixture(t);
  const store = createStore(fixture.clientA, fixture.tempRoot);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  // Lexicographic order would pick v0.9.9 as the maximum; numeric semver
  // comparison must pick v0.10.0.
  await claimAndBind(store, 'Older minor', 'v0.9.9');
  await claimAndBind(store, 'Newer minor', 'v0.10.0');

  const patched = await claimRequirement({
    store, type: 'I', title: 'Patched', profile: 'tooling', backlogText: '| I-001 | fixture |\n',
  });
  const patchResult = await bindRequirementVersion({ store, id: patched.id, bump: 'patch' });
  assert.equal(patchResult.version, 'v0.10.1');
  assert.deepEqual(
    (await store.readSnapshot()).readJson('versions/v0.10.1.json').requirements,
    [patched.id],
  );

  const minored = await claimRequirement({
    store, type: 'I', title: 'Minored', profile: 'tooling', backlogText: '| I-001 | fixture |\n',
  });
  assert.equal(
    (await bindRequirementVersion({ store, id: minored.id, bump: 'minor' })).version,
    'v0.11.0',
  );

  const majored = await claimRequirement({
    store, type: 'I', title: 'Majored', profile: 'tooling', backlogText: '| I-001 | fixture |\n',
  });
  assert.equal(
    (await bindRequirementVersion({ store, id: majored.id, bump: 'major' })).version,
    'v1.0.0',
  );
});

test('bind-version --bump on an empty registry starts from the v0.0.0 floor', async (t) => {
  const fixture = createGitFixture(t);
  const store = createStore(fixture.clientA, fixture.tempRoot);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const claimed = await claimRequirement({
    store, type: 'I', title: 'First ever', profile: 'tooling', backlogText: '| I-001 | fixture |\n',
  });

  const result = await bindRequirementVersion({ store, id: claimed.id, bump: 'patch' });

  assert.equal(result.version, 'v0.0.1');
  assert.deepEqual(
    (await store.readSnapshot()).readJson('versions/v0.0.1.json').requirements,
    [claimed.id],
  );
});

test('bind-version --bump rejects an unknown bump level and a second binding', async (t) => {
  const fixture = createGitFixture(t);
  const store = createStore(fixture.clientA, fixture.tempRoot);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const claimed = await claimRequirement({
    store, type: 'I', title: 'Bump validation', profile: 'tooling', backlogText: '| I-001 | fixture |\n',
  });

  await assert.rejects(
    bindRequirementVersion({ store, id: claimed.id, bump: 'hotfix' }),
    (error) => error.code === 'INVALID_VERSION_BUMP',
  );
  await assert.rejects(
    bindRequirementVersion({ store, id: claimed.id }),
    (error) => error.code === 'INVALID_VERSION_OPTIONS',
  );
  await assert.rejects(
    bindRequirementVersion({ store, id: claimed.id, version: 'v0.1.0', bump: 'patch' }),
    (error) => error.code === 'INVALID_VERSION_OPTIONS',
  );
});

test('bind-version --join-version joins a registered version or fails VERSION_NOT_FOUND', async (t) => {
  const fixture = createGitFixture(t);
  const store = createStore(fixture.clientA, fixture.tempRoot);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const first = await claimAndBind(store, 'Registered', 'v0.10.0');
  const second = await claimRequirement({
    store, type: 'I', title: 'Joiner', profile: 'tooling', backlogText: '| I-001 | fixture |\n',
  });

  const joined = await bindRequirementVersion({ store, id: second.id, joinVersion: 'v0.10.0' });
  assert.equal(joined.version, 'v0.10.0');
  assert.deepEqual(
    (await store.readSnapshot()).readJson('versions/v0.10.0.json').requirements,
    [first, second.id].sort(),
  );

  const third = await claimRequirement({
    store, type: 'I', title: 'Missing joiner', profile: 'tooling', backlogText: '| I-001 | fixture |\n',
  });
  await assert.rejects(
    bindRequirementVersion({ store, id: third.id, joinVersion: 'v9.9.9' }),
    (error) => error.code === 'VERSION_NOT_FOUND' && error.exitCode === 12,
  );
  assert.equal((await store.readSnapshot()).has('versions/v9.9.9.json'), false);
});

test('the versions registry stays deduplicated across repeated identical binds', async (t) => {
  const fixture = createGitFixture(t);
  const store = createStore(fixture.clientA, fixture.tempRoot);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const claimed = await claimRequirement({
    store, type: 'I', title: 'Dedupe', profile: 'tooling', backlogText: '| I-001 | fixture |\n',
  });

  await bindRequirementVersion({ store, id: claimed.id, version: 'v0.10.0' });
  await bindRequirementVersion({ store, id: claimed.id, version: 'v0.10.0' });

  assert.deepEqual(
    (await store.readSnapshot()).readJson('versions/v0.10.0.json').requirements,
    [claimed.id],
  );
});

test('bind-version CLI enforces exactly one version mode', async (t) => {
  const fixture = createGitFixture(t);
  const store = createStore(fixture.clientA, fixture.tempRoot);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const id = await claimAndBind(store, 'CLI seed', 'v0.10.0');
  const env = {
    COORD_CWD: fixture.clientA,
    COORD_REMOTE: 'origin',
    COORD_BRANCH: 'coordination',
    COORD_TEMP_ROOT: fixture.tempRoot,
  };

  const noMode = await runCoordination(['requirement', 'bind-version', id, '--json'], env);
  assert.equal(noMode.status, 14);
  assert.equal(JSON.parse(noMode.stderr).code, 'CLI_USAGE');

  const twoModes = await runCoordination([
    'requirement', 'bind-version', id, 'v0.10.1', '--bump', 'patch', '--force', '--json',
  ], env);
  assert.equal(twoModes.status, 14);
  assert.equal(JSON.parse(twoModes.stderr).code, 'CLI_USAGE');

  const claimed = await runCoordination([
    'requirement', 'claim', '--type', 'I', '--title', 'CLI bump', '--profile', 'tooling', '--ux-impact', 'none', '--json',
  ], { ...env, COORD_AGENT: 'test-agent', COORD_USER: 'tester' });
  assert.equal(claimed.status, 0, claimed.stderr);
  const claimedId = JSON.parse(claimed.stdout).data.requirementId;
  const bumped = await runCoordination([
    'requirement', 'bind-version', claimedId, '--bump', 'minor', '--json',
  ], env);
  assert.equal(bumped.status, 0, bumped.stderr);
  assert.equal(JSON.parse(bumped.stdout).data.version, 'v0.11.0');
  assert.deepEqual(
    (await store.readSnapshot()).readJson('versions/v0.11.0.json').requirements,
    [claimedId],
  );
});

// ============================================================================
// I-130 (D3): requirement start——单次 coordination update 内原子完成
// ID 分配 + requirement JSON（含 migrationAssessment）+ 版本绑定/注册 +
// branch 绑定；lifecycle 仍落 todo。
// ============================================================================

test('startRequirement atomically claims, binds the version and binds the branch', async (t) => {
  const fixture = createGitFixture(t);
  const store = createStore(fixture.clientA, fixture.tempRoot);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  await claimAndBind(store, 'Existing release member', 'v0.10.0');

  const started = await startRequirement({
    store,
    type: 'I',
    title: 'Started requirement',
    profile: 'runtime',
    topic: 'coord-redesign-model',
    migration: 'yes',
    joinVersion: 'v0.10.0',
    backlogText: '| I-001 | fixture |\n',
    owner: { sessionId: null, agent: 'test-agent', user: 'tester', host: 'fixture' },
  });

  assert.equal(started.id, 'I-003');
  assert.equal(started.version, 'v0.10.0');
  assert.equal(started.branch, 'feature/v0.10.0/coord-redesign-model');
  assert.equal(started.migrationAssessment, '是');
  const snapshot = await store.readSnapshot();
  const requirement = snapshot.readJson(`requirements/${started.id}.json`);
  assert.equal(requirement.schemaVersion, 1);
  // I-131 (E2): start lands directly at in_dev with one honest start event.
  assert.equal(requirement.lifecycle, 'in_dev');
  assert.deepEqual(requirement.lifecycleHistory, [{
    type: 'start',
    from: null,
    to: 'in_dev',
    at: '2026-07-17T00:00:00.000Z',
    actor: 'test-agent',
  }]);
  assert.equal(requirement.migrationAssessment, '是');
  assert.equal(requirement.version, 'v0.10.0');
  assert.equal(requirement.branch, 'feature/v0.10.0/coord-redesign-model');
  assert.equal(requirement.deliveryProfile, 'runtime');
  assert.deepEqual(
    snapshot.readJson('versions/v0.10.0.json').requirements,
    ['I-002', started.id].sort(),
  );
});

test('startRequirement bumps from an empty registry and projects 否 for --migration no', async (t) => {
  const fixture = createGitFixture(t);
  const store = createStore(fixture.clientA, fixture.tempRoot);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });

  const started = await startRequirement({
    store,
    type: 'F',
    title: 'Fresh start',
    profile: 'tooling',
    topic: 'fresh-start',
    migration: 'no',
    bump: 'patch',
    backlogText: '| I-001 | fixture |\n',
  });

  assert.equal(started.id, 'F-002');
  assert.equal(started.version, 'v0.0.1');
  assert.equal(started.migrationAssessment, '否');
  const snapshot = await store.readSnapshot();
  assert.equal(snapshot.readJson(`requirements/${started.id}.json`).migrationAssessment, '否');
  assert.deepEqual(snapshot.readJson('versions/v0.0.1.json').requirements, [started.id]);
});

test('startRequirement fails closed before writing on invalid inputs', async (t) => {
  const fixture = createGitFixture(t);
  const store = createStore(fixture.clientA, fixture.tempRoot);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const base = {
    store,
    type: 'I',
    title: 'Invalid start',
    profile: 'tooling',
    topic: 'invalid-start',
    migration: 'yes',
    version: 'v0.1.0',
    backlogText: '| I-001 | fixture |\n',
  };

  await assert.rejects(
    startRequirement({ ...base, migration: 'maybe' }),
    (error) => error.code === 'INVALID_MIGRATION_ASSESSMENT',
  );
  await assert.rejects(
    startRequirement({ ...base, migration: undefined }),
    (error) => error.code === 'INVALID_MIGRATION_ASSESSMENT',
  );
  await assert.rejects(
    startRequirement({ ...base, version: undefined }),
    (error) => error.code === 'INVALID_VERSION_OPTIONS',
  );
  await assert.rejects(
    startRequirement({ ...base, bump: 'patch' }),
    (error) => error.code === 'INVALID_VERSION_OPTIONS',
  );
  await assert.rejects(
    startRequirement({ ...base, version: undefined, joinVersion: 'v9.9.9' }),
    (error) => error.code === 'VERSION_NOT_FOUND' && error.exitCode === 12,
  );
  await assert.rejects(
    startRequirement({ ...base, topic: '../escape' }),
    (error) => error.code === 'INVALID_WORKTREE_TOPIC',
  );

  // No half-initialized requirement or version document may survive.
  const snapshot = await store.readSnapshot();
  assert.equal(snapshot.has('requirements/I-002.json'), false);
  assert.equal(snapshot.has('versions/v0.1.0.json'), false);
  assert.equal(snapshot.has('versions/v9.9.9.json'), false);
});

// ============================================================================
// I-134 (F4): declare-resources --auto inference. Changed paths come from
// `git diff origin/main...HEAD` (source 'diff') and uncommitted porcelain
// entries (source 'uncommitted'); services come from the path classifier
// (source 'classifier'). ≥3 files in one directory collapse to dir/**;
// BACKLOG.md and docs/product/current/<ID>-* are excluded.
// ============================================================================

async function setupInferenceFixture(t) {
  const fixture = createGitFixture(t);
  const store = createStore(fixture.clientA, fixture.tempRoot);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const claimed = await claimRequirement({
    store,
    type: 'I',
    title: 'Inference requirement',
    profile: 'tooling',
    backlogText: '| I-001 | fixture |\n',
  });
  runGit(fixture.clientA, ['switch', '-c', 'feature/v0.2.33/inference']);
  return { fixture, store, id: claimed.id };
}

test('infers resources from the committed diff, uncommitted paths and the classifier', async (t) => {
  const { fixture, id } = await setupInferenceFixture(t);
  mkdirSync(join(fixture.clientA, 'apps', 'web', 'src'), { recursive: true });
  writeFileSync(join(fixture.clientA, 'apps', 'web', 'src', 'page.tsx'), 'export default 1;\n');
  runGit(fixture.clientA, ['add', 'apps']);
  runGit(fixture.clientA, ['commit', '-m', 'feat: web page']);
  // Uncommitted: a tracked-file modification and a brand-new directory under
  // an already tracked tree.
  writeFileSync(join(fixture.clientA, 'README.md'), '# changed\n');
  mkdirSync(join(fixture.clientA, 'apps', 'web', 'public'), { recursive: true });
  writeFileSync(join(fixture.clientA, 'apps', 'web', 'public', 'logo.svg'), '<svg/>\n');

  const inferred = inferRequirementResources({ cwd: fixture.clientA, id });

  assert.deepEqual(inferred.files, [
    // The new public/ directory is untracked, so it collapses directly.
    { value: 'apps/web/public/**', source: 'uncommitted' },
    { value: 'apps/web/src/page.tsx', source: 'diff' },
    { value: 'README.md', source: 'uncommitted' },
  ]);
  assert.deepEqual(inferred.services, [{ value: 'web', source: 'classifier' }]);
});

test('inference stays fail-closed on unknown paths through the classifier', async (t) => {
  const { fixture, id } = await setupInferenceFixture(t);
  // An untracked top-level directory matches no classifier rule; the
  // classifier's conservative contract infers every service.
  mkdirSync(join(fixture.clientA, 'packages', 'shared'), { recursive: true });
  writeFileSync(join(fixture.clientA, 'packages', 'shared', 'index.js'), 'export default 2;\n');

  const inferred = inferRequirementResources({ cwd: fixture.clientA, id });

  assert.deepEqual(inferred.files, [{ value: 'packages/**', source: 'uncommitted' }]);
  assert.deepEqual(
    inferred.services,
    ['account', 'admin', 'api', 'gateway', 'web'].map((value) => ({ value, source: 'classifier' })),
  );
});

test('collapses directories with at least three inferred files into dir/**', async (t) => {
  const { fixture, id } = await setupInferenceFixture(t);
  mkdirSync(join(fixture.clientA, 'apps', 'web', 'src'), { recursive: true });
  mkdirSync(join(fixture.clientA, 'apps', 'web', 'other'), { recursive: true });
  for (const name of ['a.ts', 'b.ts', 'c.ts']) {
    writeFileSync(join(fixture.clientA, 'apps', 'web', 'src', name), 'export default 1;\n');
  }
  writeFileSync(join(fixture.clientA, 'apps', 'web', 'other', 'd.ts'), 'export default 1;\n');
  runGit(fixture.clientA, ['add', 'apps']);
  runGit(fixture.clientA, ['commit', '-m', 'feat: web sources']);

  const inferred = inferRequirementResources({ cwd: fixture.clientA, id });

  assert.deepEqual(inferred.files, [
    { value: 'apps/web/other/d.ts', source: 'diff' },
    { value: 'apps/web/src/**', source: 'diff' },
  ]);
  assert.deepEqual(inferred.services, [{ value: 'web', source: 'classifier' }]);
});

test('auto resource inference keeps diverse root scripts as exact paths', async (t) => {
  const { fixture, id } = await setupInferenceFixture(t);
  mkdirSync(join(fixture.clientA, 'scripts'), { recursive: true });
  for (const name of ['local-e2e.mjs', 'mixed-frontend.mjs', 'validate-mixed-release.mjs']) {
    writeFileSync(join(fixture.clientA, 'scripts', name), '// task tool\n');
  }
  runGit(fixture.clientA, ['add', 'scripts']);
  runGit(fixture.clientA, ['commit', '-m', 'feat: task tooling']);
  const inferred = inferRequirementResources({ cwd: fixture.clientA, id });
  assert.deepEqual(inferred.files.map((entry) => entry.value), [
    'scripts/local-e2e.mjs', 'scripts/mixed-frontend.mjs', 'scripts/validate-mixed-release.mjs',
  ]);
  assert.deepEqual(inferred.services, []);
});

test('excludes the process files of the requirement itself from inference', async (t) => {
  const { fixture, id } = await setupInferenceFixture(t);
  // Three files in the requirement's own product directory would collapse if
  // they were not excluded up front.
  const ownDocs = join(fixture.clientA, 'docs', 'product', 'current', `${id}-inference`);
  mkdirSync(ownDocs, { recursive: true });
  for (const name of ['REQUIREMENT.md', 'TECH_DESIGN.md', 'CHECKLIST.md']) {
    writeFileSync(join(ownDocs, name), '# doc\n');
  }
  // Another requirement's product document is a real declaration candidate.
  const otherDocs = join(fixture.clientA, 'docs', 'product', 'current', 'I-999-other');
  mkdirSync(otherDocs, { recursive: true });
  writeFileSync(join(otherDocs, 'REQUIREMENT.md'), '# doc\n');
  writeFileSync(join(fixture.clientA, 'BACKLOG.md'), '| I-001 | fixture |\n| I-900 | row |\n');
  runGit(fixture.clientA, ['add', 'docs', 'BACKLOG.md']);
  runGit(fixture.clientA, ['commit', '-m', 'docs: requirement documents']);

  const inferred = inferRequirementResources({ cwd: fixture.clientA, id });

  assert.deepEqual(inferred.files, [
    { value: 'docs/product/current/I-999-other/REQUIREMENT.md', source: 'diff' },
  ]);
  assert.deepEqual(inferred.services, []);
});

test('declare-resources --auto unions inferred and explicit resources with provenance', async (t) => {
  const { fixture, id } = await setupInferenceFixture(t);
  mkdirSync(join(fixture.clientA, 'apps', 'web', 'src'), { recursive: true });
  writeFileSync(join(fixture.clientA, 'apps', 'web', 'src', 'page.tsx'), 'export default 1;\n');
  runGit(fixture.clientA, ['add', 'apps']);
  runGit(fixture.clientA, ['commit', '-m', 'feat: web page']);

  const memory = createMemoryIo();
  const exitCode = await main([
    'requirement', 'declare-resources', id,
    '--auto',
    '--file', 'apps/web/src/page.tsx',
    '--file', 'scripts/extra.sh',
    '--service', 'web',
    '--json',
  ], {
    env: {
      COORD_CWD: fixture.clientA,
      COORD_REMOTE: 'origin',
      COORD_BRANCH: 'coordination',
      COORD_TEMP_ROOT: fixture.tempRoot,
    },
    ...memory.io,
  });

  assert.equal(exitCode, 0, memory.stderr.join(''));
  const output = JSON.parse(memory.stdout.join(''));
  // Inferred and explicit entries are unioned and deduplicated.
  assert.deepEqual(output.data.resources.files, ['apps/web/src/page.tsx', 'scripts/extra.sh']);
  assert.deepEqual(output.data.resources.services, ['web']);
  assert.deepEqual(output.data.inferred, {
    files: [{ value: 'apps/web/src/page.tsx', source: 'diff' }],
    services: [{ value: 'web', source: 'classifier' }],
  });
});

test('declare-resources --auto with empty inference and no explicit options is a usage error', async (t) => {
  const { fixture, id } = await setupInferenceFixture(t);
  const env = {
    COORD_CWD: fixture.clientA,
    COORD_REMOTE: 'origin',
    COORD_BRANCH: 'coordination',
    COORD_TEMP_ROOT: fixture.tempRoot,
  };

  const empty = createMemoryIo();
  const emptyExit = await main(['requirement', 'declare-resources', id, '--auto', '--json'], {
    env,
    ...empty.io,
  });
  assert.equal(emptyExit, 14);
  const error = JSON.parse(empty.stderr.join(''));
  assert.equal(error.code, 'CLI_USAGE');
  assert.match(error.message, /nothing to declare/);

  // Explicit options still declare when inference is empty.
  const explicit = createMemoryIo();
  const explicitExit = await main([
    'requirement', 'declare-resources', id, '--auto', '--file', 'docs/manual.md', '--json',
  ], {
    env,
    ...explicit.io,
  });
  assert.equal(explicitExit, 0, explicit.stderr.join(''));
  const output = JSON.parse(explicit.stdout.join(''));
  assert.deepEqual(output.data.resources.files, ['docs/manual.md']);
  assert.deepEqual(output.data.inferred, { files: [], services: [] });
});

// ============================================================================
// I-134 (F8): requirement cancel. A non-terminal requirement lands at the
// cancelled terminal state with a cancel history event and the 🚫 Cancelled
// BACKLOG projection; in_dev and later require --force; done is rejected;
// re-cancelling is an idempotent no-op; a missing BACKLOG row skips the
// projection with a flag.
// ============================================================================

async function setupCancelFixture(t, { lifecycle = 'todo', withBacklogRow = true } = {}) {
  const fixture = createGitFixture(t);
  const store = createStore(fixture.clientA, fixture.tempRoot);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const claimed = await claimRequirement({
    store,
    type: 'I',
    title: 'Cancel me',
    profile: 'tooling',
    backlogText: '| I-001 | fixture |\n',
  });
  runGit(fixture.clientA, ['switch', '-c', 'feature/v0.2.33/cancel-me']);
  if (lifecycle !== 'todo') {
    await store.update({
      operation: `prepare ${lifecycle} lifecycle`,
      mutate(snapshot) {
        const path = `requirements/${claimed.id}.json`;
        snapshot.writeJson(path, { ...snapshot.readJson(path), lifecycle });
      },
    });
  }
  if (withBacklogRow) {
    writeFileSync(
      join(fixture.clientA, 'BACKLOG.md'),
      `| ${claimed.id} | Cancel me | 否 | ${BACKLOG_STATUSES[lifecycle]} | v0.2.33 | fixture |\n`,
    );
    runGit(fixture.clientA, ['add', 'BACKLOG.md']);
    runGit(fixture.clientA, ['commit', '-m', 'test: register backlog row']);
  }
  return { fixture, store, id: claimed.id };
}

test('cancels a todo requirement with a history event and the BACKLOG projection', async (t) => {
  const { fixture, store, id } = await setupCancelFixture(t);

  const result = await cancelRequirement({
    store,
    cwd: fixture.clientA,
    id,
    reason: 'no longer needed this quarter',
    actor: 'kimi',
  });

  assert.equal(result.changed, true);
  assert.equal(result.from, 'todo');
  assert.equal(result.lifecycle, 'cancelled');
  assert.equal(result.projection.changed, true);
  const requirement = (await store.readSnapshot()).readJson(`requirements/${id}.json`);
  assert.equal(requirement.lifecycle, 'cancelled');
  assert.deepEqual(requirement.lifecycleHistory.at(-1), {
    type: 'cancel',
    from: 'todo',
    to: 'cancelled',
    at: '2026-07-17T00:00:00.000Z',
    actor: 'kimi',
    reason: 'no longer needed this quarter',
  });
  assert.match(
    readFileSync(join(fixture.clientA, 'BACKLOG.md'), 'utf8'),
    new RegExp(`\\| ${id} \\| Cancel me \\| 否 \\| 🚫 Cancelled \\|`),
  );
});

test('cancelling in_dev or later requires --force', async (t) => {
  const { fixture, store, id } = await setupCancelFixture(t, { lifecycle: 'in_dev' });

  await assert.rejects(
    cancelRequirement({
      store,
      cwd: fixture.clientA,
      id,
      reason: 'abandoned midway through development',
    }),
    (error) => error.code === 'CANCEL_NEEDS_FORCE' && error.exitCode === 14,
  );
  // The rejected cancel left the lifecycle untouched.
  assert.equal(
    (await store.readSnapshot()).readJson(`requirements/${id}.json`).lifecycle,
    'in_dev',
  );

  const result = await cancelRequirement({
    store,
    cwd: fixture.clientA,
    id,
    reason: 'abandoned midway through development',
    force: true,
    actor: 'kimi',
  });
  assert.equal(result.changed, true);
  assert.equal(result.from, 'in_dev');
  assert.equal(
    (await store.readSnapshot()).readJson(`requirements/${id}.json`).lifecycle,
    'cancelled',
  );
});

test('cancel rejects a done requirement and invalid reasons', async (t) => {
  const { fixture, store, id } = await setupCancelFixture(t, { lifecycle: 'done' });
  await assert.rejects(
    cancelRequirement({
      store,
      cwd: fixture.clientA,
      id,
      reason: 'trying to cancel a done requirement',
      force: true,
    }),
    (error) => error.code === 'CANCEL_TERMINAL_STATE' && error.exitCode === 14,
  );

  const { fixture: freshFixture, store: freshStore, id: freshId } = await setupCancelFixture(t);
  await assert.rejects(
    cancelRequirement({ store: freshStore, cwd: freshFixture.clientA, id: freshId, reason: 'short' }),
    (error) => error.code === 'INVALID_CANCEL_REASON' && error.exitCode === 14,
  );
  await assert.rejects(
    cancelRequirement({
      store: freshStore,
      cwd: freshFixture.clientA,
      id: freshId,
      reason: 'one line is never\nfollowed by another',
    }),
    (error) => error.code === 'INVALID_CANCEL_REASON' && error.exitCode === 14,
  );
});

test('re-cancelling is an idempotent no-op', async (t) => {
  const { fixture, store, id } = await setupCancelFixture(t);
  await cancelRequirement({
    store,
    cwd: fixture.clientA,
    id,
    reason: 'no longer needed this quarter',
  });

  const again = await cancelRequirement({
    store,
    cwd: fixture.clientA,
    id,
    reason: 'no longer needed this quarter',
  });

  assert.equal(again.changed, false);
  assert.equal(again.from, 'cancelled');
  assert.equal(again.lifecycle, 'cancelled');
  assert.equal(again.projection.changed, false);
  const requirement = (await store.readSnapshot()).readJson(`requirements/${id}.json`);
  assert.equal(requirement.lifecycleHistory.filter((event) => event.type === 'cancel').length, 1);
});

test('cancel tolerates a missing BACKLOG row and flags the skipped projection', async (t) => {
  const { fixture, store, id } = await setupCancelFixture(t, { withBacklogRow: false });

  const result = await cancelRequirement({
    store,
    cwd: fixture.clientA,
    id,
    reason: 'zombie registration without a backlog row',
  });

  assert.equal(result.changed, true);
  assert.equal(result.projection.skipped, 'missing-backlog-row');
  assert.equal(
    (await store.readSnapshot()).readJson(`requirements/${id}.json`).lifecycle,
    'cancelled',
  );
});

test('requirement cancel CLI publishes the projection and reports cleanup hints', async (t) => {
  const { fixture, store, id } = await setupCancelFixture(t, { lifecycle: 'in_dev' });
  const clock = () => new Date('2026-07-17T00:00:00.000Z');
  await bindRequirementVersion({ store, id, version: 'v0.2.33' });
  await store.update({
    operation: 'bind cancel fixture branch',
    mutate(snapshot) {
      const path = `requirements/${id}.json`;
      snapshot.writeJson(path, { ...snapshot.readJson(path), branch: 'feature/v0.2.33/cancel-me' });
    },
  });
  const session = initializeSession({
    cwd: fixture.clientA, agent: 'kimi', user: 'tester', host: 'host-a', clock,
  });
  await acquireLease({
    store,
    cwd: fixture.clientA,
    resource: 'dev',
    requirementId: id,
    ttl: '8h',
    session,
    clock,
  });
  runGit(fixture.clientA, ['push', '--set-upstream', 'origin', 'HEAD']);

  const memory = createMemoryIo();
  const exitCode = await main([
    'requirement', 'cancel', id,
    '--reason', 'zombie requirement cleanup',
    '--force',
    '--json',
  ], {
    env: {
      COORD_CWD: fixture.clientA,
      COORD_REMOTE: 'origin',
      COORD_BRANCH: 'coordination',
      COORD_TEMP_ROOT: fixture.tempRoot,
      COORD_AGENT: 'kimi',
      COORD_USER: 'tester',
    },
    clock,
    ...memory.io,
  });

  assert.equal(exitCode, 0, memory.stderr.join(''));
  const output = JSON.parse(memory.stdout.join(''));
  assert.equal(output.data.lifecycle, 'cancelled');
  assert.equal(output.data.changed, true);
  assert.equal(output.data.published.pushed, true);
  assert.ok(
    output.data.cleanupHints.some((hint) => hint.includes('lock release dev')),
    'held lease hint',
  );
  assert.ok(
    output.data.cleanupHints.some((hint) => hint.includes('git worktree remove')),
    'worktree hint',
  );
  assert.ok(
    output.data.cleanupHints.some((hint) => hint.includes('git branch -D feature/v0.2.33/cancel-me')),
    'branch hint',
  );
  // The 🚫 Cancelled projection was committed and pushed to the feature branch.
  assert.match(
    runGit(fixture.clientA, ['show', 'origin/feature/v0.2.33/cancel-me:BACKLOG.md']),
    /🚫 Cancelled/,
  );
  // The cancel never touches the held lease or the worktree.
  assert.notEqual((await store.readSnapshot()).readJson('locks/dev.json').active, null);
});

// I-134 (review): re-running cancel after the cleanup hints were followed
// (worktree removed, branch deleted) or from another checkout must stay an
// idempotent no-op — the terminal fact already exists, so the projection
// clean/branch assertions are skipped.
test('requirement cancel CLI stays idempotent after the branch is cleaned up', async (t) => {
  const { fixture, store, id } = await setupCancelFixture(t);
  const clock = () => new Date('2026-07-17T00:00:00.000Z');
  await store.update({
    operation: 'bind cancel fixture branch',
    mutate(snapshot) {
      const path = `requirements/${id}.json`;
      snapshot.writeJson(path, { ...snapshot.readJson(path), branch: 'feature/v0.2.33/cancel-me' });
    },
  });
  runGit(fixture.clientA, ['push', '--set-upstream', 'origin', 'HEAD']);
  const env = {
    COORD_CWD: fixture.clientA,
    COORD_REMOTE: 'origin',
    COORD_BRANCH: 'coordination',
    COORD_TEMP_ROOT: fixture.tempRoot,
    COORD_AGENT: 'kimi',
    COORD_USER: 'tester',
  };
  const first = createMemoryIo();
  const firstExit = await main([
    'requirement', 'cancel', id,
    '--reason', 'zombie requirement cleanup',
    '--json',
  ], { env, clock, ...first.io });
  assert.equal(firstExit, 0, first.stderr.join(''));
  assert.equal(JSON.parse(first.stdout.join('')).data.changed, true);

  // Follow the cleanup hints: leave the branch, then delete it locally and
  // on the remote, and re-run the cancel from the main checkout.
  runGit(fixture.clientA, ['switch', 'main']);
  runGit(fixture.clientA, ['branch', '-D', 'feature/v0.2.33/cancel-me']);
  runGit(fixture.clientA, ['push', 'origin', '--delete', 'feature/v0.2.33/cancel-me']);

  const again = createMemoryIo();
  const againExit = await main([
    'requirement', 'cancel', id,
    '--reason', 'zombie requirement cleanup',
    '--json',
  ], { env, clock, ...again.io });
  assert.equal(againExit, 0, again.stderr.join(''));
  const output = JSON.parse(again.stdout.join(''));
  assert.equal(output.data.changed, false);
  assert.equal(output.data.lifecycle, 'cancelled');
  assert.equal(output.data.published, null);
});
