import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';

import { validateTestEvidence } from './evidence.mjs';
import { classifyChangedPaths, COORD_ENGINE_PATH, isMigrationPath } from './path-classifier.mjs';
import {
  dependencyReaches,
  overlappingResources,
  requirementDocuments,
  requirementIsActive,
  resourceValueCoversPath,
} from './requirements.mjs';
import { assertGitRevision, assertRequirementId } from './validation.mjs';
import { parseBacklogRows } from './backlog.mjs';
import { evaluateUxReadiness } from './ux-approvals.mjs';
import { classifyAdminUxImpact } from './ux-impact.mjs';
import { provePrototypeOnlyLockfile } from './prototype-lockfile.mjs';
import { evaluateReviewReadiness } from './reviews.mjs';
import { resolveAcceptanceFact } from './ui-acceptance.mjs';
import { isSingleAdditionSince } from './revision-policy.mjs';
import { validateVersionIssue } from './version-issues.mjs';

// Backlog parsing is shared (I-128/M9); the local name is kept for the
// existing call sites in this module.
const backlogRows = parseBacklogRows;

const TEST_PASSED = '✅ Test Passed';
const DONE = '✔️ Done';
const MERGED_STATES = new Set(['merged', 'completed', 'done', 'prod_deployed']);
const PROD_STAGE_STATUSES = ['✅ Test Passed', '📋 Prod Planning', '🚀 Prod Deployed', '✔️ Done'];
const PROD_STAGE_LIFECYCLES = new Set(['prod_planning', 'prod_deployed', 'done']);
const COMPLETION_BASE_STATUSES = new Set(['✅ Test Passed', '📋 Prod Planning', '🚀 Prod Deployed']);
const COMPLETION_LIFECYCLES = new Set(['merged', 'prod_deployed', 'done']);

export class GateError extends Error {
  constructor(message, { code = 'GATE_FAILED', exitCode = 14, data = {}, cause } = {}) {
    super(message, { cause });
    this.name = 'GateError';
    this.code = code;
    this.exitCode = exitCode;
    this.data = data;
  }
}

export function uxPathsOwnedByRequirement({ changedPaths, requirement }) {
  return changedPaths.filter((path) => (requirement.resources?.files ?? [])
    .some((pattern) => resourceValueCoversPath(pattern, path)));
}

function runGitResult(cwd, args) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function runGit(cwd, args) {
  const result = runGitResult(cwd, args);
  if (result.error || result.status !== 0) {
    const message = result.stderr || result.error?.message || 'git command failed';
    throw new GateError(`git ${args.join(' ')} failed: ${message.trim()}`, {
      code: 'GATE_GIT_ERROR',
      exitCode: 13,
    });
  }
  return result.stdout.trim();
}

function revision(cwd, value) {
  try {
    assertGitRevision(value);
  } catch (error) {
    throw new GateError(error.message, { cause: error });
  }
  return runGit(cwd, ['rev-parse', '--verify', `${value}^{commit}`]);
}

function textAt(cwd, sha, path) {
  const result = runGitResult(cwd, ['show', `${sha}:${path}`]);
  if (result.status !== 0) return null;
  return result.stdout;
}

function pathsBetween(cwd, from, to) {
  return runGit(cwd, ['diff', '--name-only', '--ignore-submodules=none', from, to]).split('\n').filter(Boolean);
}

function unresolvedVersionIssuesAt({ cwd, ref, version }) {
  const directory = `docs/releases/PENDING/${version}/iteration-issues`;
  const listing = runGitResult(cwd, ['ls-tree', '-r', '--name-only', ref, `${directory}/`]);
  if (listing.status !== 0) return [];
  return listing.stdout.split('\n').filter((path) => /\/VI-\d{3,}\.json$/.test(path)).flatMap((path) => {
    try {
      const issue = validateVersionIssue(JSON.parse(textAt(cwd, ref, path)), { version });
      return ['P0', 'P1'].includes(issue.severity) && ['open', 'mitigated'].includes(issue.status)
        ? [{ path, issueId: issue.issueId, severity: issue.severity, status: issue.status }]
        : [];
    } catch {
      return [{ path, issueId: path.split('/').at(-1)?.replace(/\.json$/, ''), severity: 'P0', status: 'invalid' }];
    }
  });
}

function isAncestor(cwd, ancestor, descendant) {
  return runGitResult(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]).status === 0;
}


function changedBacklogIds(baseRows, headRows) {
  return [...new Set([...baseRows.keys(), ...headRows.keys()])]
    .filter((id) => baseRows.get(id)?.line !== headRows.get(id)?.line);
}

function manifestFields(source) {
  const fields = new Map();
  for (const line of (source ?? '').split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match) fields.set(match[1], match[2]);
  }
  return fields;
}

function invalidToolingPaths(changedPaths, { prototypeOnlyLockfile = false } = {}) {
  return changedPaths.filter((path) => {
    if (path.startsWith('apps/ux-prototype/')) return false;
    if (path === 'pnpm-lock.yaml' && prototypeOnlyLockfile) return false;
    if (
      path === 'apps/web/playwright.config.ts'
      || path === 'apps/admin/playwright.config.ts'
      // B-248: test-runner configuration is test infrastructure, not a runtime
      // service surface — same carve-out family as the playwright configs.
      || path === 'apps/admin/vitest.config.mts'
      // I-269: Playwright suites (specs/helpers/README) and integration-test
      // trees are test infrastructure too — not a runtime service surface.
      || /^apps\/[^/]+\/e2e\//.test(path)
      || /^apps\/[^/]+\/test-integration\//.test(path)
      // The isolated E2E stack compose is consumed only by
      // scripts/run-isolated-e2e.mjs on the leased dev host; dev/prod compose
      // files stay runtime-only.
      || path === 'docker-compose.e2e.yml'
      || /^deploy\/release-manifests\/v\d+\.\d+\.\d+\.env$/.test(path)
    ) return false;
    return path.startsWith('apps/')
      || path === 'pnpm-lock.yaml'
      || path === 'pnpm-workspace.yaml'
      || /^docker-compose.*\.yml$/.test(path)
      || /^deploy\/[^/]+\.env$/.test(path)
      || /(^|\/)Dockerfile(?:\.|$)/.test(path);
  });
}

