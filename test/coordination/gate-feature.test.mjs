import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { preflightRepositoryGate, validateRepositoryGate } from '../../lib/coordination/gate.mjs';
import { main } from '../../lib/coordination/cli.mjs';
import { createMemoryIo, runGit } from './fixtures.mjs';
import { REQUIREMENT_ID, setupFeatureGate, expectGateFailure, commitMutation, gateDecision } from './gate-fixtures.mjs';

test('gate preflight returns the same decision as a pull request event', async (t) => {
  const context = await setupFeatureGate(t);
  const pullRequest = await validateRepositoryGate({
    cwd: context.fixture.clientA,
    store: context.store,
    event: context.event,
    head: context.head,
    base: context.base,
  });
  const preflight = await preflightRepositoryGate({
    cwd: context.fixture.clientA,
    store: context.store,
    head: context.head,
    base: context.base,
  });

  assert.deepEqual(gateDecision(preflight), gateDecision(pullRequest));

  const memory = createMemoryIo();
  const exitCode = await main([
    'gate', 'preflight',
    '--head', context.head,
    '--base', context.base,
    '--json',
  ], {
    env: {
      ...process.env,
      COORD_CWD: context.fixture.clientA,
      COORD_REMOTE: 'origin',
      COORD_BRANCH: 'coordination',
      COORD_TEMP_ROOT: context.fixture.tempRoot,
    },
    ...memory.io,
  });
  assert.equal(exitCode, 0, memory.stderr.join(''));
  assert.deepEqual(
    gateDecision(JSON.parse(memory.stdout.join('')).data),
    gateDecision(pullRequest),
  );
});

test('valid feature PR accepts an evidence-only closure commit', async (t) => {
  const context = await setupFeatureGate(t);
  let result;
  try {
    result = await validateRepositoryGate({
      cwd: context.fixture.clientA,
      store: context.store,
      event: context.event,
      head: context.head,
      base: 'origin/main',
    });
  } catch (error) {
    assert.fail(JSON.stringify(error.data, null, 2));
  }
  assert.equal(result.valid, true);
  assert.equal(result.kind, 'feature');
  assert.deepEqual(result.requirements, [REQUIREMENT_ID]);
  assert.equal(result.evidenceClosures[0].testedCommit, context.testedCommit);

  const eventPath = join(context.fixture.root, 'pull-request-event.json');
  writeFileSync(eventPath, JSON.stringify(context.event));
  const memory = createMemoryIo();
  const exitCode = await main([
    'gate', 'validate',
    '--event', eventPath,
    '--head', context.head,
    '--base', 'origin/main',
    '--json',
  ], {
    env: {
      ...process.env,
      COORD_CWD: context.fixture.clientA,
      COORD_REMOTE: 'origin',
      COORD_BRANCH: 'coordination',
      COORD_TEMP_ROOT: context.fixture.tempRoot,
    },
    ...memory.io,
  });
  assert.equal(exitCode, 0, memory.stderr.join(''));
  assert.equal(JSON.parse(memory.stdout.join('')).data.valid, true);
});

