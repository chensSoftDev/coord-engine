import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { assertDeliveryProfile, assertRequirementId } from './validation.mjs';
import { evaluateUxReadiness } from './ux-approvals.mjs';
import { evaluateWorkflowReadiness } from './workflow-policy.mjs';
import { invalidateWorkflowFacts } from './workflow-facts.mjs';

// I-132 (F4): exported so the read-only plan command walks the exact same
// state graph the gates enforce — the two can never drift apart.
export const TRANSITIONS = Object.freeze({
  runtime: {
    todo: ['reviewing'],
    reviewing: ['req_confirmed'],
    req_confirmed: ['tech_design'],
    tech_design: ['in_dev'],
    in_dev: ['dev_deployed'],
    dev_deployed: ['testing'],
    testing: ['test_passed'],
    test_passed: ['prod_planning'],
    prod_planning: ['prod_deployed'],
    prod_deployed: ['done'],
  },
  tooling: {
    todo: ['reviewing'],
    reviewing: ['req_confirmed'],
    req_confirmed: ['tech_design'],
    tech_design: ['in_dev'],
    in_dev: ['testing'],
    testing: ['test_passed'],
    test_passed: ['merged'],
    merged: ['done'],
  },
  governance: {
    todo: ['reviewing'],
    reviewing: ['req_confirmed'],
    req_confirmed: ['tech_design'],
    tech_design: ['in_dev'],
    in_dev: ['testing'],
    testing: ['test_passed'],
    test_passed: ['merged'],
    merged: ['done'],
  },
});

const FAILURE_STATES = new Set(['testing', 'test_passed', 'prod_planning']);
// I-131 (E2): exported so worktrees.mjs projects the BACKLOG status column
// from requirement.lifecycle instead of hardcoding a start status.
export const BACKLOG_STATUSES = Object.freeze({
  todo: '⚪ Todo',
  reviewing: '🔍 Reviewing',
  req_confirmed: '📝 Req Confirmed',
  tech_design: '🧩 Tech Design',
  in_dev: '🔨 In Dev',
  dev_deployed: '🚚 Dev Deployed',
  testing: '🧪 Testing',
  test_passed: '✅ Test Passed',
  prod_planning: '📋 Prod Planning',
  prod_deployed: '🚀 Prod Deployed',
  merged: '✅ Test Passed',
  done: '✔️ Done',
  cancelled: '🚫 Cancelled',
});
const EVIDENCE_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export class LifecycleError extends Error {
  constructor(message, { code, exitCode = 14, data = {}, cause } = {}) {
    super(message, { cause });
    this.name = 'LifecycleError';
    this.code = code;
    this.exitCode = exitCode;
    this.data = data;
  }
}

function profileName(profile) {
  try {
    return assertDeliveryProfile(profile);
  } catch (error) {
    throw new LifecycleError(error.message, {
      code: 'INVALID_DELIVERY_PROFILE',
      cause: error,
    });
  }
}

function requirementId(id) {
  try {
    return assertRequirementId(id);
  } catch (error) {
    throw new LifecycleError(error.message, {
      code: 'INVALID_REQUIREMENT_ID',
      cause: error,
    });
  }
}

function stateName(state) {
  if (!Object.hasOwn(BACKLOG_STATUSES, state ?? '')) {
    throw new LifecycleError(`invalid lifecycle state: ${state ?? '<missing>'}`, {
      code: 'INVALID_LIFECYCLE_STATE',
      exitCode: 12,
    });
  }
  return state;
}

function action(code, message) {
  return { code, message };
}

function testEvidenceValid(context) {
  return context.testEvidence?.outcome === 'passed'
    && typeof context.testedCommit === 'string'
    && context.testedCommit === context.currentCommit;
}

// I-130 (D1): lease evidence identity is version-level. The commit leg is
// gone — commit consistency is already hard-checked by
// testedCommit === currentCommit and the devSnapshot JSON identity.
function sameLeaseEvidence(left, right) {
  return Boolean(
    left
    && right
    && typeof left.version === 'string'
    && left.version === right.version
    && left.sessionId === right.sessionId
    && left.branch === right.branch,
  );
}

// `target` covers `commit` when they are equal or `target` is a descendant containing
// `commit`; multi-requirement batches publish one release commit that contains every
// earlier merge commit, so strict equality would lock earlier requirements out.
function commitCovers(context, target, commit) {
  if (typeof target !== 'string' || typeof commit !== 'string') return false;
  if (target === commit) return true;
  return typeof context.isAncestor === 'function' && context.isAncestor(commit, target);
}

