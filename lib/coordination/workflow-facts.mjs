import { showUxApproval } from './ux-approvals.mjs';
import { assertRequirementId } from './validation.mjs';
import { showReview } from './reviews.mjs';

function completedDownstreamIteration({ snapshot, cwd, requirement }) {
  if (!cwd || !['dev_deployed', 'testing', 'user_acceptance', 'test_passed', 'prod_planning'].includes(requirement.lifecycle)) return false;
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

export async function enableAcceptanceWorkflow({ store, id, reason, uxBridgeSha256, actor = 'unknown', clock = () => new Date() }) {
  assertRequirementId(id);
  if (typeof reason !== 'string' || reason.trim().length < 10 || /[\r\n]/.test(reason)) {
    throw Object.assign(new Error('acceptance enrollment requires an auditable reason'), { code: 'INVALID_WORKFLOW_REASON', exitCode: 12 });
  }
  const uxItems = uxBridgeSha256 !== undefined;
  if (uxItems && !/^[a-f0-9]{64}$/.test(uxBridgeSha256)) {
    throw Object.assign(new Error('provide the SHA-256 of the committed legacy UX checklist bridge'),
      { code: 'UX_ITEM_BRIDGE_INVALID', exitCode: 12 });
  }
  return store.update({ operation: `enable explicit user acceptance for ${id}`,
    auditData: { requirementId: id, reason, actor, ...(uxItems ? { uxBridgeSha256 } : {}) }, mutate(snapshot) {
    const path = `requirements/${id}.json`;
    if (!snapshot.has(path)) throw Object.assign(new Error(`requirement ${id} is absent`), { code: 'REQUIREMENT_NOT_FOUND', exitCode: 14 });
    const requirement = snapshot.readJson(path);
    if (uxItems && requirement.uxItemAcceptanceVersion === 1 && requirement.uxItemAcceptanceBridgeSha256 !== uxBridgeSha256) {
      throw Object.assign(new Error('the enrolled UX checklist cannot be replaced; update the prototype and obtain a new approval'),
        { code: 'UX_ITEM_BRIDGE_INVALID', exitCode: 14 });
    }
    const existingScenarioPolicy = requirement.acceptanceWorkflowVersion === 1 && requirement.scenarioAcceptanceVersion === 1;
    if (existingScenarioPolicy && (!uxItems || requirement.uxItemAcceptanceVersion === 1)) return;
    if (requirement.workflowVersion !== 2) throw Object.assign(new Error('enable workflow v2 before enrolling user acceptance'), { code: 'REVIEW_WORKFLOW_REQUIRED', exitCode: 12 });
    if (!['todo', 'reviewing', 'req_confirmed', 'tech_design', 'in_dev', 'dev_deployed', 'testing'].includes(requirement.lifecycle)
      || (snapshot.has('freezes/dev.json') && snapshot.readJson('freezes/dev.json').requirementId === id)) {
      throw Object.assign(new Error('enroll before freezing a candidate; existing acceptance/release history cannot be rewritten'), { code: 'ACCEPTANCE_ENROLLMENT_TOO_LATE', exitCode: 12 });
    }
    const approval = uxItems && showUxApproval({ snapshot, id });
    if (uxItems && (requirement.uxImpact !== 'admin-ui' || requirement.deliveryProfile !== 'runtime'
      || !approval || approval.version !== requirement.version)) {
      throw Object.assign(new Error('the legacy UX checklist bridge requires an existing approval on the current runtime requirement version'), {
        code: 'UX_ITEM_LEGACY_APPROVAL_REQUIRED', exitCode: 14,
      });
    }
    const at = clock().toISOString();
    const policy = uxItems ? { policy: 'ux-item-acceptance', approvedCommit: approval.approvedCommit } : { policy: 'scenario-acceptance' };
    snapshot.writeJson(path, { ...requirement, acceptanceWorkflowVersion: 1, scenarioAcceptanceVersion: 1,
      ...(uxItems ? { uxItemAcceptanceVersion: 1, uxItemAcceptanceBridge: true, uxItemAcceptanceBridgeSha256: uxBridgeSha256 } : {}),
      workflowHistory: [...(requirement.workflowHistory ?? []), { ...policy, from: 0, to: 1, reason, actor, at }], updatedAt: at });
  } });
}

/** Invalidate derived facts, retaining their original identities for audit. */
export function invalidateWorkflowFacts(snapshot, id, requirement, {
  kind = 'correction', reason, instructionRef, actor = 'unknown', at, cwd,
  preserveReviewEpochs = false,
}) {
  const newIteration = !preserveReviewEpochs
    && (kind !== 'correction' || completedDownstreamIteration({ snapshot, cwd, requirement }));
  for (const path of [`release-approvals/${id}.json`, `environments/${id}/mixed-dev.json`]) {
    if (!snapshot.has(path)) continue;
    const fact = snapshot.readJson(path);
    snapshot.writeJson(path, {
      ...fact,
      ...(path.startsWith('release-approvals/') ? { revoked: true, revokedAt: at } : { invalidated: true }),
      invalidatedAt: at, invalidationReason: reason, instructionRef,
    });
  }
  if (['ux', 'requirements'].includes(kind) && snapshot.has(`ux-approvals/${id}.json`)) {
    const path = `ux-approvals/${id}.json`;
    snapshot.writeJson(path, { ...snapshot.readJson(path), revoked: true,
      revokedAt: at, revokedBy: actor, revokeReason: reason });
  }
  const nextEpoch = (requirement.workflowEpoch ?? 0) + (newIteration ? 1 : 0);
  const stages = ['requirements', 'ux', 'design', 'implementation', 'verification', 'release', 'closure'];
  const first = { requirements: 'requirements', ux: 'ux', design: 'design', correction: 'implementation' }[kind];
  const affected = stages.slice(stages.indexOf(first));
  // Stage-local epochs retain earlier approvals/reviews without copying or
  // rewriting their immutable reports into a newly manufactured review round.
  const reviewEpochs = Object.fromEntries(stages.map(stage => [stage,
    newIteration && affected.includes(stage) ? nextEpoch : requirement.reviewEpochs?.[stage] ?? requirement.workflowEpoch ?? 0]));
  const acceptancePath = `acceptance/${id}/current.json`;
  if (snapshot.has(acceptancePath)) {
    const pointer = snapshot.readJson(acceptancePath);
    snapshot.writeJson(acceptancePath, { ...pointer, invalidated: true, invalidatedAt: at, invalidationReason: reason });
  }
  return {
    mergeStatus: null, mergedCommit: null, mergedAt: null,
    ...(requirement.workflowVersion === 2 ? {
      workflowEpoch: nextEpoch,
      reviewEpochs,
      validationEpoch: (requirement.validationEpoch ?? 0) + 1,
      invalidation: { kind, affectedStages: affected, retainedStages: stages.filter(stage => !affected.includes(stage)),
        retainedUx: !['ux', 'requirements'].includes(kind), backendDeployment: 'revalidate-input-equivalence', at },
    } : {}),
    invalidatedAt: at,
  };
}
