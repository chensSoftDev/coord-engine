// Release approval fact（I-113 Task 3）：记录用户明确授权"机器验证通过后自动
// 进入生产闭环"的耐久审计事实。默认授权模式是 manual；只有直接用户指令产生
// 的 auto_after_machine_verification 事实才允许跳过人工等待。该入口在
// CI/定时任务中禁用；prod guard 只读取本事实并 fail closed——记录缺失、范围
// 不符、缺少指令引用或已撤销时，一律回到人工验收路径。

import { assertRequirementId } from './validation.mjs';
import { actor, knownSession } from './leases.mjs';

const APPROVAL_MODE = 'auto_after_machine_verification';
const APPROVAL_SCOPE = 'requirement';
const CI_ENV_KEYS = ['CI', 'GITHUB_ACTIONS'];

export class ApprovalError extends Error {
  constructor(message, { code, exitCode = 14, data = {}, cause } = {}) {
    super(message, { cause });
    this.name = 'ApprovalError';
    this.code = code;
    this.exitCode = exitCode;
    this.data = data;
  }
}

function approvalPath(requirementId) {
  return `release-approvals/${assertRequirementId(requirementId)}.json`;
}

function isCiContext(env) {
  return CI_ENV_KEYS.some((key) => {
    const value = env?.[key];
    return value === 'true' || value === '1';
  });
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function invalidApprovalStateError(cause) {
  return new ApprovalError('invalid release approval fact', {
    code: 'INVALID_APPROVAL_STATE',
    ...(cause ? { cause } : {}),
  });
}

// Validate and return a fact from a snapshot, or null when no fact exists.
// A malformed fact, a non-auto mode, a wrong scope, or a missing instruction
// reference all fail closed — no consumer may treat them as an active
// authorization. A revoked fact is a legal historical record but no longer
// an active approval, so it reads as null (identical to "never approved").
export function approvalFactFromSnapshot(snapshot, requirementId) {
  const path = approvalPath(requirementId);
  if (!snapshot.has(path)) return null;
  let fact;
  try {
    fact = snapshot.readJson(path);
  } catch (error) {
    throw invalidApprovalStateError(error);
  }
  const wellFormed = fact !== null
    && typeof fact === 'object'
    && !Array.isArray(fact)
    && fact.schemaVersion === 1
    && fact.mode === APPROVAL_MODE
    && fact.requirementId === assertRequirementId(requirementId)
    && isNonEmptyString(fact.authorizedBy)
    && isNonEmptyString(fact.instructionRef)
    && fact.scope === APPROVAL_SCOPE
    && isNonEmptyString(fact.authorizedAt)
    && !Number.isNaN(Date.parse(fact.authorizedAt))
    && isNonEmptyString(fact.actor?.sessionId);
  if (!wellFormed) throw invalidApprovalStateError();
  if (fact.revoked === true) return null;
  return fact;
}

export async function showReleaseApproval({ store, requirementId }) {
  const snapshot = await store.readSnapshot();
  return approvalFactFromSnapshot(snapshot, requirementId);
}

function requireApprovalInputs({ requirementId, authorizedBy, instructionRef, scope }) {
  const missing = [];
  if (typeof authorizedBy !== 'string' || authorizedBy.trim() === '') {
    missing.push('authorizedBy');
  }
  if (typeof instructionRef !== 'string' || instructionRef.trim() === '') {
    throw new ApprovalError('an approval requires a user instruction reference', {
      code: 'MISSING_APPROVAL_INSTRUCTION',
      data: { missing: ['instructionRef'] },
    });
  }
  if (scope !== APPROVAL_SCOPE) {
    throw new ApprovalError(`approval scope must be ${APPROVAL_SCOPE}: ${scope ?? '<missing>'}`, {
      code: 'INVALID_APPROVAL_SCOPE',
      data: { scope: scope ?? null },
    });
  }
  return missing;
}

// Record a durable auto_after_machine_verification approval fact. The entry
// is disabled in CI/scheduled contexts and only records the audit fact —
// it never grants anything by itself; prod guard consumes it fail closed.
export async function recordReleaseApproval({
  store,
  cwd,
  requirementId,
  mode = APPROVAL_MODE,
  authorizedBy,
  instructionRef,
  scope = APPROVAL_SCOPE,
  session,
  env = {},
  clock = () => new Date(),
}) {
  const safeId = assertRequirementId(requirementId);
  if (isCiContext(env)) {
    throw new ApprovalError('release approval cannot be recorded from CI or scheduled jobs', {
      code: 'APPROVAL_DISALLOWED_IN_CI',
      data: { requirementId: safeId },
    });
  }
  if (mode !== APPROVAL_MODE) {
    throw new ApprovalError(`approval mode must be ${APPROVAL_MODE}: ${mode ?? '<missing>'}`, {
      code: 'INVALID_APPROVAL_MODE',
      data: { mode: mode ?? null },
    });
  }
  const missing = requireApprovalInputs({ authorizedBy, instructionRef, scope });
  if (missing.length > 0) {
    throw new ApprovalError('approval requires authorizedBy', {
      code: 'MISSING_APPROVAL_BINDING',
      data: { missing },
    });
  }
  const localSession = knownSession(cwd, session);
  const now = clock();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new ApprovalError('approval clock returned an invalid date', {
      code: 'INVALID_APPROVAL_CLOCK',
    });
  }

  let fact;
  const update = await store.update({
    operation: `record release approval for ${safeId}`,
    auditData: {
      kind: 'approval',
      action: 'record',
      requirementId: safeId,
      authorizedBy,
      instructionRef,
      sessionId: localSession.sessionId,
    },
    mutate(snapshot) {
      const requirementPath = `requirements/${safeId}.json`;
      if (!snapshot.has(requirementPath)) {
        throw new ApprovalError(`requirement is not claimed: ${safeId}`, {
          code: 'REQUIREMENT_NOT_FOUND',
          data: { requirementId: safeId },
        });
      }
      const requirement = snapshot.readJson(requirementPath);
      if (requirement.workflowVersion === 2 && !/^user-message:[A-Za-z0-9._:-]{6,}$/.test(instructionRef)) {
        throw new ApprovalError('automatic release requires a direct user message reference', { code: 'MISSING_APPROVAL_INSTRUCTION' });
      }
      fact = {
        schemaVersion: 1,
        mode: APPROVAL_MODE,
        requirementId: safeId,
        authorizedBy: authorizedBy.trim(),
        authorizedAt: now.toISOString(),
        instructionRef: instructionRef.trim(),
        scope: APPROVAL_SCOPE,
        actor: actor(localSession),
        ...(requirement.workflowVersion === 2 ? { validationEpoch: requirement.validationEpoch ?? 0 } : {}),
      };
      snapshot.writeJson(approvalPath(safeId), fact);
    },
  });

  return {
    ...fact,
    operationId: update.operationId,
    coordinationSha: update.sha,
  };
}

