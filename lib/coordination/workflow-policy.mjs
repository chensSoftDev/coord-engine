import { evaluateReviewReadiness } from './reviews.mjs';
import { inspectFeedbackArtifacts } from './feedback.mjs';
import { revisionMatchesDeployment } from './leases.mjs';
import { approvalFactFromSnapshot } from './approvals.mjs';
import { uiAcceptanceRequired, validateUiAcceptanceReport } from './ui-acceptance.mjs';
import { evaluateUxReadiness } from './ux-approvals.mjs';

export function workflowReviewStage(requirement, to) {
  if (to === 'req_confirmed') return 'requirements';
  if (to === 'tech_design') return requirement.uxImpact === 'admin-ui' ? 'ux' : null;
  if (to === 'in_dev') return 'design';
  if (to === 'dev_deployed' || (to === 'testing' && requirement.deliveryProfile !== 'runtime')) return 'implementation';
  if (['test_passed', 'merged'].includes(to)) return 'verification';
  if (to === 'prod_deployed') return 'release';
  if (to === 'done') return 'closure';
  return null;
}

export function humanAcceptanceReadiness({ snapshot, cwd, requirement, currentCommit }) {
  if (requirement.workflowVersion !== 2 || requirement.deliveryProfile !== 'runtime') return { ok: true, missing: [] };
  const missing = [{ code: 'HUMAN_ACCEPTANCE_REQUIRED', message: 'accept the current verified candidate, or provide explicit current automatic-release authorization',
    remediation: `pnpm coord freeze show dev --json` }];
  try {
    const approval = approvalFactFromSnapshot(snapshot, requirement.id);
    const mixedPath = `environments/${requirement.id}/mixed-dev.json`;
    const mixedCandidate = snapshot.has(mixedPath) && snapshot.readJson(mixedPath)?.mode === 'mixed-dev';
    const uiRequired = uiAcceptanceRequired({ requirement, snapshot });
    if (mixedCandidate) missing[0].message = 'accept the current verified mixed frontend/backend candidate with a direct human decision';
    if (uiRequired) missing[0].message = 'complete interactive and visual comparison of the frozen UI candidate, then record direct human acceptance';
    if (!uiRequired && !mixedCandidate && approval && approval.validationEpoch === (requirement.validationEpoch ?? 0)
      && /^user-message:[A-Za-z0-9._:-]{6,}$/.test(approval.instructionRef)) return { ok: true, missing: [], mode: 'authorized-auto' };
    const freeze = snapshot.has('freezes/dev.json') ? snapshot.readJson('freezes/dev.json') : null;
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
  const acceptance = (to === 'test_passed' && uiAcceptanceRequired({ requirement, snapshot }))
    || ['prod_planning', 'prod_deployed'].includes(to)
    ? humanAcceptanceReadiness({ snapshot, cwd, requirement, currentCommit }) : { ok: true, missing: [] };
  const ux = to === 'test_passed' && requirement.uxImpact === 'admin-ui'
    ? evaluateUxReadiness({ snapshot, cwd, requirement }) : { ok: true, missing: [] };
  return { ok: review.ok && acceptance.ok && ux.ok, stage,
    missing: [...review.missing, ...acceptance.missing, ...ux.missing.map(code => ({ code, message: 'current UX confirmation is required for visual acceptance' }))] };
}
