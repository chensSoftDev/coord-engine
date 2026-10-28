import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { main } from '../../lib/coordination/cli.mjs';
import { recordDeployment } from '../../lib/coordination/deployments.mjs';
import { GitCoordinationStore } from '../../lib/coordination/git-store.mjs';
import { acquireLease } from '../../lib/coordination/leases.mjs';
import {
  bindRequirementVersion,
  claimRequirement,
} from '../../lib/coordination/requirements.mjs';
import { initializeSession } from '../../lib/coordination/worktrees.mjs';
import { createGitFixture, createMemoryIo, runGit } from './fixtures.mjs';

async function setupDeploymentFixture(t) {
  const fixture = createGitFixture(t);
  runGit(fixture.clientA, ['switch', '-c', 'feature/v0.2.32/runtime-deployment']);
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
    title: 'Runtime deployment',
    profile: 'runtime',
    backlogText: '| I-056 | previous |\n',
  });
  await bindRequirementVersion({ store, id: claimed.id, version: 'v0.2.32' });
  mkdirSync(join(fixture.clientA, 'deploy', 'release-manifests'), { recursive: true });
  writeFileSync(
    join(fixture.clientA, 'deploy', 'release-manifests', 'v0.2.32.env'),
    [
      'RELEASE_VERSION=v0.2.32',
      `RELEASE_REQUIREMENTS=${claimed.id}`,
      'RELEASE_DELIVERY_PROFILE=runtime',
      'RELEASE_SERVICES=api,gateway',
      '',
    ].join('\n'),
  );
  // Revision-policy support files: deployment drift tolerance (review fix)
  // classifies the range between the deployed commit and HEAD, so the policy
  // declaration and per-service Dockerfiles must exist for a genuine
  // deployment-neutral vs runtime-affecting verdict.
  mkdirSync(join(fixture.clientA, '.agents'), { recursive: true });
  writeFileSync(
    join(fixture.clientA, '.agents', 'runtime-artifact-inputs.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      services: {
        api: { includes: ['apps/api/**'], excludes: [] },
        gateway: { includes: ['apps/gateway/**'], excludes: [] },
      },
    }, null, 2)}\n`,
  );
  mkdirSync(join(fixture.clientA, 'apps', 'api'), { recursive: true });
  mkdirSync(join(fixture.clientA, 'apps', 'gateway'), { recursive: true });
  writeFileSync(
    join(fixture.clientA, 'apps', 'api', 'Dockerfile'),
    'FROM node:22-alpine\nCOPY apps/api ./apps/api\n',
  );
  writeFileSync(
    join(fixture.clientA, 'apps', 'gateway', 'Dockerfile'),
    'FROM node:22-alpine\nCOPY apps/gateway ./apps/gateway\n',
  );
  runGit(fixture.clientA, ['add', 'deploy/release-manifests/v0.2.32.env', '.agents', 'apps']);
  runGit(fixture.clientA, ['commit', '-m', 'test: commit runtime release manifest']);
  await store.update({
    operation: 'bind runtime deployment branch',
    mutate(snapshot) {
      const path = `requirements/${claimed.id}.json`;
      snapshot.writeJson(path, {
        ...snapshot.readJson(path),
        branch: 'feature/v0.2.32/runtime-deployment',
      });
    },
  });
  commitBacklogFixture(
    fixture.clientA,
    `| ${claimed.id} | Runtime deployment | 否 | 🔨 In Dev | v0.2.32 | fixture |\n`,
  );
  writeTestEvidenceFixture(fixture.clientA, claimed.id);
  const session = initializeSession({
    cwd: fixture.clientA,
    agent: 'codex',
    user: 'developer',
    host: 'fixture',
    clock,
  });
  await acquireLease({
    store,
    cwd: fixture.clientA,
    resource: 'dev',
    requirementId: claimed.id,
    ttl: '90m',
    session,
    clock,
  });
  return { fixture, store, clock, session, id: claimed.id };
}

function writeDeploymentSnapshot(context, {
  stage = 'dev',
  services = ['api', 'gateway'],
  imageIds = {},
  suffix = 'fixture',
  status = 'success',
  succeededAt = '2026-07-17T00:05:00Z',
  invalidatedAt,
  branch,
  cwd,
} = {}) {
  const root = cwd ?? context.fixture.clientA;
  const directory = join(
    root,
    'deploy',
    stage === 'dev' ? 'dev-releases' : 'releases',
    'v0.2.32',
  );
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${suffix}.env`);
  const prefixes = { account: 'ACCOUNT', api: 'API', gateway: 'GATEWAY', web: 'WEB', admin: 'ADMIN' };
  const lines = [
    `STAGE=${stage}`,
    'RELEASE_VERSION=v0.2.32',
    `REQUIREMENT_ID=${context.id}`,
    `RELEASE_COMMIT_SHA=${runGit(root, ['rev-parse', 'HEAD'])}`,
    `RELEASE_BRANCH=${branch ?? runGit(root, ['branch', '--show-current'])}`,
    'DECLARED_RELEASE_SERVICES=api,gateway',
    `RELEASE_SERVICES=${services.join(',')}`,
    `SERVICE_OVERRIDE=${services.length === 1 ? 'true' : 'false'}`,
    `DEPLOYMENT_STATUS=${status}`,
  ];
  if (succeededAt !== null) lines.push(`SUCCEEDED_AT=${succeededAt}`);
  if (invalidatedAt !== undefined) lines.push(`INVALIDATED_AT=${invalidatedAt}`);
  for (const service of services) {
    const prefix = prefixes[service];
    lines.push(`${prefix}_IMAGE_TAG=luggage-${service}:v0.2.32-fixture`);
    lines.push(`${prefix}_IMAGE_ID=${imageIds[service] ?? `sha256:${service === 'api' ? 'a' : 'b'}`.padEnd(71, service === 'api' ? 'a' : 'b')}`);
  }
  lines.push('');
  writeFileSync(path, lines.join('\n'));
  return path;
}

function commitBacklogFixture(cwd, content) {
  writeFileSync(join(cwd, 'BACKLOG.md'), content);
  runGit(cwd, ['add', 'BACKLOG.md']);
  runGit(cwd, ['commit', '-m', 'test: commit lifecycle backlog projection']);
  runGit(cwd, ['push', '-u', 'origin', 'HEAD']);
}

function writeTestEvidenceFixture(cwd, id) {
  const testedCommit = runGit(cwd, ['rev-parse', 'HEAD']);
  const directory = join(cwd, 'docs', 'product', 'current', `${id}-runtime-deployment`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'TEST_EVIDENCE.json'), `${JSON.stringify({
    schemaVersion: 1,
    requirement: { id, version: 'v0.2.32', deliveryProfile: 'runtime' },
    testedCommit,
    outcome: 'passed',
  }, null, 2)}\n`);
  runGit(cwd, ['add', join('docs', 'product', 'current', `${id}-runtime-deployment`, 'TEST_EVIDENCE.json')]);
  runGit(cwd, ['commit', '-m', 'test: commit runtime test evidence fixture']);
  runGit(cwd, ['push', '-u', 'origin', 'HEAD']);
}

