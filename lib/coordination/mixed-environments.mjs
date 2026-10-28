import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gitCommonDir } from './worktrees.mjs';
import { assertVersionLease } from './leases.mjs';
import { assertRequirementId } from './validation.mjs';
import { loadRuntimeArtifactInputs } from './revision-policy.mjs';

export const MIXED_API_TARGET = 'https://api-dev.hongli-ruian.com/api';
export const BACKEND_SERVICES = Object.freeze(['account', 'api', 'gateway']);
const APPS = { account: 'account-api', api: 'api', gateway: 'gateway-api', web: 'web', admin: 'admin' };
const digest = value => createHash('sha256').update(value).digest('hex');
export class MixedEnvironmentError extends Error {
  constructor(message, { code = 'MIXED_ENVIRONMENT_INVALID', exitCode = 14, data = {}, cause } = {}) {
    super(message, { cause }); this.name = 'MixedEnvironmentError'; this.code = code; this.exitCode = exitCode; this.data = data;
  }
}
function fail(message, code) { throw new MixedEnvironmentError(message, { code }); }
function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (result.error || result.status !== 0) fail(`cannot read mixed environment source: git ${args[0]}`, 'MIXED_SOURCE_UNAVAILABLE');
  return result.stdout.trim();
}
export function mixedSourceCommit(cwd) { return git(cwd, ['rev-parse', 'HEAD']); }
export function assertMixedSourcesClean({ cwd, requirementId }) {
  const exclusions = [];
  if (requirementId) {
    const paths = git(cwd, ['ls-files', 'docs/product/current']).split('\n').filter(p => p.includes(`/${requirementId}-`) && p.endsWith('/TEST_EVIDENCE.json'));
    for (const path of paths) exclusions.push(`:(exclude)${path}`);
    // The first generated evidence is untracked until the caller commits it.
    const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard', 'docs/product/current']).split('\n');
    for (const path of untracked.filter(p => p.includes(`/${requirementId}-`) && p.endsWith('/TEST_EVIDENCE.json'))) exclusions.push(`:(exclude)${path}`);
  }
  if (git(cwd, ['status', '--porcelain=v1', '--untracked-files=all', '--', '.', ...exclusions])) fail('formal mixed evidence requires clean committed sources', 'MIXED_DIRTY_SOURCES');
}
function glob(pattern, path) {
  const escaped = pattern.split('**').map(part => part.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*');
  return new RegExp(`^${escaped}$`).test(path);
}
// Consume the same service declaration as revision-policy, supplemented by root,
// shared and unknown inputs. Only known documentation/tooling paths are excluded;
// a new or unclassified build input therefore invalidates backend reuse.
export function serviceRuntimeInputs({ cwd, commit = 'HEAD', services = Object.keys(APPS) }) {
  loadRuntimeArtifactInputs({ cwd });
  let declaration;
  try { declaration = JSON.parse(git(cwd, ['show', `${commit}:.agents/runtime-artifact-inputs.json`])); }
  catch { fail('historical runtime input declaration is unavailable', 'MIXED_INPUTS_UNKNOWN'); }
  if (declaration?.schemaVersion !== 1 || !declaration.services || Array.isArray(declaration.services) || Object.keys(declaration).some(k => !['schemaVersion', 'services'].includes(k))) fail('runtime input declaration is invalid', 'MIXED_INPUTS_UNKNOWN');
  const entries = git(cwd, ['ls-tree', '-r', '-z', commit]).split('\0').filter(Boolean).map(line => {
    const match = /^(\d+) (\S+) ([a-f0-9]+)\t([\s\S]+)$/.exec(line);
    if (!match) fail('unknown source tree entry', 'MIXED_INPUTS_UNKNOWN');
    return { mode: match[1], type: match[2], blob: match[3], path: match[4] };
  });
  return Object.fromEntries(services.map(service => {
    const rules = declaration.services[service];
    if (!APPS[service] || !Array.isArray(rules?.includes) || !Array.isArray(rules?.excludes)) fail(`unknown runtime inputs for ${service}`, 'MIXED_INPUTS_UNKNOWN');
    const patterns = [...rules.includes, ...rules.excludes];
    if (!rules.includes.length || Object.keys(rules).some(k => !['includes', 'excludes'].includes(k)) || patterns.some(p => typeof p !== 'string' || !p || p.startsWith('/') || p.includes('..') || p.includes('\\'))) fail(`invalid historical runtime declaration for ${service}`, 'MIXED_INPUTS_UNKNOWN');
    const dockerfile = git(cwd, ['show', `${commit}:apps/${APPS[service]}/Dockerfile`]).replace(/\\\r?\n/g, ' ');
    const copies = [];
    for (const line of dockerfile.split(/\r?\n/)) {
      if (!/^COPY\s/i.test(line.trim()) || /--from=/.test(line)) continue;
      const parts = line.trim().split(/\s+/).slice(1).filter(p => !p.startsWith('--'));
      if (parts.length < 2 || parts.some(p => /[\[\]$]/.test(p))) fail('unrecognized historical Docker COPY input', 'MIXED_INPUTS_UNKNOWN');
      copies.push(...parts.slice(0, -1).map(p => p.replace(/^\.\//, '').replace(/\/$/, '')));
    }
    const selected = entries.filter(({ path }) => {
      if (path === '.agents/runtime-artifact-inputs.json' || copies.some(p => p === '.' || path === p || path.startsWith(`${p}/`) || glob(p, path))) return true;
      if (rules.includes.some(p => glob(p, path)) && !rules.excludes.some(p => glob(p, path))) return true;
      if (path.startsWith('apps/')) return !Object.values(APPS).some(app => path.startsWith(`apps/${app}/`)) && !path.startsWith('apps/ux-prototype/');
      if (/^(docs\/|\.github\/|\.ai\/|\.codex\/|\.shared-skills(?:\/|$)|deploy\/(?:release-manifests|dev-releases|releases)\/)/.test(path)) return false;
      if (/^(BACKLOG\.md|AGENTS\.md|README(?:\.[^/]*)?|LICENSE(?:\.[^/]*)?|\.gitignore)$/.test(path)) return false;
      return true;
    });
    if (!selected.some(e => e.path.startsWith(`apps/${APPS[service]}/`)) || selected.some(e => e.type !== 'blob' || !['100644', '100755'].includes(e.mode))) fail(`unverifiable runtime source for ${service}`, 'MIXED_INPUTS_UNKNOWN');
    return [service, digest(JSON.stringify({ rules, entries: selected }))];
  }));
}
export function canonicalMixedBaseUrl(value) {
  let url; try { url = new URL(value); } catch { fail('mixed frontend requires a loopback HTTP URL'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) fail('mixed frontend requires a loopback HTTP origin');
  return url.origin;
}
export function managedRunnerPath({ cwd, baseUrl }) {
  return resolve(gitCommonDir(cwd), 'coordination/frontend-runners', `${digest(canonicalMixedBaseUrl(baseUrl))}.json`);
}
export function managedFrontendRegistration({ cwd = process.env.COORD_ROOT_DIR || process.cwd(), baseUrl }) {
  try {
    const target = new URL(baseUrl);
    if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) return null;
    cwd = git(cwd, ['rev-parse', '--show-toplevel']);
    const origin = canonicalMixedBaseUrl(new URL(baseUrl).origin);
    const record = JSON.parse(readFileSync(managedRunnerPath({ cwd, baseUrl: origin }), 'utf8'));
    if (record.cwd !== realpathSync(cwd) || record.baseUrl !== origin || !Number.isInteger(record.pid)) return null;
    process.kill(record.pid, 0);
    return { baseUrl: origin, instanceId: record.instanceId, apiTarget: MIXED_API_TARGET };
  } catch { return null; }
}
export function signManagedProbe(secret, challenge, identity) {
  return createHmac('sha256', secret).update(`${challenge}\n${JSON.stringify(identity)}`).digest('hex');
}
export async function probeManagedFrontend({ cwd, baseUrl }) {
  const origin = canonicalMixedBaseUrl(baseUrl);
  let runner;
  try { runner = JSON.parse(readFileSync(managedRunnerPath({ cwd, baseUrl: origin }), 'utf8')); }
  catch { fail('no locally managed frontend runner for this origin', 'MIXED_RUNNER_REQUIRED'); }
  if (runner.cwd !== realpathSync(cwd) || runner.baseUrl !== origin || typeof runner.secret !== 'string' || !Number.isInteger(runner.pid)) fail('managed frontend runner registry is invalid', 'MIXED_RUNNER_REQUIRED');
  try { process.kill(runner.pid, 0); } catch { fail('managed frontend is not running', 'MIXED_RUNNER_STOPPED'); }
  const challenge = randomUUID(); let body;
  try {
    const response = await fetch(`${origin}/__coord/mixed-identity`, { headers: { 'x-coord-challenge': challenge }, redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('probe refused');
    body = await response.json();
  } catch { fail('managed frontend live identity probe is unavailable', 'MIXED_RUNNER_STOPPED'); }
  const signature = signManagedProbe(runner.secret, challenge, body?.identity);
  if (typeof body?.signature !== 'string' || body.signature.length !== signature.length || !timingSafeEqual(Buffer.from(body.signature), Buffer.from(signature)) || body.identity?.instanceId !== runner.instanceId || body.identity?.baseUrl !== origin) fail('managed frontend identity probe is invalid', 'MIXED_RUNNER_IDENTITY_INVALID');
  return body.identity;
}
function leaseIdentity(lease) { return { version: lease?.version, branch: lease?.branch, sessionId: lease?.sessionId }; }
function identityHash(fact) { return digest(JSON.stringify({ mode: fact.mode, requirementId: fact.requirementId, version: fact.version, validationEpoch: fact.validationEpoch ?? 0, frontend: fact.frontend, backend: fact.backend, lease: fact.lease })); }
function assertBackend({ cwd, devSnapshot, head }) {
  if (devSnapshot?.schemaVersion !== 2 || devSnapshot.stage !== 'dev' || !/^[a-f0-9]{40}$/.test(devSnapshot.commit ?? '') || !/^[a-f0-9]{64}$/.test(devSnapshot.manifest?.sha256 ?? '') || !/^[a-f0-9]{64}$/.test(devSnapshot.sourceSnapshot?.sha256 ?? '') || devSnapshot.serviceOverride === true) fail('authoritative dev backend deployment required', 'MIXED_BACKEND_REQUIRED');
  const deployed = {};
  for (const service of BACKEND_SERVICES) {
    const fact = devSnapshot.serviceSnapshots?.[service] ?? (devSnapshot.services?.includes(service) ? {
      commit: devSnapshot.commit, artifact: devSnapshot.artifacts?.[service], manifest: devSnapshot.manifest, sourceSnapshot: devSnapshot.sourceSnapshot,
    } : null);
    if (fact?.serviceOverride === true || !/^[a-f0-9]{40}$/.test(fact?.commit ?? '') || !/^sha256:[a-f0-9]{64}$/.test(fact.artifact?.imageId ?? '') || !fact.artifact.imageTag || !/^[a-f0-9]{64}$/.test(fact.manifest?.sha256 ?? '') || !/^[a-f0-9]{64}$/.test(fact.sourceSnapshot?.sha256 ?? '')) fail(`backend deployment is missing immutable ${service} identity`, 'MIXED_BACKEND_REQUIRED');
    deployed[service] = serviceRuntimeInputs({ cwd, commit: fact.commit, services: [service] })[service];
  }
  const current = serviceRuntimeInputs({ cwd, commit: head, services: BACKEND_SERVICES });
  if (JSON.stringify(deployed) !== JSON.stringify(current)) fail('backend runtime inputs changed; deploy changed backend services before mixed testing', 'MIXED_BACKEND_INPUTS_CHANGED');
  return deployed;
}
function assertLeaseIdentity({ requirement, devLease, expected, clock, freeze, environment }) {
  const frozen = freeze?.requirementId === requirement.id && freeze?.version === requirement.version && (freeze.validationEpoch ?? 0) === (requirement.validationEpoch ?? 0) && freeze?.mixedEnvironmentIdentity === environment?.identitySha256;
  if (frozen) return;
  if (!devLease || devLease.version !== requirement.version || !devLease.sessionId || !devLease.branch || !Number.isFinite(Date.parse(devLease.expiresAt)) || Date.parse(devLease.expiresAt) <= clock().getTime() || (expected && JSON.stringify(leaseIdentity(devLease)) !== JSON.stringify(expected))) fail('mixed environment requires the matching active dev lease; lease expired or changed', 'MIXED_LEASE_CHANGED');
}
export async function prepareMixedEnvironment({ cwd, requirement, app, baseUrl, devLease, devSnapshot, clock = () => new Date() }) {
  assertRequirementId(requirement?.id);
  if (requirement.deliveryProfile !== 'runtime' || requirement.workflowVersion !== 2 || !['admin', 'web'].includes(app)) fail('mixed-dev requires a workflow v2 runtime requirement and a frontend app');
  assertMixedSourcesClean({ cwd, requirementId: requirement.id });
  assertLeaseIdentity({ requirement, devLease, clock });
  const commit = mixedSourceCommit(cwd);
  const frontend = await probeManagedFrontend({ cwd, baseUrl });
  if (frontend.app !== app || spawnSync('git', ['merge-base', '--is-ancestor', frontend.commit, commit], { cwd }).status !== 0 || frontend.inputsSha256 !== serviceRuntimeInputs({ cwd, commit, services: [app] })[app] || frontend.apiTarget !== MIXED_API_TARGET || frontend.buildValidated !== true) fail('formal frontend identity requires the current committed build; HMR is provisional', 'MIXED_FRONTEND_IDENTITY_CHANGED');
  const runtimeInputs = assertBackend({ cwd, devSnapshot, head: commit });
  const fact = { schemaVersion: 1, mode: 'mixed-dev', requirementId: requirement.id, version: requirement.version, validationEpoch: requirement.validationEpoch ?? 0,
    frontend, backend: { deployment: devSnapshot, runtimeInputs }, lease: leaseIdentity(devLease) };
  return { ...fact, identitySha256: identityHash(fact), recordedAt: clock().toISOString() };
}
export async function validateMixedEnvironment({ cwd, requirement, environment, devLease, devSnapshot, clock = () => new Date(), freeze = null, probe = true }) {
  const fact = environment;
  if (requirement.workflowVersion !== 2 || fact?.schemaVersion !== 1 || fact.invalidated === true || (fact.validationEpoch ?? 0) !== (requirement.validationEpoch ?? 0) || fact.mode !== 'mixed-dev' || fact.requirementId !== requirement.id || fact.version !== requirement.version || fact.identitySha256 !== identityHash(fact)) fail('mixed environment identity does not match the requirement', 'MIXED_IDENTITY_CHANGED');
  assertLeaseIdentity({ requirement, devLease, expected: fact.lease, clock, freeze, environment: fact });
  if (JSON.stringify(devSnapshot) !== JSON.stringify(fact.backend?.deployment)) fail('mixed backend deployment changed', 'MIXED_DEPLOYMENT_CHANGED');
  assertMixedSourcesClean({ cwd, requirementId: requirement.id });
  const currentCommit = mixedSourceCommit(cwd);
  const runtimeInputs = assertBackend({ cwd, devSnapshot, head: currentCommit });
  if (JSON.stringify(runtimeInputs) !== JSON.stringify(fact.backend.runtimeInputs)) fail('mixed backend runtime input identity changed');
  if (fact.frontend?.apiTarget !== MIXED_API_TARGET || fact.frontend.buildValidated !== true || serviceRuntimeInputs({ cwd, services: [fact.frontend.app] })[fact.frontend.app] !== fact.frontend.inputsSha256) fail('mixed frontend runtime inputs or API identity changed');
  if (probe && JSON.stringify(await probeManagedFrontend({ cwd, baseUrl: fact.frontend.baseUrl })) !== JSON.stringify(fact.frontend)) fail('running frontend instance identity changed', 'MIXED_FRONTEND_IDENTITY_CHANGED');
  return true;
}
const factPath = id => `environments/${assertRequirementId(id)}/mixed-dev.json`;
export async function showMixedEnvironment({ store, requirementId }) {
  const snapshot = await store.readSnapshot(); return snapshot.has(factPath(requirementId)) ? snapshot.readJson(factPath(requirementId)) : null;
}
export async function recordMixedEnvironment({ store, cwd, requirementId, app, baseUrl, session, clock = () => new Date() }) {
  const devLease = await assertVersionLease({ store, cwd, resource: 'dev', requirementId, session, clock });
  const snapshot = await store.readSnapshot(); const requirement = snapshot.readJson(`requirements/${assertRequirementId(requirementId)}.json`);
  const devSnapshot = snapshot.has('deployments/dev.json') ? snapshot.readJson('deployments/dev.json') : null;
  const fact = await prepareMixedEnvironment({ cwd, requirement, app, baseUrl, devLease, devSnapshot, clock });
  const update = await store.update({ operation: `record mixed environment ${requirementId}`, auditData: { kind: 'mixed-environment', requirementId, identitySha256: fact.identitySha256 }, mutate(current) {
    const lock = current.has('locks/dev.json') ? current.readJson('locks/dev.json').active : null;
    if (lock?.ownerToken !== devLease.ownerToken || Date.parse(lock.expiresAt) <= clock().getTime() || JSON.stringify(current.readJson('deployments/dev.json')) !== JSON.stringify(devSnapshot) || JSON.stringify(current.readJson(`requirements/${requirementId}.json`)) !== JSON.stringify(requirement)) fail('lease, requirement or backend deployment changed before recording mixed environment');
    const immutable = `environments/${requirementId}/${fact.identitySha256}.json`;
    if (!current.has(immutable)) current.writeJson(immutable, fact);
    current.writeJson(factPath(requirementId), current.readJson(immutable));
  } });
  return { environment: fact, operationId: update.operationId, coordinationSha: update.sha };
}

// Production consumes the immutable accepted identity, rather than requiring
// the developer's laptop runner or a frontend Docker image to exist on dev.
export function validateMixedReleaseIdentity({ cwd, requirement, environment, freeze, devSnapshot, services, evidenceSha, releaseCommit = 'HEAD' }) {
  const fact = environment;
  if (requirement.workflowVersion !== 2 || fact?.invalidated || fact?.mode !== 'mixed-dev' || fact.requirementId !== requirement.id || fact.version !== requirement.version || (fact.validationEpoch ?? 0) !== (requirement.validationEpoch ?? 0) || fact.identitySha256 !== identityHash(fact)) fail('mixed accepted identity is invalid');
  if (freeze?.requirementId !== requirement.id || freeze.version !== requirement.version || freeze.mixedEnvironmentIdentity !== fact.identitySha256 || (freeze.validationEpoch ?? 0) !== (requirement.validationEpoch ?? 0) || freeze.machineVerificationEvidence !== evidenceSha || !freeze.acceptance?.authorizedBy || !/^user-message:[A-Za-z0-9._:-]{6,}$/.test(freeze.acceptance?.instructionRef ?? '') || !Number.isFinite(Date.parse(freeze.acceptance?.acceptedAt))) fail('current explicit human acceptance of mixed identity is required', 'MIXED_ACCEPTANCE_REQUIRED');
  if (JSON.stringify(devSnapshot) !== JSON.stringify(fact.backend.deployment) || JSON.stringify(freeze.deploymentSnapshot) !== JSON.stringify(devSnapshot)) fail('accepted backend deployment identity changed');
  if (fact.frontend.apiTarget !== MIXED_API_TARGET || fact.frontend.buildValidated !== true) fail('accepted frontend API/build identity is invalid');
  const expected = { ...fact.backend.runtimeInputs, [fact.frontend.app]: fact.frontend.inputsSha256 };
  if (!Array.isArray(services) || !services.length || services.some(s => !expected[s])) fail('production service lacks an accepted mixed runtime identity');
  const actual = serviceRuntimeInputs({ cwd, commit: releaseCommit, services });
  if (services.some(s => actual[s] !== expected[s])) fail('production runtime inputs differ from accepted mixed frontend/backend inputs', 'MIXED_RELEASE_INPUTS_CHANGED');
  return { valid: true, identitySha256: fact.identitySha256, runtimeInputs: actual, services };
}
