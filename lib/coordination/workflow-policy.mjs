import { evaluateReviewReadiness } from './reviews.mjs';
import { inspectFeedbackArtifacts } from './feedback.mjs';
import { revisionMatchesDeployment } from './leases.mjs';
import { approvalFactFromSnapshot } from './approvals.mjs';
import { uiAcceptanceRequired, validateUiAcceptanceReport, resolveAcceptanceFact, userAcceptanceStageRequired } from './ui-acceptance.mjs';
import { evaluateUxReadiness } from './ux-approvals.mjs';

export function workflowReviewStage(requirement, to) {
  if (to === 'req_confirmed') return 'requirements';
  if (to === 'tech_design') return requirement.uxImpact === 'admin-ui' ? 'ux' : null;
  if (to === 'in_dev') return 'design';
  if (to === 'dev_deployed' || (to === 'testing' && requirement.deliveryProfile !== 'runtime')) return 'implementation';
  if (['user_acceptance', 'test_passed', 'merged'].includes(to)) return 'verification';
  if (to === 'prod_deployed') return 'release';
  if (to === 'done') return 'closure';
  return null;
}

// Recovery follows the durable attempt, not the current tenant of shared dev.
// Commands that record a human decision remain templates until that direct
// decision is available; this diagnostic never supplies authorization itself.
export function acceptanceRecovery({ snapshot, requirement }) {
  if (requirement.acceptanceWorkflowVersion !== 1 || requirement.deliveryProfile !== 'runtime') return null;
  const id = requirement.id;
  const inspect = `pnpm coord freeze show dev --requirement ${id} --json`;
  const pointerPath = `acceptance/${id}/current.json`;
  const pointer = snapshot.has(pointerPath) ? snapshot.readJson(pointerPath) : null;
  if (pointer?.invalidated) return { state: 'reworked', command: `pnpm coord lifecycle next ${id} --dry-run`,
    message: `complete the current ${requirement.lifecycle} stage; the previous candidate is invalidated`, preparationCommands: [], inspectCommand: inspect, requiresHumanDecision: false };
  let candidate;
  try { candidate = resolveAcceptanceFact(snapshot, id); }
  catch (error) { return { state: 'invalid', command: inspect, message: error.message, preparationCommands: [], inspectCommand: inspect, requiresHumanDecision: false }; }
  if (!candidate?.attemptId) return null;
  const base = { state: candidate.windowState, candidateId: candidate.candidateId, attemptId: candidate.attemptId,
    preparationCommands: [], inspectCommand: inspect, requiresHumanDecision: false };
  const batch = `pnpm coord lifecycle rework-batch ${id} --batch <file> --json`;
  if (candidate.windowState === 'released') return { ...base, command: batch, requiresHumanDecision: true,
    message: 'this candidate was abandoned; classify the direct feedback against its candidateId and apply one feedback batch before preparing another candidate' };
  if (candidate.version !== requirement.version || candidate.validationEpoch !== (requirement.validationEpoch ?? 0)) return { ...base,
    state: 'stale', command: batch, message: 'the candidate no longer matches the current requirement; classify the change before preparing a new candidate' };
  if (candidate.windowState === 'accepted') return { ...base,
    command: requirement.lifecycle === 'user_acceptance' ? `pnpm coord reconcile ${id} --json` : `pnpm coord lifecycle next ${id} --dry-run`,
    message: 'the direct human decision is preserved; follow the remaining merge and release gates without reacquiring the acceptance window' };
  if (candidate.windowState === 'paused') {
    const path = `environments/${id}/mixed-dev.json`;
    const environment = snapshot.has(path) ? snapshot.readJson(path) : null;
    const preparationCommands = [`pnpm coord lock acquire dev --requirement ${id} --ttl 8h --json`];
    if (candidate.mixedEnvironmentIdentity && environment?.frontend?.artifactSha256) return { ...base, preparationCommands,
      command: `node scripts/mixed-frontend.mjs --app ${environment.frontend.app} --requirement ${id} --resume ${environment.frontend.artifactSha256}`,
      message: 'acquire dev and restore the preserved frontend artifact; resume verifies the same backend snapshot, frontend content and health' };
    const service = candidate.deploymentSnapshot?.services?.includes('admin') ? 'admin' : 'web';
    return { ...base, preparationCommands,
      command: `pnpm coord freeze resume dev --requirement ${id} --base-url https://${service}-dev.hongli-ruian.com --json`,
      message: 'acquire dev and resume the same candidate after its deployment identity and frontend health are verified' };
  }
  return { ...base, command: `pnpm coord freeze unfreeze dev --requirement ${id} --outcome accepted --reason "<acceptance summary>" --authorized-by <user> --instruction-ref user-message:<id> --json`,
    requiresHumanDecision: true, message: 'complete the current interactive and visual comparison, then record the direct user decision; use a classified feedback batch for requested changes' };
}