test('records a successful deployment only for the active matching lease', async (t) => {
  const context = await setupDeploymentFixture(t);
  const snapshotPath = writeDeploymentSnapshot(context);
  writeFileSync(
    join(context.fixture.clientA, 'deploy', 'release-manifests', 'v0.2.32.env'),
    `${readFileSync(join(context.fixture.clientA, 'deploy', 'release-manifests', 'v0.2.32.env'), 'utf8')}# uncommitted local edit\n`,
  );
  const result = await recordDeployment({
    store: context.store,
    cwd: context.fixture.clientA,
    stage: 'dev',
    requirementId: context.id,
    snapshotPath,
    session: context.session,
    clock: context.clock,
  });

  assert.deepEqual(result.deployment.services, ['api', 'gateway']);
  assert.equal(result.deployment.requirementId, context.id);
  assert.equal(result.deployment.commit, runGit(context.fixture.clientA, ['rev-parse', 'HEAD']));
  assert.equal(result.deployment.schemaVersion, 2);
  assert.match(result.deployment.artifacts.api.imageId, /^sha256:a{64}$/);
  assert.match(result.deployment.artifacts.gateway.imageId, /^sha256:b{64}$/);
  assert.equal(
    result.deployment.manifest.sha256,
    createHash('sha256').update(runGit(context.fixture.clientA, [
      'show', 'HEAD:deploy/release-manifests/v0.2.32.env',
    ]) + '\n').digest('hex'),
  );
  assert.equal(
    result.deployment.sourceSnapshot.sha256,
    createHash('sha256').update(readFileSync(snapshotPath)).digest('hex'),
  );
  assert.deepEqual(
    (await context.store.readSnapshot()).readJson('deployments/dev.json'),
    result.deployment,
  );

  await assert.rejects(
    recordDeployment({
      store: context.store,
      cwd: context.fixture.clientA,
      stage: 'dev',
      requirementId: context.id,
      snapshotPath: writeDeploymentSnapshot(context, {
        services: ['api'],
        suffix: 'missing-artifact',
        imageIds: { api: '' },
      }),
      session: context.session,
      clock: context.clock,
    }),
    (error) => error.code === 'DEPLOYMENT_ARTIFACT_MISSING',
  );

  await assert.rejects(
    recordDeployment({
      store: context.store,
      cwd: context.fixture.clientA,
      stage: 'dev',
      requirementId: context.id,
      snapshotPath: writeDeploymentSnapshot(context, {
        suffix: 'failed-release',
        status: 'invalidated',
      }),
      session: context.session,
      clock: context.clock,
    }),
    (error) => error.code === 'DEPLOYMENT_NOT_SUCCESSFUL',
  );

  for (const [suffix, terminalFacts] of [
    ['missing-success-time', { succeededAt: null }],
    ['non-utc-success-time', { succeededAt: '2026-07-17T08:05:00+08:00' }],
    ['contradictory-success', { invalidatedAt: '2026-07-17T00:06:00Z' }],
  ]) {
    await assert.rejects(
      recordDeployment({
        store: context.store,
        cwd: context.fixture.clientA,
        stage: 'dev',
        requirementId: context.id,
        snapshotPath: writeDeploymentSnapshot(context, { suffix, ...terminalFacts }),
        session: context.session,
        clock: context.clock,
      }),
      (error) => error.code === 'DEPLOYMENT_NOT_SUCCESSFUL',
      suffix,
    );
  }
});

test('deployment record CLI emits stable JSON', async (t) => {
  const context = await setupDeploymentFixture(t);
  const snapshotPath = writeDeploymentSnapshot(context, {
    services: ['api'],
    suffix: 'cli',
  });
  const memory = createMemoryIo();
  const exitCode = await main([
    'deployment', 'record', 'dev',
    '--requirement', context.id,
    '--snapshot', snapshotPath,
    '--json',
  ], {
    env: {
      COORD_CWD: context.fixture.clientA,
      COORD_REMOTE: 'origin',
      COORD_BRANCH: 'coordination',
      COORD_TEMP_ROOT: context.fixture.tempRoot,
      COORD_SESSION_ID: context.session.sessionId,
    },
    clock: context.clock,
    ...memory.io,
  });

  assert.equal(exitCode, 0, memory.stderr.join(''));
  const output = JSON.parse(memory.stdout.join(''));
  assert.equal(output.data.deployment.stage, 'dev');
  assert.deepEqual(output.data.deployment.services, ['api']);
  assert.match(output.data.deployment.artifacts.api.imageId, /^sha256:a{64}$/);

  const rejected = createMemoryIo();
  const rejectedExit = await main([
    'deployment', 'record', 'dev',
    '--requirement', context.id,
    '--snapshot', snapshotPath,
    '--version', 'v0.2.32',
    '--json',
  ], {
    env: {
      COORD_CWD: context.fixture.clientA,
      COORD_REMOTE: 'origin',
      COORD_BRANCH: 'coordination',
      COORD_TEMP_ROOT: context.fixture.tempRoot,
      COORD_SESSION_ID: context.session.sessionId,
    },
    clock: context.clock,
    ...rejected.io,
  });
  assert.equal(rejectedExit, 14);
  assert.equal(JSON.parse(rejected.stderr.join('')).code, 'CLI_USAGE');
});

test('runtime lifecycle CLI consumes the active lease and deployment snapshot', async (t) => {
  const context = await setupDeploymentFixture(t);
  const snapshotPath = writeDeploymentSnapshot(context, {
    services: ['api'],
    suffix: 'lifecycle',
  });
  await recordDeployment({
    store: context.store,
    cwd: context.fixture.clientA,
    stage: 'dev',
    requirementId: context.id,
    snapshotPath,
    session: context.session,
    clock: context.clock,
  });
  await context.store.update({
    operation: 'prepare runtime lifecycle fixture',
    mutate(snapshot) {
      const path = `requirements/${context.id}.json`;
      snapshot.writeJson(path, { ...snapshot.readJson(path), lifecycle: 'in_dev' });
    },
  });
  const env = {
    COORD_CWD: context.fixture.clientA,
    COORD_REMOTE: 'origin',
    COORD_BRANCH: 'coordination',
    COORD_TEMP_ROOT: context.fixture.tempRoot,
    COORD_SESSION_ID: context.session.sessionId,
  };

  const deployedMemory = createMemoryIo();
  const deployedExit = await main([
    'lifecycle', 'advance', context.id, '--to', 'dev_deployed', '--json',
  ], { env, clock: context.clock, ...deployedMemory.io });
  assert.equal(deployedExit, 0, deployedMemory.stderr.join(''));
  assert.equal(JSON.parse(deployedMemory.stdout.join('')).data.lifecycle, 'dev_deployed');

  // I-130 (D1): the dev_deployed BACKLOG projection moved the branch tip;
  // redeploying re-anchors the deployment snapshot at the new HEAD (a
  // BACKLOG-only drift would also be tolerated, Task 3.5) — the immutable
  // deployment fact is the commit anchor, not the lease.
  await recordDeployment({
    store: context.store,
    cwd: context.fixture.clientA,
    stage: 'dev',
    requirementId: context.id,
    snapshotPath: writeDeploymentSnapshot(context, {
      services: ['api'],
      suffix: 'lifecycle-redeploy',
    }),
    session: context.session,
    clock: context.clock,
  });
  const testingMemory = createMemoryIo();
  const testingExit = await main([
    'lifecycle', 'advance', context.id, '--to', 'testing', '--json',
  ], { env, clock: context.clock, ...testingMemory.io });
  assert.equal(testingExit, 0, testingMemory.stderr.join(''));
  assert.equal(JSON.parse(testingMemory.stdout.join('')).data.lifecycle, 'testing');
});

