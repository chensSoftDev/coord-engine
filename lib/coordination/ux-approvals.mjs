import { spawnSync } from 'node:child_process';

import { actor, knownSession } from './leases.mjs';
import { inspectUxArtifacts } from './ux-artifacts.mjs';
import { assertRequirementId } from './validation.mjs';

export class UxApprovalError extends Error {
  constructor(message, { code, exitCode = 14, data = {} } = {}) {
    super(message);
    this.name = 'UxApprovalError';
    this.code = code;
    this.exitCode = exitCode;
    this.data = data;
  }
}

const pathFor = (id) => `ux-approvals/${assertRequirementId(id)}.json`;
const disallowed = (env) => ['CI', 'GITHUB_ACTIONS', 'CODEX_AUTOMATION', 'CRON'].some((key) => ['1', 'true'].includes(String(env[key] ?? '').toLowerCase()));

function activeFact(snapshot, id) {
  if (!snapshot.has(pathFor(id))) return null;
  try {
    const fact = snapshot.readJson(pathFor(id));
    if (fact.schemaVersion !== 1 || fact.requirementId !== id || !fact.authorizedBy
      || !fact.instructionRef?.startsWith('user-message:') || !fact.actor?.sessionId
      || !fact.approvedCommit || !fact.fingerprint || !fact.version) return null;
    return fact.revoked ? null : fact;
  } catch { return null; }
}

export function showUxApproval({ snapshot, id }) {
  return activeFact(snapshot, assertRequirementId(id));
}

function isAncestor(cwd, ancestor, descendant) {
  return spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
    cwd, stdio: 'ignore',
  }).status === 0;
}

export function evaluateUxReadiness({ snapshot, cwd, requirement }) {
  const id = assertRequirementId(requirement.id);
  if (requirement.uxImpact === undefined) return { ok: true, exempt: 'legacy', missing: [] };
  if (requirement.uxImpact === 'none') return { ok: true, exempt: 'declared-none', missing: [] };
  if (requirement.uxImpact !== 'admin-ui') return { ok: false, missing: ['declare_ux_impact'] };
  let artifacts;
  try { artifacts = inspectUxArtifacts({ cwd, id, requireFeedbackDefinitions: requirement.workflowVersion === 2 }); } catch (error) {
    return { ok: false, missing: ['create_ux_spec', 'create_ux_prototype'], detail: error.message };
  }
  if (!artifacts.ok) {
    // B-248: feedback-artifact failures carry their own FEEDBACK_* codes —
    // bucketing them under create_ux_spec/create_ux_prototype misdirected the
    // remediation toward the prototype instead of FEEDBACK.json.
    const feedbackMissing = artifacts.missing.some((item) => /^FEEDBACK[A-Z_]*:/.test(item));
    const specMissing = artifacts.missing.some((item) => /UX_SPEC|chapter/.test(item));
    const prototypeMissing = artifacts.missing.some((item) => !/UX_SPEC|chapter|^FEEDBACK[A-Z_]*:/.test(item));
    return {
      ok: false,
      missing: [
        feedbackMissing && 'prepare_feedback_artifacts',
        specMissing && 'create_ux_spec',
        prototypeMissing && 'create_ux_prototype',
      ].filter(Boolean),
      artifacts,
    };
  }
  const fact = activeFact(snapshot, id);
  if (!fact) return { ok: false, missing: ['obtain_ux_approval'], artifacts };
  if (fact.version !== requirement.version || fact.fingerprint !== artifacts.fingerprint
    || !isAncestor(cwd, fact.approvedCommit, artifacts.commit)) {
    return { ok: false, missing: ['refresh_ux_approval'], artifacts, approval: fact };
  }
  return { ok: true, missing: [], artifacts, approval: fact };
}

