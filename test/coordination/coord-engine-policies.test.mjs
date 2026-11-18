import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { validateRepositoryGate } from '../../lib/coordination/gate.mjs';
import { CoordinationSnapshot } from '../../lib/coordination/git-store.mjs';
import { classifyChangedPaths, COORD_ENGINE_PATH } from '../../lib/coordination/path-classifier.mjs';
import { prepareReview } from '../../lib/coordination/reviews.mjs';
import { classifyRevisionRange } from '../../lib/coordination/revision-policy.mjs';
import { createGitFixture, runGit } from './fixtures.mjs';
import { REQUIREMENT_ID, setupFeatureGate } from './gate-fixtures.mjs';

const ISOLATED_TESTS = 'node scripts/assert-isolated-test-git.mjs && node --test scripts/test/coordination/*.test.mjs';
const DUAL_SUITE = 'node scripts/assert-isolated-test-git.mjs && bash scripts/lib/ensure-coord-engine.sh'
  + ' && node --test scripts/test/coordination/*.test.mjs .coord-engine/test/coordination/*.test.mjs';

function commitEnginePin(cwd, pin, path = COORD_ENGINE_PATH) {
  runGit(cwd, ['update-index', '--add', '--cacheinfo', `160000,${pin},${path}`]);
  runGit(cwd, ['-c', 'diff.ignoreSubmodules=none', 'commit', '-m', `test: pin ${path}`]);
  return runGit(cwd, ['rev-parse', 'HEAD']);
}

test('the engine pointer requires coordination checks without an application rebuild', () => {
  const result = classifyChangedPaths([COORD_ENGINE_PATH]);
  assert.deepEqual(result.blockingChecks, ['coordination-gate']);
  assert.deepEqual(result.affectedServices, []);
  assert.deepEqual(result.candidateRuntimePaths, []);
  assert.deepEqual(result.unknownPaths, []);
  assert.equal(result.docsOnly, false);
  assert.deepEqual(classifyChangedPaths(['.other-engine']).unknownPaths, ['.other-engine']);
});

test('only the pinned coordination gitlink is deployment-neutral and invalidates evidence', (t) => {
  const { clientA: cwd } = createGitFixture(t);
  runGit(cwd, ['config', 'diff.ignoreSubmodules', 'all']);
  const base = runGit(cwd, ['rev-parse', 'HEAD']);
  const installed = commitEnginePin(cwd, base);
  const updated = commitEnginePin(cwd, installed);
  const artifactInputs = { schemaVersion: 1, services: { api: { includes: ['apps/api/**'], excludes: [] } } };
  const classify = (fromSha, toSha) => classifyRevisionRange({ cwd, requirementId: REQUIREMENT_ID, fromSha, toSha, artifactInputs });
  for (const result of [classify(base, installed), classify(installed, updated)]) {
    assert.equal(result.valid, true);
    assert.equal(result.classification, 'deployment-neutral');
    assert.equal(result.deploymentNeutral, true);
    assert.equal(result.evidenceNeutral, false);
  }
  const unexpected = commitEnginePin(cwd, updated, '.other-engine');
  const result = classify(updated, unexpected);
  assert.equal(result.code, 'REVISION_POLICY_HARDFAIL');
  assert.equal(result.failures[0].path, '.other-engine');
  runGit(cwd, ['update-index', '--force-remove', COORD_ENGINE_PATH]);
  runGit(cwd, ['-c', 'diff.ignoreSubmodules=none', 'commit', '-m', 'test: remove the module pointer']);
  const removed = runGit(cwd, ['rev-parse', 'HEAD']);
  assert.equal(classify(unexpected, removed).classification, 'deployment-neutral');
  writeFileSync(join(cwd, COORD_ENGINE_PATH), 'not a Gitlink\n');
  runGit(cwd, ['add', COORD_ENGINE_PATH]);
  runGit(cwd, ['commit', '-m', 'test: add a regular file in place of the module pointer']);
  const invalid = classify(removed, runGit(cwd, ['rev-parse', 'HEAD']));
  assert.equal(invalid.code, 'REVISION_POLICY_HARDFAIL');
  assert.equal(invalid.failures[0].path, COORD_ENGINE_PATH);
});

