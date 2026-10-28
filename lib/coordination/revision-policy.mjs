import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { assertRequirementId } from './validation.mjs';
import { parseBacklogRows } from './backlog.mjs';

// Backlog parsing is shared (I-128/M9); the local name is kept for the
// existing call sites in this module.
const backlogRows = parseBacklogRows;

export const REVISION_POLICY_VERSION = 1;

const ARTIFACT_INPUTS_PATH = '.agents/runtime-artifact-inputs.json';
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;
const REQUIREMENT_ROW_ID = /^(I|F|B)-\d{3,}$/;
const CLOSURE_DIRECTORY_PATTERN = /^docs\/product\/current\/((?:I|F|B)-\d{3,})-[^/]+\/([^/]+)$/;
const REVIEW_REPORT_PATTERN = /^docs\/product\/current\/((?:I|F|B)-\d{3,})-[^/]+\/reviews\/(requirements|ux|design|implementation|verification|release|closure)-(?:epoch-\d+-)?(round-[12]|verify-round-[12])\.json$/;
const UI_ACCEPTANCE_PATTERN = /^docs\/product\/current\/((?:I|F|B)-\d{3,})-[^/]+\/UI_ACCEPTANCE\.json$/;
const VISUAL_SCREENSHOT_PATTERN = /^docs\/product\/current\/((?:I|F|B)-\d{3,})-[^/]+\/reviews\/screenshots\/[^/]+\.(?:png|webp)$/;
const CLOSURE_DOCUMENTS = new Set(['CHECKLIST.md', 'ACCEPTANCE.md', 'TEST_EVIDENCE.json']);
const RESULTS_SECTION_HEADING = '## 本地验收结果';
const RESULT_FIELD_PATTERN = /^(?:-\s*)?(?:结果|结论|备注)[:：]/;
const CHECKBOX_PATTERN = /^(\s*- )\[([ xX])\]( .*)$/;
const DOCKERFILE_PATTERN = /(^|\/)Dockerfile(?:\.|$)/;
const DOCKER_COMPOSE_PATTERN = /^docker-compose.*\.yml$/;
const ROOT_BUILD_INPUTS = new Set(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']);
const REGULAR_FILE_MODES = new Set(['000000', '100644', '100755']);
const DIFF_STATUSES = new Set(['A', 'M', 'D']);
const CLASSIFICATION_RANK = Object.freeze({
  'evidence-neutral': 1,
  'deployment-neutral': 2,
  'runtime-affecting': 3,
});

export class RevisionPolicyError extends Error {
  constructor(message, { code, exitCode = 14, data = {}, cause } = {}) {
    super(message, { cause });
    this.name = 'RevisionPolicyError';
    this.code = code;
    this.exitCode = exitCode;
    this.data = data;
  }
}

function runGitResult(cwd, args) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runGit(cwd, args) {
  const result = runGitResult(cwd, args);
  if (result.error || result.status !== 0) {
    const message = result.stderr || result.error?.message || 'git command failed';
    throw new RevisionPolicyError(`git ${args.join(' ')} failed: ${message.trim()}`, {
      code: 'REVISION_POLICY_GIT_ERROR',
      exitCode: 13,
    });
  }
  return result.stdout.trim();
}

export function isSingleAdditionSince({ cwd, path, fromSha, toSha }) {
  const history = runGitResult(cwd, ['log', '--format=%H', `${fromSha}..${toSha}`, '--', path]);
  if (history.status !== 0) return false;
  const commits = history.stdout.trim().split('\n').filter(Boolean);
  if (commits.length !== 1) return false;
  const change = runGitResult(cwd, ['diff-tree', '--no-commit-id', '--name-status', '-r', '--root', commits[0], '--', path]);
  return change.status === 0 && change.stdout.trim() === `A\t${path}`;
}

function textAt(cwd, sha, path) {
  const result = runGitResult(cwd, ['show', `${sha}:${path}`]);
  if (result.status !== 0) return null;
  return result.stdout;
}

// Parses `git diff --raw -z --no-abbrev` output into path/status/mode/blob entries.
function diffEntries(cwd, fromSha, toSha) {
  const output = runGit(cwd, ['diff', '--raw', '-z', '--no-abbrev', fromSha, toSha]);
  const tokens = output.split('\0').filter((token) => token.length > 0);
  const entries = [];
  let index = 0;
  while (index < tokens.length) {
    const meta = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z]\d*)$/.exec(tokens[index]);
    if (!meta) {
      throw new RevisionPolicyError('unable to parse git diff --raw output', {
        code: 'REVISION_POLICY_GIT_ERROR',
        exitCode: 13,
        data: { token: tokens[index] },
      });
    }
    const [, oldMode, newMode, oldSha, newSha, status] = meta;
    const path = tokens[index + 1];
    const entry = { path, status: status[0], oldMode, newMode, oldSha, newSha };
    if (status[0] === 'R' || status[0] === 'C') {
      entry.oldPath = tokens[index + 2];
      index += 1;
    }
    entries.push(entry);
    index += 2;
  }
  return entries;
}

