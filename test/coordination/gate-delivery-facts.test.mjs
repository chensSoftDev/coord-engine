import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { validateRepositoryGate } from '../../lib/coordination/gate.mjs';
import { runGit } from './fixtures.mjs';
import { REQUIREMENT_ID, replaceBacklogRow, setupFeatureGate, expectGateFailure, commitMutation } from './gate-fixtures.mjs';

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
