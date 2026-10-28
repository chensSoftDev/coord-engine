import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  REVISION_POLICY_VERSION,
  RevisionPolicyError,
  classifyRevisionRange,
  loadRuntimeArtifactInputs,
} from '../../lib/coordination/revision-policy.mjs';
import { createGitFixture, runGit } from './fixtures.mjs';

const REQUIREMENT_ID = 'I-002';
const REQUIREMENT_DIR = join('docs', 'product', 'current', 'I-002-policy-fixture');
const ARTIFACT_INPUTS_PATH = join('.agents', 'runtime-artifact-inputs.json');

const BACKLOG = [
  '# BACKLOG',
  '',
  '| ID | 标题 | 迁移 | 状态 | Version | 备注 |',
  '| --- | --- | --- | --- | --- | --- |',
  '| I-001 | Other requirement | 否 | 🔨 In Dev | v0.2.32 | keep unchanged |',
  '| I-002 | Policy fixture | 否 | 🔨 In Dev | v0.2.32 | - |',
  '',
].join('\n');

const CHECKLIST = [
  '# I-002 Checklist',
  '',
  '## P2 编码质量',
  '',
  '- [ ] 2.1 单测通过。',
  '- [x] 2.2 lint 通过。',
  '',
  '## P4 测试验证',
  '',
  '- [ ] 4.1 e2e 通过。',
  '',
].join('\n');

const ACCEPTANCE = [
  '# I-002 验收计划',
  '',
  '## 必跑命令',
  '',
  '```coord-required',
  '["node", "scripts/policy-verify.mjs"]',
  '["pnpm", "test:coordination"]',
  '```',
  '',
  '## 本地验收结果',
  '',
  '（testing 阶段填写）',
  '',
].join('\n');

const ARTIFACT_INPUTS = {
  schemaVersion: 1,
  services: {
    admin: {
      includes: ['apps/admin/**'],
      excludes: ['apps/admin/e2e/**', 'apps/admin/playwright.config.ts'],
    },
    api: { includes: ['apps/api/**'], excludes: [] },
  },
};

function writeArtifactInputs(cwd, value) {
  mkdirSync(join(cwd, '.agents'), { recursive: true });
  writeFileSync(
    join(cwd, ARTIFACT_INPUTS_PATH),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

function setupPolicyFixture(t) {
  const fixture = createGitFixture(t);
  const cwd = fixture.clientA;
  runGit(cwd, ['config', 'core.fileMode', 'true']);
  writeFileSync(join(cwd, 'BACKLOG.md'), BACKLOG);
  writeFileSync(join(cwd, 'package.json'), '{"private":true,"scripts":{}}\n');
  writeArtifactInputs(cwd, ARTIFACT_INPUTS);
  for (const service of ['admin', 'api']) {
    const dir = join(cwd, 'apps', service);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'Dockerfile'), [
      'FROM node:22-alpine',
      'COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./',
      `COPY apps/${service} ./apps/${service}`,
      '',
    ].join('\n'));
  }
  mkdirSync(join(cwd, 'scripts'), { recursive: true });
  writeFileSync(join(cwd, 'scripts', 'policy-verify.mjs'), 'process.exitCode = 0;\n');
  const requirementDir = join(cwd, REQUIREMENT_DIR);
  mkdirSync(requirementDir, { recursive: true });
  writeFileSync(join(requirementDir, 'ACCEPTANCE.md'), ACCEPTANCE);
  writeFileSync(join(requirementDir, 'CHECKLIST.md'), CHECKLIST);
  writeFileSync(join(requirementDir, 'TECH_DESIGN.md'), '# design\n');
  runGit(cwd, ['add', '-A']);
  runGit(cwd, ['commit', '-m', 'test: policy fixture base']);
  return { cwd, baseSha: runGit(cwd, ['rev-parse', 'HEAD']) };
}