function toolingPackageChangesScriptsOnly({ cwd, base, head }) {
  try {
    const basePackage = JSON.parse(textAt(cwd, base, 'package.json'));
    const headPackage = JSON.parse(textAt(cwd, head, 'package.json'));
    const { scripts: baseScripts = {}, ...baseMetadata } = basePackage;
    const { scripts: headScripts = {}, ...headMetadata } = headPackage;
    const validScripts = (scripts) => scripts !== null
      && typeof scripts === 'object' && !Array.isArray(scripts)
      && Object.values(scripts).every(command => typeof command === 'string' && command.trim().length > 0);
    if (!validScripts(baseScripts) || !validScripts(headScripts)) return false;
    // Adding the isolation guard preserves the existing test command exactly.
    // Do not permit arbitrary rewrites merely because a script has a tooling name.
    const addsIsolationGuard = (name, command) => name === 'test:coordination'
      && headScripts[name] === `node scripts/assert-isolated-test-git.mjs && ${command}`;
    const guard = 'node scripts/assert-isolated-test-git.mjs';
    const projectTests = 'node --test scripts/test/coordination/*.test.mjs';
    const addsEngineSuite = (name, command) => name === 'test:coordination'
      && command === `${guard} && ${projectTests}`
      && headScripts[name] === `${guard} && bash scripts/lib/ensure-coord-engine.sh && ${projectTests} ${COORD_ENGINE_PATH}/test/coordination/*.test.mjs`;
    const extendsCoordinationChecks = (name, command) => addsIsolationGuard(name, command) || addsEngineSuite(name, command);
    return isDeepStrictEqual(baseMetadata, headMetadata)
      // Coordination entries must survive; other script entries may be retired
      // (deletion is still a scripts-only change, e.g. I-269 retiring
      // test:e2e:local), while surviving commands may not be rewritten.
      && Object.entries(baseScripts).every(([name, command]) => headScripts[name] === command
        || extendsCoordinationChecks(name, command)
        || (headScripts[name] === undefined && name !== 'test:coordination'))
      && (Object.keys(headScripts).length !== Object.keys(baseScripts).length
        || Object.entries(baseScripts).some(([name, command]) => extendsCoordinationChecks(name, command)));
  } catch {
    return false;
  }
}

function validateManifestFacts({
  failures,
  id,
  requirement,
  manifestSource,
  changedPaths,
  cwd,
  base,
  head,
  prototypeOnlyLockfile,
}) {
  const fields = manifestFields(manifestSource);
  const version = fields.get('RELEASE_VERSION');
  const requirements = (fields.get('RELEASE_REQUIREMENTS') ?? '').split(',').filter(Boolean);
  const profile = fields.get('RELEASE_DELIVERY_PROFILE') ?? 'runtime';
  const servicesValue = fields.get('RELEASE_SERVICES') ?? '';
  const services = new Set(servicesValue.split(',').filter(Boolean));
  if (version !== requirement.version || !requirements.includes(id)) {
    addFailure(
      failures,
      'MANIFEST_REQUIREMENT_MISMATCH',
      id,
      'manifest Version or requirement list differs from coordination',
    );
  }
  if (profile !== requirement.deliveryProfile) {
    addFailure(
      failures,
      'DELIVERY_PROFILE_MISMATCH',
      id,
      'manifest delivery profile differs from coordination',
    );
  }
  if (profile === 'tooling' || profile === 'governance') {
    const invalidPaths = invalidToolingPaths(changedPaths, { prototypeOnlyLockfile });
    if (
      changedPaths.includes('package.json')
      && !toolingPackageChangesScriptsOnly({ cwd, base, head })
    ) invalidPaths.push('package.json');
    if (servicesValue !== 'none' || invalidPaths.length > 0) {
      addFailure(
        failures,
        'PROFILE_PATH_MISMATCH',
        id,
        'non-runtime profile contains runtime services or paths',
        { paths: invalidPaths },
      );
    }
    return;
  }
  if (profile === 'runtime') {
    // I-113：runtime manifest 服务覆盖直接消费统一分类器结果，不再维护 gate 自有规则。
    const missing = classifyChangedPaths(changedPaths, { prototypeOnlyLockfile }).affectedServices
      .filter((service) => !services.has(service));
    if (missing.length > 0) {
      addFailure(
        failures,
        'SERVICE_COVERAGE_MISMATCH',
        id,
        'runtime manifest does not cover changed services',
        { services: missing },
      );
    }
  }
}

const REQUIREMENT_DOCS_PATTERN = /^docs\/product\/current\/((?:I|F|B)-\d{3,})-/;
const COMPLETION_DOCS_PATTERN = /^docs\/product\/current\/(?:I|F|B)-\d{3,}-[^/]+\/COMPLETION\.json$/;

