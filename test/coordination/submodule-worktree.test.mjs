import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ensureSubmodulesInitialized } from '../../lib/coordination/worktrees.mjs';
import { cleanupFixtureRoot, runGit } from './fixtures.mjs';

// I-249: 引擎以 .coord-engine submodule 挂载后，worktree 必须自动 init
// submodule，否则 worktree 内的 pnpm coord 入口不可用。
function configureFixtureGit(cwd) {
  runGit(cwd, ['config', 'user.name', 'Coordination Test']);
  runGit(cwd, ['config', 'user.email', 'coordination-test@example.invalid']);
  runGit(cwd, ['config', 'maintenance.auto', 'false']);
  runGit(cwd, ['config', 'gc.auto', '0']);
  // git 自 CVE-2022-39253 修复后默认禁止 file transport，本地 fixture 的
  // submodule clone 需要显式放行。
  runGit(cwd, ['config', 'protocol.file.allow', 'always']);
}

test('ensureSubmodulesInitialized is a no-op without .gitmodules', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'coord-submodule-noop-'));
  t.after(async () => { await cleanupFixtureRoot(root); });

  const repo = join(root, 'plain');
  mkdirSync(repo, { recursive: true });
  runGit(repo, ['init', '--initial-branch=main']);
  configureFixtureGit(repo);
  writeFileSync(join(repo, 'BACKLOG.md'), '| I-001 | fixture |\n');
  runGit(repo, ['add', 'BACKLOG.md']);
  runGit(repo, ['commit', '-m', 'seed']);
  assert.equal(existsSync(join(repo, '.gitmodules')), false);
  ensureSubmodulesInitialized(repo);
});

test('ensureSubmodulesInitialized checks out submodules inside a linked worktree', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'coord-submodule-worktree-'));
  t.after(async () => { await cleanupFixtureRoot(root); });

  const inner = join(root, 'inner');
  const outer = join(root, 'outer');
  const worktree = join(root, 'feature-wt');
  mkdirSync(inner, { recursive: true });
  mkdirSync(outer, { recursive: true });

  runGit(inner, ['init', '--initial-branch=main']);
  configureFixtureGit(inner);
  writeFileSync(join(inner, 'payload.txt'), 'inner module\n');
  runGit(inner, ['add', 'payload.txt']);
  runGit(inner, ['commit', '-m', 'inner seed']);

  runGit(outer, ['init', '--initial-branch=main']);
  configureFixtureGit(outer);
  writeFileSync(join(outer, 'BACKLOG.md'), '| I-001 | fixture |\n');
  runGit(outer, ['add', 'BACKLOG.md']);
  runGit(outer, ['commit', '-m', 'outer seed']);
  // protocol.file.allow 必须内联 -c：submodule--helper 的 clone 子进程不读仓库级配置。
  runGit(outer, ['-c', 'protocol.file.allow=always', 'submodule', 'add', inner, 'inner']);
  runGit(outer, ['commit', '-m', 'add submodule']);

  runGit(outer, ['worktree', 'add', '-b', 'feature/v0/test', worktree]);
  assert.equal(existsSync(join(worktree, 'inner', 'payload.txt')), false);

  // 通过 git 的 env-config 注入 file transport 放行：引擎的 runGit 继承
  // process.env，不污染全局配置也不弱化引擎实现。
  const saved = { ...process.env };
  process.env.GIT_CONFIG_COUNT = '1';
  process.env.GIT_CONFIG_KEY_0 = 'protocol.file.allow';
  process.env.GIT_CONFIG_VALUE_0 = 'always';
  try {
    ensureSubmodulesInitialized(worktree);
    assert.equal(existsSync(join(worktree, 'inner', 'payload.txt')), true);

    // 幂等：重复 init 不报错、不改变结果。
    ensureSubmodulesInitialized(worktree);
    assert.equal(existsSync(join(worktree, 'inner', 'payload.txt')), true);
  } finally {
    for (const key of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) {
      if (key in saved) process.env[key] = saved[key];
      else delete process.env[key];
    }
  }
});