test('production deployment record rejects a commit without a main merge fact', async (t) => {
  const context = await setupDeploymentFixture(t);
  commitBacklogFixture(
    context.fixture.clientA,
    `| ${context.id} | Runtime deployment | 否 | 📋 Prod Planning | v0.2.32 | fixture |\n`,
  );
  await acquireLease({
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'prod',
    requirementId: context.id,
    ttl: '30m',
    session: context.session,
    clock: context.clock,
  });
  await assert.rejects(
    recordDeployment({
      store: context.store,
      cwd: context.fixture.clientA,
      stage: 'prod',
      requirementId: context.id,
      snapshotPath: writeDeploymentSnapshot(context, {
        stage: 'prod',
        services: ['api'],
        suffix: 'unmerged-prod',
      }),
      session: context.session,
      clock: context.clock,
    }),
    (error) => error.code === 'DEPLOYMENT_NOT_MERGED',
  );
});

test('runtime Prod Deployed consumes the active prod lease and prod snapshot', async (t) => {
  const context = await setupDeploymentFixture(t);
  const mergedCommit = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  await context.store.update({
    operation: 'record runtime main merge fact',
    mutate(snapshot) {
      const path = `requirements/${context.id}.json`;
      snapshot.writeJson(path, {
        ...snapshot.readJson(path),
        mergeStatus: 'merged',
        mergedCommit,
      });
    },
  });
  commitBacklogFixture(
    context.fixture.clientA,
    `| ${context.id} | Runtime deployment | 否 | 📋 Prod Planning | v0.2.32 | fixture |\n`,
  );
  await acquireLease({
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'prod',
    requirementId: context.id,
    ttl: '30m',
    session: context.session,
    clock: context.clock,
  });
  const snapshotPath = writeDeploymentSnapshot(context, {
    stage: 'prod',
    services: ['api'],
    suffix: 'prod-lifecycle',
  });
  await recordDeployment({
    store: context.store,
    cwd: context.fixture.clientA,
    stage: 'prod',
    requirementId: context.id,
    snapshotPath,
    session: context.session,
    clock: context.clock,
  });
  await context.store.update({
    operation: 'prepare production lifecycle fixture',
    mutate(snapshot) {
      const path = `requirements/${context.id}.json`;
      snapshot.writeJson(path, { ...snapshot.readJson(path), lifecycle: 'prod_planning' });
    },
  });
  const memory = createMemoryIo();
  const exitCode = await main([
    'lifecycle', 'advance', context.id, '--to', 'prod_deployed', '--json',
  ], {
    env: {
      COORD_CWD: context.fixture.clientA,
      COORD_REMOTE: 'origin',
      COORD_BRANCH: 'coordination',
      COORD_TEMP_ROOT: context.fixture.tempRoot,
      COORD_SESSION_ID: context.session.sessionId,
    },
    clock: context.clock,
    ...memory.io,
  });
  assert.equal(exitCode, 0, memory.stderr.join(''));
  assert.equal(JSON.parse(memory.stdout.join('')).data.lifecycle, 'prod_deployed');
});

test('prod deployment accepts a tag commit that contains the merged commit', async (t) => {
  const context = await setupDeploymentFixture(t);
  const mergedCommit = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  await context.store.update({
    operation: 'record runtime main merge fact',
    mutate(snapshot) {
      const path = `requirements/${context.id}.json`;
      snapshot.writeJson(path, { ...snapshot.readJson(path), mergeStatus: 'merged', mergedCommit });
    },
  });
  writeFileSync(join(context.fixture.clientA, 'docs-release-note.md'), 'release planning docs\n');
  runGit(context.fixture.clientA, ['add', 'docs-release-note.md']);
  runGit(context.fixture.clientA, ['commit', '-m', 'docs: release planning notes']);
  await acquireLease({
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'prod',
    requirementId: context.id,
    ttl: '30m',
    session: context.session,
    clock: context.clock,
  });
  const result = await recordDeployment({
    store: context.store,
    cwd: context.fixture.clientA,
    stage: 'prod',
    requirementId: context.id,
    snapshotPath: writeDeploymentSnapshot(context, {
      stage: 'prod',
      services: ['api'],
      suffix: 'tag-contains-merge',
    }),
    session: context.session,
    clock: context.clock,
  });
  assert.equal(result.deployment.mergedCommit, mergedCommit);
  assert.notEqual(result.deployment.commit, mergedCommit);
});

test('prod deployment rejects a commit that does not contain the merged commit', async (t) => {
  const context = await setupDeploymentFixture(t);
  runGit(context.fixture.clientB, ['pull', '--ff-only', 'origin', 'main']);
  writeFileSync(join(context.fixture.clientB, 'unrelated.md'), 'unrelated main work\n');
  runGit(context.fixture.clientB, ['add', 'unrelated.md']);
  runGit(context.fixture.clientB, ['commit', '-m', 'test: unrelated main commit']);
  runGit(context.fixture.clientB, ['push', 'origin', 'main']);
  const unrelated = runGit(context.fixture.clientB, ['rev-parse', 'HEAD']);
  await context.store.update({
    operation: 'record unrelated merge fact',
    mutate(snapshot) {
      const path = `requirements/${context.id}.json`;
      snapshot.writeJson(path, { ...snapshot.readJson(path), mergeStatus: 'merged', mergedCommit: unrelated });
    },
  });
  await acquireLease({
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'prod',
    requirementId: context.id,
    ttl: '30m',
    session: context.session,
    clock: context.clock,
  });
  await assert.rejects(
    recordDeployment({
      store: context.store,
      cwd: context.fixture.clientA,
      stage: 'prod',
      requirementId: context.id,
      snapshotPath: writeDeploymentSnapshot(context, {
        stage: 'prod',
        services: ['api'],
        suffix: 'foreign-commit',
      }),
      session: context.session,
      clock: context.clock,
    }),
    (error) => error.code === 'DEPLOYMENT_NOT_MERGED',
  );
});