function changedRequirementIds({ changedPaths, baseRows, headRows, doneRequirementIds }) {
  const ids = new Set(changedBacklogIds(baseRows, headRows));
  for (const path of changedPaths) {
    const docsMatch = REQUIREMENT_DOCS_PATTERN.exec(path);
    // I-119：已 Done 需求的文档目录变更不检出 id——Done 是终态，检出后按 release-docs
    // 会强制 BACKLOG 继续推进而死锁（B-117 PR #121 案例）；零 id 后按 I-109 放行。
    if (docsMatch && !doneRequirementIds?.has(docsMatch[1])) ids.add(docsMatch[1]);
  }
  return [...ids].sort();
}

// I-257：coordination done 之外，另两类终态需求的文档目录变更同样不检出 id——
// main 已含其 COMPLETION.json（完成事实已合并、协调记录滞后，如 I-082），以及
// coordination 启用前即已完结、从未进入协调状态的老需求（如 F-012）。两类都要求
// base BACKLOG 行为 ✔️ Done，只读 base，PR 无法自证终态；改动 BACKLOG 行仍经行 diff
// 检出，改动该需求的 COMPLETION.json 时也不适用本口径，完成事实不能被纯文档 PR 改写。
function terminalDocsRequirementIds({ cwd, base, coordination, baseRows, changedPaths }) {
  const candidates = new Set();
  const completionTouched = new Set();
  for (const path of changedPaths) {
    const id = REQUIREMENT_DOCS_PATTERN.exec(path)?.[1];
    if (!id) continue;
    candidates.add(id);
    if (COMPLETION_DOCS_PATTERN.test(path)) completionTouched.add(id);
  }
  return [...candidates].filter((id) => !completionTouched.has(id)
    && baseRows.get(id)?.status === DONE
    && (!coordination.has(`requirements/${id}.json`) || completionFactAt(cwd, base, id)));
}

function completionFactAt(cwd, ref, id) {
  const directory = headRequirementDirectory(cwd, ref, id);
  const source = directory ? textAt(cwd, ref, `${directory}/COMPLETION.json`) : null;
  if (source === null) return false;
  try {
    return JSON.parse(source).requirementId === id;
  } catch {
    return false;
  }
}

function eventContext(event) {
  if (event?.pull_request) {
    return {
      type: 'pull_request',
      headSha: event.pull_request.head?.sha,
      headRef: event.pull_request.head?.ref,
      baseSha: event.pull_request.base?.sha,
    };
  }
  if (event?.merge_group) {
    return {
      type: 'merge_group',
      headSha: event.merge_group.head_sha,
      headRef: event.merge_group.head_ref,
      baseSha: event.merge_group.base_sha,
    };
  }
  throw new GateError('gate supports only pull_request and merge_group events', {
    code: 'UNSUPPORTED_GATE_EVENT',
  });
}

// B-248: the gate judges the head commit, so the requirement directory must be
// resolved from the head git tree — a different checkout (or a worktree where
// the directory is not materialized) would otherwise misreport documents that
// exist in the evaluated commit. Mirrors requirementDirectory's single-match
// rule; returns the repo-relative directory path.
function headRequirementDirectory(cwd, ref, id) {
  const listing = runGit(cwd, ['ls-tree', '--name-only', ref, 'docs/product/current/']);
  const matches = listing.split('\n').filter(Boolean)
    .map((line) => line.replace(/\/$/, ''))
    .filter((line) => line.startsWith(`docs/product/current/${id}-`));
  return matches.length === 1 ? matches[0] : null;
}

function coreBacklogEqual(left, right) {
  // version 不在此比较：headRow.version 由 VERSION_MISMATCH 单独强校验等于 coordination
  // 绑定版本，因此版本列只能被校正为协调事实（允许合并后改绑版本的需求走完发布门禁）。
  return left && right
    && left.id === right.id
    && left.description === right.description
    && left.migration === right.migration;
}

function testingHistoryValid(requirement) {
  const history = requirement.lifecycleHistory ?? [];
  const testing = history.findIndex(({ to }) => to === 'testing');
  const passed = history.findIndex(({ to }) => to === 'test_passed');
  return testing >= 0 && passed > testing;
}

function loadCompletionSource(source) {
  try {
    return JSON.parse(source);
  } catch {
    return null;
  }
}

function addFailure(failures, code, id, message, data = {}) {
  failures.push({ code, requirementId: id, message, ...data });
}

function completionBranchId(headRef) {
  return /^automation\/((?:I|F|B)-\d{3,})-complete(?:\/[^/].*)?$/.exec(headRef ?? '')?.[1] ?? null;
}

// Closure commits after testing may only tick checklist items and record evidence;
// exempt every active requirement directory's closure documents, not just the detected
// requirement, so multi-requirement batch closures do not trip UNTESTED_CHANGES.
const CLOSURE_DOCUMENT_PATTERN = /^docs\/product\/current\/[^/]+\/(?:CHECKLIST\.md|ACCEPTANCE\.md|TEST_EVIDENCE\.json)$/;

