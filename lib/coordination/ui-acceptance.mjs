import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { evidencePath } from './evidence.mjs';
import { isSafeReviewPath } from './feedback.mjs';

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
  return spawnSync('git', ['ls-files', '--error-unmatch', '--', path], { cwd, stdio: 'ignore' }).status === 0
    && !spawnSync('git', ['status', '--porcelain=v1', '--', path], { cwd, encoding: 'utf8' }).stdout.trim();
}

export function uiAcceptanceRequired({ requirement, snapshot }) {
  if (requirement?.workflowVersion !== 2 || requirement.deliveryProfile !== 'runtime') return false;
  const services = requirement.resources?.services ?? requirement.services ?? [];
  const mixedPath = `environments/${requirement.id}/mixed-dev.json`;
  const mixed = snapshot?.has?.(mixedPath) ? snapshot.readJson(mixedPath) : null;
  return requirement.uxImpact === 'admin-ui' || (Array.isArray(services) && services.some(service => ['admin', 'web'].includes(service)))
    || (mixed?.mode === 'mixed-dev' && mixed.invalidated !== true);
}

export function validateUiAcceptanceReport({ cwd, requirement, freeze }) {
  const root = dirname(evidencePath({ cwd, id: requirement.id }));
  const relativeRoot = relative(cwd, root).split('\\').join('/');
  const reportPath = `${relativeRoot}/UI_ACCEPTANCE.json`;
  if (!trackedRegular(cwd, reportPath)) fail('UI_ACCEPTANCE.json must be a clean committed regular file', 'UI_ACCEPTANCE_REPORT_REQUIRED');
  let report;
  try { report = JSON.parse(readFileSync(join(cwd, reportPath), 'utf8')); }
  catch { fail('UI_ACCEPTANCE.json is not valid JSON'); }
  if (report?.schemaVersion !== 1 || report.requirementId !== requirement.id || report.candidateId !== freeze.candidateId
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
  const artifacts = {};
  for (const item of comparisons) {
    if (item.baselineScreenshot === item.actualScreenshot) fail('baseline and actual screenshots must be distinct files');
    for (const key of ['baselineScreenshot', 'actualScreenshot']) {
      const path = item[key];
      if (!text(path) || !path.startsWith(`${relativeRoot}/reviews/screenshots/`) || !/\.(png|webp)$/.test(path)
        || !trackedRegular(cwd, path)) fail('visual comparison screenshots must be clean committed images in this requirement');
      const data = readFileSync(join(cwd, path));
      if (data.length < 16 || data.length > 10 * 1024 * 1024) fail('visual comparison screenshot size is invalid');
      if (path.endsWith('.png') && !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail('visual comparison PNG signature is invalid');
      if (path.endsWith('.webp') && (data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WEBP')) fail('visual comparison WebP signature is invalid');
      artifacts[path] = digest(data);
    }
  }
  return { reportPath, report, evidenceSha256: digest(JSON.stringify({ report: digest(readFileSync(join(cwd, reportPath))), artifacts })) };
}
