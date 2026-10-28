import assert from 'node:assert/strict';
import test from 'node:test';

import { main } from '../../lib/coordination/cli.mjs';
import { GitCoordinationStore } from '../../lib/coordination/git-store.mjs';
import {
  SchemaMigrationError,
  migrateSchema,
} from '../../lib/coordination/schema-migration.mjs';
import { createGitFixture, createMemoryIo } from './fixtures.mjs';

const NOW = '2026-08-20T00:00:00.000Z';

function createStore(cwd, tempRoot, clock) {
  return new GitCoordinationStore({
    cwd,
    remote: 'origin',
    branch: 'coordination',
    tempRoot,
    clock,
  });
}

// initialize() already writes schema v2, so pre-migration state is seeded
// explicitly through a regular update (v1 stays readable and writable until
// the flag-day migration runs).
async function setup(t) {
  const fixture = createGitFixture(t);
  const clock = () => new Date(NOW);
  const store = createStore(fixture.clientA, fixture.tempRoot, clock);
  await store.initialize();
  return { fixture, store, clock };
}

function activeLease({ version } = {}) {
  return {
    holder: { kind: 'requirement', id: 'I-130' },
    ...(version ? { version } : {}),
    sessionId: 'session-a',
    branch: 'feature/v0.11.0/coord-redesign-model',
    commit: 'a'.repeat(40),
    ownerToken: 'b'.repeat(36),
    acquiredAt: NOW,
    expiresAt: '2026-08-20T01:00:00.000Z',
  };
}

async function seedV1State(store, { devActive = null, prodActive = null } = {}) {
  await store.update({
    operation: 'seed v1 state',
    operationId: 'seed-v1-state',
    mutate(snapshot) {
      snapshot.writeJson('schema.json', { schemaVersion: 1, initializedAt: NOW });
      snapshot.writeJson('locks/dev.json', {
        schemaVersion: 1,
        resource: 'dev',
        active: devActive,
        lastEvent: null,
      });
      snapshot.writeJson('locks/prod.json', {
        schemaVersion: 1,
        resource: 'prod',
        active: prodActive,
        lastEvent: {
          type: 'break',
          at: NOW,
          actor: { sessionId: 'session-a', agent: 'kimi', user: 'developer', host: 'host-a' },
          reason: 'seeded history',
        },
      });
      snapshot.writeJson('requirements/I-130.json', { schemaVersion: 1, id: 'I-130' });
    },
  });
}

test('migrateSchema rewrites the root schema and locks to v2 in one update', async (t) => {
  const { store } = await setup(t);
  const prodActive = activeLease({ version: 'v0.11.0' });
  await seedV1State(store, { prodActive });

  const result = await migrateSchema({ store });

  assert.equal(result.changed, true);
  const snapshot = await store.readSnapshot();
  assert.deepEqual(snapshot.readJson('schema.json'), {
    schemaVersion: 2,
    initializedAt: NOW,
  });
  assert.deepEqual(snapshot.readJson('locks/dev.json'), {
    schemaVersion: 2,
    resource: 'dev',
    active: null,
    lastEvent: null,
  });
  const prod = snapshot.readJson('locks/prod.json');
  assert.equal(prod.schemaVersion, 2);
  assert.deepEqual(prod.active, prodActive);
  assert.equal(prod.lastEvent.type, 'break');
  // Other document kinds keep their own format version (I-130 D4).
  assert.equal(snapshot.readJson('requirements/I-130.json').schemaVersion, 1);
});

test('migrateSchema is idempotent once everything is at v2', async (t) => {
  const { store } = await setup(t);
  await seedV1State(store, { prodActive: activeLease({ version: 'v0.11.0' }) });

  const migrated = await migrateSchema({ store });
  const repeated = await migrateSchema({ store });

  assert.equal(migrated.changed, true);
  assert.equal(repeated.changed, false);
  const snapshot = await store.readSnapshot();
  assert.equal(snapshot.readJson('schema.json').schemaVersion, 2);
  assert.equal(snapshot.readJson('locks/dev.json').schemaVersion, 2);
  assert.equal(snapshot.readJson('locks/prod.json').schemaVersion, 2);
});

test('migrateSchema refuses an active lease without a version and writes nothing', async (t) => {
  const { store } = await setup(t);
  await seedV1State(store, {
    devActive: activeLease(),
    prodActive: activeLease({ version: 'v0.11.0' }),
  });

  await assert.rejects(
    migrateSchema({ store }),
    (error) => {
      assert.ok(error instanceof SchemaMigrationError);
      assert.equal(error.code, 'LOCK_VERSION_MISSING');
      assert.equal(error.exitCode, 12);
      assert.deepEqual(error.data.resources, ['dev']);
      assert.match(error.message, /pnpm coord lock release dev/);
      return true;
    },
  );

  // The mutation is atomic: the refusal leaves the pre-migration state intact.
  const snapshot = await store.readSnapshot();
  assert.equal(snapshot.readJson('schema.json').schemaVersion, 1);
  assert.equal(snapshot.readJson('locks/dev.json').schemaVersion, 1);
  assert.equal(snapshot.readJson('locks/prod.json').schemaVersion, 1);
});

test('coord migrate-schema reports the migration result as JSON', async (t) => {
  const { fixture, store, clock } = await setup(t);
  await seedV1State(store);
  const env = {
    COORD_CWD: fixture.clientA,
    COORD_REMOTE: 'origin',
    COORD_BRANCH: 'coordination',
    COORD_TEMP_ROOT: fixture.tempRoot,
  };
  const run = (argv) => {
    const memory = createMemoryIo();
    return main(argv, { ...memory.io, env, clock })
      .then((exitCode) => ({ exitCode, memory }));
  };

  const migrated = await run(['migrate-schema', '--json']);
  assert.equal(migrated.exitCode, 0, migrated.memory.stderr.join(''));
  const migratedResult = JSON.parse(migrated.memory.stdout.join(''));
  assert.equal(migratedResult.ok, true);
  assert.equal(migratedResult.message, 'migrated coordination state to schema v2');
  assert.equal(migratedResult.data.changed, true);

  const repeated = await run(['migrate-schema', '--json']);
  assert.equal(repeated.exitCode, 0, repeated.memory.stderr.join(''));
  const repeatedResult = JSON.parse(repeated.memory.stdout.join(''));
  assert.equal(repeatedResult.ok, true);
  assert.equal(repeatedResult.message, 'coordination state is already at schema v2');
  assert.equal(repeatedResult.data.changed, false);

  assert.equal((await store.readSnapshot()).readJson('schema.json').schemaVersion, 2);
});

test('coord migrate-schema exits 12 when an active lease lacks a version', async (t) => {
  const { fixture, store, clock } = await setup(t);
  await seedV1State(store, { devActive: activeLease() });
  const env = {
    COORD_CWD: fixture.clientA,
    COORD_REMOTE: 'origin',
    COORD_BRANCH: 'coordination',
    COORD_TEMP_ROOT: fixture.tempRoot,
  };
  const memory = createMemoryIo();

  const exitCode = await main(['migrate-schema', '--json'], { ...memory.io, env, clock });

  assert.equal(exitCode, 12);
  const result = JSON.parse(memory.stderr.join(''));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'LOCK_VERSION_MISSING');
  assert.deepEqual(result.data.resources, ['dev']);
  assert.equal((await store.readSnapshot()).readJson('schema.json').schemaVersion, 1);
});