export async function recordUxApproval({
  store, cwd, id, authorizedBy, instructionRef, session, env = {}, clock = () => new Date(),
}) {
  const safeId = assertRequirementId(id);
  if (disallowed(env)) throw new UxApprovalError('UX approval cannot be recorded from CI or automation', { code: 'UX_APPROVAL_DISALLOWED_IN_CI' });
  if (typeof authorizedBy !== 'string' || authorizedBy.trim().length < 2) {
    throw new UxApprovalError('the approving user is required', { code: 'MISSING_UX_APPROVER' });
  }
  if (typeof instructionRef !== 'string' || !/^user-message:[A-Za-z0-9._:-]{6,}$/.test(instructionRef)) {
    throw new UxApprovalError('reference a direct user message as user-message:<id>', { code: 'INVALID_UX_INSTRUCTION_REF' });
  }
  const localSession = knownSession(cwd, session);
  let artifacts;
  let fact;
  const result = await store.update({
    operation: `record UX approval for ${safeId}`,
    auditData: { kind: 'ux-approval', action: 'record', requirementId: safeId, authorizedBy, instructionRef, sessionId: localSession.sessionId },
    mutate(snapshot) {
      const requirementPath = `requirements/${safeId}.json`;
      if (!snapshot.has(requirementPath)) throw new UxApprovalError(`requirement ${safeId} is absent`, { code: 'REQUIREMENT_NOT_FOUND' });
      const requirement = snapshot.readJson(requirementPath);
      if (requirement.uxImpact !== 'admin-ui' || !requirement.version) {
        throw new UxApprovalError('requirement must declare admin-ui and have a version', { code: 'UX_APPROVAL_SCOPE_MISMATCH' });
      }
      artifacts = inspectUxArtifacts({ cwd, id: safeId, requireFeedbackDefinitions: requirement.workflowVersion === 2 });
      if (!artifacts.ok) throw new UxApprovalError('UX review artifacts are incomplete or uncommitted', {
        code: 'UX_ARTIFACTS_INVALID', data: { missing: artifacts.missing },
      });
      if (!['req_confirmed', 'tech_design', 'in_dev', 'dev_deployed', 'testing', 'test_passed', 'prod_planning', 'prod_deployed'].includes(requirement.lifecycle)) {
        throw new UxApprovalError('confirm the requirement before recording UX approval', { code: 'UX_APPROVAL_BEFORE_REQ_CONFIRMED' });
      }
      const branch = spawnSync('git', ['branch', '--show-current'], {
        cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      }).stdout?.trim();
      if (requirement.branch && branch !== requirement.branch) {
        throw new UxApprovalError('checkout does not match the requirement branch', { code: 'UX_APPROVAL_BRANCH_MISMATCH' });
      }
      fact = {
        schemaVersion: 1, requirementId: safeId, version: requirement.version,
        authorizedBy: authorizedBy.trim(), instructionRef,
        authorizedAt: clock().toISOString(), approvedCommit: artifacts.commit,
        fingerprint: artifacts.fingerprint, specPath: artifacts.specPath,
        scenarioPaths: artifacts.scenarioPaths, actor: actor(localSession), revoked: false,
      };
      snapshot.writeJson(pathFor(safeId), fact);
    },
  });
  return { ...fact, coordinationSha: result.sha, operationId: result.operationId };
}

export async function revokeUxApproval({
  store, cwd, id, reason, session, env = {}, clock = () => new Date(),
}) {
  const safeId = assertRequirementId(id);
  if (disallowed(env)) throw new UxApprovalError('UX approval cannot be revoked from CI or automation', { code: 'UX_APPROVAL_DISALLOWED_IN_CI' });
  if (typeof reason !== 'string' || reason.trim().length < 10 || /[\r\n]/.test(reason)) {
    throw new UxApprovalError('a single-line revoke reason of at least 10 characters is required', { code: 'INVALID_UX_REVOKE_REASON' });
  }
  const localSession = knownSession(cwd, session);
  let fact;
  const update = await store.update({
    operation: `revoke UX approval for ${safeId}`,
    auditData: { kind: 'ux-approval', action: 'revoke', requirementId: safeId, reason: reason.trim(), sessionId: localSession.sessionId },
    mutate(snapshot) {
      const prior = activeFact(snapshot, safeId);
      if (!prior) throw new UxApprovalError('no active UX approval', { code: 'UX_APPROVAL_NOT_FOUND' });
      fact = { ...prior, revoked: true, revokedAt: clock().toISOString(), revokedBy: actor(localSession), revokeReason: reason.trim() };
      snapshot.writeJson(pathFor(safeId), fact);
    },
  });
  return { ...fact, coordinationSha: update.sha };
}
