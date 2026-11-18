import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { assertRequirementId, assertVersion } from './validation.mjs';

const ISSUE_ID = /^VI-\d{3,}$/;
const CATEGORIES = new Set(['branch', 'train', 'gate', 'test', 'deploy', 'runtime', 'data', 'ux', 'correction', 'design', 'requirements']);
const SEVERITIES = new Set(['P0', 'P1', 'P2', 'P3']);
const STATUSES = new Set(['open', 'mitigated', 'resolved', 'deferred']);
const PHASES = new Set(['tech_design', 'in_dev', 'testing', 'prod_planning']);
const ENVIRONMENTS = new Set(['local', 'shared-dev', 'prod']);
const STATUS_TRANSITIONS = Object.freeze({
  open: new Set(['open', 'mitigated', 'resolved', 'deferred']),
  mitigated: new Set(['mitigated', 'resolved', 'deferred']),
  deferred: new Set(['deferred', 'open', 'mitigated', 'resolved']),
  resolved: new Set(['resolved']),
});

export class VersionIssueError extends Error {
  constructor(message, { code = 'INVALID_VERSION_ISSUE', exitCode = 14, data = {} } = {}) {
    super(message);
    this.name = 'VersionIssueError';
    this.code = code;
    this.exitCode = exitCode;
    this.data = data;
  }
}

function issueDirectory(cwd, version) {
  return join(cwd, 'docs', 'releases', 'PENDING', version, 'iteration-issues');
}

function issuePath(cwd, version, issueId) {
  return join(issueDirectory(cwd, version), `${issueId}.json`);
}

function indexPath(cwd, version) {
  return join(issueDirectory(cwd, version), 'INDEX.json');
}

function nonEmpty(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new VersionIssueError(`${name} must be a non-empty string`, { data: { field: name } });
  }
  return value.trim();
}

function validDate(value, name) {
  nonEmpty(value, name);
  if (Number.isNaN(Date.parse(value))) {
    throw new VersionIssueError(`${name} must be an ISO date`, { data: { field: name } });
  }
  return value;
}

function listOfStrings(value, name, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new VersionIssueError(`${name} must be a string array`, { data: { field: name } });
  }
  return value.map((item) => item.trim());
}

function validateActor(actor, name) {
  if (!actor || typeof actor !== 'object' || Array.isArray(actor)) {
    throw new VersionIssueError(`${name} must be an object`);
  }
  return {
    ...(actor.sessionId ? { sessionId: nonEmpty(actor.sessionId, `${name}.sessionId`) } : {}),
    agent: nonEmpty(actor.agent, `${name}.agent`),
    user: nonEmpty(actor.user, `${name}.user`),
  };
}

function validateTimeline(items) {
  if (!Array.isArray(items) || items.length === 0) throw new VersionIssueError('timeline must not be empty');
  return items.map((item, index) => {
    if (!item || typeof item !== 'object') throw new VersionIssueError(`timeline[${index}] must be an object`);
    if (!STATUSES.has(item.status)) throw new VersionIssueError(`timeline[${index}].status is invalid`);
    return {
      at: validDate(item.at, `timeline[${index}].at`),
      status: item.status,
      actor: nonEmpty(item.actor, `timeline[${index}].actor`),
      note: nonEmpty(item.note, `timeline[${index}].note`),
    };
  });
}

