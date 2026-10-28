import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { assertRequirementId, normalizeDuration } from './validation.mjs';
import { isBacklogProjectionDescendant } from './repository-projection.mjs';
import { classifyRevisionRange } from './revision-policy.mjs';
import { gitCommonDir, loadSession } from './worktrees.mjs';

const RESOURCES = new Set(['dev', 'prod', 'prod-build']);
// I-113 Task 5: the prod-build lock serializes candidate prebuilds on the
// prod host and is mutually exclusive with the formal prod deploy/rollback
// lease. It never grants release permission by itself.
const PROD_BUILD_MUTEX = Object.freeze({
  'prod-build': 'prod',
  prod: 'prod-build',
});
const OWNER_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class LeaseError extends Error {
  constructor(message, { code, exitCode = 14, data = {}, cause } = {}) {
    super(message, { cause });
    this.name = 'LeaseError';
    this.code = code;
    this.exitCode = exitCode;
    this.data = data;
  }
}

// freezes.mjs（I-113 Task 3）复用以下 lease 内部语义（持有、过期、身份、
// 本地 token、锁文件读写），避免在 freeze 路径复制同一套判定；这些 helper
// 不属于对外 CLI 契约，仅供 coordination 内部模块使用。

function validateResource(resource) {
  if (!RESOURCES.has(resource)) {
    throw new LeaseError(`invalid lease resource: ${resource ?? '<missing>'}`, {
      code: 'INVALID_LEASE_RESOURCE',
    });
  }
  return resource;
}

function validateRequirementId(id) {
  try {
    return assertRequirementId(id);
  } catch (error) {
    throw new LeaseError(error.message, {
      code: 'INVALID_REQUIREMENT_ID',
      cause: error,
    });
  }
}

function durationMs(ttl) {
  try {
    return normalizeDuration(ttl);
  } catch (error) {
    throw new LeaseError(error.message, { code: 'INVALID_TTL', cause: error });
  }
}

function nowFrom(clock) {
  const now = clock();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new LeaseError('lease clock returned an invalid date', {
      code: 'INVALID_LEASE_CLOCK',
    });
  }
  return now;
}

function runGit(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    const message = result.stderr || result.error?.message || 'git command failed';
    throw new LeaseError(`git ${args.join(' ')} failed: ${message.trim()}`, {
      code: 'GIT_LEASE_ERROR',
      exitCode: 13,
    });
  }
  return result.stdout.trim();
}

export function currentRevision(cwd) {
  const branch = runGit(cwd, ['branch', '--show-current']);
  const commit = runGit(cwd, ['rev-parse', 'HEAD']);
  if (!branch) {
    throw new LeaseError('a lease cannot be held from a detached HEAD', {
      code: 'DETACHED_HEAD',
    });
  }
  return { branch, commit };
}

function isAncestor(cwd, ancestor, descendant) {
  return spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
    cwd,
    stdio: ['ignore', 'ignore', 'ignore'],
  }).status === 0;
}

export function knownSession(cwd, session) {
  if (!session || typeof session !== 'object') {
    throw new LeaseError('a local coordination session is required', {
      code: 'SESSION_REQUIRED',
    });
  }
  return loadSession({ cwd, sessionId: session.sessionId });
}

export function actor(session) {
  return {
    sessionId: session.sessionId,
    agent: session.agent,
    user: session.user,
    host: session.host,
  };
}

function requirementFromSnapshot(snapshot, id) {
  const path = `requirements/${validateRequirementId(id)}.json`;
  if (!snapshot.has(path)) {
    throw new LeaseError(`requirement is not claimed: ${id}`, {
      code: 'REQUIREMENT_NOT_FOUND',
    });
  }
  return snapshot.readJson(path);
}

// I-130 (D1): Lease v2 binds the lock to the requirement's release version.
// A requirement without a bound version can never acquire or assert a lease.
function boundRequirementVersion(requirement, id) {
  if (typeof requirement?.version !== 'string' || requirement.version.trim() === '') {
    throw new LeaseError(`${id} is not bound to a release version`, {
      code: 'REQUIREMENT_VERSION_UNBOUND',
      exitCode: 12,
      data: { requirementId: id },
    });
  }
  return requirement.version;
}