// I-160：部署记录的成员匹配——recordDeployment 对同一部署事实的列车共享登记会累积
// requirementIds（首登者保留在 requirementId），两者任一命中即视为覆盖该需求。
export function deploymentCovers(deployment, id) {
  return Boolean(deployment)
    && (
      deployment.requirementId === id
      || (Array.isArray(deployment.requirementIds) && deployment.requirementIds.includes(id))
    );
}

function runtimeTestEnvironmentValid(context) {
  return context.hasDevLease
    && sameLeaseEvidence(context.devLease, context.testEvidence?.environment?.devLease)
    && JSON.stringify(context.devSnapshot) === JSON.stringify(
      context.testEvidence?.environment?.devSnapshot,
    );
}

// I-113 Task 3: after machine verification the dev lease is atomically
// converted into a durable awaiting_human freeze fact, so advancing to Test
// Passed must accept a matching freeze fact as the machine verification
// evidence. freezeEvidenceMatches is set by the CLI only after it verified
// requirement id, machine verification evidence SHA and commit identity.
function freezeTestEnvironmentValid(context) {
  return context.hasFreezeEvidence === true
    && context.freezeEvidenceMatches === true;
}

function requiredActions({ profile, to, context }) {
  const failures = [];
  for (const item of context.workflowMissing ?? []) failures.push(action(item.code, item.message));
  const afterReview = !['reviewing'].includes(to);
  // I-131 (E3): the manifest and migration draft are no longer design-stage
  // gates (afterDesign) — they attach where they are actually consumed:
  // runtime needs them before dev_deployed, tooling/governance (which have
  // no dev_deployed state) before testing (evidence binds the manifest
  // sha256 and the gate preflight reads the manifest). The implementation
  // stage keeps full room to author them.
  const manifestRequired = (profile === 'runtime' && to === 'dev_deployed')
    || (profile !== 'runtime' && to === 'testing');

  if (afterReview && context.migrationResolved !== true) {
    failures.push(action('resolve_migration', 'resolve BACKLOG migration to 是 or 否'));
  }
  if (afterReview && !context.hasVersion) {
    failures.push(action('bind_version', 'bind the requirement to a release version'));
  }
  if (to === 'tech_design' && Array.isArray(context.uxMissing)) {
    for (const code of context.uxMissing) failures.push(action(code, 'complete the current UX review before technical design'));
  }
  if (manifestRequired && !context.hasManifest) {
    failures.push(action('create_manifest', 'create a valid release manifest'));
  }
  if (manifestRequired && context.requiresMigration && !context.hasMigrationDraft) {
    failures.push(action('create_migration_draft', 'create the pending migration draft'));
  }

  if (profile === 'runtime' && ['dev_deployed', 'testing', 'test_passed'].includes(to)) {
    // A matching awaiting_human freeze fact (I-113 Task 3) substitutes for
    // the dev lease and deployment snapshot: the freeze fact itself binds
    // the dev deployment snapshot and machine verification evidence, so
    // those gates are satisfied without an active lease.
    const freezeSatisfies = to === 'test_passed'
      && context.hasFreezeEvidence === true
      && context.freezeEvidenceMatches === true;
    if (!context.hasDevLease && !freezeSatisfies) {
      failures.push(action('acquire_dev_lease', 'acquire the dev environment lease'));
    }
    if (
      !freezeSatisfies && context.mixedEnvironmentValid !== true
      && (
        // I-130 (D1 + review fix): the immutable deployment snapshot is the
        // commit anchor. Drift between the deployed commit and HEAD is
        // tolerated only when the CLI pre-computed devRevisionMatches ===
        // true (the whole range is not runtime-affecting: BACKLOG projection
        // commits, docs, evidence-neutral closures); any runtime-affecting
        // commit in the range fails closed. The pure gate stays IO-free.
        !context.devSnapshot
        || (
          context.devSnapshot.commit !== context.currentCommit
          && context.devRevisionMatches !== true
        )
        || context.devSnapshot.version !== context.version
      )
    ) {
      failures.push(action(
        'deploy_current_commit_to_dev',
        'deploy the current feature commit and record a dev snapshot',
      ));
    }
  }

  if (profile === 'runtime' && ['prod_planning', 'prod_deployed'].includes(to)) {
    if (typeof context.testedCommit !== 'string') {
      failures.push(action('run_required_tests', 'provide valid test evidence for this requirement'));
    } else if (
      context.mergeStatus !== 'merged'
      || !commitCovers(context, context.currentCommit, context.mergedCommit)
      || !commitCovers(context, context.mergedCommit, context.testedCommit)
    ) {
      failures.push(action(
        'merge_tested_commit',
        'use the tested commit recorded as merged into main',
      ));
    }
  }

  if (profile === 'runtime' && to === 'prod_deployed') {
    if (!context.hasProdLease) {
      failures.push(action('acquire_prod_lease', 'acquire the production environment lease'));
    }
    if (
      !context.prodSnapshot
      || (
        !commitCovers(context, context.prodSnapshot.commit, context.currentCommit)
        // I-160：与 dev 门禁同一漂移政策——HEAD 越过已部署 commit 的范围全部为
        // 非 runtime-affecting（BACKLOG 投影等）时容忍，由 CLI 预计算传入，纯门禁保持 IO-free。
        // 版本列车逐条 record+advance 时投影 commit 必然领先 tag，本条款替代 v0.16.3/v0.16.4
        // 的「钉住 tag 临时分支 + 逐条 force-push 复位」收尾路径。
        && context.prodRevisionMatches !== true
      )
      || context.prodSnapshot.version !== context.version
    ) {
      failures.push(action(
        'deploy_current_commit_to_prod',
        'deploy the current commit and record a production snapshot',
      ));
    }
  }

  if (to === 'test_passed') {
    const environmentValid = profile === 'runtime'
      ? runtimeTestEnvironmentValid(context) || freezeTestEnvironmentValid(context)
      : true;
    if (
      !testEvidenceValid(context)
      || !environmentValid
    ) {
      failures.push(action('run_required_tests', 'run all required tests for the current commit'));
    }
  }

  // I-118：runtime prod_deployed -> done 必须先由 Coordination Complete workflow 生成 completion
  // 事实（COMPLETION.json 已合并进 main）。提前 advance done 会把 BACKLOG 行投影成 Done，
  // 使 plan-completion 找不到合法的 base 状态（COMPLETION_BACKLOG_INVALID），造成 I-115 收尾死锁。
  if (profile === 'runtime' && to === 'done') {
    if (context.completionFactPresent !== true) {
      failures.push(action(
        'complete_via_workflow',
        'run local requirement plan-completion/apply-completion and merge the completion PR before advancing to done',
      ));
    }
  }
  if (to === 'done' && context.completionStatus === 'pending') {
    failures.push(action(
      'reconcile_completion',
      'reconcile the merged completion commit before marking the requirement Done',
    ));
  }
  return failures;
}