export function validateVersionIssue(input, { version } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new VersionIssueError('version issue must be an object');
  if (input.schemaVersion !== 1) throw new VersionIssueError('version issue schemaVersion must be 1');
  const issueId = nonEmpty(input.issueId, 'issueId');
  if (!ISSUE_ID.test(issueId)) throw new VersionIssueError(`invalid issueId: ${issueId}`);
  const issueVersion = assertVersion(input.version);
  if (version && issueVersion !== assertVersion(version)) throw new VersionIssueError(`issue version does not match ${version}`);
  if (!Array.isArray(input.requirementIds) || input.requirementIds.length === 0) throw new VersionIssueError('requirementIds must not be empty');
  const requirementIds = [...new Set(input.requirementIds.map((id) => assertRequirementId(id)))].sort();
  if (!CATEGORIES.has(input.category)) throw new VersionIssueError(`invalid category: ${input.category}`);
  if (!SEVERITIES.has(input.severity)) throw new VersionIssueError(`invalid severity: ${input.severity}`);
  if (!STATUSES.has(input.status)) throw new VersionIssueError(`invalid status: ${input.status}`);
  if (!PHASES.has(input.phase)) throw new VersionIssueError(`invalid phase: ${input.phase}`);
  const detectedBy = validateActor(input.detectedBy, 'detectedBy');
  if (!input.reproduction || typeof input.reproduction !== 'object') throw new VersionIssueError('reproduction must be an object');
  const reproduction = {
    command: listOfStrings(input.reproduction.command, 'reproduction.command'),
    environment: nonEmpty(input.reproduction.environment, 'reproduction.environment'),
    steps: listOfStrings(input.reproduction.steps, 'reproduction.steps'),
  };
  if (!ENVIRONMENTS.has(reproduction.environment)) throw new VersionIssueError(`invalid reproduction.environment: ${reproduction.environment}`);
  if (!input.fixPlan || typeof input.fixPlan !== 'object') throw new VersionIssueError('fixPlan must be an object');
  const fixPlan = {
    ownerRequirementId: assertRequirementId(input.fixPlan.ownerRequirementId),
    dependsOn: listOfStrings(input.fixPlan.dependsOn ?? [], 'fixPlan.dependsOn', { allowEmpty: true }).map((id) => assertRequirementId(id)),
    acceptance: listOfStrings(input.fixPlan.acceptance, 'fixPlan.acceptance'),
  };
  if (!input.verification || typeof input.verification !== 'object') throw new VersionIssueError('verification must be an object');
  const verification = {
    commands: listOfStrings(input.verification.commands ?? [], 'verification.commands', { allowEmpty: true }),
    evidence: listOfStrings(input.verification.evidence ?? [], 'verification.evidence', { allowEmpty: true }),
    verifiedAt: input.verification.verifiedAt == null ? null : validDate(input.verification.verifiedAt, 'verification.verifiedAt'),
  };
  if (input.status === 'resolved' && (!input.rootCause || verification.commands.length === 0 || verification.evidence.length === 0 || !verification.verifiedAt)) {
    throw new VersionIssueError('resolved issue requires rootCause, verification commands, evidence and verifiedAt', { code: 'ISSUE_VERIFICATION_REQUIRED' });
  }
  if (input.status === 'deferred' && !nonEmpty(input.decision, 'decision')) throw new VersionIssueError('deferred issue requires decision');
  const timeline = validateTimeline(input.timeline);
  if (timeline.at(-1).status !== input.status) throw new VersionIssueError('timeline last status must match issue status');
  return {
    schemaVersion: 1,
    issueId,
    version: issueVersion,
    requirementIds,
    category: input.category,
    severity: input.severity,
    status: input.status,
    phase: input.phase,
    detectedAt: validDate(input.detectedAt, 'detectedAt'),
    detectedBy,
    summary: nonEmpty(input.summary, 'summary'),
    symptom: nonEmpty(input.symptom, 'symptom'),
    impact: nonEmpty(input.impact, 'impact'),
    reproduction,
    rootCause: input.rootCause == null ? null : nonEmpty(input.rootCause, 'rootCause'),
    decision: input.decision == null ? null : nonEmpty(input.decision, 'decision'),
    fixPlan,
    verification,
    timeline,
  };
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function loadIssues(cwd, version) {
  const directory = issueDirectory(cwd, assertVersion(version));
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => ISSUE_ID.test(name.replace(/\.json$/, '')))
    .map((name) => validateVersionIssue(JSON.parse(readFileSync(join(directory, name), 'utf8')), { version }))
    .sort((left, right) => left.issueId.localeCompare(right.issueId));
}

function writeIndex(cwd, version, issues, clock) {
  const counts = { severity: {}, status: {} };
  for (const issue of issues) {
    counts.severity[issue.severity] = (counts.severity[issue.severity] ?? 0) + 1;
    counts.status[issue.status] = (counts.status[issue.status] ?? 0) + 1;
  }
  writeJsonAtomic(indexPath(cwd, version), {
    schemaVersion: 1,
    version: assertVersion(version),
    generatedAt: clock().toISOString(),
    counts,
    unresolved: issues.filter((issue) => !['resolved', 'deferred'].includes(issue.status)).map((issue) => issue.issueId),
    issues: issues.map((issue) => ({ issueId: issue.issueId, requirementIds: issue.requirementIds, severity: issue.severity, status: issue.status, category: issue.category, phase: issue.phase })),
  });
}

