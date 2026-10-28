import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { assertRequirementId } from './validation.mjs';

const SHARED_STAGES = ['dev', 'prod'];
const STAGES = new Set(['auto', ...SHARED_STAGES]);
const GUARD_TICKET_PATTERN = /^[0-9a-f]{64}$/;
const GUARD_TICKET_TTL_MS = 30 * 60 * 1000;
const CANONICAL_SHARED_ENVIRONMENTS = Object.freeze({
  dev: Object.freeze({ hosts: Object.freeze([
    'admin-dev.hongli-ruian.com',
    'api-dev.hongli-ruian.com',
    'web-dev.hongli-ruian.com',
  ]) }),
  prod: Object.freeze({ hosts: Object.freeze([
    'admin.hongli-ruian.com',
    'api.hongli-ruian.com',
    'hongli-ruian.com',
  ]) }),
});

export class SharedEnvironmentGuardError extends Error {
  constructor(message, { code = 'SHARED_ENV_GUARD_FAILED', data = {}, cause } = {}) {
    super(message, { cause });
    this.name = 'SharedEnvironmentGuardError';
    this.code = code;
    this.exitCode = 14;
    this.data = data;
  }
}

function normalizeHost(host) {
  return String(host ?? '').trim().toLowerCase().replace(/\.$/, '');
}

function normalizeStage(stage) {
  const value = String(stage ?? '').trim().toLowerCase();
  if (!STAGES.has(value)) {
    throw new SharedEnvironmentGuardError(`invalid shared environment stage: ${stage ?? '<missing>'}`, {
      code: 'INVALID_SHARED_ENV_STAGE',
    });
  }
  return value;
}

// The shared-environment host list is a deliberate fail-closed constant: a
// repo-local config file must never be able to widen (or shrink) the set of
// hosts that require a lease (I-128/L18). Any argument passed by legacy call
// sites is intentionally ignored.
export function loadSharedEnvironmentPolicy() {
  return Object.fromEntries(SHARED_STAGES.map((stage) => [
    stage,
    { hosts: [...CANONICAL_SHARED_ENVIRONMENTS[stage].hosts] },
  ]));
}

function targetHost(target) {
  let url;
  try {
    url = new URL(target);
  } catch (error) {
    throw new SharedEnvironmentGuardError(`invalid shared environment target: ${target}`, {
      code: 'INVALID_SHARED_ENV_TARGET',
      cause: error,
    });
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new SharedEnvironmentGuardError(`shared environment target must use http or https: ${target}`, {
      code: 'INVALID_SHARED_ENV_TARGET',
    });
  }
  return normalizeHost(url.hostname);
}

function ticketDigest(ticket) {
  if (!GUARD_TICKET_PATTERN.test(ticket ?? '')) {
    throw new SharedEnvironmentGuardError('invalid shared environment guard ticket', {
      code: 'INVALID_GUARD_TICKET',
    });
  }
  return createHash('sha256').update(ticket).digest('hex');
}