test('deployment record accepts a detached-entry snapshot whose commit matches the lease', async (t) => {
  const context = await setupDeploymentFixture(t);
  const snapshotPath = writeDeploymentSnapshot(context, {
    services: ['api'],
    suffix: 'detached-entry',
    branch: 'HEAD',
  });
  const result = await recordDeployment({
    store: context.store,
    cwd: context.fixture.clientA,
    stage: 'dev',
    requirementId: context.id,
    snapshotPath,
    session: context.session,
    clock: context.clock,
  });
  assert.equal(result.deployment.branch, 'feature/v0.2.32/runtime-deployment');
  assert.equal(result.deployment.commit, runGit(context.fixture.clientA, ['rev-parse', 'HEAD']));
});

// I-130 (D1): the lease commit floats, so a detached-entry snapshot at the
// current HEAD records fine even though the lease was acquired on an older
// commit — the record binds the snapshot's immutable commit.
test('deployment record binds the current HEAD when the lease commit lags behind', async (t) => {
  const context = await setupDeploymentFixture(t);
  writeFileSync(join(context.fixture.clientA, 'post-lease.md'), 'post-lease work\n');
  runGit(context.fixture.clientA, ['add', 'post-lease.md']);
  runGit(context.fixture.clientA, ['commit', '-m', 'test: advance past the leased commit']);
  const head = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  const result = await recordDeployment({
    store: context.store,
    cwd: context.fixture.clientA,
    stage: 'dev',
    requirementId: context.id,
    snapshotPath: writeDeploymentSnapshot(context, {
      services: ['api'],
      suffix: 'detached-stale-commit',
      branch: 'HEAD',
    }),
    session: context.session,
    clock: context.clock,
  });
  assert.equal(result.deployment.commit, head);
  assert.equal(result.deployment.branch, 'feature/v0.2.32/runtime-deployment');
});

// I-130 (D1) end-to-end float-commit contract: acquire the lease, advance the
// branch, redeploy and record the new HEAD, then advance the runtime
// lifecycle — no lease renew is needed because the deployment snapshot, not
// the lease, is the commit anchor. devRevisionMatches stays informational and
// never blocks; only a missing/stale deployment snapshot does.
// I-130 (Task 3.5): the dev_deployed BACKLOG projection moves the branch tip
// past the deployed commit, but the delta is BACKLOG-only, so the chained
// advance to testing is tolerated without a redeploy.
test('a redeployed HEAD advances the runtime lifecycle without renewing the lease', async (t) => {
  const context = await setupDeploymentFixture(t);
  const leaseCommit = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  writeFileSync(join(context.fixture.clientA, 'runtime-change.md'), 'runtime work\n');
  runGit(context.fixture.clientA, ['add', 'runtime-change.md']);
  runGit(context.fixture.clientA, ['commit', '-m', 'feat: runtime work after the lease']);
  const redeployedHead = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);

  await recordDeployment({
    store: context.store,
    cwd: context.fixture.clientA,
    stage: 'dev',
    requirementId: context.id,
    snapshotPath: writeDeploymentSnapshot(context, {
      services: ['api'],
      suffix: 'redeployed',
    }),
    session: context.session,
    clock: context.clock,
  });
  await context.store.update({
    operation: 'prepare runtime lifecycle fixture',
    mutate(snapshot) {
      const path = `requirements/${context.id}.json`;
      snapshot.writeJson(path, { ...snapshot.readJson(path), lifecycle: 'in_dev' });
    },
  });
  const env = {
    COORD_CWD: context.fixture.clientA,
    COORD_REMOTE: 'origin',
    COORD_BRANCH: 'coordination',
    COORD_TEMP_ROOT: context.fixture.tempRoot,
    COORD_SESSION_ID: context.session.sessionId,
  };

  // The deployment snapshot anchors the current HEAD: dev_deployed passes even
  // though the lease commit lags and the drift is runtime-affecting.
  const deployedMemory = createMemoryIo();
  const deployedExit = await main([
    'lifecycle', 'advance', context.id, '--to', 'dev_deployed', '--json',
  ], { env, clock: context.clock, ...deployedMemory.io });
  assert.equal(deployedExit, 0, deployedMemory.stderr.join(''));

  // I-130 (Task 3.5): the dev_deployed BACKLOG projection moved the branch
  // tip past the deployed commit, but every changed path in the delta is
  // BACKLOG.md, so testing advances without a redeploy.
  const testingMemory = createMemoryIo();
  const testingExit = await main([
    'lifecycle', 'advance', context.id, '--to', 'testing', '--json',
  ], { env, clock: context.clock, ...testingMemory.io });
  assert.equal(testingExit, 0, testingMemory.stderr.join(''));
  assert.equal(JSON.parse(testingMemory.stdout.join('')).data.lifecycle, 'testing');

  // The lease commit never moved: it is informational, not an anchor. The
  // deployment snapshot still anchors the originally deployed commit.
  const snapshot = await context.store.readSnapshot();
  assert.equal(snapshot.readJson('locks/dev.json').active.commit, leaseCommit);
  assert.notEqual(redeployedHead, leaseCommit);
  assert.equal(snapshot.readJson('deployments/dev.json').commit, redeployedHead);
});

// I-130 (Task 3.5): the BACKLOG projection tolerance is exact — a
// runtime-affecting commit mixed into the delta between the deployed commit
// and HEAD closes the gate again until the new HEAD is redeployed.
test('a code change after the dev_deployed projection still requires a redeploy', async (t) => {
  const context = await setupDeploymentFixture(t);
  await recordDeployment({
    store: context.store,
    cwd: context.fixture.clientA,
    stage: 'dev',
    requirementId: context.id,
    snapshotPath: writeDeploymentSnapshot(context, {
      services: ['api'],
      suffix: 'projection-then-code',
    }),
    session: context.session,
    clock: context.clock,
  });
  await context.store.update({
    operation: 'prepare runtime lifecycle fixture',
    mutate(snapshot) {
      const path = `requirements/${context.id}.json`;
      snapshot.writeJson(path, { ...snapshot.readJson(path), lifecycle: 'in_dev' });
    },
  });
  const env = {
    COORD_CWD: context.fixture.clientA,
    COORD_REMOTE: 'origin',
    COORD_BRANCH: 'coordination',
    COORD_TEMP_ROOT: context.fixture.tempRoot,
    COORD_SESSION_ID: context.session.sessionId,
  };

  const deployedMemory = createMemoryIo();
  const deployedExit = await main([
    'lifecycle', 'advance', context.id, '--to', 'dev_deployed', '--json',
  ], { env, clock: context.clock, ...deployedMemory.io });
  assert.equal(deployedExit, 0, deployedMemory.stderr.join(''));

  // A runtime-affecting commit on top of the BACKLOG projection commit: the
  // delta from the deployed commit is no longer BACKLOG-only.
  writeFileSync(join(context.fixture.clientA, 'runtime-change.md'), 'runtime work\n');
  runGit(context.fixture.clientA, ['add', 'runtime-change.md']);
  runGit(context.fixture.clientA, ['commit', '-m', 'feat: runtime work after the projection']);

  const blockedMemory = createMemoryIo();
  const blockedExit = await main([
    'lifecycle', 'advance', context.id, '--to', 'testing', '--json',
  ], { env, clock: context.clock, ...blockedMemory.io });
  assert.equal(blockedExit, 14, blockedMemory.stderr.join(''));
  const blocked = JSON.parse(blockedMemory.stderr.join(''));
  assert.equal(blocked.code, 'LIFECYCLE_GATE_FAILED');
  assert.deepEqual(blocked.data.requiredActions, ['deploy_current_commit_to_dev']);

  // Redeploying the new HEAD re-anchors the snapshot and unblocks testing.
  await recordDeployment({
    store: context.store,
    cwd: context.fixture.clientA,
    stage: 'dev',
    requirementId: context.id,
    snapshotPath: writeDeploymentSnapshot(context, {
      services: ['api'],
      suffix: 'projection-then-code-redeploy',
    }),
    session: context.session,
    clock: context.clock,
  });
  const testingMemory = createMemoryIo();
  const testingExit = await main([
    'lifecycle', 'advance', context.id, '--to', 'testing', '--json',
  ], { env, clock: context.clock, ...testingMemory.io });
  assert.equal(testingExit, 0, testingMemory.stderr.join(''));
  assert.equal(JSON.parse(testingMemory.stdout.join('')).data.lifecycle, 'testing');
});