export function recordVersionIssue({ cwd, version, issue, clock = () => new Date() }) {
  const normalizedVersion = assertVersion(version);
  const normalized = validateVersionIssue(issue, { version: normalizedVersion });
  const path = issuePath(cwd, normalizedVersion, normalized.issueId);
  if (existsSync(path)) throw new VersionIssueError(`${normalized.issueId} already exists for ${normalizedVersion}`, { code: 'VERSION_ISSUE_EXISTS' });
  const issues = loadIssues(cwd, normalizedVersion);
  writeJsonAtomic(path, normalized);
  writeIndex(cwd, normalizedVersion, [...issues, normalized].sort((left, right) => left.issueId.localeCompare(right.issueId)), clock);
  return { path: path.replace(`${resolve(cwd)}/`, ''), issue: normalized };
}

export function updateVersionIssue({ cwd, version, issueId, status, note, actor, rootCause, decision, fixRequirementId, evidence = [], commands = [], verifiedAt = null, clock = () => new Date() }) {
  const normalizedVersion = assertVersion(version);
  if (!ISSUE_ID.test(issueId ?? '')) throw new VersionIssueError(`invalid issueId: ${issueId}`);
  const path = issuePath(cwd, normalizedVersion, issueId);
  if (!existsSync(path)) throw new VersionIssueError(`${issueId} does not exist for ${normalizedVersion}`, { code: 'VERSION_ISSUE_NOT_FOUND' });
  const current = validateVersionIssue(JSON.parse(readFileSync(path, 'utf8')), { version: normalizedVersion });
  if (current.status === 'resolved') throw new VersionIssueError(`${issueId} is resolved and immutable`, { code: 'VERSION_ISSUE_TERMINAL' });
  if (!STATUSES.has(status)) throw new VersionIssueError(`invalid status: ${status}`);
  if (!STATUS_TRANSITIONS[current.status]?.has(status)) {
    throw new VersionIssueError(`cannot transition ${issueId} from ${current.status} to ${status}`, { code: 'VERSION_ISSUE_INVALID_TRANSITION' });
  }
  const normalizedActor = nonEmpty(actor, 'actor');
  const updated = {
    ...current,
    status,
    ...(rootCause !== undefined ? { rootCause: rootCause === '' ? null : nonEmpty(rootCause, 'rootCause') } : {}),
    ...(decision !== undefined ? { decision: decision === '' ? null : nonEmpty(decision, 'decision') } : {}),
    fixPlan: {
      ...current.fixPlan,
      ...(fixRequirementId ? { ownerRequirementId: assertRequirementId(fixRequirementId) } : {}),
    },
    verification: {
      ...current.verification,
      ...(commands.length > 0 ? { commands: listOfStrings(commands, 'commands') } : {}),
      ...(evidence.length > 0 ? { evidence: listOfStrings(evidence, 'evidence') } : {}),
      ...(verifiedAt ? { verifiedAt: validDate(verifiedAt, 'verifiedAt') } : {}),
    },
    timeline: [...current.timeline, { at: clock().toISOString(), status, actor: normalizedActor, note: nonEmpty(note, 'note') }],
  };
  const normalized = validateVersionIssue(updated, { version: normalizedVersion });
  writeJsonAtomic(path, normalized);
  const issues = loadIssues(cwd, normalizedVersion).map((item) => item.issueId === issueId ? normalized : item);
  writeIndex(cwd, normalizedVersion, issues, clock);
  return { path: path.replace(`${resolve(cwd)}/`, ''), issue: normalized };
}

export function listVersionIssues({ cwd, version }) {
  const normalizedVersion = assertVersion(version);
  const issues = loadIssues(cwd, normalizedVersion);
  return { version: normalizedVersion, issues, unresolved: issues.filter((issue) => !['resolved', 'deferred'].includes(issue.status)).map((issue) => issue.issueId) };
}
