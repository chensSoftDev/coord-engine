import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { canonicalCheck, localCheck } from './test-execution.mjs';

const stable = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const hash = value => createHash('sha256').update(value).digest('hex');
const digest = /^[a-f0-9]{64}$/;

// I-276: a check result depends on the code, its dependencies and the switches
// that code or its toolchain reads, not on who runs it. Only variables named in
// the checked repository's source or owned by the toolchain take part, so a new
// agent session, sub-agent, worktree or host upgrade reuses an identical result
// while a changed application, compiler or tool switch still runs again.
// pnpm's reporter/loglevel only change how pnpm prints (`pnpm -s` sets the
// silent reporter); without this, formal Testing and pre-push never share.
const INVOCATION_METADATA = new Set(['PWD', 'OLDPWD', 'SHLVL', '_', 'INIT_CWD',
  'npm_lifecycle_event', 'npm_lifecycle_script', 'npm_command', 'npm_execpath', 'npm_node_execpath',
  'npm_package_json', 'npm_package_name', 'npm_package_version', 'npm_config_reporter', 'npm_config_loglevel',
  'CODEX_TOOL_CALL_ID', 'COORD_SESSION_ID', 'TMPDIR']);
const TOOLCHAIN_VARIABLE = new RegExp('^(?:CI|TZ|LANG|LC_\\w+|PATH|npm_config_\\w+|BROWSERSLIST\\w*'
  + '|(?:NODE|NPM|PNPM|GIT|NEXT|VITE|VITEST|JEST|ESLINT|TS_NODE|BABEL|PLAYWRIGHT)_\\w+'
  + '|CC|CXX|CPP|CPATH|C_INCLUDE_PATH|CPLUS_INCLUDE_PATH|LIBRARY_PATH|LD_LIBRARY_PATH|DYLD_\\w+'
  + '|SDKROOT|DEVELOPER_DIR|MACOSX_DEPLOYMENT_TARGET|PKG_CONFIG_PATH|\\w*FLAGS)$');
const SOURCE_FILES = ['*.js', '*.cjs', '*.mjs', '*.jsx', '*.ts', '*.cts', '*.mts', '*.tsx', '*.sh', '*.bash'];
// process.env / import.meta.env / an env object, Nest ConfigService get('NAME')
// and shell $NAME / ${NAME}; a matching non-environment name is harmless.
const ENVIRONMENT_REFERENCE = String.raw`process\.env\.[A-Za-z_][A-Za-z0-9_]*|process\.env\[['"][A-Za-z_][A-Za-z0-9_]*['"]\]`
  + String.raw`|import\.meta\.env\.[A-Za-z_][A-Za-z0-9_]*|env\.[A-Z][A-Z0-9_]*|env\[['"][A-Z][A-Z0-9_]*['"]\]`
  + String.raw`|get(OrThrow)?(<[^>]*>)?\(['"][A-Z][A-Z0-9_]*['"]|\$\{?[A-Z_][A-Z0-9_]*`;
const REPOSITORY_LOCATORS = new Set(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_QUARANTINE_PATH', 'GIT_IMPLICIT_WORK_TREE', 'GIT_PREFIX',
  'GIT_INTERNAL_SUPER_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE', 'GIT_REPLACE_REF_BASE']);
export const COORD_ENGINE_PATH = '.coord-engine';
const referencedNames = new Map();

function sourceEnvironment() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !REPOSITORY_LOCATORS.has(key)));
  return { ...env, GIT_NO_REPLACE_OBJECTS: '1' };
}

function checkoutError(reason) {
  return Object.assign(new Error(`Coordination engine ${reason}. Restore the committed checkout at ${COORD_ENGINE_PATH} and retry.`), {
    code: 'COORD_ENGINE_CHECKOUT_INVALID', exitCode: 14,
  });
}

