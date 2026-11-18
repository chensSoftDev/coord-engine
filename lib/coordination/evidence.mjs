import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import { assertDeliveryProfile, assertRequirementId, assertVersion } from './validation.mjs';
import { loadSharedEnvironmentPolicy } from './guard.mjs';
import { revisionMatchesDeployment } from './leases.mjs';
import {
  REVISION_POLICY_VERSION,
  acceptanceCommandsSha256,
  classifyRevisionRange,
} from './revision-policy.mjs';
import { gitCommonDir } from './worktrees.mjs';
import { MIXED_API_TARGET, validateMixedEnvironment } from './mixed-environments.mjs';
import { canonicalCheck, commandExecutionEnvironment, checkEnvironmentIdentity, classifyTestFailure, commandResources, executionBatches, inspectTestPrerequisites, localCheck } from './test-execution.mjs';
import {
  COORD_ENGINE_PATH,
  assertCoordEngineCheckout,
  coordEngineCheckoutMatches,
  readCheckReceipt,
  receiptIdentity,
  verificationEnvironmentFingerprint,
  verificationToolchain,
  writeCheckReceipt,
} from './check-receipts.mjs';
import { gitExecutionEnvironment } from './git-execution-env.mjs';

const SUMMARY_LIMIT = 2_000;
const MAX_COMMAND_OUTPUT = 10 * 1024 * 1024;
const SERVICE_BY_PATH = Object.freeze({
  'apps/account-api/': 'account',
  'apps/api/': 'api',
  'apps/gateway-api/': 'gateway',
  'apps/web/': 'web',
  'apps/admin/': 'admin',
});

export class EvidenceError extends Error {
  constructor(message, { code, exitCode = 14, data = {}, cause } = {}) {
    super(message, { cause });
    this.name = 'EvidenceError';
    this.code = code;
    this.exitCode = exitCode;
    this.data = data;
  }
}

function validId(id) {
  try {
    return assertRequirementId(id);
  } catch (error) {
    throw new EvidenceError(error.message, { code: 'INVALID_REQUIREMENT_ID', cause: error });
  }
}

function validVersion(version) {
  try {
    return assertVersion(version);
  } catch (error) {
    throw new EvidenceError(error.message, { code: 'INVALID_VERSION', cause: error });
  }
}

function validProfile(profile) {
  try {
    return assertDeliveryProfile(profile);
  } catch (error) {
    throw new EvidenceError(error.message, {
      code: 'INVALID_DELIVERY_PROFILE',
      cause: error,
    });
  }
}

function requirementDirectory({ cwd, id }) {
  const safeId = validId(id);
  const current = resolve(cwd, 'docs', 'product', 'current');
  const matches = existsSync(current)
    ? readdirSync(current, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${safeId}-`))
    : [];
  if (matches.length !== 1) {
    throw new EvidenceError(
      matches.length === 0
        ? `requirement document directory is missing for ${safeId}`
        : `multiple requirement document directories found for ${safeId}`,
      { code: 'REQUIREMENT_DOCUMENTS_NOT_FOUND' },
    );
  }
  return resolve(current, matches[0].name);
}

export function evidencePath({ cwd, id }) {
  return resolve(requirementDirectory({ cwd, id }), 'TEST_EVIDENCE.json');
}

function unsafeCommand(message) {
  return new EvidenceError(message, { code: 'UNSAFE_TEST_COMMAND' });
}

function tokenizePlainCommand(line) {
  if (/[;$`|&<>\r\n]/.test(line)) {
    throw unsafeCommand(`shell syntax is forbidden in required test command: ${line}`);
  }
  const argv = [];
  let token = '';
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote) {
      if (character === quote) quote = null;
      else token += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (token) {
        argv.push(token);
        token = '';
      }
      continue;
    }
    if (character === '\\') {
      throw unsafeCommand('backslash escaping is forbidden; use a JSON argv array');
    }
    token += character;
  }
  if (quote) throw unsafeCommand('unterminated quote in required test command');
  if (token) argv.push(token);
  if (argv.length === 0) throw unsafeCommand('required test command cannot be empty');
  return argv;
}

function pathWithin(root, target) {
  const path = relative(root, target);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function safeScriptPath(cwd, value, extensions) {
  if (typeof value !== 'string' || value.startsWith('-')) {
    throw unsafeCommand('test script path is required');
  }
  const scriptsRoot = realpathSync(resolve(cwd, 'scripts'));
  const candidate = resolve(cwd, value);
  if (!existsSync(candidate)) throw unsafeCommand(`test script does not exist: ${value}`);
  const realCandidate = realpathSync(candidate);
  if (!pathWithin(scriptsRoot, realCandidate)) {
    throw unsafeCommand(`test script must remain under scripts/: ${value}`);
  }
  if (!extensions.some((extension) => realCandidate.endsWith(extension))) {
    throw unsafeCommand(`unsupported test script type: ${value}`);
  }
}

function validateArgv(argv, cwd) {
  if (!Array.isArray(argv) || argv.length < 2 || argv.some((item) => (
    typeof item !== 'string' || item.length === 0 || /[\r\n\0]/.test(item)
  ))) {
    throw unsafeCommand('required test command must be a non-empty string argv array');
  }
  const [executable, firstArgument] = argv;
  if (executable === 'pnpm') {
    if (firstArgument.startsWith('-') || ['exec', 'dlx', 'run'].includes(firstArgument)) {
      throw unsafeCommand('pnpm required tests must name a root package script directly');
    }
    const packageJson = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8'));
    if (!Object.hasOwn(packageJson.scripts ?? {}, firstArgument)) {
      throw unsafeCommand(`pnpm script is not declared in package.json: ${firstArgument}`);
    }
    return;
  }
  if (executable === 'node') {
    safeScriptPath(cwd, firstArgument, ['.js', '.mjs', '.cjs']);
    return;
  }
  if (executable === 'bash') {
    safeScriptPath(cwd, firstArgument, ['.sh']);
    return;
  }
  throw unsafeCommand(`executable is not allowed for required tests: ${executable}`);
}

// I-262: E2E commands bind the shared dev lease, the local Playwright run and
// fixed stack ports; overlapping them with anything else is never sound, so a
// parallel group that names one is rejected fail-closed instead of trusted to
// the ACCEPTANCE author. Rejected forms are the pnpm `e2e` root script name
// and the direct `node scripts/local-e2e.mjs` form validateArgv allows; the
// retired `test:e2e:local` spelling was removed by I-269 (it now fails closed
// one layer earlier as an undeclared pnpm script).
const PARALLEL_FORBIDDEN_PNPM_SCRIPTS = new Set(['e2e']);

function isE2eLikeArgv(argv) {
  if (argv[0] === 'pnpm' && PARALLEL_FORBIDDEN_PNPM_SCRIPTS.has(argv[1] ?? '')) {
    return true;
  }
  return argv[0] === 'node' && /(^|\/)local-e2e\.mjs$/.test(argv[1] ?? '');
}

// I-262: one block line is either a plain command (serial singleton group) or
// a JSON array of argv arrays — a parallel group whose commands have no
// ordering dependency and run concurrently. The flat command list consumers
// rely on is unchanged; parseAcceptanceCommands flattens the groups.
export function parseAcceptanceGroups(source, { cwd }) {
  if (typeof source !== 'string') {
    throw new EvidenceError('ACCEPTANCE.md must be text', { code: 'INVALID_ACCEPTANCE' });
  }
  const blocks = [...source.matchAll(/```coord-required[ \t]*\r?\n([\s\S]*?)```/g)];
  if (blocks.length !== 1) {
    throw new EvidenceError('ACCEPTANCE.md must contain exactly one coord-required block', {
      code: 'INVALID_ACCEPTANCE',
    });
  }
  const lines = blocks[0][1].split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) {
    throw new EvidenceError('coord-required block cannot be empty', {
      code: 'INVALID_ACCEPTANCE',
    });
  }
  return lines.map((line) => {
    if (!line.startsWith('[')) {
      const argv = tokenizePlainCommand(line);
      validateArgv(argv, cwd);
      return { parallel: false, commands: [argv] };
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new EvidenceError('invalid JSON argv in coord-required block', {
        code: 'INVALID_ACCEPTANCE',
        cause: error,
      });
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      validateArgv(parsed, cwd);
      return { parallel: false, commands: [parsed] };
    }
    if (parsed.some((item) => Array.isArray(item))) {
      if (!parsed.every((item) => Array.isArray(item))) {
        throw unsafeCommand(
          'parallel group must be a JSON array of argv arrays; mixing arrays and plain tokens is ambiguous',
        );
      }
      if (parsed.length < 2) {
        throw unsafeCommand(
          'parallel group must declare at least two commands; write a plain command line for one',
        );
      }
      const commands = parsed.map((argv) => {
        validateArgv(argv, cwd);
        if (isE2eLikeArgv(argv)) {
          throw unsafeCommand(
            `E2E commands depend on the shared dev lease and local Playwright/ports and must stay serial: ${JSON.stringify(argv)}`,
          );
        }
        return argv;
      });
      return { parallel: true, commands };
    }
    validateArgv(parsed, cwd);
    return { parallel: false, commands: [parsed] };
  });
}

