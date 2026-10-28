import assert from 'node:assert/strict';
import test from 'node:test';

import { GitCoordinationStore } from '../../lib/coordination/git-store.mjs';
import { main } from '../../lib/coordination/cli.mjs';
import {
  clearRequirementMerge,
  declareRequirementResources,
  setRequirementDatabaseTables,
  setRequirementMigration,
  startRequirement,
} from '../../lib/coordination/requirements.mjs';
import { createGitFixture, createMemoryIo } from './fixtures.mjs';

const CLOCK = '2026-10-15T00:00:00.000Z';
const MIGRATION_REASON = 'inv_swatches schema change needs a migration';
const TABLES_REASON = 'inv_swatches and parts schema changes';

function createStore(fixture) {
  return new GitCoordinationStore({
    cwd: fixture.clientA,
    remote: 'origin',
    branch: 'coordination',
    tempRoot: fixture.tempRoot,
    clock: () => new Date(CLOCK),
  });
}

async function setup(t, { migration = 'no' } = {}) {
  const fixture = createGitFixture(t);
  const store = createStore(fixture);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const started = await startRequirement({
    store,
    type: 'I',
    title: 'Fact corrections',
    profile: 'governance',
    uxImpact: 'none',
    topic: 'fact-corrections',
    migration,
    bump: 'patch',
    backlogText: '| I-001 | fixture |\n',
  });
  return { fixture, store, id: started.id };
}

async function setLifecycle(store, id, lifecycle) {
  await store.update({
    operation: `park ${id} at ${lifecycle}`,
    mutate(snapshot) {
      const path = `requirements/${id}.json`;
      snapshot.writeJson(path, { ...snapshot.readJson(path), lifecycle });
    },
  });
}

function cliEnv(fixture) {
  return {
    ...process.env,
    COORD_CWD: fixture.clientA,
    COORD_REMOTE: 'origin',
    COORD_BRANCH: 'coordination',
    COORD_TEMP_ROOT: fixture.tempRoot,
    COORD_AGENT: 'cli-agent',
    COORD_SESSION_ID: 'session-cli-243',
  };
}

test('I-243: set-migration corrects the assessment after start with an audited history', async (t) => {
  const { store, id } = await setup(t, { migration: 'no' });
  // I-243 itself is at Test Passed when the stale 否 is discovered.
  await setLifecycle(store, id, 'test_passed');

  await assert.rejects(
    setRequirementMigration({ store, id, migration: 'maybe', reason: MIGRATION_REASON }),
    { code: 'INVALID_MIGRATION_ASSESSMENT', exitCode: 12 },
  );
  await assert.rejects(
    setRequirementMigration({ store, id, migration: 'yes', reason: '' }),
    { code: 'INVALID_MIGRATION_REASON', exitCode: 12 },
  );
  await assert.rejects(
    setRequirementMigration({ store, id, migration: 'yes', reason: 'line one\nline two' }),
    { code: 'INVALID_MIGRATION_REASON', exitCode: 12 },
  );

  const result = await setRequirementMigration({
    store,
    id,
    migration: 'yes',
    reason: MIGRATION_REASON,
    actor: { agent: 'review-agent', sessionId: 'session-review-1' },
  });
  assert.equal(result.migrationAssessment, '是');

  const snapshot = await store.readSnapshot();
  const fact = snapshot.readJson(`requirements/${id}.json`);
  assert.equal(fact.migrationAssessment, '是');
  assert.deepEqual(fact.migrationAssessmentHistory, [{
    from: '否',
    to: '是',
    reason: MIGRATION_REASON,
    actor: 'review-agent',
    sessionId: 'session-review-1',
    at: CLOCK,
  }]);
  assert.deepEqual(snapshot.readJson(`operations/by-id/${result.operationId}.json`).metadata, {
    requirementId: id,
    migrationAssessment: '是',
    reason: MIGRATION_REASON,
    actor: 'review-agent',
    sessionId: 'session-review-1',
  });

  await assert.rejects(
    setRequirementMigration({ store, id, migration: 'yes', reason: MIGRATION_REASON }),
    { code: 'MIGRATION_ALREADY_SET', exitCode: 14 },
  );

  await setLifecycle(store, id, 'done');
  await assert.rejects(
    setRequirementMigration({ store, id, migration: 'no', reason: MIGRATION_REASON }),
    { code: 'MIGRATION_STATE_NOT_ALLOWED', exitCode: 14 },
  );
});

