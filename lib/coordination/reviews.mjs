import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { actor, knownSession } from './leases.mjs';
import { assertRequirementId } from './validation.mjs';
import { REVIEW_STAGES, evaluateFeedbackReadiness, isSafeReviewPath, reviewRepository } from './feedback.mjs';

export class ReviewError extends Error {
  constructor(message, { code = 'REVIEW_INVALID', data = {} } = {}) {
    super(message); this.name = 'ReviewError'; this.code = code; this.exitCode = 14; this.data = data;
  }
}
const fail = (code, message, data) => { throw new ReviewError(message, { code, data }); };
const issue = (code, message, remediation) => ({ code, message, ...(remediation ? { remediation } : {}) });
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const stable = (value) => JSON.stringify(value, (_key, item) => object(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const fullHash = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
function copyReport(report) {
  try {
    if (!object(report)) throw new Error('not an object');
    return JSON.parse(JSON.stringify(report));
  } catch { fail('REVIEW_REPORT_INVALID', 'report must be a JSON object'); }
}
const ids = (value) => Array.isArray(value) && value.every((id) => typeof id === 'string' && /^[A-Za-z][A-Za-z0-9_-]{1,63}$/.test(id)) && new Set(value).size === value.length;
const epoch = (requirement) => requirement.workflowEpoch ?? 0;
function assertScope(requirement, stage) {
  assertRequirementId(requirement.id);
  if (!REVIEW_STAGES.includes(stage)) fail('REVIEW_STAGE_INVALID', `unsupported review stage: ${stage}`);
  if (requirement.workflowVersion !== 2 || !Number.isSafeInteger(epoch(requirement)) || epoch(requirement) < 0 || !requirement.version) {
    fail('REVIEW_WORKFLOW_REQUIRED', 'a version-bound workflowVersion 2 requirement with a valid workflowEpoch is required');
  }
}
function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) fail('REVIEW_GIT_ERROR', `git ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout;
}
const ancestor = (cwd, from, to) => /^[0-9a-f]{40}$/.test(from ?? '') && spawnSync('git', ['merge-base', '--is-ancestor', from, to], { cwd, stdio: 'ignore' }).status === 0;
const commitExists = (cwd, ref) => /^[0-9a-f]{40}$/.test(ref ?? '') && spawnSync('git', ['cat-file', '-e', `${ref}^{commit}`], { cwd, stdio: 'ignore' }).status === 0;
function rootFor(repository, id) {
  const roots = [...new Set([...repository.entries.keys()].filter((path) => path.startsWith(`docs/product/current/${id}-`) && path.endsWith('/FEEDBACK.json')).map((path) => path.slice(0, -'/FEEDBACK.json'.length)))];
  return roots.length === 1 ? roots[0] : null;
}
function excluded(path, root) {
  if (!root || !path.startsWith(`${root}/`)) return false;
  const relative = path.slice(root.length + 1);
  return ['TEST_EVIDENCE.json', 'COMPLETION.json', 'UI_ACCEPTANCE.json'].includes(relative)
    || /^reviews\/screenshots\/[^/]+\.(?:png|webp)$/.test(relative)
    || /^reviews\/(?:requirements|ux|design|implementation|verification|release|closure)-(?:epoch-\d+-)?(?:round-[12]|verify-round-[12])\.json$/.test(relative);
}
function inStage(path, stage, root) {
  if (['implementation', 'verification', 'release', 'closure'].includes(stage)) return true;
  if (!root) return false;
  if (stage === 'requirements') return [`${root}/REQUIREMENT.md`, `${root}/FEEDBACK.json`].includes(path);
  if (stage === 'ux') return [`${root}/UX_SPEC.md`, `${root}/FEEDBACK.json`, 'pnpm-lock.yaml'].includes(path) || path.startsWith('apps/ux-prototype/');
  return path.startsWith(`${root}/`) || path.startsWith('apps/ux-prototype/') || path === 'pnpm-lock.yaml';
}
function canonical(path, source, root, id) {
  if (path === 'BACKLOG.md') {
    return source.split(/\r?\n/).map((line) => {
      const cells = line.split('|');
      if (!/^(I|F|B)-\d{3,}$/.test(cells[1]?.trim() ?? '')) return line;
      // Preserve requirement identity/scope and all non-projection prose.
      if (cells.length > 4) cells[4] = ' <status projection> ';
      if (cells[1].trim() === id && cells.length > 6) cells[6] = ' <notes projection> ';
      return cells.join('|');
    }).join('\n');
  }
  if (path === `${root}/ACCEPTANCE.md`) return source.split(/^## 本地验收结果\s*$/m)[0].trimEnd();
  if (path === `${root}/CHECKLIST.md`) return source.replace(/^(\s*- )\[[ xX]\]/gm, '$1[ ]')
    .replace(/(?:\n(?:-\s*)?(?:结果|结论|备注)[:：][^\n]*)+\s*$/, '').trimEnd();
  return null;
}
function subject({ cwd, requirement, stage, ref = 'HEAD' }) {
  const repository = reviewRepository({ cwd, ref });
  const root = rootFor(repository, requirement.id);
  const missing = [];
  if (!root) missing.push(issue('REVIEW_SUBJECT_INVALID', 'exactly one committed requirement FEEDBACK.json is required'));
  const relevant = (path) => inStage(path, stage, root) && !excluded(path, root);
  // Implementation and verification review the feature's own committed delta.
  // A newer origin/main may contain unrelated work from another requirement;
  // rebasing on it must not consume a second review round for unchanged inputs.
  let featurePaths = null;
  if (['implementation', 'verification'].includes(stage)) {
    const base = spawnSync('git', ['merge-base', repository.commit, 'origin/main'], { cwd, encoding: 'utf8' });
    if (base.status === 0) featurePaths = new Set(git(cwd, ['diff', '--name-only', '-z', '--no-renames', base.stdout.trim(), repository.commit]).split('\0').filter(Boolean));
  }
  const paths = [...repository.entries.keys()].filter((path) => relevant(path) && (!featurePaths
    || featurePaths.has(path) || path === 'BACKLOG.md' || (root && path.startsWith(`${root}/`)))).sort();
  const input = [];
  for (const path of paths) {
    const entry = repository.entries.get(path);
    // Gitlinks bind the exact shared-skill revision without reading its checkout.
    if (entry.mode !== '160000' && !repository.regular(path)) missing.push(issue('REVIEW_SUBJECT_INVALID', `${path} is not a regular committed input`));
    const special = path === 'BACKLOG.md' || path === `${root}/ACCEPTANCE.md` || path === `${root}/CHECKLIST.md`;
    const digest = special ? hash(canonical(path, repository.read(path), root, requirement.id)) : entry.oid;
    input.push([path, entry.mode, digest]);
  }
  for (const path of repository.changedPaths()) if (relevant(path)) missing.push(issue('REVIEW_SUBJECT_DIRTY', `${path} has uncommitted changes`));
  const scope = Object.fromEntries(['id', 'workflowVersion', 'workflowEpoch', 'version', 'uxImpact', 'deliveryProfile', 'services', 'migrationRequired'].map((key) => [key, key === 'workflowEpoch' ? epoch(requirement) : requirement[key]]));
  return { ok: missing.length === 0, missing, commit: repository.commit, root, paths,
    subjectFingerprint: hash(stable({ stage, scope, input })) };
}
function prefix(requirement, stage) { return `reviews/${requirement.id}/${stage}/epoch-${epoch(requirement)}`; }
const reviewId = (requirement, stage, round) => `${requirement.id}:${stage}:${epoch(requirement)}:${round}`;
function history({ snapshot, requirement, stage }) {
  const base = prefix(requirement, stage);
  const rounds = [];
  const verifications = new Map();
  for (const round of [1, 2]) {
    const path = `${base}/round-${round}.json`;
    if (!snapshot.has(path)) continue;
    const fact = snapshot.readJson(path);
    if (round !== rounds.length + 1 || fact.schemaVersion !== 1 || fact.requirementId !== requirement.id || fact.stage !== stage
      || fact.workflowEpoch !== epoch(requirement) || fact.round !== round || fact.reviewId !== reviewId(requirement, stage, round)
      || !fact.actor?.sessionId || !fact.recordedAt || !fullHash(fact.subjectFingerprint) || fact.reportHash !== hash(stable(fact.report))
      || fact.report?.subjectFingerprint !== fact.subjectFingerprint) fail('REVIEW_FACT_INVALID', `invalid immutable review fact: ${path}`);
    validateReport(fact.report, { requirement, stage });
    rounds.push(fact);
    const verificationPath = `${base}/verify-round-${round}.json`;
    if (snapshot.has(verificationPath)) {
      const verification = snapshot.readJson(verificationPath);
      if (verification.schemaVersion !== 1 || verification.reviewId !== fact.reviewId || verification.requirementId !== requirement.id
        || verification.stage !== stage || verification.round !== round || verification.workflowEpoch !== epoch(requirement)
        || !verification.actor?.sessionId || !verification.recordedAt || verification.reportHash !== hash(stable(verification.report))
        || verification.subjectFingerprint !== verification.report?.subjectFingerprint) fail('REVIEW_FACT_INVALID', `invalid immutable targeted verification: ${verificationPath}`);
      validateReport(verification.report, { requirement, stage, verification: true });
      accountFindings(fact.report.findings, verification.report.closedFindingIds, verification.report.remainingFindingIds, verification.report.newFindings ?? []);
      verifications.set(round, verification);
    }
  }
  // A missing first round or unknown round cannot manufacture a fresh budget.
  if (snapshot.paths?.().some((path) => path.startsWith(`${base}/`) && !/^\/(?:round-[12]|verify-round-[12])\.json$/.test(path.slice(base.length)))) {
    fail('REVIEW_FACT_INVALID', 'unexpected review round or state artifact');
  }
  for (const round of [1, 2]) if (snapshot.has(`${base}/verify-round-${round}.json`) && !rounds.some((fact) => fact.round === round)) fail('REVIEW_FACT_INVALID', 'targeted verification has no matching review');
  for (let index = 0; index < rounds.length; index += 1) {
    const previous = rounds[index - 1];
    accountRound(previous, previous && verifications.get(previous.round), rounds[index].report);
  }
  return { rounds, verifications };
}
function validateReport(report, { requirement, stage, verification = false, repository }) {
  const shared = ['schemaVersion', 'requirementId', 'stage', 'subjectFingerprint', 'feedbackIds'];
  const allowed = [...shared, ...(verification ? ['reviewId', 'closedFindingIds', 'remainingFindingIds', 'newFindings'] : ['verdict', 'findings', 'closedFindingIds'])];
  if (!object(report) || Object.keys(report).some((key) => !allowed.includes(key)) || report.schemaVersion !== 1
    || report.requirementId !== requirement.id || report.stage !== stage || !fullHash(report.subjectFingerprint) || !ids(report.feedbackIds)) {
    fail('REVIEW_REPORT_INVALID', 'report schema, requirement, stage, fingerprint or feedback IDs are invalid');
  }
  if (verification) {
    if (typeof report.reviewId !== 'string' || !ids(report.closedFindingIds) || !ids(report.remainingFindingIds)) fail('REVIEW_REPORT_INVALID', 'targeted verification needs reviewId and unique closed/remaining finding IDs');
    if (report.newFindings !== undefined) validateFindings(report.newFindings, repository);
    return;
  }
  if (!['pass', 'needs-fix'].includes(report.verdict) || !Array.isArray(report.findings)
    || (report.closedFindingIds !== undefined && !ids(report.closedFindingIds))) fail('REVIEW_REPORT_INVALID', 'a review needs verdict, findings and valid optional closedFindingIds');
  validateFindings(report.findings, repository);
  if (report.verdict === 'pass' && report.findings.some((finding) => ['P0', 'P1'].includes(finding.priority))) fail('REVIEW_OPEN_BLOCKERS', 'a pass report cannot contain open P0/P1 findings');
  if (report.verdict === 'needs-fix' && report.findings.length === 0) fail('REVIEW_REPORT_INVALID', 'needs-fix must record findings');
}
function safeRepairPath(cwd, path, repository) {
  if (!isSafeReviewPath(path) || /[*?\[\]{}]/.test(path)) return false;
  if (repository?.entries.has(path) && !repository.regular(path)) return false;
  if (cwd) {
    let cursor = cwd;
    for (const part of path.split('/')) {
      cursor = join(cursor, part);
      try { if (lstatSync(cursor).isSymbolicLink()) return false; } catch { /* a future file may be absent */ }
    }
  }
  return true;
}
function validateFindings(findings, repository) {
  if (!Array.isArray(findings)) fail('REVIEW_REPORT_INVALID', 'findings must be an array');
  const findingIds = new Set();
  for (const finding of findings) {
    if (!object(finding) || Object.keys(finding).some((key) => !['id', 'priority', 'message', 'paths', 'repairPaths'].includes(key))
      || !/^[A-Za-z][A-Za-z0-9_-]{1,63}$/.test(finding.id ?? '') || findingIds.has(finding.id)
      || !['P0', 'P1', 'P2', 'P3'].includes(finding.priority) || typeof finding.message !== 'string' || !finding.message.trim()
      || !Array.isArray(finding.paths) || finding.paths.length === 0 || new Set(finding.paths).size !== finding.paths.length
      || finding.paths.some((path) => !isSafeReviewPath(path) || (repository && !repository.regular(path)))
      || (finding.repairPaths !== undefined && (!Array.isArray(finding.repairPaths) || !finding.repairPaths.length
        || new Set(finding.repairPaths).size !== finding.repairPaths.length
        || finding.repairPaths.some((path) => !safeRepairPath(repository?.cwd, path, repository))))) {
      fail('REVIEW_REPORT_INVALID', 'findings require unique IDs, priority, message and tracked regular file paths');
    }
    findingIds.add(finding.id);
  }
}
function accountFindings(findings, closed, remaining, newlyFound = []) {
  const actual = [...closed, ...remaining];
  if (new Set(actual).size !== actual.length || actual.length !== findings.length || findings.some((finding) => !actual.includes(finding.id))) {
    fail('REVIEW_FINDING_OMITTED', 'every original finding must appear exactly once as closed or remaining');
  }
  if (newlyFound.some((finding) => actual.includes(finding.id) || findings.some((prior) => prior.id === finding.id))) {
    fail('REVIEW_FINDING_CHANGED', 'new finding IDs must not reuse an existing finding ID');
  }
}
function openFindings(fact, verification) {
  return verification ? [...fact.report.findings.filter((finding) => verification.report.remainingFindingIds.includes(finding.id)), ...(verification.report.newFindings ?? [])] : fact.report.findings;
}
function accountRound(previous, verification, report) {
  const prior = previous ? openFindings(previous, verification) : [];
  const closed = report.closedFindingIds ?? [];
  if (closed.some((id) => !prior.some((finding) => finding.id === id))) fail('REVIEW_FINDING_OMITTED', 'only known open findings may be closed');
  for (const finding of prior) {
    const next = report.findings.find((item) => item.id === finding.id);
    if (closed.includes(finding.id)) {
      if (next) fail('REVIEW_FINDING_OMITTED', `${finding.id} cannot be both open and closed`);
    } else if (!next) fail('REVIEW_FINDING_OMITTED', `${finding.id} is omitted; explicitly close it or carry it forward`);
    else if (next.priority !== finding.priority || stable([...next.paths].sort()) !== stable([...finding.paths].sort())
      || stable([...(next.repairPaths ?? [])].sort()) !== stable([...(finding.repairPaths ?? [])].sort())) fail('REVIEW_FINDING_CHANGED', `${finding.id} cannot change priority or repair scope`);
  }
}

export function prepareReview({ snapshot, cwd, requirement, stage, ref = 'HEAD' }) {
  assertScope(requirement, stage);
  const inputs = subject({ cwd, requirement, stage, ref });
  const feedback = evaluateFeedbackReadiness({ snapshot, cwd, requirement, stage, ref });
  const records = history({ snapshot, requirement, stage });
  return { ...inputs, ok: inputs.ok && feedback.ok, missing: [...inputs.missing, ...feedback.missing],
    requirementId: requirement.id, stage, workflowEpoch: epoch(requirement),
    roundsUsed: records.rounds.length, roundsRemaining: 2 - records.rounds.length, feedback };
}
export function showReview({ snapshot, cwd, requirement, stage, ref = 'HEAD' }) {
  if (requirement.workflowVersion === undefined) return { requirementId: requirement.id, stage, readiness: { ok: true, exempt: 'legacy', missing: [] }, rounds: [] };
  assertScope(requirement, stage);
  const records = history({ snapshot, requirement, stage });
  return { requirementId: requirement.id, stage, rounds: records.rounds, verifications: [...records.verifications.values()],
    readiness: evaluateReviewReadiness({ snapshot, cwd, requirement, stage, ref }) };
}
export function evaluateReviewReadiness({ snapshot, cwd, requirement, stage, ref = 'HEAD' }) {
  if (requirement.workflowVersion === undefined) return { ok: true, exempt: 'legacy', missing: [] };
  try {
    const prepared = prepareReview({ snapshot, cwd, requirement, stage, ref });
    const records = history({ snapshot, requirement, stage });
    const latest = records.rounds.at(-1);
    const verification = latest && records.verifications.get(latest.round);
    const active = verification ?? latest;
    const missing = [...prepared.missing];
    const remediation = `pnpm coord review prepare ${requirement.id} --stage ${stage} --json`;
    if (!active) missing.push(issue('REVIEW_MISSING', `record the ${stage} review`, remediation));
    else {
      if (active.version !== requirement.version || active.subjectFingerprint !== prepared.subjectFingerprint
        || !commitExists(cwd, active.subjectCommit)) missing.push(issue('REVIEW_STALE', `${stage} review does not match current committed inputs`, remediation));
      const feedback = evaluateFeedbackReadiness({ snapshot, cwd, requirement, stage, ref, report: active.report });
      missing.push(...feedback.missing.filter((item) => !missing.some((prior) => prior.code === item.code && prior.message === item.message)));
      if ((!verification && latest.report.verdict !== 'pass') || openFindings(latest, verification).some((finding) => ['P0', 'P1'].includes(finding.priority))) {
        missing.push(issue('REVIEW_BLOCKERS_OPEN', `${stage} review still requires repair or targeted verification`, remediation));
      }
    }
    return { ok: missing.length === 0, missing, stage, roundsUsed: records.rounds.length, subjectFingerprint: prepared.subjectFingerprint, review: latest ?? null, verification: verification ?? null };
  } catch (error) { return { ok: false, missing: [issue(error.code ?? 'REVIEW_INVALID', error.message)] }; }
}
function requirementFrom(snapshot, id) {
  const path = `requirements/${assertRequirementId(id)}.json`;
  if (!snapshot.has(path)) fail('REQUIREMENT_NOT_FOUND', `requirement ${id} is absent`);
  return snapshot.readJson(path);
}
function checkRecording({ cwd, snapshot, requirement, stage, report, verification }) {
  assertScope(requirement, stage);
  const branch = git(cwd, ['branch', '--show-current']).trim();
  const mergedStage = ['release', 'closure'].includes(stage) && requirement.mergeStatus === 'merged'
    && branch && ancestor(cwd, requirement.mergedCommit, 'HEAD');
  if (!branch || (requirement.branch && branch !== requirement.branch && !mergedStage)) fail('REVIEW_BRANCH_MISMATCH', 'checkout must match the requirement branch or be a release/closure descendant of its recorded merge');
  validateReport(report, { requirement, stage, verification, repository: reviewRepository({ cwd }) });
  const prepared = prepareReview({ snapshot, cwd, requirement, stage });
  if (prepared.missing.some((item) => item.code.startsWith('REVIEW_SUBJECT'))) fail('REVIEW_SUBJECT_INVALID', 'review subject must be clean committed inputs', { missing: prepared.missing });
  const recordable = (item) => !verification && report.verdict === 'needs-fix' && item.code === 'FEEDBACK_MAPPING_MISSING';
  const blockers = prepared.missing.filter((item) => !recordable(item));
  if (blockers.length) fail(blockers[0].code, blockers[0].message, { missing: prepared.missing });
  if (report.subjectFingerprint !== prepared.subjectFingerprint) fail('REVIEW_REPORT_STALE', 'report subjectFingerprint differs from the current committed subject');
  const feedback = evaluateFeedbackReadiness({ snapshot, cwd, requirement, stage, report });
  const feedbackBlockers = feedback.missing.filter((item) => !recordable(item));
  if (feedbackBlockers.length) fail(feedbackBlockers[0].code, feedbackBlockers[0].message, { missing: feedback.missing });
  return prepared;
}
export async function recordReview({ store, cwd, id, stage, report, session, clock = () => new Date() }) {
  const localSession = knownSession(cwd, session);
  const claimedReport = copyReport(report);
  let fact;
  const result = await store.update({ operation: `record ${stage} review for ${id}`, auditData: { kind: 'review', action: 'record', requirementId: id, stage, sessionId: localSession.sessionId }, mutate(snapshot) {
    const requirement = requirementFrom(snapshot, id);
    const prepared = checkRecording({ cwd, snapshot, requirement, stage, report: claimedReport });
    const records = history({ snapshot, requirement, stage });
    if (records.rounds.length >= 2) fail('REVIEW_ROUND_LIMIT', 'this stage/cycle already used both review rounds; use one targeted verification of the latest findings');
    const previous = records.rounds.at(-1);
    accountRound(previous, previous && records.verifications.get(previous.round), claimedReport);
    const round = records.rounds.length + 1;
    fact = { schemaVersion: 1, requirementId: id, stage, workflowEpoch: epoch(requirement), version: requirement.version,
      round, reviewId: reviewId(requirement, stage, round), actor: actor(localSession), recordedAt: clock().toISOString(),
      subjectCommit: prepared.commit, subjectFingerprint: prepared.subjectFingerprint, reportHash: hash(stable(claimedReport)), report: claimedReport };
    snapshot.writeJson(`${prefix(requirement, stage)}/round-${round}.json`, fact);
  } });
  return { ...fact, coordinationSha: result.sha };
}
export async function verifyReview({ store, cwd, id, stage, report, session, clock = () => new Date() }) {
  const localSession = knownSession(cwd, session);
  const claimedReport = copyReport(report);
  let fact;
  const result = await store.update({ operation: `verify ${stage} review findings for ${id}`, auditData: { kind: 'review', action: 'verify', requirementId: id, stage, sessionId: localSession.sessionId }, mutate(snapshot) {
    const requirement = requirementFrom(snapshot, id);
    const prepared = checkRecording({ cwd, snapshot, requirement, stage, report: claimedReport, verification: true });
    const records = history({ snapshot, requirement, stage });
    const latest = records.rounds.at(-1);
    if (!latest || latest.reviewId !== claimedReport.reviewId) fail('REVIEW_VERIFICATION_SCOPE_INVALID', 'targeted verification must reference the latest review in this stage/cycle');
    if (records.verifications.has(latest.round)) fail('REVIEW_VERIFICATION_EXISTS', 'this review already has its one targeted verification');
    if (latest.report.verdict !== 'needs-fix') fail('REVIEW_VERIFICATION_SCOPE_INVALID', 'targeted verification requires an existing needs-fix review');
    accountFindings(latest.report.findings, claimedReport.closedFindingIds, claimedReport.remainingFindingIds, claimedReport.newFindings ?? []);
    if (!ancestor(cwd, latest.subjectCommit, prepared.commit)) fail('REVIEW_REPAIR_SCOPE_EXCEEDED', 'repair subject must descend from the original review commit');
    const allowed = new Set(latest.report.findings.flatMap((finding) => [...finding.paths, ...(finding.repairPaths ?? [])]));
    const changed = git(cwd, ['diff', '--name-only', '-z', '--no-renames', latest.subjectCommit, prepared.commit]).split('\0').filter(Boolean);
    const before = reviewRepository({ cwd, ref: latest.subjectCommit });
    const after = reviewRepository({ cwd });
    const outside = changed.filter((path) => {
      if (allowed.has(path) || excluded(path, prepared.root)) return false;
      if (['BACKLOG.md', `${prepared.root}/ACCEPTANCE.md`, `${prepared.root}/CHECKLIST.md`].includes(path)
        && before.entries.has(path) && after.entries.has(path) && before.regular(path) && after.regular(path)) {
        return canonical(path, before.read(path), prepared.root, id) !== canonical(path, after.read(path), prepared.root, id);
      }
      return true;
    });
    if (outside.length) fail('REVIEW_REPAIR_SCOPE_EXCEEDED', 'targeted verification cannot approve unrelated changed paths', { paths: outside });
    fact = { schemaVersion: 1, requirementId: id, stage, workflowEpoch: epoch(requirement), version: requirement.version,
      round: latest.round, reviewId: latest.reviewId, actor: actor(localSession), recordedAt: clock().toISOString(),
      subjectCommit: prepared.commit, subjectFingerprint: prepared.subjectFingerprint, reportHash: hash(stable(claimedReport)), report: claimedReport };
    snapshot.writeJson(`${prefix(requirement, stage)}/verify-round-${latest.round}.json`, fact);
  } });
  return { ...fact, coordinationSha: result.sha };
}