export function parseAcceptanceCommands(source, { cwd }) {
  return parseAcceptanceGroups(source, { cwd }).flatMap((group) => group.commands);
}

export function runGit(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: MAX_COMMAND_OUTPUT,
  });
  if (result.error || result.status !== 0) {
    const message = result.stderr || result.error?.message || 'git command failed';
    throw new EvidenceError(`git ${args.join(' ')} failed: ${message.trim()}`, {
      code: 'GIT_EVIDENCE_ERROR',
      exitCode: 13,
    });
  }
  return result.stdout.trim();
}

// I-134 (dogfood fix): tolerate blank and comment lines — the I-132
// `manifest init` generator renders the annotated _example.env template,
// so coord's own evidence parser must accept the file coord produces
// (deployments.parseEnv and gate.manifestFields already skip comments).
export function parseManifest(source) {
  return Object.fromEntries(source.split(/\r?\n/).map((line) => line.trim()).filter((line) => (
    line !== '' && !line.startsWith('#')
  )).map((line) => {
    const index = line.indexOf('=');
    if (index < 1) {
      throw new EvidenceError('invalid release manifest line', {
        code: 'INVALID_RELEASE_MANIFEST',
      });
    }
    return [line.slice(0, index), line.slice(index + 1)];
  }));
}

function manifestEvidence({ cwd, requirement }) {
  const version = validVersion(requirement.version);
  const profile = validProfile(requirement.deliveryProfile);
  const path = resolve(cwd, 'deploy', 'release-manifests', `${version}.env`);
  if (!existsSync(path)) {
    throw new EvidenceError(`release manifest is missing: ${version}`, {
      code: 'INVALID_RELEASE_MANIFEST',
    });
  }
  const contents = readFileSync(path);
  const fields = parseManifest(contents.toString('utf8'));
  const requirements = (fields.RELEASE_REQUIREMENTS ?? '').split(',').filter(Boolean);
  const manifestProfile = fields.RELEASE_DELIVERY_PROFILE ?? 'runtime';
  if (
    fields.RELEASE_VERSION !== version
    || !requirements.includes(requirement.id)
    || manifestProfile !== profile
  ) {
    throw new EvidenceError('release manifest does not match the requirement', {
      code: 'INVALID_RELEASE_MANIFEST',
    });
  }
  const services = fields.RELEASE_SERVICES === 'none'
    ? []
    : (fields.RELEASE_SERVICES ?? '').split(',').filter(Boolean).sort();
  if (profile !== 'runtime' && services.length > 0) {
    throw new EvidenceError(`${profile} manifest must use RELEASE_SERVICES=none`, {
      code: 'INVALID_RELEASE_MANIFEST',
    });
  }
  return {
    path: relative(cwd, path),
    sha256: createHash('sha256').update(contents).digest('hex'),
    valid: true,
    services,
  };
}

function leaseEvidence(lease) {
  if (!lease) return null;
  return {
    requirementId: lease.requirementId ?? lease.holder?.id ?? null,
    holder: lease.holder ?? null,
    version: lease.version ?? null,
    sessionId: lease.sessionId ?? null,
    branch: lease.branch ?? null,
    commit: lease.commit ?? null,
    expiresAt: lease.expiresAt ?? null,
  };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateRuntimeTargets(targets) {
  const allowedHosts = new Set(loadSharedEnvironmentPolicy().dev.hosts);
  for (const [name, target] of Object.entries(targets ?? {})) {
    if (target === null || target === undefined || target === '') continue;
    let url;
    try {
      url = new URL(target);
    } catch {
      throw new EvidenceError(`runtime test target is invalid: ${name}`, {
        code: 'DEV_TEST_TARGET_INVALID',
      });
    }
    if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname.toLowerCase())) {
      throw new EvidenceError(`runtime test target is not a canonical dev host: ${name}`, {
        code: 'DEV_TEST_TARGET_INVALID',
        data: { name, host: url.hostname },
      });
    }
  }
}

async function normalizeEnvironment({
  cwd,
  profile,
  environment,
  requirement,
  head,
  manifest,
  freeze = null,
  probeMixed = true,
  devRevisionMatches = false,
  clock = () => new Date(),
}) {
  const normalized = {
    kind: profile === 'runtime' ? 'shared-dev' : 'local',
    devLease: leaseEvidence(environment?.devLease),
    devSnapshot: environment?.devSnapshot ?? null,
    targets: environment?.targets ?? {},
  };
  if (profile !== 'runtime') return normalized;
  if (environment?.mixedEnvironment || environment?.kind === 'mixed-dev') {
    const mixed = environment.mixedEnvironment;
    await validateMixedEnvironment({ cwd, requirement, environment: mixed, devLease: environment.devLease, devSnapshot: environment.devSnapshot, freeze, clock, probe: probeMixed });
    const targetKey = mixed.frontend.app === 'admin' ? 'adminBaseUrl' : 'e2eBaseUrl';
    for (const [key, value] of Object.entries(normalized.targets)) {
      if (value && ((key === targetKey && value !== mixed.frontend.baseUrl) || (key !== targetKey && value !== MIXED_API_TARGET))) {
        throw new EvidenceError('mixed test target differs from the recorded frontend/API identity', { code: 'DEV_TEST_TARGET_INVALID' });
      }
    }
    normalized.kind = 'mixed-dev'; normalized.mixedEnvironment = mixed;
    normalized.targets = { [targetKey]: mixed.frontend.baseUrl, apiBaseUrl: MIXED_API_TARGET };
    return normalized;
  }
  validateRuntimeTargets(normalized.targets);
  const snapshotServices = [...(normalized.devSnapshot?.services ?? [])].sort();
  // I-130 (D1 + review fix): the lease is version-level and its commit
  // floats, so the evidence anchors on the immutable deployment snapshot
  // commit and the lease's bound version — never on the lease commit. Drift
  // between the snapshot commit and the head is tolerated only when the
  // caller proved (revisionMatchesDeployment) that the whole range is not
  // runtime-affecting; the default stays fail-closed.
  if (
    normalized.devLease?.version !== requirement.version
    || normalized.devSnapshot?.version !== requirement.version
    || (normalized.devSnapshot?.commit !== head && devRevisionMatches !== true)
    || JSON.stringify(snapshotServices) !== JSON.stringify(manifest.services)
  ) {
    throw new EvidenceError('runtime tests require a matching dev lease and deployment snapshot', {
      code: 'DEV_EVIDENCE_REQUIRED',
    });
  }
  if (environment?.authoritative === true) {
    const snapshot = normalized.devSnapshot;
    const lease = normalized.devLease;
    // A durable awaiting_human freeze fact (I-113 Task 3) is the machine
    // verification evidence itself: the freeze outlives the original lease
    // TTL by design (cross-day human acceptance), so the lease-expiry check
    // only applies without a matching freeze fact.
    const leaseActive = Number.isFinite(Date.parse(lease.expiresAt))
      && Date.parse(lease.expiresAt) > clock().getTime();
    if (
      snapshot?.schemaVersion !== 2
      || snapshot.requirementId !== requirement.id
      || snapshot.stage !== 'dev'
      || snapshot.branch !== lease.branch
      || snapshot.sessionId !== lease.sessionId
      || snapshot.manifest?.sha256 !== manifest.sha256
      || !/^[a-f0-9]{64}$/.test(snapshot.sourceSnapshot?.sha256 ?? '')
      || (!freeze && !leaseActive)
      || snapshotServices.some((service) => (
        !/^sha256:[a-f0-9]{64}$/.test(snapshot.artifacts?.[service]?.imageId ?? '')
      ))
    ) {
      throw new EvidenceError('runtime evidence is not bound to an authoritative deployment', {
        code: 'DEV_EVIDENCE_REQUIRED',
      });
    }
  }
  return normalized;
}