// Same row semantics as the coordination gate: only `|` lines whose second cell is a
// requirement id count as rows; status/notes are projection-owned, the rest are core cells.

function isBacklogRowLine(line) {
  return REQUIREMENT_ROW_ID.test(line.split('|')[1]?.trim() ?? '');
}

function coreBacklogEqual(left, right) {
  return left && right
    && left.id === right.id
    && left.description === right.description
    && left.migration === right.migration
    && left.version === right.version;
}

function globToRegExp(glob) {
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === '*') {
      if (glob[index + 1] === '*') {
        if (glob[index + 2] === '/') {
          source += '(?:.*/)?';
          index += 2;
        } else {
          source += '.*';
          index += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (character === '?') {
      source += '[^/]';
    } else {
      source += character.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

function globMatches(pattern, path) {
  if (pattern.endsWith('/**') && path === pattern.slice(0, -3)) return true;
  return globToRegExp(pattern).test(path);
}

function patternCovers(include, candidate) {
  if (include === candidate) return true;
  if (include.endsWith('/**')) {
    const prefix = include.slice(0, -2);
    return candidate === prefix.slice(0, -1) || candidate.startsWith(prefix);
  }
  return false;
}

function validGlobPattern(pattern) {
  return pattern.length > 0
    && !pattern.startsWith('/')
    && !pattern.endsWith('/')
    && !pattern.includes('..')
    && !pattern.includes('\\');
}

function invalidArtifactInputs(message, data = {}) {
  return new RevisionPolicyError(`runtime artifact inputs are invalid: ${message}`, {
    code: 'ARTIFACT_INPUTS_INVALID',
    data,
  });
}

function assertArtifactInputsShape(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidArtifactInputs('document must be an object');
  }
  if (Object.keys(value).some((key) => !['schemaVersion', 'services'].includes(key))) {
    throw invalidArtifactInputs('document has unknown top-level keys');
  }
  if (value.schemaVersion !== 1) {
    throw invalidArtifactInputs(`unsupported schemaVersion: ${value.schemaVersion ?? '<missing>'}`);
  }
  const services = value.services;
  if (services === null || typeof services !== 'object' || Array.isArray(services)) {
    throw invalidArtifactInputs('services must be an object');
  }
  const entries = Object.entries(services);
  if (entries.length === 0) {
    throw invalidArtifactInputs('services must declare at least one service');
  }
  for (const [name, service] of entries) {
    if (!name) throw invalidArtifactInputs('service name must be non-empty');
    if (service === null || typeof service !== 'object' || Array.isArray(service)) {
      throw invalidArtifactInputs(`service ${name} must be an object`);
    }
    if (Object.keys(service).some((key) => !['includes', 'excludes'].includes(key))) {
      throw invalidArtifactInputs(`service ${name} has unknown keys`);
    }
    const { includes, excludes } = service;
    if (
      !Array.isArray(includes)
      || includes.length === 0
      || includes.some((pattern) => typeof pattern !== 'string' || !validGlobPattern(pattern))
    ) {
      throw invalidArtifactInputs(`service ${name} includes must be non-empty path globs`);
    }
    if (
      !Array.isArray(excludes)
      || excludes.some((pattern) => typeof pattern !== 'string' || !validGlobPattern(pattern))
    ) {
      throw invalidArtifactInputs(`service ${name} excludes must be path globs`);
    }
    for (const exclude of excludes) {
      if (!includes.some((include) => patternCovers(include, exclude))) {
        throw invalidArtifactInputs(`service ${name} exclude is outside its includes: ${exclude}`);
      }
    }
  }
  return value;
}

function staticPrefix(pattern) {
  const segments = [];
  for (const segment of pattern.split('/')) {
    if (/[*?]/.test(segment)) break;
    segments.push(segment);
  }
  return segments.join('/');
}

function dockerfileContextSources(source) {
  const sources = [];
  for (const line of source.split(/\r?\n/)) {
    const match = /^COPY\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    const tokens = match[1].split(/\s+/);
    if (tokens.some((token) => token.startsWith('--from='))) continue;
    const positional = tokens.filter((token) => !token.startsWith('--'));
    sources.push(...positional.slice(0, -1));
  }
  return sources;
}

// The declaration must cover every build-context path each service Dockerfile consumes;
// root manifests are covered implicitly because the classifier always treats them as
// runtime-affecting.
function crossCheckDockerfiles(cwd, services) {
  const includes = Object.values(services).flatMap((service) => service.includes);
  for (const [name, service] of Object.entries(services)) {
    const directories = [...new Set(service.includes.map(staticPrefix))];
    const dockerfiles = directories
      .map((directory) => `${directory}/Dockerfile`)
      .filter((path) => existsSync(resolve(cwd, path)));
    if (dockerfiles.length === 0) {
      throw invalidArtifactInputs(`no Dockerfile found within the includes of service ${name}`);
    }
    for (const dockerfile of dockerfiles) {
      const source = readFileSync(resolve(cwd, dockerfile), 'utf8');
      for (const contextPath of dockerfileContextSources(source)) {
        if (ROOT_BUILD_INPUTS.has(contextPath)) continue;
        if (!includes.some((include) => patternCovers(include, contextPath))) {
          throw invalidArtifactInputs(
            `Dockerfile build input is not covered by declared includes: ${contextPath}`,
            { dockerfile, source: contextPath },
          );
        }
      }
    }
  }
}

export function loadRuntimeArtifactInputs({ cwd }) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(resolve(cwd, ARTIFACT_INPUTS_PATH), 'utf8'));
  } catch (error) {
    throw new RevisionPolicyError(`runtime artifact inputs are unreadable: ${error.message}`, {
      code: 'ARTIFACT_INPUTS_INVALID',
      cause: error,
    });
  }
  assertArtifactInputsShape(parsed);
  crossCheckDockerfiles(cwd, parsed.services);
  return parsed;
}