function commitChange(cwd, message = 'test: change') {
  runGit(cwd, ['add', '-A']);
  runGit(cwd, ['commit', '-m', message]);
  return runGit(cwd, ['rev-parse', 'HEAD']);
}

function classify(env, toSha, options = {}) {
  return classifyRevisionRange({
    cwd: env.cwd,
    requirementId: REQUIREMENT_ID,
    fromSha: env.baseSha,
    toSha,
    ...options,
  });
}

function rewrite(cwd, relativePath, transform) {
  const path = join(cwd, relativePath);
  writeFileSync(path, transform(readFileSync(path, 'utf8')));
}

test('policy version is a stable integer', () => {
  assert.ok(Number.isInteger(REVISION_POLICY_VERSION));
  assert.ok(REVISION_POLICY_VERSION >= 1);
});

test('evidence-neutral: only the current requirement BACKLOG status cell changes', (t) => {
  const env = setupPolicyFixture(t);
  rewrite(env.cwd, 'BACKLOG.md', (source) => source.replace(
    '| I-002 | Policy fixture | 否 | 🔨 In Dev | v0.2.32 | - |',
    '| I-002 | Policy fixture | 否 | 🧪 Testing | v0.2.32 | 投影备注 |',
  ));
  const head = commitChange(env.cwd, 'test: project I-002 to Testing');
  const result = classify(env, head);
  assert.equal(result.valid, true);
  assert.equal(result.classification, 'evidence-neutral');
  assert.equal(result.evidenceNeutral, true);
  assert.equal(result.deploymentNeutral, true);
  assert.equal(result.policyVersion, REVISION_POLICY_VERSION);
  assert.deepEqual(result.paths.map(({ path }) => path), ['BACKLOG.md']);
});

test('evidence-neutral: ticking an existing checklist item and appending a result field', (t) => {
  const env = setupPolicyFixture(t);
  rewrite(env.cwd, join(REQUIREMENT_DIR, 'CHECKLIST.md'), (source) => source.replace(
    '- [ ] 2.1 单测通过。',
    '- [x] 2.1 单测通过。',
  ).replace(
    '- [ ] 4.1 e2e 通过。\n',
    '- [ ] 4.1 e2e 通过。\n- 结果：单测 12/12 通过。\n',
  ));
  const head = commitChange(env.cwd, 'test: tick checklist');
  const result = classify(env, head);
  assert.equal(result.valid, true);
  assert.equal(result.classification, 'evidence-neutral');
  assert.equal(result.evidenceNeutral, true);
});

test('evidence-neutral: acceptance results section append keeps command fingerprint', (t) => {
  const env = setupPolicyFixture(t);
  rewrite(env.cwd, join(REQUIREMENT_DIR, 'ACCEPTANCE.md'), (source) => source.replace(
    '（testing 阶段填写）\n',
    '（testing 阶段填写）\n- 结果：3/3 通过。\n',
  ));
  const head = commitChange(env.cwd, 'test: record acceptance results');
  const result = classify(env, head);
  assert.equal(result.valid, true);
  assert.equal(result.classification, 'evidence-neutral');
  assert.equal(result.evidenceNeutral, true);
});

test('evidence-neutral: TEST_EVIDENCE.json may be added or updated', (t) => {
  const env = setupPolicyFixture(t);
  writeFileSync(
    join(env.cwd, REQUIREMENT_DIR, 'TEST_EVIDENCE.json'),
    '{"schemaVersion":1,"outcome":"passed"}\n',
  );
  const head = commitChange(env.cwd, 'test: add test evidence');
  const result = classify(env, head);
  assert.equal(result.valid, true);
  assert.equal(result.classification, 'evidence-neutral');
});