test('I-243: set-database-tables records an audited correction and preserves other resources', async (t) => {
  const { store, id } = await setup(t);
  await declareRequirementResources({
    store,
    id,
    resources: { files: ['apps/api/schema.sql'], services: ['api'] },
  });
  await setLifecycle(store, id, 'test_passed');

  await assert.rejects(
    setRequirementDatabaseTables({ store, id, tables: [], reason: TABLES_REASON }),
    { code: 'INVALID_DATABASE_TABLES', exitCode: 12 },
  );
  await assert.rejects(
    setRequirementDatabaseTables({
      store, id, tables: ['inv_swatches', 'Bad-Table'], reason: TABLES_REASON,
    }),
    { code: 'INVALID_DATABASE_TABLES', exitCode: 12 },
  );
  await assert.rejects(
    setRequirementDatabaseTables({ store, id, tables: ['inv_swatches'], reason: 'too short' }),
    { code: 'INVALID_DATABASE_TABLES_REASON', exitCode: 12 },
  );

  const result = await setRequirementDatabaseTables({
    store,
    id,
    tables: ['inv_swatches', 'parts'],
    reason: TABLES_REASON,
    actor: { agent: 'review-agent', sessionId: 'session-review-1' },
  });
  assert.deepEqual(result.databaseTables, ['inv_swatches', 'parts']);
  assert.deepEqual(result.previousTables, []);

  const snapshot = await store.readSnapshot();
  const fact = snapshot.readJson(`requirements/${id}.json`);
  assert.deepEqual(fact.resources.databaseTables, ['inv_swatches', 'parts']);
  // The correction never wipes the other declared resource keys.
  assert.deepEqual(fact.resources.files, ['apps/api/schema.sql']);
  assert.deepEqual(fact.resources.services, ['api']);
  assert.deepEqual(fact.databaseTablesHistory, [{
    from: [],
    to: ['inv_swatches', 'parts'],
    reason: TABLES_REASON,
    actor: 'review-agent',
    sessionId: 'session-review-1',
    at: CLOCK,
  }]);
  assert.deepEqual(snapshot.readJson(`operations/by-id/${result.operationId}.json`).metadata, {
    requirementId: id,
    databaseTables: ['inv_swatches', 'parts'],
    reason: TABLES_REASON,
    actor: 'review-agent',
    sessionId: 'session-review-1',
  });

  await assert.rejects(
    setRequirementDatabaseTables({
      store, id, tables: ['inv_swatches', 'parts'], reason: TABLES_REASON,
    }),
    { code: 'DATABASE_TABLES_UNCHANGED', exitCode: 14 },
  );

  await setLifecycle(store, id, 'done');
  await assert.rejects(
    setRequirementDatabaseTables({
      store, id, tables: ['inv_swatches'], reason: TABLES_REASON,
    }),
    { code: 'DATABASE_TABLES_STATE_NOT_ALLOWED', exitCode: 14 },
  );
});

test('I-243: clear-merge removes a stale merge fact with an audited history', async (t) => {
  const { store, id } = await setup(t);
  const staleCommit = 'e3eace3248af0bec246f5a9aa2e8a68a3003e06f';
  await store.update({
    operation: `stale merge ${id}`,
    mutate(snapshot) {
      const path = `requirements/${id}.json`;
      snapshot.writeJson(path, {
        ...snapshot.readJson(path),
        lifecycle: 'test_passed',
        mergeStatus: 'merged',
        mergedCommit: staleCommit,
        mergedAt: CLOCK,
      });
    },
  });

  await assert.rejects(
    clearRequirementMerge({ store, id, reason: '' }),
    { code: 'INVALID_MERGE_REASON', exitCode: 12 },
  );

  const result = await clearRequirementMerge({
    store,
    id,
    reason: 'reworked commit is not contained in the historical merge',
    actor: { agent: 'review-agent', sessionId: 'session-review-1' },
  });
  assert.deepEqual(result.previousMerge, {
    mergeStatus: 'merged', mergedCommit: staleCommit, mergedAt: CLOCK,
  });

  const snapshot = await store.readSnapshot();
  const fact = snapshot.readJson(`requirements/${id}.json`);
  assert.equal(fact.mergeStatus, null);
  assert.equal(fact.mergedCommit, null);
  assert.equal(fact.mergedAt, null);
  assert.deepEqual(fact.mergeHistory, [{
    from: { mergeStatus: 'merged', mergedCommit: staleCommit, mergedAt: CLOCK },
    to: null,
    reason: 'reworked commit is not contained in the historical merge',
    actor: 'review-agent',
    sessionId: 'session-review-1',
    at: CLOCK,
  }]);

  await assert.rejects(
    clearRequirementMerge({ store, id, reason: 'already cleared merge fact' }),
    { code: 'MERGE_FACT_ABSENT', exitCode: 14 },
  );

  await setLifecycle(store, id, 'done');
  await assert.rejects(
    clearRequirementMerge({ store, id, reason: 'terminal state cannot change' }),
    { code: 'MERGE_STATE_NOT_ALLOWED', exitCode: 14 },
  );
});

