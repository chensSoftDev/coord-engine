import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  evidencePath,
  parseAcceptanceCommands,
  parseManifest,
  runRequiredTests,
  validateTestEvidence,
} from '../../lib/coordination/evidence.mjs';
import { REVISION_POLICY_VERSION } from '../../lib/coordination/revision-policy.mjs';
import { GitCoordinationStore } from '../../lib/coordination/git-store.mjs';
import { main } from '../../lib/coordination/cli.mjs';
import { acquireLease } from '../../lib/coordination/leases.mjs';
import { enterFreeze } from '../../lib/coordination/freezes.mjs';
import {
  bindRequirementVersion,
  claimRequirement,
} from '../../lib/coordination/requirements.mjs';
import {
  gitCommonDir,
  initializeSession,
} from '../../lib/coordination/worktrees.mjs';
import { createGitFixture, createMemoryIo, runGit } from './fixtures.mjs';

const ACCEPTANCE = `# Acceptance

\`\`\`coord-required
["node", "scripts/verify.mjs"]
pnpm verify
\`\`\`
`;

function setupEvidenceFixture(t, {
  profile = 'tooling',
  services = 'none',
  requirementId = 'I-057',
} = {}) {
  const fixture = createGitFixture(t);
  const requirementDir = join(
    fixture.clientA,
    'docs',
    'product',
    'current',
    `${requirementId}-evidence-fixture`,
  );
  mkdirSync(requirementDir, { recursive: true });
  mkdirSync(join(fixture.clientA, 'scripts'), { recursive: true });
  mkdirSync(join(fixture.clientA, 'deploy', 'release-manifests'), { recursive: true });
  writeFileSync(join(requirementDir, 'ACCEPTANCE.md'), ACCEPTANCE);
  writeFileSync(join(fixture.clientA, 'scripts', 'verify.mjs'), 'process.exitCode = 0;\n');
  writeFileSync(join(fixture.clientA, 'package.json'), JSON.stringify({
    private: true,
    scripts: { verify: 'node scripts/verify.mjs' },
  }, null, 2));
  writeFileSync(
    join(fixture.clientA, 'deploy', 'release-manifests', 'v0.2.32.env'),
    [
      'RELEASE_VERSION=v0.2.32',
      `RELEASE_REQUIREMENTS=${requirementId}`,
      `RELEASE_DELIVERY_PROFILE=${profile}`,
      `RELEASE_SERVICES=${services}`,
      '',
    ].join('\n'),
  );
  mkdirSync(join(fixture.clientA, '.agents'), { recursive: true });
  mkdirSync(join(fixture.clientA, 'apps', 'api'), { recursive: true });
  writeFileSync(
    join(fixture.clientA, '.agents', 'runtime-artifact-inputs.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      services: { api: { includes: ['apps/api/**'], excludes: [] } },
    }, null, 2)}\n`,
  );
  writeFileSync(
    join(fixture.clientA, 'apps', 'api', 'Dockerfile'),
    'FROM node:22-alpine\nCOPY apps/api ./apps/api\n',
  );
  runGit(fixture.clientA, ['switch', '-c', `feature/v0.2.32/${requirementId.toLowerCase()}`]);
  runGit(fixture.clientA, [
    'add',
    'docs',
    'scripts/verify.mjs',
    'package.json',
    'deploy',
    '.agents',
    'apps',
  ]);
  runGit(fixture.clientA, ['commit', '-m', 'test: prepare evidence fixture']);
  return {
    fixture,
    requirementDir,
    requirement: {
      id: requirementId,
      version: 'v0.2.32',
      deliveryProfile: profile,
    },
  };
}

async function setupCoordinationTesting(context) {
  const clock = () => new Date('2026-07-17T00:00:00.000Z');
  const store = new GitCoordinationStore({
    cwd: context.fixture.clientA,
    remote: 'origin',
    branch: 'coordination',
    tempRoot: context.fixture.tempRoot,
    clock,
  });
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const claimed = await claimRequirement({
    store,
    type: 'I',
    title: 'Evidence fixture',
    profile: context.requirement.deliveryProfile,
    backlogText: '| I-056 | previous |\n',
  });
  assert.equal(claimed.id, context.requirement.id);
  await bindRequirementVersion({ store, id: claimed.id, version: context.requirement.version });
  await store.update({
    operation: `prepare ${claimed.id} testing`,
    mutate(snapshot) {
      const path = `requirements/${claimed.id}.json`;
      snapshot.writeJson(path, {
        ...snapshot.readJson(path),
        lifecycle: 'testing',
        branch: runGit(context.fixture.clientA, ['branch', '--show-current']),
      });
    },
  });
  writeFileSync(join(context.fixture.clientA, 'BACKLOG.md'), [
    '| I-001 | Other requirement | 否 | ⚪ Todo | - | keep unchanged |',
    `| ${claimed.id} | Evidence fixture | 否 | 🧪 Testing | v0.2.32 | fixture |`,
    '',
  ].join('\n'));
  runGit(context.fixture.clientA, ['add', 'BACKLOG.md']);
  runGit(context.fixture.clientA, ['commit', '-m', `test: project ${claimed.id} to Testing`]);
  runGit(context.fixture.clientA, [
    'push', '--set-upstream', 'origin',
    `HEAD:refs/heads/${runGit(context.fixture.clientA, ['branch', '--show-current'])}`,
  ]);
  return { store, clock };
}

function coordinationEnv(context) {
  return {
    ...process.env,
    COORD_CWD: context.fixture.clientA,
    COORD_REMOTE: 'origin',
    COORD_BRANCH: 'coordination',
    COORD_TEMP_ROOT: context.fixture.tempRoot,
  };
}

function runtimeDeploymentRecord(context, { branch, head, sessionId, services = ['api'] }) {
  const manifestPath = join(
    context.fixture.clientA,
    'deploy',
    'release-manifests',
    'v0.2.32.env',
  );
  return {
    schemaVersion: 2,
    stage: 'dev',
    requirementId: context.requirement.id,
    version: 'v0.2.32',
    commit: head,
    branch,
    services,
    declaredServices: services,
    serviceOverride: false,
    artifacts: Object.fromEntries(services.map((service) => [service, {
      imageId: `sha256:${'a'.repeat(64)}`,
      imageTag: `luggage-${service}:v0.2.32-fixture`,
    }])),
    manifest: {
      path: 'deploy/release-manifests/v0.2.32.env',
      sha256: createHash('sha256').update(readFileSync(manifestPath)).digest('hex'),
    },
    sourceSnapshot: {
      path: 'deploy/dev-releases/v0.2.32/fixture.env',
      sha256: 'b'.repeat(64),
    },
    sessionId,
    recordedAt: '2026-07-17T00:00:00.000Z',
  };
}

test('parses argv arrays and plain commands without invoking a shell', (t) => {
  const context = setupEvidenceFixture(t);
  const commands = parseAcceptanceCommands(ACCEPTANCE, { cwd: context.fixture.clientA });
  assert.deepEqual(commands, [
    ['node', 'scripts/verify.mjs'],
    ['pnpm', 'verify'],
  ]);
});

test('rejects shell syntax, traversal, eval flags, and undeclared executables', (t) => {
  const context = setupEvidenceFixture(t);
  const invalid = [
    'pnpm verify; rm -rf .',
    'bash $(touch /tmp/unsafe)',
    'node -e "process.exit(0)"',
    'node ../outside.mjs',
    'curl https://example.com',
  ];
  for (const command of invalid) {
    assert.throws(
      () => parseAcceptanceCommands(`\`\`\`coord-required\n${command}\n\`\`\``, {
        cwd: context.fixture.clientA,
      }),
      (error) => error.code === 'UNSAFE_TEST_COMMAND' && error.exitCode === 14,
      command,
    );
  }
});

// I-134 (dogfood fix): the I-132 `manifest init` generator renders the
// annotated _example.env template — the evidence parser must accept the
// comment/blank lines coord itself produces.
test('parseManifest tolerates comments and blank lines from the generator template', () => {
  const generated = [
    '# Release Manifest 模板',
    '# 每个 Version 一个文件。',
    '',
    'RELEASE_VERSION=v0.14.0',
    '',
    '# 本版本包含的需求 ID，逗号分隔。',
    'RELEASE_REQUIREMENTS=I-134',
    'RELEASE_DELIVERY_PROFILE=tooling',
    'RELEASE_SERVICES=none',
    '# 可选：上一版本号。',
    '# BASE_VERSION=vX.Y.Z-1',
    '',
  ].join('\n');
  assert.deepEqual(parseManifest(generated), {
    RELEASE_VERSION: 'v0.14.0',
    RELEASE_REQUIREMENTS: 'I-134',
    RELEASE_DELIVERY_PROFILE: 'tooling',
    RELEASE_SERVICES: 'none',
  });
});

test('parseManifest still rejects non-comment lines without a key', () => {
  assert.throws(
    () => parseManifest('RELEASE_VERSION=v0.14.0\nnot a field\n'),
    (error) => error.code === 'INVALID_RELEASE_MANIFEST',
  );
});

test('runs commands sequentially and writes complete machine evidence', async (t) => {
  const context = setupEvidenceFixture(t);
  const calls = [];
  let tick = 0;
  const clock = () => new Date(1_752_710_400_000 + (tick += 1) * 1000);
  const result = await runRequiredTests({
    cwd: context.fixture.clientA,
    id: context.requirement.id,
    requirement: context.requirement,
    clock,
    runner: async ({ argv, index }) => {
      calls.push({ argv, index });
      return { exitCode: 0, stdout: `passed ${index}\n`, stderr: '' };
    },
  });

  assert.deepEqual(calls.map(({ index }) => index), [0, 1]);
  assert.equal(result.evidence.outcome, 'passed');
  assert.equal(result.evidence.requirement.id, 'I-057');
  assert.equal(result.evidence.requirement.version, 'v0.2.32');
  assert.equal(result.evidence.requirement.deliveryProfile, 'tooling');
  assert.match(result.evidence.testedCommit, /^[0-9a-f]{40}$/);
  assert.match(result.evidence.mainBase, /^[0-9a-f]{40}$/);
  assert.match(result.evidence.manifest.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(result.evidence.commands.map(({ argv }) => argv), [
    ['node', 'scripts/verify.mjs'],
    ['pnpm', 'verify'],
  ]);
  assert.ok(result.evidence.commands.every(({ outcome }) => outcome === 'passed'));
  assert.equal(result.path, evidencePath({ cwd: context.fixture.clientA, id: 'I-057' }));
  assert.deepEqual(JSON.parse(readFileSync(result.path, 'utf8')), result.evidence);
});

test('committed evidence uses portable paths while local logs stay in the Git common dir', async (t) => {
  const context = setupEvidenceFixture(t);
  const commonDirectory = gitCommonDir(context.fixture.clientA);
  const result = await runRequiredTests({
    cwd: context.fixture.clientA,
    id: context.requirement.id,
    requirement: context.requirement,
    runner: async () => ({
      exitCode: 0,
      stdout: `cwd=${context.fixture.clientA}\ncommon=${commonDirectory}\n`,
      stderr: '',
    }),
  });

  const serialized = JSON.stringify(result.evidence);
  assert.doesNotMatch(serialized, new RegExp(context.fixture.clientA.replaceAll('/', '\\/')));
  assert.doesNotMatch(serialized, new RegExp(commonDirectory.replaceAll('/', '\\/')));
  for (const [index, command] of result.evidence.commands.entries()) {
    assert.match(
      command.logPath,
      new RegExp(`^coordination/test-logs/I-057/[0-9a-f-]{36}/${String(index + 1).padStart(2, '0')}\\.log$`),
    );
    assert.match(command.stdoutSummary, /cwd=<WORKTREE>/);
    assert.match(command.stdoutSummary, /common=<GIT_COMMON_DIR>/);
    assert.match(readFileSync(resolve(commonDirectory, command.logPath), 'utf8'), /\[stdout\]/);
  }
});

test('redacts credentials from committed command summaries', async (t) => {
  const context = setupEvidenceFixture(t);
  const result = await runRequiredTests({
    cwd: context.fixture.clientA,
    id: context.requirement.id,
    requirement: context.requirement,
    runner: async () => ({
      exitCode: 0,
      stdout: [
        'API_TOKEN=super-secret-value',
        `COORD_GUARD_TICKET=${'f'.repeat(64)}`,
        'AWS_SECRET_ACCESS_KEY=aws-secret',
        'MYSQL_PASSWORD=mysql-secret',
        'ADMIN_TOKEN=admin-secret',
        '',
      ].join('\n'),
      stderr: 'Authorization: Bearer eyJhbGciOi.fake.signature ticket=short-lived-capability\n',
    }),
  });
  const serialized = JSON.stringify(result.evidence);
  assert.doesNotMatch(
    serialized,
    /super-secret-value|eyJhbGciOi\.fake\.signature|f{64}|short-lived-capability|aws-secret|mysql-secret|admin-secret/,
  );
  assert.match(serialized, /\[REDACTED\]/);
});

test('a failed required command records failed evidence and stops the sequence', async (t) => {
  const context = setupEvidenceFixture(t);
  const calls = [];
  const result = await runRequiredTests({
    cwd: context.fixture.clientA,
    id: context.requirement.id,
    requirement: context.requirement,
    runner: async ({ index }) => {
      calls.push(index);
      return index === 0
        ? { exitCode: 7, stdout: '', stderr: 'intentional failure\n' }
        : { exitCode: 0, stdout: '', stderr: '' };
    },
  });

  // I-113 ACCEPTANCE B: a non-zero first attempt gets exactly one automatic
  // retry with unchanged inputs; a second failure is the real failure, so the
  // sequence stops without ever running command 1.
  assert.deepEqual(calls, [0, 0]);
  assert.equal(result.evidence.outcome, 'failed');
  assert.equal(result.evidence.commands[0].exitCode, 7);
  assert.equal(result.evidence.commands[0].outcome, 'failed');
  await assert.rejects(
    validateTestEvidence({ cwd: context.fixture.clientA, id: 'I-057' }),
    (error) => error.code === 'TEST_EVIDENCE_INVALID' && error.exitCode === 14,
  );
});

test('a second identical run reuses passed results without invoking the runner', async (t) => {
  const context = setupEvidenceFixture(t);
  const calls = [];
  const runner = async ({ argv, index }) => {
    calls.push({ argv, index });
    return { exitCode: 0, stdout: `passed ${index}\n`, stderr: '' };
  };
  const first = await runRequiredTests({
    cwd: context.fixture.clientA,
    id: context.requirement.id,
    requirement: context.requirement,
    runner,
  });
  assert.equal(first.evidence.outcome, 'passed');
  assert.deepEqual(calls.map(({ index }) => index), [0, 1]);

  const second = await runRequiredTests({
    cwd: context.fixture.clientA,
    id: context.requirement.id,
    requirement: context.requirement,
    runner,
  });

  assert.equal(second.evidence.outcome, 'passed');
  assert.equal(second.evidence.testedCommit, first.evidence.testedCommit);
  assert.equal(second.evidence.mainBase, first.evidence.mainBase);
  assert.equal(second.evidence.manifest.sha256, first.evidence.manifest.sha256);
  assert.deepEqual(calls.map(({ index }) => index), [0, 1]);
  assert.deepEqual(second.evidence.commands.map(({ argv }) => argv), [
    ['node', 'scripts/verify.mjs'],
    ['pnpm', 'verify'],
  ]);
  assert.ok(second.evidence.commands.every(({ outcome }) => outcome === 'passed'));
  assert.ok(
    second.evidence.commands.every(({ reused }) => reused === true),
    'reused commands must be marked with reused=true',
  );
});

test('B-248: a dirty worktree refuses to run, and the clean cache survives the refusal', async (t) => {
  const context = setupEvidenceFixture(t);
  const cwd = context.fixture.clientA;
  const calls = [];
  const runner = async ({ argv, index }) => {
    calls.push({ argv, index });
    return { exitCode: 0, stdout: `passed ${index}\n`, stderr: '' };
  };
  const run = () => runRequiredTests({
    cwd,
    id: context.requirement.id,
    requirement: context.requirement,
    runner,
  });

  const first = await run();
  assert.equal(first.evidence.outcome, 'passed');
  assert.deepEqual(calls.map(({ index }) => index), [0, 1]);

  // B-248: a dirty worktree no longer re-runs silently — the recorded
  // testedCommit would describe a tree that never exists in git, so the run
  // is refused up front with an actionable code and nothing executes.
  const readmePath = join(cwd, 'README.md');
  const originalReadme = readFileSync(readmePath, 'utf8');
  writeFileSync(readmePath, `${originalReadme}dirty after testing\n`);
  await assert.rejects(run(), (error) => (
    error.code === 'DIRTY_WORKTREE'
      && /uncommitted or untracked changes/.test(error.message)
  ));
  assert.deepEqual(
    calls.map(({ index }) => index),
    [0, 1],
    'a dirty worktree must not execute required commands at all',
  );

  // Restoring the original content leaves only TEST_EVIDENCE.json changed;
  // the evidence file itself must not block reuse of the original clean cache,
  // and the refused dirty attempt must not have poisoned it.
  writeFileSync(readmePath, originalReadme);
  const restored = await run();
  assert.equal(restored.evidence.outcome, 'passed');
  assert.deepEqual(
    calls.map(({ index }) => index),
    [0, 1],
    'a clean worktree must reuse the cache written before the dirty attempt',
  );
  assert.ok(
    restored.evidence.commands.every(({ reused }) => reused === true),
    'restored clean run must reuse the original cached results',
  );
});

test('a cached result whose log path escapes the git common dir is rejected', async (t) => {
  const context = setupEvidenceFixture(t);
  const cwd = context.fixture.clientA;
  const calls = [];
  const runner = async ({ argv, index }) => {
    calls.push({ argv, index });
    return { exitCode: 0, stdout: `passed ${index}\n`, stderr: '' };
  };
  const first = await runRequiredTests({
    cwd,
    id: context.requirement.id,
    requirement: context.requirement,
    runner,
  });
  assert.equal(first.evidence.outcome, 'passed');
  assert.deepEqual(calls.map(({ index }) => index), [0, 1]);

  const commonDirectory = gitCommonDir(cwd);
  const cacheDirectory = resolve(
    commonDirectory,
    'coordination',
    'test-results',
    context.requirement.id,
  );
  const escapedLogPath = join(cwd, 'README.md');
  for (const entry of readdirSync(cacheDirectory)) {
    const path = join(cacheDirectory, entry);
    const record = JSON.parse(readFileSync(path, 'utf8'));
    record.result.logPath = escapedLogPath;
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  }

  const second = await runRequiredTests({
    cwd,
    id: context.requirement.id,
    requirement: context.requirement,
    runner,
  });
  assert.equal(second.evidence.outcome, 'passed');
  assert.deepEqual(
    calls.map(({ index }) => index),
    [0, 1, 0, 1],
    'a cached log path outside the git common dir must be rejected and re-run',
  );
  assert.ok(
    second.evidence.commands.every(({ reused }) => reused !== true),
    'a tampered cache record must not produce reused results',
  );
});

test('a malformed JSON cache record falls back to the real runner', async (t) => {
  const context = setupEvidenceFixture(t);
  const cwd = context.fixture.clientA;
  const calls = [];
  const runner = async ({ argv, index }) => {
    calls.push({ argv, index });
    return { exitCode: 0, stdout: `passed ${index}\n`, stderr: '' };
  };
  const first = await runRequiredTests({
    cwd,
    id: context.requirement.id,
    requirement: context.requirement,
    runner,
  });
  assert.equal(first.evidence.outcome, 'passed');
  assert.deepEqual(calls.map(({ index }) => index), [0, 1]);

  const cacheDirectory = resolve(
    gitCommonDir(cwd),
    'coordination',
    'test-results',
    context.requirement.id,
  );
  for (const entry of readdirSync(cacheDirectory)) {
    writeFileSync(join(cacheDirectory, entry), 'this is not valid json{');
  }

  const second = await runRequiredTests({
    cwd,
    id: context.requirement.id,
    requirement: context.requirement,
    runner,
  });
  assert.equal(second.evidence.outcome, 'passed');
  assert.deepEqual(
    calls.map(({ index }) => index),
    [0, 1, 0, 1],
    'an unreadable cache record must be treated as a miss and re-run',
  );
  assert.ok(
    second.evidence.commands.every(({ reused }) => reused !== true),
    'a malformed cache record must not produce reused results',
  );
});

test('a rerun reuses earlier passed commands and only re-executes the previously failing one', async (t) => {
  const context = setupEvidenceFixture(t);
  const cwd = context.fixture.clientA;
  const calls = [];
  let failSecondCommand = true;
  const runner = async ({ argv, index }) => {
    calls.push({ argv, index });
    if (index === 1 && failSecondCommand) {
      return { exitCode: 7, stdout: '', stderr: 'intentional failure\n' };
    }
    return { exitCode: 0, stdout: `passed ${index}\n`, stderr: '' };
  };
  const run = () => runRequiredTests({
    cwd,
    id: context.requirement.id,
    requirement: context.requirement,
    runner,
  });

  const first = await run();
  assert.equal(first.evidence.outcome, 'failed');
  // The failing command is retried once in the same run before giving up.
  assert.deepEqual(calls.map(({ index }) => index), [0, 1, 1]);

  failSecondCommand = false;
  const second = await run();
  assert.equal(second.evidence.outcome, 'passed');
  assert.deepEqual(
    calls.map(({ index }) => index),
    [0, 1, 1, 1],
    'only the previously failing command must re-execute',
  );
  assert.equal(
    second.evidence.commands[0].reused,
    true,
    'the command that already passed must be reused from the cache',
  );
  assert.notEqual(second.evidence.commands[1].reused, true);
  assert.equal(second.evidence.commands[1].exitCode, 0);
});

// I-113 ACCEPTANCE B: a flaky/infra first failure with unchanged inputs gets
// at most one automatic retry within the same run; a second failure is a real
// failure. No stale/partial outcomes and no third attempt are introduced.
test('a flaky first failure retries the same command at most once within a run (I-113 ACCEPTANCE B)', async (t) => {
  await t.test('first failure then success retries exactly once, keeps both attempt logs, and continues', async (subtest) => {
    const context = setupEvidenceFixture(subtest);
    const cwd = context.fixture.clientA;
    const calls = [];
    const runner = async ({ argv, index }) => {
      calls.push({ argv, index });
      const attempt = calls.filter((call) => call.index === index).length;
      if (index === 0 && attempt === 1) {
        return {
          exitCode: 7,
          stdout: 'flaky attempt 1 stdout\n',
          stderr: 'flaky attempt 1 stderr: infra timeout\n',
        };
      }
      return { exitCode: 0, stdout: `passed ${index}\n`, stderr: '' };
    };
    const result = await runRequiredTests({
      cwd,
      id: context.requirement.id,
      requirement: context.requirement,
      runner,
    });

    assert.equal(result.evidence.outcome, 'passed');
    assert.deepEqual(
      calls.map(({ index }) => index),
      [0, 0, 1],
      'the flaky command must be retried exactly once and later commands must still run',
    );
    assert.deepEqual(
      calls[1].argv,
      calls[0].argv,
      'the retry attempt must receive exactly the same argv as the first attempt',
    );
    const [retried, following] = result.evidence.commands;
    assert.equal(retried.outcome, 'passed');
    assert.equal(retried.exitCode, 0);
    assert.equal(following.outcome, 'passed');

    // Both attempts' stdout/stderr stay in the local log with explicit
    // attempt boundaries; the retry must not overwrite the first failure's
    // diagnostics.
    const log = readFileSync(resolve(gitCommonDir(cwd), retried.logPath), 'utf8');
    assert.match(log, /attempt 1/, 'the log must mark the first attempt boundary');
    assert.match(log, /attempt 2/, 'the log must mark the second attempt boundary');
    assert.ok(
      log.includes('flaky attempt 1 stdout'),
      'the first attempt stdout must be preserved',
    );
    assert.ok(
      log.includes('flaky attempt 1 stderr: infra timeout'),
      'the first attempt stderr diagnostics must be preserved',
    );
    assert.ok(
      log.includes('passed 0'),
      'the retry attempt output must be recorded in the same log',
    );
  });

  await t.test('two failures run at most two attempts, fail the evidence, and stop the sequence', async (subtest) => {
    const context = setupEvidenceFixture(subtest);
    const cwd = context.fixture.clientA;
    const calls = [];
    const runner = async ({ argv, index }) => {
      calls.push({ argv, index });
      const attempt = calls.filter((call) => call.index === index).length;
      return {
        exitCode: 7,
        stdout: `attempt ${attempt} stdout\n`,
        stderr: `attempt ${attempt} stderr: still failing\n`,
      };
    };
    const result = await runRequiredTests({
      cwd,
      id: context.requirement.id,
      requirement: context.requirement,
      runner,
    });

    assert.equal(result.evidence.outcome, 'failed');
    assert.deepEqual(
      calls.map(({ index }) => index),
      [0, 0],
      'a persistently failing command must run at most twice and command 1 must never run',
    );
    assert.deepEqual(
      calls[1].argv,
      calls[0].argv,
      'both failed attempts must receive exactly the same argv',
    );
    assert.equal(result.evidence.commands.length, 1);
    const [failed] = result.evidence.commands;
    assert.equal(failed.outcome, 'failed');
    assert.equal(failed.exitCode, 7, 'the second attempt result is the final command result');
    const log = readFileSync(resolve(gitCommonDir(cwd), failed.logPath), 'utf8');
    assert.ok(log.includes('attempt 1 stderr: still failing'), 'first attempt log preserved');
    assert.ok(log.includes('attempt 2 stderr: still failing'), 'second attempt log preserved');
  });

  await t.test('a runner throw is retried once like a non-zero exit code', async (subtest) => {
    const context = setupEvidenceFixture(subtest);
    const cwd = context.fixture.clientA;
    const calls = [];
    const runner = async ({ argv, index }) => {
      calls.push({ argv, index });
      const attempt = calls.filter((call) => call.index === index).length;
      if (index === 0 && attempt === 1) {
        throw new Error('runner infrastructure exploded');
      }
      return { exitCode: 0, stdout: `passed ${index}\n`, stderr: '' };
    };
    const result = await runRequiredTests({
      cwd,
      id: context.requirement.id,
      requirement: context.requirement,
      runner,
    });

    assert.equal(result.evidence.outcome, 'passed');
    assert.deepEqual(
      calls.map(({ index }) => index),
      [0, 0, 1],
      'a runner throw must trigger exactly one retry before giving up',
    );
    const log = readFileSync(
      resolve(gitCommonDir(cwd), result.evidence.commands[0].logPath),
      'utf8',
    );
    assert.ok(
      log.includes('runner infrastructure exploded'),
      'the thrown attempt error must be preserved in the log',
    );
  });

  await t.test('a retry-passed result is cached and reused by the next identical run', async (subtest) => {
    const context = setupEvidenceFixture(subtest);
    const cwd = context.fixture.clientA;
    const calls = [];
    let flaky = true;
    const runner = async ({ argv, index }) => {
      calls.push({ argv, index });
      if (index === 0 && flaky) {
        flaky = false;
        return { exitCode: 7, stdout: '', stderr: 'flaky first attempt\n' };
      }
      return { exitCode: 0, stdout: `passed ${index}\n`, stderr: '' };
    };
    const run = () => runRequiredTests({
      cwd,
      id: context.requirement.id,
      requirement: context.requirement,
      runner,
    });

    const first = await run();
    assert.equal(first.evidence.outcome, 'passed');
    assert.deepEqual(calls.map(({ index }) => index), [0, 0, 1]);

    const second = await run();
    assert.equal(second.evidence.outcome, 'passed');
    assert.deepEqual(
      calls.map(({ index }) => index),
      [0, 0, 1],
      'the retry-passed result must be cached: an identical next run must not invoke the runner',
    );
    assert.ok(
      second.evidence.commands.every(({ reused }) => reused === true),
      'the next identical run must reuse the cached passed results',
    );
  });
});

test('runtime evidence requires a matching dev lease and deployment snapshot', async (t) => {
  const context = setupEvidenceFixture(t, { profile: 'runtime', services: 'api' });
  await assert.rejects(
    runRequiredTests({
      cwd: context.fixture.clientA,
      id: context.requirement.id,
      requirement: context.requirement,
      runner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    }),
    (error) => error.code === 'DEV_EVIDENCE_REQUIRED' && error.exitCode === 14,
  );

  const head = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  const result = await runRequiredTests({
    cwd: context.fixture.clientA,
    id: context.requirement.id,
    requirement: context.requirement,
    environment: {
      devLease: { requirementId: 'I-057', version: 'v0.2.32', commit: head },
      devSnapshot: { version: 'v0.2.32', commit: head, services: ['api'] },
    },
    runner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
  });
  assert.equal(result.evidence.environment.devSnapshot.commit, head);

  await assert.rejects(
    runRequiredTests({
      cwd: context.fixture.clientA,
      id: context.requirement.id,
      requirement: context.requirement,
      environment: {
        devLease: { requirementId: 'I-057', version: 'v0.2.32', commit: head },
        devSnapshot: { version: 'v0.2.32', commit: head, services: ['api'] },
        targets: { e2eBaseUrl: 'http://127.0.0.1:3000' },
      },
      runner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    }),
    (error) => error.code === 'DEV_TEST_TARGET_INVALID',
  );
});

test('evidence becomes invalid when feature HEAD changes', async (t) => {
  const context = setupEvidenceFixture(t);
  await runRequiredTests({
    cwd: context.fixture.clientA,
    id: context.requirement.id,
    requirement: context.requirement,
    runner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
  });
  writeFileSync(join(context.fixture.clientA, 'HEAD_CHANGED.md'), 'changed\n');
  runGit(context.fixture.clientA, ['add', 'HEAD_CHANGED.md']);
  runGit(context.fixture.clientA, ['commit', '-m', 'test: change feature head']);

  await assert.rejects(
    validateTestEvidence({ cwd: context.fixture.clientA, id: 'I-057' }),
    (error) => (
      error.code === 'TEST_EVIDENCE_INVALID'
      && error.data.failures.some(({ code }) => code === 'TESTED_COMMIT_MISMATCH')
    ),
  );
});

test('generated evidence fixes the policy version and acceptance command fingerprint', async (t) => {
  const context = setupEvidenceFixture(t);
  const result = await runRequiredTests({
    cwd: context.fixture.clientA,
    id: context.requirement.id,
    requirement: context.requirement,
    runner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
  });
  assert.equal(result.evidence.revisionPolicyVersion, REVISION_POLICY_VERSION);
  const expectedFingerprint = createHash('sha256')
    .update(JSON.stringify([
      ['node', 'scripts/verify.mjs'],
      ['pnpm', 'verify'],
    ]))
    .digest('hex');
  assert.equal(result.evidence.acceptanceCommandsSha256, expectedFingerprint);
  assert.deepEqual(
    JSON.parse(readFileSync(result.path, 'utf8')).acceptanceCommandsSha256,
    expectedFingerprint,
  );
});

function setupClosureEvidenceFixture(t) {
  const context = setupEvidenceFixture(t);
  const cwd = context.fixture.clientA;
  writeFileSync(join(cwd, 'BACKLOG.md'), [
    '| I-001 | Other requirement | 否 | ⚪ Todo | - | keep unchanged |',
    '| I-057 | Evidence fixture | 否 | 🧪 Testing | v0.2.32 | - |',
    '',
  ].join('\n'));
  writeFileSync(join(context.requirementDir, 'CHECKLIST.md'), [
    '# I-057 Checklist',
    '',
    '- [ ] 4.1 测试通过。',
    '',
  ].join('\n'));
  writeFileSync(join(context.requirementDir, 'ACCEPTANCE.md'), [
    '# Acceptance',
    '',
    '```coord-required',
    '["node", "scripts/verify.mjs"]',
    'pnpm verify',
    '```',
    '',
    '## 本地验收结果',
    '',
    '（testing 阶段填写）',
    '',
  ].join('\n'));
  runGit(cwd, ['add', 'BACKLOG.md', 'docs']);
  runGit(cwd, ['commit', '-m', 'test: prepare closure evidence fixture']);
  return context;
}

test('evidence stays valid after evidence-neutral closure commits', async (t) => {
  const mutations = {
    'BACKLOG status projection': (context) => {
      const path = join(context.fixture.clientA, 'BACKLOG.md');
      writeFileSync(path, readFileSync(path, 'utf8').replace(
        '| I-057 | Evidence fixture | 否 | 🧪 Testing | v0.2.32 | - |',
        '| I-057 | Evidence fixture | 否 | ✅ Test Passed | v0.2.32 | - |',
      ));
      return ['BACKLOG.md'];
    },
    'checklist tick': (context) => {
      const path = join(context.requirementDir, 'CHECKLIST.md');
      writeFileSync(path, readFileSync(path, 'utf8').replace(
        '- [ ] 4.1 测试通过。',
        '- [x] 4.1 测试通过。',
      ));
      return ['docs'];
    },
    'acceptance results append': (context) => {
      const path = join(context.requirementDir, 'ACCEPTANCE.md');
      writeFileSync(path, readFileSync(path, 'utf8').replace(
        '（testing 阶段填写）\n',
        '（testing 阶段填写）\n- 结果：2/2 通过。\n',
      ));
      return ['docs'];
    },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    await t.test(name, async (subtest) => {
      const context = setupClosureEvidenceFixture(subtest);
      const cwd = context.fixture.clientA;
      const { evidence } = await runRequiredTests({
        cwd,
        id: context.requirement.id,
        requirement: context.requirement,
        runner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      });
      const paths = mutate(context);
      runGit(cwd, ['add', ...paths]);
      runGit(cwd, ['commit', '-m', `test: ${name}`]);
      const head = runGit(cwd, ['rev-parse', 'HEAD']);

      const validation = await validateTestEvidence({ cwd, id: 'I-057' });
      assert.equal(validation.valid, true);
      assert.equal(validation.toleratedCommitRange.from, evidence.testedCommit);
      assert.equal(validation.toleratedCommitRange.to, head);
      assert.equal(validation.toleratedCommitRange.classification, 'evidence-neutral');
      assert.equal(typeof validation.toleratedCommitRange.reason, 'string');
    });
  }
});

test('deployment-neutral and runtime-affecting commits still invalidate evidence', async (t) => {
  const mutations = [
    ['docs/ops/note.md', 'deployment-neutral'],
    ['apps/api/src/change.ts', 'runtime-affecting'],
  ];
  for (const [changedPath, classification] of mutations) {
    await t.test(changedPath, async (subtest) => {
      const context = setupClosureEvidenceFixture(subtest);
      const cwd = context.fixture.clientA;
      await runRequiredTests({
        cwd,
        id: context.requirement.id,
        requirement: context.requirement,
        runner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      });
      const target = join(cwd, changedPath);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, 'changed after testing\n');
      runGit(cwd, ['add', changedPath]);
      runGit(cwd, ['commit', '-m', `test: change ${changedPath}`]);

      await assert.rejects(
        validateTestEvidence({ cwd, id: 'I-057' }),
        (error) => (
          error.code === 'TEST_EVIDENCE_INVALID'
          && error.data.failures.some((failure) => (
            failure.code === 'TESTED_COMMIT_MISMATCH'
            && failure.policyClassification === classification
          ))
        ),
      );
    });
  }
});

test('evidence validation fails closed when the tested commit range is invalid', async (t) => {
  const context = setupClosureEvidenceFixture(t);
  const cwd = context.fixture.clientA;
  await runRequiredTests({
    cwd,
    id: context.requirement.id,
    requirement: context.requirement,
    runner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
  });
  runGit(cwd, ['commit', '--amend', '-m', 'test: rewrite the tested commit']);

  await assert.rejects(
    validateTestEvidence({ cwd, id: 'I-057' }),
    (error) => (
      error.code === 'TEST_EVIDENCE_INVALID'
      && error.data.failures.some((failure) => (
        failure.code === 'TESTED_COMMIT_MISMATCH'
        && failure.policyCode === 'REVISION_RANGE_INVALID'
      ))
    ),
  );
});

test('manifest metadata cannot be tampered while retaining the original hash', async (t) => {
  const context = setupEvidenceFixture(t, { profile: 'runtime', services: 'api' });
  const head = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  const result = await runRequiredTests({
    cwd: context.fixture.clientA,
    id: context.requirement.id,
    requirement: context.requirement,
    environment: {
      devLease: { requirementId: 'I-057', version: 'v0.2.32', commit: head },
      devSnapshot: { version: 'v0.2.32', commit: head, services: ['api'] },
    },
    runner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
  });
  const tampered = JSON.parse(readFileSync(result.path, 'utf8'));
  tampered.manifest.services = [];
  tampered.environment.devSnapshot.services = [];
  writeFileSync(result.path, `${JSON.stringify(tampered, null, 2)}\n`);

  await assert.rejects(
    validateTestEvidence({
      cwd: context.fixture.clientA,
      id: 'I-057',
      deployment: result.evidence.environment.devSnapshot,
    }),
    (error) => (
      error.data.failures.some(({ code }) => code === 'MANIFEST_METADATA_MISMATCH')
      && error.data.failures.some(({ code }) => code === 'DEPLOYMENT_FACT_MISMATCH')
    ),
  );
});

test('evidence cannot downgrade a coordinated runtime requirement to tooling', async (t) => {
  const context = setupEvidenceFixture(t, { profile: 'runtime', services: 'api' });
  const head = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  const result = await runRequiredTests({
    cwd: context.fixture.clientA,
    id: context.requirement.id,
    requirement: context.requirement,
    environment: {
      devLease: { requirementId: 'I-057', version: 'v0.2.32', commit: head },
      devSnapshot: { version: 'v0.2.32', commit: head, services: ['api'] },
    },
    runner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
  });
  const tampered = JSON.parse(readFileSync(result.path, 'utf8'));
  tampered.requirement.deliveryProfile = 'tooling';
  writeFileSync(result.path, `${JSON.stringify(tampered, null, 2)}\n`);

  await assert.rejects(
    validateTestEvidence({
      cwd: context.fixture.clientA,
      id: 'I-057',
      requirement: context.requirement,
    }),
    (error) => error.data.failures.some(({ code }) => code === 'REQUIREMENT_FACT_MISMATCH'),
  );
});

test('main base service overlap invalidates evidence while unrelated changes require local CI only', async (t) => {
  for (const { changedPath, valid, failureCode } of [
    { changedPath: 'apps/api/src/change.ts', valid: false, failureCode: 'MAIN_BASE_SERVICE_OVERLAP' },
    { changedPath: 'docs/unrelated.md', valid: true, failureCode: null },
  ]) {
    await t.test(changedPath, async (subtest) => {
      const context = setupEvidenceFixture(subtest, { profile: 'runtime', services: 'api' });
      const head = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
      await runRequiredTests({
        cwd: context.fixture.clientA,
        id: context.requirement.id,
        requirement: context.requirement,
        environment: {
          devLease: { requirementId: 'I-057', version: 'v0.2.32', commit: head },
          devSnapshot: { version: 'v0.2.32', commit: head, services: ['api'] },
        },
        runner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      });

      const target = join(context.fixture.clientB, changedPath);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, 'main changed\n');
      runGit(context.fixture.clientB, ['add', changedPath]);
      runGit(context.fixture.clientB, ['commit', '-m', `test: change ${changedPath}`]);
      runGit(context.fixture.clientB, ['push', 'origin', 'main']);
      runGit(context.fixture.clientA, ['fetch', 'origin', 'main']);

      if (!valid) {
        await assert.rejects(
          validateTestEvidence({ cwd: context.fixture.clientA, id: 'I-057' }),
          (error) => error.data.failures.some(({ code }) => code === failureCode),
        );
      } else {
        const validation = await validateTestEvidence({
          cwd: context.fixture.clientA,
          id: 'I-057',
        });
        assert.equal(validation.valid, true);
        assert.equal(validation.reuseDevEvidence, true);
        assert.deepEqual(validation.requiredActions, ['rerun_local_ci']);
      }
    });
  }
});

test('CLI runs tests, validates evidence, and advances Testing to Test Passed', async (t) => {
  const context = setupEvidenceFixture(t);
  const { store } = await setupCoordinationTesting(context);
  const runIo = createMemoryIo();
  const runExit = await main(['test', 'run', 'I-057', '--json'], {
    env: coordinationEnv(context),
    clock: context.clock,
    ...runIo.io,
  });
  assert.equal(runExit, 0, runIo.stderr.join(''));
  assert.equal(JSON.parse(runIo.stdout.join('')).data.evidence.outcome, 'passed');

  const validateIo = createMemoryIo();
  const validateExit = await main([
    'evidence', 'validate', 'I-057', '--head', 'HEAD', '--base', 'origin/main', '--json',
  ], {
    env: coordinationEnv(context),
    clock: context.clock,
    ...validateIo.io,
  });
  assert.equal(validateExit, 0, validateIo.stderr.join(''));
  assert.equal(JSON.parse(validateIo.stdout.join('')).data.valid, true);

  const advanceIo = createMemoryIo();
  const advanceExit = await main([
    'lifecycle', 'advance', 'I-057', '--to', 'test_passed', '--json',
  ], {
    env: coordinationEnv(context),
    clock: context.clock,
    ...advanceIo.io,
  });
  assert.equal(advanceExit, 0, advanceIo.stderr.join(''));
  const requirement = (await store.readSnapshot()).readJson('requirements/I-057.json');
  assert.equal(requirement.lifecycle, 'test_passed');
  assert.match(readFileSync(join(context.fixture.clientA, 'BACKLOG.md'), 'utf8'), /✅ Test Passed/);
});

test('CLI test failure writes evidence and returns lifecycle to In Dev', async (t) => {
  const context = setupEvidenceFixture(t);
  writeFileSync(join(context.fixture.clientA, 'scripts', 'verify.mjs'), 'process.exitCode = 7;\n');
  runGit(context.fixture.clientA, ['add', 'scripts/verify.mjs']);
  runGit(context.fixture.clientA, ['commit', '-m', 'test: make required command fail']);
  const { store } = await setupCoordinationTesting(context);
  const memory = createMemoryIo();

  const exitCode = await main(['test', 'run', 'I-057', '--json'], {
    env: coordinationEnv(context),
    clock: context.clock,
    ...memory.io,
  });
  assert.equal(exitCode, 14);
  assert.equal(JSON.parse(memory.stderr.join('')).code, 'REQUIRED_TESTS_FAILED');
  const evidence = JSON.parse(readFileSync(evidencePath({
    cwd: context.fixture.clientA,
    id: 'I-057',
  }), 'utf8'));
  assert.equal(evidence.outcome, 'failed');
  const requirement = (await store.readSnapshot()).readJson('requirements/I-057.json');
  assert.equal(requirement.lifecycle, 'in_dev');
  assert.equal(requirement.lifecycleHistory.at(-1).evidenceSha.length, 64);
  assert.match(readFileSync(join(context.fixture.clientA, 'BACKLOG.md'), 'utf8'), /🔨 In Dev/);
  const branch = runGit(context.fixture.clientA, ['branch', '--show-current']);
  runGit(context.fixture.clientA, ['fetch', 'origin', branch]);
  assert.match(
    runGit(context.fixture.clientA, ['show', `origin/${branch}:BACKLOG.md`]),
    /🔨 In Dev/,
  );
});

test('CLI test failure refuses BACKLOG changes outside its requirement', async (t) => {
  const context = setupEvidenceFixture(t);
  writeFileSync(join(context.fixture.clientA, 'scripts', 'verify.mjs'), [
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "const backlog = readFileSync('BACKLOG.md', 'utf8');",
    "writeFileSync('BACKLOG.md', backlog.replace(",
    "  '| I-001 | Other requirement | 否 | ⚪ Todo | - | keep unchanged |',",
    "  '| I-001 | Other requirement | 否 | ⚪ Todo | - | changed outside I-057 |',",
    '));',
    'process.exitCode = 7;',
    '',
  ].join('\n'));
  runGit(context.fixture.clientA, ['add', 'scripts/verify.mjs']);
  runGit(context.fixture.clientA, ['commit', '-m', 'test: pollute another requirement row on failure']);
  const { store } = await setupCoordinationTesting(context);
  const branch = runGit(context.fixture.clientA, ['branch', '--show-current']);
  const remoteShaBefore = runGit(context.fixture.clientA, ['rev-parse', `origin/${branch}`]);
  assert.equal(
    (await store.readSnapshot()).readJson('requirements/I-057.json').lifecycle,
    'testing',
  );

  const memory = createMemoryIo();
  const exitCode = await main(['test', 'run', 'I-057', '--json'], {
    env: coordinationEnv(context),
    clock: context.clock,
    ...memory.io,
  });

  assert.equal(exitCode, 14, memory.stderr.join(''));
  assert.equal(JSON.parse(memory.stderr.join('')).code, 'BACKLOG_PROJECTION_SCOPE_DIRTY');
  const requirement = (await store.readSnapshot()).readJson('requirements/I-057.json');
  assert.equal(requirement.lifecycle, 'testing');
  assert.equal(
    runGit(context.fixture.clientA, ['rev-parse', `origin/${branch}`]),
    remoteShaBefore,
  );
});

test('runtime CLI failure releases the dev lease and returns to In Dev', async (t) => {
  const context = setupEvidenceFixture(t, { profile: 'runtime', services: 'api' });
  writeFileSync(join(context.fixture.clientA, 'scripts', 'verify.mjs'), 'process.exitCode = 7;\n');
  runGit(context.fixture.clientA, ['add', 'scripts/verify.mjs']);
  runGit(context.fixture.clientA, ['commit', '-m', 'test: make runtime command fail']);
  const { store, clock } = await setupCoordinationTesting(context);
  const branch = runGit(context.fixture.clientA, ['branch', '--show-current']);
  const head = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  const session = initializeSession({
    cwd: context.fixture.clientA,
    agent: 'codex',
    user: 'developer',
    host: 'host-a',
    clock,
  });
  await store.update({
    operation: 'prepare runtime dev snapshot',
    mutate(snapshot) {
      const requirement = snapshot.readJson('requirements/I-057.json');
      snapshot.writeJson('requirements/I-057.json', { ...requirement, branch });
      snapshot.writeJson('deployments/dev.json', runtimeDeploymentRecord(context, {
        branch,
        head,
        sessionId: session.sessionId,
      }));
    },
  });
  await acquireLease({
    store,
    cwd: context.fixture.clientA,
    resource: 'dev',
    requirementId: 'I-057',
    ttl: '90m',
    session,
    clock,
  });
  const memory = createMemoryIo();
  const exitCode = await main(['test', 'run', 'I-057', '--json'], {
    env: { ...coordinationEnv(context), COORD_SESSION_ID: session.sessionId },
    clock,
    ...memory.io,
  });

  assert.equal(exitCode, 14);
  const snapshot = await store.readSnapshot();
  assert.equal(snapshot.readJson('locks/dev.json').active, null);
  assert.equal(snapshot.readJson('requirements/I-057.json').lifecycle, 'in_dev');
});

test('runtime CLI failure releases the dev lease when BACKLOG projection is uncertain', async (t) => {
  const context = setupEvidenceFixture(t, { profile: 'runtime', services: 'api' });
  writeFileSync(join(context.fixture.clientA, 'scripts', 'verify.mjs'), 'process.exitCode = 7;\n');
  runGit(context.fixture.clientA, ['add', 'scripts/verify.mjs']);
  runGit(context.fixture.clientA, ['commit', '-m', 'test: fail before projection conflict']);
  const { store, clock } = await setupCoordinationTesting(context);
  const branch = runGit(context.fixture.clientA, ['branch', '--show-current']);
  const head = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  const session = initializeSession({
    cwd: context.fixture.clientA,
    agent: 'codex',
    user: 'developer',
    host: 'host-a',
    clock,
  });
  await store.update({
    operation: 'prepare runtime projection conflict',
    mutate(snapshot) {
      const requirement = snapshot.readJson('requirements/I-057.json');
      snapshot.writeJson('requirements/I-057.json', { ...requirement, branch });
      snapshot.writeJson('deployments/dev.json', runtimeDeploymentRecord(context, {
        branch,
        head,
        sessionId: session.sessionId,
      }));
    },
  });
  await acquireLease({
    store,
    cwd: context.fixture.clientA,
    resource: 'dev',
    requirementId: 'I-057',
    ttl: '90m',
    session,
    clock,
  });
  // B-248: the conflicting row must be committed — an uncommitted one now
  // trips the evidence dirty-worktree refusal before any command runs, while
  // this case targets the post-failure projection uncertainty path.
  writeFileSync(join(context.fixture.clientA, 'BACKLOG.md'), [
    '| I-001 | Other requirement | 否 | ⚪ Todo | - | keep unchanged |',
    '| I-057 | Evidence fixture | 否 | ⚪ Todo | v0.2.32 | conflicting projection |',
    '',
  ].join('\n'));
  runGit(context.fixture.clientA, ['add', 'BACKLOG.md']);
  runGit(context.fixture.clientA, ['commit', '-m', 'test: commit conflicting projection row']);
  const memory = createMemoryIo();
  const exitCode = await main(['test', 'run', 'I-057', '--json'], {
    env: { ...coordinationEnv(context), COORD_SESSION_ID: session.sessionId },
    clock,
    ...memory.io,
  });

  assert.equal(exitCode, 15);
  assert.equal(JSON.parse(memory.stderr.join('')).code, 'PROJECTION_UNCERTAIN');
  const snapshot = await store.readSnapshot();
  assert.equal(snapshot.readJson('requirements/I-057.json').lifecycle, 'in_dev');
  assert.equal(snapshot.readJson('locks/dev.json').active, null);
});

test('runtime CLI failure returns to In Dev even when lease cleanup fails', async (t) => {
  const context = setupEvidenceFixture(t, { profile: 'runtime', services: 'api' });
  const { store, clock } = await setupCoordinationTesting(context);
  const branch = runGit(context.fixture.clientA, ['branch', '--show-current']);
  const session = initializeSession({
    cwd: context.fixture.clientA,
    agent: 'codex',
    user: 'developer',
    host: 'host-a',
    clock,
  });
  const tokenPath = join(
    gitCommonDir(context.fixture.clientA),
    'coordination',
    'lease-tokens',
    `dev-${session.sessionId}.json`,
  );
  writeFileSync(join(context.fixture.clientA, 'scripts', 'verify.mjs'), [
    "import { unlinkSync } from 'node:fs';",
    `try { unlinkSync(${JSON.stringify(tokenPath)}); } catch {}`,
    'process.exitCode = 7;',
    '',
  ].join('\n'));
  runGit(context.fixture.clientA, ['add', 'scripts/verify.mjs']);
  runGit(context.fixture.clientA, ['commit', '-m', 'test: break lease cleanup during failure']);
  const head = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  await store.update({
    operation: 'prepare runtime cleanup failure',
    mutate(snapshot) {
      const requirement = snapshot.readJson('requirements/I-057.json');
      snapshot.writeJson('requirements/I-057.json', { ...requirement, branch });
      snapshot.writeJson('deployments/dev.json', runtimeDeploymentRecord(context, {
        branch,
        head,
        sessionId: session.sessionId,
      }));
    },
  });
  await acquireLease({
    store,
    cwd: context.fixture.clientA,
    resource: 'dev',
    requirementId: 'I-057',
    ttl: '90m',
    session,
    clock,
  });
  const memory = createMemoryIo();
  const exitCode = await main(['test', 'run', 'I-057', '--json'], {
    env: { ...coordinationEnv(context), COORD_SESSION_ID: session.sessionId },
    clock,
    ...memory.io,
  });

  assert.equal(exitCode, 14);
  const error = JSON.parse(memory.stderr.join(''));
  assert.equal(error.code, 'REQUIRED_TESTS_FAILED');
  assert.deepEqual(error.data.leaseCleanup, {
    released: false,
    code: 'NOT_LEASE_HOLDER',
    message: 'current session does not hold the dev lease',
  });
  const snapshot = await store.readSnapshot();
  assert.equal(snapshot.readJson('requirements/I-057.json').lifecycle, 'in_dev');
  assert.equal(snapshot.readJson('locks/dev.json').active.sessionId, session.sessionId);
});

test('declared command input fingerprints rerun only the changed command across commits (I-113)', async (t) => {
  const context = setupEvidenceFixture(t);
  const cwd = context.fixture.clientA;
  writeFileSync(join(context.requirementDir, 'ACCEPTANCE.md'), [
    '# Acceptance',
    '',
    '```coord-required',
    '["node", "scripts/verify-a.mjs"]',
    '["node", "scripts/verify-b.mjs"]',
    '```',
    '',
  ].join('\n'));
  writeFileSync(join(cwd, 'scripts', 'verify-a.mjs'), 'process.exitCode = 0;\n');
  writeFileSync(join(cwd, 'scripts', 'verify-b.mjs'), 'process.exitCode = 0;\n');
  writeFileSync(join(cwd, '.agents', 'coord-required-inputs.json'), `${JSON.stringify({
    schemaVersion: 1,
    commands: [
      {
        argv: ['node', 'scripts/verify-a.mjs'],
        includes: ['scripts/verify-a.mjs'],
        excludes: [],
        lockfiles: [],
      },
      {
        argv: ['node', 'scripts/verify-b.mjs'],
        includes: ['scripts/verify-b.mjs'],
        excludes: [],
        lockfiles: [],
      },
    ],
  }, null, 2)}\n`);
  runGit(cwd, [
    'add',
    'docs',
    'scripts/verify-a.mjs',
    'scripts/verify-b.mjs',
    '.agents/coord-required-inputs.json',
  ]);
  runGit(cwd, ['commit', '-m', 'test: declare per-command input fingerprints']);
  const firstHead = runGit(cwd, ['rev-parse', 'HEAD']);

  const calls = [];
  const runner = async ({ argv, index }) => {
    calls.push({ argv, index });
    return { exitCode: 0, stdout: `passed ${index}\n`, stderr: '' };
  };
  const run = () => runRequiredTests({
    cwd,
    id: context.requirement.id,
    requirement: context.requirement,
    runner,
  });

  const first = await run();
  assert.equal(first.evidence.outcome, 'passed');
  assert.deepEqual(calls.map(({ index }) => index), [0, 1]);

  writeFileSync(join(cwd, 'scripts', 'verify-a.mjs'), 'process.exitCode = 0; // changed\n');
  runGit(cwd, ['add', 'scripts/verify-a.mjs']);
  runGit(cwd, ['commit', '-m', 'test: change only verify-a inputs']);
  const secondHead = runGit(cwd, ['rev-parse', 'HEAD']);

  const second = await run();
  assert.equal(second.evidence.outcome, 'passed');
  assert.deepEqual(
    calls.map(({ argv }) => argv),
    [
      ['node', 'scripts/verify-a.mjs'],
      ['node', 'scripts/verify-b.mjs'],
      ['node', 'scripts/verify-a.mjs'],
    ],
    'only the command whose declared inputs changed must re-execute',
  );
  const [commandA, commandB] = second.evidence.commands;
  assert.deepEqual(commandA.argv, ['node', 'scripts/verify-a.mjs']);
  assert.deepEqual(commandB.argv, ['node', 'scripts/verify-b.mjs']);
  assert.notEqual(commandA.reused, true, 'changed command must not be marked reused');
  assert.equal(commandB.reused, true, 'unchanged command must be reused from the cache');
  for (const command of [commandA, commandB]) {
    assert.match(
      command.inputsSha256 ?? '',
      /^[0-9a-f]{64}$/,
      'each command evidence must carry its declared inputs fingerprint',
    );
  }
  assert.equal(commandA.testedCommit, secondHead);
  assert.equal(
    commandB.testedCommit,
    firstHead,
    'a reused command keeps the commit its cached result was produced on',
  );
  assert.equal(second.evidence.testedCommit, secondHead);
});

test('a linked worktree at a different absolute path reuses declared passed results via the shared Git common dir (I-113)', async (t) => {
  const context = setupEvidenceFixture(t);
  const cwd = context.fixture.clientA;
  writeFileSync(join(context.requirementDir, 'ACCEPTANCE.md'), [
    '# Acceptance',
    '',
    '```coord-required',
    '["node", "scripts/verify-worktree.mjs"]',
    '```',
    '',
  ].join('\n'));
  writeFileSync(join(cwd, 'scripts', 'verify-worktree.mjs'), 'process.exitCode = 0;\n');
  writeFileSync(join(cwd, '.agents', 'coord-required-inputs.json'), `${JSON.stringify({
    schemaVersion: 1,
    commands: [
      {
        argv: ['node', 'scripts/verify-worktree.mjs'],
        includes: ['scripts/verify-worktree.mjs'],
        excludes: [],
        lockfiles: [],
      },
    ],
  }, null, 2)}\n`);
  runGit(cwd, ['add', 'docs', 'scripts/verify-worktree.mjs', '.agents/coord-required-inputs.json']);
  runGit(cwd, ['commit', '-m', 'test: declare linked-worktree reuse inputs']);

  const calls = [];
  const runner = async ({ argv, index }) => {
    calls.push({ argv, index });
    return { exitCode: 0, stdout: `passed ${index}\n`, stderr: '' };
  };

  const first = await runRequiredTests({
    cwd,
    id: context.requirement.id,
    requirement: context.requirement,
    runner,
  });
  assert.equal(first.evidence.outcome, 'passed');
  assert.deepEqual(calls.map(({ index }) => index), [0]);

  // A real linked worktree of the same repository: different absolute path,
  // same commit, same content and declaration, same Git common dir.
  const linked = join(context.fixture.root, 'client-linked');
  runGit(cwd, ['worktree', 'add', '--detach', linked, 'HEAD']);
  assert.notEqual(
    realpathSync(linked),
    realpathSync(cwd),
    'the linked worktree must live at a different absolute path',
  );
  assert.equal(
    gitCommonDir(linked),
    gitCommonDir(cwd),
    'the linked worktree must share the original worktree Git common dir',
  );

  const second = await runRequiredTests({
    cwd: linked,
    id: context.requirement.id,
    requirement: context.requirement,
    runner,
  });

  assert.equal(second.evidence.outcome, 'passed');
  assert.deepEqual(
    calls.map(({ index }) => index),
    [0],
    'same argv, declaration and input content at a different worktree path must not re-execute',
  );
  assert.equal(second.evidence.commands.length, 1);
  const [reusedCommand] = second.evidence.commands;
  assert.equal(
    reusedCommand.reused,
    true,
    'the second run in the linked worktree must reuse the cached passed result',
  );
  assert.equal(
    reusedCommand.testedCommit,
    first.evidence.testedCommit,
    'a reused command keeps the commit its cached result was produced on',
  );
  assert.match(
    reusedCommand.inputsSha256 ?? '',
    /^[0-9a-f]{64}$/,
    'reuse must go through the declared v2 fingerprint, not the exact-commit key',
  );
  // Evidence stays portable: neither worktree absolute path may leak into the
  // committed evidence for the linked-worktree run.
  const serialized = JSON.stringify(second.evidence);
  for (const absolutePath of [realpathSync(linked), realpathSync(cwd), linked, cwd]) {
    assert.ok(
      !serialized.includes(absolutePath),
      `evidence must not embed the worktree absolute path ${absolutePath}`,
    );
  }
});

test('a node declaration that omits the script argument must not reuse across a script change (I-113)', async (t) => {
  const context = setupEvidenceFixture(t);
  const cwd = context.fixture.clientA;
  writeFileSync(join(context.requirementDir, 'ACCEPTANCE.md'), [
    '# Acceptance',
    '',
    '```coord-required',
    '["node", "scripts/verify-a.mjs"]',
    '```',
    '',
  ].join('\n'));
  writeFileSync(join(cwd, 'scripts', 'verify-a.mjs'), 'process.exitCode = 0;\n');
  // The declaration points at an existing, unchanged tracked directory that
  // does NOT cover the script passed as argv[1]; the script change below must
  // therefore re-run the command instead of reusing a stale result.
  writeFileSync(join(cwd, '.agents', 'coord-required-inputs.json'), `${JSON.stringify({
    schemaVersion: 1,
    commands: [
      {
        argv: ['node', 'scripts/verify-a.mjs'],
        includes: ['docs'],
        excludes: [],
        lockfiles: [],
      },
    ],
  }, null, 2)}\n`);
  runGit(cwd, ['add', 'docs', 'scripts/verify-a.mjs', '.agents/coord-required-inputs.json']);
  runGit(cwd, ['commit', '-m', 'test: declare inputs that omit the script argument']);

  const calls = [];
  const runner = async ({ argv, index }) => {
    calls.push({ argv, index });
    return { exitCode: 0, stdout: `passed ${index}\n`, stderr: '' };
  };
  const run = () => runRequiredTests({
    cwd,
    id: context.requirement.id,
    requirement: context.requirement,
    runner,
  });

  const first = await run();
  assert.equal(first.evidence.outcome, 'passed');
  assert.deepEqual(calls.map(({ index }) => index), [0]);

  writeFileSync(join(cwd, 'scripts', 'verify-a.mjs'), 'process.exitCode = 0; // changed\n');
  runGit(cwd, ['add', 'scripts/verify-a.mjs']);
  runGit(cwd, ['commit', '-m', 'test: change only the script argument']);

  const second = await run();
  assert.equal(second.evidence.outcome, 'passed');
  assert.deepEqual(
    calls.map(({ argv }) => argv),
    [['node', 'scripts/verify-a.mjs'], ['node', 'scripts/verify-a.mjs']],
    'a script change outside the declared includes must re-run the command',
  );
  assert.notEqual(
    second.evidence.commands[0].reused,
    true,
    'a declaration that omits the script argument must degrade to exact-commit reuse',
  );
});

// Every fail-closed branch of the declaration loader/fingerprinter must
// degrade the affected command to the v1 exact-commit cache key: a degraded
// command re-executes on every new tested commit and never reuses results
// across commits. (Dirty-worktree bypass is already covered by 'worktree
// changes outside TEST_EVIDENCE.json bypass reuse ...' above.)
const VALID_VERIFY_A_DECLARATION = {
  argv: ['node', 'scripts/verify-a.mjs'],
  includes: ['scripts/verify-a.mjs'],
  excludes: [],
  lockfiles: [],
};
const DEGRADED_DECLARATION_SCENARIOS = [
  {
    name: 'invalid JSON',
    declaration: '{ not valid json\n',
  },
  {
    name: 'invalid schema version',
    declaration: `${JSON.stringify({
      schemaVersion: 2,
      commands: [VALID_VERIFY_A_DECLARATION],
    }, null, 2)}\n`,
  },
  {
    name: 'duplicate declarations for the same argv',
    declaration: `${JSON.stringify({
      schemaVersion: 1,
      commands: [
        VALID_VERIFY_A_DECLARATION,
        { argv: ['node', 'scripts/verify-a.mjs'], includes: ['scripts'], excludes: [] },
      ],
    }, null, 2)}\n`,
  },
  {
    name: 'path traversal in includes',
    declaration: `${JSON.stringify({
      schemaVersion: 1,
      commands: [{
        argv: ['node', 'scripts/verify-a.mjs'],
        includes: ['scripts/verify-a.mjs', '../outside'],
        excludes: [],
        lockfiles: [],
      }],
    }, null, 2)}\n`,
  },
  {
    name: 'unmatched include',
    declaration: `${JSON.stringify({
      schemaVersion: 1,
      commands: [{
        argv: ['node', 'scripts/verify-a.mjs'],
        includes: ['scripts/verify-a.mjs', 'scripts/does-not-exist.mjs'],
        excludes: [],
        lockfiles: [],
      }],
    }, null, 2)}\n`,
  },
  {
    name: 'fully excluded include',
    declaration: `${JSON.stringify({
      schemaVersion: 1,
      commands: [{
        argv: ['node', 'scripts/verify-a.mjs'],
        includes: ['scripts/verify-a.mjs'],
        excludes: ['scripts/verify-a.mjs'],
        lockfiles: [],
      }],
    }, null, 2)}\n`,
  },
  {
    name: 'symlink include',
    declaration: `${JSON.stringify({
      schemaVersion: 1,
      commands: [{
        argv: ['node', 'scripts/verify-a.mjs'],
        includes: ['scripts/verify-a.mjs', 'scripts/verify-link.mjs'],
        excludes: [],
        lockfiles: [],
      }],
    }, null, 2)}\n`,
    setup(cwd) {
      symlinkSync('verify-a.mjs', join(cwd, 'scripts', 'verify-link.mjs'));
    },
  },
  {
    // An entry with a key the schema does not define must fail closed:
    // silently ignoring unknown keys would let a typo like `lockfile`
    // (instead of `lockfiles`) look valid while dropping lockfile coverage.
    name: 'unknown entry key',
    declaration: `${JSON.stringify({
      schemaVersion: 1,
      commands: [{ ...VALID_VERIFY_A_DECLARATION, unexpected: true }],
    }, null, 2)}\n`,
  },
  {
    name: 'declaration deleted between runs',
    declaration: `${JSON.stringify({
      schemaVersion: 1,
      commands: [VALID_VERIFY_A_DECLARATION],
    }, null, 2)}\n`,
    change(cwd) {
      runGit(cwd, ['rm', '-q', '.agents/coord-required-inputs.json']);
    },
  },
];

async function assertDegradedDeclarationRerunsAcrossCommits(t, { declaration, setup, change }) {
  const context = setupEvidenceFixture(t);
  const cwd = context.fixture.clientA;
  writeFileSync(join(context.requirementDir, 'ACCEPTANCE.md'), [
    '# Acceptance',
    '',
    '```coord-required',
    '["node", "scripts/verify-a.mjs"]',
    '```',
    '',
  ].join('\n'));
  writeFileSync(join(cwd, 'scripts', 'verify-a.mjs'), 'process.exitCode = 0;\n');
  setup?.(cwd);
  writeFileSync(join(cwd, '.agents', 'coord-required-inputs.json'), declaration);
  runGit(cwd, ['add', 'docs', 'scripts', '.agents']);
  runGit(cwd, ['commit', '-m', 'test: declare command inputs']);

  const calls = [];
  const runner = async ({ argv, index }) => {
    calls.push({ argv, index });
    return { exitCode: 0, stdout: `passed ${index}\n`, stderr: '' };
  };
  const run = () => runRequiredTests({
    cwd,
    id: context.requirement.id,
    requirement: context.requirement,
    runner,
  });

  const first = await run();
  assert.equal(first.evidence.outcome, 'passed');
  assert.equal(calls.length, 1);

  // A degraded declaration must fall back to the v1 exact-commit path and
  // therefore emit no v2 fingerprints; the deletion scenario is the only
  // one whose first run still holds a valid v2 declaration.
  const v2FingerprintKeys = ['inputsSha256', 'declarationSha256'];
  for (const key of v2FingerprintKeys) {
    if (change) {
      assert.match(
        first.evidence.commands[0][key] ?? '',
        /^[0-9a-f]{64}$/,
        `the run before deletion must carry a valid v2 ${key}`,
      );
    } else {
      assert.equal(
        first.evidence.commands[0][key],
        undefined,
        `a degraded declaration must not emit ${key}`,
      );
    }
  }

  if (change) {
    change(cwd);
    runGit(cwd, ['commit', '-m', 'test: remove the inputs declaration']);
  } else {
    // Advance testedCommit without touching any declared input: a wrongly
    // accepted declaration would find unchanged fingerprints and reuse, so
    // a re-run here proves the v1 path was really taken.
    runGit(cwd, ['commit', '--allow-empty', '-m', 'test: advance the tested commit']);
  }

  const second = await run();
  assert.equal(second.evidence.outcome, 'passed');
  assert.equal(
    calls.length,
    2,
    'a degraded declaration must re-run the command on the new commit',
  );
  assert.notEqual(
    second.evidence.commands[0].reused,
    true,
    'a degraded declaration must not reuse results across commits',
  );
  for (const key of v2FingerprintKeys) {
    assert.equal(
      second.evidence.commands[0][key],
      undefined,
      `a degraded declaration must not emit ${key} after re-running`,
    );
  }
}

for (const scenario of DEGRADED_DECLARATION_SCENARIOS) {
  test(`declaration degradation reruns across commits: ${scenario.name} (I-113)`, async (t) => {
    await assertDegradedDeclarationRerunsAcrossCommits(t, scenario);
  });
}

test('a declaration entry without lockfiles degrades and re-runs on a pnpm-lock.yaml change (I-113)', async (t) => {
  const context = setupEvidenceFixture(t);
  const cwd = context.fixture.clientA;
  writeFileSync(join(context.requirementDir, 'ACCEPTANCE.md'), [
    '# Acceptance',
    '',
    '```coord-required',
    '["node", "scripts/verify-a.mjs"]',
    '```',
    '',
  ].join('\n'));
  writeFileSync(join(cwd, 'scripts', 'verify-a.mjs'), 'process.exitCode = 0;\n');
  writeFileSync(join(cwd, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  // The entry omits the required `lockfiles` field: without a declared
  // lockfile fingerprint the entry must degrade to the v1 exact-commit
  // cache key, so a lockfile-only change on a new commit re-executes the
  // command instead of reusing a stale result.
  writeFileSync(join(cwd, '.agents', 'coord-required-inputs.json'), `${JSON.stringify({
    schemaVersion: 1,
    commands: [
      {
        argv: ['node', 'scripts/verify-a.mjs'],
        includes: ['scripts/verify-a.mjs'],
        excludes: [],
      },
    ],
  }, null, 2)}\n`);
  runGit(cwd, [
    'add',
    'docs',
    'scripts/verify-a.mjs',
    'pnpm-lock.yaml',
    '.agents/coord-required-inputs.json',
  ]);
  runGit(cwd, ['commit', '-m', 'test: declare inputs without the lockfiles field']);

  const calls = [];
  const runner = async ({ argv, index }) => {
    calls.push({ argv, index });
    return { exitCode: 0, stdout: `passed ${index}\n`, stderr: '' };
  };
  const run = () => runRequiredTests({
    cwd,
    id: context.requirement.id,
    requirement: context.requirement,
    runner,
  });

  const first = await run();
  assert.equal(first.evidence.outcome, 'passed');
  assert.equal(calls.length, 1);

  writeFileSync(join(cwd, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n# changed\n');
  runGit(cwd, ['add', 'pnpm-lock.yaml']);
  runGit(cwd, ['commit', '-m', 'test: change only pnpm-lock.yaml']);

  const second = await run();
  assert.equal(second.evidence.outcome, 'passed');
  assert.equal(
    calls.length,
    2,
    'a declaration without lockfiles must degrade to exact-commit and re-run on a lockfile change',
  );
  assert.notEqual(
    second.evidence.commands[0].reused,
    true,
    'a declaration without lockfiles must not reuse results across commits',
  );
  for (const key of ['inputsSha256', 'declarationSha256']) {
    assert.equal(
      second.evidence.commands[0][key],
      undefined,
      `a declaration without lockfiles must take the v1 path and not emit ${key}`,
    );
  }
});

test('declared lockfiles participate in the v2 fingerprint: unrelated commits reuse, lockfile changes re-run (I-113)', async (t) => {
  const context = setupEvidenceFixture(t);
  const cwd = context.fixture.clientA;
  writeFileSync(join(context.requirementDir, 'ACCEPTANCE.md'), [
    '# Acceptance',
    '',
    '```coord-required',
    '["node", "scripts/verify-a.mjs"]',
    '```',
    '',
  ].join('\n'));
  writeFileSync(join(cwd, 'scripts', 'verify-a.mjs'), 'process.exitCode = 0;\n');
  writeFileSync(join(cwd, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  writeFileSync(join(cwd, '.agents', 'coord-required-inputs.json'), `${JSON.stringify({
    schemaVersion: 1,
    commands: [
      {
        argv: ['node', 'scripts/verify-a.mjs'],
        includes: ['scripts/verify-a.mjs'],
        excludes: [],
        lockfiles: ['pnpm-lock.yaml'],
      },
    ],
  }, null, 2)}\n`);
  runGit(cwd, [
    'add',
    'docs',
    'scripts/verify-a.mjs',
    'pnpm-lock.yaml',
    '.agents/coord-required-inputs.json',
  ]);
  runGit(cwd, ['commit', '-m', 'test: declare inputs with a lockfile fingerprint']);

  const calls = [];
  const runner = async ({ argv, index }) => {
    calls.push({ argv, index });
    return { exitCode: 0, stdout: `passed ${index}\n`, stderr: '' };
  };
  const run = () => runRequiredTests({
    cwd,
    id: context.requirement.id,
    requirement: context.requirement,
    runner,
  });

  const first = await run();
  assert.equal(first.evidence.outcome, 'passed');
  assert.equal(calls.length, 1, 'the first run must execute the command');
  const firstLockfilesSha256 = first.evidence.commands[0].lockfilesSha256;
  assert.match(
    firstLockfilesSha256 ?? '',
    /^[0-9a-f]{64}$/,
    'a declaration with lockfiles must emit a lockfilesSha256 fingerprint',
  );

  // A commit that touches only unrelated docs must leave every declared
  // fingerprint unchanged, so the cached result is reused on the new commit.
  writeFileSync(join(cwd, 'docs', 'unrelated.md'), 'unrelated docs\n');
  runGit(cwd, ['add', 'docs/unrelated.md']);
  runGit(cwd, ['commit', '-m', 'test: change only unrelated docs']);

  const second = await run();
  assert.equal(second.evidence.outcome, 'passed');
  assert.equal(
    calls.length,
    1,
    'an unrelated docs commit must not re-run a command with a valid v2 declaration',
  );
  assert.equal(
    second.evidence.commands[0].reused,
    true,
    'an unrelated docs commit must reuse the cached result',
  );
  assert.equal(second.evidence.commands[0].lockfilesSha256, firstLockfilesSha256);

  // A lockfile-only change must move the lockfilesSha256 fingerprint and
  // therefore re-execute the command instead of reusing the stale result.
  writeFileSync(join(cwd, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n# changed\n');
  runGit(cwd, ['add', 'pnpm-lock.yaml']);
  runGit(cwd, ['commit', '-m', 'test: change only pnpm-lock.yaml']);

  const third = await run();
  assert.equal(third.evidence.outcome, 'passed');
  assert.equal(
    calls.length,
    2,
    'a pnpm-lock.yaml change must re-run the command',
  );
  assert.notEqual(
    third.evidence.commands[0].reused,
    true,
    'a lockfile change must not reuse the cached result',
  );
  assert.match(
    third.evidence.commands[0].lockfilesSha256 ?? '',
    /^[0-9a-f]{64}$/,
    'the re-run must emit a fresh lockfilesSha256 fingerprint',
  );
  assert.notEqual(
    third.evidence.commands[0].lockfilesSha256,
    firstLockfilesSha256,
    'a lockfile content change must change the lockfilesSha256 fingerprint',
  );
});

test('fixtureNamespace isolates cached results: namespace change re-runs and is recorded (I-113)', async (t) => {
  const context = setupEvidenceFixture(t);
  const cwd = context.fixture.clientA;
  writeFileSync(join(context.requirementDir, 'ACCEPTANCE.md'), [
    '# Acceptance',
    '',
    '```coord-required',
    '["node", "scripts/verify-a.mjs"]',
    '```',
    '',
  ].join('\n'));
  writeFileSync(join(cwd, 'scripts', 'verify-a.mjs'), 'process.exitCode = 0;\n');
  writeFileSync(join(cwd, '.agents', 'coord-required-inputs.json'), `${JSON.stringify({
    schemaVersion: 1,
    commands: [
      {
        argv: ['node', 'scripts/verify-a.mjs'],
        includes: ['scripts/verify-a.mjs'],
        excludes: [],
        lockfiles: [],
        fixtureNamespace: 'i-113-fixture-a',
      },
    ],
  }, null, 2)}\n`);
  runGit(cwd, [
    'add',
    'docs',
    'scripts/verify-a.mjs',
    '.agents/coord-required-inputs.json',
  ]);
  runGit(cwd, ['commit', '-m', 'test: declare inputs with fixture namespace a']);

  const calls = [];
  const runner = async ({ argv, index }) => {
    calls.push({ argv, index });
    return { exitCode: 0, stdout: `passed ${index}\n`, stderr: '' };
  };
  const run = () => runRequiredTests({
    cwd,
    id: context.requirement.id,
    requirement: context.requirement,
    runner,
  });

  const first = await run();
  assert.equal(first.evidence.outcome, 'passed');
  assert.equal(calls.length, 1, 'the first run must execute the command');
  assert.equal(
    first.evidence.commands[0].fixtureNamespace,
    'i-113-fixture-a',
    'the command result must record the declared fixtureNamespace',
  );

  // Changing only the registry declaration's fixtureNamespace must move the
  // cache identity: the second run re-executes and records the new namespace
  // instead of reusing the result cached under namespace a.
  writeFileSync(join(cwd, '.agents', 'coord-required-inputs.json'), `${JSON.stringify({
    schemaVersion: 1,
    commands: [
      {
        argv: ['node', 'scripts/verify-a.mjs'],
        includes: ['scripts/verify-a.mjs'],
        excludes: [],
        lockfiles: [],
        fixtureNamespace: 'i-113-fixture-b',
      },
    ],
  }, null, 2)}\n`);
  runGit(cwd, ['add', '.agents/coord-required-inputs.json']);
  runGit(cwd, ['commit', '-m', 'test: switch fixture namespace to b']);

  const second = await run();
  assert.equal(second.evidence.outcome, 'passed');
  assert.equal(
    calls.length,
    2,
    'a fixtureNamespace change must re-run the command',
  );
  assert.notEqual(
    second.evidence.commands[0].reused,
    true,
    'a fixtureNamespace change must not reuse the cached result',
  );
  assert.equal(
    second.evidence.commands[0].fixtureNamespace,
    'i-113-fixture-b',
    'the re-run must record the new fixtureNamespace',
  );
});

test('a legacy v1 cache record without testedCommit still reuses safely on the same commit (I-113)', async (t) => {
  const context = setupEvidenceFixture(t);
  const cwd = context.fixture.clientA;
  const calls = [];
  const runner = async ({ argv, index }) => {
    calls.push({ argv, index });
    return { exitCode: 0, stdout: `passed ${index}\n`, stderr: '' };
  };
  const run = () => runRequiredTests({
    cwd,
    id: context.requirement.id,
    requirement: context.requirement,
    runner,
  });
  const first = await run();
  assert.equal(first.evidence.outcome, 'passed');
  assert.deepEqual(calls.map(({ index }) => index), [0, 1]);
  const head = runGit(cwd, ['rev-parse', 'HEAD']);

  // Simulate records written before the testedCommit field existed.
  const cacheDirectory = resolve(
    gitCommonDir(cwd),
    'coordination',
    'test-results',
    context.requirement.id,
  );
  for (const entry of readdirSync(cacheDirectory)) {
    const path = join(cacheDirectory, entry);
    const record = JSON.parse(readFileSync(path, 'utf8'));
    delete record.testedCommit;
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  }

  const second = await run();
  assert.equal(second.evidence.outcome, 'passed');
  assert.deepEqual(
    calls.map(({ index }) => index),
    [0, 1],
    'legacy v1 records without testedCommit must still reuse on the same commit',
  );
  assert.ok(second.evidence.commands.every(({ reused }) => reused === true));
  for (const command of second.evidence.commands) {
    assert.equal(
      command.testedCommit,
      head,
      'a legacy record without testedCommit falls back to the current commit',
    );
  }
});

test('runtime CLI refuses to run required tests after the dev lease expires', async (t) => {
  const context = setupEvidenceFixture(t, { profile: 'runtime', services: 'api' });
  const { store, clock } = await setupCoordinationTesting(context);
  const branch = runGit(context.fixture.clientA, ['branch', '--show-current']);
  const head = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  const session = initializeSession({
    cwd: context.fixture.clientA,
    agent: 'codex',
    user: 'developer',
    host: 'host-a',
    clock,
  });
  await store.update({
    operation: 'prepare expired runtime lease',
    mutate(snapshot) {
      const requirement = snapshot.readJson('requirements/I-057.json');
      snapshot.writeJson('requirements/I-057.json', { ...requirement, branch });
      snapshot.writeJson('deployments/dev.json', runtimeDeploymentRecord(context, {
        branch,
        head,
        sessionId: session.sessionId,
      }));
    },
  });
  await acquireLease({
    store,
    cwd: context.fixture.clientA,
    resource: 'dev',
    requirementId: 'I-057',
    ttl: '90m',
    session,
    clock,
  });
  await store.update({
    operation: 'expire runtime dev lease',
    mutate(snapshot) {
      const lock = snapshot.readJson('locks/dev.json');
      snapshot.writeJson('locks/dev.json', {
        ...lock,
        active: { ...lock.active, expiresAt: '2026-07-16T00:00:00.000Z' },
      });
    },
  });

  const memory = createMemoryIo();
  const exitCode = await main(['test', 'run', 'I-057', '--json'], {
    env: { ...coordinationEnv(context), COORD_SESSION_ID: session.sessionId },
    clock,
    ...memory.io,
  });
  assert.equal(exitCode, 11);
  assert.equal(JSON.parse(memory.stderr.join('')).code, 'LEASE_EXPIRED');
  assert.equal((await store.readSnapshot()).readJson('requirements/I-057.json').lifecycle, 'testing');
});

// I-113 Task 3 (lifecycle slice): the awaiting_human freeze fact is the
// machine verification evidence and survives the original lease TTL by
// design (cross-day human acceptance). Validating test evidence with a
// matching freeze fact must not fail because the consumed lease's expiry
// has passed.
test('runtime evidence stays valid past the lease TTL when a matching freeze fact is supplied', async (t) => {
  const context = setupEvidenceFixture(t, { profile: 'runtime', services: 'api' });
  const { store, clock } = await setupCoordinationTesting(context);
  const branch = runGit(context.fixture.clientA, ['branch', '--show-current']);
  const head = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  const session = initializeSession({
    cwd: context.fixture.clientA,
    agent: 'codex',
    user: 'developer',
    host: 'host-a',
    clock,
  });
  await store.update({
    operation: 'prepare frozen runtime lease',
    mutate(snapshot) {
      const requirement = snapshot.readJson('requirements/I-057.json');
      snapshot.writeJson('requirements/I-057.json', { ...requirement, branch });
      snapshot.writeJson('deployments/dev.json', runtimeDeploymentRecord(context, {
        branch,
        head,
        sessionId: session.sessionId,
      }));
    },
  });
  const acquired = await acquireLease({
    store,
    cwd: context.fixture.clientA,
    resource: 'dev',
    requirementId: 'I-057',
    ttl: '90m',
    session,
    clock,
  });
  // Simulate machine verification completing and the lease converting into a
  // durable freeze fact whose original lease has already expired (the freeze
  // itself has no TTL).
  const entered = await enterFreeze({
    store,
    cwd: context.fixture.clientA,
    resource: 'dev',
    requirementId: 'I-057',
    candidateId: 'candidate-I-057-abc123',
    deploymentSnapshot: runtimeDeploymentRecord(context, {
      branch,
      head,
      sessionId: session.sessionId,
    }),
    machineVerificationEvidence: 'c'.repeat(64),
    session,
    clock,
  });
  assert.equal(entered.state, 'awaiting_human');

  await runRequiredTests({
    cwd: context.fixture.clientA,
    id: 'I-057',
    requirement: context.requirement,
    environment: {
      devLease: acquired,
      devSnapshot: runtimeDeploymentRecord(context, {
        branch,
        head,
        sessionId: session.sessionId,
      }),
      authoritative: true,
    },
    runner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    clock,
  });

  const freeze = (await store.readSnapshot()).readJson('freezes/dev.json');
  const lateClock = () => new Date('2026-07-18T12:00:00.000Z');
  const validation = await validateTestEvidence({
    cwd: context.fixture.clientA,
    id: 'I-057',
    freeze,
    clock: lateClock,
  });
  assert.equal(validation.valid, true);

  // I-128 (M6): the evidence validate CLI must reach the same conclusion now
  // that it forwards the matching freeze fact (previously DEV_LEASE_MISMATCH).
  const validateIo = createMemoryIo();
  const validateExit = await main([
    'evidence', 'validate', 'I-057',
    '--head', 'HEAD',
    '--base', 'origin/main',
    '--json',
  ], {
    env: coordinationEnv(context),
    clock: lateClock,
    ...validateIo.io,
  });
  assert.equal(validateExit, 0, validateIo.stderr.join(''));
  assert.equal(JSON.parse(validateIo.stdout.join('')).data.valid, true);

  // Without the freeze fact the consumed lease is stale: the CLI always
  // passes the asserted lease, and the lease-expiry check must fail closed
  // past the original TTL.
  await assert.rejects(
    validateTestEvidence({
      cwd: context.fixture.clientA,
      id: 'I-057',
      lease: acquired,
      clock: lateClock,
    }),
    (error) => (
      error.code === 'TEST_EVIDENCE_INVALID'
      && error.data.failures.some(({ code }) => code === 'DEV_LEASE_MISMATCH')
    ),
  );
});