function assertRequirementRevision(requirement, id, revision, cwd) {
  if (!requirement.branch) {
    throw new LeaseError(`${id} must be bound to a branch before acquiring a lease`, {
      code: 'BRANCH_REQUIRED',
    });
  }
  const mergedMainRevision = requirement.deliveryProfile === 'runtime'
    && requirement.mergeStatus === 'merged'
    && typeof requirement.mergedCommit === 'string'
    && (
      requirement.mergedCommit === revision.commit
      || isAncestor(cwd, requirement.mergedCommit, revision.commit)
    );
  if (requirement.branch !== revision.branch && !mergedMainRevision) {
    throw new LeaseError(
      `${id} is bound to ${requirement.branch}, not ${revision.branch}`,
      {
        code: 'BRANCH_MISMATCH',
        data: { expected: requirement.branch, actual: revision.branch },
      },
    );
  }
}

function lockPath(resource) {
  return `locks/${validateResource(resource)}.json`;
}

// Single freeze-fact parser/validator (I-113 review) shared by leases.mjs
// (acquire/break) and freezes.mjs (enter/show). A missing fact returns null;
// any malformed fact — wrong shape, wrong schemaVersion/resource/state, or a
// missing required binding field — fails closed with INVALID_FREEZE_STATE so
// no path can silently overwrite or bypass corrupt freeze state.
const FREEZE_FACT_STATE = 'awaiting_human';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function invalidFreezeStateError(resource, cause) {
  return new LeaseError(`invalid ${resource} freeze state`, {
    code: 'INVALID_FREEZE_STATE',
    ...(cause ? { cause } : {}),
  });
}

export function freezeFactFromSnapshot(snapshot, resource) {
  validateResource(resource);
  const path = `freezes/${resource}.json`;
  if (!snapshot.has(path)) return null;
  let fact;
  try {
    fact = snapshot.readJson(path);
  } catch (error) {
    throw invalidFreezeStateError(resource, error);
  }
  const valid = isPlainObject(fact)
    && fact.schemaVersion === 1
    && fact.resource === resource
    && fact.state === FREEZE_FACT_STATE
    && isNonEmptyString(fact.requirementId)
    && isNonEmptyString(fact.version)
    && isNonEmptyString(fact.candidateId)
    && isPlainObject(fact.deploymentSnapshot)
    && isNonEmptyString(fact.machineVerificationEvidence)
    && isNonEmptyString(fact.branch)
    && isNonEmptyString(fact.commit)
    && isNonEmptyString(fact.frozenAt)
    && !Number.isNaN(Date.parse(fact.frozenAt))
    && isPlainObject(fact.actor);
  if (!valid) throw invalidFreezeStateError(resource);
  return fact;
}

// A durable awaiting_human freeze fact (I-113 Task 3) blocks any acquire or
// break — including force breaks — until a human accept/reject/release path
// clears it.
function freezeActiveError(resource, fact) {
  return new LeaseError(`${resource} is frozen awaiting a human decision`, {
    code: 'FREEZE_ACTIVE',
    exitCode: 10,
    data: {
      resource,
      requirementId: fact.requirementId ?? null,
      candidateId: fact.candidateId ?? null,
    },
  });
}

function emptyLock(resource) {
  return {
    schemaVersion: 2,
    resource,
    active: null,
    lastEvent: null,
  };
}

export function lockFromSnapshot(snapshot, resource) {
  const path = lockPath(resource);
  if (!snapshot.has(path)) return emptyLock(resource);
  const lock = snapshot.readJson(path);
  if (
    lock === null
    || typeof lock !== 'object'
    || Array.isArray(lock)
    // I-130 (D4): v2 is the write target; pre-migration v1 locks stay
    // readable until `coord migrate-schema` rewrites them.
    || (lock.schemaVersion !== 1 && lock.schemaVersion !== 2)
    || lock.resource !== resource
    || (lock.active !== null && typeof lock.active !== 'object')
  ) {
    throw new LeaseError(`invalid ${resource} lease state`, {
      code: 'INVALID_LEASE_STATE',
    });
  }
  return lock;
}

function expiryTime(active) {
  const expiresAt = Date.parse(active.expiresAt);
  if (Number.isNaN(expiresAt)) {
    throw new LeaseError('active lease has an invalid expiry', {
      code: 'INVALID_LEASE_STATE',
    });
  }
  return expiresAt;
}

function isOccupied(active, now) {
  if (!active) return false;
  return now.getTime() <= expiryTime(active) + CLOCK_SKEW_MS;
}