test('a batch release commit satisfies every prod gate for an earlier merged requirement', async (t) => {
  const context = await setupDeploymentFixture(t);
  const mergedCommit = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  runGit(context.fixture.clientA, ['switch', 'main']);
  runGit(context.fixture.clientA, ['merge', '--ff-only', 'feature/v0.2.32/runtime-deployment']);
  runGit(context.fixture.clientA, ['push', 'origin', 'main']);

  runGit(context.fixture.clientB, ['pull', '--ff-only', 'origin', 'main']);
  writeFileSync(join(context.fixture.clientB, 'docs-batch-sibling.md'), 'sibling requirement work\n');
  runGit(context.fixture.clientB, ['add', 'docs-batch-sibling.md']);
  runGit(context.fixture.clientB, ['commit', '-m', 'test: sibling batch commit']);
  runGit(context.fixture.clientB, ['push', 'origin', 'main']);
  commitBacklogFixture(
    context.fixture.clientB,
    `| ${context.id} | Runtime deployment | 否 | 📋 Prod Planning | v0.2.32 | fixture |\n`,
  );
  const batchCommit = runGit(context.fixture.clientB, ['rev-parse', 'HEAD']);

  await context.store.update({
    operation: 'record runtime main merge fact',
    mutate(snapshot) {
      const path = `requirements/${context.id}.json`;
      snapshot.writeJson(path, {
        ...snapshot.readJson(path),
        mergeStatus: 'merged',
        mergedCommit,
      });
    },
  });

  const sessionB = initializeSession({
    cwd: context.fixture.clientB,
    agent: 'claude-code',
    user: 'developer',
    host: 'fixture-batch',
    clock: context.clock,
  });
  await acquireLease({
    store: context.store,
    cwd: context.fixture.clientB,
    resource: 'prod',
    requirementId: context.id,
    ttl: '30m',
    session: sessionB,
    clock: context.clock,
  });

  const snapshotPath = writeDeploymentSnapshot(context, {
    stage: 'prod',
    services: ['api'],
    suffix: 'batch-release',
    branch: 'HEAD',
    cwd: context.fixture.clientB,
  });
  const recorded = await recordDeployment({
    store: context.store,
    cwd: context.fixture.clientB,
    stage: 'prod',
    requirementId: context.id,
    snapshotPath,
    session: sessionB,
    clock: context.clock,
  });
  assert.equal(recorded.deployment.commit, batchCommit);
  assert.equal(recorded.deployment.branch, 'main');
  assert.equal(recorded.deployment.mergedCommit, mergedCommit);

  await context.store.update({
    operation: 'prepare batch production lifecycle fixture',
    mutate(snapshot) {
      const path = `requirements/${context.id}.json`;
      snapshot.writeJson(path, { ...snapshot.readJson(path), lifecycle: 'prod_planning' });
    },
  });
  const memory = createMemoryIo();
  const exitCode = await main([
    'lifecycle', 'advance', context.id, '--to', 'prod_deployed', '--json',
  ], {
    env: {
      COORD_CWD: context.fixture.clientB,
      COORD_REMOTE: 'origin',
      COORD_BRANCH: 'coordination',
      COORD_TEMP_ROOT: context.fixture.tempRoot,
      COORD_SESSION_ID: sessionB.sessionId,
    },
    clock: context.clock,
    ...memory.io,
  });
  assert.equal(exitCode, 0, memory.stderr.join(''));
  assert.equal(JSON.parse(memory.stdout.join('')).data.lifecycle, 'prod_deployed');
});

// ============================================================================
// I-160：release train 共享一次 prod 部署——列车成员可用同一快照登记
// （deployments/prod.json 累积 requirementIds），prod 门禁容忍 BACKLOG 投影漂移
// （prodRevisionMatches，与 dev 同政策）；dev 记录保持严格匹配。
// ============================================================================

async function claimTrainSibling(context, { mergedCommit }) {
  const sibling = await claimRequirement({
    store: context.store,
    type: 'F',
    title: 'Train sibling',
    profile: 'runtime',
    backlogText: `| ${context.id} | Runtime deployment | 否 | 🔨 In Dev | v0.2.32 | fixture |\n`,
  });
  await bindRequirementVersion({ store: context.store, id: sibling.id, version: 'v0.2.32' });
  await context.store.update({
    operation: 'prepare train sibling fixture',
    mutate(snapshot) {
      const path = `requirements/${sibling.id}.json`;
      snapshot.writeJson(path, {
        ...snapshot.readJson(path),
        branch: 'feature/v0.2.32/runtime-deployment',
        lifecycle: 'prod_planning',
        mergeStatus: 'merged',
        mergedCommit,
      });
    },
  });
  return sibling.id;
}

function writeTrainManifest(context, requirementIds) {
  writeFileSync(
    join(context.fixture.clientA, 'deploy', 'release-manifests', 'v0.2.32.env'),
    [
      'RELEASE_VERSION=v0.2.32',
      `RELEASE_REQUIREMENTS=${requirementIds.join(',')}`,
      'RELEASE_DELIVERY_PROFILE=runtime',
      'RELEASE_SERVICES=api,gateway',
      '',
    ].join('\n'),
  );
  runGit(context.fixture.clientA, ['add', 'deploy/release-manifests/v0.2.32.env']);
  runGit(context.fixture.clientA, ['commit', '-m', 'test: train manifest']);
}

