import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { setupFeatureGate, expectGateFailure, commitMutation } from './gate-fixtures.mjs';

test('tooling gate rejects malformed scripts and dependency changes', async (t) => {
  for (const scripts of [null, [], { 'verify:check': 42 }, { 'verify:check': ' ' }]) {
    const context = await setupFeatureGate(t, { featureScripts: scripts });
    await expectGateFailure(context, 'PROFILE_PATH_MISMATCH');
  }
  const context = await setupFeatureGate(t);
  const path = join(context.fixture.clientA, 'package.json');
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  pkg.dependencies = { unreviewed: '1.0.0' };
  writeFileSync(path, `${JSON.stringify(pkg)}\n`);
  commitMutation(context, 'package.json', 'test: alter runtime dependency');
  await expectGateFailure(context, 'PROFILE_PATH_MISMATCH');
});

test('tooling gate rejects changes to existing runtime and install scripts', async (t) => {
  for (const name of ['build', 'start', 'postinstall', 'unknown']) {
    const context = await setupFeatureGate(t, {
      baseScripts: { [name]: 'node original.mjs' },
      featureScripts: { [name]: 'node changed.mjs', 'verify:check': 'node scripts/run-verified-check.mjs' },
    });
    await expectGateFailure(context, 'PROFILE_PATH_MISMATCH');
  }
});

test('tooling gate rejects removed or empty existing coordination scripts', async (t) => {
  for (const featureScripts of [{}, { 'test:coordination': '' }]) {
    const context = await setupFeatureGate(t, {
      baseScripts: { 'test:coordination': 'node --test scripts/test/coordination/*.test.mjs' },
      featureScripts: { ...featureScripts, 'verify:check': 'node scripts/run-verified-check.mjs' },
    });
    await expectGateFailure(context, 'PROFILE_PATH_MISMATCH');
  }
});

// I-113：runtime 需求只改 release tooling 脚本时，统一分类器 affectedServices 为空，
// RELEASE_SERVICES=none 应通过；当前 gate 内重复的 requiredServices 会错误要求全部五服务。
