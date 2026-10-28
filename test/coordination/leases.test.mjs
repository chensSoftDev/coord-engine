import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { GitCoordinationStore } from '../../lib/coordination/git-store.mjs';
import {
  acquireLease,
  assertLease,
  assertVersionLease,
  breakLease,
  reconcileLeaseOperation,
  releaseLease,
  renewLease,
  revisionMatchesDeployment,
} from '../../lib/coordination/leases.mjs';
import {
  bindRequirementVersion,
  claimRequirement,
} from '../../lib/coordination/requirements.mjs';
import { initializeSession } from '../../lib/coordination/worktrees.mjs';
import { createGitFixture, runGit } from './fixtures.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const COORDINATION_SCRIPT = resolve(TEST_DIR, '../../scripts/coordination.mjs');

function createStore(cwd, tempRoot, clock) {
  return new GitCoordinationStore({
    cwd,
    remote: 'origin',
    branch: 'coordination',
    tempRoot,
    clock,
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

async function setupLeaseFixture(t, { initialNow = '2026-07-17T00:00:00.000Z' } = {}) {
  const fixture = createGitFixture(t);
  let now = new Date(initialNow);
  const clock = () => new Date(now);
  const store = createStore(fixture.clientA, fixture.tempRoot, clock);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const claimed = await claimRequirement({
    store,
    type: 'I',
    title: 'Lease requirement',
    profile: 'runtime',
    backlogText: '| I-001 | fixture |\n',
  });
  await bindRequirementVersion({ store, id: claimed.id, version: 'v0.2.32' });
  const branch = 'feature/v0.2.32/lease-requirement';
  await store.update({
    operation: `bind branch for ${claimed.id}`,
    mutate(snapshot) {
      const path = `requirements/${claimed.id}.json`;
      snapshot.writeJson(path, { ...snapshot.readJson(path), branch });
    },
  });
  runGit(fixture.clientA, ['switch', '-c', branch]);
  runGit(fixture.clientB, ['switch', '-c', branch]);
  const sessionA = initializeSession({
    cwd: fixture.clientA, agent: 'codex', user: 'developer', host: 'host-a', clock,
  });
  const sessionB = initializeSession({
    cwd: fixture.clientB, agent: 'kimi', user: 'developer', host: 'host-b', clock,
  });
  return {
    fixture,
    store,
    id: claimed.id,
    branch,
    commit: runGit(fixture.clientA, ['rev-parse', 'HEAD']),
    sessionA,
    sessionB,
    clock,
    setNow(value) { now = new Date(value); },
  };
}

test('acquires and asserts a lease bound to version, requirement, session, and branch', async (t) => {
  const context = await setupLeaseFixture(t);
  const acquired = await acquireLease({
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'dev',
    requirementId: context.id,
    ttl: '90m',
    session: context.sessionA,
    clock: context.clock,
  });

  assert.match(acquired.ownerToken, /^[0-9a-f-]{36}$/);
  assert.equal(acquired.secret, undefined);
  // I-130 (D1): the lease carries the requirement's bound version.
  assert.equal(acquired.version, 'v0.2.32');
  const asserted = await assertLease({
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'dev',
    requirementId: context.id,
    session: context.sessionA,
    clock: context.clock,
  });
  assert.equal(asserted.ownerToken, acquired.ownerToken);
  assert.equal(asserted.version, 'v0.2.32');
  assert.equal(asserted.branch, context.branch);
  assert.equal(asserted.commit, context.commit);
});

// I-130 (D1) helper: claim a sibling requirement bound to the same fixture
// branch, optionally with a different release version.
async function claimSiblingRequirement(context, { version }) {
  const claimed = await claimRequirement({
    store: context.store,
    type: 'I',
    title: 'Sibling lease requirement',
    profile: 'runtime',
    backlogText: '| I-001 | fixture |\n',
  });
  await bindRequirementVersion({ store: context.store, id: claimed.id, version });
  await context.store.update({
    operation: `bind branch for ${claimed.id}`,
    mutate(snapshot) {
      const path = `requirements/${claimed.id}.json`;
      snapshot.writeJson(path, { ...snapshot.readJson(path), branch: context.branch });
    },
  });
  return claimed.id;
}

test('acquire refuses a requirement without a bound version', async (t) => {
  const context = await setupLeaseFixture(t);
  const claimed = await claimRequirement({
    store: context.store,
    type: 'I',
    title: 'Unbound lease requirement',
    profile: 'runtime',
    backlogText: '| I-001 | fixture |\n',
  });
  await context.store.update({
    operation: `bind branch for ${claimed.id}`,
    mutate(snapshot) {
      const path = `requirements/${claimed.id}.json`;
      snapshot.writeJson(path, { ...snapshot.readJson(path), branch: context.branch });
    },
  });

  await assert.rejects(
    acquireLease({
      store: context.store,
      cwd: context.fixture.clientA,
      resource: 'dev',
      requirementId: claimed.id,
      ttl: '30m',
      session: context.sessionA,
      clock: context.clock,
    }),
    (error) => error.code === 'REQUIREMENT_VERSION_UNBOUND' && error.exitCode === 12,
  );
});

test('assertLease refuses a requirement whose version was unbound after acquire', async (t) => {
  const context = await setupLeaseFixture(t);
  await acquireLease({
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'dev',
    requirementId: context.id,
    ttl: '90m',
    session: context.sessionA,
    clock: context.clock,
  });
  await context.store.update({
    operation: `unbind version for ${context.id}`,
    mutate(snapshot) {
      const path = `requirements/${context.id}.json`;
      const requirement = snapshot.readJson(path);
      delete requirement.version;
      snapshot.writeJson(path, requirement);
    },
  });

  await assert.rejects(
    assertLease({
      store: context.store,
      cwd: context.fixture.clientA,
      resource: 'dev',
      requirementId: context.id,
      session: context.sessionA,
      clock: context.clock,
    }),
    (error) => error.code === 'REQUIREMENT_VERSION_UNBOUND' && error.exitCode === 12,
  );
});

// I-130 (D1): lease identity is version-level — the session owning the lock
// asserts for any same-version requirement; the recorded holder is
// informational only.
test('assertLease passes for a same-version requirement that is not the recorded holder', async (t) => {
  const context = await setupLeaseFixture(t);
  const siblingId = await claimSiblingRequirement(context, { version: 'v0.2.32' });
  await acquireLease({
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'dev',
    requirementId: context.id,
    ttl: '90m',
    session: context.sessionA,
    clock: context.clock,
  });

  const asserted = await assertLease({
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'dev',
    requirementId: siblingId,
    session: context.sessionA,
    clock: context.clock,
  });
  assert.equal(asserted.version, 'v0.2.32');
  assert.equal(asserted.holder?.id, context.id);
});

test('assertLease rejects a different bound version', async (t) => {
  const context = await setupLeaseFixture(t);
  const siblingId = await claimSiblingRequirement(context, { version: 'v0.2.33' });
  await acquireLease({
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'dev',
    requirementId: context.id,
    ttl: '90m',
    session: context.sessionA,
    clock: context.clock,
  });

  await assert.rejects(
    assertLease({
      store: context.store,
      cwd: context.fixture.clientA,
      resource: 'dev',
      requirementId: siblingId,
      session: context.sessionA,
      clock: context.clock,
    }),
    (error) => (
      error.code === 'LEASE_VERSION_MISMATCH'
      && error.exitCode === 11
      && error.data?.leaseVersion === 'v0.2.32'
      && error.data?.requirementVersion === 'v0.2.33'
    ),
  );
});

test('two independent same-version CLI acquires both succeed with a takeover audit', async (t) => {
  const context = await setupLeaseFixture(t, { initialNow: new Date() });
  const commonEnv = {
    COORD_REMOTE: 'origin',
    COORD_BRANCH: 'coordination',
    COORD_TEMP_ROOT: context.fixture.tempRoot,
  };

  // I-130 (D1): two processes racing the same version no longer conflict —
  // the later acquire is an audited takeover of the earlier one.
  const results = await Promise.all([
    runCoordination([
      'lock', 'acquire', 'dev', '--requirement', context.id, '--ttl', '90m', '--json',
    ], {
      ...commonEnv,
      COORD_CWD: context.fixture.clientA,
      COORD_SESSION_ID: context.sessionA.sessionId,
    }),
    runCoordination([
      'lock', 'acquire', 'dev', '--requirement', context.id, '--ttl', '90m', '--json',
    ], {
      ...commonEnv,
      COORD_CWD: context.fixture.clientB,
      COORD_SESSION_ID: context.sessionB.sessionId,
    }),
  ]);

  assert.deepEqual(results.map(({ status }) => status).sort(), [0, 0]);
  const remoteLock = (await context.store.readSnapshot()).readJson('locks/dev.json');
  assert.equal(remoteLock.active.version, 'v0.2.32');
  assert.equal(remoteLock.lastEvent.type, 'takeover');
  assert.ok(remoteLock.lastEvent.previous, 'the takeover records the previous lease');
  const winnerSessions = results.map((result) => JSON.parse(result.stdout).data.sessionId);
  assert.ok(winnerSessions.includes(remoteLock.active.sessionId));
});

test('a different-version CLI acquire loses to the occupied lease', async (t) => {
  const context = await setupLeaseFixture(t, { initialNow: new Date() });
  const siblingId = await claimSiblingRequirement(context, { version: 'v0.2.33' });
  const commonEnv = {
    COORD_REMOTE: 'origin',
    COORD_BRANCH: 'coordination',
    COORD_TEMP_ROOT: context.fixture.tempRoot,
  };

  const results = await Promise.all([
    runCoordination([
      'lock', 'acquire', 'dev', '--requirement', context.id, '--ttl', '90m', '--json',
    ], {
      ...commonEnv,
      COORD_CWD: context.fixture.clientA,
      COORD_SESSION_ID: context.sessionA.sessionId,
    }),
    runCoordination([
      'lock', 'acquire', 'dev', '--requirement', siblingId, '--ttl', '90m', '--json',
    ], {
      ...commonEnv,
      COORD_CWD: context.fixture.clientB,
      COORD_SESSION_ID: context.sessionB.sessionId,
    }),
  ]);

  assert.deepEqual(results.map(({ status }) => status).sort(), [0, 10]);
  const winner = results.find(({ status }) => status === 0);
  const occupied = results.find(({ status }) => status === 10);
  const winnerData = JSON.parse(winner.stdout).data;
  assert.equal(winnerData.resource, 'dev');
  assert.equal(JSON.parse(occupied.stderr).code, 'RESOURCE_OCCUPIED');
  const remoteLock = (await context.store.readSnapshot()).readJson('locks/dev.json');
  assert.equal(remoteLock.active.ownerToken, winnerData.ownerToken);
  assert.equal(remoteLock.active.sessionId, winnerData.sessionId);
});

test('a merged requirement can lease from a main checkout containing its merge commit', async (t) => {
  const context = await setupLeaseFixture(t);
  runGit(context.fixture.clientA, ['switch', 'main']);
  runGit(context.fixture.clientA, ['merge', '--ff-only', context.branch]);
  runGit(context.fixture.clientA, ['push', 'origin', 'main']);
  const mergedCommit = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  runGit(context.fixture.clientA, ['switch', context.branch]);
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

  // A batch sibling advances main beyond this requirement's merge commit.
  runGit(context.fixture.clientB, ['switch', 'main']);
  runGit(context.fixture.clientB, ['pull', '--ff-only', 'origin', 'main']);
  writeFileSync(join(context.fixture.clientB, 'docs-batch-sibling.md'), 'sibling requirement work\n');
  runGit(context.fixture.clientB, ['add', 'docs-batch-sibling.md']);
  runGit(context.fixture.clientB, ['commit', '-m', 'test: sibling batch commit']);
  const batchCommit = runGit(context.fixture.clientB, ['rev-parse', 'HEAD']);

  const acquired = await acquireLease({
    store: context.store,
    cwd: context.fixture.clientB,
    resource: 'prod',
    requirementId: context.id,
    ttl: '30m',
    session: context.sessionB,
    clock: context.clock,
  });
  assert.equal(acquired.branch, 'main');
  assert.equal(acquired.commit, batchCommit);

  // A merge fact that main does not contain still fails the branch exemption.
  runGit(context.fixture.clientB, ['switch', '-c', 'unrelated-work', context.commit]);
  writeFileSync(join(context.fixture.clientB, 'unrelated.md'), 'unrelated work\n');
  runGit(context.fixture.clientB, ['add', 'unrelated.md']);
  runGit(context.fixture.clientB, ['commit', '-m', 'test: unrelated commit']);
  const unrelated = runGit(context.fixture.clientB, ['rev-parse', 'HEAD']);
  runGit(context.fixture.clientB, ['switch', 'main']);
  await context.store.update({
    operation: 'record unrelated merge fact',
    mutate(snapshot) {
      const path = `requirements/${context.id}.json`;
      snapshot.writeJson(path, { ...snapshot.readJson(path), mergedCommit: unrelated });
    },
  });
  await assert.rejects(
    acquireLease({
      store: context.store,
      cwd: context.fixture.clientB,
      resource: 'dev',
      requirementId: context.id,
      ttl: '30m',
      session: context.sessionB,
      clock: context.clock,
    }),
    (error) => error.code === 'BRANCH_MISMATCH',
  );
});

test('rejects lease TTL values outside the supported range', async (t) => {
  const context = await setupLeaseFixture(t);
  for (const ttl of ['1m', '9h']) {
    await assert.rejects(
      acquireLease({
        store: context.store,
        cwd: context.fixture.clientA,
        resource: 'dev',
        requirementId: context.id,
        ttl,
        session: context.sessionA,
        clock: context.clock,
      }),
      (error) => error.code === 'INVALID_TTL' && error.exitCode === 14,
    );
  }
});

test('non-holders cannot renew or release a lease', async (t) => {
  const context = await setupLeaseFixture(t);
  const acquired = await acquireLease({
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'dev',
    requirementId: context.id,
    ttl: '90m',
    session: context.sessionA,
    clock: context.clock,
  });

  await assert.rejects(
    renewLease({
      store: context.store,
      cwd: context.fixture.clientB,
      resource: 'dev',
      ttl: '30m',
      session: context.sessionB,
      ownerToken: acquired.ownerToken,
      clock: context.clock,
    }),
    (error) => error.code === 'NOT_LEASE_HOLDER' && error.exitCode === 10,
  );
  await assert.rejects(
    releaseLease({
      store: context.store,
      cwd: context.fixture.clientA,
      resource: 'dev',
      session: context.sessionA,
      ownerToken: '00000000-0000-4000-8000-000000000000',
      clock: context.clock,
    }),
    (error) => error.code === 'NOT_LEASE_HOLDER' && error.exitCode === 10,
  );
});

test('the holder can renew and release while preserving the last audit event', async (t) => {
  const context = await setupLeaseFixture(t);
  await acquireLease({
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'dev',
    requirementId: context.id,
    ttl: '90m',
    session: context.sessionA,
    clock: context.clock,
  });
  context.setNow('2026-07-17T00:30:00.000Z');
  const renewed = await renewLease({
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'dev',
    ttl: '30m',
    session: context.sessionA,
    clock: context.clock,
  });
  assert.equal(renewed.expiresAt, '2026-07-17T01:00:00.000Z');

  await releaseLease({
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'dev',
    session: context.sessionA,
    clock: context.clock,
  });
  const lock = (await context.store.readSnapshot()).readJson('locks/dev.json');
  assert.equal(lock.active, null);
  assert.equal(lock.lastEvent.type, 'release');
  assert.equal(lock.lastEvent.previous.ownerToken, renewed.ownerToken);
});

// I-130 (D1): float-commit — renewing moves the lease commit to the branch
// tip instead of requiring commit equality; only branch drift is rejected.
test('renew floats the lease commit to the branch tip and still rejects branch drift', async (t) => {
  const context = await setupLeaseFixture(t);
  await acquireLease({
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'dev',
    requirementId: context.id,
    ttl: '90m',
    session: context.sessionA,
    clock: context.clock,
  });
  writeFileSync(join(context.fixture.clientA, 'BACKLOG.md'), '| I-002 | Testing |\n');
  runGit(context.fixture.clientA, ['add', 'BACKLOG.md']);
  runGit(context.fixture.clientA, ['commit', '-m', 'docs: project lifecycle status']);
  const projectionHead = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  context.setNow('2026-07-17T00:30:00.000Z');

  const renewed = await renewLease({
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'dev',
    ttl: '30m',
    session: context.sessionA,
    clock: context.clock,
  });
  assert.equal(renewed.expiresAt, '2026-07-17T01:00:00.000Z');
  assert.equal(renewed.commit, projectionHead, 'renew floats the lease commit to HEAD');

  // Any content drift floats too — the lease is no longer the commit anchor.
  writeFileSync(join(context.fixture.clientA, 'runtime-change.md'), 'runtime change\n');
  runGit(context.fixture.clientA, ['add', 'runtime-change.md']);
  runGit(context.fixture.clientA, ['commit', '-m', 'feat: change runtime input']);
  const runtimeHead = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  context.setNow('2026-07-17T00:45:00.000Z');
  const refloated = await renewLease({
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'dev',
    ttl: '30m',
    session: context.sessionA,
    clock: context.clock,
  });
  assert.equal(refloated.commit, runtimeHead, 'renew floats past any commit drift');

  // Branch drift is still rejected.
  runGit(context.fixture.clientA, ['switch', 'main']);
  await assert.rejects(
    renewLease({
      store: context.store,
      cwd: context.fixture.clientA,
      resource: 'dev',
      ttl: '30m',
      session: context.sessionA,
      clock: context.clock,
    }),
    (error) => error.code === 'LEASE_REVISION_MISMATCH' && error.exitCode === 11,
  );
});

// I-130 (D1): an occupied slot passes to a same-version acquire immediately
// as an audited takeover — no expiry wait.
test('a same-version acquire takes over an occupied lease immediately', async (t) => {
  const context = await setupLeaseFixture(t);
  await acquireLease({
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'dev',
    requirementId: context.id,
    ttl: '5m',
    session: context.sessionA,
    clock: context.clock,
  });

  context.setNow('2026-07-17T00:01:00.000Z');
  const takeover = await acquireLease({
    store: context.store,
    cwd: context.fixture.clientB,
    resource: 'dev',
    requirementId: context.id,
    ttl: '30m',
    session: context.sessionB,
    clock: context.clock,
  });
  assert.equal(takeover.sessionId, context.sessionB.sessionId);
  assert.equal(takeover.version, 'v0.2.32');
  const lock = (await context.store.readSnapshot()).readJson('locks/dev.json');
  assert.equal(lock.lastEvent.type, 'takeover');
  assert.equal(lock.lastEvent.previous.sessionId, context.sessionA.sessionId);
});

// A different version keeps the occupied conflict until the lease expires
// (plus the five-minute clock skew), then takes over like an expired lease.
test('a different-version acquire waits for expiry plus five minutes of clock skew', async (t) => {
  const context = await setupLeaseFixture(t);
  await acquireLease({
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'dev',
    requirementId: context.id,
    ttl: '5m',
    session: context.sessionA,
    clock: context.clock,
  });
  const siblingId = await claimSiblingRequirement(context, { version: 'v0.2.33' });

  context.setNow('2026-07-17T00:09:00.000Z');
  await assert.rejects(
    acquireLease({
      store: context.store,
      cwd: context.fixture.clientB,
      resource: 'dev',
      requirementId: siblingId,
      ttl: '30m',
      session: context.sessionB,
      clock: context.clock,
    }),
    (error) => error.code === 'RESOURCE_OCCUPIED' && error.exitCode === 10,
  );

  context.setNow('2026-07-17T00:11:00.000Z');
  const takeover = await acquireLease({
    store: context.store,
    cwd: context.fixture.clientB,
    resource: 'dev',
    requirementId: siblingId,
    ttl: '30m',
    session: context.sessionB,
    clock: context.clock,
  });
  assert.equal(takeover.sessionId, context.sessionB.sessionId);
  assert.equal(takeover.version, 'v0.2.33');
  const lock = (await context.store.readSnapshot()).readJson('locks/dev.json');
  assert.equal(lock.lastEvent.type, 'takeover');
  assert.equal(lock.lastEvent.previous.sessionId, context.sessionA.sessionId);
});

test('the old holder cannot assert or renew after TTL while takeover observes skew', async (t) => {
  const context = await setupLeaseFixture(t);
  await acquireLease({
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'dev',
    requirementId: context.id,
    ttl: '5m',
    session: context.sessionA,
    clock: context.clock,
  });
  context.setNow('2026-07-17T00:06:00.000Z');

  await assert.rejects(
    assertLease({
      store: context.store,
      cwd: context.fixture.clientA,
      resource: 'dev',
      requirementId: context.id,
      session: context.sessionA,
      clock: context.clock,
    }),
    (error) => error.code === 'LEASE_EXPIRED' && error.exitCode === 11,
  );
  await assert.rejects(
    renewLease({
      store: context.store,
      cwd: context.fixture.clientA,
      resource: 'dev',
      ttl: '30m',
      session: context.sessionA,
      clock: context.clock,
    }),
    (error) => error.code === 'LEASE_EXPIRED' && error.exitCode === 11,
  );
});

test('break requires a reason and audits forced takeover of an active lease', async (t) => {
  const context = await setupLeaseFixture(t);
  await acquireLease({
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'prod',
    requirementId: context.id,
    ttl: '90m',
    session: context.sessionA,
    clock: context.clock,
  });

  await assert.rejects(
    breakLease({
      store: context.store,
      cwd: context.fixture.clientB,
      resource: 'prod',
      reason: 'short',
      force: true,
      session: context.sessionB,
      clock: context.clock,
    }),
    /break reason must be at least 10 characters/,
  );
  await assert.rejects(
    breakLease({
      store: context.store,
      cwd: context.fixture.clientB,
      resource: 'prod',
      reason: 'owner is still active',
      session: context.sessionB,
      clock: context.clock,
    }),
    (error) => error.code === 'RESOURCE_OCCUPIED' && error.exitCode === 10,
  );

  await breakLease({
    store: context.store,
    cwd: context.fixture.clientB,
    resource: 'prod',
    reason: 'owner session crashed during release',
    force: true,
    session: context.sessionB,
    clock: context.clock,
  });
  const lock = (await context.store.readSnapshot()).readJson('locks/prod.json');
  assert.equal(lock.active, null);
  assert.equal(lock.lastEvent.type, 'break');
  assert.equal(lock.lastEvent.reason, 'owner session crashed during release');
  assert.equal(lock.lastEvent.previous.sessionId, context.sessionA.sessionId);
  assert.equal(lock.lastEvent.actor.sessionId, context.sessionB.sessionId);
});

test('reconciles an immutable lease operation only when its local owner token matches', async (t) => {
  const context = await setupLeaseFixture(t);
  const acquired = await acquireLease({
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'dev',
    requirementId: context.id,
    ttl: '90m',
    session: context.sessionA,
    clock: context.clock,
  });

  const reconciled = await reconcileLeaseOperation({
    store: context.store,
    cwd: context.fixture.clientA,
    operationId: acquired.operationId,
  });
  assert.equal(reconciled.applied, true);
  assert.equal(reconciled.ownerToken, acquired.ownerToken);

  // I-128 (H3): an operation with no audit record and no local record is
  // decisively not-applied, not "uncertain" forever.
  const missing = await reconcileLeaseOperation({
    store: context.store,
    cwd: context.fixture.clientA,
    operationId: '00000000-0000-4000-8000-000000000000',
  });
  assert.equal(missing.applied, false);
  assert.equal(missing.localRecordFound, false);
  assert.equal(missing.metadata, null);
});

test('CLI asserts HEAD and reconciles a lease operation as stable JSON', async (t) => {
  const context = await setupLeaseFixture(t, { initialNow: new Date() });
  const acquired = await acquireLease({
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'dev',
    requirementId: context.id,
    ttl: '90m',
    session: context.sessionA,
    clock: context.clock,
  });
  const env = {
    COORD_CWD: context.fixture.clientA,
    COORD_REMOTE: 'origin',
    COORD_BRANCH: 'coordination',
    COORD_TEMP_ROOT: context.fixture.tempRoot,
    COORD_SESSION_ID: context.sessionA.sessionId,
  };

  const asserted = await runCoordination([
    'lock', 'assert', 'dev', '--requirement', context.id, '--commit', 'HEAD', '--json',
  ], env);
  assert.equal(asserted.status, 0);
  assert.equal(JSON.parse(asserted.stdout).data.commit, context.commit);

  const reconciled = await runCoordination([
    'reconcile', '--operation', acquired.operationId, '--json',
  ], env);
  assert.equal(reconciled.status, 0);
  assert.equal(JSON.parse(reconciled.stdout).data.ownerToken, acquired.ownerToken);
});

function commitRuntimeArtifactInputs(cwd) {
  mkdirSync(join(cwd, '.agents'), { recursive: true });
  writeFileSync(join(cwd, '.agents', 'runtime-artifact-inputs.json'), `${JSON.stringify({
    schemaVersion: 1,
    services: { api: { includes: ['apps/api/**'], excludes: [] } },
  }, null, 2)}\n`);
  mkdirSync(join(cwd, 'apps', 'api'), { recursive: true });
  writeFileSync(
    join(cwd, 'apps', 'api', 'Dockerfile'),
    'FROM node:22-alpine\nCOPY apps/api ./apps/api\n',
  );
  runGit(cwd, ['add', '.agents', 'apps']);
  runGit(cwd, ['commit', '-m', 'test: declare runtime artifact inputs']);
  return runGit(cwd, ['rev-parse', 'HEAD']);
}

// I-130 (D1): the lease commit is informational — assertion checks ownership,
// the bound version, the branch and the caller-declared expected commit, but
// never the drift between the lease commit and HEAD.
test('lease assertion ignores commit drift behind the floating lease commit', async (t) => {
  const context = await setupLeaseFixture(t);
  const cwd = context.fixture.clientA;
  const leaseCommit = commitRuntimeArtifactInputs(cwd);
  await acquireLease({
    store: context.store,
    cwd,
    resource: 'dev',
    requirementId: context.id,
    ttl: '90m',
    session: context.sessionA,
    clock: context.clock,
  });

  mkdirSync(join(cwd, 'docs', 'ops'), { recursive: true });
  writeFileSync(join(cwd, 'docs', 'ops', 'note.md'), '# note\n');
  runGit(cwd, ['add', 'docs']);
  runGit(cwd, ['commit', '-m', 'docs: update ops note']);

  mkdirSync(join(cwd, 'apps', 'api', 'src'), { recursive: true });
  writeFileSync(join(cwd, 'apps', 'api', 'src', 'change.ts'), 'export {};\n');
  runGit(cwd, ['add', 'apps']);
  runGit(cwd, ['commit', '-m', 'feat: change runtime code']);

  const asserted = await assertLease({
    store: context.store,
    cwd,
    resource: 'dev',
    requirementId: context.id,
    session: context.sessionA,
    clock: context.clock,
  });
  assert.equal(asserted.commit, leaseCommit, 'the lease commit stays the informational acquire-time commit');
  assert.equal(asserted.branch, context.branch);
  assert.equal(asserted.version, 'v0.2.32');
});

// The caller-declared expected commit must still equal the working-tree HEAD:
// asserting a stale commit is a revision mismatch even though the lease
// itself no longer anchors one.
test('lease assertion rejects a stale expected commit', async (t) => {
  const context = await setupLeaseFixture(t);
  const cwd = context.fixture.clientA;
  const leaseCommit = commitRuntimeArtifactInputs(cwd);
  await acquireLease({
    store: context.store,
    cwd,
    resource: 'dev',
    requirementId: context.id,
    ttl: '90m',
    session: context.sessionA,
    clock: context.clock,
  });

  mkdirSync(join(cwd, 'docs', 'ops'), { recursive: true });
  writeFileSync(join(cwd, 'docs', 'ops', 'note.md'), '# note\n');
  runGit(cwd, ['add', 'docs']);
  runGit(cwd, ['commit', '-m', 'docs: update ops note']);

  await assert.rejects(
    assertLease({
      store: context.store,
      cwd,
      resource: 'dev',
      requirementId: context.id,
      commit: leaseCommit,
      session: context.sessionA,
      clock: context.clock,
    }),
    (error) => error.code === 'LEASE_REVISION_MISMATCH' && error.exitCode === 11,
  );
});

test('revisionMatchesDeployment reuses deployments only for non-runtime-affecting drift', async (t) => {
  const context = await setupLeaseFixture(t);
  const cwd = context.fixture.clientA;
  const leaseCommit = commitRuntimeArtifactInputs(cwd);

  assert.deepEqual(
    revisionMatchesDeployment({
      cwd,
      requirementId: context.id,
      fromCommit: leaseCommit,
      toCommit: leaseCommit,
    }),
    { matches: true, policy: null },
    'an exact commit match never needs policy evaluation',
  );

  mkdirSync(join(cwd, 'docs', 'ops'), { recursive: true });
  writeFileSync(join(cwd, 'docs', 'ops', 'note.md'), '# note\n');
  runGit(cwd, ['add', 'docs']);
  runGit(cwd, ['commit', '-m', 'docs: update ops note']);
  const docsDrift = revisionMatchesDeployment({
    cwd,
    requirementId: context.id,
    fromCommit: leaseCommit,
    toCommit: 'HEAD',
  });
  assert.equal(docsDrift.matches, true);
  assert.equal(docsDrift.policy.classification, 'deployment-neutral');

  mkdirSync(join(cwd, 'apps', 'api', 'src'), { recursive: true });
  writeFileSync(join(cwd, 'apps', 'api', 'src', 'change.ts'), 'export {};\n');
  runGit(cwd, ['add', 'apps']);
  runGit(cwd, ['commit', '-m', 'feat: change runtime code']);
  const runtimeDrift = revisionMatchesDeployment({
    cwd,
    requirementId: context.id,
    fromCommit: leaseCommit,
    toCommit: 'HEAD',
  });
  assert.equal(runtimeDrift.matches, false);
  assert.equal(runtimeDrift.policy.classification, 'runtime-affecting');
});

test('revisionMatchesDeployment stays fail-closed on policy hard failures', async (t) => {
  const context = await setupLeaseFixture(t);
  const cwd = context.fixture.clientA;
  const leaseCommit = commitRuntimeArtifactInputs(cwd);
  runGit(cwd, ['mv', 'README.md', 'README-renamed.md']);
  runGit(cwd, ['commit', '-m', 'test: rename a tracked file']);

  const result = revisionMatchesDeployment({
    cwd,
    requirementId: context.id,
    fromCommit: leaseCommit,
    toCommit: 'HEAD',
  });
  assert.equal(result.matches, false);
  assert.equal(result.policy.code, 'REVISION_POLICY_HARDFAIL');
});

// I-113 review: a malformed freezes/dev.json must fail closed with
// INVALID_FREEZE_STATE — breakLease must not proceed, even with force.
test('break fails closed on a malformed freeze fact, even with force', async (t) => {
  const context = await setupLeaseFixture(t);
  await acquireLease({
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'dev',
    requirementId: context.id,
    ttl: '8h',
    session: context.sessionA,
    clock: context.clock,
  });
  const malformed = { schemaVersion: 1, resource: 'dev', state: 'awaiting_human' };
  await context.store.update({
    operation: 'inject malformed freeze fact',
    mutate(snapshot) {
      snapshot.writeJson('freezes/dev.json', malformed);
    },
  });

  await assert.rejects(
    breakLease({
      store: context.store,
      cwd: context.fixture.clientB,
      resource: 'dev',
      reason: 'operator cleanup attempt on malformed state',
      force: true,
      session: context.sessionB,
      clock: context.clock,
    }),
    (error) => error.code === 'INVALID_FREEZE_STATE',
  );

  const snapshot = await context.store.readSnapshot();
  assert.deepEqual(
    snapshot.readJson('freezes/dev.json'),
    malformed,
    'the malformed freeze fact must be left untouched',
  );
  assert.notEqual(
    snapshot.readJson('locks/dev.json').active,
    null,
    'the break must not proceed past the malformed freeze fact',
  );
});

// ============================================================================
// I-113 Task 5 (prod-build slice): the prod-build lock serializes candidate
// prebuilds on the prod host and is mutually exclusive with the formal prod
// deploy/rollback lease. It never grants release permission by itself.
// ============================================================================

test('prod-build lock is mutually exclusive with the prod deploy lease', async (t) => {
  const context = await setupLeaseFixture(t);

  // Hold the prod-build lock first: a formal prod lease must be refused.
  const buildLock = await acquireLease({
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'prod-build',
    requirementId: context.id,
    ttl: '30m',
    session: context.sessionA,
    clock: context.clock,
  });
  assert.equal(buildLock.holder?.id, context.id);
  assert.equal(buildLock.resource, 'prod-build');

  await assert.rejects(
    acquireLease({
      store: context.store,
      cwd: context.fixture.clientB,
      resource: 'prod',
      requirementId: context.id,
      ttl: '30m',
      session: context.sessionB,
      clock: context.clock,
    }),
    (error) => error.code === 'PROD_LEASE_BLOCKED_BY_BUILD' && error.exitCode === 10,
  );

  // Release the build lock, then the prod lease wins and a new build lock is
  // refused.
  await releaseLease({
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'prod-build',
    session: context.sessionA,
    clock: context.clock,
  });
  await acquireLease({
    store: context.store,
    cwd: context.fixture.clientB,
    resource: 'prod',
    requirementId: context.id,
    ttl: '30m',
    session: context.sessionB,
    clock: context.clock,
  });
  await assert.rejects(
    acquireLease({
      store: context.store,
      cwd: context.fixture.clientA,
      resource: 'prod-build',
      requirementId: context.id,
      ttl: '30m',
      session: context.sessionA,
      clock: context.clock,
    }),
    (error) => error.code === 'PROD_BUILD_BLOCKED_BY_LEASE' && error.exitCode === 10,
  );
});

test('prod-build lock does not grant release permission and follows lease rules', async (t) => {
  const context = await setupLeaseFixture(t);
  const buildLock = await acquireLease({
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'prod-build',
    requirementId: context.id,
    ttl: '30m',
    session: context.sessionA,
    clock: context.clock,
  });

  // A non-holder cannot release the prod-build lock.
  await assert.rejects(
    releaseLease({
      store: context.store,
      cwd: context.fixture.clientB,
      resource: 'prod-build',
      session: context.sessionB,
      clock: context.clock,
    }),
    (error) => error.code === 'NOT_LEASE_HOLDER' || error.code === 'LEASE_TOKEN_MISSING',
  );

  // Within the TTL the slot stays occupied for a different version (I-130
  // D1: a same-version acquire would take over immediately instead).
  const siblingId = await claimSiblingRequirement(context, { version: 'v0.2.33' });
  context.setNow('2026-07-17T00:20:00.000Z');
  await assert.rejects(
    acquireLease({
      store: context.store,
      cwd: context.fixture.clientB,
      resource: 'prod-build',
      requirementId: siblingId,
      ttl: '30m',
      session: context.sessionB,
      clock: context.clock,
    }),
    (error) => error.code === 'RESOURCE_OCCUPIED' && error.exitCode === 10,
  );

  // After expiry plus clock skew the slot is re-acquirable.
  context.setNow('2026-07-17T00:36:00.000Z');
  const reacquired = await acquireLease({
    store: context.store,
    cwd: context.fixture.clientB,
    resource: 'prod-build',
    requirementId: siblingId,
    ttl: '30m',
    session: context.sessionB,
    clock: context.clock,
  });
  assert.equal(reacquired.holder?.id, siblingId);
  assert.equal(buildLock.holder?.id, context.id);
});

// I-128 (H3): the remote audit record is authoritative for non-lease
// operations too — no more permanent "uncertain" dead end.
test('reconciles a non-lease operation from its remote audit record', async (t) => {
  const context = await setupLeaseFixture(t);
  await context.store.update({
    operation: 'issue dev guard ticket for I-057',
    operationId: 'non-lease-operation',
    auditData: { kind: 'guard-ticket', stage: 'dev', requirementId: context.id },
    mutate(snapshot) {
      snapshot.writeJson(`guard-tickets/${'f'.repeat(64)}.json`, { schemaVersion: 1 });
    },
  });

  const result = await reconcileLeaseOperation({
    store: context.store,
    cwd: context.fixture.clientA,
    operationId: 'non-lease-operation',
  });
  assert.equal(result.applied, true);
  assert.equal(result.metadata.kind, 'guard-ticket');
  assert.equal(result.localRecordFound, false);
});

// I-128 (H4): an option the command does not consume (here --dry-run on a
// write command) is rejected instead of silently ignored.
test('CLI rejects options the command does not consume', async (t) => {
  const context = await setupLeaseFixture(t);
  const result = await runCoordination(
    ['lock', 'acquire', 'dev', '--requirement', context.id, '--ttl', '1h', '--dry-run', '--json'],
    {
      COORD_CWD: context.fixture.clientA,
      COORD_REMOTE: 'origin',
      COORD_BRANCH: 'coordination',
      COORD_TEMP_ROOT: context.fixture.tempRoot,
      COORD_SESSION_ID: context.sessionA.sessionId,
    },
  );
  assert.equal(result.status, 14);
  const error = JSON.parse(result.stderr);
  assert.equal(error.code, 'CLI_USAGE');
  assert.match(error.message, /--dry-run/);
  const snapshot = await context.store.readSnapshot();
  assert.equal(snapshot.has('locks/dev.json'), false);
});

// I-128 (H4): an unknown subcommand names the valid ones instead of the
// misleading "not implemented yet".
test('unknown subcommands list the valid ones', async () => {
  const result = await runCoordination(['session', 'list', '--json'], {});
  assert.equal(result.status, 14);
  const error = JSON.parse(result.stderr);
  assert.equal(error.code, 'CLI_USAGE');
  assert.match(error.message, /init, show/);
});

// ============================================================================
// I-134 (F1): assertLease is split into an identity segment (holder, expiry,
// version binding) and a revision segment (branch + expected commit).
// assertVersionLease runs the identity segment plus the branch leg — the
// commit leg is exempt so deployment recording tolerates neutral commits on
// top of the floating lease commit, but the branch never floats (I-134
// review); assertLease keeps running both segments unchanged.
// ============================================================================

test('assertVersionLease tolerates a HEAD ahead of the floating lease commit', async (t) => {
  const context = await setupLeaseFixture(t);
  const acquired = await acquireLease({
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'dev',
    requirementId: context.id,
    ttl: '90m',
    session: context.sessionA,
    clock: context.clock,
  });
  // A neutral BACKLOG projection commit moves the branch tip past the lease
  // commit without any renew.
  const staleCommit = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  writeFileSync(join(context.fixture.clientA, 'BACKLOG.md'), '| I-001 | fixture |\n| I-002 | projection |\n');
  runGit(context.fixture.clientA, ['add', 'BACKLOG.md']);
  runGit(context.fixture.clientA, ['commit', '-m', 'docs: backlog projection']);

  const asserted = await assertVersionLease({
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'dev',
    requirementId: context.id,
    session: context.sessionA,
    clock: context.clock,
  });
  assert.equal(asserted.ownerToken, acquired.ownerToken);
  assert.equal(asserted.version, 'v0.2.32');
  assert.equal(asserted.branch, context.branch);

  // The strict assertion still rejects the drifted working tree when the
  // caller pins the pre-drift commit.
  await assert.rejects(
    assertLease({
      store: context.store,
      cwd: context.fixture.clientA,
      resource: 'dev',
      requirementId: context.id,
      commit: staleCommit,
      session: context.sessionA,
      clock: context.clock,
    }),
    (error) => error.code === 'LEASE_REVISION_MISMATCH' && error.exitCode === 11,
  );
});

test('assertVersionLease keeps the holder, expiry and version rejections', async (t) => {
  const context = await setupLeaseFixture(t);
  await acquireLease({
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'dev',
    requirementId: context.id,
    ttl: '30m',
    session: context.sessionA,
    clock: context.clock,
  });

  await assert.rejects(
    assertVersionLease({
      store: context.store,
      cwd: context.fixture.clientB,
      resource: 'dev',
      requirementId: context.id,
      session: context.sessionB,
      clock: context.clock,
    }),
    (error) => error.code === 'NOT_LEASE_HOLDER' && error.exitCode === 10,
  );

  context.setNow('2026-07-17T01:00:00.000Z');
  await assert.rejects(
    assertVersionLease({
      store: context.store,
      cwd: context.fixture.clientA,
      resource: 'dev',
      requirementId: context.id,
      session: context.sessionA,
      clock: context.clock,
    }),
    (error) => error.code === 'LEASE_EXPIRED' && error.exitCode === 11,
  );
  context.setNow('2026-07-17T00:00:00.000Z');

  const siblingId = await claimSiblingRequirement(context, { version: 'v0.2.33' });
  await assert.rejects(
    assertVersionLease({
      store: context.store,
      cwd: context.fixture.clientA,
      resource: 'dev',
      requirementId: siblingId,
      session: context.sessionA,
      clock: context.clock,
    }),
    (error) => error.code === 'LEASE_VERSION_MISMATCH' && error.exitCode === 11,
  );
});

// I-134 (review): the commit leg is exempt but the branch leg is not — the
// local token lives in the shared git common dir, so without this check the
// lease would assert from any branch checkout in the same clone.
test('assertVersionLease rejects a working tree on a different branch', async (t) => {
  const context = await setupLeaseFixture(t);
  await acquireLease({
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'dev',
    requirementId: context.id,
    ttl: '90m',
    session: context.sessionA,
    clock: context.clock,
  });
  runGit(context.fixture.clientA, ['switch', '-c', 'feature/v0.2.32/other-workstream']);

  await assert.rejects(
    assertVersionLease({
      store: context.store,
      cwd: context.fixture.clientA,
      resource: 'dev',
      requirementId: context.id,
      session: context.sessionA,
      clock: context.clock,
    }),
    (error) => error.code === 'LEASE_REVISION_MISMATCH' && error.exitCode === 11,
  );
});

// ============================================================================
// I-134 (F2): a force break of an occupied lease leaves a durable audit fact
// (breaker, full previous holder snapshot, reason, operation id) in the same
// coordination commit; natural breaks of an expired lease and breaks of an
// empty slot write nothing.
// ============================================================================

test('force break writes a durable audit record in the same coordination commit', async (t) => {
  const context = await setupLeaseFixture(t);
  const acquired = await acquireLease({
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'prod',
    requirementId: context.id,
    ttl: '90m',
    session: context.sessionA,
    clock: context.clock,
  });

  const result = await breakLease({
    store: context.store,
    cwd: context.fixture.clientB,
    resource: 'prod',
    reason: 'owner session crashed during release',
    force: true,
    session: context.sessionB,
    clock: context.clock,
  });

  const snapshot = await context.store.readSnapshot();
  // The audit file and the lock mutation land in one coordination commit.
  assert.equal(snapshot.sha, result.coordinationSha);
  const auditPath = 'operations/force-breaks/2026-07-17T00-00-00.000Z-prod.json';
  assert.ok(snapshot.has(auditPath), 'force-break audit record is committed');
  const audit = snapshot.readJson(auditPath);
  assert.equal(audit.schemaVersion, 1);
  assert.equal(audit.resource, 'prod');
  assert.equal(audit.reason, 'owner session crashed during release');
  assert.equal(audit.brokenAt, '2026-07-17T00:00:00.000Z');
  assert.deepEqual(audit.breaker, {
    sessionId: context.sessionB.sessionId,
    agent: 'kimi',
    user: 'developer',
    host: 'host-b',
  });
  assert.equal(audit.operationId, result.operationId);
  // The full previous holder snapshot is preserved (owner token included).
  assert.equal(audit.previousActive.ownerToken, acquired.ownerToken);
  assert.equal(audit.previousActive.holder.id, context.id);
  assert.equal(audit.previousActive.sessionId, context.sessionA.sessionId);
  const lock = snapshot.readJson('locks/prod.json');
  assert.equal(lock.active, null);
  assert.deepEqual(audit.previousActive, lock.lastEvent.previous);
});

test('breaking an expired lease or an empty slot writes no force-break audit record', async (t) => {
  const context = await setupLeaseFixture(t);
  await acquireLease({
    store: context.store,
    cwd: context.fixture.clientA,
    resource: 'prod',
    requirementId: context.id,
    ttl: '30m',
    session: context.sessionA,
    clock: context.clock,
  });

  // Past expiry plus clock skew the break is natural — even with force no
  // audit record is written.
  context.setNow('2026-07-17T01:00:00.000Z');
  await breakLease({
    store: context.store,
    cwd: context.fixture.clientB,
    resource: 'prod',
    reason: 'expired lease cleanup after ttl',
    force: true,
    session: context.sessionB,
    clock: context.clock,
  });
  let snapshot = await context.store.readSnapshot();
  assert.equal(snapshot.readJson('locks/prod.json').active, null);
  assert.equal(
    snapshot.paths().filter((path) => path.startsWith('operations/force-breaks/')).length,
    0,
  );

  // Breaking an already empty slot writes nothing either.
  await breakLease({
    store: context.store,
    cwd: context.fixture.clientB,
    resource: 'prod',
    reason: 'second break on an empty slot',
    force: true,
    session: context.sessionB,
    clock: context.clock,
  });
  snapshot = await context.store.readSnapshot();
  assert.equal(
    snapshot.paths().filter((path) => path.startsWith('operations/force-breaks/')).length,
    0,
  );
});