// Revoke a recorded approval. The fact is kept on the coordination branch
// with a revocation audit trail, but showReleaseApproval and prod guard
// consumers treat it as no active authorization.
export async function revokeReleaseApproval({
  store,
  cwd,
  requirementId,
  reason,
  session,
  clock = () => new Date(),
}) {
  const safeId = assertRequirementId(requirementId);
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new ApprovalError('revoking an approval requires a reason', {
      code: 'MISSING_APPROVAL_REASON',
    });
  }
  const localSession = knownSession(cwd, session);
  const now = clock();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new ApprovalError('approval clock returned an invalid date', {
      code: 'INVALID_APPROVAL_CLOCK',
    });
  }

  let revoked;
  const update = await store.update({
    operation: `revoke release approval for ${safeId}`,
    auditData: {
      kind: 'approval',
      action: 'revoke',
      requirementId: safeId,
      reason: reason.trim(),
      sessionId: localSession.sessionId,
    },
    mutate(snapshot) {
      const current = approvalFactFromSnapshot(snapshot, safeId);
      if (!current) {
        throw new ApprovalError(`no active release approval for ${safeId}`, {
          code: 'APPROVAL_NOT_FOUND',
          data: { requirementId: safeId },
        });
      }
      revoked = {
        ...current,
        revoked: true,
        revokedAt: now.toISOString(),
        revokedBy: actor(localSession),
        revokeReason: reason.trim(),
      };
      snapshot.writeJson(approvalPath(safeId), revoked);
    },
  });

  return {
    requirementId: safeId,
    revoked: true,
    reason: reason.trim(),
    previous: revoked,
    operationId: update.operationId,
    coordinationSha: update.sha,
  };
}