test('I-243: CLI fact-correction commands validate options and forward the session actor', async (t) => {
  const { fixture, store, id } = await setup(t);
  const env = cliEnv(fixture);

  const missingMigration = createMemoryIo();
  assert.equal(await main([
    'requirement', 'set-migration', id, '--reason', MIGRATION_REASON, '--json',
  ], { ...missingMigration.io, env }), 14);
  assert.equal(JSON.parse(missingMigration.stderr.join('')).code, 'CLI_USAGE');

  const invalidMigration = createMemoryIo();
  assert.equal(await main([
    'requirement', 'set-migration', id,
    '--migration', 'maybe', '--reason', MIGRATION_REASON, '--json',
  ], { ...invalidMigration.io, env }), 12);
  assert.equal(
    JSON.parse(invalidMigration.stderr.join('')).code,
    'INVALID_MIGRATION_ASSESSMENT',
  );

  const migrationIo = createMemoryIo();
  assert.equal(await main([
    'requirement', 'set-migration', id,
    '--migration', 'yes', '--reason', MIGRATION_REASON, '--json',
  ], { ...migrationIo.io, env }), 0, migrationIo.stderr.join(''));
  const migrationData = JSON.parse(migrationIo.stdout.join('')).data;
  assert.equal(migrationData.migrationAssessment, '是');
  assert.deepEqual(
    (await store.readSnapshot())
      .readJson(`operations/by-id/${migrationData.operationId}.json`).metadata,
    {
      requirementId: id,
      migrationAssessment: '是',
      reason: MIGRATION_REASON,
      actor: 'cli-agent',
      sessionId: 'session-cli-243',
    },
  );

  const missingTables = createMemoryIo();
  assert.equal(await main([
    'requirement', 'set-database-tables', id,
    '--reason', TABLES_REASON, '--json',
  ], { ...missingTables.io, env }), 14);
  assert.equal(JSON.parse(missingTables.stderr.join('')).code, 'CLI_USAGE');

  const invalidTables = createMemoryIo();
  assert.equal(await main([
    'requirement', 'set-database-tables', id,
    '--database-table', 'Bad-Table', '--reason', TABLES_REASON, '--json',
  ], { ...invalidTables.io, env }), 12);
  assert.equal(JSON.parse(invalidTables.stderr.join('')).code, 'INVALID_DATABASE_TABLES');

  const tablesIo = createMemoryIo();
  assert.equal(await main([
    'requirement', 'set-database-tables', id,
    '--database-table', 'inv_swatches',
    '--database-table', 'parts',
    '--reason', TABLES_REASON,
    '--json',
  ], { ...tablesIo.io, env }), 0, tablesIo.stderr.join(''));
  const tablesData = JSON.parse(tablesIo.stdout.join('')).data;
  assert.deepEqual(tablesData.databaseTables, ['inv_swatches', 'parts']);
  const snapshot = await store.readSnapshot();
  assert.deepEqual(
    snapshot.readJson(`requirements/${id}.json`).resources.databaseTables,
    ['inv_swatches', 'parts'],
  );
  assert.deepEqual(
    snapshot.readJson(`operations/by-id/${tablesData.operationId}.json`).metadata,
    {
      requirementId: id,
      databaseTables: ['inv_swatches', 'parts'],
      reason: TABLES_REASON,
      actor: 'cli-agent',
      sessionId: 'session-cli-243',
    },
  );
});