async function acquireProdLease(context) {
  await acquireLease({
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'prod',
    requirementId: context.id,
    ttl: '30m',
    session: context.session,
    clock: context.clock,
  });
}

test('prod record accepts a train member snapshot and accumulates requirementIds', async (t) => {
  const context = await setupDeploymentFixture(t);
  const deployedCommit = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  const siblingId = await claimTrainSibling(context, { mergedCommit: deployedCommit });
  writeTrainManifest(context, [context.id, siblingId]);
  await context.store.update({
    operation: 'mark first requirement merged',
    mutate(snapshot) {
      const path = `requirements/${context.id}.json`;
      snapshot.writeJson(path, {
        ...snapshot.readJson(path),
        mergeStatus: 'merged',
        mergedCommit: deployedCommit,
      });
    },
  });
  await acquireProdLease(context);

  const snapshotPath = writeDeploymentSnapshot(context, { stage: 'prod', suffix: 'train-release' });
  const first = await recordDeployment({
    store: context.store,
    cwd: context.fixture.clientA,
    stage: 'prod',
    requirementId: context.id,
    snapshotPath,
    session: context.session,
    clock: context.clock,
  });
  assert.equal(first.deployment.requirementId, context.id);
  assert.deepEqual(first.deployment.requirementIds, [context.id]);
  assert.equal(first.deployment.sourceRequirementId, context.id);

  // 列车成员用同一快照（REQUIREMENT_ID=首登者）登记，不再要求派生快照文件
  const second = await recordDeployment({
    store: context.store,
    cwd: context.fixture.clientA,
    stage: 'prod',
    requirementId: siblingId,
    snapshotPath,
    session: context.session,
    clock: context.clock,
  });
  assert.equal(second.deployment.requirementId, context.id, '首登者保持不变');
  assert.deepEqual(second.deployment.requirementIds, [context.id, siblingId].sort());
  assert.equal(second.deployment.mergedCommit, deployedCommit);
});

test('prod record rejects a requirement outside the train manifest', async (t) => {
  const context = await setupDeploymentFixture(t);
  const deployedCommit = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  const siblingId = await claimTrainSibling(context, { mergedCommit: deployedCommit });
  // manifest 只含首登者，sibling 不在列车名单
  await context.store.update({
    operation: 'mark first requirement merged',
    mutate(snapshot) {
      const path = `requirements/${context.id}.json`;
      snapshot.writeJson(path, {
        ...snapshot.readJson(path),
        mergeStatus: 'merged',
        mergedCommit: deployedCommit,
      });
    },
  });
  await acquireProdLease(context);
  const snapshotPath = writeDeploymentSnapshot(context, { stage: 'prod', suffix: 'train-release' });
  await assert.rejects(
    recordDeployment({
      store: context.store,
      cwd: context.fixture.clientA,
      stage: 'prod',
      requirementId: siblingId,
      snapshotPath,
      session: context.session,
      clock: context.clock,
    }),
    (error) => error.code === 'DEPLOYMENT_SNAPSHOT_MISMATCH',
  );
});

test('dev record still rejects a train member snapshot (evidence equality guard)', async (t) => {
  const context = await setupDeploymentFixture(t);
  const siblingId = await claimTrainSibling(context, {
    mergedCommit: runGit(context.fixture.clientA, ['rev-parse', 'HEAD']),
  });
  writeTrainManifest(context, [context.id, siblingId]);
  const snapshotPath = writeDeploymentSnapshot(context, { stage: 'dev', suffix: 'train-dev' });
  await assert.rejects(
    recordDeployment({
      store: context.store,
      cwd: context.fixture.clientA,
      stage: 'dev',
      requirementId: siblingId,
      snapshotPath,
      session: context.session,
      clock: context.clock,
    }),
    (error) => error.code === 'DEPLOYMENT_SNAPSHOT_MISMATCH',
  );
});

test('prod advance after train record tolerates BACKLOG projection drift', async (t) => {
  const context = await setupDeploymentFixture(t);
  const deployedCommit = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  const siblingId = await claimTrainSibling(context, { mergedCommit: deployedCommit });
  writeTrainManifest(context, [context.id, siblingId]);
  writeTestEvidenceFixture(context.fixture.clientA, siblingId);
  const siblingMergedCommit = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  await context.store.update({
    operation: 'record train sibling tested merge',
    mutate(snapshot) {
      const path = `requirements/${siblingId}.json`;
      snapshot.writeJson(path, { ...snapshot.readJson(path), mergedCommit: siblingMergedCommit });
    },
  });
  await context.store.update({
    operation: 'mark first requirement merged',
    mutate(snapshot) {
      const path = `requirements/${context.id}.json`;
      snapshot.writeJson(path, {
        ...snapshot.readJson(path),
        lifecycle: 'prod_planning',
        mergeStatus: 'merged',
        mergedCommit: deployedCommit,
      });
    },
  });
  await acquireProdLease(context);
  const snapshotPath = writeDeploymentSnapshot(context, { stage: 'prod', suffix: 'train-release' });
  await recordDeployment({
    store: context.store,
    cwd: context.fixture.clientA,
    stage: 'prod',
    requirementId: context.id,
    snapshotPath,
    session: context.session,
    clock: context.clock,
  });
  // 列车成员用同一快照登记（requirementIds=[首登者, sibling]）
  await recordDeployment({
    store: context.store,
    cwd: context.fixture.clientA,
    stage: 'prod',
    requirementId: siblingId,
    snapshotPath,
    session: context.session,
    clock: context.clock,
  });

  // record 之后 HEAD 被纯 BACKLOG 投影推进（v0.16.3/v0.16.4 的收尾卡点）
  commitBacklogFixture(
    context.fixture.clientA,
    `| ${context.id} | Runtime deployment | 否 | 📋 Prod Planning | v0.2.32 | fixture |\n`
      + `| ${siblingId} | Train sibling | 否 | 📋 Prod Planning | v0.2.32 | fixture |\n`,
  );

  const env = runtimeCliEnv(context);
  await advanceTo(context, env, 'prod_deployed');
  // 列车成员（经 requirementIds 成员匹配 + 同一漂移政策）也能推进
  const memory = createMemoryIo();
  const exitCode = await main([
    'lifecycle', 'advance', siblingId, '--to', 'prod_deployed', '--json',
  ], { env, clock: context.clock, ...memory.io });
  assert.equal(exitCode, 0, memory.stderr.join(''));
  assert.equal(JSON.parse(memory.stdout.join('')).data.lifecycle, 'prod_deployed');
});

// ============================================================================
// I-130 (review fix S2): 部署漂移容忍统一为 revisionMatchesDeployment(
// devSnapshot.commit → HEAD)。以下端到端测试钉住主流程：record 部署后 HEAD
// 被 BACKLOG 投影/docs 提交推进时，lifecycle 门禁、coord test run 与
// evidence validate 全部沿同一规则放行；混入 runtime-affecting 提交仍拒绝。
// ============================================================================

