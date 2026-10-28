import { assertRequirementId } from './validation.mjs';
import { showReview } from './reviews.mjs';

function completedDownstreamIteration({ snapshot, cwd, requirement }) {
  if (!cwd || !['dev_deployed', 'testing', 'test_passed', 'prod_planning'].includes(requirement.lifecycle)) return false;
  try {
    const history = showReview({ snapshot, cwd, requirement, stage: 'implementation' });
    const last = history.rounds.at(-1);
    if (!last) return false;
    const verified = history.verifications.find((fact) => fact.reviewId === last.reviewId);
    if (verified) return !last.report.findings.some((finding) => ['P0', 'P1'].includes(finding.priority)
      && verified.report.remainingFindingIds.includes(finding.id))
      && !(verified.report.newFindings ?? []).some((finding) => ['P0', 'P1'].includes(finding.priority));
    return last.report.verdict === 'pass' && !last.report.findings.some((finding) => ['P0', 'P1'].includes(finding.priority));
  } catch { return false; }
}

export async function enableWorkflow({ store, id, reason, actor = 'unknown', clock = () => new Date() }) {
  assertRequirementId(id);
  if (typeof reason !== 'string' || reason.trim().length < 10 || /[\r\n]/.test(reason)) {
    throw Object.assign(new Error('workflow enrollment requires a single-line audit reason of at least 10 characters'), {
      code: 'INVALID_WORKFLOW_REASON', exitCode: 12,
    });
  }
  return store.update({
    operation: `enable closed-loop workflow for ${id}`,
    auditData: { requirementId: id, reason, actor },
    mutate(snapshot) {
      const path = `requirements/${id}.json`;
      if (!snapshot.has(path)) throw Object.assign(new Error(`requirement ${id} is absent`), { code: 'REQUIREMENT_NOT_FOUND', exitCode: 14 });
      const requirement = snapshot.readJson(path);
      if (['prod_deployed', 'merged', 'done', 'cancelled'].includes(requirement.lifecycle)) {
        throw Object.assign(new Error('terminal requirements cannot be enrolled retroactively'), { code: 'WORKFLOW_ENROLLMENT_TERMINAL', exitCode: 12 });
      }
      if (requirement.workflowVersion === 2) return;
      const at = clock().toISOString();
      snapshot.writeJson(path, { ...requirement, workflowVersion: 2, workflowEpoch: 0, validationEpoch: 0,
        workflowHistory: [...(requirement.workflowHistory ?? []), { from: requirement.workflowVersion ?? 1, to: 2, reason, actor, at }],
        updatedAt: at });
    },
  });
}

/** Invalidate derived facts, retaining their original identities for audit. */
export function invalidateWorkflowFacts(snapshot, id, requirement, {
  kind = 'correction', reason, instructionRef, actor = 'unknown', at, cwd,
}) {
  const newIteration = kind !== 'correction' || completedDownstreamIteration({ snapshot, cwd, requirement });
  for (const path of [`release-approvals/${id}.json`, `environments/${id}/mixed-dev.json`]) {
    if (!snapshot.has(path)) continue;
    const fact = snapshot.readJson(path);
    snapshot.writeJson(path, {
      ...fact,
      ...(path.startsWith('release-approvals/') ? { revoked: true, revokedAt: at } : { invalidated: true }),
      invalidatedAt: at, invalidationReason: reason, instructionRef,
    });
  }
  if (kind !== 'correction' && snapshot.has(`ux-approvals/${id}.json`)) {
    const path = `ux-approvals/${id}.json`;
    snapshot.writeJson(path, { ...snapshot.readJson(path), revoked: true,
      revokedAt: at, revokedBy: actor, revokeReason: reason });
  }
  return {
    mergeStatus: null, mergedCommit: null, mergedAt: null,
    ...(requirement.workflowVersion === 2 ? {
      workflowEpoch: (requirement.workflowEpoch ?? 0) + (newIteration ? 1 : 0),
      validationEpoch: (requirement.validationEpoch ?? 0) + 1,
    } : {}),
    invalidatedAt: at,
  };
}