export function transition({ profile, from, to, context = {} }) {
  const normalizedProfile = profileName(profile);
  const current = stateName(from);
  const requested = stateName(to);
  if (!(TRANSITIONS[normalizedProfile][current] ?? []).includes(requested)) {
    throw new LifecycleError(
      `invalid ${normalizedProfile} lifecycle transition: ${current} -> ${requested}`,
      {
        code: 'INVALID_TRANSITION',
        exitCode: 12,
        data: { profile: normalizedProfile, from: current, to: requested },
      },
    );
  }

  const failures = requiredActions({ profile: normalizedProfile, to: requested, context });
  return {
    allowed: failures.length === 0,
    profile: normalizedProfile,
    from: current,
    requestedState: requested,
    nextState: failures.length === 0 ? requested : current,
    requiredActions: failures.map(({ code }) => code),
    failures,
  };
}

export function failTransition({ profile, from, reason, evidenceSha }) {
  const normalizedProfile = profileName(profile);
  const current = stateName(from);
  if (!FAILURE_STATES.has(current)) {
    throw new LifecycleError(`cannot fail ${normalizedProfile} lifecycle from ${current}`, {
      code: 'INVALID_TRANSITION',
      exitCode: 12,
      data: { profile: normalizedProfile, from: current, to: 'in_dev' },
    });
  }
  const normalizedReason = typeof reason === 'string' ? reason.trim() : '';
  if (normalizedReason.length < 10 || normalizedReason.length > 500 || /[\r\n]/.test(normalizedReason)) {
    throw new LifecycleError('failure reason must be a single line between 10 and 500 characters', {
      code: 'INVALID_FAILURE_REASON',
    });
  }
  if (!EVIDENCE_SHA_PATTERN.test(evidenceSha ?? '')) {
    throw new LifecycleError('failure evidence SHA must be a 40 or 64 character hex digest', {
      code: 'INVALID_EVIDENCE_SHA',
    });
  }
  return {
    allowed: true,
    profile: normalizedProfile,
    from: current,
    nextState: 'in_dev',
    event: {
      type: 'fail',
      from: current,
      to: 'in_dev',
      reason: normalizedReason,
      evidenceSha,
    },
  };
}

