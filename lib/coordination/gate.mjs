import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';

import { evidencePath, validateTestEvidence } from './evidence.mjs';
import { classifyChangedPaths } from './path-classifier.mjs';
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
import { freezeFactFromSnapshot } from './leases.mjs';
import { isSingleAdditionSince } from './revision-policy.mjs';

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
  return runGit(cwd, ['diff', '--name-only', from, to]).split('\n').filter(Boolean);
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

function toolingPackageAddsScriptsOnly({ cwd, base, head }) {
  try {
    const basePackage = JSON.parse(textAt(cwd, base, 'package.json'));
    const headPackage = JSON.parse(textAt(cwd, head, 'package.json'));
    const { scripts: baseScripts = {}, ...baseMetadata } = basePackage;
    const { scripts: headScripts = {}, ...headMetadata } = headPackage;
    return isDeepStrictEqual(baseMetadata, headMetadata)
      && Object.entries(baseScripts).every(([name, command]) => headScripts[name] === command)
      && Object.keys(headScripts).length > Object.keys(baseScripts).length;
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
      && !toolingPackageAddsScriptsOnly({ cwd, base, head })
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

function changedRequirementIds({ changedPaths, baseRows, headRows, doneRequirementIds }) {
  const ids = new Set(changedBacklogIds(baseRows, headRows));
  for (const path of changedPaths) {
    const docsMatch = /^docs\/product\/current\/((?:I|F|B)-\d{3,})-/.exec(path);
    // I-119：已 Done 需求的文档目录变更不检出 id——Done 是终态，检出后按 release-docs
    // 会强制 BACKLOG 继续推进而死锁（B-117 PR #121 案例）；零 id 后按 I-109 放行。
    if (docsMatch && !doneRequirementIds?.has(docsMatch[1])) ids.add(docsMatch[1]);
  }
  return [...ids].sort();
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

function requirementDirectory(cwd, id) {
  const current = resolve(cwd, 'docs', 'product', 'current');
  const matches = existsSync(current)
    ? readdirSync(current, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${id}-`))
    : [];
  return matches.length === 1 ? resolve(current, matches[0].name) : null;
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

function loadCompletion(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
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

function allowedClosurePath(path, { cwd, requirementId, testedCommit, evaluationHead }) {
  if (path === 'BACKLOG.md' || CLOSURE_DOCUMENT_PATTERN.test(path)) return true;
  const root = `docs/product/current/${requirementId}-`;
  if (!path.startsWith(root)) return false;
  const relative = path.slice('docs/product/current/'.length);
  if (!relative.includes('/')) return false;
  const artifact = relative.slice(relative.indexOf('/') + 1);
  const stage = /^reviews\/(requirements|ux|design|implementation|verification|release|closure)-(?:epoch-\d+-)?(?:round-[12]|verify-round-[12])\.json$/.exec(artifact)?.[1];
  const uiReport = artifact === 'UI_ACCEPTANCE.json';
  const screenshot = /^reviews\/screenshots\/[^/]+\.(?:png|webp)$/.test(artifact);
  if (!stage && !uiReport && !screenshot) return false;
  if (textAt(cwd, testedCommit, path) !== null) return false;
  if (!isSingleAdditionSince({ cwd, path, fromSha: testedCommit, toSha: evaluationHead })) return false;
  const source = textAt(cwd, evaluationHead, path);
  if (source === null) return false;
  if (screenshot) return true;
  try {
    const report = JSON.parse(source);
    return report.schemaVersion === 1 && report.requirementId === requirementId
      && (uiReport || (report.stage === stage && /^[0-9a-f]{64}$/.test(report.subjectFingerprint ?? '')));
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
  // I-119：已 Done 需求的文档目录变更不参与 id 检出（纯文档收尾放行）
  const doneRequirementIds = new Set(
    requirementDocuments(coordination)
      .filter((requirement) => requirement.lifecycle === 'done')
      .map((requirement) => requirement.id),
  );
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
    const directory = requirementDirectory(cwd, id);
    if (!directory || !existsSync(join(directory, 'ACCEPTANCE.md'))) {
      addFailure(failures, 'REQUIREMENT_DOCUMENTS_MISSING', id, 'requirement documents are missing');
    }
    const manifestRelativePath = `deploy/release-manifests/${requirement.version}.env`;
    const manifestPath = resolve(cwd, manifestRelativePath);
    const manifestSource = textAt(cwd, evaluationHead, manifestRelativePath);
    if (!existsSync(manifestPath) || manifestSource === null) {
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
    if (
      headRow.migration === '是'
      && !existsSync(resolve(cwd, 'docs', 'releases', 'PENDING', `MIGRATION-${id}.md`))
    ) {
      addFailure(failures, 'MIGRATION_DRAFT_MISSING', id, 'pending migration draft is missing');
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
      const completionPath = directory ? join(directory, 'COMPLETION.json') : '';
      const completion = completionPath ? loadCompletion(completionPath) : null;
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
      if (impact.review.length > 0) {
        uxReviewHints.push({ requirementId: id, paths: impact.review,
          message: 'Check whether these admin paths change employee-visible wording or behavior' });
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
      : [requirement];
    const uncoveredPaths = changedPaths.filter((changedPath) => changedPath !== 'BACKLOG.md'
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
    const path = directory ? join(directory, 'TEST_EVIDENCE.json') : '';
    if (!path || !existsSync(path)) {
      addFailure(failures, 'TEST_EVIDENCE_MISSING', id, 'TEST_EVIDENCE.json is missing');
      continue;
    }
    let evidence;
    try {
      evidence = JSON.parse(readFileSync(evidencePath({ cwd, id }), 'utf8'));
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
      : [];
    const untested = closurePaths.filter((changedPath) => (
      !allowedClosurePath(changedPath, { cwd, requirementId: id, testedCommit: evidence.testedCommit, evaluationHead })
      && (!mainAdvancementPaths.has(changedPath) || gateDeltaPaths.has(changedPath))
      && !(
        !testedPaths.has(changedPath)
        && otherMergeGroupRequirements.some((candidate) => (
          candidate.resources?.files ?? []
        ).some((pattern) => resourceValueCoversPath(pattern, changedPath)))
      )
    ));
    const testedRows = backlogRows(textAt(cwd, evidence.testedCommit, 'BACKLOG.md'));
    if (untested.length > 0 || !coreBacklogEqual(testedRows.get(id), headRow)) {
      addFailure(failures, 'UNTESTED_CHANGES', id, 'files or requirement core fields changed after testing', {
        paths: untested,
      });
    }
    try {
      const validation = await validateTestEvidence({
        cwd,
        id,
        head: evidence.testedCommit,
        base,
        requirement,
        deployment: coordination.has('deployments/dev.json')
          ? coordination.readJson('deployments/dev.json')
          : null,
        mixedEnvironment: coordination.has(`environments/${id}/mixed-dev.json`)
          ? coordination.readJson(`environments/${id}/mixed-dev.json`)
          : null,
        ...(evidence.environment?.kind === 'mixed-dev' ? {
          lease: coordination.has('locks/dev.json') ? coordination.readJson('locks/dev.json').active : null,
          freeze: (() => {
            const fact = freezeFactFromSnapshot(coordination, 'dev');
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
      const directory = requirementDirectory(cwd, id);
      if (directory) allowed.add(`${relative(cwd, directory)}/COMPLETION.json`);
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