// Mirrors evidence.mjs parseAcceptanceCommands tokenization, without the repo-state
// validation: fingerprints compare historical blobs, so package.json/script checks do
// not apply here.
function invalidAcceptance(message) {
  return new RevisionPolicyError(message, { code: 'INVALID_ACCEPTANCE' });
}
function tokenizePlainCommand(line) {
  if (/[;$`|&<>\r\n]/.test(line)) {
    throw invalidAcceptance(`shell syntax is forbidden in coord-required command: ${line}`);
  }
  const argv = [];
  let token = '';
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote) {
      if (character === quote) quote = null;
      else token += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (token) {
        argv.push(token);
        token = '';
      }
      continue;
    }
    if (character === '\\') {
      throw invalidAcceptance('backslash escaping is forbidden; use a JSON argv array');
    }
    token += character;
  }
  if (quote) throw invalidAcceptance('unterminated quote in coord-required command');
  if (token) argv.push(token);
  if (argv.length === 0) throw invalidAcceptance('coord-required command cannot be empty');
  return argv;
}

export function acceptanceCommandsSha256(source) {
  const blocks = [...source.matchAll(/```coord-required[ \t]*\r?\n([\s\S]*?)```/g)];
  if (blocks.length !== 1) {
    throw invalidAcceptance('ACCEPTANCE.md must contain exactly one coord-required block');
  }
  const lines = blocks[0][1].split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) {
    throw invalidAcceptance('coord-required block cannot be empty');
  }
  const argvs = lines.map((line) => {
    if (!line.startsWith('[')) return tokenizePlainCommand(line);
    try {
      return JSON.parse(line);
    } catch {
      throw invalidAcceptance('invalid JSON argv in coord-required block');
    }
  });
  return createHash('sha256').update(JSON.stringify(argvs)).digest('hex');
}

function splitResultsSection(source) {
  const lines = contentLines(source);
  const index = lines.findIndex((line) => line.trim() === RESULTS_SECTION_HEADING);
  if (index < 0) return null;
  return { prefix: lines.slice(0, index + 1), suffix: lines.slice(index + 1) };
}

// Line arrays without the trailing empty artifact produced by a final newline.
function contentLines(source) {
  const lines = source.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function isPrefixLines(base, head) {
  return base.length <= head.length && base.every((line, index) => line === head[index]);
}

function closureFailure(entry, reason) {
  return { path: entry.path, reason };
}

function checkBacklogClosure({ entry, baseText, headText, requirementId }) {
  if (baseText === null || headText === null) {
    return closureFailure(entry, 'BACKLOG.md must be modified in place');
  }
  const baseRows = backlogRows(baseText);
  const headRows = backlogRows(headText);
  const baseNonRows = contentLines(baseText).filter((line) => !isBacklogRowLine(line));
  const headNonRows = contentLines(headText).filter((line) => !isBacklogRowLine(line));
  if (
    baseNonRows.length !== headNonRows.length
    || baseNonRows.some((line, index) => line !== headNonRows[index])
  ) {
    return closureFailure(entry, 'BACKLOG.md non-row content changed');
  }
  for (const id of new Set([...baseRows.keys(), ...headRows.keys()])) {
    const baseRow = baseRows.get(id);
    const headRow = headRows.get(id);
    if (!baseRow || !headRow) {
      return closureFailure(entry, `BACKLOG.md row added or removed: ${id}`);
    }
    if (id !== requirementId) {
      // I-113 (unified branch): co-branch requirements advance their own
      // lifecycle and project the BACKLOG status cell while sharing the
      // feature branch. A status-only projection of another requirement's
      // row is an evidence-neutral audit closure; any core-cell change to
      // another requirement's row stays a hard fail.
      if (baseRow.line === headRow.line) continue;
      if (coreBacklogEqual(baseRow, headRow) && baseRow.status !== headRow.status) {
        continue;
      }
      return closureFailure(entry, `BACKLOG.md row of another requirement changed: ${id}`);
    } else if (!coreBacklogEqual(baseRow, headRow)) {
      return closureFailure(
        entry,
        'BACKLOG.md core cells (title/migration/version) of the requirement changed',
      );
    }
  }
  return null;
}

function checkChecklistClosure({ entry, baseText, headText }) {
  if (baseText === null || headText === null) {
    return closureFailure(entry, 'CHECKLIST.md must be modified in place');
  }
  const baseLines = contentLines(baseText);
  const headLines = contentLines(headText);
  let baseIndex = 0;
  let headIndex = 0;
  while (baseIndex < baseLines.length && headIndex < headLines.length) {
    const baseLine = baseLines[baseIndex];
    const headLine = headLines[headIndex];
    if (baseLine === headLine) {
      baseIndex += 1;
      headIndex += 1;
      continue;
    }
    const baseBox = CHECKBOX_PATTERN.exec(baseLine);
    const headBox = CHECKBOX_PATTERN.exec(headLine);
    if (baseBox && headBox && baseBox[1] === headBox[1] && baseBox[3] === headBox[3]) {
      if (baseBox[2] !== ' ' || headBox[2] === ' ') {
        return closureFailure(entry, 'CHECKLIST.md checkbox may only flip from [ ] to [x]');
      }
      baseIndex += 1;
      headIndex += 1;
      continue;
    }
    return closureFailure(entry, 'CHECKLIST.md items may not be added, removed or rewritten');
  }
  if (baseIndex < baseLines.length) {
    return closureFailure(entry, 'CHECKLIST.md items may not be removed');
  }
  if (headLines.slice(headIndex).some((line) => !RESULT_FIELD_PATTERN.test(line))) {
    return closureFailure(entry, 'CHECKLIST.md only allows appending fixed result fields');
  }
  return null;
}

function checkAcceptanceClosure({ entry, baseText, headText }) {
  if (baseText === null || headText === null) {
    return closureFailure(entry, 'ACCEPTANCE.md must be modified in place');
  }
  let baseFingerprint;
  let headFingerprint;
  try {
    baseFingerprint = acceptanceCommandsSha256(baseText);
    headFingerprint = acceptanceCommandsSha256(headText);
  } catch (error) {
    return closureFailure(entry, `ACCEPTANCE.md coord-required block parse failed: ${error.message}`);
  }
  if (baseFingerprint !== headFingerprint) {
    return closureFailure(entry, 'ACCEPTANCE.md coord-required command fingerprint changed');
  }
  const baseSection = splitResultsSection(baseText);
  const headSection = splitResultsSection(headText);
  if (!baseSection || !headSection) {
    return closureFailure(entry, `ACCEPTANCE.md is missing the "${RESULTS_SECTION_HEADING}" section`);
  }
  if (
    baseSection.prefix.length !== headSection.prefix.length
    || !isPrefixLines(baseSection.prefix, headSection.prefix)
  ) {
    return closureFailure(entry, 'ACCEPTANCE.md content before the results section changed');
  }
  if (!isPrefixLines(baseSection.suffix, headSection.suffix)) {
    return closureFailure(entry, 'ACCEPTANCE.md results section may only be appended to');
  }
  return null;
}

function checkTestEvidenceClosure({ entry, baseText, headText }) {
  if (entry.status === 'D') {
    return closureFailure(entry, 'TEST_EVIDENCE.json must not be deleted');
  }
  for (const [label, text] of [['base', baseText], ['head', headText]]) {
    if (text === null) continue;
    try {
      JSON.parse(text);
    } catch {
      return closureFailure(entry, `TEST_EVIDENCE.json ${label} content is not valid JSON`);
    }
  }
  return null;
}

function runtimeAffecting(path, reason) {
  return { path, classification: 'runtime-affecting', reason };
}

function servicePathDisposition(services, path) {
  let includedBy = null;
  let excluded = false;
  for (const [name, service] of Object.entries(services)) {
    if (!service.includes.some((pattern) => globMatches(pattern, path))) continue;
    if (service.excludes.some((pattern) => globMatches(pattern, path))) {
      excluded = true;
    } else {
      includedBy = includedBy ?? name;
    }
  }
  if (includedBy) {
    return runtimeAffecting(path, `${includedBy} runtime artifact input`);
  }
  if (excluded) {
    return {
      path,
      classification: 'deployment-neutral',
      reason: 'excluded from every affected service runtime artifact input',
    };
  }
  return null;
}

function classifyEntry(entry, { cwd, requirementId, fromSha, toSha, services }) {
  const { path } = entry;
  if (!DIFF_STATUSES.has(entry.status)) {
    return {
      entry: { path, classification: null, reason: `unsupported diff status: ${entry.status}` },
      failure: closureFailure(entry, `file rename/copy/type change is not allowed: ${path}`),
    };
  }
  if (!REGULAR_FILE_MODES.has(entry.oldMode) || !REGULAR_FILE_MODES.has(entry.newMode)) {
    return {
      entry: { path, classification: null, reason: `non-regular file mode: ${path}` },
      failure: closureFailure(entry, `symlink or submodule entry is not allowed: ${path}`),
    };
  }
  if (
    entry.oldMode !== '000000'
    && entry.newMode !== '000000'
    && entry.oldMode !== entry.newMode
  ) {
    return {
      entry: { path, classification: null, reason: `file mode ${entry.oldMode} -> ${entry.newMode}` },
      failure: closureFailure(entry, `file mode change is not allowed: ${path}`),
    };
  }
  if (path === ARTIFACT_INPUTS_PATH) {
    return { entry: runtimeAffecting(path, 'runtime artifact input declaration changed') };
  }
  if (path === '.dockerignore') {
    return { entry: runtimeAffecting(path, 'docker build ignore rules changed') };
  }
  if (DOCKERFILE_PATTERN.test(path)) {
    return { entry: runtimeAffecting(path, 'Dockerfile changed') };
  }
  if (DOCKER_COMPOSE_PATTERN.test(path)) {
    return { entry: runtimeAffecting(path, 'docker compose definition changed') };
  }
  if (path === 'pnpm-lock.yaml') {
    return { entry: runtimeAffecting(path, 'lockfile changed') };
  }
  if (path.startsWith('deploy/')) {
    return { entry: runtimeAffecting(path, 'deployment configuration changed') };
  }

  const baseText = entry.status === 'A' ? null : textAt(cwd, fromSha, path);
  const headText = entry.status === 'D' ? null : textAt(cwd, toSha, path);

  if (path === 'BACKLOG.md') {
    const failure = checkBacklogClosure({ entry, baseText, headText, requirementId });
    if (failure) return { entry: { path, classification: null, reason: failure.reason }, failure };
    return {
      entry: {
        path,
        classification: 'evidence-neutral',
        reason: 'requirement BACKLOG status projection',
      },
    };
  }

  const closure = CLOSURE_DIRECTORY_PATTERN.exec(path);
  if (closure && closure[1] === requirementId && CLOSURE_DOCUMENTS.has(closure[2])) {
    const document = closure[2];
    const check = document === 'CHECKLIST.md'
      ? checkChecklistClosure
      : document === 'ACCEPTANCE.md'
        ? checkAcceptanceClosure
        : checkTestEvidenceClosure;
    const failure = check({ entry, baseText, headText });
    if (failure) return { entry: { path, classification: null, reason: failure.reason }, failure };
    return {
      entry: {
        path,
        classification: 'evidence-neutral',
        reason: `${document} restricted closure change`,
      },
    };
  }

  // I-113 (unified branch): multiple requirements sharing one feature branch
  // commit their own TEST_EVIDENCE.json in separate closure commits. A
  // machine-generated TEST_EVIDENCE.json for ANOTHER requirement is still an
  // evidence-neutral closure — its JSON validity is checked and the content
  // binding is enforced by that requirement's own validateTestEvidence.
  if (closure && CLOSURE_DOCUMENTS.has(closure[2]) && closure[2] === 'TEST_EVIDENCE.json') {
    const failure = checkTestEvidenceClosure({ entry, baseText, headText });
    if (failure) return { entry: { path, classification: null, reason: failure.reason }, failure };
    return {
      entry: {
        path,
        classification: 'evidence-neutral',
        reason: 'TEST_EVIDENCE.json closure change for a co-branch requirement',
      },
    };
  }

  const reviewReport = REVIEW_REPORT_PATTERN.exec(path);
  if (reviewReport && reviewReport[1] === requirementId) {
    if (entry.status !== 'A' || !isSingleAdditionSince({ cwd, path, fromSha, toSha })) {
      const failure = closureFailure(entry, 'recorded review report may not be modified or deleted after testing');
      return { entry: { path, classification: null, reason: failure.reason }, failure };
    }
    let report;
    try { report = JSON.parse(headText); } catch { /* reject malformed report below */ }
    if (report?.schemaVersion !== 1 || report.requirementId !== requirementId || report.stage !== reviewReport[2]
      || !/^[0-9a-f]{64}$/.test(report.subjectFingerprint ?? '')) {
      const failure = closureFailure(entry, 'review report is not a valid matching stage result');
      return { entry: { path, classification: null, reason: failure.reason }, failure };
    }
    return { entry: { path, classification: 'evidence-neutral', reason: 'additive stage review result' } };
  }
  const uiAcceptance = UI_ACCEPTANCE_PATTERN.exec(path);
  if (uiAcceptance && uiAcceptance[1] === requirementId) {
    let report;
    try { report = JSON.parse(headText); } catch { /* reject below */ }
    if (entry.status !== 'A' || !isSingleAdditionSince({ cwd, path, fromSha, toSha })
      || report?.schemaVersion !== 1 || report.requirementId !== requirementId) {
      const failure = closureFailure(entry, 'interactive visual acceptance report must be a matching additive result');
      return { entry: { path, classification: null, reason: failure.reason }, failure };
    }
    return { entry: { path, classification: 'evidence-neutral', reason: 'additive interactive visual acceptance result' } };
  }
  const screenshot = VISUAL_SCREENSHOT_PATTERN.exec(path);
  if (screenshot && screenshot[1] === requirementId) {
    if (entry.status !== 'A' || !isSingleAdditionSince({ cwd, path, fromSha, toSha })) {
      const failure = closureFailure(entry, 'visual acceptance screenshot may not be modified or deleted after testing');
      return { entry: { path, classification: null, reason: failure.reason }, failure };
    }
    return { entry: { path, classification: 'evidence-neutral', reason: 'additive visual comparison screenshot' } };
  }

  if (path.startsWith('docs/') && path.endsWith('.md')) {
    return {
      entry: { path, classification: 'deployment-neutral', reason: 'documentation markdown' },
    };
  }

  const disposition = servicePathDisposition(services, path);
  if (disposition) return { entry: disposition };

  return { entry: runtimeAffecting(path, 'unclassified path') };
}

function invalidRangeResult({ requirementId, fromSha, toSha, reason }) {
  return {
    valid: false,
    code: 'REVISION_RANGE_INVALID',
    requirementId,
    fromSha,
    toSha,
    classification: null,
    evidenceNeutral: false,
    deploymentNeutral: false,
    reason,
    paths: [],
    policyVersion: REVISION_POLICY_VERSION,
  };
}

export function classifyRevisionRange({
  cwd,
  requirementId,
  fromSha,
  toSha,
  artifactInputs,
}) {
  try {
    assertRequirementId(requirementId);
  } catch (error) {
    throw new RevisionPolicyError(error.message, {
      code: 'INVALID_REQUIREMENT_ID',
      cause: error,
    });
  }
  if (!FULL_SHA_PATTERN.test(fromSha ?? '') || !FULL_SHA_PATTERN.test(toSha ?? '')) {
    return invalidRangeResult({
      requirementId,
      fromSha,
      toSha,
      reason: 'fromSha and toSha must be full 40-hex commit SHAs',
    });
  }
  if (runGitResult(cwd, ['cat-file', '-e', `${fromSha}^{commit}`]).status !== 0) {
    return invalidRangeResult({
      requirementId, fromSha, toSha, reason: `revision does not exist: ${fromSha}`,
    });
  }
  if (runGitResult(cwd, ['cat-file', '-e', `${toSha}^{commit}`]).status !== 0) {
    return invalidRangeResult({
      requirementId, fromSha, toSha, reason: `revision does not exist: ${toSha}`,
    });
  }
  if (runGitResult(cwd, ['merge-base', '--is-ancestor', fromSha, toSha]).status !== 0) {
    return invalidRangeResult({
      requirementId, fromSha, toSha, reason: `${fromSha} is not an ancestor of ${toSha}`,
    });
  }

  const inputs = artifactInputs ?? loadRuntimeArtifactInputs({ cwd });
  assertArtifactInputsShape(inputs);

  const paths = [];
  const failures = [];
  for (const entry of diffEntries(cwd, fromSha, toSha)) {
    const outcome = classifyEntry(entry, {
      cwd,
      requirementId,
      fromSha,
      toSha,
      services: inputs.services,
    });
    paths.push(outcome.entry);
    if (outcome.failure) failures.push(outcome.failure);
  }

  if (failures.length > 0) {
    return {
      valid: false,
      code: 'REVISION_POLICY_HARDFAIL',
      requirementId,
      fromSha,
      toSha,
      classification: null,
      evidenceNeutral: false,
      deploymentNeutral: false,
      reason: failures[0].reason,
      paths,
      failures,
      policyVersion: REVISION_POLICY_VERSION,
    };
  }

  let top = null;
  for (const candidate of paths) {
    if (
      !top
      || CLASSIFICATION_RANK[candidate.classification] > CLASSIFICATION_RANK[top.classification]
    ) {
      top = candidate;
    }
  }
  const classification = top?.classification ?? 'evidence-neutral';
  return {
    valid: true,
    requirementId,
    fromSha,
    toSha,
    classification,
    evidenceNeutral: classification === 'evidence-neutral',
    deploymentNeutral: classification !== 'runtime-affecting',
    reason: top?.reason ?? 'no changes between revisions',
    paths,
    policyVersion: REVISION_POLICY_VERSION,
  };
}