function requirementFromSnapshot(snapshot, id) {
  const path = `requirements/${requirementId(id)}.json`;
  if (!snapshot.has(path)) {
    throw new LifecycleError(`requirement is not claimed: ${id}`, {
      code: 'REQUIREMENT_NOT_FOUND',
    });
  }
  return { path, requirement: snapshot.readJson(path) };
}

function backlogLineIndex(lines, id) {
  const prefix = new RegExp(`^\\|\\s*${requirementId(id)}\\s*\\|`);
  const matches = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => prefix.test(line));
  if (matches.length !== 1) {
    throw new LifecycleError(
      matches.length === 0
        ? `BACKLOG row is missing for ${id}`
        : `BACKLOG contains duplicate rows for ${id}`,
      { code: 'BACKLOG_PROJECTION_CONFLICT' },
    );
  }
  return matches[0].index;
}

// I-134 (F8): exported so requirement cancel projects the 🚫 Cancelled row
// through the exact same cell rewrite as lifecycle advances — the projection
// rule stays single-source.
export function projectBacklog({ cwd, id, from, to }) {
  const path = join(cwd, 'BACKLOG.md');
  const original = readFileSync(path, 'utf8');
  const lines = original.split('\n');
  const index = backlogLineIndex(lines, id);
  const cells = lines[index].split('|');
  if (cells.length < 8) {
    throw new LifecycleError(`invalid BACKLOG row for ${id}`, {
      code: 'BACKLOG_PROJECTION_CONFLICT',
    });
  }
  const currentStatus = cells[4].trim();
  // I-131 (review fix): start/import events have from === null — registration
  // already projected the row, so reconciliation is a pure audit closure over
  // the target status and there is no source status to verify.
  const expectedStatus = from === null ? null : BACKLOG_STATUSES[stateName(from)];
  const targetStatus = BACKLOG_STATUSES[stateName(to)];
  if (currentStatus !== expectedStatus && currentStatus !== targetStatus) {
    throw new LifecycleError(
      expectedStatus === null
        ? `BACKLOG ${id} is ${currentStatus}, expected ${targetStatus}`
        : `BACKLOG ${id} is ${currentStatus}, expected ${expectedStatus} or ${targetStatus}`,
      {
        code: 'BACKLOG_PROJECTION_CONFLICT',
        data: { id, currentStatus, expectedStatus, targetStatus },
      },
    );
  }
  if (currentStatus === targetStatus) return { changed: false, status: targetStatus };

  cells[4] = ` ${targetStatus} `;
  lines[index] = cells.join('|');
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, lines.join('\n'), { mode: statSync(path).mode });
  renameSync(temporary, path);
  return { changed: true, status: targetStatus };
}

function lifecycleHistory(requirement, event) {
  return [...(requirement.lifecycleHistory ?? []), event];
}

function runtimeGateContext(snapshot, id, context, clock) {
  const now = clock().getTime();
  // I-130 (D1): the lease recheck mirrors assertLease — identity is the
  // bound version (read from the requirement in the same snapshot) plus
  // ownership (session/token/branch), never the floating commit. The
  // requirement's deployment snapshot carries the commit anchor.
  const requirementVersion = snapshot.readJson(`requirements/${id}.json`).version;
  const leaseContext = (stage, asserted) => {
    const lock = snapshot.has(`locks/${stage}.json`)
      ? snapshot.readJson(`locks/${stage}.json`).active
      : null;
    const valid = Boolean(
      lock
      && asserted
      && typeof lock.version === 'string'
      && lock.version === requirementVersion
      && lock.sessionId === asserted.sessionId
      && lock.branch === asserted.branch
      && lock.ownerToken === asserted.ownerToken
      && Number.isFinite(Date.parse(lock.expiresAt))
      && Date.parse(lock.expiresAt) > now,
    );
    return valid ? lock : null;
  };
  const devLease = leaseContext('dev', context.assertedDevLease);
  const prodLease = leaseContext('prod', context.assertedProdLease);
  const devSnapshot = snapshot.has('deployments/dev.json')
    ? snapshot.readJson('deployments/dev.json')
    : null;
  const prodSnapshot = snapshot.has('deployments/prod.json')
    ? snapshot.readJson('deployments/prod.json')
    : null;
  const mixedPath = `environments/${id}/mixed-dev.json`;
  const mixedFact = snapshot.has(mixedPath) ? snapshot.readJson(mixedPath) : null;
  const mixedEnvironmentValid = context.mixedEnvironmentValid === true && Boolean(mixedFact)
    && !mixedFact.invalidated && context.mixedEnvironment?.identitySha256 === mixedFact.identitySha256
    && JSON.stringify(mixedFact.backend?.deployment) === JSON.stringify(devSnapshot);
  return {
    ...context,
    mixedEnvironmentValid,
    hasDevLease: Boolean(devLease),
    hasProdLease: Boolean(prodLease),
    devLease: devLease ? {
      requirementId: id,
      holder: devLease.holder,
      version: devLease.version,
      sessionId: devLease.sessionId,
      branch: devLease.branch,
      commit: devLease.commit,
      expiresAt: devLease.expiresAt,
    } : null,
    // I-160：部署记录可能被版本列车内多个需求共享登记（requirementIds 累积），
    // 成员匹配 = 首登 requirementId 或累积列表包含当前需求。
    devSnapshot: deploymentCovers(devSnapshot, id) || mixedEnvironmentValid ? devSnapshot : null,
    prodSnapshot: deploymentCovers(prodSnapshot, id) ? prodSnapshot : null,
  };
}

