import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  ensureInitialBacklogRow,
  publishBacklogProjection,
} from '../../lib/coordination/repository-projection.mjs';
import { createGitFixture, runGit } from './fixtures.mjs';

function setupProjectionBranch(t) {
  const fixture = createGitFixture(t);
  const branch = 'feature/v0.2.32/projection';
  runGit(fixture.clientA, ['switch', '-c', branch]);
  runGit(fixture.clientA, ['push', '-u', 'origin', branch]);
  return { fixture, branch };
}

test('initial registration is idempotent and rejects conflicting rows', (t) => {
  const fixture = createGitFixture(t);
  const input = {
    cwd: fixture.clientA,
    id: 'I-002',
    title: 'Projection requirement',
    migration: '待评审',
    status: '⚪ Todo',
    version: 'v0.2.32',
    notes: 'profile=tooling; migration and resources unresolved at Todo',
  };

  assert.equal(ensureInitialBacklogRow(input).changed, true);
  assert.equal(ensureInitialBacklogRow(input).changed, false);
  assert.equal(
    readFileSync(join(fixture.clientA, 'BACKLOG.md'), 'utf8')
      .split('\n').filter((line) => line.startsWith('| I-002 |')).length,
    1,
  );
  assert.throws(
    () => ensureInitialBacklogRow({ ...input, title: 'Conflicting title' }),
    (error) => error.code === 'BACKLOG_PROJECTION_CONFLICT',
  );
});

test('publishes only BACKLOG and is idempotent', (t) => {
  const { fixture, branch } = setupProjectionBranch(t);
  writeFileSync(
    join(fixture.clientA, 'BACKLOG.md'),
    '| I-001 | fixture |\n| I-002 | projection | 否 | ⚪ Todo | v0.2.32 | fixture |\n',
  );
  writeFileSync(join(fixture.clientA, 'OTHER.md'), 'staged\n');
  runGit(fixture.clientA, ['add', 'OTHER.md']);

  const result = publishBacklogProjection({
    cwd: fixture.clientA,
    remote: 'origin',
    branch,
    id: 'I-002',
    message: 'docs(docs): project I-002 status [I-002]',
  });

  assert.equal(result.committed, true);
  assert.equal(result.pushed, true);
  assert.match(runGit(fixture.clientA, ['status', '--short']), /^A  OTHER\.md/m);
  assert.equal(runGit(fixture.clientA, ['show', '--format=', '--name-only', 'HEAD']), 'BACKLOG.md');

  const repeated = publishBacklogProjection({
    cwd: fixture.clientA,
    remote: 'origin',
    branch,
    id: 'I-002',
    message: 'docs(docs): project I-002 status [I-002]',
  });
  assert.equal(repeated.committed, false);
  assert.equal(repeated.head, result.head);
});

test('refuses to publish another requirement row after coordination already changed', (t) => {
  const { fixture, branch } = setupProjectionBranch(t);
  const before = runGit(fixture.clientA, ['rev-parse', 'HEAD']);
  writeFileSync(
    join(fixture.clientA, 'BACKLOG.md'),
    '| I-001 | unrelated concurrent edit |\n| I-002 | projection | 否 | 🔨 In Dev | v0.2.32 | fixture |\n',
  );

  assert.throws(
    () => publishBacklogProjection({
      cwd: fixture.clientA,
      remote: 'origin',
      branch,
      id: 'I-002',
      message: 'docs(docs): project I-002 status [I-002]',
    }),
    (error) => {
      assert.equal(error.code, 'PROJECTION_UNCERTAIN', error.message);
      assert.equal(error.exitCode, 15);
      return true;
    },
  );
  assert.equal(runGit(fixture.clientA, ['rev-parse', 'HEAD']), before);
  assert.equal(runGit(fixture.clientA, ['rev-parse', `origin/${branch}`]), before);
});

test('rejects a diverged remote branch with deterministic recovery actions', (t) => {
  const { fixture, branch } = setupProjectionBranch(t);
  runGit(fixture.clientB, ['fetch', 'origin', branch]);
  runGit(fixture.clientB, ['switch', '-c', branch, '--track', `origin/${branch}`]);
  writeFileSync(join(fixture.clientB, 'REMOTE.md'), 'remote\n');
  runGit(fixture.clientB, ['add', 'REMOTE.md']);
  runGit(fixture.clientB, ['commit', '-m', 'test: remote divergence']);
  runGit(fixture.clientB, ['push', 'origin', branch]);

  writeFileSync(
    join(fixture.clientA, 'BACKLOG.md'),
    '| I-001 | fixture |\n| I-002 | projection | 否 | ⚪ Todo | v0.2.32 | fixture |\n',
  );

  assert.throws(
    () => publishBacklogProjection({
      cwd: fixture.clientA,
      remote: 'origin',
      branch,
      id: 'I-002',
      message: 'docs(docs): project I-002 status [I-002]',
    }),
    (error) => {
      assert.equal(error.code, 'PROJECTION_UNCERTAIN', error.message);
      assert.equal(error.exitCode, 15);
      assert.deepEqual(error.data.requiredActions, [
        `git fetch origin ${branch}`,
        `git rebase origin/${branch}`,
        'pnpm coord reconcile I-002 --json',
      ]);
      return true;
    },
  );
});