test('feature gate does not import sibling requirements from a shared manifest', async (t) => {
  const context = await setupFeatureGate(t, {
    manifestRequirements: [REQUIREMENT_ID, 'I-003'],
    additionalRequirements: ['I-003'],
  });

  const result = await validateRepositoryGate({
    cwd: context.fixture.clientA,
    store: context.store,
    event: context.event,
    head: context.head,
    base: 'origin/main',
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.requirements, [REQUIREMENT_ID]);
});

test('feature gate still requires the current requirement in its manifest', async (t) => {
  const context = await setupFeatureGate(t);
  writeFileSync(
    join(context.fixture.clientA, 'deploy', 'release-manifests', 'v0.2.32.env'),
    [
      'RELEASE_VERSION=v0.2.32',
      'RELEASE_REQUIREMENTS=I-003',
      'RELEASE_DELIVERY_PROFILE=tooling',
      'RELEASE_SERVICES=none',
      '',
    ].join('\n'),
  );
  commitMutation(
    context,
    'deploy/release-manifests/v0.2.32.env',
    'test: remove current requirement from manifest',
  );
  await expectGateFailure(context, 'MANIFEST_REQUIREMENT_MISMATCH');
});

test('feature gate accepts requirement closure documents changed after testing', async (t) => {
  const context = await setupFeatureGate(t);
  const requirementRelative = `docs/product/current/${REQUIREMENT_ID}-gate-fixture`;
  writeFileSync(join(context.requirementDir, 'CHECKLIST.md'), [
    '# Gate checklist',
    '',
    '- [x] P4 testing closed',
    '',
  ].join('\n'));
  writeFileSync(
    join(context.requirementDir, 'ACCEPTANCE.md'),
    `${readFileSync(join(context.requirementDir, 'ACCEPTANCE.md'), 'utf8')}\n## 证据记录\n\n已闭包。\n`,
  );
  const siblingDir = join(context.fixture.clientA, 'docs', 'product', 'current', 'batch-notes');
  mkdirSync(siblingDir, { recursive: true });
  writeFileSync(join(siblingDir, 'CHECKLIST.md'), '# batch closure checklist\n');
  writeFileSync(join(siblingDir, 'TEST_EVIDENCE.json'), '{"outcome":"passed"}\n');
  runGit(context.fixture.clientA, ['add', 'docs']);
  runGit(context.fixture.clientA, ['commit', '-m', 'test: close requirement documents']);
  context.head = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  context.event.pull_request.head.sha = context.head;

  const result = await validateRepositoryGate({
    cwd: context.fixture.clientA,
    store: context.store,
    event: context.event,
    head: context.head,
    base: 'origin/main',
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.evidenceClosures[0].closurePaths.sort(), [
    'BACKLOG.md',
    'docs/product/current/batch-notes/CHECKLIST.md',
    'docs/product/current/batch-notes/TEST_EVIDENCE.json',
    `${requirementRelative}/ACCEPTANCE.md`,
    `${requirementRelative}/CHECKLIST.md`,
    `${requirementRelative}/TEST_EVIDENCE.json`,
  ].sort());
});

test('feature gate still rejects requirement design changes after testing', async (t) => {
  const context = await setupFeatureGate(t);
  writeFileSync(
    join(context.requirementDir, 'TECH_DESIGN.md'),
    '# Gate design\n\nChanged after testing.\n',
  );
  commitMutation(
    context,
    `docs/product/current/${REQUIREMENT_ID}-gate-fixture/TECH_DESIGN.md`,
    'test: change design after testing',
  );
  await expectGateFailure(context, 'UNTESTED_CHANGES');
});

test('feature gate accepts an additive epoch review report but rejects a later edit', async t => {
  const context = await setupFeatureGate(t);
  const relative = `docs/product/current/${REQUIREMENT_ID}-gate-fixture/reviews/verification-epoch-1-round-1.json`;
  mkdirSync(join(context.requirementDir, 'reviews'), { recursive: true });
  writeFileSync(join(context.fixture.clientA, relative), `${JSON.stringify({ schemaVersion: 1,
    requirementId: REQUIREMENT_ID, stage: 'verification', subjectFingerprint: 'a'.repeat(64),
    feedbackIds: [], verdict: 'pass', findings: [] })}\n`);
  commitMutation(context, relative, 'test: add epoch verification result');
  assert.equal((await validateRepositoryGate({ cwd: context.fixture.clientA, store: context.store,
    event: context.event, head: context.head, base: 'origin/main' })).valid, true);
  writeFileSync(join(context.fixture.clientA, relative), '{"changed":true}\n');
  commitMutation(context, relative, 'test: edit epoch verification result');
  await expectGateFailure(context, 'UNTESTED_CHANGES');
});

test('feature gate accepts additive interaction and visual results but rejects screenshot replacement', async t => {
  const context = await setupFeatureGate(t);
  const root = `docs/product/current/${REQUIREMENT_ID}-gate-fixture`;
  const imageRoot = join(context.requirementDir, 'reviews/screenshots');
  mkdirSync(imageRoot, { recursive: true });
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');
  for (const name of ['baseline.png', 'actual.png']) writeFileSync(join(imageRoot, name), image);
  const reportPath = `${root}/UI_ACCEPTANCE.json`;
  writeFileSync(join(context.fixture.clientA, reportPath), `${JSON.stringify({ schemaVersion: 1,
    requirementId: REQUIREMENT_ID, candidateId: 'fixture-candidate' })}\n`);
  runGit(context.fixture.clientA, ['add', reportPath, `${root}/reviews/screenshots`]);
  runGit(context.fixture.clientA, ['commit', '-m', 'test: add UI acceptance artifacts']);
  context.head = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  context.event.pull_request.head.sha = context.head;
  assert.equal((await validateRepositoryGate({ cwd: context.fixture.clientA, store: context.store,
    event: context.event, head: context.head, base: 'origin/main' })).valid, true);
  writeFileSync(join(imageRoot, 'actual.png'), Buffer.concat([image, Buffer.from('changed')]));
  commitMutation(context, `${root}/reviews/screenshots/actual.png`, 'test: replace accepted screenshot');
  await expectGateFailure(context, 'UNTESTED_CHANGES');
});