function projectionError(error, data) {
  return new LifecycleError(
    'coordination lifecycle changed but BACKLOG projection failed; reconcile before continuing',
    {
      code: 'PROJECTION_UNCERTAIN',
      exitCode: 15,
      data: { ...data, projectionError: error.message },
      cause: error,
    },
  );
}

// I-131 (E1): resolve the unique successor of a lifecycle state. Terminal
// states (done/cancelled) have none and fail as INVALID_TRANSITION.
export function successorState({ profile, from }) {
  const normalizedProfile = profileName(profile);
  const current = stateName(from);
  const successors = TRANSITIONS[normalizedProfile][current] ?? [];
  if (successors.length !== 1) {
    throw new LifecycleError(
      `${normalizedProfile} lifecycle has no successor from ${current} (terminal state)`,
      {
        code: 'INVALID_TRANSITION',
        exitCode: 12,
        data: { profile: normalizedProfile, from: current },
      },
    );
  }
  return successors[0];
}

// I-131 (E1/E5): shared advance evaluation core — `advance --to`, `next` and
// `batch-next` must never drift apart on gate semantics.
function evaluateAdvance({ snapshot, cwd, id, to, context = {}, clock }) {
  const current = requirementFromSnapshot(snapshot, id);
  // I-132 (F3): the gate evaluation itself lives in the exported pure
  // precheck so the read-only what-next command and the advance path can
  // never drift apart on gate semantics.
  const precheck = evaluateTransitionPrecheck({
    snapshot,
    cwd,
    id,
    to,
    requirement: current.requirement,
    context,
    clock,
  });
  return { current, from: precheck.from, result: precheck.result };
}

// I-132 (F3): actionable remediation per gate-failure code. The manifest,
// migration-draft and version-binding remedies point at the F5 generator
// commands and the standard bind-version flow.
function precheckRemediation(code, { id, requirement }) {
  switch (code) {
    case 'resolve_migration':
      return 'resolve the BACKLOG migration column to 是 or 否';
    case 'bind_version':
      return `pnpm coord requirement bind-version ${id} --bump patch --json`;
    case 'create_ux_spec':
      return `copy docs/product/_TEMPLATE/UX_SPEC.md into the ${id} requirement directory`;
    case 'create_ux_prototype':
      return `add a runnable ${id} scenario in apps/ux-prototype and commit it`;
    case 'obtain_ux_approval':
    case 'refresh_ux_approval':
      return `pnpm coord ux prepare ${id} --json, then request explicit user review of that version`;
    case 'create_manifest':
      return requirement.version
        ? `pnpm coord manifest init ${requirement.version} --json`
        : `bind a version first: pnpm coord requirement bind-version ${id} --bump patch --json`;
    case 'create_migration_draft':
      return `pnpm coord migration draft ${id} --json`;
    case 'acquire_dev_lease':
      return `pnpm coord lock acquire dev --requirement ${id} --ttl 8h --json`;
    case 'deploy_current_commit_to_dev':
      return `deploy the current commit to dev, then pnpm coord deployment record dev --requirement ${id} --snapshot <file> --json`;
    case 'merge_tested_commit':
      return `merge the tested commit into main, then pnpm coord requirement reconcile-merged --commit <sha> --json`;
    case 'acquire_prod_lease':
      return `pnpm coord lock acquire prod --requirement ${id} --ttl 8h --json`;
    case 'deploy_current_commit_to_prod':
      return `deploy the current commit to prod, then pnpm coord deployment record prod --requirement ${id} --snapshot <file> --json`;
    case 'run_required_tests':
      return `run all required tests at the current commit and refresh TEST_EVIDENCE.json, then pnpm coord evidence validate ${id} --head HEAD --base origin/main --json`;
    case 'complete_via_workflow':
      return `pnpm coord requirement plan-completion ${id} --commit <main-tip-sha> --json, then apply-completion and merge its completion PR`;
    case 'reconcile_completion':
      return 'pnpm coord requirement reconcile-merged --commit <main-completion-merge-sha> --json';
    default:
      return null;
  }
}