// I-128 (L12): an acceptance command wedged on network/I/O must fail the
// test run instead of hanging the caller forever. 30 minutes is generous
// for the slowest declared command (the full coordination suite).
const RUNNER_TIMEOUT_MS = 30 * 60 * 1000;
const RUNNER_TIMEOUT_GRACE_MS = 5_000;

// I-262: the runner is async so parallel groups can overlap commands. The
// child is spawned detached in its own process group so a timeout kills the
// whole tree — an orphaned nested CI process (pre-push lesson) is worse than
// a failed run. Collected output is truncated at MAX_COMMAND_OUTPUT instead
// of failing the command (spawnSync maxBuffer killed the child); evidence
// logs stay usable and the divergence is deliberate.
function defaultRunner({ cwd, argv, env }) {
  return new Promise((resolveResult) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const capture = (current, chunk) => (
      current.length < MAX_COMMAND_OUTPUT
        ? (current + chunk).slice(0, MAX_COMMAND_OUTPUT)
        : current
    );
    const finish = (exitCode, extraStderr = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({
        exitCode: Number.isInteger(exitCode) ? exitCode : 1,
        stdout,
        stderr: stderr + extraStderr,
      });
    };
    const killProcessGroup = (signal) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // The group is already gone; the close event settles the promise.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup('SIGTERM');
      setTimeout(() => killProcessGroup('SIGKILL'), RUNNER_TIMEOUT_GRACE_MS).unref();
    }, RUNNER_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      stdout = capture(stdout, chunk.toString('utf8'));
    });
    child.stderr.on('data', (chunk) => {
      stderr = capture(stderr, chunk.toString('utf8'));
    });
    child.on('error', (error) => finish(1, `\n${error.message}`));
    child.on('close', (code) => finish(
      timedOut ? null : code,
      timedOut ? `\n[runner] command exceeded ${RUNNER_TIMEOUT_MS / 60000} minutes and its process group was killed` : '',
    ));
  });
}

function summary(value, { cwd, commonDirectory }) {
  let portable = String(value ?? '');
  const roots = [
    [commonDirectory, '<GIT_COMMON_DIR>'],
    [realpathSync(commonDirectory), '<GIT_COMMON_DIR>'],
    [cwd, '<WORKTREE>'],
    [realpathSync(cwd), '<WORKTREE>'],
  ].sort(([left], [right]) => right.length - left.length);
  for (const [root, replacement] of roots) {
    portable = portable.replaceAll(root, replacement);
  }
  const text = portable
    .replace(
      /(^|[^A-Za-z0-9_-])([A-Za-z0-9_-]*(?:token|ticket|password|passwd|secret|authorization|access[_-]?key|private[_-]?key)[A-Za-z0-9_-]*)\s*[:=]\s*(?:Bearer\s+)?[^\s"']+/gim,
      '$1$2=[REDACTED]',
    )
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/:\/\/([^:\s/]+):([^@\s/]+)@/g, '://$1:[REDACTED]@');
  return text.length <= SUMMARY_LIMIT ? text : `${text.slice(0, SUMMARY_LIMIT)}\n…truncated`;
}

function writeJsonAtomic(path, value, { mode = 0o644 } = {}) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  renameSync(temporary, path);
}

const RESULT_CACHE_SCHEMA_VERSION = 1;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function resultCacheKey({
  safeId,
  requirement,
  profile,
  argv,
  testedCommit,
  mainBase,
  manifest,
  environment,
}) {
  const identity = {
    schemaVersion: RESULT_CACHE_SCHEMA_VERSION,
    requirement: {
      id: safeId,
      version: requirement.version,
      deliveryProfile: profile,
    },
    argv,
    testedCommit,
    mainBase,
    manifest: { path: manifest.path, sha256: manifest.sha256 },
    environment: environment ?? null,
  };
  return createHash('sha256').update(stableJson(identity)).digest('hex');
}

function resultCachePath({ commonDirectory, safeId, key }) {
  return resolve(commonDirectory, 'coordination', 'test-results', safeId, `${key}.json`);
}

// Optional per-command input declarations live in
// .agents/coord-required-inputs.json (schemaVersion 1) at the repository
// root. Each entry binds to an already parsed/validated ACCEPTANCE argv by
// exact equality, so the command tokenizer is never duplicated here. The
// file is an optimization hint: any problem (missing file, parse failure,
// invalid schema, missing/ambiguous/invalid entries, unmatched paths,
// symlinks, unrecognized submodules) degrades the affected command to the v1
// exact-commit cache key. A declaration must cover every input passed on
// the command line — for node/bash that means includes must contain the
// argv[1] script by file or directory component boundary; inputs are never
// inferred automatically (e.g. pnpm scripts resolve through package.json,
// so their includes must be declared explicitly).
const INPUTS_DECLARATION_SCHEMA_VERSION = 1;

// Declaration paths name exact repo-relative tracked files or directory
// roots — never globs, pathspec magic, absolute paths, or traversal.
function normalizeInputsPath(value) {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/.test(value)) return null;
  let path = value;
  while (path.startsWith('./')) path = path.slice(2);
  while (path.endsWith('/')) path = path.slice(0, -1);
  if (path.length === 0 || path.startsWith('/') || /^[A-Za-z]:/.test(path)) return null;
  if (/^[:!^(]/.test(path) || /[*?[\]{}\\]/.test(path)) return null;
  if (path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return null;
  }
  return path;
}

// Optional fixture namespace: a 1-63 character DNS-like lowercase token
// (starts/ends with a-z/0-9, middle only a-z/0-9/hyphen) that isolates
// cached results between test fixture setups. An absent field normalizes
// to null and keeps the plain v2 identity; a present but invalid value
// degrades the whole declaration fail-closed to the v1 cache key.
function normalizeFixtureNamespace(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > 63) return false;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) return false;
  return value;
}

function declarationSha256({ argv, includes, excludes, lockfiles, fixtureNamespace }) {
  return createHash('sha256').update(stableJson({
    schemaVersion: INPUTS_DECLARATION_SCHEMA_VERSION,
    argv,
    includes: [...includes].sort(),
    excludes: [...excludes].sort(),
    lockfiles: [...lockfiles].sort(),
    fixtureNamespace,
  })).digest('hex');
}

const INPUTS_DECLARATION_ENTRY_KEYS = new Set([
  'argv',
  'includes',
  'excludes',
  'lockfiles',
  'fixtureNamespace',
]);