test('a feature gate requires an explicit engine resource and tests at the current pin', async (t) => {
  const context = await setupFeatureGate(t, {
    baseScripts: { 'test:coordination': ISOLATED_TESTS },
    featureScripts: { 'test:coordination': DUAL_SUITE },
  });
  const cwd = context.fixture.clientA;
  const gate = () => validateRepositoryGate({ cwd, store: context.store, event: context.event, head: context.head, base: 'origin/main' });
  assert.equal((await gate()).valid, true);
  runGit(cwd, ['config', 'diff.ignoreSubmodules', 'all']);
  context.head = commitEnginePin(cwd, context.testedCommit);
  context.event.pull_request.head.sha = context.head;
  const hasPath = (error, code) => error.data?.failures.some((failure) => failure.code === code
    && failure.paths?.includes(COORD_ENGINE_PATH));
  await assert.rejects(gate, (error) => hasPath(error, 'RESOURCE_DECLARATION_INCOMPLETE')
    && hasPath(error, 'UNTESTED_CHANGES'));
  await context.store.update({ operation: 'declare engine pointer', mutate(snapshot) {
    const path = `requirements/${REQUIREMENT_ID}.json`;
    const requirement = snapshot.readJson(path);
    snapshot.writeJson(path, { ...requirement, resources: { ...requirement.resources,
      files: [...requirement.resources.files, COORD_ENGINE_PATH] } });
  } });
  await assert.rejects(gate, (error) => !hasPath(error, 'RESOURCE_DECLARATION_INCOMPLETE')
    && hasPath(error, 'UNTESTED_CHANGES'));
});

test('accepting a new engine from main still invalidates a feature test result', async (t) => {
  const context = await setupFeatureGate(t);
  const cwd = context.fixture.clientA;
  runGit(cwd, ['switch', 'main']);
  const newBase = commitEnginePin(cwd, context.base);
  runGit(cwd, ['update-ref', 'refs/remotes/origin/main', newBase]);
  runGit(cwd, ['switch', context.event.pull_request.head.ref]);
  runGit(cwd, ['merge', '--no-edit', 'main']);
  context.head = runGit(cwd, ['rev-parse', 'HEAD']);
  context.event.pull_request.head.sha = context.head;
  context.event.pull_request.base.sha = newBase;
  await assert.rejects(
    () => validateRepositoryGate({ cwd, store: context.store, event: context.event, head: context.head, base: 'origin/main' }),
    (error) => error.data?.failures.some((failure) => failure.code === 'UNTESTED_CHANGES'
      && failure.paths?.includes(COORD_ENGINE_PATH)),
  );
});

test('implementation and verification reviews bind the engine pin inherited from main', (t) => {
  const { clientA: cwd } = createGitFixture(t);
  const origin = 'refs/remotes/origin/main';
  const seed = runGit(cwd, ['rev-parse', 'HEAD']);
  const firstPin = commitEnginePin(cwd, seed);
  runGit(cwd, ['update-ref', origin, firstPin]);
  runGit(cwd, ['switch', '-c', 'feature/pinned-engine']);
  const root = join(cwd, 'docs/product/current', `${REQUIREMENT_ID}-engine-review`);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'FEEDBACK.json'), JSON.stringify({ schemaVersion: 1, requirementId: REQUIREMENT_ID, items: [] }));
  runGit(cwd, ['add', 'docs']);
  runGit(cwd, ['commit', '-m', 'test: record feedback']);
  const snapshot = new CoordinationSnapshot({ sha: 'coord-sha', files: new Map() });
  const requirement = { id: REQUIREMENT_ID, workflowVersion: 2, version: 'v0.2.32' };
  const reviews = () => ['implementation', 'verification'].map((stage) => prepareReview({ cwd, snapshot, requirement, stage }));
  const before = reviews();
  assert.equal(before.every((result) => result.paths.includes(COORD_ENGINE_PATH)), true);

  runGit(cwd, ['switch', 'main']);
  const nextPin = commitEnginePin(cwd, firstPin);
  runGit(cwd, ['update-ref', origin, nextPin]);
  runGit(cwd, ['switch', 'feature/pinned-engine']);
  runGit(cwd, ['rebase', 'main']);
  for (const [index, result] of reviews().entries()) {
    assert.deepEqual(result.paths, before[index].paths);
    assert.notEqual(result.subjectFingerprint, before[index].subjectFingerprint);
  }
});