test('evidence-neutral: a matching immutable stage review report may be added after testing', (t) => {
  const env = setupPolicyFixture(t);
  const directory = join(env.cwd, REQUIREMENT_DIR, 'reviews');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'verification-epoch-1-round-1.json');
  writeFileSync(file, `${JSON.stringify({ schemaVersion: 1, requirementId: REQUIREMENT_ID, stage: 'verification', subjectFingerprint: 'a'.repeat(64), verdict: 'pass', feedbackIds: [], findings: [] })}\n`);
  const head = commitChange(env.cwd, 'test: record verification review');
  const result = classify(env, head);
  assert.equal(result.valid, true);
  assert.equal(result.classification, 'evidence-neutral');
  writeFileSync(file, '{"schemaVersion":1,"stage":"verification"}\n');
  const modified = commitChange(env.cwd, 'test: alter recorded review');
  assert.equal(classifyRevisionRange({ cwd: env.cwd, requirementId: REQUIREMENT_ID, fromSha: head, toSha: modified }).valid, false);
  assert.equal(classify(env, modified).valid, false, 'add-then-edit cannot look like one additive review from the tested commit');
});

test('evidence-neutral: committed interaction report and visual screenshots close testing without changing test inputs', t => {
  const env = setupPolicyFixture(t);
  const imageRoot = join(env.cwd, REQUIREMENT_DIR, 'reviews', 'screenshots');
  mkdirSync(imageRoot, { recursive: true });
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');
  writeFileSync(join(imageRoot, 'prototype.png'), image);
  writeFileSync(join(imageRoot, 'actual.png'), image);
  writeFileSync(join(env.cwd, REQUIREMENT_DIR, 'UI_ACCEPTANCE.json'), '{"schemaVersion":1,"requirementId":"I-002"}\n');
  const head = commitChange(env.cwd, 'test: add interaction and visual comparison evidence');
  const result = classify(env, head);
  assert.equal(result.valid, true);
  assert.equal(result.classification, 'evidence-neutral');
  writeFileSync(join(env.cwd, REQUIREMENT_DIR, 'UI_ACCEPTANCE.json'), '{"schemaVersion":1,"requirementId":"I-002","changed":true}\n');
  const changed = commitChange(env.cwd, 'test: change accepted result');
  assert.equal(classifyRevisionRange({ cwd: env.cwd, requirementId: REQUIREMENT_ID, fromSha: head, toSha: changed }).valid, false);
  assert.equal(classify(env, changed).valid, false, 'add-then-edit cannot look like one additive acceptance from the tested commit');
});

// I-113 (unified branch): when several requirements share one feature branch,
// another requirement's machine-generated TEST_EVIDENCE.json closure commit
// must stay evidence-neutral for this requirement (content binding is
// enforced by the other requirement's own validateTestEvidence).
test('evidence-neutral: another requirement TEST_EVIDENCE.json on a shared branch', (t) => {
  const env = setupPolicyFixture(t);
  const otherDir = join(env.cwd, 'docs', 'product', 'current', 'I-003-other-fixture');
  mkdirSync(otherDir, { recursive: true });
  writeFileSync(join(otherDir, 'TEST_EVIDENCE.json'), '{"schemaVersion":1,"outcome":"passed"}\n');
  const head = commitChange(env.cwd, 'test: co-branch requirement evidence closure');
  const result = classify(env, head);
  assert.equal(result.valid, true);
  assert.equal(result.classification, 'evidence-neutral');
});

test('hard fail: malformed co-branch TEST_EVIDENCE.json is never evidence-neutral', (t) => {
  const env = setupPolicyFixture(t);
  const otherDir = join(env.cwd, 'docs', 'product', 'current', 'I-003-other-fixture');
  mkdirSync(otherDir, { recursive: true });
  writeFileSync(join(otherDir, 'TEST_EVIDENCE.json'), '{not valid json\n');
  const head = commitChange(env.cwd, 'test: malformed co-branch evidence');
  const result = classify(env, head);
  assert.equal(result.valid, false);
});