export function humanAcceptanceReadiness({ snapshot, cwd, requirement, currentCommit }) {
  if (requirement.workflowVersion !== 2 || requirement.deliveryProfile !== 'runtime') return { ok: true, missing: [] };
  const recovery = acceptanceRecovery({ snapshot, requirement });
  const missing = [{ code: 'HUMAN_ACCEPTANCE_REQUIRED', message: 'accept the current verified candidate, or provide explicit current automatic-release authorization',
    remediation: recovery?.command ?? `pnpm coord freeze show dev --requirement ${requirement.id} --json`,
    ...(recovery?.preparationCommands.length ? { preparationCommands: recovery.preparationCommands } : {}) }];
  try {
    const approval = approvalFactFromSnapshot(snapshot, requirement.id);
    const mixedPath = `environments/${requirement.id}/mixed-dev.json`;
    const mixedCandidate = snapshot.has(mixedPath) && snapshot.readJson(mixedPath)?.mode === 'mixed-dev';
    const uiRequired = uiAcceptanceRequired({ requirement, snapshot });
    if (mixedCandidate) missing[0].message = 'accept the current verified mixed frontend/backend candidate with a direct human decision';
    if (uiRequired) missing[0].message = 'complete interactive and visual comparison of the frozen UI candidate, then record direct human acceptance';
    if (recovery && ['paused', 'released', 'reworked', 'stale', 'invalid'].includes(recovery.state)) missing[0].message = recovery.message;
    if (!uiRequired && !mixedCandidate && approval && approval.validationEpoch === (requirement.validationEpoch ?? 0)
      && /^user-message:[A-Za-z0-9._:-]{6,}$/.test(approval.instructionRef)) return { ok: true, missing: [], mode: 'authorized-auto' };
    const freeze = resolveAcceptanceFact(snapshot, requirement.id);
    if (!freeze || freeze.requirementId !== requirement.id || freeze.version !== requirement.version
      || freeze.validationEpoch !== (requirement.validationEpoch ?? 0)
      || !freeze.acceptance?.authorizedBy || !/^user-message:[A-Za-z0-9._:-]{6,}$/.test(freeze.acceptance?.instructionRef ?? '')
      || !Number.isFinite(Date.parse(freeze.acceptance?.acceptedAt))) return { ok: false, missing };
    if (freeze.commit !== currentCommit && (!cwd || !revisionMatchesDeployment({ cwd, requirementId: requirement.id,
      fromCommit: freeze.commit, toCommit: currentCommit }).matches)) return { ok: false, missing };
    if (freeze.mixedEnvironmentIdentity) {
      const path = `environments/${requirement.id}/mixed-dev.json`;
      if (!snapshot.has(path)) return { ok: false, missing };
      const environment = snapshot.readJson(path);
      if (environment.identitySha256 !== freeze.mixedEnvironmentIdentity || environment.invalidated) return { ok: false, missing };
    }
    if (freeze.feedbackFingerprint && cwd && inspectFeedbackArtifacts({ cwd, id: requirement.id }).fingerprint !== freeze.feedbackFingerprint) return { ok: false, missing };
    if (uiRequired) {
      if (!cwd || !freeze.acceptance.uiEvidenceSha256
        || validateUiAcceptanceReport({ cwd, requirement, freeze }).evidenceSha256 !== freeze.acceptance.uiEvidenceSha256) return { ok: false, missing };
    }
    return { ok: true, missing: [], mode: 'human', freeze };
  } catch (error) {
    return { ok: false, missing: [...missing, { code: error.code ?? 'ACCEPTANCE_INVALID', message: error.message }] };
  }
}

export function evaluateWorkflowReadiness({ snapshot, cwd, requirement, to, ref = 'HEAD', currentCommit }) {
  if (requirement.workflowVersion !== 2) return { ok: true, missing: [], exempt: 'legacy' };
  const stage = workflowReviewStage(requirement, to);
  const review = stage ? evaluateReviewReadiness({ snapshot, cwd, requirement, stage, ref }) : { ok: true, missing: [] };
  if (to === 'user_acceptance' && userAcceptanceStageRequired({ requirement, snapshot })) {
    const candidate = resolveAcceptanceFact(snapshot, requirement.id);
    if (!candidate || candidate.validationEpoch !== (requirement.validationEpoch ?? 0)) {
      review.missing.push({ code: 'ACCEPTANCE_CANDIDATE_REQUIRED', message: 'freeze the verified candidate to open its human acceptance window',
        remediation: `pnpm coord freeze enter dev --requirement ${requirement.id} --candidate <id> --evidence <sha> --deployment-snapshot <file>` });
      review.ok = false;
    }
  }
  const acceptance = (to === 'test_passed' && uiAcceptanceRequired({ requirement, snapshot }))
    || ['prod_planning', 'prod_deployed'].includes(to)
    ? humanAcceptanceReadiness({ snapshot, cwd, requirement, currentCommit }) : { ok: true, missing: [] };
  const ux = to === 'test_passed' && requirement.uxImpact === 'admin-ui'
    ? evaluateUxReadiness({ snapshot, cwd, requirement }) : { ok: true, missing: [] };
  return { ok: review.ok && acceptance.ok && ux.ok, stage,
    missing: [...review.missing, ...acceptance.missing, ...ux.missing.map(code => ({ code, message: 'current UX confirmation is required for visual acceptance' }))] };
}
