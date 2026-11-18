import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { validateRepositoryGate } from '../../lib/coordination/gate.mjs';
import { setupFeatureGate, expectGateFailure, commitMutation } from './gate-fixtures.mjs';

test('feature gate rejects runtime paths under a tooling profile', async (t) => {
  const context = await setupFeatureGate(t, { runtimePath: 'apps/api/src/unsafe.ts' });
  await expectGateFailure(context, 'PROFILE_PATH_MISMATCH');
});

test('feature gate rejects root package metadata changes for a tooling profile', async (t) => {
  const context = await setupFeatureGate(t);
  writeFileSync(
    join(context.fixture.clientA, 'package.json'),
    '{"private":true,"name":"smuggled-runtime-metadata","scripts":{"coord":"node scripts/coordination.mjs"}}\n',
  );
  commitMutation(context, 'package.json', 'test: smuggle package metadata');
  await expectGateFailure(context, 'PROFILE_PATH_MISMATCH');
});

test('tooling gate accepts coordination script guard updates without requiring new scripts', async (t) => {
  const context = await setupFeatureGate(t, {
    baseScripts: { 'test:coordination': 'node --test scripts/test/coordination/*.test.mjs', build: 'pnpm -r build' },
    featureScripts: { 'test:coordination': 'node scripts/assert-isolated-test-git.mjs && node --test scripts/test/coordination/*.test.mjs', build: 'pnpm -r build' },
  });
  const result = await validateRepositoryGate({ cwd: context.fixture.clientA, store: context.store,
    event: context.event, head: context.head, base: 'origin/main' });
  assert.equal(result.valid, true);
});

test('tooling gate accepts the real guard and verification entrypoint additions', async (t) => {
  const context = await setupFeatureGate(t, {
    baseScripts: { 'test:coordination': 'node --test scripts/test/coordination/*.test.mjs' },
    featureScripts: {
      'test:coordination': 'node scripts/assert-isolated-test-git.mjs && node --test scripts/test/coordination/*.test.mjs',
      'verify:check': 'node scripts/run-verified-check.mjs',
    },
  });
  const result = await validateRepositoryGate({ cwd: context.fixture.clientA, store: context.store,
    event: context.event, head: context.head, base: 'origin/main' });
  assert.equal(result.valid, true);
});

test('tooling gate rejects changed test commands and isolation guard bypasses', async (t) => {
  for (const command of [
    'node scripts/assert-isolated-test-git.mjs && node --test scripts/test/coordination/subset.test.mjs',
    'node scripts/assert-isolated-test-git.mjs || node --test scripts/test/coordination/*.test.mjs',
  ]) {
    const context = await setupFeatureGate(t, {
      baseScripts: { 'test:coordination': 'node --test scripts/test/coordination/*.test.mjs' },
      featureScripts: { 'test:coordination': command, 'verify:check': 'node scripts/run-verified-check.mjs' },
    });
    await expectGateFailure(context, 'PROFILE_PATH_MISMATCH');
  }
});