test('hard fail: coord-required argv change is not evidence-neutral', (t) => {
  const env = setupPolicyFixture(t);
  rewrite(env.cwd, join(REQUIREMENT_DIR, 'ACCEPTANCE.md'), (source) => source.replace(
    '["node", "scripts/policy-verify.mjs"]',
    '["node", "scripts/policy-verify.mjs", "--write"]',
  ));
  const head = commitChange(env.cwd, 'test: tamper with required commands');
  const result = classify(env, head);
  assert.equal(result.valid, false);
  assert.equal(result.code, 'REVISION_POLICY_HARDFAIL');
  assert.equal(result.evidenceNeutral, false);
});

test('hard fail: editing acceptance content outside the results section', (t) => {
  const env = setupPolicyFixture(t);
  rewrite(env.cwd, join(REQUIREMENT_DIR, 'ACCEPTANCE.md'), (source) => source.replace(
    '## 必跑命令',
    '## 必跑命令（已改写）',
  ));
  const head = commitChange(env.cwd, 'test: rewrite acceptance prose');
  const result = classify(env, head);
  assert.equal(result.valid, false);
  assert.equal(result.code, 'REVISION_POLICY_HARDFAIL');
});

test('hard fail: checklist items cannot be added, removed, rewritten or unticked', (t) => {
  const mutations = {
    'rewritten item': (source) => source.replace('- [ ] 2.1 单测通过。', '- [ ] 2.1 单测与 lint 通过。'),
    'added item': (source) => source.replace('- [ ] 4.1 e2e 通过。', '- [ ] 4.1 e2e 通过。\n- [ ] 4.2 新增检查项。'),
    'removed item': (source) => source.replace('- [ ] 4.1 e2e 通过。\n', ''),
    'unticked item': (source) => source.replace('- [x] 2.2 lint 通过。', '- [ ] 2.2 lint 通过。'),
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const env = setupPolicyFixture(t);
    rewrite(env.cwd, join(REQUIREMENT_DIR, 'CHECKLIST.md'), mutate);
    const head = commitChange(env.cwd, `test: ${name}`);
    const result = classify(env, head);
    assert.equal(result.valid, false, name);
    assert.equal(result.code, 'REVISION_POLICY_HARDFAIL', name);
  }
});

test('hard fail: BACKLOG core cells and other requirement rows are frozen', (t) => {
  const mutations = {
    'migration cell': (source) => source.replace(
      '| I-002 | Policy fixture | 否 |',
      '| I-002 | Policy fixture | 是 |',
    ),
    'version cell': (source) => source.replace(
      '| I-002 | Policy fixture | 否 | 🔨 In Dev | v0.2.32 |',
      '| I-002 | Policy fixture | 否 | 🔨 In Dev | v0.9.0 |',
    ),
    'title cell': (source) => source.replace(
      '| I-002 | Policy fixture |',
      '| I-002 | Renamed fixture |',
    ),
    'non-row content': (source) => source.replace('# BACKLOG', '# BACKLOG!'),
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const env = setupPolicyFixture(t);
    rewrite(env.cwd, 'BACKLOG.md', mutate);
    const head = commitChange(env.cwd, `test: ${name}`);
    const result = classify(env, head);
    assert.equal(result.valid, false, name);
    assert.equal(result.code, 'REVISION_POLICY_HARDFAIL', name);
  }
});

