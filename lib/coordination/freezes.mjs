// dev freeze fact（I-113 Task 3）：机器验证全绿后，把 active dev lease 原子
// 转换为无自动 TTL 的 awaiting_human freeze fact，并绑定 candidateId、dev
// 部署快照与机器验证证据（三者缺一即拒绝）。lease 槽位在同一次 coordination
// 更新中清空；freeze 的清除只属于后续 accept/reject/release 路径，不在本切片内。
// lease 持有/过期/身份判定复用 leases.mjs 的窄公共原语
// consumeActiveLeaseInSnapshot，本模块不复制所有权语义；协调写入复用窄内部导出
// updateLeaseState（audit metadata kind='lease'、action='freeze'、本地 operation
// record pending/uncertain/applied），使 exit 15 不确定推送与 acquire/release/break
// 一样可由 reconcileLeaseOperation 闭环并清理本地 lease token。

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { assertRequirementId, normalizeDuration } from './validation.mjs';
import { isBacklogProjectionDescendant } from './repository-projection.mjs';
import { classifyRevisionRange } from './revision-policy.mjs';
import {
  actor,
  assertLease,
  consumeActiveLeaseInSnapshot,
  currentRevision,
  freezeFactFromSnapshot,
  knownSession,
  lockFromSnapshot,
  releaseLocalLeaseToken,
  resolvedToken,
  updateLeaseState,
  writeLocalLeaseToken,
} from './leases.mjs';
import { evidencePath, validateTestEvidence } from './evidence.mjs';
import { evaluateReviewReadiness } from './reviews.mjs';
import { inspectFeedbackArtifacts } from './feedback.mjs';
import { revisionMatchesDeployment } from './leases.mjs';
import { uiAcceptanceRequired, validateUiAcceptanceReport } from './ui-acceptance.mjs';

const FREEZE_RESOURCE = 'dev';
const FREEZE_STATE = 'awaiting_human';
const DEFAULT_REJECT_TTL = '8h';

function evidenceNeutralDescendant(cwd, id, fromSha, toSha) {
  try {
    const drift = classifyRevisionRange({ cwd, requirementId: id, fromSha, toSha });
    return drift.valid && drift.classification === 'evidence-neutral';
  } catch { return false; }
}

export class FreezeError extends Error {
  constructor(message, { code, exitCode = 14, data = {}, cause } = {}) {
    super(message, { cause });
    this.name = 'FreezeError';
    this.code = code;
    this.exitCode = exitCode;
    this.data = data;
  }
}

function freezePath(resource) {
  return `freezes/${resource}.json`;
}

function validateId(id) {
  try {
    return assertRequirementId(id);
  } catch (error) {
    throw new FreezeError(error.message, { code: 'INVALID_REQUIREMENT_ID', cause: error });
  }
}

function nowFrom(clock) {
  const now = clock();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new FreezeError('freeze clock returned an invalid date', {
      code: 'INVALID_FREEZE_CLOCK',
    });
  }
  return now;
}

function requireBinding({ candidateId, deploymentSnapshot, machineVerificationEvidence }) {
  const missing = [];
  if (typeof candidateId !== 'string' || candidateId.trim() === '') missing.push('candidateId');
  if (
    deploymentSnapshot === null
    || typeof deploymentSnapshot !== 'object'
    || Array.isArray(deploymentSnapshot)
  ) {
    missing.push('deploymentSnapshot');
  }
  if (typeof machineVerificationEvidence !== 'string' || machineVerificationEvidence.trim() === '') {
    missing.push('machineVerificationEvidence');
  }
  if (missing.length > 0) {
    throw new FreezeError(
      `freeze requires ${missing.join(', ')}`,
      { code: 'MISSING_FREEZE_BINDING', data: { missing } },
    );
  }
}