// I-132 (F3): pure transition gate precheck — the single source of truth for
// gate evaluation. advanceLifecycle rejects on { ok: false } exactly as
// before (via evaluateAdvance above); the read-only what-next command
// reports the same `missing` set without throwing. Gate outcomes are
// returned, never thrown; invalid input (unknown state/profile, invalid
// transition) still throws, mirroring transition().
export function evaluateTransitionPrecheck({
  snapshot,
  cwd,
  id,
  to,
  requirement,
  context = {},
  clock = () => new Date(),
}) {
  const from = requirement.lifecycle;
  const uxReadiness = to === 'tech_design'
    ? evaluateUxReadiness({ snapshot, cwd, requirement: { ...requirement, id } })
    : null;
  const transitionContext = requirement.deliveryProfile === 'runtime'
    ? runtimeGateContext(snapshot, id, context, clock)
    : context;
  const workflow = evaluateWorkflowReadiness({ snapshot, cwd, requirement: { ...requirement, id }, to,
    currentCommit: context.currentCommit });
  const result = transition({
    profile: requirement.deliveryProfile,
    from,
    to,
    context: {
      ...transitionContext,
      ...(uxReadiness ? { uxMissing: uxReadiness.missing } : {}),
      workflowMissing: workflow.missing,
      hasVersion: Boolean(requirement.version),
      version: requirement.version,
      mergeStatus: requirement.mergeStatus ?? null,
      mergedCommit: requirement.mergedCommit ?? null,
      completionStatus: requirement.completion?.status ?? null,
      isAncestor: (ancestor, descendant) => isAncestor(cwd, ancestor, descendant),
    },
  });
  return {
    ok: result.allowed,
    from,
    to,
    missing: result.failures.map(({ code, message }) => ({
      code,
      message,
      remediation: workflow.missing.find((item) => item.code === code)?.remediation ?? precheckRemediation(code, { id, requirement }),
    })),
    result,
  };
}

function applyAdvance(snapshot, current, from, next, clock) {
  const event = {
    type: 'advance',
    from,
    to: next,
    at: clock().toISOString(),
  };
  snapshot.writeJson(current.path, {
    ...current.requirement,
    lifecycle: next,
    lifecycleHistory: lifecycleHistory(current.requirement, event),
    updatedAt: clock().toISOString(),
  });
}

export async function advanceLifecycle({
  store,
  cwd,
  id,
  to,
  context = {},
  clock = () => new Date(),
}) {
  requirementId(id);
  let from;
  let next;
  const update = await store.update({
    operation: `advance ${id} lifecycle to ${to}`,
    mutate(snapshot) {
      const evaluated = evaluateAdvance({ snapshot, cwd, id, to, context, clock });
      from = evaluated.from;
      if (!evaluated.result.allowed) {
        throw new LifecycleError(`lifecycle gates failed for ${id}: ${from} -> ${to}`, {
          code: 'LIFECYCLE_GATE_FAILED',
          exitCode: 14,
          data: evaluated.result,
        });
      }
      next = evaluated.result.nextState;
      applyAdvance(snapshot, evaluated.current, from, next, clock);
    },
  });

  try {
    const projection = projectBacklog({ cwd, id, from, to: next });
    return {
      id,
      lifecycle: next,
      projection,
      operationId: update.operationId,
      coordinationSha: update.sha,
    };
  } catch (error) {
    throw projectionError(error, {
      id,
      lifecycle: next,
      operationId: update.operationId,
      coordinationSha: update.sha,
    });
  }
}