test('hard fail: renames, symlinks, mode changes and unparseable evidence', (t) => {
  {
    const env = setupPolicyFixture(t);
    runGit(env.cwd, [
      'mv',
      REQUIREMENT_DIR,
      join('docs', 'product', 'current', 'I-002-renamed'),
    ]);
    const head = commitChange(env.cwd, 'test: rename requirement directory');
    const result = classify(env, head);
    assert.equal(result.valid, false, 'rename');
    assert.equal(result.code, 'REVISION_POLICY_HARDFAIL', 'rename');
  }
  {
    const env = setupPolicyFixture(t);
    symlinkSync('ACCEPTANCE.md', join(env.cwd, REQUIREMENT_DIR, 'ACCEPTANCE-link.md'));
    const head = commitChange(env.cwd, 'test: add symlink');
    const result = classify(env, head);
    assert.equal(result.valid, false, 'symlink');
    assert.equal(result.code, 'REVISION_POLICY_HARDFAIL', 'symlink');
  }
  {
    const env = setupPolicyFixture(t);
    chmodSync(join(env.cwd, REQUIREMENT_DIR, 'CHECKLIST.md'), 0o755);
    const head = commitChange(env.cwd, 'test: flip executable bit');
    const result = classify(env, head);
    assert.equal(result.valid, false, 'mode change');
    assert.equal(result.code, 'REVISION_POLICY_HARDFAIL', 'mode change');
  }
  {
    const env = setupPolicyFixture(t);
    writeFileSync(join(env.cwd, REQUIREMENT_DIR, 'TEST_EVIDENCE.json'), '{ not json\n');
    const head = commitChange(env.cwd, 'test: corrupt test evidence');
    const result = classify(env, head);
    assert.equal(result.valid, false, 'parse failure');
    assert.equal(result.code, 'REVISION_POLICY_HARDFAIL', 'parse failure');
  }
});

test('deployment-neutral: general docs markdown changes are not evidence-neutral', (t) => {
  const env = setupPolicyFixture(t);
  mkdirSync(join(env.cwd, 'docs', 'ops'), { recursive: true });
  writeFileSync(join(env.cwd, 'docs', 'ops', 'NOTE.md'), '# note\n');
  const head = commitChange(env.cwd, 'test: docs only change');
  const result = classify(env, head);
  assert.equal(result.valid, true);
  assert.equal(result.classification, 'deployment-neutral');
  assert.equal(result.evidenceNeutral, false);
  assert.equal(result.deploymentNeutral, true);
});

test('classification: artifact-input excludes decide test path neutrality', (t) => {
  const env = setupPolicyFixture(t);

  mkdirSync(join(env.cwd, 'apps', 'admin', 'e2e'), { recursive: true });
  writeFileSync(join(env.cwd, 'apps', 'admin', 'e2e', 'foo.spec.ts'), '// spec\n');
  let from = env.baseSha;
  let head = commitChange(env.cwd, 'test: add excluded e2e spec');
  let result = classifyRevisionRange({
    cwd: env.cwd, requirementId: REQUIREMENT_ID, fromSha: from, toSha: head,
  });
  assert.equal(result.valid, true, 'excluded e2e spec');
  assert.equal(result.classification, 'deployment-neutral', 'excluded e2e spec');

  writeFileSync(join(env.cwd, 'apps', 'admin', 'playwright.config.ts'), 'export {};\n');
  from = head;
  head = commitChange(env.cwd, 'test: add excluded playwright config');
  result = classifyRevisionRange({
    cwd: env.cwd, requirementId: REQUIREMENT_ID, fromSha: from, toSha: head,
  });
  assert.equal(result.classification, 'deployment-neutral', 'excluded playwright config');

  mkdirSync(join(env.cwd, 'apps', 'api', 'src'), { recursive: true });
  writeFileSync(join(env.cwd, 'apps', 'api', 'src', 'x.ts'), 'export {};\n');
  from = head;
  head = commitChange(env.cwd, 'test: add api source');
  result = classifyRevisionRange({
    cwd: env.cwd, requirementId: REQUIREMENT_ID, fromSha: from, toSha: head,
  });
  assert.equal(result.valid, true, 'api source');
  assert.equal(result.classification, 'runtime-affecting', 'api source');
  assert.equal(result.deploymentNeutral, false, 'api source');

  writeFileSync(join(env.cwd, 'apps', 'api', 'src', 'foo.spec.ts'), '// spec inside build inputs\n');
  from = head;
  head = commitChange(env.cwd, 'test: add spec inside build inputs');
  result = classifyRevisionRange({
    cwd: env.cwd, requirementId: REQUIREMENT_ID, fromSha: from, toSha: head,
  });
  assert.equal(result.classification, 'runtime-affecting', 'spec inside build inputs');
});

