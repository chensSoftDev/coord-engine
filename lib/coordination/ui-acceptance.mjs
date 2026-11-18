import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { evidencePath } from './evidence.mjs';
import { isSafeReviewPath } from './feedback.mjs';
import { readAcceptanceScenarios, validateScenarioHandoff } from './acceptance-scenarios.mjs';
export { parseAcceptanceScenarios, renderUserAcceptanceGuide, validateScenarioHandoff } from './acceptance-scenarios.mjs';

export class UiAcceptanceError extends Error {
  constructor(message, code = 'UI_ACCEPTANCE_INVALID') {
    super(message); this.name = 'UiAcceptanceError'; this.code = code; this.exitCode = 14;
  }
}
const fail = (message, code) => { throw new UiAcceptanceError(message, code); };
const text = value => typeof value === 'string' && value.trim().length > 0;
const digest = value => createHash('sha256').update(value).digest('hex');
function trackedRegular(cwd, path) {
  if (!isSafeReviewPath(path)) return false;
  let cursor = cwd;
  for (const part of path.split('/')) {
    cursor = join(cursor, part);
    try { if (lstatSync(cursor).isSymbolicLink()) return false; } catch { return false; }
  }
  if (!lstatSync(cursor).isFile()) return false;
  return spawnSync('git', ['ls-files', '--error-unmatch', '--', path], {
    cwd, stdio: 'ignore', maxBuffer: 64 * 1024 * 1024,
  }).status === 0
    && !spawnSync('git', ['status', '--porcelain=v1', '--', path], {
      cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    }).stdout.trim();
}

export function uiAcceptanceRequired({ requirement, snapshot }) {
  if (requirement?.workflowVersion !== 2 || requirement.deliveryProfile !== 'runtime') return false;
  const services = requirement.resources?.services ?? requirement.services ?? [];
  const mixedPath = `environments/${requirement.id}/mixed-dev.json`;
  const mixed = snapshot?.has?.(mixedPath) ? snapshot.readJson(mixedPath) : null;
  return requirement.uxImpact === 'admin-ui' || (Array.isArray(services) && services.some(service => ['admin', 'web'].includes(service)))
    || (mixed?.mode === 'mixed-dev' && mixed.invalidated !== true);
}

// Enrollment is explicit for existing work. Adding this policy must not insert
// a new historical state into a requirement that already passed Testing.
export function userAcceptanceStageRequired({ requirement, snapshot }) {
  return requirement?.acceptanceWorkflowVersion === 1 && uiAcceptanceRequired({ requirement, snapshot });
}

export function acceptanceAttemptId({ requirementId, candidateId, machineVerificationEvidence, validationEpoch = 0 }) {
  return `attempt-${digest(JSON.stringify({ requirementId, candidateId, machineVerificationEvidence, validationEpoch })).slice(0, 32)}`;
}

export function acceptanceAttemptPath(id, attemptId) {
  if (!/^(I|F|B)-\d{3,}$/.test(id ?? '') || !/^attempt-[a-f0-9]{16,64}$/.test(attemptId ?? '')) {
    fail('invalid acceptance attempt identity', 'ACCEPTANCE_IDENTITY_INVALID');
  }
  return `acceptance/${id}/${attemptId}.json`;
}

// Long-lived candidate/decision facts are independent of freezes/dev.json,
// which is only an exclusive human-use window. Legacy requirements still read
// their original freeze, but a stale new pointer never falls back to it.
export function resolveAcceptanceFact(snapshot, id) {
  const pointerPath = `acceptance/${id}/current.json`;
  if (snapshot.has(pointerPath)) {
    const pointer = snapshot.readJson(pointerPath);
    if (pointer.invalidated) return null;
    if (pointer.requirementId !== id || pointer.schemaVersion !== 1) fail('invalid acceptance pointer', 'ACCEPTANCE_IDENTITY_INVALID');
    const path = acceptanceAttemptPath(id, pointer.attemptId);
    if (!snapshot.has(path)) fail('acceptance candidate fact is missing', 'ACCEPTANCE_IDENTITY_INVALID');
    const fact = snapshot.readJson(path);
    if (fact.requirementId !== id || fact.attemptId !== pointer.attemptId) fail('acceptance candidate identity differs from pointer', 'ACCEPTANCE_IDENTITY_INVALID');
    const decisionPath = path.replace(/\.json$/, '-decision.json');
    const decision = snapshot.has(decisionPath) ? snapshot.readJson(decisionPath) : null;
    if (pointer.state === 'accepted' && (decision?.outcome !== 'accepted' || !decision.acceptance)) fail('accepted pointer has no human decision', 'ACCEPTANCE_IDENTITY_INVALID');
    return { ...fact, windowState: pointer.state,
      ...(decision?.outcome === 'accepted' ? { acceptance: decision.acceptance } : {}) };
  }
  const freeze = snapshot.has('freezes/dev.json') ? snapshot.readJson('freezes/dev.json') : null;
  return freeze?.requirementId === id ? freeze : null;
}