const ACCEPTANCE = `# Acceptance

\`\`\`coord-required
["node", "scripts/verify.mjs"]
pnpm verify
\`\`\`
`;

function writeAcceptanceFixture(context) {
  const requirementDir = join(
    context.fixture.clientA,
    'docs',
    'product',
    'current',
    `${context.id}-runtime-deployment`,
  );
  mkdirSync(requirementDir, { recursive: true });
  mkdirSync(join(context.fixture.clientA, 'scripts'), { recursive: true });
  writeFileSync(join(requirementDir, 'ACCEPTANCE.md'), ACCEPTANCE);
  writeFileSync(join(context.fixture.clientA, 'scripts', 'verify.mjs'), 'process.exitCode = 0;\n');
  writeFileSync(join(context.fixture.clientA, 'package.json'), JSON.stringify({
    private: true,
    scripts: { verify: 'node scripts/verify.mjs' },
  }, null, 2));
  runGit(context.fixture.clientA, ['add', 'docs', 'scripts', 'package.json']);
  runGit(context.fixture.clientA, ['commit', '-m', 'test: add acceptance fixture']);
}

function runtimeCliEnv(context) {
  return {
    COORD_CWD: context.fixture.clientA,
    COORD_REMOTE: 'origin',
    COORD_BRANCH: 'coordination',
    COORD_TEMP_ROOT: context.fixture.tempRoot,
    COORD_SESSION_ID: context.session.sessionId,
  };
}

async function advanceTo(context, env, to) {
  const memory = createMemoryIo();
  const exitCode = await main([
    'lifecycle', 'advance', context.id, '--to', to, '--json',
  ], { env, clock: context.clock, ...memory.io });
  assert.equal(exitCode, 0, `advance ${to}: ${memory.stderr.join('')}`);
}

test('the main runtime flow runs required tests after BACKLOG projection drift', async (t) => {
  const context = await setupDeploymentFixture(t);
  writeAcceptanceFixture(context);
  const env = runtimeCliEnv(context);
  await recordDeployment({
    store: context.store,
    cwd: context.fixture.clientA,
    stage: 'dev',
    requirementId: context.id,
    snapshotPath: writeDeploymentSnapshot(context, { suffix: 'main-flow' }),
    session: context.session,
    clock: context.clock,
  });
  const deployedCommit = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  await context.store.update({
    operation: 'prepare runtime lifecycle fixture',
    mutate(snapshot) {
      const path = `requirements/${context.id}.json`;
      snapshot.writeJson(path, { ...snapshot.readJson(path), lifecycle: 'in_dev' });
    },
  });

  // Each advance publishes a BACKLOG-only projection commit, moving HEAD past
  // the deployed commit: D (deploy) -> D+1 (dev_deployed) -> D+2 (testing).
  await advanceTo(context, env, 'dev_deployed');
  await advanceTo(context, env, 'testing');
  assert.notEqual(runGit(context.fixture.clientA, ['rev-parse', 'HEAD']), deployedCommit);
  assert.equal(
    (await context.store.readSnapshot()).readJson('deployments/dev.json').commit,
    deployedCommit,
  );

  // The review-blocked main flow: test run must tolerate the projection drift
  // anchored on the deployment snapshot commit.
  const runMemory = createMemoryIo();
  const runExit = await main(['test', 'run', context.id, '--json'], {
    env, clock: context.clock, ...runMemory.io,
  });
  assert.equal(runExit, 0, runMemory.stderr.join(''));
  assert.equal(JSON.parse(runMemory.stdout.join('')).data.evidence.outcome, 'passed');

  // validateTestEvidence applies the same tolerance to the recorded evidence.
  await advanceTo(context, env, 'test_passed');
});

test('deployment-neutral docs drift keeps the deployment reusable for test run and evidence validate', async (t) => {
  const context = await setupDeploymentFixture(t);
  writeAcceptanceFixture(context);
  const env = runtimeCliEnv(context);
  await recordDeployment({
    store: context.store,
    cwd: context.fixture.clientA,
    stage: 'dev',
    requirementId: context.id,
    snapshotPath: writeDeploymentSnapshot(context, { suffix: 'docs-drift' }),
    session: context.session,
    clock: context.clock,
  });
  await context.store.update({
    operation: 'prepare runtime lifecycle fixture',
    mutate(snapshot) {
      const path = `requirements/${context.id}.json`;
      snapshot.writeJson(path, { ...snapshot.readJson(path), lifecycle: 'in_dev' });
    },
  });

  // A docs-only commit after the deployment is deployment-neutral; the range
  // also contains the two BACKLOG projection commits, so the full revision
  // policy (not the BACKLOG fast path) produces the verdict.
  writeFileSync(join(context.fixture.clientA, 'docs', 'release-notes.md'), '# notes\n');
  runGit(context.fixture.clientA, ['add', 'docs/release-notes.md']);
  runGit(context.fixture.clientA, ['commit', '-m', 'docs: release notes']);

  await advanceTo(context, env, 'dev_deployed');
  await advanceTo(context, env, 'testing');

  const runMemory = createMemoryIo();
  const runExit = await main(['test', 'run', context.id, '--json'], {
    env, clock: context.clock, ...runMemory.io,
  });
  assert.equal(runExit, 0, runMemory.stderr.join(''));
  assert.equal(JSON.parse(runMemory.stdout.join('')).data.evidence.outcome, 'passed');

  const validateMemory = createMemoryIo();
  const validateExit = await main([
    'evidence', 'validate', context.id, '--head', 'HEAD', '--base', 'origin/main', '--json',
  ], { env, clock: context.clock, ...validateMemory.io });
  assert.equal(validateExit, 0, validateMemory.stderr.join(''));
  assert.equal(JSON.parse(validateMemory.stdout.join('')).data.valid, true);
});

test('a runtime-affecting commit after the projections closes the evidence path again', async (t) => {
  const context = await setupDeploymentFixture(t);
  writeAcceptanceFixture(context);
  const env = runtimeCliEnv(context);
  await recordDeployment({
    store: context.store,
    cwd: context.fixture.clientA,
    stage: 'dev',
    requirementId: context.id,
    snapshotPath: writeDeploymentSnapshot(context, { suffix: 'runtime-drift' }),
    session: context.session,
    clock: context.clock,
  });
  await context.store.update({
    operation: 'prepare runtime lifecycle fixture',
    mutate(snapshot) {
      const path = `requirements/${context.id}.json`;
      snapshot.writeJson(path, { ...snapshot.readJson(path), lifecycle: 'in_dev' });
    },
  });
  await advanceTo(context, env, 'dev_deployed');
  await advanceTo(context, env, 'testing');

  // A service-source change on top of the projection commits makes the range
  // from the deployed commit runtime-affecting.
  writeFileSync(join(context.fixture.clientA, 'apps', 'api', 'index.js'), 'export default 1;\n');
  runGit(context.fixture.clientA, ['add', 'apps/api/index.js']);
  runGit(context.fixture.clientA, ['commit', '-m', 'feat: api change after the projections']);

  const runMemory = createMemoryIo();
  const runExit = await main(['test', 'run', context.id, '--json'], {
    env, clock: context.clock, ...runMemory.io,
  });
  assert.equal(runExit, 14, runMemory.stderr.join(''));
  assert.equal(JSON.parse(runMemory.stderr.join('')).code, 'DEV_EVIDENCE_REQUIRED');
});

