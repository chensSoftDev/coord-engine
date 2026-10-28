import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function createMemoryIo() {
  const stdout = [];
  const stderr = [];

  return {
    stdout,
    stderr,
    io: {
      stdout: { write: (value) => stdout.push(String(value)) },
      stderr: { write: (value) => stderr.push(String(value)) },
    },
  };
}

export function runGit(cwd, args, options = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

function configureGit(cwd) {
  runGit(cwd, ['config', 'user.name', 'Coordination Test']);
  runGit(cwd, ['config', 'user.email', 'coordination-test@example.invalid']);
  runGit(cwd, ['config', 'maintenance.auto', 'false']);
  runGit(cwd, ['config', 'gc.auto', '0']);
}

export async function cleanupFixtureRoot(root, { remove = rmSync } = {}) {
  // B-110：CI runner 上 teardown 时目录可能仍有尾部写入，rm 偶发 ENOTEMPTY。
  // 加长重试 + 兜底轮次；最终失败仅告警——临时目录残留由 runner/OS 回收，不应阻断构建。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      remove(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
      return;
    } catch (error) {
      if (attempt === 2) {
        console.warn(`[coordination-test-fixture] cleanup failed for ${root}: ${error?.message ?? error}`);
        return;
      }
      await new Promise((resolve) => { setTimeout(resolve, 500); });
    }
  }
}

export function createGitFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'luggage-coordination-fixture-'));
  const origin = join(root, 'origin.git');
  const clientA = join(root, 'client-a');
  const clientB = join(root, 'client-b');
  const tempRoot = join(root, 'temps');

  t.after(async () => { await cleanupFixtureRoot(root); });
  mkdirSync(tempRoot, { recursive: true });
  runGit(root, ['init', '--bare', '--initial-branch=main', origin]);
  runGit(root, ['clone', origin, clientA]);
  configureGit(clientA);
  writeFileSync(join(clientA, 'README.md'), '# coordination fixture\n');
  writeFileSync(join(clientA, 'BACKLOG.md'), '| I-001 | fixture |\n');
  writeFileSync(join(clientA, '.gitignore'), '.worktrees/\n');
  runGit(clientA, ['add', 'README.md', 'BACKLOG.md', '.gitignore']);
  runGit(clientA, ['commit', '-m', 'test: seed main']);
  runGit(clientA, ['push', '-u', 'origin', 'main']);
  runGit(root, ['clone', origin, clientB]);
  configureGit(clientB);

  return { root, origin, clientA, clientB, tempRoot };
}
