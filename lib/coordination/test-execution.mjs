import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function canonicalCheck(argv) {
  const args = [...argv];
  if (args[0] === 'pnpm' && args[1] === 'run') args.splice(1, 1);
  return args;
}
const LOCAL = new Set(['lint', 'test', 'test:admin', 'build', 'test:coordination']);
export function localCheck(argv) {
  const args = canonicalCheck(argv);
  return args.length === 2 && args[0] === 'pnpm' && LOCAL.has(args[1]);
}
export function checkEnvironmentIdentity(argv, environment) {
  if (localCheck(argv)) return null;
  if (!environment || environment.kind === 'local') return null;
  const { devLease: _permission, ...identity } = environment;
  return identity;
}
export function commandExecutionEnvironment({ argv, requirement, profile, environment, env = process.env }) {
  const result = { ...env, GIT_TERMINAL_PROMPT: '0' };
  if (localCheck(argv)) return result;
  if (requirement.acceptanceWorkflowVersion === 1 && profile === 'runtime') {
    Object.assign(result, { E2E_EXPECTATIONS_REQUIRED: '1', REQUIREMENT_ID: requirement.id });
  }
  if (environment.kind === 'mixed-dev') Object.assign(result, {
    API_BASE_URL: 'https://api-dev.hongli-ruian.com/api',
    [environment.mixedEnvironment.frontend.app === 'admin' ? 'ADMIN_BASE_URL' : 'E2E_BASE_URL']: environment.mixedEnvironment.frontend.baseUrl,
    E2E_DEVELOPMENT_ITERATION: '0', E2E_LOCAL_PRODUCTS_FIXTURE: '0', E2E_MIXED_DEV: '1', REQUIREMENT_ID: requirement.id,
  });
  return result;
}

export function classifyTestFailure({ exitCode, stdout = '', stderr = '' }) {
  if (exitCode === 0) return { kind: 'passed', retryable: false, recovery: null };
  const output = `${stdout}\n${stderr}`;
  const match = (kind, pattern, recovery) => pattern.test(output) ? { kind, retryable: false, recovery } : null;
  // Suite logs can include expected schema/network errors from passing tests.
  // An explicit failed assertion must not become a recoverable prerequisite
  // merely because one of those unrelated messages occurs earlier in output.
  return match('product', /AssertionError|ERR_ASSERTION/, '按实际失败修复实现或测试预期，并执行受影响验证')
    ?? match('schema', /ER_NO_SUCH_TABLE|Table .+doesn't exist|Unknown column|migration.+(?:missing|mismatch)/i, '核对schema/migration与候选兼容，修复后先跑canary')
    ?? match('readiness', /command not found|Cannot find (?:module|package)|ENOENT|ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND|EACCES|permission denied|Access denied for user/i, '修复依赖、权限或运行条件，预检通过后恢复测试')
    ?? match('fixture', /(?:fixture|cleanup|seed).+(?:failed|missing|error|invalid)/i, '修复本次run的造数/清理并验证残留')
    ?? match('product', /AssertionError|AssertionError\[|expected .+(?:got|received)|FAIL\s+.+(?:test|spec)|Tests\s+\d+ failed/i, '按实际失败修复实现或测试预期，并执行受影响验证')
    ?? match('interrupted', /SIGTERM|SIGINT|aborted|cancelled/i, '确认该run进程已退出，保留日志后恢复')
    ?? (/ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|HTTP 50[234]/i.test(output)
      ? { kind: 'network', retryable: true, recovery: '检查连接；允许本命令一次重试，成功仍记录flaky' }
      : { kind: 'unknown', retryable: false, recovery: '保留首个失败信号并诊断；不能推定是环境故障' });
}
export function commandResources(argv) {
  const args = canonicalCheck(argv);
  if (args[0] === 'bash' && args.length === 2 && ['scripts/test-release-flow.sh', 'scripts/test-release-services.sh'].includes(args[1])) return { slots: 1, exclusive: false };
  // Nested worker pools and unknown wrappers can saturate memory or mutate a
  // shared service. Explicit parallel syntax is a request, not a safety proof.
  return { slots: 2, exclusive: true };
}
export function executionBatches(commands, { budget = 2, resources = commandResources } = {}) {
  const limit = Number.isSafeInteger(budget) && budget > 0 ? budget : 1;
  const batches = []; let batch = []; let used = 0;
  const flush = () => { if (batch.length) batches.push(batch); batch = []; used = 0; };
  for (const argv of commands) {
    const item = resources(argv);
    if (item.exclusive || !Number.isSafeInteger(item.slots) || item.slots < 1) { flush(); batches.push([argv]); continue; }
    if (used + item.slots > limit) flush();
    batch.push(argv); used += item.slots;
  }
  flush(); return batches;
}

export function inspectTestPrerequisites({ cwd, commands }) {
  const missing = [];
  if (commands.some(argv => argv[0] === 'pnpm')) {
    if (!existsSync(join(cwd, 'node_modules'))) missing.push({ code: 'DEPENDENCIES_MISSING', recovery: 'pnpm install --frozen-lockfile' });
    const pnpm = spawnSync('pnpm', ['--version'], { cwd, encoding: 'utf8', timeout: 10_000 });
    if (pnpm.status !== 0) missing.push({ code: 'PACKAGE_MANAGER_UNAVAILABLE', recovery: '检查packageManager与pnpm可执行文件' });
  }
  return { ok: missing.length === 0, missing };
}
