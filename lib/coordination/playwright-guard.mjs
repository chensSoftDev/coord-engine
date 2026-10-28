import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { managedFrontendRegistration } from './mixed-environments.mjs';

// Successful guard resolutions are cached per process, keyed by the full resolution
// input (requirement, session, ticket, stage, target host, branch, commit, repo root).
// A new process always re-reads live coordination state; a required assertion is cached
// at most until its lease expires; failures are never cached. There is deliberately no
// environment-variable bypass.
const DEFAULT_CACHE = new Map();

// B-248: required assertions are additionally capped by this window so a dev
// freeze that enters while the Playwright process is alive is noticed within
// a bounded delay (the next cache miss re-runs the CLI, which rejects with
// FREEZE_ACTIVE) instead of at process exit.
const FREEZE_RECHECK_WINDOW_MS = 60_000;

function defaultRunner({ args, cwd, env }) {
  return spawnSync(process.execPath, args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function resolveGitRevision({ cwd }) {
  const options = { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
  const branch = spawnSync('git', ['branch', '--show-current'], options);
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], options);
  if (branch.error || branch.status !== 0 || commit.error || commit.status !== 0) return null;
  return { branch: branch.stdout.trim(), commit: commit.stdout.trim() };
}

function cacheKey({ target, requirementId, env, rootDir, revision }) {
  if (!revision?.commit) return null;
  let url;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  return JSON.stringify([
    requirementId ?? '',
    env.COORD_SESSION_ID ?? '',
    env.COORD_GUARD_TICKET ?? '',
    'auto',
    `${url.protocol}//${url.host}`,
    revision.branch ?? '',
    revision.commit,
    rootDir,
  ]);
}

export function guardPlaywrightTarget({
  target,
  requirementId = process.env.REQUIREMENT_ID,
  env = process.env,
  rootDir,
  cache = DEFAULT_CACHE,
  clock = () => new Date(),
  runner = defaultRunner,
  resolveRevision = resolveGitRevision,
} = {}) {
  // 不能用 import.meta.url 推导本文件位置：Playwright 会把 .mjs 转译成 CJS，
  // import.meta 会在运行期抛 SyntaxError。root 由调用方显式传入，
  // 其次取 COORD_ROOT_DIR，最后回退 process.cwd()（node 侧测试从仓库根运行）。
  const ROOT_DIR = rootDir || process.env.COORD_ROOT_DIR || process.cwd();
  const managed = managedFrontendRegistration({ cwd: ROOT_DIR, baseUrl: target });
  if (managed) target = managed.apiTarget;
  const key = cacheKey({
    target,
    requirementId,
    env,
    rootDir: ROOT_DIR,
    revision: resolveRevision({ cwd: ROOT_DIR }),
  });
  if (key && cache.has(key)) {
    const entry = cache.get(key);
    if (entry.expiresAtMs === null || clock().getTime() <= entry.expiresAtMs) {
      if (entry.required) process.stdout.write(`[coord-guard] ${entry.message}\n`);
      return;
    }
    cache.delete(key);
  }

  const COORDINATION_SCRIPT = resolve(ROOT_DIR, 'scripts/coordination.mjs');
  const args = [
    COORDINATION_SCRIPT,
    'guard', 'shared-env',
    '--stage', 'auto',
    '--target', target,
    '--commit', 'HEAD',
    '--json',
  ];
  if (requirementId) args.push('--requirement', requirementId);
  const result = runner({ args, cwd: ROOT_DIR, env });
  if (result.error || result.status !== 0) {
    const detail = result.stderr?.trim() || result.error?.message || `exit ${result.status}`;
    throw new Error(`Playwright shared-environment guard failed: ${detail}`);
  }
  const document = JSON.parse(result.stdout);
  const required = Boolean(document.data.required);
  if (required) process.stdout.write(`[coord-guard] ${document.message}\n`);

  if (!key) return;
  if (!required) {
    // Pure policy classification of a local/third-party target: no coordination state
    // is involved, so the result stays valid for the rest of the process.
    cache.set(key, { required, message: document.message ?? '', expiresAtMs: null });
    return;
  }
  const leaseExpiryMs = Date.parse(document.data?.assertion?.expiresAt ?? '');
  if (Number.isFinite(leaseExpiryMs)) {
    cache.set(key, {
      required,
      message: document.message ?? '',
      expiresAtMs: Math.min(leaseExpiryMs, clock().getTime() + FREEZE_RECHECK_WINDOW_MS),
    });
  }
  // A required assertion without a parseable lease expiry is never cached.
}