// Read the current durable freeze fact for a resource, or null when the
// resource is not frozen. Parsing and validation come from the shared
// freezeFactFromSnapshot helper in leases.mjs: a malformed fact fails closed
// with INVALID_FREEZE_STATE.
export async function showFreeze({ store, resource = FREEZE_RESOURCE }) {
  if (resource !== FREEZE_RESOURCE) {
    throw new FreezeError(`freeze facts only apply to the dev resource: ${resource}`, {
      code: 'INVALID_FREEZE_RESOURCE',
    });
  }
  const snapshot = await store.readSnapshot();
  return freezeFactFromSnapshot(snapshot, resource);
}

// Atomically convert the caller's active dev lease into a durable freeze fact
// bound to candidateId, the dev deployment snapshot and the machine
// verification evidence. The session must hold the lease for the same
// requirement at the current working-tree revision; the conversion is a single
// coordination update so the queue never observes a state where both the lease
// is gone and the freeze is missing.
export async function enterFreeze({
  store,
  cwd,
  resource = FREEZE_RESOURCE,
  requirementId,
  candidateId,
  deploymentSnapshot,
  machineVerificationEvidence,
  session,
  clock = () => new Date(),
}) {
  if (resource !== FREEZE_RESOURCE) {
    throw new FreezeError(`freeze facts only apply to the dev resource: ${resource}`, {
      code: 'INVALID_FREEZE_RESOURCE',
    });
  }
  const safeId = validateId(requirementId);
  requireBinding({ candidateId, deploymentSnapshot, machineVerificationEvidence });
  const localSession = knownSession(cwd, session);
  const revision = currentRevision(cwd);

  // Resolve the caller's owner token up front so updateLeaseState can write
  // the durable local operation record before the push. A prior successful
  // freeze deletes the local token, so on NOT_HOLDER re-check the remote
  // freeze fact first: a second conversion must still report FREEZE_EXISTS
  // (or INVALID_FREEZE_STATE for a malformed fact), preserving the error
  // precedence of the atomic mutate checks below.
  let ownerToken;
  try {
    ownerToken = resolvedToken({ cwd, resource, session: localSession });
  } catch (error) {
    const existing = freezeFactFromSnapshot(await store.readSnapshot(), resource);
    if (existing) {
      throw new FreezeError(`${resource} is already frozen by ${existing.requirementId}`, {
        code: 'FREEZE_EXISTS',
        exitCode: 10,
        data: { resource, requirementId: existing.requirementId },
      });
    }
    throw error;
  }

  let workflowBinding = null;
  const preflight = await store.readSnapshot();
  const requirementPath = `requirements/${safeId}.json`;
  const preflightRequirement = preflight.has(requirementPath) ? preflight.readJson(requirementPath) : null;
  if (preflightRequirement?.workflowVersion === 2) {
    try {
      const review = evaluateReviewReadiness({ snapshot: preflight, cwd, requirement: preflightRequirement, stage: 'verification' });
      if (!review.ok) throw new Error('current verification review is incomplete');
      const deployment = preflight.has('deployments/dev.json') ? preflight.readJson('deployments/dev.json') : null;
      if (JSON.stringify(deployment) !== JSON.stringify(deploymentSnapshot)) throw new Error('freeze snapshot is not the current trusted dev deployment');
      const actualSha = createHash('sha256').update(readFileSync(evidencePath({ cwd, id: safeId }))).digest('hex');
      if (actualSha !== machineVerificationEvidence) throw new Error('freeze evidence digest differs from TEST_EVIDENCE.json');
      const lease = await assertLease({ store, cwd, resource, requirementId: safeId, session: localSession, clock });
      const mixedPath = `environments/${safeId}/mixed-dev.json`;
      await validateTestEvidence({ cwd, id: safeId, requirement: preflightRequirement, deployment, lease,
        mixedEnvironment: preflight.has(mixedPath) ? preflight.readJson(mixedPath) : null, clock });
      workflowBinding = {
        validationEpoch: preflightRequirement.validationEpoch ?? 0,
        feedbackFingerprint: inspectFeedbackArtifacts({ cwd, id: safeId }).fingerprint,
        ...(preflight.has(mixedPath) ? { mixedEnvironmentIdentity: preflight.readJson(mixedPath).identitySha256 } : {}),
      };
    } catch (cause) {
      throw new FreezeError('complete the current review and machine verification before freezing for human acceptance', {
        code: 'FREEZE_VERIFICATION_REQUIRED', cause, data: { detail: cause.message },
      });
    }
  }
  let fact;
  const update = await updateLeaseState({
    store,
    cwd,
    resource,
    action: 'freeze',
    ownerToken,
    session: localSession,
    requirementId: safeId,
    clock,
    operation: `freeze ${resource} for ${safeId}`,
    mutate(snapshot) {
      const now = nowFrom(clock);
      // The shared helper fails closed: a malformed existing fact propagates
      // INVALID_FREEZE_STATE and is never overwritten; only a valid fact is
      // reported as FREEZE_EXISTS.
      const existing = freezeFactFromSnapshot(snapshot, resource);
      if (existing) {
        throw new FreezeError(`${resource} is already frozen by ${existing.requirementId}`, {
          code: 'FREEZE_EXISTS',
          exitCode: 10,
          data: { resource, requirementId: existing.requirementId },
        });
      }
      const requirementPath = `requirements/${safeId}.json`;
      if (!snapshot.has(requirementPath)) {
        throw new FreezeError(`requirement is not claimed: ${safeId}`, {
          code: 'REQUIREMENT_NOT_FOUND',
          data: { requirementId: safeId },
        });
      }
      // I-130 (D1): the freeze binds the lease's bound version, so the
      // requirement must carry one and the lease must match it.
      const requirement = snapshot.readJson(requirementPath);
      if (requirement.workflowVersion === 2 && (!workflowBinding
        || workflowBinding.validationEpoch !== (requirement.validationEpoch ?? 0)
        || !evaluateReviewReadiness({ snapshot, cwd, requirement, stage: 'verification' }).ok
        || JSON.stringify(snapshot.readJson('deployments/dev.json')) !== JSON.stringify(deploymentSnapshot)
        || (workflowBinding.mixedEnvironmentIdentity && (!snapshot.has(`environments/${safeId}/mixed-dev.json`)
          || snapshot.readJson(`environments/${safeId}/mixed-dev.json`).identitySha256 !== workflowBinding.mixedEnvironmentIdentity
          || snapshot.readJson(`environments/${safeId}/mixed-dev.json`).invalidated)))) {
        throw new FreezeError('verified workflow inputs changed before the freeze could be recorded', { code: 'FREEZE_VERIFICATION_REQUIRED' });
      }
      if (typeof requirement.version !== 'string' || requirement.version.trim() === '') {
        throw new FreezeError(`${safeId} is not bound to a release version`, {
          code: 'REQUIREMENT_VERSION_UNBOUND',
          exitCode: 12,
          data: { requirementId: safeId },
        });
      }
      // Revision identity is part of the lease binding: a stale worktree must
      // not convert someone else's verified state into a freeze. The freeze
      // anchors on the lease's verified commit; a pure BACKLOG.md projection
      // commit on top of it is tolerated because it is an audit closure of
      // the same deployed commit — the freeze still binds that commit.
      const lock = lockFromSnapshot(snapshot, resource);
      const commitMatches = lock.active?.commit === revision.commit
        || isBacklogProjectionDescendant({
          cwd,
          ancestor: lock.active?.commit,
          descendant: revision.commit,
        }) || (requirement.workflowVersion === 2
          && evidenceNeutralDescendant(cwd, safeId, lock.active?.commit, revision.commit));
      if (lock.active?.branch !== revision.branch || !commitMatches) {
        throw new FreezeError('working tree revision no longer matches the active lease', {
          code: 'LEASE_REVISION_MISMATCH',
          exitCode: 11,
          data: {
            resource,
            branch: revision.branch,
            commit: revision.commit,
            leaseBranch: lock.active?.branch ?? null,
            leaseCommit: lock.active?.commit ?? null,
          },
        });
      }
      if (lock.active?.version !== requirement.version) {
        throw new FreezeError(
          `${resource} lease is bound to ${lock.active?.version ?? '<no version>'}, not ${requirement.version}`,
          {
            code: 'LEASE_VERSION_MISMATCH',
            exitCode: 11,
            data: {
              resource,
              requirementId: safeId,
              leaseVersion: lock.active?.version ?? null,
              requirementVersion: requirement.version,
            },
          },
        );
      }
      const previous = consumeActiveLeaseInSnapshot({
        snapshot,
        cwd,
        resource,
        requirementId: safeId,
        session: localSession,
        ownerToken,
        now,
        eventType: 'freeze',
        eventActor: actor(localSession),
      });
      fact = {
        schemaVersion: 1,
        resource,
        state: FREEZE_STATE,
        requirementId: safeId,
        // I-130 (D1): the freeze fact carries the lease's bound version so the
        // evidence chain stays version-identifiable after the lease is gone.
        version: previous.version,
        candidateId,
        deploymentSnapshot,
        machineVerificationEvidence,
        branch: previous.branch,
        commit: previous.commit,
        frozenAt: now.toISOString(),
        actor: actor(localSession),
        ...(workflowBinding ?? {}),
      };
      snapshot.writeJson(freezePath(resource), fact);
    },
  });

  releaseLocalLeaseToken({ cwd, resource, session: localSession });
  return {
    ...fact,
    operationId: update.operationId,
    coordinationSha: update.sha,
  };
}