// I-131 (E5): atomically advance a batch of requirements in a single
// store.update. Every gate failure aborts the whole batch (all-or-nothing)
// and reports per-ID outcomes; BACKLOG rows are projected one by one and the
// caller publishes them in a single commit.
export async function advanceLifecycleBatch({
  store,
  cwd,
  items,
  clock = () => new Date(),
}) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new LifecycleError('lifecycle batch requires at least one requirement', {
      code: 'INVALID_LIFECYCLE_BATCH',
      exitCode: 12,
    });
  }
  const froms = new Map();
  let advanced = [];
  const update = await store.update({
    operation: `batch advance ${items.map(({ id }) => id).join(', ')}`,
    mutate(snapshot) {
      const evaluations = items.map(({ id, to, context }) => ({
        id,
        to,
        ...evaluateAdvance({ snapshot, cwd, id, to, context, clock }),
      }));
      if (evaluations.some(({ result }) => !result.allowed)) {
        throw new LifecycleError(
          `lifecycle batch gates failed for ${
            evaluations.filter(({ result }) => !result.allowed).map(({ id }) => id).join(', ')
          }`,
          {
            code: 'LIFECYCLE_GATE_FAILED',
            exitCode: 14,
            data: {
              results: evaluations.map(({ id, to, from, result }) => ({
                id,
                from,
                to,
                allowed: result.allowed,
                requiredActions: result.requiredActions,
                failures: result.failures,
              })),
            },
          },
        );
      }
      froms.clear();
      advanced = evaluations.map(({ id, current, from, result }) => {
        froms.set(id, from);
        applyAdvance(snapshot, current, from, result.nextState, clock);
        return { id, lifecycle: result.nextState };
      });
    },
  });

  try {
    const results = advanced.map(({ id, lifecycle }) => ({
      id,
      lifecycle,
      projection: projectBacklog({ cwd, id, from: froms.get(id), to: lifecycle }),
    }));
    return {
      results,
      operationId: update.operationId,
      coordinationSha: update.sha,
    };
  } catch (error) {
    // I-131 (review fix): a mid-batch projection failure must name every
    // affected ID and its recovery command, mirroring the single-advance
    // and repository-projection shapes.
    throw projectionError(error, {
      ids: advanced.map(({ id }) => id),
      requiredActions: advanced.map(({ id }) => `pnpm coord reconcile ${id} --json`),
      operationId: update.operationId,
      coordinationSha: update.sha,
    });
  }
}

export async function failLifecycle({
  store,
  cwd,
  id,
  reason,
  evidenceSha,
  clock = () => new Date(),
}) {
  requirementId(id);
  let from;
  const update = await store.update({
    operation: `fail ${id} lifecycle`,
    mutate(snapshot) {
      const current = requirementFromSnapshot(snapshot, id);
      from = current.requirement.lifecycle;
      const result = failTransition({
        profile: current.requirement.deliveryProfile,
        from,
        reason,
        evidenceSha,
      });
      const event = { ...result.event, at: clock().toISOString() };
      snapshot.writeJson(current.path, {
        ...current.requirement,
        lifecycle: result.nextState,
        // I-243 review：失败即代表返工，旧合并事实不再描述新 HEAD。保留它会让
        // Prod Planning 门禁把「旧 merge 覆盖 HEAD」误当成返工后已合并；整组事实
        // 与 mergeStatus 一起清空，由下一次真实合并重新建立。
        ...invalidateWorkflowFacts(snapshot, id, current.requirement, {
          kind: 'correction', reason, instructionRef: `test-evidence:${evidenceSha}`, at: event.at, cwd,
        }),
        lifecycleHistory: lifecycleHistory(current.requirement, event),
        updatedAt: clock().toISOString(),
      });
    },
  });

  try {
    const projection = projectBacklog({ cwd, id, from, to: 'in_dev' });
    return {
      id,
      lifecycle: 'in_dev',
      projection,
      operationId: update.operationId,
      coordinationSha: update.sha,
    };
  } catch (error) {
    throw projectionError(error, {
      id,
      lifecycle: 'in_dev',
      operationId: update.operationId,
      coordinationSha: update.sha,
    });
  }
}

export async function reconcileLifecycle({ store, cwd, id }) {
  requirementId(id);
  const snapshot = await store.readSnapshot();
  const { requirement } = requirementFromSnapshot(snapshot, id);
  const lastEvent = requirement.lifecycleHistory?.at(-1);
  if (!lastEvent || lastEvent.to !== requirement.lifecycle) {
    throw new LifecycleError(`coordination has no replayable lifecycle event for ${id}`, {
      code: 'PROJECTION_UNCERTAIN',
      exitCode: 15,
      data: { id, lifecycle: requirement.lifecycle },
    });
  }
  try {
    const projection = projectBacklog({
      cwd,
      id,
      from: lastEvent.from,
      to: requirement.lifecycle,
    });
    return {
      id,
      lifecycle: requirement.lifecycle,
      reconciled: true,
      projection,
      coordinationSha: snapshot.sha,
    };
  } catch (error) {
    throw projectionError(error, {
      id,
      lifecycle: requirement.lifecycle,
      coordinationSha: snapshot.sha,
    });
  }
}