test('runtime-affecting: mixed and unknown paths take the highest risk level', (t) => {
  {
    const env = setupPolicyFixture(t);
    mkdirSync(join(env.cwd, 'docs', 'ops'), { recursive: true });
    writeFileSync(join(env.cwd, 'docs', 'ops', 'NOTE.md'), '# note\n');
    mkdirSync(join(env.cwd, 'apps', 'api', 'src'), { recursive: true });
    writeFileSync(join(env.cwd, 'apps', 'api', 'src', 'y.ts'), 'export {};\n');
    const head = commitChange(env.cwd, 'test: docs plus runtime code');
    const result = classify(env, head);
    assert.equal(result.valid, true);
    assert.equal(result.classification, 'runtime-affecting');
    assert.equal(result.evidenceNeutral, false);
    assert.equal(result.deploymentNeutral, false);
  }
  {
    const env = setupPolicyFixture(t);
    mkdirSync(join(env.cwd, 'scripts', 'other'), { recursive: true });
    writeFileSync(join(env.cwd, 'scripts', 'other', 'x.sh'), 'exit 0\n');
    const head = commitChange(env.cwd, 'test: unknown path');
    const result = classify(env, head);
    assert.equal(result.valid, true);
    assert.equal(result.classification, 'runtime-affecting');
  }
});

test('runtime-affecting: Dockerfile, .dockerignore and the declaration itself', (t) => {
  {
    const env = setupPolicyFixture(t);
    rewrite(env.cwd, join('apps', 'api', 'Dockerfile'), (source) => `${source}RUN true\n`);
    const head = commitChange(env.cwd, 'test: touch Dockerfile');
    const result = classify(env, head);
    assert.equal(result.classification, 'runtime-affecting', 'Dockerfile');
  }
  {
    const env = setupPolicyFixture(t);
    writeFileSync(join(env.cwd, '.dockerignore'), 'node_modules\n');
    const head = commitChange(env.cwd, 'test: touch dockerignore');
    const result = classify(env, head);
    assert.equal(result.classification, 'runtime-affecting', '.dockerignore');
  }
  {
    const env = setupPolicyFixture(t);
    writeArtifactInputs(env.cwd, {
      schemaVersion: 1,
      services: {
        ...ARTIFACT_INPUTS.services,
        api: { includes: ['apps/api/**'], excludes: ['apps/api/e2e/**'] },
      },
    });
    const head = commitChange(env.cwd, 'test: change artifact input declaration');
    const result = classify(env, head);
    assert.equal(result.valid, true, 'declaration change');
    assert.equal(result.classification, 'runtime-affecting', 'declaration change');
  }
});

test('invalid revision ranges never degrade into runtime-affecting', (t) => {
  const env = setupPolicyFixture(t);
  writeFileSync(join(env.cwd, REQUIREMENT_DIR, 'NOTE.md'), '# note\n');
  const head = commitChange(env.cwd, 'test: second commit');

  const badHex = classifyRevisionRange({
    cwd: env.cwd, requirementId: REQUIREMENT_ID, fromSha: 'abc123', toSha: head,
  });
  assert.equal(badHex.valid, false);
  assert.equal(badHex.code, 'REVISION_RANGE_INVALID');
  assert.notEqual(badHex.classification, 'runtime-affecting');

  const missing = classifyRevisionRange({
    cwd: env.cwd,
    requirementId: REQUIREMENT_ID,
    fromSha: '0'.repeat(40),
    toSha: head,
  });
  assert.equal(missing.valid, false);
  assert.equal(missing.code, 'REVISION_RANGE_INVALID');

  const reversed = classifyRevisionRange({
    cwd: env.cwd, requirementId: REQUIREMENT_ID, fromSha: head, toSha: env.baseSha,
  });
  assert.equal(reversed.valid, false);
  assert.equal(reversed.code, 'REVISION_RANGE_INVALID');

  const empty = classifyRevisionRange({
    cwd: env.cwd, requirementId: REQUIREMENT_ID, fromSha: head, toSha: head,
  });
  assert.equal(empty.valid, true);
  assert.equal(empty.classification, 'evidence-neutral');
});