// ---------------------------------------------------------------------------
// Human decision paths (I-113 Task 3): the durable awaiting_human freeze fact
// can only be cleared by an explicit human decision. acceptFreeze records the
// acceptance on the fact (the freeze persists until prod success); rejectFreeze
// atomically converts the fact back into a fresh machine_verifying dev lease
// for the same requirement so no other requirement can grab the slot in
// between; releaseFreeze clears the fact and returns dev to available. All
// three require an auditable reason and record the acting session.
// ---------------------------------------------------------------------------

function requireDecisionReason(reason) {
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new FreezeError('a human freeze decision requires a reason', {
      code: 'MISSING_FREEZE_REASON',
      data: { missing: ['reason'] },
    });
  }
  return reason.trim();
}

function requireFreezeBinding({ fact, requirementId }) {
  if (!fact) {
    throw new FreezeError('dev is not frozen; no human decision is pending', {
      code: 'FREEZE_NOT_FOUND',
      data: { resource: FREEZE_RESOURCE },
    });
  }
  if (fact.requirementId !== requirementId) {
    throw new FreezeError(`the dev freeze is held for ${fact.requirementId}, not ${requirementId}`, {
      code: 'FREEZE_REQUIREMENT_MISMATCH',
      data: { resource: FREEZE_RESOURCE, requirementId, frozenFor: fact.requirementId },
    });
  }
}

