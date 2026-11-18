import assert from 'node:assert/strict';
import test from 'node:test';

import { uxPathsOwnedByRequirement, validateRepositoryGate } from '../../lib/coordination/gate.mjs';
import { REQUIREMENT_ID, setupFeatureGate, expectGateFailure } from './gate-fixtures.mjs';

test('Ready rejects a new admin-ui requirement without a current UX approval', async (t) => {
  const context = await setupFeatureGate(t, { uxImpact: 'admin-ui' });
  await expectGateFailure(context, 'UX_APPROVAL_NOT_CURRENT');
});

test('Ready rejects none when the change includes an employee-visible admin page', async (t) => {
  const context = await setupFeatureGate(t, {
    uxImpact: 'none', runtimePath: 'apps/admin/app/production/page.tsx',
  });
  await expectGateFailure(context, 'UX_IMPACT_MISMATCH');
});

test('B-248: Ready rejects a no-migration declaration when migration-like paths change', async (t) => {
  const context = await setupFeatureGate(t, {
    uxImpact: 'none',
    runtimePath: 'apps/api/src/database/migrations/1746000000000-b248-fixture.ts',
  });
  await expectGateFailure(context, 'MIGRATION_IMPACT_MISMATCH');
});

test('B-248: Ready rejects none when admin behavior-shaping (review-bucket) paths change', async (t) => {
  const context = await setupFeatureGate(t, {
    uxImpact: 'none', runtimePath: 'apps/admin/hooks/use-table.ts',
  });
  await expectGateFailure(context, 'UX_IMPACT_REVIEW_UNRESOLVED');
});

test('B-248: a recorded ux review override carries the review-bucket paths', async (t) => {
  // A runtime profile is required: tooling profiles reject apps/** paths
  // outright (PROFILE_PATH_MISMATCH) before the ux review check runs.
  const context = await setupFeatureGate(t, {
    uxImpact: 'none',
    deliveryProfile: 'runtime',
    manifestServices: 'admin',
    runtimePath: 'apps/admin/hooks/use-table.ts',
  });
  await context.store.update({
    operation: 'record ux review override',
    mutate(snapshot) {
      const path = `requirements/${REQUIREMENT_ID}.json`;
      snapshot.writeJson(path, {
        ...snapshot.readJson(path),
        uxReviewOverrides: [{
          paths: ['apps/admin/hooks/use-table.ts'],
          reason: 'pure typing refactor, no employee-visible behavior',
          actor: 'b248-agent',
          at: context.clock().toISOString(),
        }],
      });
    },
  });
  // The override resolves the review failure; the remaining gate verdict must
  // not contain UX_IMPACT_REVIEW_UNRESOLVED anymore (this fixture has no other
  // failing conditions).
  await assert.doesNotReject(validateRepositoryGate({
    cwd: context.fixture.clientA,
    store: context.store,
    event: context.event,
    head: context.head,
    base: 'origin/main',
  }));
});

test('batch changes attribute employee UI paths to the declaring requirement', () => {
  const paths = ['BACKLOG.md', 'apps/admin/components/TaskForm.tsx', 'scripts/none-change.mjs'];
  const noneRequirement = { resources: { files: ['BACKLOG.md', 'scripts/none-change.mjs'] } };
  assert.deepEqual(uxPathsOwnedByRequirement({ changedPaths: paths, requirement: noneRequirement }),
    ['BACKLOG.md', 'scripts/none-change.mjs']);
});