function validInputsDeclaration(entry, argv) {
  // Strict field whitelist: any own enumerable key outside the schema
  // degrades the whole declaration fail-closed to the v1 cache key, so a
  // typo like `lockfile` can never silently drop lockfile coverage.
  if (Object.keys(entry).some((key) => !INPUTS_DECLARATION_ENTRY_KEYS.has(key))) {
    return null;
  }
  if (!Array.isArray(entry.includes) || entry.includes.length === 0) return null;
  if (!Array.isArray(entry.excludes)) return null;
  // Every usable entry must explicitly declare its lockfiles: a missing or
  // non-array field degrades fail-closed to the v1 exact-commit cache key.
  // Each entry is normalized with the same path rules as includes/excludes;
  // the empty array stays an explicit dependency-agnostic audit exemption.
  if (!Array.isArray(entry.lockfiles)) return null;
  const lockfiles = entry.lockfiles.map(normalizeInputsPath);
  if (lockfiles.some((path) => path === null)) return null;
  const fixtureNamespace = normalizeFixtureNamespace(entry.fixtureNamespace);
  if (fixtureNamespace === false) return null;
  const includes = entry.includes.map(normalizeInputsPath);
  const excludes = entry.excludes.map(normalizeInputsPath);
  if (includes.some((path) => path === null) || excludes.some((path) => path === null)) {
    return null;
  }
  // node/bash execute the script passed as argv[1]: the declaration must
  // cover that script by exact file or directory component boundary, or the
  // command degrades to the v1 exact-commit cache key. A missing/invalid
  // script argument also degrades — never guess inputs.
  if (argv[0] === 'node' || argv[0] === 'bash') {
    const script = normalizeInputsPath(argv[1]);
    const covered = script !== null && includes.some(
      (include) => script === include || script.startsWith(`${include}/`),
    );
    if (!covered) return null;
  }
  return {
    argv,
    includes,
    excludes,
    lockfiles,
    fixtureNamespace,
    sha256: declarationSha256({ argv, includes, excludes, lockfiles, fixtureNamespace }),
  };
}

// Returns a Map keyed by JSON.stringify(argv); values are validated
// declarations or null (undeclared / ambiguous / invalid → v1 fallback).
// Module-private; callers go through resolveDeclaredInputs.
function loadInputsDeclarations({ cwd, commands }) {
  const declarations = new Map(commands.map((argv) => [JSON.stringify(argv), null]));
  const path = resolve(cwd, '.agents', 'coord-required-inputs.json');
  if (!existsSync(path)) return declarations;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return declarations;
  }
  if (
    parsed?.schemaVersion !== INPUTS_DECLARATION_SCHEMA_VERSION
    || !Array.isArray(parsed.commands)
  ) {
    return declarations;
  }
  const entriesByArgv = new Map();
  for (const entry of parsed.commands) {
    if (!entry || !Array.isArray(entry.argv)) continue;
    const key = JSON.stringify(entry.argv);
    entriesByArgv.set(key, [...(entriesByArgv.get(key) ?? []), entry]);
  }
  for (const argv of commands) {
    const key = JSON.stringify(argv);
    const entries = entriesByArgv.get(key) ?? [];
    // Zero matches means undeclared; more than one is ambiguous — both degrade.
    if (entries.length !== 1) continue;
    const declaration = validInputsDeclaration(entries[0], argv);
    if (declaration) declarations.set(key, declaration);
  }
  return declarations;
}