// I-272: review artifacts under ANY requirement directory join the closure
// window as single additions — a unified version train records one member's
// rounds and acceptance after another member's test run. Recorded-report
// immutability is preserved: a later edit is not a single addition and the
// report must belong to the directory's requirement, so replaced or forged
// artifacts stay rejected.
function allowedClosurePath(path, { cwd, testedCommit, evaluationHead }) {
  if (path === 'BACKLOG.md' || CLOSURE_DOCUMENT_PATTERN.test(path)) return true;
  const match = /^docs\/product\/current\/((?:I|F|B)-\d+)[^/]*\/(.+)$/.exec(path);
  if (!match) return false;
  const [, dirRequirementId, artifact] = match;
  const stage = /^reviews\/(requirements|ux|design|implementation|verification|release|closure)-(?:epoch-\d+-)?(?:round-[12]|verify-round-[12])\.json$/.exec(artifact)?.[1];
  const uiReport = /^(?:acceptance\/attempt-[0-9a-f]{16,64}\/)?UI_ACCEPTANCE\.json$/.test(artifact);
  const scenarioReport = /^self-check\/[a-f0-9]{64}\/AGENT_SELF_CHECK\.json$/.test(artifact);
  const screenshot = /^(?:reviews|acceptance\/attempt-[0-9a-f]{16,64})\/screenshots\/[^/]+\.(?:png|webp)$/.test(artifact);
  if (!stage && !uiReport && !scenarioReport && !screenshot) return false;
  if (textAt(cwd, testedCommit, path) !== null) return false;
  if (!isSingleAdditionSince({ cwd, path, fromSha: testedCommit, toSha: evaluationHead })) return false;
  const source = textAt(cwd, evaluationHead, path);
  if (source === null) return false;
  if (screenshot) return true;
  try {
    const report = JSON.parse(source);
    return report.schemaVersion === 1 && report.requirementId === dirRequirementId
      && (uiReport || scenarioReport || (report.stage === stage && /^[0-9a-f]{64}$/.test(report.subjectFingerprint ?? '')));
  } catch { return false; }
}

export function readGateEvent(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new GateError(`failed to read GitHub event: ${path}`, {
      code: 'INVALID_GATE_EVENT',
      cause: error,
    });
  }
}

export async function preflightRepositoryGate({
  cwd,
  store,
  head = 'HEAD',
  base = 'origin/main',
}) {
  const resolvedHead = revision(cwd, head);
  const resolvedBase = revision(cwd, base);
  const headRef = runGit(cwd, ['branch', '--show-current']);
  if (!headRef) {
    throw new GateError('gate preflight requires a named branch', {
      code: 'BRANCH_REQUIRED',
    });
  }
  return validateRepositoryGate({
    cwd,
    store,
    event: {
      pull_request: {
        draft: false,
        head: { ref: headRef, sha: resolvedHead },
        base: { ref: 'main', sha: resolvedBase },
      },
    },
    head: resolvedHead,
    base: resolvedBase,
  });
}

