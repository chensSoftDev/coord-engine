import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { validateRepositoryGate } from '../../lib/coordination/gate.mjs';
import { runGit } from './fixtures.mjs';
import { REQUIREMENT_ID, expectGateFailure, commitMutation, replaceBacklogRow, setupFeatureGate, setupCompletionGate } from './gate-fixtures.mjs';

async function archivedRuntimeCompletion(t, { migrationId = REQUIREMENT_ID, releaseId = REQUIREMENT_ID } = {}) {
  const context = await setupFeatureGate(t, {
    deliveryProfile: 'runtime', manifestServices: 'api', migrationDecl: '是',
    preTestFiles: {
      'docs/releases/v0.2.32/MIGRATION.md': `# Executed migration ${migrationId}\n`,
      ...(releaseId ? { 'docs/releases/v0.2.32/RELEASE.md': `# Released ${releaseId}\n` } : {}),
    },
  });
  const cwd = context.fixture.clientA;
  replaceBacklogRow(cwd, line => line.replace('✅ Test Passed', '🚀 Prod Deployed'));
  runGit(cwd, ['add', 'BACKLOG.md']);
  runGit(cwd, ['commit', '-m', 'test: record historical production deployment']);
  const deployedHead = runGit(cwd, ['rev-parse', 'HEAD']);
  runGit(cwd, ['switch', 'main']);
  runGit(cwd, ['merge', '--ff-only', deployedHead]);
  runGit(cwd, ['push', 'origin', 'main']);
  const base = runGit(cwd, ['rev-parse', 'HEAD']);
  await context.store.update({ operation: 'record runtime production and merge facts', mutate(snapshot) {
    const path = `requirements/${REQUIREMENT_ID}.json`;
    snapshot.writeJson(path, { ...snapshot.readJson(path), lifecycle: 'prod_deployed', mergeStatus: 'merged', mergedCommit: base });
  } });
  runGit(cwd, ['switch', '-c', `automation/${REQUIREMENT_ID}-complete`]);
  replaceBacklogRow(cwd, line => line.replace('🚀 Prod Deployed', '✔️ Done'));
  writeFileSync(join(context.requirementDir, 'COMPLETION.json'), JSON.stringify({
    schemaVersion: 1, requirementId: REQUIREMENT_ID, deliveryProfile: 'runtime', mergedCommit: base,
  }));
  runGit(cwd, ['add', 'BACKLOG.md', context.requirementDir]);
  runGit(cwd, ['commit', '-m', 'test: complete deployed runtime requirement']);
  const head = runGit(cwd, ['rev-parse', 'HEAD']);
  return { ...context, base, head, event: { pull_request: {
    head: { ref: `automation/${REQUIREMENT_ID}-complete`, sha: head }, base: { ref: 'main', sha: base },
  } } };
}

test('deployed runtime completion accepts its committed release migration archive', async t => {
  const context = await archivedRuntimeCompletion(t);
  const result = await validateRepositoryGate({ cwd: context.fixture.clientA, store: context.store,
    event: context.event, head: context.head, base: 'origin/main' });
  assert.equal(result.valid, true);
  assert.equal(result.kind, 'completion');
});

test('archived migration completion still requires matching release and production facts', async t => {
  for (const options of [{ migrationId: 'I-0020' }, { releaseId: 'I-999' }, { releaseId: null }]) {
    await t.test(JSON.stringify(options), async t => {
      await expectGateFailure(await archivedRuntimeCompletion(t, options), 'MIGRATION_DRAFT_MISSING');
    });
  }
  for (const patch of [{ lifecycle: 'merged' }, { mergeStatus: null }, { deliveryProfile: 'tooling' }]) {
    await t.test(JSON.stringify(patch), async t => {
      const context = await archivedRuntimeCompletion(t);
      await context.store.update({ operation: 'remove production completion prerequisite', mutate(snapshot) {
        const path = `requirements/${REQUIREMENT_ID}.json`;
        snapshot.writeJson(path, { ...snapshot.readJson(path), ...patch });
      } });
      await expectGateFailure(context, 'MIGRATION_DRAFT_MISSING');
    });
  }
});

test('release archive cannot replace the pending draft in a feature PR', async t => {
  const context = await setupFeatureGate(t, { migrationDecl: '是', preTestFiles: {
    'docs/releases/v0.2.32/MIGRATION.md': `# ${REQUIREMENT_ID}\n`,
    'docs/releases/v0.2.32/RELEASE.md': `# ${REQUIREMENT_ID}\n`,
  } });
  await expectGateFailure(context, 'MIGRATION_DRAFT_MISSING');
});

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