function isExpired(active, now) {
  return now.getTime() > expiryTime(active);
}

function expiredError(resource, active) {
  return new LeaseError(`${resource} lease has expired`, {
    code: 'LEASE_EXPIRED',
    exitCode: 11,
    data: { resource, expiresAt: active.expiresAt },
  });
}

function occupiedError(resource, active) {
  return new LeaseError(`${resource} is occupied by ${active.holder?.id ?? 'another requirement'}`, {
    code: 'RESOURCE_OCCUPIED',
    exitCode: 10,
    data: {
      resource,
      requirementId: active.holder?.id,
      version: active.version ?? null,
      sessionId: active.sessionId,
      branch: active.branch,
      commit: active.commit,
      expiresAt: active.expiresAt,
    },
  });
}

function notHolderError(resource) {
  return new LeaseError(`current session does not hold the ${resource} lease`, {
    code: 'NOT_LEASE_HOLDER',
    exitCode: 10,
    data: { resource },
  });
}

// Shared deployment-reuse rule (I-095 TECH_DESIGN §6): an earlier commit still matches
// the current revision when it is an ancestor and the whole range is not
// runtime-affecting (evidence/deployment-neutral). Tolerance means the image does not
// need a rebuild; it never implies the HEAD is tested. The legacy BACKLOG-only
// projection fast path stays; policy errors and hard failures stay fail-closed.
// I-130 (D1 + review fix): since Lease v2 the lease itself no longer anchors a
// commit; callers anchor this check on the immutable devSnapshot.commit. It is
// the single drift-tolerance rule behind the lifecycle dev gate (pre-computed
// in the CLI) and the evidence paths (runRequiredTests/validateTestEvidence).
export function revisionMatchesDeployment({ cwd, requirementId, fromCommit, toCommit }) {
  if (fromCommit === toCommit) return { matches: true, policy: null };
  if (isBacklogProjectionDescendant({ cwd, ancestor: fromCommit, descendant: toCommit })) {
    return { matches: true, policy: null };
  }
  const resolvedTo = /^[0-9a-f]{40}$/.test(toCommit ?? '')
    ? toCommit
    : runGit(cwd, ['rev-parse', `${toCommit}^{commit}`]);
  let policy;
  try {
    policy = classifyRevisionRange({
      cwd,
      requirementId,
      fromSha: fromCommit,
      toSha: resolvedTo,
    });
  } catch (error) {
    return {
      matches: false,
      policy: {
        classification: null,
        code: typeof error?.code === 'string' ? error.code : 'REVISION_POLICY_ERROR',
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  }
  return {
    matches: policy.valid && policy.classification !== 'runtime-affecting',
    policy: {
      classification: policy.classification ?? null,
      code: policy.code ?? null,
      reason: policy.reason ?? null,
    },
  };
}

function tokenDirectory(cwd) {
  return join(gitCommonDir(cwd), 'coordination', 'lease-tokens');
}

function operationDirectory(cwd) {
  return join(gitCommonDir(cwd), 'coordination', 'lease-operations');
}

function operationPath(cwd, operationId) {
  if (!OPERATION_ID_PATTERN.test(operationId ?? '')) {
    throw new LeaseError(`invalid operation id: ${operationId ?? '<missing>'}`, {
      code: 'INVALID_OPERATION_ID',
    });
  }
  return join(operationDirectory(cwd), `${operationId}.json`);
}

function writeOperationRecord(cwd, record) {
  const directory = operationDirectory(cwd);
  mkdirSync(directory, { recursive: true });
  const target = operationPath(cwd, record.operationId);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
}

function readOperationRecord(cwd, operationId) {
  const path = operationPath(cwd, operationId);
  if (!existsSync(path)) return null;
  try {
    const record = JSON.parse(readFileSync(path, 'utf8'));
    if (
      record.schemaVersion !== 1
      || record.operationId !== operationId
      || !RESOURCES.has(record.resource)
      || !OWNER_TOKEN_PATTERN.test(record.ownerToken ?? '')
    ) {
      throw new Error('invalid lease operation record');
    }
    return record;
  } catch (error) {
    throw new LeaseError(`invalid local lease operation: ${operationId}`, {
      code: 'INVALID_LOCAL_OPERATION',
      cause: error,
    });
  }
}

function deleteOperationRecord(cwd, operationId) {
  const path = operationPath(cwd, operationId);
  if (existsSync(path)) unlinkSync(path);
}

function tokenPath(cwd, resource, sessionId) {
  return join(tokenDirectory(cwd), `${validateResource(resource)}-${sessionId}.json`);
}

function writeLocalToken(cwd, resource, session, ownerToken) {
  const directory = tokenDirectory(cwd);
  mkdirSync(directory, { recursive: true });
  const target = tokenPath(cwd, resource, session.sessionId);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({
    schemaVersion: 1,
    resource,
    sessionId: session.sessionId,
    ownerToken,
  }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
}

function deleteLocalToken(cwd, resource, session) {
  const path = tokenPath(cwd, resource, session.sessionId);
  if (existsSync(path)) unlinkSync(path);
}

function readLocalToken(cwd, resource, session) {
  const path = tokenPath(cwd, resource, session.sessionId);
  if (!existsSync(path)) throw notHolderError(resource);
  try {
    const document = JSON.parse(readFileSync(path, 'utf8'));
    if (
      document.schemaVersion !== 1
      || document.resource !== resource
      || document.sessionId !== session.sessionId
      || !OWNER_TOKEN_PATTERN.test(document.ownerToken ?? '')
    ) {
      throw new Error('invalid token document');
    }
    return document.ownerToken;
  } catch (error) {
    if (error instanceof LeaseError) throw error;
    throw new LeaseError(`invalid local ${resource} lease token`, {
      code: 'INVALID_LOCAL_LEASE_TOKEN',
      cause: error,
    });
  }
}

export function resolvedToken({ cwd, resource, session, ownerToken }) {
  const token = ownerToken ?? readLocalToken(cwd, resource, session);
  if (!OWNER_TOKEN_PATTERN.test(token ?? '')) throw notHolderError(resource);
  return token;
}

function owns(active, session, ownerToken) {
  return active?.sessionId === session.sessionId && active.ownerToken === ownerToken;
}

function leaseResult(resource, active) {
  return { resource, ...active };
}

// Narrow internal export (I-113 review): freezes.mjs reuses the same durable
// local operation record + audit metadata (kind 'lease') + uncertain-push
// handling for the freeze conversion, so an exit-15 enterFreeze reconciles
// exactly like acquire/renew/release/break. Not part of the public CLI contract.
export async function updateLeaseState({
  store,
  cwd,
  resource,
  action,
  ownerToken,
  session,
  requirementId,
  clock,
  operation,
  mutate,
}) {
  const operationId = randomUUID();
  const baseRecord = {
    schemaVersion: 1,
    operationId,
    resource,
    action,
    ownerToken,
    sessionId: session.sessionId,
    ...(requirementId ? { requirementId } : {}),
    createdAt: nowFrom(clock).toISOString(),
    status: 'pending',
  };
  writeOperationRecord(cwd, baseRecord);
  let result;
  try {
    result = await store.update({
      operation,
      operationId,
      auditData: {
        kind: 'lease',
        resource,
        action,
        ownerToken,
        sessionId: session.sessionId,
        ...(requirementId ? { requirementId } : {}),
      },
      // I-134 (F2): the mutate receives the update's operationId so callers
      // can bind audit artifacts (the force-break record) to the operation.
      mutate: (snapshot) => mutate(snapshot, { operationId }),
    });
  } catch (error) {
    if (error?.exitCode === 15) {
      writeOperationRecord(cwd, { ...baseRecord, status: 'uncertain' });
    } else {
      deleteOperationRecord(cwd, operationId);
    }
    throw error;
  }
  writeOperationRecord(cwd, {
    ...baseRecord,
    status: 'applied',
    coordinationSha: result.sha,
  });
  return { ...result, operationId };
}

export async function acquireLease({
  store,
  cwd,
  resource,
  requirementId,
  ttl,
  session,
  clock = () => new Date(),
}) {
  validateResource(resource);
  validateRequirementId(requirementId);
  const leaseDurationMs = durationMs(ttl);
  const localSession = knownSession(cwd, session);
  const revision = currentRevision(cwd);
  const ownerToken = randomUUID();
  let active;

  const update = await updateLeaseState({
    store,
    cwd,
    resource,
    action: 'acquire',
    ownerToken,
    session: localSession,
    requirementId,
    clock,
    operation: `acquire ${resource} lease for ${requirementId}`,
    mutate(snapshot) {
      const freezeFact = freezeFactFromSnapshot(snapshot, resource);
      if (freezeFact) throw freezeActiveError(resource, freezeFact);
      const now = nowFrom(clock);
      const requirement = requirementFromSnapshot(snapshot, requirementId);
      const version = boundRequirementVersion(requirement, requirementId);
      assertRequirementRevision(requirement, requirementId, revision, cwd);
      const lock = lockFromSnapshot(snapshot, resource);
      // I-130 (D1): an occupied slot passes to a same-version acquire as a
      // takeover (same path as an expired takeover, lastEvent records the
      // previous holder); a different version keeps the occupied conflict.
      if (isOccupied(lock.active, now) && lock.active.version !== version) {
        throw occupiedError(resource, lock.active);
      }
      // I-113 Task 5: prod-build and the formal prod lease are mutually
      // exclusive — a prebuild must never race a deploy/rollback, and a
      // deploy must never start while a candidate prebuild is running.
      const mutexResource = PROD_BUILD_MUTEX[resource];
      if (mutexResource) {
        const mutexLock = lockFromSnapshot(snapshot, mutexResource);
        if (isOccupied(mutexLock.active, now)) {
          const blocked = resource === 'prod'
            ? 'PROD_LEASE_BLOCKED_BY_BUILD'
            : 'PROD_BUILD_BLOCKED_BY_LEASE';
          throw new LeaseError(
            `${resource} is blocked by the active ${mutexResource} lock`,
            {
              code: blocked,
              exitCode: 10,
              data: {
                resource,
                blockedBy: mutexResource,
                holderId: mutexLock.active.holder?.id ?? null,
                expiresAt: mutexLock.active.expiresAt ?? null,
              },
            },
          );
        }
      }

      const previous = lock.active;
      active = {
        holder: { kind: 'requirement', id: requirementId },
        version,
        sessionId: localSession.sessionId,
        branch: revision.branch,
        commit: revision.commit,
        ownerToken,
        acquiredAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + leaseDurationMs).toISOString(),
      };
      snapshot.writeJson(lockPath(resource), {
        schemaVersion: 2,
        resource,
        active,
        lastEvent: {
          type: previous ? 'takeover' : 'acquire',
          at: now.toISOString(),
          actor: actor(localSession),
          ...(previous ? { previous } : {}),
        },
      });
    },
  });

  writeLocalToken(cwd, resource, localSession, ownerToken);
  return {
    ...leaseResult(resource, active),
    operationId: update.operationId,
    coordinationSha: update.sha,
  };
}

export async function renewLease({
  store,
  cwd,
  resource,
  ttl,
  session,
  ownerToken,
  clock = () => new Date(),
}) {
  validateResource(resource);
  const leaseDurationMs = durationMs(ttl);
  const localSession = knownSession(cwd, session);
  const token = resolvedToken({ cwd, resource, session: localSession, ownerToken });
  const revision = currentRevision(cwd);
  let renewed;

  const update = await updateLeaseState({
    store,
    cwd,
    resource,
    action: 'renew',
    ownerToken: token,
    session: localSession,
    requirementId: null,
    clock,
    operation: `renew ${resource} lease`,
    mutate(snapshot) {
      const now = nowFrom(clock);
      const lock = lockFromSnapshot(snapshot, resource);
      if (!owns(lock.active, localSession, token)) throw notHolderError(resource);
      if (isExpired(lock.active, now)) throw expiredError(resource, lock.active);
      // I-130 (D1): float-commit — renewing moves the lease commit to the
      // current branch tip instead of requiring commit equality; only branch
      // drift is still rejected.
      if (lock.active.branch !== revision.branch) {
        throw new LeaseError('working tree branch no longer matches the active lease', {
          code: 'LEASE_REVISION_MISMATCH',
          exitCode: 11,
        });
      }
      renewed = {
        ...lock.active,
        commit: revision.commit,
        expiresAt: new Date(now.getTime() + leaseDurationMs).toISOString(),
      };
      snapshot.writeJson(lockPath(resource), {
        ...lock,
        // I-130 (D4): writes converge on v2 even when the read lock was a
        // pre-migration v1 document.
        schemaVersion: 2,
        active: renewed,
        lastEvent: {
          type: 'renew',
          at: now.toISOString(),
          actor: actor(localSession),
          previous: lock.active,
        },
      });
    },
  });

  writeLocalToken(cwd, resource, localSession, token);
  return {
    ...leaseResult(resource, renewed),
    operationId: update.operationId,
    coordinationSha: update.sha,
  };
}

// I-134 (F1): the lease assertion is split into two segments with a single
// source of truth. The identity segment (holder, expiry, version binding) is
// shared by both entry points below; assertVersionLease adds only the branch
// leg of the revision segment (the commit leg is exempt — the lease commit
// floats to the branch tip on renew); assertLease runs the full revision
// segment (working-tree branch + expected commit equality) on top of it.
async function assertLeaseIdentity({
  store,
  resource,
  requirementId,
  localSession,
  token,
  clock,
}) {
  const now = nowFrom(clock);
  const snapshot = await store.readSnapshot();
  const lock = lockFromSnapshot(snapshot, resource);
  if (!owns(lock.active, localSession, token)) throw notHolderError(resource);
  if (isExpired(lock.active, now)) throw expiredError(resource, lock.active);
  // I-130 (D1): identity is version-level — the holder recorded on the lock
  // is informational; any requirement bound to the same version asserts.
  const version = boundRequirementVersion(
    requirementFromSnapshot(snapshot, requirementId),
    requirementId,
  );
  if (lock.active.version !== version) {
    throw new LeaseError(
      `${resource} lease is bound to ${lock.active.version ?? '<no version>'}, not ${version}`,
      {
        code: 'LEASE_VERSION_MISMATCH',
        exitCode: 11,
        data: {
          resource,
          requirementId,
          leaseVersion: lock.active.version ?? null,
          requirementVersion: version,
        },
      },
    );
  }
  return lock.active;
}

export async function assertLease({
  store,
  cwd,
  resource,
  requirementId,
  session,
  ownerToken,
  commit = 'HEAD',
  // I-130 (D1): deprecated and ignored — the lease no longer anchors a
  // commit, so the backlog-projection tolerance is meaningless. The parameter
  // stays only so existing call sites keep working.
  allowBacklogProjection = false,
  clock = () => new Date(),
}) {
  validateResource(resource);
  validateRequirementId(requirementId);
  void allowBacklogProjection;
  const localSession = knownSession(cwd, session);
  const token = resolvedToken({ cwd, resource, session: localSession, ownerToken });
  const revision = currentRevision(cwd);
  if (!/^(HEAD|[0-9a-f]{7,40})$/.test(commit ?? '')) {
    throw new LeaseError(`invalid expected commit: ${commit ?? '<missing>'}`, {
      code: 'INVALID_EXPECTED_COMMIT',
    });
  }
  const expectedCommit = runGit(cwd, ['rev-parse', `${commit}^{commit}`]);
  const active = await assertLeaseIdentity({
    store,
    resource,
    requirementId,
    localSession,
    token,
    clock,
  });
  if (active.branch !== revision.branch || revision.commit !== expectedCommit) {
    throw new LeaseError('working tree does not match the active lease', {
      code: 'LEASE_REVISION_MISMATCH',
      exitCode: 11,
    });
  }
  return leaseResult(resource, active);
}

// I-134 (F1): version-level assertion — the identity segment (holder,
// expiry, version binding) plus the branch leg of the revision segment. Only
// the commit leg is exempt: the lease commit floats to the branch tip on
// renew, so a neutral commit on top of it (e.g. a BACKLOG projection) must
// not invalidate a deployment record. The branch leg never floats — and the
// local lease token lives in the shared git common dir, so without this
// check a session holding the lease could assert it from any branch
// checkout and record that branch's history as the lease branch's
// deployment (I-134 review).
export async function assertVersionLease({
  store,
  cwd,
  resource,
  requirementId,
  session,
  ownerToken,
  clock = () => new Date(),
}) {
  validateResource(resource);
  validateRequirementId(requirementId);
  const localSession = knownSession(cwd, session);
  const token = resolvedToken({ cwd, resource, session: localSession, ownerToken });
  const active = await assertLeaseIdentity({
    store,
    resource,
    requirementId,
    localSession,
    token,
    clock,
  });
  const revision = currentRevision(cwd);
  if (active.branch !== revision.branch) {
    throw new LeaseError(
      `working tree branch ${revision.branch} does not match the active ${resource} lease branch ${active.branch}`,
      {
        code: 'LEASE_REVISION_MISMATCH',
        exitCode: 11,
        data: { resource, expected: active.branch, actual: revision.branch },
      },
    );
  }
  return leaseResult(resource, active);
}

export async function releaseLease({
  store,
  cwd,
  resource,
  session,
  ownerToken,
  clock = () => new Date(),
}) {
  validateResource(resource);
  const localSession = knownSession(cwd, session);
  // A durable awaiting_human freeze fact (I-113 Task 3) blocks dev release:
  // the freeze slot owns the resource until a human accept/reject/release
  // path runs. The check must precede the local-token lookup because the
  // freeze conversion already deleted the holder's token.
  if (resource === 'dev') {
    const snapshot = await store.readSnapshot();
    const freezeFact = freezeFactFromSnapshot(snapshot, resource);
    if (freezeFact) throw freezeActiveError(resource, freezeFact);
  }
  const token = resolvedToken({ cwd, resource, session: localSession, ownerToken });
  let previous;

  const update = await updateLeaseState({
    store,
    cwd,
    resource,
    action: 'release',
    ownerToken: token,
    session: localSession,
    requirementId: null,
    clock,
    operation: `release ${resource} lease`,
    mutate(snapshot) {
      const now = nowFrom(clock);
      const lock = lockFromSnapshot(snapshot, resource);
      if (!owns(lock.active, localSession, token)) throw notHolderError(resource);
      previous = lock.active;
      snapshot.writeJson(lockPath(resource), {
        ...lock,
        schemaVersion: 2,
        active: null,
        lastEvent: {
          type: 'release',
          at: now.toISOString(),
          actor: actor(localSession),
          previous,
        },
      });
    },
  });

  deleteLocalToken(cwd, resource, localSession);
  return {
    resource,
    released: true,
    previous,
    operationId: update.operationId,
    coordinationSha: update.sha,
  };
}

// I-134 (F2): durable force-break audit record path. The resource is already
// validateResource-safe; the ISO timestamp's colons become hyphens so the
// file name stays portable.
function forceBreakAuditPath(resource, now) {
  return `operations/force-breaks/${now.toISOString().replace(/:/g, '-')}-${resource}.json`;
}

export async function breakLease({
  store,
  cwd,
  resource,
  reason,
  force = false,
  session,
  clock = () => new Date(),
}) {
  validateResource(resource);
  const normalizedReason = typeof reason === 'string' ? reason.trim() : '';
  if (normalizedReason.length < 10) {
    throw new LeaseError('break reason must be at least 10 characters', {
      code: 'INVALID_BREAK_REASON',
    });
  }
  if (normalizedReason.length > 500 || /[\r\n]/.test(normalizedReason)) {
    throw new LeaseError('break reason must be a single line of at most 500 characters', {
      code: 'INVALID_BREAK_REASON',
    });
  }
  const localSession = knownSession(cwd, session);
  const operationToken = randomUUID();
  let previous;

  const update = await updateLeaseState({
    store,
    cwd,
    resource,
    action: 'break',
    ownerToken: operationToken,
    session: localSession,
    requirementId: null,
    clock,
    operation: `break ${resource} lease`,
    mutate(snapshot, { operationId }) {
      // The shared freeze-fact helper fails closed: a valid fact blocks the
      // break (force included) and a malformed fact stops it with
      // INVALID_FREEZE_STATE instead of being silently bypassed.
      const freezeFact = freezeFactFromSnapshot(snapshot, resource);
      if (freezeFact) throw freezeActiveError(resource, freezeFact);
      const now = nowFrom(clock);
      const lock = lockFromSnapshot(snapshot, resource);
      if (lock.active && isOccupied(lock.active, now) && !force) {
        throw occupiedError(resource, lock.active);
      }
      previous = lock.active;
      // I-134 (F2): a force break of an occupied lease leaves a durable audit
      // fact — breaker, the full previous holder snapshot, reason and
      // operation id — inside the same coordination commit. A natural break
      // of an expired lease and any non-force break write nothing.
      if (force && lock.active && isOccupied(lock.active, now)) {
        snapshot.writeJson(forceBreakAuditPath(resource, now), {
          schemaVersion: 1,
          resource,
          reason: normalizedReason,
          brokenAt: now.toISOString(),
          breaker: actor(localSession),
          previousActive: lock.active,
          operationId,
        });
      }
      snapshot.writeJson(lockPath(resource), {
        ...lock,
        schemaVersion: 2,
        active: null,
        lastEvent: {
          type: 'break',
          at: now.toISOString(),
          actor: actor(localSession),
          reason: normalizedReason,
          ...(previous ? { previous } : {}),
        },
      });
    },
  });

  deleteLocalToken(cwd, resource, localSession);
  return {
    resource,
    broken: true,
    previous,
    reason: normalizedReason,
    operationId: update.operationId,
    coordinationSha: update.sha,
  };
}

// Narrow shared primitive for the freeze conversion (I-113 Task 3): assert
// that the given session owns the active, unexpired lease for requirementId,
// then release the slot inside an in-progress snapshot mutation and return
// the consumed lease. Ownership and expiry semantics stay defined here;
// callers write their own state (e.g. the freeze fact) in the same update.
export function consumeActiveLeaseInSnapshot({
  snapshot,
  cwd,
  resource,
  requirementId,
  session,
  ownerToken,
  now,
  eventType,
  eventActor,
}) {
  validateResource(resource);
  validateRequirementId(requirementId);
  const lock = lockFromSnapshot(snapshot, resource);
  const token = resolvedToken({ cwd, resource, session, ownerToken });
  if (!owns(lock.active, session, token)) throw notHolderError(resource);
  if (isExpired(lock.active, now)) throw expiredError(resource, lock.active);
  if (lock.active.holder?.id !== requirementId) {
    throw new LeaseError(
      `${resource} lease is held for ${lock.active.holder?.id ?? 'another requirement'}, not ${requirementId}`,
      {
        code: 'LEASE_REQUIREMENT_MISMATCH',
        data: { resource, requirementId, holderId: lock.active.holder?.id ?? null },
      },
    );
  }
  const previous = lock.active;
  snapshot.writeJson(lockPath(resource), {
    ...lock,
    schemaVersion: 2,
    active: null,
    lastEvent: {
      type: eventType,
      at: now.toISOString(),
      actor: eventActor,
      previous,
    },
  });
  return previous;
}

// Local token cleanup companion to consumeActiveLeaseInSnapshot: the caller
// runs it only after the coordination update was applied.
export function releaseLocalLeaseToken({ cwd, resource, session }) {
  validateResource(resource);
  deleteLocalToken(cwd, resource, session);
}

// Narrow internal export (I-113 Task 3 accept/reject slice): rejectFreeze
// atomically converts a freeze fact back into a fresh machine_verifying dev
// lease and must persist the new owner token locally after the update — the
// same write acquireLease/renewLease do internally. Not part of the public
// CLI contract.
export function writeLocalLeaseToken({ cwd, resource, session, ownerToken }) {
  validateResource(resource);
  writeLocalToken(cwd, resource, session, ownerToken);
}

export async function reconcileLeaseOperation({ store, cwd, operationId }) {
  const local = readOperationRecord(cwd, operationId);
  const reconciliation = await store.reconcileOperation(operationId);
  const metadata = reconciliation.operation?.metadata;
  if (
    reconciliation.applied
    && local
    && metadata?.kind === 'lease'
    && metadata.resource === local.resource
    && metadata.action === local.action
    && metadata.ownerToken === local.ownerToken
  ) {
    writeOperationRecord(cwd, {
      ...local,
      status: 'reconciled',
      coordinationSha: reconciliation.sha,
    });
    // The freeze conversion consumed the lease remotely; on an uncertain push
    // the local token cleanup never ran, so reconcile closes it out here.
    if (local.action === 'freeze') {
      deleteLocalToken(cwd, local.resource, { sessionId: local.sessionId });
    }
    return {
      applied: true,
      operationId,
      resource: local.resource,
      action: local.action,
      ownerToken: local.ownerToken,
      coordinationSha: reconciliation.sha,
    };
  }

  // I-128 (H3): the audit record is committed in the same coordination commit
  // as the mutation, so once the snapshot is readable the outcome is decisive
  // for every operation kind. Only lease operations with a matching local
  // record need the local close-out above; everything else is reported
  // straight from the audit trail instead of staying "uncertain" forever.
  return {
    applied: reconciliation.applied,
    operationId,
    operation: reconciliation.operation?.operation ?? null,
    metadata: metadata ?? null,
    localRecordFound: local !== null,
    coordinationSha: reconciliation.sha,
  };
}

// Freeze facts (I-113 Task 3) reuse the lease state machine's parsing,
// ownership, expiry and identity helpers so both modules enforce exactly the
// same holder semantics. Only the helpers freezes.mjs actually consumes are
// exported inline at their declarations above; the public lease API is
// unchanged.