test('loader validates declaration structure and Dockerfile coverage', (t) => {
  const assertInvalid = (cwd) => assert.throws(
    () => loadRuntimeArtifactInputs({ cwd }),
    (error) => error instanceof RevisionPolicyError
      && error.code === 'ARTIFACT_INPUTS_INVALID',
  );
  {
    const env = setupPolicyFixture(t);
    const loaded = loadRuntimeArtifactInputs({ cwd: env.cwd });
    assert.equal(loaded.schemaVersion, 1);
    assert.deepEqual(
      Object.keys(loaded.services).sort(),
      ['admin', 'api'],
    );
  }
  const invalidDeclarations = {
    'wrong schemaVersion': { ...ARTIFACT_INPUTS, schemaVersion: 2 },
    'missing services': { schemaVersion: 1 },
    'empty services': { schemaVersion: 1, services: {} },
    'empty includes': {
      schemaVersion: 1,
      services: { admin: { includes: [], excludes: [] } },
    },
    'exclude outside includes': {
      schemaVersion: 1,
      services: { admin: { includes: ['apps/admin/**'], excludes: ['apps/web/**'] } },
    },
    'unknown key': {
      schemaVersion: 1,
      services: { admin: { includes: ['apps/admin/**'], excludes: [], comment: 'x' } },
    },
  };
  for (const declaration of Object.values(invalidDeclarations)) {
    const env = setupPolicyFixture(t);
    writeArtifactInputs(env.cwd, declaration);
    assertInvalid(env.cwd);
  }
  {
    const env = setupPolicyFixture(t);
    rewrite(env.cwd, join('apps', 'api', 'Dockerfile'), (source) => source.replace(
      'COPY apps/api ./apps/api',
      'COPY apps/api ./apps/api\nCOPY apps/shared ./apps/shared',
    ));
    assertInvalid(env.cwd);
  }
});

test('classify rejects an invalid declaration instead of guessing', (t) => {
  const env = setupPolicyFixture(t);
  writeArtifactInputs(env.cwd, { schemaVersion: 2, services: {} });
  const head = commitChange(env.cwd, 'test: break declaration');
  assert.throws(
    () => classify(env, head),
    (error) => error instanceof RevisionPolicyError
      && error.code === 'ARTIFACT_INPUTS_INVALID',
  );
});

// I-113 (unified branch): a co-branch requirement's lifecycle projection
// changes only its own BACKLOG status cell — evidence-neutral for this
// requirement; a core-cell change to another row stays a hard fail.
test('evidence-neutral: co-branch requirement BACKLOG status projection', (t) => {
  const env = setupPolicyFixture(t);
  rewrite(env.cwd, 'BACKLOG.md', (source) => source.replace(
    '| I-001 | Other requirement | 否 | 🔨 In Dev | v0.2.32 | keep unchanged |',
    '| I-001 | Other requirement | 否 | 🧪 Testing | v0.2.32 | keep unchanged |',
  ));
  const head = commitChange(env.cwd, 'test: co-branch requirement lifecycle projection');
  const result = classify(env, head);
  assert.equal(result.valid, true);
  assert.equal(result.classification, 'evidence-neutral');
});

test('hard fail: co-branch requirement BACKLOG core cells stay frozen', (t) => {
  const env = setupPolicyFixture(t);
  rewrite(env.cwd, 'BACKLOG.md', (source) => source.replace(
    '| I-001 | Other requirement | 否 | 🔨 In Dev | v0.2.32 | keep unchanged |',
    '| I-001 | Other requirement REWRITTEN | 否 | 🔨 In Dev | v0.2.32 | keep unchanged |',
  ));
  const head = commitChange(env.cwd, 'test: tamper with co-branch requirement row');
  const result = classify(env, head);
  assert.equal(result.valid, false);
  assert.equal(result.code, 'REVISION_POLICY_HARDFAIL');
});
