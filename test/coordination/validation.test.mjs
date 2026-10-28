import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertDeliveryProfile,
  assertGitRevision,
  assertRequirementId,
  assertStateDocument,
  assertVersion,
  normalizeDuration,
} from '../../lib/coordination/validation.mjs';

test('accepts safe git revisions and rejects revision or option injection', () => {
  for (const revision of ['HEAD', 'origin/main', 'refs/heads/main', 'a'.repeat(40)]) {
    assert.equal(assertGitRevision(revision), revision);
  }
  for (const revision of ['--help', 'main..feature', 'HEAD^', 'main@{1}', '../main']) {
    assert.throws(() => assertGitRevision(revision), /invalid git revision/);
  }
});

test('validates requirement ids without imposing a three-digit ceiling', () => {
  assert.equal(assertRequirementId('I-057'), 'I-057');
  assert.equal(assertRequirementId('F-1000'), 'F-1000');
  assert.equal(assertRequirementId('B-999'), 'B-999');
  assert.throws(() => assertRequirementId('I-57'), /invalid requirement id/);
  assert.throws(() => assertRequirementId('X-057'), /invalid requirement id/);
});

test('validates strict release versions and delivery profiles', () => {
  assert.equal(assertVersion('v0.2.32'), 'v0.2.32');
  assert.throws(() => assertVersion('0.2.32'), /invalid version/);
  assert.throws(() => assertVersion('v0.2'), /invalid version/);

  for (const profile of ['runtime', 'tooling', 'governance']) {
    assert.equal(assertDeliveryProfile(profile), profile);
  }
  assert.throws(() => assertDeliveryProfile('docs'), /invalid delivery profile/);
});

test('normalizes durations from five minutes through eight hours', () => {
  assert.equal(normalizeDuration('5m'), 5 * 60 * 1000);
  assert.equal(normalizeDuration('90m'), 90 * 60 * 1000);
  assert.equal(normalizeDuration('8h'), 8 * 60 * 60 * 1000);
  assert.throws(() => normalizeDuration('4m'), /between 5m and 8h/);
  assert.throws(() => normalizeDuration('9h'), /between 5m and 8h/);
  assert.throws(() => normalizeDuration('300'), /invalid duration/);
});

test('accepts schema version one and two state documents', () => {
  const v1 = { schemaVersion: 1, initializedAt: '2026-07-17T00:00:00.000Z' };
  const v2 = { schemaVersion: 2, initializedAt: '2026-07-17T00:00:00.000Z' };
  assert.equal(assertStateDocument(v1), v1);
  assert.equal(assertStateDocument(v2), v2);
  assert.throws(() => assertStateDocument(null), /state document must be an object/);
  assert.throws(() => assertStateDocument({}), /unsupported schema version/);
  assert.throws(
    () => assertStateDocument({ schemaVersion: 3 }),
    /unsupported schema version/,
  );
});