function freezeAudit(store, action, requirementId, reason, session) {
  return {
    kind: 'freeze',
    action,
    resource: FREEZE_RESOURCE,
    requirementId,
    reason,
    sessionId: session.sessionId,
  };
}

// I-134 (F3): unfreezeFact is the single implementation of the human freeze
// decision. The shared preamble (resource/id/reason/session validation) runs
// once; the outcome selects the mutate body, audit action, operation label
// and result shape. The accept/reject/release exports below stay as thin
// wrappers so existing callers and tests are unaffected.
const UNFREEZE_OUTCOMES = Object.freeze(['accepted', 'rejected', 'released']);

// Record the human acceptance on the freeze fact (accepted). The fact is not
// cleared: per the shared-dev design the freeze stays until the production
// release succeeds (released) or the release smoke fails and the candidate is
// sent back to machine verification (rejected, an atomic conversion back into
// a fresh machine_verifying dev lease so no other requirement can grab the
// slot in between). released clears the fact and returns dev to available.
export async function unfreezeFact({
  outcome,
  store,
  cwd,
  resource = FREEZE_RESOURCE,
  requirementId,
  reason,
  authorizedBy,
  instructionRef,
  session,
  ttl = DEFAULT_REJECT_TTL,
  clock = () => new Date(),
}) {
  if (!UNFREEZE_OUTCOMES.includes(outcome)) {
    throw new FreezeError(`invalid unfreeze outcome: ${outcome ?? '<missing>'}`, {
      code: 'INVALID_UNFREEZE_OUTCOME',
      data: { outcomes: [...UNFREEZE_OUTCOMES] },
    });
  }
  if (resource !== FREEZE_RESOURCE) {
    throw new FreezeError(`freeze facts only apply to the dev resource: ${resource}`, {
      code: 'INVALID_FREEZE_RESOURCE',
    });
  }
  const safeId = validateId(requirementId);
  const decisionReason = requireDecisionReason(reason);
  const localSession = knownSession(cwd, session);

  if (outcome === 'accepted') {
    const now = nowFrom(clock);
    let fact;
    const update = await store.update({
      operation: `accept freeze for ${safeId}`,
      auditData: freezeAudit(store, 'accept', safeId, decisionReason, localSession),
      mutate(snapshot) {
        const current = freezeFactFromSnapshot(snapshot, resource);
        requireFreezeBinding({ fact: current, requirementId: safeId });
        const requirementPath = `requirements/${safeId}.json`;
        const requirement = snapshot.has(requirementPath) ? snapshot.readJson(requirementPath) : null;
        if (requirement?.workflowVersion === 2) {
          if (typeof authorizedBy !== 'string' || authorizedBy.trim().length < 2
            || !/^user-message:[A-Za-z0-9._:-]{6,}$/.test(instructionRef ?? '')) {
            throw new FreezeError('record the approving human and direct message for the current candidate', { code: 'FREEZE_ACCEPTANCE_AUTHORIZATION_REQUIRED' });
          }
          const revision = currentRevision(cwd);
          // B-248: accept and advance must share one tolerance line. The
          // advance gate only accepts evidence-neutral drift; letting accept
          // tolerate deployment-neutral drift here would approve a candidate
          // that advance then refuses, with no executable remediation left
          // under an active freeze. The null-policy fast paths (identical
          // commit, pure BACKLOG projection descendant) count as neutral.
          const acceptDriftNeutral = current.commit === revision.commit
            || (() => {
              const drift = revisionMatchesDeployment({
                cwd, requirementId: safeId, fromCommit: current.commit, toCommit: revision.commit,
              });
              return drift.matches
                && (drift.policy === null || drift.policy.classification === 'evidence-neutral');
            })();
          if (current.validationEpoch !== (requirement.validationEpoch ?? 0) || !acceptDriftNeutral) {
            throw new FreezeError('candidate drifted beyond evidence-neutral changes after machine verification; reject the freeze and reverify', { code: 'FREEZE_EVIDENCE_MISMATCH', exitCode: 11 });
          }
          if (current.mixedEnvironmentIdentity) {
            const path = `environments/${safeId}/mixed-dev.json`;
            if (!snapshot.has(path) || snapshot.readJson(path).invalidated
              || snapshot.readJson(path).identitySha256 !== current.mixedEnvironmentIdentity) {
              throw new FreezeError('mixed candidate changed before human acceptance', { code: 'FREEZE_EVIDENCE_MISMATCH', exitCode: 11 });
            }
          }
        }
        const uiEvidence = uiAcceptanceRequired({ requirement, snapshot })
          ? validateUiAcceptanceReport({ cwd, requirement, freeze: current }) : null;
        fact = {
          ...current,
          acceptance: {
            acceptedAt: now.toISOString(),
            acceptedBy: actor(localSession),
            reason: decisionReason,
            ...(authorizedBy ? { authorizedBy: authorizedBy.trim() } : {}),
            ...(instructionRef ? { instructionRef } : {}),
            ...(uiEvidence ? { uiEvidenceSha256: uiEvidence.evidenceSha256 } : {}),
          },
        };
        snapshot.writeJson(freezePath(resource), fact);
      },
    });

    return {
      ...fact,
      operationId: update.operationId,
      coordinationSha: update.sha,
    };
  }

  if (outcome === 'rejected') {
    const ownerToken = randomUUID();
    const revision = currentRevision(cwd);
    let leaseDurationMs;
    try {
      leaseDurationMs = normalizeDuration(ttl);
    } catch (error) {
      throw new FreezeError(error.message, { code: 'INVALID_FREEZE_TTL', cause: error });
    }

    let fact;
    let lease;
    const update = await store.update({
      operation: `reject freeze for ${safeId} back to machine verification`,
      auditData: freezeAudit(store, 'reject', safeId, decisionReason, localSession),
      mutate(snapshot) {
        const now = nowFrom(clock);
        const current = freezeFactFromSnapshot(snapshot, resource);
        requireFreezeBinding({ fact: current, requirementId: safeId });
        // The rejecting worktree must still be on the frozen requirement's
        // branch; otherwise a cross-branch actor could hijack the requirement's
        // dev slot. Commits may have moved (fixes/docs), only the branch is
        // identity-critical for the resumed machine_verifying lease.
        if (current.branch !== revision.branch) {
          throw new FreezeError(
            `working tree branch ${revision.branch} no longer matches the frozen branch ${current.branch}`,
            {
              code: 'FREEZE_REVISION_MISMATCH',
              exitCode: 11,
              data: { resource, branch: revision.branch, frozenBranch: current.branch },
            },
          );
        }
        const lock = lockFromSnapshot(snapshot, resource);
        if (lock.active) {
          throw new FreezeError('the dev slot is unexpectedly occupied while frozen', {
            code: 'FREEZE_LEASE_CONFLICT',
            exitCode: 11,
            data: { resource, holderId: lock.active.holder?.id ?? null },
          });
        }
        fact = current;
        lease = {
          holder: { kind: 'requirement', id: safeId },
          // I-130 (D1): the resumed machine_verifying lease backfills the frozen
          // version (locks are written at schema v2).
          version: current.version,
          sessionId: localSession.sessionId,
          branch: revision.branch,
          commit: revision.commit,
          ownerToken,
          acquiredAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + leaseDurationMs).toISOString(),
        };
        snapshot.delete(freezePath(resource));
        snapshot.writeJson(`locks/${resource}.json`, {
          schemaVersion: 2,
          resource,
          active: lease,
          lastEvent: {
            type: 'reject',
            at: now.toISOString(),
            actor: actor(localSession),
            reason: decisionReason,
            previous: current,
          },
        });
      },
    });

    writeLocalLeaseToken({ cwd, resource, session: localSession, ownerToken });
    return {
      requirementId: safeId,
      reason: decisionReason,
      lease,
      previousFreeze: fact,
      operationId: update.operationId,
      coordinationSha: update.sha,
    };
  }

  // outcome === 'released': clear the freeze fact and return dev to
  // available. Used when the user explicitly cancels/releases the candidate,
  // or after the production release succeeded.
  let fact;
  const update = await store.update({
    operation: `release freeze for ${safeId}`,
    auditData: freezeAudit(store, 'release', safeId, decisionReason, localSession),
    mutate(snapshot) {
      const current = freezeFactFromSnapshot(snapshot, resource);
      requireFreezeBinding({ fact: current, requirementId: safeId });
      fact = current;
      snapshot.delete(freezePath(resource));
    },
  });

  return {
    requirementId: safeId,
    reason: decisionReason,
    released: true,
    previousFreeze: fact,
    operationId: update.operationId,
    coordinationSha: update.sha,
  };
}

// I-134 (F3): the historical per-outcome entry points stay exported as thin
// wrappers over unfreezeFact — the outcome is the only difference.
export function acceptFreeze(args) {
  return unfreezeFact({ ...args, outcome: 'accepted' });
}

export function rejectFreeze(args) {
  return unfreezeFact({ ...args, outcome: 'rejected' });
}

export function releaseFreeze(args) {
  return unfreezeFact({ ...args, outcome: 'released' });
}