function runGit(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    throw new LifecycleError('failed to inspect the current Git revision', {
      code: 'GIT_LIFECYCLE_ERROR',
      exitCode: 13,
    });
  }
  return result.stdout.trim();
}

function isAncestor(cwd, ancestor, descendant) {
  return spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
    cwd,
    stdio: ['ignore', 'ignore', 'ignore'],
  }).status === 0;
}

function backlogMigrationAssessment(cwd, id) {
  const lines = readFileSync(join(cwd, 'BACKLOG.md'), 'utf8').split('\n');
  const cells = lines[backlogLineIndex(lines, id)].split('|');
  const assessment = cells[3]?.trim();
  if (!['是', '否', '待评审'].includes(assessment)) {
    throw new LifecycleError(`invalid BACKLOG migration assessment for ${id}: ${assessment}`, {
      code: 'BACKLOG_PROJECTION_CONFLICT',
    });
  }
  return assessment;
}

/**
 * I-118：完成事实校验——需求目录中存在 COMPLETION.json 且 mergedCommit 与 coordination 记录一致。
 * prod_deployed -> done 门禁用它阻止提前推进导致的 completion 死锁。
 */
export function completionFactPresentFromRepository({ cwd, id, mergedCommit }) {
  if (typeof mergedCommit !== 'string' || !/^[0-9a-f]{40}$/.test(mergedCommit)) return false;
  const currentDirectory = join(cwd, 'docs', 'product', 'current');
  const matches = existsSync(currentDirectory)
    ? readdirSync(currentDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${id}-`))
    : [];
  if (matches.length !== 1) return false;
  const completionPath = join(currentDirectory, matches[0].name, 'COMPLETION.json');
  if (!existsSync(completionPath)) return false;
  try {
    const document = JSON.parse(readFileSync(completionPath, 'utf8'));
    return document.schemaVersion === 1
      && document.requirementId === id
      && document.mergedCommit === mergedCommit;
  } catch {
    return false;
  }
}

// Production transitions must fail closed when the committed test evidence is absent or invalid.
function testedCommitFromRepository(cwd, id, version) {
  const currentDirectory = join(cwd, 'docs', 'product', 'current');
  const matches = existsSync(currentDirectory)
    ? readdirSync(currentDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${id}-`))
    : [];
  if (matches.length !== 1) return null;
  const path = join(currentDirectory, matches[0].name, 'TEST_EVIDENCE.json');
  if (!existsSync(path)) return null;
  try {
    const evidence = JSON.parse(readFileSync(path, 'utf8'));
    return evidence?.schemaVersion === 1
      && evidence?.requirement?.id === id
      && evidence.requirement.version === version
      && evidence.requirement.deliveryProfile === 'runtime'
      && evidence.outcome === 'passed'
      && /^[0-9a-f]{40}$/.test(evidence.testedCommit ?? '')
      ? evidence.testedCommit
      : null;
  } catch {
    return null;
  }
}

export function lifecycleContextFromRepository({ cwd, id, version }) {
  const migrationAssessment = backlogMigrationAssessment(cwd, id);
  const requiresMigration = migrationAssessment === '是';
  return {
    hasVersion: Boolean(version),
    hasManifest: Boolean(version) && existsSync(
      join(cwd, 'deploy', 'release-manifests', `${version}.env`),
    ),
    migrationResolved: migrationAssessment !== '待评审',
    requiresMigration,
    hasMigrationDraft: !requiresMigration || existsSync(
      join(cwd, 'docs', 'releases', 'PENDING', `MIGRATION-${id}.md`),
    ),
    hasDevLease: false,
    devSnapshot: null,
    testEvidence: null,
    testedCommit: testedCommitFromRepository(cwd, id, version),
    currentCommit: runGit(cwd, ['rev-parse', 'HEAD']),
  };
}

export function lifecycleEvidenceShaFromRepository({ cwd, id }) {
  requirementId(id);
  const currentDirectory = join(cwd, 'docs', 'product', 'current');
  const matches = existsSync(currentDirectory)
    ? readdirSync(currentDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${id}-`))
    : [];
  if (matches.length !== 1) {
    throw new LifecycleError(
      matches.length === 0
        ? `requirement document directory is missing for ${id}`
        : `multiple requirement document directories found for ${id}`,
      { code: 'TEST_EVIDENCE_NOT_FOUND' },
    );
  }
  const path = join(currentDirectory, matches[0].name, 'TEST_EVIDENCE.json');
  if (!existsSync(path)) {
    throw new LifecycleError(`TEST_EVIDENCE.json is missing for ${id}`, {
      code: 'TEST_EVIDENCE_NOT_FOUND',
    });
  }
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