// ============================================================================
// I-134 (F1): recordDeployment asserts the lease at version level
// (assertVersionLease) and replaces the old snapshot-commit equality with an
// ancestor check — a neutral commit on top of the snapshot commit no longer
// invalidates the record, while a snapshot built on a commit outside HEAD's
// history is rejected with DEPLOYMENT_SNAPSHOT_FOREIGN. The version-level
// assertion exempts only the commit leg: the branch leg still rejects a
// working tree checked out on a foreign branch (I-134 review).
// ============================================================================

test('deployment record tolerates a neutral commit on top of the snapshot commit', async (t) => {
  const context = await setupDeploymentFixture(t);
  const snapshotPath = writeDeploymentSnapshot(context, {
    services: ['api'],
    suffix: 'neutral-drift',
  });
  const snapshotCommit = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  // A BACKLOG-only projection commit moves HEAD past the snapshot commit.
  writeFileSync(
    join(context.fixture.clientA, 'BACKLOG.md'),
    `| ${context.id} | Runtime deployment | 否 | 🔨 In Dev | v0.2.32 | fixture |\n| I-900 | neutral projection |\n`,
  );
  runGit(context.fixture.clientA, ['add', 'BACKLOG.md']);
  runGit(context.fixture.clientA, ['commit', '-m', 'docs: neutral backlog projection']);

  const result = await recordDeployment({
    store: context.store,
    cwd: context.fixture.clientA,
    stage: 'dev',
    requirementId: context.id,
    snapshotPath,
    session: context.session,
    clock: context.clock,
  });

  assert.equal(result.deployment.commit, snapshotCommit);
  assert.notEqual(result.deployment.commit, runGit(context.fixture.clientA, ['rev-parse', 'HEAD']));
});

test('deployment record rejects a snapshot built on a foreign commit', async (t) => {
  const context = await setupDeploymentFixture(t);
  // A commit on a sibling branch carries the manifest (it descends from the
  // fixture commit) but is not an ancestor of the feature branch HEAD.
  runGit(context.fixture.clientA, ['switch', '-c', 'feature/v0.2.32/foreign-snapshot']);
  runGit(context.fixture.clientA, ['commit', '--allow-empty', '-m', 'test: foreign branch commit']);
  const foreignCommit = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  runGit(context.fixture.clientA, ['switch', 'feature/v0.2.32/runtime-deployment']);
  const snapshotPath = writeDeploymentSnapshot(context, {
    services: ['api'],
    suffix: 'foreign-commit',
  });
  writeFileSync(snapshotPath, readFileSync(snapshotPath, 'utf8').replace(
    /RELEASE_COMMIT_SHA=[0-9a-f]{40}/,
    `RELEASE_COMMIT_SHA=${foreignCommit}`,
  ));

  await assert.rejects(
    recordDeployment({
      store: context.store,
      cwd: context.fixture.clientA,
      stage: 'dev',
      requirementId: context.id,
      snapshotPath,
      session: context.session,
      clock: context.clock,
    }),
    (error) => error.code === 'DEPLOYMENT_SNAPSHOT_FOREIGN' && error.exitCode === 14,
  );
  assert.equal((await context.store.readSnapshot()).has('deployments/dev.json'), false);
});

// I-134 (review): the local lease token lives in the shared git common dir,
// so the holder check keeps passing after a branch switch — only the branch
// leg of the lease assertion stops a foreign-branch checkout from recording
// its own history as the lease branch's deployment.
test('deployment record rejects a working tree checked out on a foreign branch', async (t) => {
  const context = await setupDeploymentFixture(t);
  // The snapshot commit stays inside HEAD's history (the new branch starts
  // from the same tip), so only the lease branch leg can reject the record.
  const snapshotPath = writeDeploymentSnapshot(context, {
    services: ['api'],
    suffix: 'foreign-branch-checkout',
  });
  runGit(context.fixture.clientA, ['switch', '-c', 'feature/v0.2.32/foreign-checkout']);

  await assert.rejects(
    recordDeployment({
      store: context.store,
      cwd: context.fixture.clientA,
      stage: 'dev',
      requirementId: context.id,
      snapshotPath,
      session: context.session,
      clock: context.clock,
    }),
    (error) => error.name === 'LeaseError'
      && error.code === 'LEASE_REVISION_MISMATCH'
      && error.exitCode === 11
      && /branch/.test(error.message),
  );
  assert.equal((await context.store.readSnapshot()).has('deployments/dev.json'), false);
});

test('explicit dev backend-only records the actual subset and preserves full manifest identity; prod rejects it', async t => {
  const context = await setupDeploymentFixture(t); const cwd = context.fixture.clientA;
  const manifestPath = join(cwd, 'deploy/release-manifests/v0.2.32.env');
  writeFileSync(manifestPath, readFileSync(manifestPath, 'utf8').replace('RELEASE_SERVICES=api,gateway', 'RELEASE_SERVICES=api,gateway,admin'));
  runGit(cwd, ['add', 'deploy/release-manifests/v0.2.32.env']); runGit(cwd, ['commit', '-m', 'full frontend and backend manifest']);
  const path = writeDeploymentSnapshot(context);
  writeFileSync(path, readFileSync(path, 'utf8').replace('DECLARED_RELEASE_SERVICES=api,gateway', 'DECLARED_RELEASE_SERVICES=api,gateway,admin') + 'DEPLOYMENT_MODE=backend-only\n');
  const result = await recordDeployment({ store: context.store, cwd, stage: 'dev', requirementId: context.id, snapshotPath: path, session: context.session, clock: context.clock });
  assert.equal(result.deployment.deploymentMode, 'backend-only');
  assert.deepEqual(result.deployment.services, ['api', 'gateway']);
  assert.deepEqual(result.deployment.declaredServices, ['admin', 'api', 'gateway']);
  assert.equal(result.deployment.serviceSnapshots.api.commit, runGit(cwd, ['rev-parse', 'HEAD']));
  const prodPath = join(cwd, 'deploy/releases/v0.2.32/backend-only.env'); mkdirSync(join(cwd, 'deploy/releases/v0.2.32'), { recursive: true });
  writeFileSync(prodPath, readFileSync(path, 'utf8').replace('STAGE=dev', 'STAGE=prod'));
  await assert.rejects(recordDeployment({ store: context.store, cwd, stage: 'prod', requirementId: context.id, snapshotPath: prodPath, session: context.session, clock: context.clock }), error => error.code === 'DEPLOYMENT_SERVICE_MISMATCH');
});