test('divergence recovery preserves unrelated staged changes', (t) => {
  const { fixture, branch } = setupProjectionBranch(t);
  runGit(fixture.clientB, ['fetch', 'origin', branch]);
  runGit(fixture.clientB, ['switch', '-c', branch, '--track', `origin/${branch}`]);
  writeFileSync(join(fixture.clientB, 'REMOTE.md'), 'remote\n');
  runGit(fixture.clientB, ['add', 'REMOTE.md']);
  runGit(fixture.clientB, ['commit', '-m', 'test: remote divergence']);
  runGit(fixture.clientB, ['push', 'origin', branch]);
  writeFileSync(
    join(fixture.clientA, 'BACKLOG.md'),
    '| I-001 | fixture |\n| I-002 | projection | 否 | ⚪ Todo | v0.2.32 | fixture |\n',
  );
  writeFileSync(join(fixture.clientA, 'OTHER.md'), 'staged\n');
  runGit(fixture.clientA, ['add', 'OTHER.md']);

  assert.throws(
    () => publishBacklogProjection({
      cwd: fixture.clientA,
      remote: 'origin',
      branch,
      id: 'I-002',
      message: 'docs(docs): project I-002 status [I-002]',
    }),
    (error) => {
      assert.equal(error.code, 'PROJECTION_UNCERTAIN');
      assert.deepEqual(error.data.requiredActions, [
        'git stash push --include-untracked --message coordination-projection-I-002',
        `git fetch origin ${branch}`,
        `git rebase origin/${branch}`,
        'git stash pop --index',
        'pnpm coord reconcile I-002 --json',
      ]);
      return true;
    },
  );
  assert.match(runGit(fixture.clientA, ['status', '--short']), /^A  OTHER\.md/m);
});

test('classifies a concurrent remote advance during push as projection uncertainty', (t) => {
  const { fixture, branch } = setupProjectionBranch(t);
  runGit(fixture.clientB, ['fetch', 'origin', branch]);
  runGit(fixture.clientB, ['switch', '-c', branch, '--track', `origin/${branch}`]);
  writeFileSync(join(fixture.clientB, 'REMOTE.md'), 'racing remote\n');
  runGit(fixture.clientB, ['add', 'REMOTE.md']);
  runGit(fixture.clientB, ['commit', '-m', 'test: race projection push']);

  // I-130 (D5): the projection push carries --no-verify, so a pre-push hook
  // can no longer inject the racing commit. A PATH shim injects it at push
  // time instead — hook-independent — and records the push argv so the
  // --no-verify contract is pinned too.
  const shimDir = join(fixture.root, 'git-shim');
  mkdirSync(shimDir);
  const logPath = join(fixture.root, 'git-argv.log');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  writeFileSync(
    join(shimDir, 'git'),
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> '${logPath}'`,
      'case "$*" in',
      `  *"HEAD:refs/heads/${branch}"*)`,
      `    '${realGit}' -C '${fixture.clientB}' push origin '${branch}' >/dev/null 2>&1 ;;`,
      'esac',
      `exec '${realGit}' "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  const originalPath = process.env.PATH;
  process.env.PATH = `${shimDir}:${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; });
  writeFileSync(
    join(fixture.clientA, 'BACKLOG.md'),
    '| I-001 | fixture |\n| I-002 | projection | 否 | ⚪ Todo | v0.2.32 | fixture |\n',
  );

  assert.throws(
    () => publishBacklogProjection({
      cwd: fixture.clientA,
      remote: 'origin',
      branch,
      id: 'I-002',
      message: 'docs(docs): project I-002 status [I-002]',
    }),
    (error) => {
      assert.equal(error.code, 'PROJECTION_UNCERTAIN', error.message);
      assert.equal(error.exitCode, 15);
      assert.deepEqual(error.data.requiredActions, [
        `git fetch origin ${branch}`,
        `git rebase origin/${branch}`,
        'pnpm coord reconcile I-002 --json',
      ]);
      return true;
    },
  );
  const pushes = readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('push '));
  assert.equal(pushes.length, 1);
  assert.match(pushes[0], /^push --no-verify --set-upstream origin /);
});

test('classifies an unprovable post-mutation remote failure as projection uncertainty', (t) => {
  const { fixture, branch } = setupProjectionBranch(t);
  writeFileSync(
    join(fixture.clientA, 'BACKLOG.md'),
    '| I-001 | fixture |\n| I-002 | projection | 否 | ⚪ Todo | v0.2.32 | fixture |\n',
  );

  assert.throws(
    () => publishBacklogProjection({
      cwd: fixture.clientA,
      remote: 'missing-remote',
      branch,
      id: 'I-002',
      message: 'docs(docs): project I-002 status [I-002]',
    }),
    (error) => error.code === 'PROJECTION_UNCERTAIN' && error.exitCode === 15,
  );
});