export async function validateRepositoryGate({ cwd, store, event, head, base }) {
  const evaluationHead = revision(cwd, head);
  const evaluationBase = revision(cwd, base);
  const currentHead = runGit(cwd, ['rev-parse', 'HEAD']);
  const eventInfo = eventContext(event);
  const failures = [];
  const uxReviewHints = [];
  if (currentHead !== evaluationHead) {
    addFailure(failures, 'CHECKOUT_HEAD_MISMATCH', null, 'checkout HEAD differs from gate head');
  }
  if (eventInfo.headSha && revision(cwd, eventInfo.headSha) !== evaluationHead) {
    addFailure(failures, 'EVENT_HEAD_MISMATCH', null, 'event head differs from gate head');
  }
  if (eventInfo.baseSha && revision(cwd, eventInfo.baseSha) !== evaluationBase) {
    addFailure(failures, 'EVENT_BASE_MISMATCH', null, 'event base differs from gate base');
  }
  if (!isAncestor(cwd, evaluationBase, evaluationHead)) {
    addFailure(failures, 'BASE_NOT_ANCESTOR', null, 'gate base is not an ancestor of gate head');
  }

  const baseRows = backlogRows(textAt(cwd, evaluationBase, 'BACKLOG.md'));
  const headRows = backlogRows(textAt(cwd, evaluationHead, 'BACKLOG.md'));
  const changedPaths = pathsBetween(cwd, evaluationBase, evaluationHead);
  const prototypeOnlyLockfile = changedPaths.includes('pnpm-lock.yaml')
    && provePrototypeOnlyLockfile({ cwd, base: evaluationBase, head: evaluationHead });
  const coordination = await store.readSnapshot();
  const checkedIssueVersions = new Set();
  // I-119：已 Done 需求的文档目录变更不参与 id 检出（纯文档收尾放行）
  const doneRequirementIds = new Set([
    ...requirementDocuments(coordination)
      .filter((requirement) => requirement.lifecycle === 'done')
      .map((requirement) => requirement.id),
    ...terminalDocsRequirementIds({
      cwd,
      base: evaluationBase,
      coordination,
      baseRows,
      changedPaths,
    }),
  ]);
  const ids = changedRequirementIds({
    cwd,
    head: evaluationHead,
    changedPaths,
    baseRows,
    headRows,
    doneRequirementIds,
  });
  const releaseDocsOnly = changedPaths.length > 0 && changedPaths.every((path) => (
    path === 'BACKLOG.md' || path.startsWith('docs/')
  ));
  // I-109：纯文档变更（仅 BACKLOG/docs）允许不关联需求 id（发布结果回填等场景）；
  // 其余零 id 变更仍按 REQUIREMENT_NOT_DETECTED 拒绝。
  if (ids.length === 0 && !releaseDocsOnly) {
    addFailure(failures, 'REQUIREMENT_NOT_DETECTED', null, 'no changed requirement was detected');
  }

  const completionId = completionBranchId(eventInfo.headRef);
  const inferredCompletion = ids.length > 0 && ids.every((id) => (
    COMPLETION_BASE_STATUSES.has(baseRows.get(id)?.status)
    && headRows.get(id)?.status === DONE
    && coordination.has(`requirements/${id}.json`)
    && COMPLETION_LIFECYCLES.has(coordination.readJson(`requirements/${id}.json`).lifecycle)
  ));
  const allProdStage = ids.length > 0 && ids.every((id) => (
    coordination.has(`requirements/${id}.json`)
    && PROD_STAGE_LIFECYCLES.has(coordination.readJson(`requirements/${id}.json`).lifecycle)
  ));
  // I-109：纯文档回填 PR（仅 BACKLOG/docs 且未检出任何需求 id）按 release-docs 放行；
  // BACKLOG 行增改会经行 diff 检出 id（新增行不在 coordination 则落 feature 被拒），放行面仅限零需求关联的纯文档变更。
  const kind = completionId || inferredCompletion
    ? 'completion'
    : (releaseDocsOnly && (ids.length === 0 || allProdStage) ? 'release-docs' : 'feature');
  // B-248: the zero-id release-docs allowance (I-109) previously skipped every
  // per-id check, so a docs-only PR could silently delete or rewrite pending
  // migration drafts. Deletions/modifications of PENDING migration drafts
  // require an owning requirement — record the change against it instead.
  if (kind === 'release-docs' && ids.length === 0) {
    const protectedPaths = changedPaths.filter((path) => /^docs\/releases\/PENDING\/MIGRATION-[^/]+\.md$/.test(path));
    if (protectedPaths.length > 0) {
      addFailure(
        failures,
        'RELEASE_DOCS_PROTECTED_PATH',
        null,
        'pending migration drafts cannot be changed by a requirement-less release-docs change',
        { paths: protectedPaths },
      );
    }
  }
  const evidenceClosures = [];

  if (completionId && (ids.length !== 1 || ids[0] !== completionId)) {
    addFailure(failures, 'COMPLETION_REQUIREMENT_MISMATCH', completionId, (
      'completion branch must change exactly its declared requirement'
    ));
  }

  for (const id of ids) {
    try {
      assertRequirementId(id);
    } catch {
      addFailure(failures, 'INVALID_REQUIREMENT_ID', id, 'invalid requirement id');
      continue;
    }
    const statePath = `requirements/${id}.json`;
    if (!coordination.has(statePath)) {
      addFailure(failures, 'REQUIREMENT_NOT_CLAIMED', id, 'requirement is absent from coordination');
      continue;
    }
    const requirement = coordination.readJson(statePath);
    if (requirement.version && !checkedIssueVersions.has(requirement.version)) {
      checkedIssueVersions.add(requirement.version);
      const unresolved = unresolvedVersionIssuesAt({ cwd, ref: evaluationHead, version: requirement.version });
      if (unresolved.length > 0) {
        addFailure(
          failures,
          'VERSION_ISSUES_UNRESOLVED',
          id,
          `Version ${requirement.version} has unresolved P0/P1 iteration issues`,
          { version: requirement.version, issues: unresolved },
        );
      }
    }
    // I-272: joint train support. A unified version train (multiple requirements
    // sharing one version and one branch, merged as a single PR) is one delivery
    // unit: coverage, migration attribution, resource conflicts and the dev
    // deployment fact are evaluated per train, not per member, in pull_request
    // mode — matching what merge_group events already do for coverage. Members
    // must each still pass their own lifecycle/evidence checks below.
    const trainCoMembers = ids.filter((candidateId) => candidateId !== id)
      .filter((candidateId) => coordination.has(`requirements/${candidateId}.json`))
      .map((candidateId) => coordination.readJson(`requirements/${candidateId}.json`))
      .filter((candidate) => candidate.version === requirement.version);
    const trainOwnedPatterns = trainCoMembers.flatMap((candidate) => candidate.resources?.files ?? []);
    if (requirement.workflowVersion === 2 && kind !== 'release-docs') {
      const stage = kind === 'completion' ? 'closure' : 'verification';
      const review = evaluateReviewReadiness({ snapshot: coordination, cwd, requirement, stage, ref: evaluationHead });
      for (const item of review.missing) addFailure(failures, item.code, id, item.message, { stage, remediation: item.remediation });
    }
    const baseRow = baseRows.get(id);
    const headRow = headRows.get(id);
    if (!headRow) {
      addFailure(failures, 'BACKLOG_MISSING', id, 'requirement row is missing from BACKLOG');
      continue;
    }
    if (headRow.version !== requirement.version || headRow.version === '-') {
      addFailure(failures, 'VERSION_MISMATCH', id, 'BACKLOG and coordination versions differ');
    }
    const requirementDirRelative = headRequirementDirectory(cwd, evaluationHead, id);
    const directory = requirementDirRelative ? resolve(cwd, requirementDirRelative) : null;
    // B-248: the gate judges the head commit, not the local worktree. Reading
    // requirement documents from disk let uncommitted edits or deletions flip
    // a preflight verdict without ever being pushed, so all four evidence
    // documents are resolved from the evaluationHead git object.
    const acceptanceSource = requirementDirRelative
      ? textAt(cwd, evaluationHead, `${requirementDirRelative}/ACCEPTANCE.md`)
      : null;
    if (!directory || acceptanceSource === null) {
      addFailure(failures, 'REQUIREMENT_DOCUMENTS_MISSING', id, 'requirement documents are missing');
    }
    const manifestRelativePath = `deploy/release-manifests/${requirement.version}.env`;
    const manifestSource = textAt(cwd, evaluationHead, manifestRelativePath);
    if (manifestSource === null) {
      addFailure(failures, 'MANIFEST_MISSING', id, 'release manifest is missing');
    } else {
      validateManifestFacts({
        failures,
        id,
        requirement,
        manifestSource,
        changedPaths,
        cwd,
        base: evaluationBase,
        head: evaluationHead,
        prototypeOnlyLockfile,
      });
    }
    const migrationDraftSource = textAt(
      cwd,
      evaluationHead,
      `docs/releases/PENDING/MIGRATION-${id}.md`,
    );
    // Runtime completion happens after production: its executed migration plan
    // may already have moved from PENDING into the immutable release archive.
    // Keep the draft requirement for development and tooling completions.
    const archivedMigration = kind === 'completion'
      && requirement.deliveryProfile === 'runtime'
      && ['prod_deployed', 'done'].includes(requirement.lifecycle)
      && requirement.mergeStatus === 'merged'
      && new RegExp(`\\b${id}\\b`).test(textAt(
        cwd, evaluationHead, `docs/releases/${requirement.version}/MIGRATION.md`,
      ) ?? '')
      && new RegExp(`\\b${id}\\b`).test(textAt(
        cwd, evaluationHead, `docs/releases/${requirement.version}/RELEASE.md`,
      ) ?? '');
    if (headRow.migration === '是' && migrationDraftSource === null && !archivedMigration) {
      addFailure(failures, 'MIGRATION_DRAFT_MISSING', id, 'pending migration draft is missing');
    }
    // B-248: the migration declaration was previously one-directional — only
    // "yes" was cross-checked (against the draft). A "no" declaration shipped
    // schema/migration changes unaudited, which is the dangerous side of the
    // gate (same shape as the UX_IMPACT_MISMATCH fix for uxImpact none).
    // I-272: on a unified version train the PR diff carries the co-members'
    // audited migrations too; paths declared by a same-version co-member are
    // attributed to that member (its own 是 declaration and draft cover them)
    // instead of blaming every no-migration member of the train.
    if (headRow.migration !== '是') {
      const migrationLikePaths = changedPaths.filter((path) => isMigrationPath(path))
        .filter((path) => !trainOwnedPatterns.some((pattern) => resourceValueCoversPath(pattern, path)));
      if (migrationLikePaths.length > 0) {
        addFailure(
          failures,
          'MIGRATION_IMPACT_MISMATCH',
          id,
          'migration-like changed paths conflict with the no-migration declaration',
          { paths: migrationLikePaths },
        );
      }
    }

    if (kind === 'completion') {
      if (!COMPLETION_LIFECYCLES.has(requirement.lifecycle)) {
        addFailure(failures, 'COMPLETION_NOT_MERGED', id, 'completion requires merged or post-merge coordination state');
      }
      if (!COMPLETION_BASE_STATUSES.has(baseRow?.status) || headRow.status !== DONE) {
        addFailure(failures, 'COMPLETION_STATUS_INVALID', id, 'completion must change Test Passed / Prod Planning / Prod Deployed to Done');
      }
      if (!coreBacklogEqual(baseRow, headRow)) {
        addFailure(failures, 'COMPLETION_BACKLOG_SCOPE_INVALID', id, 'completion changed BACKLOG core fields');
      }
      const completionSource = requirementDirRelative
        ? textAt(cwd, evaluationHead, `${requirementDirRelative}/COMPLETION.json`)
        : null;
      const completion = completionSource === null ? null : loadCompletionSource(completionSource);
      if (
        completion?.schemaVersion !== 1
        || completion?.requirementId !== id
        || completion?.deliveryProfile !== requirement.deliveryProfile
        || completion?.mergedCommit !== requirement.mergedCommit
      ) {
        addFailure(failures, 'COMPLETION_EVIDENCE_INVALID', id, 'COMPLETION.json is missing or invalid');
      }
      continue;
    }

    if (kind === 'release-docs') {
      const baseIndex = PROD_STAGE_STATUSES.indexOf(baseRow?.status ?? '');
      const headIndex = PROD_STAGE_STATUSES.indexOf(headRow.status);
      if (baseIndex < 0 || headIndex <= baseIndex) {
        addFailure(failures, 'RELEASE_DOCS_STATUS_INVALID', id, 'release-docs PR must advance BACKLOG through prod-stage statuses');
      }
      if (!coreBacklogEqual(baseRow, headRow)) {
        addFailure(failures, 'RELEASE_DOCS_BACKLOG_SCOPE_INVALID', id, 'release-docs PR changed BACKLOG core fields');
      }
      continue;
    }

    if (requirement.lifecycle !== 'test_passed' || headRow.status !== TEST_PASSED) {
      addFailure(failures, 'FEATURE_NOT_TEST_PASSED', id, 'feature requirement is not Test Passed');
    }
    if (requirement.uxImpact === 'admin-ui') {
      const ux = evaluateUxReadiness({ snapshot: coordination, cwd, requirement });
      if (!ux.ok) {
        addFailure(failures, 'UX_APPROVAL_NOT_CURRENT', id, 'current UX specification and prototype need user approval', {
          missing: ux.missing, detail: ux.artifacts?.missing ?? [],
        });
      }
    } else if (requirement.uxImpact === 'none') {
      const uxPaths = uxPathsOwnedByRequirement({ changedPaths, requirement });
      const impact = classifyAdminUxImpact(uxPaths);
      // B-248: the review bucket (hooks/lib/utils/config — files that shape
      // employee-visible behavior without being a page) previously produced
      // a hint only. It is now a gate failure unless every path is covered by
      // a recorded ux review override (requirement allow-ux-review, reason
      // audited) — the visible bucket keeps its hard UX_IMPACT_MISMATCH.
      const overridePaths = new Set(
        (requirement.uxReviewOverrides ?? []).flatMap((entry) => entry.paths ?? []),
      );
      const reviewUnresolved = impact.review.filter((path) => !overridePaths.has(path));
      if (reviewUnresolved.length > 0) {
        addFailure(
          failures,
          'UX_IMPACT_REVIEW_UNRESOLVED',
          id,
          'admin behavior-influencing changes are not covered by the none declaration or a recorded review override',
          {
            paths: reviewUnresolved,
            overridden: impact.review.filter((path) => overridePaths.has(path)),
            remediation: 'upgrade the declaration (requirement set-ux-impact) or record an override: requirement allow-ux-review',
          },
        );
      } else if (impact.review.length > 0) {
        uxReviewHints.push({ requirementId: id, paths: impact.review,
          message: 'admin review-bucket paths are carried by a recorded ux review override' });
      }
      if (impact.visible.length > 0) {
        addFailure(failures, 'UX_IMPACT_MISMATCH', id, 'admin employee-visible changes conflict with uxImpact none', {
          paths: impact.visible, review: impact.review,
        });
      }
    }
    if (eventInfo.type === 'pull_request' && requirement.branch !== eventInfo.headRef) {
      addFailure(failures, 'BRANCH_MISMATCH', id, 'pull request branch differs from coordination');
    }
    if (!testingHistoryValid(requirement)) {
      addFailure(failures, 'TESTING_WAS_SKIPPED', id, 'lifecycle history does not include Testing');
    }
    const coverageRequirements = eventInfo.type === 'merge_group'
      ? ids.filter((candidateId) => coordination.has(`requirements/${candidateId}.json`))
        .map((candidateId) => coordination.readJson(`requirements/${candidateId}.json`))
      // I-272: a pull_request carrying a unified version train uses the same
      // union-coverage semantics as merge_group, restricted to same-version
      // co-members — each member declares only its own delta instead of the
      // whole train diff.
      : [requirement, ...trainCoMembers];
    const uncoveredPaths = changedPaths.filter((changedPath) => changedPath !== 'BACKLOG.md'
      && changedPath !== 'AGENTS.md'
      && !coverageRequirements.some((candidate) => changedPath.startsWith(`docs/product/current/${candidate.id}-`))
      && !coverageRequirements.some((candidate) => (candidate.resources?.files ?? [])
        .some((pattern) => resourceValueCoversPath(pattern, changedPath))));
    if (uncoveredPaths.length > 0) {
      addFailure(
        failures,
        'RESOURCE_DECLARATION_INCOMPLETE',
        id,
        'changed paths are not covered by the requirement resource declaration',
        { paths: uncoveredPaths },
      );
    }
    for (const otherPath of coordination.paths()) {
      if (!/^requirements\/(?:I|F|B)-\d{3,}\.json$/.test(otherPath)) continue;
      const other = coordination.readJson(otherPath);
      if (other.id === id || !requirementIsActive(other)) continue;
      // I-272: co-members of the same version train ride the same unified
      // branch and merge as one delivery unit — mutual resource overlap inside
      // the train is expected (union coverage), not a conflict to serialize.
      // Same-version requirements outside this evaluation still conflict.
      if (other.version === requirement.version && ids.includes(other.id)) continue;
      const overlaps = overlappingResources(requirement.resources, other.resources);
      if (Object.keys(overlaps).length === 0) continue;
      if (
        dependencyReaches(coordination, id, other.id)
        || dependencyReaches(coordination, other.id, id)
      ) continue;
      addFailure(
        failures,
        'RESOURCE_CONFLICT_UNRESOLVED',
        id,
        `active requirement has unresolved resource overlap: ${other.id}`,
        { conflictingRequirementId: other.id, overlaps },
      );
    }
    for (const dependency of requirement.dependsOn ?? []) {
      const dependencyPath = `requirements/${dependency}.json`;
      const dependencyState = coordination.has(dependencyPath)
        ? coordination.readJson(dependencyPath)
        : null;
      const merged = MERGED_STATES.has(dependencyState?.lifecycle)
        || (
          dependencyState?.mergeStatus === 'merged'
          && /^[0-9a-f]{40}$/.test(dependencyState?.mergedCommit ?? '')
        );
      if (!merged) {
        addFailure(failures, 'DEPENDENCY_NOT_MERGED', id, `dependency is not merged: ${dependency}`);
      }
    }
    const evidenceSource = requirementDirRelative
      ? textAt(cwd, evaluationHead, `${requirementDirRelative}/TEST_EVIDENCE.json`)
      : null;
    if (evidenceSource === null) {
      addFailure(failures, 'TEST_EVIDENCE_MISSING', id, 'TEST_EVIDENCE.json is missing');
      continue;
    }
    let evidence;
    try {
      evidence = JSON.parse(evidenceSource);
    } catch {
      addFailure(failures, 'TEST_EVIDENCE_INVALID', id, 'TEST_EVIDENCE.json is invalid');
      continue;
    }
    if (!isAncestor(cwd, evidence.testedCommit, evaluationHead)) {
      addFailure(failures, 'TESTED_COMMIT_NOT_ANCESTOR', id, 'tested commit is not in gate head');
      continue;
    }
    const closurePaths = pathsBetween(cwd, evidence.testedCommit, evaluationHead);
    const mainAdvancementPaths = evidence.mainBase === evaluationBase
      ? new Set()
      : new Set(pathsBetween(cwd, evidence.mainBase, evaluationBase));
    const gateDeltaPaths = new Set(changedPaths);
    const testedPaths = new Set(pathsBetween(cwd, evidence.mainBase, evidence.testedCommit));
    const otherMergeGroupRequirements = eventInfo.type === 'merge_group'
      ? ids.filter((candidateId) => candidateId !== id)
        .filter((candidateId) => coordination.has(`requirements/${candidateId}.json`))
        .map((candidateId) => coordination.readJson(`requirements/${candidateId}.json`))
      // I-272 (correction): a pull_request carrying a unified version train
      // gets the same cross-member exemption — a path that was never in this
      // member's tested window and is declared by a same-version co-member is
      // the co-member's tested change, not this member's untested delta (the
      // documented merge-group semantics, e.g. the co-member's package.json
      // script or acceptance artifacts landing after this member's run).
      : trainCoMembers;
    // B-248: when main advanced between the test run and this evaluation and
    // the branch merged it, files that exist identically in evaluationBase are
    // main's content, not this requirement's untested delta (the classic
    // mainBase === base window left them unexempted).
    const mainContentPaths = mainAdvancementPaths.size === 0
      ? new Set(closurePaths.filter((path) => !gateDeltaPaths.has(path)
        && textAt(cwd, evaluationBase, path) !== null))
      : mainAdvancementPaths;
    const untested = closurePaths.filter((changedPath) => {
      // Every member's test evidence depends on the engine that generated it.
      if (changedPath === COORD_ENGINE_PATH) return true;
      return !allowedClosurePath(changedPath, { cwd, testedCommit: evidence.testedCommit, evaluationHead })
        && (!mainContentPaths.has(changedPath) || gateDeltaPaths.has(changedPath))
        && !(
          !testedPaths.has(changedPath)
          && otherMergeGroupRequirements.some((candidate) => (
            candidate.resources?.files ?? []
          ).some((pattern) => resourceValueCoversPath(pattern, changedPath)))
        );
    });
    const testedRows = backlogRows(textAt(cwd, evidence.testedCommit, 'BACKLOG.md'));
    if (untested.length > 0 || !coreBacklogEqual(testedRows.get(id), headRow)) {
      addFailure(failures, 'UNTESTED_CHANGES', id, 'files or requirement core fields changed after testing', {
        paths: untested,
      });
    }
    try {
      // I-272: deployments/dev.json holds ONE authoritative record. On a unified
      // version train the members record their snapshots sequentially, so a
      // member's evidence may face a co-member's newer record. When that record
      // is same-version and its commit contains this member's tested commit,
      // the tested code is included in the authoritative deployment
      // (deployment-neutral per the evidence drift policy) and the strict
      // snapshot equality is not demanded for this member.
      const authoritativeDeployment = coordination.has('deployments/dev.json')
        ? coordination.readJson('deployments/dev.json')
        : null;
      const deploymentForEvidence = authoritativeDeployment
        && authoritativeDeployment.requirementId !== id
        && authoritativeDeployment.version === requirement.version
        && isAncestor(cwd, evidence.testedCommit, authoritativeDeployment.commit ?? '')
        ? undefined
        : authoritativeDeployment;
      const validation = await validateTestEvidence({
        cwd,
        id,
        head: evidence.testedCommit,
        base,
        requirement,
        freeze: resolveAcceptanceFact(coordination, id),
        deployment: deploymentForEvidence,
        mixedEnvironment: coordination.has(`environments/${id}/mixed-dev.json`)
          ? coordination.readJson(`environments/${id}/mixed-dev.json`)
          : null,
        ...(evidence.environment?.kind === 'mixed-dev' ? {
          lease: coordination.has('locks/dev.json') ? coordination.readJson('locks/dev.json').active : null,
          freeze: (() => {
            const fact = resolveAcceptanceFact(coordination, id);
            return fact?.requirementId === id ? fact : null;
          })(),
        } : {}),
      });
      evidenceClosures.push({
        requirementId: id,
        testedCommit: evidence.testedCommit,
        head: evaluationHead,
        closurePaths,
        requiredActions: validation.requiredActions,
      });
    } catch (error) {
      addFailure(failures, 'TEST_EVIDENCE_INVALID', id, error.message, {
        evidenceFailures: error.data?.failures ?? [],
      });
    }
  }

  if (kind === 'completion') {
    const allowed = new Set(['BACKLOG.md']);
    for (const id of ids) {
      const completionDir = headRequirementDirectory(cwd, evaluationHead, id);
      if (completionDir) allowed.add(`${completionDir}/COMPLETION.json`);
    }
    const unexpected = changedPaths.filter((path) => !allowed.has(path));
    if (unexpected.length > 0) {
      addFailure(failures, 'COMPLETION_SCOPE_INVALID', ids[0] ?? null, (
        'completion PR changed files outside completion facts'
      ), { paths: unexpected });
    }
  }

  if (failures.length > 0) {
    throw new GateError('repository coordination gate failed', {
      data: {
        failures,
        event: eventInfo.type,
        kind,
        head: evaluationHead,
        base: evaluationBase,
      },
    });
  }
  return {
    valid: true,
    event: eventInfo.type,
    kind,
    head: evaluationHead,
    base: evaluationBase,
    requirements: ids,
    evidenceClosures,
    uxReviewHints,
  };
}