// The input fingerprint is computed on the tested commit's git tree, never
// the working tree: each matched entry contributes its path, mode, and blob
// sha in stable path order. The declared coordination engine uses its gitlink
// commit as the input. Other submodules, symlinks and unresolvable inputs fall
// back to the v1 exact-commit cache key.
// Module-private; callers go through resolveDeclaredInputs.
function computeInputsSha256({ cwd, commit, includes, excludes }) {
  const result = spawnSync('git', [
    'ls-tree', '-r', '-z', '--full-tree', '--full-name', commit, '--', ...includes,
  ], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: MAX_COMMAND_OUTPUT,
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return null;
  const entries = new Map();
  for (const record of result.stdout.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) return null;
    const meta = record.slice(0, tab).split(' ');
    const path = record.slice(tab + 1);
    if (meta.length !== 3 || !path) return null;
    const [mode, type, sha] = meta;
    const isEngine = path === COORD_ENGINE_PATH && mode === '160000' && type === 'commit';
    const isRegular = type === 'blob' && (mode === '100644' || mode === '100755');
    if ((!isEngine && !isRegular) || !/^[0-9a-f]{40}$/.test(sha)) return null;
    if (excludes.some((exclude) => path === exclude || path.startsWith(`${exclude}/`))) continue;
    const existing = entries.get(path);
    if (existing && (existing.mode !== mode || existing.sha !== sha)) return null;
    entries.set(path, { mode, path, sha });
  }
  if (entries.size === 0) return null;
  const paths = [...entries.keys()];
  const everyIncludeMatched = includes.every((include) => paths.some(
    (path) => path === include || path.startsWith(`${include}/`),
  ));
  if (!everyIncludeMatched) return null;
  const sorted = [...entries.values()].sort(
    (left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
  );
  return createHash('sha256').update(stableJson({ schemaVersion: 1, entries: sorted }))
    .digest('hex');
}

// The lockfile fingerprint is computed on the tested commit's git tree,
// never the working tree. Every declared lockfile must match exactly one
// same-named tracked regular blob: a directory, an unmatched path, a
// symlink, a submodule, or a duplicate/conflicting match returns null so
// the whole declaration degrades to the v1 exact-commit cache key. The
// empty array still yields a stable fingerprint of the empty entry set.
// Module-private; callers go through resolveDeclaredInputs.
function computeLockfilesSha256({ cwd, commit, lockfiles }) {
  if (lockfiles.length === 0) {
    return createHash('sha256').update(stableJson({ schemaVersion: 1, entries: [] }))
      .digest('hex');
  }
  if (new Set(lockfiles).size !== lockfiles.length) return null;
  const result = spawnSync('git', [
    'ls-tree', '-z', '--full-tree', '--full-name', commit, '--', ...lockfiles,
  ], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: MAX_COMMAND_OUTPUT,
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return null;
  const entries = new Map();
  for (const record of result.stdout.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) return null;
    const meta = record.slice(0, tab).split(' ');
    const path = record.slice(tab + 1);
    if (meta.length !== 3 || !path) return null;
    const [mode, type, sha] = meta;
    // Directories, submodule commits, and symlink blobs are never lockfiles.
    if (type !== 'blob' || mode === '120000' || !/^[0-9a-f]{40}$/.test(sha)) return null;
    if (entries.has(path)) return null;
    entries.set(path, { mode, path, sha });
  }
  if (entries.size !== lockfiles.length) return null;
  if (!lockfiles.every((lockfile) => entries.has(lockfile))) return null;
  const sorted = [...entries.values()].sort(
    (left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
  );
  return createHash('sha256').update(stableJson({ schemaVersion: 1, entries: sorted }))
    .digest('hex');
}

// The single high-level inputs-resolution entry point, shared by
// runRequiredTests and contract tests so the declared gate has exactly one
// definition: loads the per-command declaration and computes both
// fingerprints against the given commit's git tree. Returns a Map keyed by
// JSON.stringify(argv) with { declaration, inputsSha256, lockfilesSha256,
// declared }; declared is true only when the declaration exists and both
// fingerprints resolve (v2 reuse path), otherwise the caller falls back to
// the v1 exact-commit cache key.
export function resolveDeclaredInputs({ cwd, commit, commands }) {
  const declarations = loadInputsDeclarations({ cwd, commands });
  const resolved = new Map();
  for (const argv of commands) {
    const key = JSON.stringify(argv);
    const declaration = declarations.get(key) ?? null;
    const inputsSha256 = declaration
      ? computeInputsSha256({
        cwd,
        commit,
        includes: declaration.includes,
        excludes: declaration.excludes,
      })
      : null;
    const lockfilesSha256 = declaration
      ? computeLockfilesSha256({ cwd, commit, lockfiles: declaration.lockfiles })
      : null;
    resolved.set(key, {
      declaration,
      inputsSha256,
      lockfilesSha256,
      declared: declaration !== null && inputsSha256 !== null && lockfilesSha256 !== null,
    });
  }
  return resolved;
}

// v2 identity for declared commands: same requirement/argv/manifest/
// environment constraints as v1, but bound to the declared inputs and the
// declaration itself instead of the exact commits, so unchanged inputs reuse
// results across commits. v1 keys stay byte-identical for undeclared
// commands and never reuse across commits.
function resultCacheKeyV2({
  safeId,
  requirement,
  profile,
  argv,
  inputsSha256,
  lockfilesSha256,
  declarationSha256: declaration,
  fixtureNamespace,
  manifest,
  environment,
}) {
  const identity = {
    schemaVersion: 2,
    requirement: {
      id: safeId,
      version: requirement.version,
      deliveryProfile: profile,
    },
    argv,
    inputsSha256,
    lockfilesSha256,
    declarationSha256: declaration,
    fixtureNamespace: fixtureNamespace ?? null,
    manifest: { path: manifest.path, sha256: manifest.sha256 },
    environment: environment ?? null,
  };
  return createHash('sha256').update(stableJson(identity)).digest('hex');
}

// A cached log path is only trusted when it is a relative path strictly
// inside coordination/test-logs/<safeId>/ under the git common directory;
// absolute paths and any `..` escape are rejected.
function cachedLogPath({ commonDirectory, safeId, logPath }) {
  if (typeof logPath !== 'string' || isAbsolute(logPath)) return null;
  const root = resolve(commonDirectory, 'coordination', 'test-logs', safeId);
  const candidate = resolve(commonDirectory, logPath);
  if (!pathWithin(root, candidate) || relative(root, candidate) === '') return null;
  return candidate;
}

// The cache is strictly fail closed: anything missing, malformed, or not a
// passed result is treated as a miss and the command runs for real.
function readCachedResult({ commonDirectory, safeId, key }) {
  try {
    const path = resultCachePath({ commonDirectory, safeId, key });
    if (!existsSync(path)) return null;
    const record = JSON.parse(readFileSync(path, 'utf8'));
    const result = record?.result;
    const logPath = cachedLogPath({ commonDirectory, safeId, logPath: result?.logPath });
    if (
      record?.schemaVersion !== RESULT_CACHE_SCHEMA_VERSION
      || record.key !== key
      || result?.exitCode !== 0
      || result.outcome !== 'passed'
      || logPath === null
      || !existsSync(logPath)
    ) {
      return null;
    }
    return {
      // Records written before this field existed degrade to null; callers
      // fall back to the current commit (exact for v1 exact-commit keys).
      testedCommit: /^[0-9a-f]{40}$/.test(record.testedCommit ?? '')
        ? record.testedCommit
        : null,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      exitCode: result.exitCode,
      outcome: result.outcome,
      stdoutSummary: result.stdoutSummary,
      stderrSummary: result.stderrSummary,
      logPath: result.logPath,
      ...(result.attempts ? { attempts: result.attempts, flaky: result.flaky === true } : {}),
    };
  } catch {
    return null;
  }
}

function writeCachedResult({ commonDirectory, safeId, key, argv, result, testedCommit, clock }) {
  if (result.exitCode !== 0 || result.outcome !== 'passed') return;
  try {
    mkdirSync(resolve(commonDirectory, 'coordination', 'test-results', safeId), {
      recursive: true,
    });
    writeJsonAtomic(resultCachePath({ commonDirectory, safeId, key }), {
      schemaVersion: RESULT_CACHE_SCHEMA_VERSION,
      key,
      argv,
      testedCommit,
      cachedAt: clock().toISOString(),
      result,
    }, { mode: 0o600 });
  } catch {
    // The cache is an optimization; a failed write must not fail required tests.
  }
}

// Cached results are only trustworthy when the worktree matches the tested
// commit: any tracked/staged/untracked change beyond this requirement's own
// TEST_EVIDENCE.json forces a real run and is never written back to the
// cache. Computed once per run; the porcelain pathspec exclusion names the
// exact evidence file relative to cwd (forward slashes, cross-platform), so
// other requirements' evidence files still count as changes.
function worktreeHasChangesBeyondEvidence({ cwd, evidenceFile }) {
  const evidenceRelative = relative(cwd, evidenceFile).split(sep).join('/');
  return runGit(cwd, [
    'status', '--porcelain=v1', '--untracked-files=all',
    '--', '.', `:(exclude)${evidenceRelative}`,
  ]).length > 0;
}

export async function runRequiredTests({
  cwd,
  id,
  requirement,
  mainBase = 'origin/main',
  environment,
  runner = defaultRunner,
  clock = () => new Date(),
  validateEnvironmentAfterRun,
  resourcesFor = commandResources,
  resourceBudget = 2,
}) {
  const safeId = validId(id);
  if (requirement?.id !== safeId) {
    throw new EvidenceError('requirement metadata does not match requested id', {
      code: 'INVALID_REQUIREMENT_METADATA',
    });
  }
  const directory = requirementDirectory({ cwd, id: safeId });
  const acceptanceSource = readFileSync(resolve(directory, 'ACCEPTANCE.md'), 'utf8');
  const groups = parseAcceptanceGroups(acceptanceSource, { cwd });
  const commands = groups.flatMap((group) => group.commands);
  const testedCommit = runGit(cwd, ['rev-parse', 'HEAD']);
  const coordEngineCommit = assertCoordEngineCheckout({ cwd, commit: testedCommit });
  const engineMatches = () => coordEngineCheckoutMatches({ cwd, commit: testedCommit, expected: coordEngineCommit });
  const testedMainBase = runGit(cwd, ['rev-parse', mainBase]);
  const manifest = manifestEvidence({ cwd, requirement });
  const profile = validProfile(requirement.deliveryProfile);
  const normalizedEnvironment = await normalizeEnvironment({
    cwd,
    profile,
    environment,
    requirement,
    head: testedCommit,
    manifest,
    // I-130 (review fix): deployment drift tolerance anchored on the
    // immutable snapshot commit — the tested HEAD may move past it through
    // BACKLOG projections or other non-runtime-affecting commits.
    devRevisionMatches: profile === 'runtime'
      && typeof environment?.devSnapshot?.commit === 'string'
      && environment.devSnapshot.commit !== testedCommit
      && revisionMatchesDeployment({
        cwd,
        requirementId: safeId,
        fromCommit: environment.devSnapshot.commit,
        toCommit: testedCommit,
      }).matches,
    clock,
  });
  const runId = randomUUID();
  const commonDirectory = gitCommonDir(cwd);
  const logDirectory = resolve(
    commonDirectory,
    'coordination',
    'test-logs',
    safeId,
    runId,
  );
  mkdirSync(logDirectory, { recursive: true });
  const results = [];
  const pendingCache = [];
  const toolchain = verificationToolchain({ cwd, coordEngineCommit });
  const localEnvironment = commands.some(localCheck) ? gitExecutionEnvironment({ cwd }) : null;
  const localToolchain = localEnvironment ? verificationToolchain({ cwd, env: localEnvironment, coordEngineCommit }) : null;
  const expectationPath = resolve(directory, 'E2E_EXPECTATIONS.json');
  const executionContract = { acceptanceWorkflowVersion: requirement.acceptanceWorkflowVersion ?? null,
    e2eExpectationsSha256: existsSync(expectationPath) ? createHash('sha256').update(readFileSync(expectationPath)).digest('hex') : null };
  // B-248: the recorded testedCommit must describe the exact tree the commands
  // run against. With uncommitted changes present the evidence would silently
  // cover a tree that never exists in git, so refuse instead of recording.
  const dirtyWorktree = worktreeHasChangesBeyondEvidence({
    cwd,
    evidenceFile: resolve(directory, 'TEST_EVIDENCE.json'),
  });
  if (dirtyWorktree) {
    throw new EvidenceError(
      'worktree has uncommitted or untracked changes beyond this requirement\'s TEST_EVIDENCE.json; commit or stash them before running required tests so testedCommit matches the tested tree',
      { code: 'DIRTY_WORKTREE' },
    );
  }
  const reuseCache = normalizedEnvironment.kind !== 'mixed-dev' && !dirtyWorktree;
  const resolvedInputs = resolveDeclaredInputs({ cwd, commit: testedCommit, commands: commands.map(canonicalCheck) });
  if (runner === defaultRunner) {
    const readiness = inspectTestPrerequisites({ cwd, commands });
    if (!readiness.ok) throw new EvidenceError('test prerequisites are missing; fix them before starting expensive checks', { code: 'TEST_READINESS_FAILED', data: readiness });
  }
  // I-262: the per-command pipeline is unchanged (cache read → run with one
  // retry → per-command log → cache write); it is extracted so a parallel
  // group can run several of these concurrently and still keep every result
  // field byte-compatible with the serial form. Returns the command result —
  // cache hits return the reused shape with reused: true.
  const runCommand = async ({ argv, index }) => {
    const cacheEnvironment = checkEnvironmentIdentity(argv, normalizedEnvironment);
    const effectiveEnv = commandExecutionEnvironment({ argv, requirement, profile, environment: normalizedEnvironment,
      env: localCheck(argv) ? localEnvironment : process.env });
    const commandToolchain = {
      ...(localCheck(argv) ? localToolchain : toolchain),
      environmentSha256: verificationEnvironmentFingerprint(effectiveEnv, { cwd, coordEngineCommit }),
    };
    const {
      declaration,
      inputsSha256,
      lockfilesSha256,
      declared,
    } = resolvedInputs.get(JSON.stringify(canonicalCheck(argv)));
    const sharedIdentity = receiptIdentity({ argv, input: resolvedInputs.get(JSON.stringify(canonicalCheck(argv))), toolchain: commandToolchain });
    const baseCacheKey = declared
      ? resultCacheKeyV2({
        safeId,
        requirement,
        profile,
        argv,
        inputsSha256,
        lockfilesSha256,
        declarationSha256: declaration.sha256,
        fixtureNamespace: declaration.fixtureNamespace,
        manifest,
        environment: cacheEnvironment,
      })
      : resultCacheKey({
        safeId,
        requirement,
        profile,
        argv,
        testedCommit,
        mainBase: testedMainBase,
        manifest,
        environment: cacheEnvironment,
      });
    const cacheKey = createHash('sha256').update(stableJson({ baseCacheKey, toolchain: commandToolchain,
      ...(localCheck(argv) ? {} : { executionContract }),
    })).digest('hex');
    const shared = !dirtyWorktree ? readCheckReceipt({ commonDirectory, identity: sharedIdentity }) : null;
    const cached = shared ? { ...shared.result, testedCommit: shared.testedCommit } : reuseCache
      ? readCachedResult({ commonDirectory, safeId, key: cacheKey })
      : null;
    if (cached) {
      return {
        ...cached,
        argv,
        command: JSON.stringify(argv),
        // A reused result keeps the commit it was first produced on; old
        // records without the field predate cross-commit reuse (v1), where
        // the key already binds the current commit.
        testedCommit: cached.testedCommit ?? testedCommit,
        ...(declared
          ? {
            inputsSha256,
            lockfilesSha256,
            declarationSha256: declaration.sha256,
            ...(declaration.fixtureNamespace !== null
              ? { fixtureNamespace: declaration.fixtureNamespace }
              : {}),
          }
          : {}),
        reused: true,
        receiptKey: sharedIdentity?.key ?? null,
      };
    }
    const startedAt = clock().toISOString();
    // Retry only a recognized transient failure, never a missing tool/table,
    // product assertion or unknown error. Keep every attempt in the evidence.
    const runAttempt = async () => {
      let rawExecution;
      try {
        rawExecution = await runner({ cwd, argv, index, env: effectiveEnv });
      } catch (error) {
        rawExecution = { exitCode: 1, stdout: '', stderr: error.message };
      }
      const execution = {
        exitCode: Number.isInteger(rawExecution.exitCode) ? rawExecution.exitCode : 1,
        stdout: rawExecution.stdout,
        stderr: rawExecution.stderr,
      };
      return { ...execution, failure: classifyTestFailure(execution) };
    };
    const attempts = [await runAttempt()];
    if (attempts[0].failure.retryable && runGit(cwd, ['rev-parse', 'HEAD']) === testedCommit && engineMatches()
      && !worktreeHasChangesBeyondEvidence({ cwd, evidenceFile: resolve(directory, 'TEST_EVIDENCE.json') })) {
      attempts.push(await runAttempt());
    }
    const finishedAt = clock().toISOString();
    const execution = attempts.at(-1);
    const exitCode = execution.exitCode;
    const logPath = resolve(logDirectory, `${String(index + 1).padStart(2, '0')}.log`);
    // Every attempt's stdout/stderr stays in the local log with an explicit
    // attempt boundary, so a retry never overwrites the first failure's
    // diagnostics; the single-attempt format is unchanged.
    const logContent = attempts.length === 1
      ? `[stdout]\n${attempts[0].stdout ?? ''}\n[stderr]\n${attempts[0].stderr ?? ''}`
      : attempts.map((attempt, attemptIndex) => (
        `[attempt ${attemptIndex + 1} stdout]\n${attempt.stdout ?? ''}\n`
        + `[attempt ${attemptIndex + 1} stderr]\n${attempt.stderr ?? ''}`
      )).join('\n');
    writeFileSync(logPath, logContent, { mode: 0o600 });
    const result = {
      argv,
      command: JSON.stringify(argv),
      testedCommit,
      ...(declared
        ? {
          inputsSha256,
          lockfilesSha256,
          declarationSha256: declaration.sha256,
          ...(declaration.fixtureNamespace !== null
            ? { fixtureNamespace: declaration.fixtureNamespace }
            : {}),
        }
        : {}),
      startedAt,
      finishedAt,
      exitCode,
      outcome: exitCode === 0 ? 'passed' : 'failed',
      failure: execution.failure,
      flaky: attempts.length > 1 && exitCode === 0,
      attempts: attempts.map(attempt => ({ exitCode: attempt.exitCode, failure: attempt.failure,
        stdoutSummary: summary(attempt.stdout, { cwd, commonDirectory }), stderrSummary: summary(attempt.stderr, { cwd, commonDirectory }) })),
      stdoutSummary: summary(execution.stdout, { cwd, commonDirectory }),
      stderrSummary: summary(execution.stderr, { cwd, commonDirectory }),
      logPath: relative(commonDirectory, logPath).split(sep).join('/'),
    };
    if (exitCode === 0 && (reuseCache || sharedIdentity)) {
      pendingCache.push({
        commonDirectory,
        safeId,
        key: cacheKey,
        argv,
        result,
        testedCommit,
        clock,
        sharedIdentity,
      });
    }
    return result;
  };
  // Groups run in declaration order; a parallel group's commands all settle
  // (killing a sibling would lose its cache write and truncate its log) and
  // then any failure short-circuits every later group — the serial
  // fail-fast semantics preserved at group granularity. Log numbering stays
  // flat and positional in declaration order.
  const parallelGroups = [];
  let shortCircuited = false;
  for (const group of groups) {
    if (shortCircuited) break;
    const groupStart = results.length;
    const groupResults = [];
    if (group.parallel) {
      for (const batch of executionBatches(group.commands, { budget: resourceBudget, resources: resourcesFor })) {
        const offset = groupStart + groupResults.length;
        groupResults.push(...await Promise.all(batch.map((argv, groupIndex) => runCommand({ argv, index: offset + groupIndex }))));
        if (batch.length > 1) parallelGroups.push([offset, offset + batch.length - 1]);
        if (groupResults.some(result => result.exitCode !== 0)) break;
      }
    } else {
      groupResults.push(await runCommand({ argv: group.commands[0], index: groupStart }));
    }
    results.push(...groupResults);
    if (groupResults.some((result) => result.exitCode !== 0)) {
      shortCircuited = true;
    }
  }

  const commandsPassed = results.length === commands.length
    && results.every(({ exitCode }) => exitCode === 0);
  let sourceValidation = runGit(cwd, ['rev-parse', 'HEAD']) !== testedCommit || !engineMatches()
    || worktreeHasChangesBeyondEvidence({ cwd, evidenceFile: resolve(directory, 'TEST_EVIDENCE.json') })
    ? { outcome: 'failed', code: 'TEST_INPUTS_CHANGED', message: 'source changed during test execution; success receipts were withheld' }
    : { outcome: 'passed' };
  let environmentValidation = null;
  if (results.some(result => result.exitCode === 0) && (normalizedEnvironment.kind === 'mixed-dev' || typeof validateEnvironmentAfterRun === 'function')) {
    try {
      if (normalizedEnvironment.kind === 'mixed-dev') await validateMixedEnvironment({ cwd, requirement, environment: normalizedEnvironment.mixedEnvironment,
        devLease: environment.devLease, devSnapshot: environment.devSnapshot, clock });
      if (typeof validateEnvironmentAfterRun === 'function') await validateEnvironmentAfterRun({ testedCommit, environment: normalizedEnvironment });
      environmentValidation = { outcome: 'passed' };
    } catch (error) {
      environmentValidation = {
        outcome: 'failed',
        code: typeof error?.code === 'string' ? error.code : 'DEV_ENVIRONMENT_CHANGED',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (runGit(cwd, ['rev-parse', 'HEAD']) !== testedCommit
    || worktreeHasChangesBeyondEvidence({ cwd, evidenceFile: resolve(directory, 'TEST_EVIDENCE.json') })
    || stableJson(toolchain) !== stableJson(verificationToolchain({ cwd, coordEngineCommit }))
    || (localToolchain && stableJson(localToolchain) !== stableJson(verificationToolchain({ cwd, env: gitExecutionEnvironment({ cwd }), coordEngineCommit })))
    || !engineMatches()) {
    sourceValidation = { outcome: 'failed', code: 'TEST_INPUTS_CHANGED', message: 'source or toolchain changed before receipt publication' };
  }
  // Publish only after the post-run source and environment checks. A process
  // that happens to exit zero cannot bless a moving source or backend.
  if (sourceValidation.outcome === 'passed') {
    for (const entry of pendingCache) {
      if (environmentValidation?.outcome === 'failed' && !localCheck(entry.argv)) continue;
      writeCachedResult(entry);
      writeCheckReceipt({ ...entry, identity: entry.sharedIdentity });
    }
  }

  const evidence = {
    schemaVersion: 1,
    requirement: {
      id: safeId,
      version: validVersion(requirement.version),
      deliveryProfile: profile,
      ...(requirement.workflowVersion === 2 ? { validationEpoch: requirement.validationEpoch ?? 0 } : {}),
    },
    testedCommit,
    mainBase: testedMainBase,
    revisionPolicyVersion: REVISION_POLICY_VERSION,
    acceptanceCommandsSha256: acceptanceCommandsSha256(acceptanceSource),
    manifest,
    environment: normalizedEnvironment,
    sourceValidation,
    ...(environmentValidation ? { environmentValidation } : {}),
    // I-262: audit-only record of which result indexes ran as one parallel
    // group; absent when the ACCEPTANCE declares no parallel groups.
    ...(parallelGroups.length > 0 ? { parallelGroups } : {}),
    commands: results,
    outcome: commandsPassed
      && sourceValidation.outcome === 'passed'
      && environmentValidation?.outcome !== 'failed'
      ? 'passed'
      : 'failed',
    generatedAt: clock().toISOString(),
  };
  const path = evidencePath({ cwd, id: safeId });
  writeJsonAtomic(path, evidence);
  return { path, evidence };
}

function changedServices(cwd, from, to) {
  if (from === to) return { paths: [], services: [] };
  const paths = runGit(cwd, ['diff', '--name-only', from, to]).split('\n').filter(Boolean);
  const services = new Set();
  for (const path of paths) {
    for (const [prefix, service] of Object.entries(SERVICE_BY_PATH)) {
      if (path.startsWith(prefix)) services.add(service);
    }
  }
  return { paths, services: [...services].sort() };
}

function failure(code, message, data = {}) {
  return { code, message, ...data };
}

// Tested-commit drift is tolerated only when every commit since testing is
// evidence-neutral for this requirement; any policy failure stays fail-closed.
function classifyTestedCommitDrift({ cwd, id, testedCommit, currentHead }) {
  try {
    return classifyRevisionRange({
      cwd,
      requirementId: id,
      fromSha: testedCommit,
      toSha: currentHead,
    });
  } catch (error) {
    return {
      valid: false,
      code: typeof error?.code === 'string' ? error.code : 'REVISION_POLICY_ERROR',
      classification: null,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function sameCommands(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function validateTestEvidence({
  cwd,
  id,
  head = 'HEAD',
  base = 'origin/main',
  requirement,
  deployment,
  mixedEnvironment,
  lease,
  freeze = null,
  clock = () => new Date(),
}) {
  const safeId = validId(id);
  const path = evidencePath({ cwd, id: safeId });
  if (!existsSync(path)) {
    throw new EvidenceError(`TEST_EVIDENCE.json is missing for ${safeId}`, {
      code: 'TEST_EVIDENCE_INVALID',
      data: { failures: [failure('EVIDENCE_MISSING', 'generate test evidence')] },
    });
  }
  let evidence;
  let evidenceBytes;
  try {
    evidenceBytes = readFileSync(path);
    evidence = JSON.parse(evidenceBytes.toString('utf8'));
  } catch (error) {
    throw new EvidenceError('TEST_EVIDENCE.json is not valid JSON', {
      code: 'TEST_EVIDENCE_INVALID',
      data: { failures: [failure('EVIDENCE_JSON_INVALID', error.message)] },
    });
  }
  const failures = [];
  const currentHead = runGit(cwd, ['rev-parse', head]);
  const currentBase = runGit(cwd, ['rev-parse', base]);
  if (evidence.schemaVersion !== 1 || evidence.requirement?.id !== safeId) {
    failures.push(failure('EVIDENCE_SCHEMA_INVALID', 'unsupported or mismatched evidence schema'));
  }
  const expectedRequirement = requirement ?? evidence.requirement;
  if (
    requirement
    && (
      evidence.requirement?.id !== requirement.id
      || evidence.requirement?.version !== requirement.version
      || evidence.requirement?.deliveryProfile !== requirement.deliveryProfile
      || (requirement.workflowVersion === 2 && (evidence.requirement?.validationEpoch ?? 0) !== (requirement.validationEpoch ?? 0))
    )
  ) {
    failures.push(failure(
      'REQUIREMENT_FACT_MISMATCH',
      'evidence requirement facts differ from coordination state',
    ));
  }
  if (evidence.outcome !== 'passed') {
    failures.push(failure('TEST_OUTCOME_NOT_PASSED', 'required tests did not all pass'));
  }
  let toleratedCommitRange = null;
  if (evidence.testedCommit !== currentHead) {
    const policy = classifyTestedCommitDrift({
      cwd,
      id: safeId,
      testedCommit: evidence.testedCommit,
      currentHead,
    });
    if (policy.valid && policy.classification === 'evidence-neutral') {
      toleratedCommitRange = {
        from: evidence.testedCommit,
        to: currentHead,
        classification: policy.classification,
        reason: policy.reason,
      };
    } else {
      failures.push(failure('TESTED_COMMIT_MISMATCH', 'feature HEAD changed after testing', {
        expected: evidence.testedCommit,
        actual: currentHead,
        policyClassification: policy.classification ?? null,
        policyCode: policy.code ?? null,
        policyReason: policy.reason ?? null,
      }));
    }
  }
  const expectedCommands = parseAcceptanceCommands(
    readFileSync(resolve(requirementDirectory({ cwd, id: safeId }), 'ACCEPTANCE.md'), 'utf8'),
    { cwd },
  );
  if (!sameCommands(evidence.commands?.map(({ argv }) => argv), expectedCommands)) {
    failures.push(failure('COMMAND_SET_MISMATCH', 'required command set changed or is incomplete'));
  }
  if (evidence.commands?.some(({ exitCode }) => exitCode !== 0)) {
    failures.push(failure('COMMAND_FAILED', 'one or more required commands failed'));
  }

  let currentManifest;
  try {
    currentManifest = manifestEvidence({ cwd, requirement: expectedRequirement });
    if (currentManifest.sha256 !== evidence.manifest?.sha256) {
      failures.push(failure('MANIFEST_HASH_MISMATCH', 'release manifest changed after testing'));
    }
    if (
      currentManifest.path !== evidence.manifest?.path
      || currentManifest.valid !== evidence.manifest?.valid
      || !sameCommands(currentManifest.services, evidence.manifest?.services)
    ) {
      failures.push(failure(
        'MANIFEST_METADATA_MISMATCH',
        'evidence manifest metadata does not match the hashed manifest',
      ));
    }
  } catch (error) {
    failures.push(failure('MANIFEST_INVALID', error.message));
  }

  const durableAcceptance = expectedRequirement.acceptanceWorkflowVersion === 1
    && freeze?.windowState === 'accepted' && freeze.requirementId === safeId
    && freeze.version === expectedRequirement.version && freeze.validationEpoch === (expectedRequirement.validationEpoch ?? 0)
    && freeze.machineVerificationEvidence === createHash('sha256').update(evidenceBytes).digest('hex')
    && sameJson(freeze.deploymentSnapshot, evidence.environment?.devSnapshot)
    && typeof freeze.acceptance?.authorizedBy === 'string' && freeze.acceptance.authorizedBy.trim().length >= 2
    && /^user-message:[A-Za-z0-9._:-]{6,}$/.test(freeze.acceptance?.instructionRef ?? '')
    && Number.isFinite(Date.parse(freeze.acceptance?.acceptedAt));
  // After direct human acceptance, validation concerns this immutable candidate,
  // not the next tenant of shared dev. Execution guards still need a live lease.
  if (durableAcceptance) deployment = freeze.deploymentSnapshot;
  if (evidence.environment?.kind === 'mixed-dev' && mixedEnvironment !== undefined && (!mixedEnvironment || mixedEnvironment.invalidated || mixedEnvironment.identitySha256 !== evidence.environment.mixedEnvironment?.identitySha256)) {
    failures.push(failure('MIXED_ENVIRONMENT_FACT_MISMATCH', 'mixed test evidence differs from the current coordination environment identity'));
  }
  if (expectedRequirement?.deliveryProfile === 'runtime') {
    try {
      const recordedSnapshotCommit = evidence.environment?.devSnapshot?.commit;
      const acceptedMixedFreeze = evidence.environment?.kind === 'mixed-dev'
        && freeze?.requirementId === safeId && freeze.version === expectedRequirement.version
        && freeze.validationEpoch === (expectedRequirement.validationEpoch ?? 0)
        && freeze.mixedEnvironmentIdentity === evidence.environment.mixedEnvironment?.identitySha256
        && freeze.machineVerificationEvidence === createHash('sha256').update(evidenceBytes).digest('hex')
        && typeof freeze.acceptance?.authorizedBy === 'string' && freeze.acceptance.authorizedBy.trim().length >= 2
        && /^user-message:[A-Za-z0-9._:-]{6,}$/.test(freeze.acceptance?.instructionRef ?? '')
        && Number.isFinite(Date.parse(freeze.acceptance?.acceptedAt))
        && (deployment === undefined || sameJson(freeze.deploymentSnapshot, deployment));
      await normalizeEnvironment({
        cwd,
        profile: 'runtime',
        environment: evidence.environment?.kind === 'mixed-dev' ? { ...evidence.environment, devLease: lease ?? evidence.environment.devLease, devSnapshot: deployment ?? evidence.environment.devSnapshot } : evidence.environment,
        requirement: expectedRequirement,
        head: evidence.testedCommit,
        manifest: evidence.manifest,
        freeze,
        probeMixed: !acceptedMixedFreeze,
        // I-130 (review fix): the recorded deployment snapshot may lag the
        // tested commit by a non-runtime-affecting range (BACKLOG
        // projections, docs); tolerance is anchored on the snapshot commit.
        devRevisionMatches: typeof recordedSnapshotCommit === 'string'
          && recordedSnapshotCommit !== evidence.testedCommit
          && revisionMatchesDeployment({
            cwd,
            requirementId: safeId,
            fromCommit: recordedSnapshotCommit,
            toCommit: evidence.testedCommit,
          }).matches,
        clock,
      });
    } catch (error) {
      failures.push(failure('DEV_EVIDENCE_INVALID', error.message));
    }
    if (deployment !== undefined && (
      !deployment || !sameJson(evidence.environment?.devSnapshot, deployment)
    )) {
      // I-260（部署事实超期容差）：dev 重锚部署可能发生在测试锚点之后
      //（典型为满足生产快照严格相等，在验收报告提交后重锚 tag 提交）。
      // 只要新部署事实与证据内嵌快照同需求、同版本、同服务集合，且内嵌
      // 快照提交 → 新部署提交的区间按 revision policy 判为非
      // runtime-affecting（BACKLOG 投影、验收/评审报告等 deployment-neutral
      // 变更），运行时输入未变，测试证据继续有效——与 candidate
      // assert-equivalent 及 testedCommit 漂移容差（I-130）同一信任模型。
      const embedded = evidence.environment?.devSnapshot;
      const supersessionNeutral = Boolean(
        embedded
        && deployment
        && embedded.requirementId === deployment.requirementId
        && embedded.version === deployment.version
        && JSON.stringify([...(embedded.services ?? [])].sort()) === JSON.stringify([...(deployment.services ?? [])].sort())
        && (
          embedded.commit === deployment.commit
          || revisionMatchesDeployment({
            cwd,
            requirementId: safeId,
            fromCommit: embedded.commit,
            toCommit: deployment.commit,
          }).matches
        ),
      );
      if (!supersessionNeutral) {
        failures.push(failure(
          'DEPLOYMENT_FACT_MISMATCH',
          'test evidence deployment differs from coordination state',
        ));
      }
    }
    if (lease !== undefined && freeze === null) {
      const expectedLease = leaseEvidence(lease);
      const recordedLease = evidence.environment?.devLease;
      // I-130 (D1): the recorded lease is compared on the version-level
      // identity tuple (version, branch, session) — the floating commit and
      // the renew-shifted expiry are not part of the identity. The expiry
      // check below still requires the lease to be live right now.
      if (
        recordedLease?.version !== expectedLease?.version
        || recordedLease?.branch !== expectedLease?.branch
        || recordedLease?.sessionId !== expectedLease?.sessionId
        || !Number.isFinite(Date.parse(expectedLease.expiresAt))
        || Date.parse(expectedLease.expiresAt) <= clock().getTime()
      ) {
        failures.push(failure(
          'DEV_LEASE_MISMATCH',
          'test evidence lease is no longer the active coordination lease',
        ));
      }
    }
  }

  let reuseDevEvidence = true;
  const requiredActions = [];
  let mainChange = { paths: [], services: [] };
  if (evidence.mainBase !== currentBase) {
    mainChange = changedServices(cwd, evidence.mainBase, currentBase);
    const affected = new Set(evidence.manifest?.services ?? []);
    const overlap = mainChange.services.filter((service) => affected.has(service));
    if (overlap.length > 0) {
      reuseDevEvidence = false;
      failures.push(failure(
        'MAIN_BASE_SERVICE_OVERLAP',
        'main changed services covered by this runtime evidence',
        { services: overlap },
      ));
    } else {
      requiredActions.push('rerun_local_ci');
    }
  }

  if (failures.length > 0) {
    throw new EvidenceError(`test evidence is invalid for ${safeId}`, {
      code: 'TEST_EVIDENCE_INVALID',
      data: { failures, currentHead, currentBase, mainChange },
    });
  }
  return {
    valid: true,
    id: safeId,
    testedCommit: evidence.testedCommit,
    mainBase: evidence.mainBase,
    currentBase,
    reuseDevEvidence,
    requiredActions,
    mainChange,
    toleratedCommitRange,
    evidence,
  };
}