export function validateUiAcceptanceReport({ cwd, requirement, freeze }) {
  if (requirement.scenarioAcceptanceVersion === 1) {
    readAcceptanceScenarios({ cwd, requirement });
    if (!freeze.scenarioHandoff) throw new UiAcceptanceError('freeze a candidate after the complete scenario handoff has been verified', 'SCENARIO_HANDOFF_INVALID');
    validateScenarioHandoff({ cwd, requirement, machineVerificationEvidence: freeze.machineVerificationEvidence,
      frontendIdentity: freeze.mixedEnvironmentIdentity ?? null, expectedBinding: freeze.scenarioHandoff });
  }
  const root = dirname(evidencePath({ cwd, id: requirement.id }));
  const relativeRoot = relative(cwd, root).split('\\').join('/');
  const versioned = requirement.acceptanceWorkflowVersion === 1;
  if (versioned) acceptanceAttemptPath(requirement.id, freeze.attemptId);
  const reportPath = versioned ? `${relativeRoot}/acceptance/${freeze.attemptId}/UI_ACCEPTANCE.json` : `${relativeRoot}/UI_ACCEPTANCE.json`;
  if (!trackedRegular(cwd, reportPath)) fail('UI_ACCEPTANCE.json must be a clean committed regular file', 'UI_ACCEPTANCE_REPORT_REQUIRED');
  let report;
  try { report = JSON.parse(readFileSync(join(cwd, reportPath), 'utf8')); }
  catch { fail('UI_ACCEPTANCE.json is not valid JSON'); }
  if (report?.schemaVersion !== 1 || report.requirementId !== requirement.id || report.candidateId !== freeze.candidateId
    || (versioned && report.attemptId !== freeze.attemptId)
    || report.machineVerificationEvidence !== freeze.machineVerificationEvidence
    || report.frontendIdentity !== (freeze.mixedEnvironmentIdentity ?? null)
    || !text(report.baselineSource) || !trackedRegular(cwd, report.baselineSource)
    || (requirement.uxImpact === 'admin-ui' && report.baselineSource !== `${relativeRoot}/UX_SPEC.md`
      && !report.baselineSource.startsWith('apps/ux-prototype/'))) {
    fail('interactive and visual report does not match the frozen candidate and tracked UX baseline');
  }
  const interactions = report.interactions;
  const comparisons = report.visualComparisons;
  if (!Array.isArray(interactions) || !interactions.length || !Array.isArray(comparisons) || !comparisons.length) {
    fail('interactive cases and visual comparisons are both required');
  }
  const ids = new Set();
  for (const item of [...interactions, ...comparisons]) {
    if (!item || !/^[A-Za-z][A-Za-z0-9_-]{1,63}$/.test(item.id ?? '') || ids.has(item.id)
      || !text(item.scenario) || !text(item.expected) || !text(item.observed)) fail('each acceptance case needs a unique ID and observable expectation/result');
    ids.add(item.id);
  }
  if (interactions.some(item => item.outcome !== 'pass') || comparisons.some(item => item.outcome !== 'match')) {
    fail('unresolved interaction or visual differences require correction or UX reapproval', 'UI_ACCEPTANCE_DIFFERENCE_OPEN');
  }
  if (requirement.scenarioAcceptanceVersion === 1) {
    const { plan } = readAcceptanceScenarios({ cwd, requirement });
    const required = plan.scenarios;
    const allIds = new Set(required.map(s => s.id));
    if ([...interactions, ...comparisons].some(item => !allIds.has(item.scenarioId))
      || required.some(s => !(s.kind === 'business' ? interactions : comparisons).some(item => item.scenarioId === s.id))) {
      throw new UiAcceptanceError('final interactions and visual comparisons must cover every designed scenario ID', 'SCENARIO_UI_COVERAGE_MISSING');
    }
  }
  const artifacts = {}, actualScreenshots = new Map();
  for (const item of comparisons) {
    if (item.baselineScreenshot === item.actualScreenshot) fail('baseline and actual screenshots must be distinct files');
    const screenshotDigests = {};
    for (const key of ['baselineScreenshot', 'actualScreenshot']) {
      const path = item[key];
      const ownImage = text(path) && (path.startsWith(`${relativeRoot}/reviews/screenshots/`)
        || (versioned && path.startsWith(`${relativeRoot}/acceptance/${freeze.attemptId}/screenshots/`)));
      if (!ownImage || !/\.(png|webp)$/.test(path)
        || !trackedRegular(cwd, path)) fail('visual comparison screenshots must be clean committed images in this requirement');
      const data = readFileSync(join(cwd, path));
      if (data.length < 16 || data.length > 10 * 1024 * 1024) fail('visual comparison screenshot size is invalid');
      if (path.endsWith('.png') && !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail('visual comparison PNG signature is invalid');
      if (path.endsWith('.webp') && (data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WEBP')) fail('visual comparison WebP signature is invalid');
      screenshotDigests[key] = digest(data);
      artifacts[path] = screenshotDigests[key];
    }
    // B-248: identical content means the "comparison" is one image copied to
    // two names — the machine layer must not certify that as a visual check.
    if (screenshotDigests.baselineScreenshot === screenshotDigests.actualScreenshot) {
      fail(`baseline and actual screenshots for ${item.id} have identical content; a copied image is not a comparison`, 'UI_ACCEPTANCE_IDENTICAL_SCREENSHOTS');
    }
    if (requirement.scenarioAcceptanceVersion === 1) {
      const previous = actualScreenshots.get(screenshotDigests.actualScreenshot);
      if (previous && previous !== item.scenarioId) throw new UiAcceptanceError('independent UI scenarios require their own actual captures', 'SCENARIO_UI_COVERAGE_MISSING');
      actualScreenshots.set(screenshotDigests.actualScreenshot, item.scenarioId);
    }
  }
  return { reportPath, report, evidenceSha256: digest(JSON.stringify({ report: digest(readFileSync(join(cwd, reportPath))), artifacts })) };
}