function enginePin(cwd, commit, env) {
  const result = spawnSync('git', ['ls-tree', '--full-tree', commit, '--', COORD_ENGINE_PATH], { cwd, env, encoding: 'utf8' });
  if (result.status !== 0) throw checkoutError('pin could not be read');
  if (!result.stdout.trim()) return null;
  const pin = /^160000 commit ([0-9a-f]{40})\t\.coord-engine\n?$/.exec(result.stdout)?.[1];
  if (!pin) throw checkoutError('path is not a committed submodule');
  return pin;
}

export function assertCoordEngineCheckout({ cwd, commit = 'HEAD' }) {
  const env = sourceEnvironment();
  const pin = enginePin(cwd, commit, env);
  if (!pin) return null;
  const engine = join(realpathSync(cwd), COORD_ENGINE_PATH);
  if (!existsSync(engine) || !lstatSync(engine).isDirectory()) throw checkoutError('checkout is missing');
  const location = spawnSync('git', ['rev-parse', '--show-toplevel', 'HEAD'], { cwd: engine, env, encoding: 'utf8' });
  const [root, head] = location.stdout?.trimEnd().split('\n') ?? [];
  if (location.status !== 0 || root !== engine) throw checkoutError('checkout is missing');
  if (head !== pin) throw checkoutError('checkout does not match the committed pin');
  const status = spawnSync('git', ['-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '--untracked-files=all',
    '--ignore-submodules=none'], { cwd: engine, env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (status.status !== 0 || status.stdout.trim()) throw checkoutError('checkout has uncommitted changes');
  return pin;
}

export function coordEngineCheckoutMatches({ cwd, commit, expected }) {
  try {
    return assertCoordEngineCheckout({ cwd, commit }) === expected;
  } catch (error) {
    if (error.code !== 'COORD_ENGINE_CHECKOUT_INVALID') throw error;
    return false;
  }
}

// Environment names the committed source reads. null means the scan failed and
// every non-metadata variable stays significant, so a failure can only re-run.
export function referencedEnvironmentNames(cwd = process.cwd(), { coordEngineCommit } = {}) {
  const env = sourceEnvironment();
  const head = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD^{tree}'], { cwd, env, encoding: 'utf8' });
  if (head.status !== 0) return null;
  const tree = head.stdout.trim();
  const key = `${resolve(cwd)}\0${tree}`;
  if (!referencedNames.has(key)) {
    let pin;
    try { pin = coordEngineCommit === undefined ? enginePin(cwd, tree, env) : coordEngineCommit; } catch { return null; }
    const sources = [[cwd, tree]];
    if (pin) sources.push([join(cwd, COORD_ENGINE_PATH), pin]);
    const names = new Set();
    for (const [source, ref] of sources) {
      const found = spawnSync('git', ['grep', '-h', '-o', '-I', '-E', ENVIRONMENT_REFERENCE, ref, '--', ...SOURCE_FILES],
        { cwd: source, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      if (found.status !== 0 && found.status !== 1) return null;
      for (const match of found.stdout.split('\n')) {
        const name = /([A-Za-z_][A-Za-z0-9_]*)['"]?\]?$/.exec(match)?.[1];
        if (name) names.add(name);
      }
    }
    referencedNames.set(key, names);
  }
  return referencedNames.get(key);
}

export function verificationEnvironmentFingerprint(env = process.env, { cwd = process.cwd(), coordEngineCommit } = {}) {
  const names = referencedEnvironmentNames(cwd, { coordEngineCommit });
  // The same checkout under another worktree path is the same input.
  const roots = [...new Set([resolve(cwd), realpathSync(cwd)])].sort((left, right) => right.length - left.length);
  const location = value => roots.reduce((text, root) => text.split(root).join('<worktree>'), value);
  const effective = { ...env, GIT_TERMINAL_PROMPT: '0' };
  return hash(stable(Object.fromEntries(Object.entries(effective)
    .filter(([key]) => !INVOCATION_METADATA.has(key) && (!names || names.has(key) || TOOLCHAIN_VARIABLE.test(key)))
    .map(([key, value]) => [key, location(value)]))));
}

// pnpm rewrites prunedAt on every install; it records when, not what, was installed.
const installState = text => text.split('\n').filter(line => !/^\s*"?prunedAt"?\s*:/.test(line)).join('\n');

export function verificationToolchain({ cwd, env = process.env, coordEngineCommit = assertCoordEngineCheckout({ cwd }) }) {
  const pnpm = spawnSync('pnpm', ['--version'], { cwd, env, encoding: 'utf8', timeout: 10_000 });
  const files = [];
  const roots = [cwd, ...['web', 'admin', 'api', 'account-api', 'gateway-api'].map(app => join(cwd, 'apps', app))];
  for (const root of roots) if (existsSync(root)) {
    for (const file of readdirSync(root).filter(name => /^\.env(?:\.|$)/.test(name))) {
      const path = join(root, file);
      const stat = lstatSync(path);
      if (stat.isFile() || stat.isSymbolicLink()) files.push([relative(cwd, path), hash(readFileSync(path))]);
    }
  }
  const modules = join(cwd, 'node_modules/.modules.yaml');
  if (existsSync(modules)) files.push(['node_modules/.modules.yaml', hash(installState(readFileSync(modules, 'utf8')))]);
  // Values may contain credentials; persist only their digest, never values.
  return { executionPolicyVersion: 5, node: process.version, platform: process.platform, arch: process.arch,
    pnpm: pnpm.status === 0 ? pnpm.stdout.trim() : null, environmentSha256: verificationEnvironmentFingerprint(env, { cwd, coordEngineCommit }),
    ...(coordEngineCommit ? { coordEngineCommit } : {}), files };
}

export function receiptIdentity({ argv, input, toolchain }) {
  if (!localCheck(argv) || !input?.declared || ![input.inputsSha256, input.lockfilesSha256, input.declaration?.sha256].every(value => digest.test(value ?? ''))) return null;
  const identity = { schemaVersion: 1, argv: canonicalCheck(argv), inputsSha256: input.inputsSha256,
    lockfilesSha256: input.lockfilesSha256, declarationSha256: input.declaration.sha256, toolchain };
  return { ...identity, key: hash(stable(identity)) };
}
function logFile(commonDirectory, path) {
  if (typeof path !== 'string' || !/^coordination\/(?:test-logs|check-logs)\//.test(path) || path.split('/').includes('..')) return null;
  const root = realpathSync(commonDirectory);
  const absolute = resolve(commonDirectory, path);
  if (!existsSync(absolute) || !lstatSync(absolute).isFile() || lstatSync(absolute).isSymbolicLink()) return null;
  const resolved = realpathSync(absolute);
  return resolved.startsWith(`${root}${sep}`) ? resolved : null;
}
export function readCheckReceipt({ commonDirectory, identity }) {
  if (!identity) return null;
  try {
    const record = JSON.parse(readFileSync(join(commonDirectory, 'coordination/check-receipts', `${identity.key}.json`), 'utf8'));
    const log = logFile(commonDirectory, record.result?.logPath);
    if (record.schemaVersion !== 1 || record.key !== identity.key || stable(record.identity) !== stable(identity)
      || record.result?.outcome !== 'passed' || record.result.exitCode !== 0 || !log || hash(readFileSync(log)) !== record.logSha256) return null;
    return record;
  } catch { return null; }
}
export function writeCheckReceipt({ commonDirectory, identity, result, testedCommit }) {
  if (!identity || result.outcome !== 'passed' || result.exitCode !== 0) return;
  try {
    const log = logFile(commonDirectory, result.logPath);
    if (!log) return;
    const directory = join(commonDirectory, 'coordination/check-receipts');
    mkdirSync(directory, { recursive: true });
    const file = join(directory, `${identity.key}.json`);
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, key: identity.key, identity, testedCommit,
      result, logSha256: hash(readFileSync(log)), recordedAt: new Date().toISOString() }), { mode: 0o600 });
    renameSync(temporary, file);
  } catch { /* receipt persistence is optional; execution result remains real */ }
}