function resolvedCommit(cwd, commit) {
  const result = spawnSync('git', ['rev-parse', `${commit}^{commit}`], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const sha = result.stdout?.trim();
  if (result.status !== 0 || !/^[0-9a-f]{40}$/.test(sha ?? '')) {
    throw new SharedEnvironmentGuardError(`cannot resolve guarded commit: ${commit}`, {
      code: 'INVALID_EXPECTED_COMMIT',
    });
  }
  return sha;
}

// I-130 (D1): lease identity is ownership + the bound version; the floating
// commit is informational, so a renew that floats the commit must not stale a
// ticket issued against the same lease.
function sameLease(left, right) {
  return left
    && right
    && left.holder?.id === right.holder?.id
    && left.version === right.version
    && left.sessionId === right.sessionId
    && left.branch === right.branch
    && left.ownerToken === right.ownerToken;
}

function ticketContext({
  snapshot,
  digest,
  stage,
  requirementId,
  commitSha,
  now,
  allowExpired = false,
}) {
  const path = `guard-tickets/${digest}.json`;
  if (!snapshot.has(path)) {
    throw new SharedEnvironmentGuardError('shared environment guard ticket is unknown', {
      code: 'INVALID_GUARD_TICKET',
    });
  }
  const record = snapshot.readJson(path);
  const lockPath = `locks/${stage}.json`;
  const active = snapshot.has(lockPath) ? snapshot.readJson(lockPath).active : null;
  const ticketExpiry = Date.parse(record.expiresAt);
  if (
    record.schemaVersion !== 1
    || record.digest !== digest
    || record.stage !== stage
    || record.requirementId !== requirementId
    || record.commit !== commitSha
    || !Number.isFinite(ticketExpiry)
    || (!allowExpired && ticketExpiry <= now.getTime())
    || !sameLease(active, record.lease)
    || !Number.isFinite(Date.parse(active?.expiresAt))
    || Date.parse(active?.expiresAt) <= now.getTime()
  ) {
    throw new SharedEnvironmentGuardError('shared environment guard ticket is stale or mismatched', {
      code: 'INVALID_GUARD_TICKET',
      data: { stage, requirementId, commit: commitSha },
    });
  }
  return { record, active };
}

export async function issueGuardTicket({
  store,
  cwd,
  stage,
  requirementId,
  commit,
  lease,
  clock = () => new Date(),
}) {
  const ticket = randomBytes(32).toString('hex');
  const digest = ticketDigest(ticket);
  const now = clock();
  const commitSha = resolvedCommit(cwd, commit);
  const leaseExpiry = Date.parse(lease?.expiresAt);
  if (!Number.isFinite(leaseExpiry) || leaseExpiry <= now.getTime()) {
    throw new SharedEnvironmentGuardError('cannot issue a ticket for an expired lease', {
      code: 'LEASE_EXPIRED',
    });
  }
  const expiresAt = new Date(Math.min(
    leaseExpiry,
    now.getTime() + GUARD_TICKET_TTL_MS,
  )).toISOString();
  await store.update({
    operation: `issue ${stage} guard ticket for ${requirementId}`,
    auditData: { kind: 'guard-ticket', stage, requirementId, commit: commitSha, digest },
    mutate(snapshot) {
      for (const path of snapshot.paths().filter((candidate) => (
        /^guard-tickets\/[0-9a-f]{64}\.json$/.test(candidate)
      ))) {
        let existing;
        try {
          existing = snapshot.readJson(path);
        } catch {
          snapshot.delete(path);
          continue;
        }
        const existingStage = existing?.stage;
        const existingActive = SHARED_STAGES.includes(existingStage)
          && snapshot.has(`locks/${existingStage}.json`)
          ? snapshot.readJson(`locks/${existingStage}.json`).active
          : null;
        if (
          !Number.isFinite(Date.parse(existing?.expiresAt))
          || !sameLease(existingActive, existing?.lease)
          || !Number.isFinite(Date.parse(existingActive?.expiresAt))
          || Date.parse(existingActive.expiresAt) <= now.getTime()
        ) {
          snapshot.delete(path);
        }
      }
      const lockPath = `locks/${stage}.json`;
      const active = snapshot.has(lockPath) ? snapshot.readJson(lockPath).active : null;
      // The ticket's commit binding comes from the asserted caller HEAD
      // (commitSha), not from the lease's floating informational commit.
      if (!sameLease(active, lease)) {
        throw new SharedEnvironmentGuardError('lease changed before guard ticket issuance', {
          code: 'STALE_GUARD_TICKET_LEASE',
          data: { stage, requirementId },
        });
      }
      snapshot.writeJson(`guard-tickets/${digest}.json`, {
        schemaVersion: 1,
        digest,
        stage,
        requirementId,
        commit: commitSha,
        lease: {
          holder: active.holder,
          version: active.version,
          sessionId: active.sessionId,
          branch: active.branch,
          commit: active.commit,
          ownerToken: active.ownerToken,
        },
        issuedAt: now.toISOString(),
        expiresAt,
      });
    },
  });
  return { ticket, digest, stage, requirementId, commit: commitSha, expiresAt };
}

export async function validateGuardTicket({
  store,
  cwd,
  ticket,
  stage,
  requirementId,
  commit,
  clock = () => new Date(),
  allowExpired = false,
}) {
  const digest = ticketDigest(ticket);
  const commitSha = resolvedCommit(cwd, commit);
  const snapshot = await store.readSnapshot();
  const { record, active } = ticketContext({
    snapshot,
    digest,
    stage,
    requirementId,
    commitSha,
    now: clock(),
    allowExpired,
  });
  return {
    resource: stage,
    holder: active.holder,
    sessionId: active.sessionId,
    branch: active.branch,
    commit: active.commit,
    ticketDigest: digest,
    ticketExpiresAt: record.expiresAt,
  };
}

export async function refreshGuardTicket({
  store,
  cwd,
  ticket,
  stage,
  requirementId,
  commit,
  clock = () => new Date(),
}) {
  const previousDigest = ticketDigest(ticket);
  const refreshedTicket = randomBytes(32).toString('hex');
  const digest = ticketDigest(refreshedTicket);
  const commitSha = resolvedCommit(cwd, commit);
  const now = clock();
  let expiresAt;
  await store.update({
    operation: `refresh ${stage} guard ticket for ${requirementId}`,
    auditData: {
      kind: 'guard-ticket-refresh',
      stage,
      requirementId,
      commit: commitSha,
      previousDigest,
      digest,
    },
    mutate(snapshot) {
      const { active } = ticketContext({
        snapshot,
        digest: previousDigest,
        stage,
        requirementId,
        commitSha,
        now,
        allowExpired: true,
      });
      expiresAt = new Date(Math.min(
        Date.parse(active.expiresAt),
        now.getTime() + GUARD_TICKET_TTL_MS,
      )).toISOString();
      snapshot.writeJson(`guard-tickets/${digest}.json`, {
        schemaVersion: 1,
        digest,
        stage,
        requirementId,
        commit: commitSha,
        lease: {
          holder: active.holder,
          version: active.version,
          sessionId: active.sessionId,
          branch: active.branch,
          commit: active.commit,
          ownerToken: active.ownerToken,
        },
        issuedAt: now.toISOString(),
        expiresAt,
        refreshedFrom: previousDigest,
      });
    },
  });
  return {
    ticket: refreshedTicket,
    digest,
    stage,
    requirementId,
    commit: commitSha,
    expiresAt,
    refreshedFrom: previousDigest,
  };
}

export function classifySharedEnvironment({ policy, stage, targets = [] }) {
  const requestedStage = normalizeStage(stage);
  if (!Array.isArray(targets)) {
    throw new SharedEnvironmentGuardError('shared environment targets must be an array', {
      code: 'INVALID_SHARED_ENV_TARGET',
    });
  }

  if (targets.length === 0) {
    if (requestedStage === 'auto') {
      throw new SharedEnvironmentGuardError('stage auto requires at least one target', {
        code: 'SHARED_ENV_TARGET_REQUIRED',
      });
    }
    return {
      required: true,
      stage: requestedStage,
      matchedHosts: [],
      reason: 'stage_operation',
    };
  }

  const hosts = [...new Set(targets.map(targetHost))];
  const matchedStages = SHARED_STAGES.filter((candidate) => (
    hosts.some((host) => policy[candidate].hosts.includes(host))
  ));
  if (matchedStages.length === 0 && requestedStage === 'auto') {
    return {
      required: false,
      stage: requestedStage === 'auto' ? null : requestedStage,
      matchedHosts: [],
      reason: 'target_not_shared',
    };
  }
  if (matchedStages.length > 1) {
    throw new SharedEnvironmentGuardError('targets span multiple shared environments', {
      code: 'MIXED_SHARED_ENV_TARGETS',
      data: { stages: matchedStages, hosts },
    });
  }

  const matchedStage = matchedStages[0] ?? requestedStage;
  if (requestedStage !== 'auto' && matchedStages.length === 1 && requestedStage !== matchedStage) {
    throw new SharedEnvironmentGuardError(
      `target belongs to shared ${matchedStage}, not requested ${requestedStage}`,
      {
        code: 'SHARED_ENV_STAGE_MISMATCH',
        data: { requestedStage, matchedStage, hosts },
      },
    );
  }
  return {
    required: true,
    stage: requestedStage === 'auto' ? matchedStage : requestedStage,
    matchedHosts: hosts.filter((host) => policy[matchedStage]?.hosts.includes(host)),
    reason: matchedStages.length === 0 ? 'explicit_stage_operation' : 'configured_shared_target',
  };
}

export async function guardSharedEnvironment({
  cwd,
  policy = loadSharedEnvironmentPolicy({ cwd }),
  stage,
  targets = [],
  requirementId,
  commit = 'HEAD',
  dryRun = false,
  assertLease,
  checkSession,
  checkWorkflow,
  checkFreeze,
  checkReleaseApproval,
  ticket,
  validateTicket,
}) {
  const classification = classifySharedEnvironment({ policy, stage, targets });
  if (!classification.required) {
    return { ...classification, dryRun: false, targets };
  }

  let normalizedRequirementId;
  try {
    normalizedRequirementId = assertRequirementId(requirementId);
  } catch (error) {
    throw new SharedEnvironmentGuardError(error.message, {
      code: 'INVALID_REQUIREMENT_ID',
      cause: error,
    });
  }
  if (!/^(HEAD|[0-9a-f]{7,40})$/.test(commit ?? '')) {
    throw new SharedEnvironmentGuardError(`invalid expected commit: ${commit ?? '<missing>'}`, {
      code: 'INVALID_EXPECTED_COMMIT',
    });
  }

  if (dryRun) {
    return {
      ...classification,
      dryRun: true,
      targets,
      requirementId: normalizedRequirementId,
      commit,
    };
  }
  // I-127: caller identity is cheap to validate (local session file) while the
  // freeze/approval checks below fetch and load the full coordination
  // snapshot, so an invalid session must fail closed before paying that cost.
  if (typeof checkSession === 'function') {
    await checkSession({
      resource: classification.stage,
      requirementId: normalizedRequirementId,
      commit,
    });
  }
  if (typeof checkWorkflow === 'function') {
    await checkWorkflow({ resource: classification.stage, requirementId: normalizedRequirementId, commit });
  }
  // A durable awaiting_human freeze fact (I-113 Task 3) blocks every shared
  // dev entry point — smoke, E2E and ticket issuance — even for the frozen
  // requirement itself: machine verification is complete and no new smoke or
  // E2E may run against the frozen dev until a human decision clears it.
  if (typeof checkFreeze === 'function') {
    await checkFreeze({
      resource: classification.stage,
      requirementId: normalizedRequirementId,
      commit,
    });
  }
  // The prod guard reads the durable release-approval fact when the release
  // intends the auto path: the approval must exist, be unrevoked, scope
  // `requirement`, and match this requirement. Missing or mismatched facts
  // fail closed back to the manual acceptance path.
  if (typeof checkReleaseApproval === 'function') {
    await checkReleaseApproval({
      resource: classification.stage,
      requirementId: normalizedRequirementId,
      commit,
    });
  }
  if (ticket) {
    if (typeof validateTicket !== 'function') {
      throw new SharedEnvironmentGuardError('guard ticket validation is unavailable', {
        code: 'SHARED_ENV_ASSERT_UNAVAILABLE',
      });
    }
    const assertion = await validateTicket({
      resource: classification.stage,
      requirementId: normalizedRequirementId,
      commit,
      ticket,
    });
    return {
      ...classification,
      dryRun: false,
      targets,
      requirementId: normalizedRequirementId,
      commit,
      assertion,
    };
  }
  if (typeof assertLease !== 'function') {
    throw new SharedEnvironmentGuardError('lease assertion implementation is unavailable', {
      code: 'SHARED_ENV_ASSERT_UNAVAILABLE',
    });
  }
  const assertion = await assertLease({
    resource: classification.stage,
    requirementId: normalizedRequirementId,
    commit,
  });
  return {
    ...classification,
    dryRun: false,
    targets,
    requirementId: normalizedRequirementId,
    commit,
    assertion,
  };
}
