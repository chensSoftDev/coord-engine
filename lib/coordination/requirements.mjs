import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  assertDeliveryProfile,
  assertGitRevision,
  assertRequirementId,
  assertVersion,
} from './validation.mjs';
import { parseBacklogRows } from './backlog.mjs';
// I-134 (F8): cancel reuses the lifecycle module's BACKLOG status mapping and
// the exact row-cell rewrite so the 🚫 Cancelled projection can never drift
// from the advance projections.
import { BACKLOG_STATUSES, projectBacklog } from './lifecycle.mjs';
import { classifyChangedPaths } from './path-classifier.mjs';
import { validateTopic } from './worktrees.mjs';

// Backlog parsing is shared (I-128/M9); the local name is kept for the
// existing call sites in this module.
const backlogRows = parseBacklogRows;

const RESOURCE_KEYS = [
  'files',
  'services',
  'databaseTables',
  'configKeys',
  'sharedResources',
];

const BACKLOG_LIFECYCLES = Object.freeze({
  '⚪ Todo': 'todo',
  '🔍 Reviewing': 'reviewing',
  '📝 Req Confirmed': 'req_confirmed',
  '🧩 Tech Design': 'tech_design',
  '🔨 In Dev': 'in_dev',
  '🚚 Dev Deployed': 'dev_deployed',
  '🧪 Testing': 'testing',
  '✅ Test Passed': 'test_passed',
  '📋 Prod Planning': 'prod_planning',
  '🚀 Prod Deployed': 'prod_deployed',
  '✔️ Done': 'done',
  '🚫 Cancelled': 'cancelled',
});

export class RequirementError extends Error {
  constructor(message, { code, exitCode = 14, data = {} }) {
    super(message);
    this.name = 'RequirementError';
    this.code = code;
    this.exitCode = exitCode;
    this.data = data;
  }
}

function validateRequirementId(id) {
  try {
    return assertRequirementId(id);
  } catch (error) {
    throw new RequirementError(error.message, { code: 'INVALID_REQUIREMENT_ID' });
  }
}

function validateVersion(version) {
  try {
    return assertVersion(version);
  } catch (error) {
    throw new RequirementError(error.message, { code: 'INVALID_VERSION' });
  }
}

function validateDeliveryProfile(profile) {
  try {
    return assertDeliveryProfile(profile);
  } catch (error) {
    throw new RequirementError(error.message, { code: 'INVALID_DELIVERY_PROFILE' });
  }
}

function requirementPath(id) {
  return `requirements/${validateRequirementId(id)}.json`;
}

function versionPath(version) {
  return `versions/${validateVersion(version)}.json`;
}

export function requirementDocuments(snapshot) {
  return snapshot.paths()
    .filter((path) => /^requirements\/(I|F|B)-\d{3,}\.json$/.test(path))
    .map((path) => snapshot.readJson(path))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function versionDocuments(snapshot) {
  return snapshot.paths()
    .filter((path) => /^versions\/v\d+\.\d+\.\d+\.json$/.test(path))
    .map((path) => snapshot.readJson(path))
    .sort((left, right) => left.version.localeCompare(right.version));
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
    throw new RequirementError(`git ${args.join(' ')} failed: ${message.trim()}`, {
      code: 'RECONCILE_GIT_ERROR',
      exitCode: 13,
    });
  }
  return result.stdout.trim();
}

function resolvedCommit(cwd, value) {
  try {
    assertGitRevision(value);
  } catch (error) {
    throw new RequirementError(error.message, { code: 'INVALID_GIT_REVISION' });
  }
  return runGit(cwd, ['rev-parse', '--verify', `${value}^{commit}`]);
}

function firstParent(cwd, commit) {
  const fields = runGit(cwd, ['rev-list', '--parents', '-n', '1', commit]).split(' ');
  if (fields.length < 2) {
    throw new RequirementError('cannot reconcile a root commit without an explicit base', {
      code: 'RECONCILE_BASE_REQUIRED',
    });
  }
  return fields[1];
}

function textAt(cwd, commit, path) {
  const result = runGitResult(cwd, ['show', `${commit}:${path}`]);
  return result.status === 0 ? result.stdout : null;
}


function requirementsFromManifest(source) {
  const declaration = (source ?? '').split(/\r?\n/)
    .find((line) => line.startsWith('RELEASE_REQUIREMENTS='));
  return declaration
    ? declaration.slice('RELEASE_REQUIREMENTS='.length).split(',').filter(Boolean)
    : [];
}

function changedCommitContext({ cwd, commit, base }) {
  const target = resolvedCommit(cwd, commit);
  const comparisonBase = base ? resolvedCommit(cwd, base) : firstParent(cwd, target);
  const changedPaths = runGit(cwd, ['diff', '--name-only', comparisonBase, target])
    .split('\n').filter(Boolean);
  const baseRows = backlogRows(textAt(cwd, comparisonBase, 'BACKLOG.md'));
  const headRows = backlogRows(textAt(cwd, target, 'BACKLOG.md'));
  const ids = new Set([...baseRows.keys(), ...headRows.keys()].filter((id) => (
    baseRows.get(id)?.line !== headRows.get(id)?.line
  )));
  const completionIds = new Set();
  for (const path of changedPaths) {
    const docs = /^docs\/product\/current\/((?:I|F|B)-\d{3,})-/.exec(path);
    if (docs) ids.add(docs[1]);
    const completion = /^docs\/product\/current\/((?:I|F|B)-\d{3,})-[^/]+\/COMPLETION\.json$/.exec(path);
    if (completion) completionIds.add(completion[1]);
    if (/^deploy\/release-manifests\/v\d+\.\d+\.\d+\.env$/.test(path)) {
      for (const id of requirementsFromManifest(textAt(cwd, target, path))) ids.add(id);
    }
  }
  const message = runGit(cwd, ['show', '-s', '--format=%B', target]);
  for (const match of message.matchAll(/\[coord-completion:((?:I|F|B)-\d{3,})\]/g)) {
    ids.add(match[1]);
    completionIds.add(match[1]);
  }
  return {
    commit: target,
    base: comparisonBase,
    changedPaths,
    baseRows,
    headRows,
    ids: [...ids].sort(),
    completionIds,
  };
}

function completionEvidencePath({ cwd, commit, id }) {
  const paths = runGit(cwd, [
    'ls-tree', '-r', '--name-only', commit, '--', 'docs/product/current',
  ]).split('\n').filter(Boolean);
  const directories = [...new Set(paths.map((path) => (
    new RegExp(`^(docs/product/current/${id.replace('-', '\\-')}-[^/]+)/`).exec(path)?.[1]
  )).filter(Boolean))];
  if (directories.length !== 1) {
    throw new RequirementError(`expected exactly one requirement directory for ${id}`, {
      code: 'REQUIREMENT_DOCUMENTS_MISSING',
      data: { requirementId: id, directories },
    });
  }
  return `${directories[0]}/COMPLETION.json`;
}

function completionPlan({
  cwd,
  commit,
  id,
  requirement,
  row,
  clock,
  allowedStatuses = new Set(['✅ Test Passed']),
}) {
  if (!row || !allowedStatuses.has(row.status)) {
    throw new RequirementError(`${id} is not at a valid completion source status`, {
      code: 'COMPLETION_BACKLOG_INVALID',
      data: { requirementId: id, status: row?.status ?? null },
    });
  }
  const after = row.line.replace(`| ${row.status} |`, '| ✔️ Done |');
  if (after === row.line) {
    throw new RequirementError(`cannot construct the exact completion row for ${id}`, {
      code: 'COMPLETION_BACKLOG_INVALID',
    });
  }
  const path = completionEvidencePath({ cwd, commit, id });
  return {
    requirementId: id,
    deliveryProfile: requirement.deliveryProfile,
    backlog: {
      path: 'BACKLOG.md',
      before: row.line,
      after,
    },
    evidence: {
      path,
      document: {
        schemaVersion: 1,
        requirementId: id,
        deliveryProfile: requirement.deliveryProfile,
        mergedCommit: commit,
        generatedAt: clock().toISOString(),
      },
    },
  };
}

function numbersFromBacklog(backlogText) {
  const numbers = [];
  const pattern = /\|\s*(?:I|F|B)-(\d{3,})\s*\|/g;
  for (const match of backlogText.matchAll(pattern)) {
    numbers.push(Number.parseInt(match[1], 10));
  }
  return numbers;
}

export function nextRequirementId({ type, backlogText, snapshot }) {
  if (!/^(I|F|B)$/.test(type ?? '')) {
    throw new RequirementError(`invalid requirement type: ${type ?? '<missing>'}`, {
      code: 'INVALID_REQUIREMENT_TYPE',
    });
  }
  const numbers = [
    ...numbersFromBacklog(backlogText ?? ''),
    ...requirementDocuments(snapshot).map(({ id }) => Number.parseInt(id.slice(2), 10)),
  ];
  const next = (numbers.length > 0 ? Math.max(...numbers) : 0) + 1;
  return `${type}-${String(next).padStart(3, '0')}`;
}

function normalizeTitle(title) {
  const normalized = typeof title === 'string' ? title.trim() : '';
  if (normalized.length === 0 || normalized.length > 200) {
    throw new RequirementError('requirement title must be between 1 and 200 characters', {
      code: 'INVALID_REQUIREMENT_TITLE',
    });
  }
  return normalized;
}

function normalizeBranch(branch) {
  try {
    assertGitRevision(branch);
  } catch (error) {
    throw new RequirementError(error.message, { code: 'INVALID_REQUIREMENT_BRANCH' });
  }
  if (branch === 'HEAD' || /^[0-9a-f]{7,40}$/.test(branch)) {
    throw new RequirementError(`requirement branch must be a named ref: ${branch}`, {
      code: 'INVALID_REQUIREMENT_BRANCH',
    });
  }
  return branch;
}

function emptyResources() {
  return Object.fromEntries(RESOURCE_KEYS.map((key) => [key, []]));
}

const UX_IMPACTS = new Set(['admin-ui', 'none']);

function normalizeUxImpact(value) {
  // Existing programmatic fixtures and requirements created before I-240
  // have no impact attribute. Production CLI entry points require it.
  if (value === undefined) return undefined;
  if (!UX_IMPACTS.has(value)) {
    throw new RequirementError(`invalid UX impact: ${value ?? '<missing>'}`, {
      code: 'INVALID_UX_IMPACT', exitCode: 12,
    });
  }
  return value;
}

export async function claimRequirement({
  store,
  type,
  title,
  profile,
  uxImpact,
  workflowVersion,
  backlogText,
  owner = {},
}) {
  const normalizedTitle = normalizeTitle(title);
  const deliveryProfile = validateDeliveryProfile(profile);
  const normalizedUxImpact = normalizeUxImpact(uxImpact);
  let claimedId;
  const result = await store.update({
    operation: `claim ${type} requirement`,
    async mutate(snapshot) {
      claimedId = nextRequirementId({ type, backlogText, snapshot });
      snapshot.writeJson(requirementPath(claimedId), {
        schemaVersion: 1,
        id: claimedId,
        title: normalizedTitle,
        deliveryProfile,
        ...(normalizedUxImpact ? { uxImpact: normalizedUxImpact } : {}),
        ...(workflowVersion === 2 ? { workflowVersion: 2, workflowEpoch: 0, validationEpoch: 0 } : {}),
        lifecycle: 'todo',
        version: null,
        owner: {
          sessionId: owner.sessionId ?? null,
          agent: owner.agent ?? 'unknown',
          user: owner.user ?? 'unknown',
          host: owner.host ?? 'unknown',
        },
        branch: null,
        resources: emptyResources(),
        dependsOn: [],
        createdAt: store.clock().toISOString(),
        updatedAt: store.clock().toISOString(),
      });
    },
  });
  return { id: claimedId, ...result };
}

// I-130 (D3): one-shot requirement start — atomically allocates the id,
// writes the requirement JSON (including the declared migrationAssessment),
// binds the version (exact, bump, or join) with registry membership, and binds
// the derived feature branch. The worktree + BACKLOG row are created
// afterwards by createRequirementWorktree; admin UI starts at todo while
// requirements with no admin UX impact retain the in_dev shortcut.
const MIGRATION_ASSESSMENTS = Object.freeze({ yes: '是', no: '否' });

export async function startRequirement({
  store,
  type,
  title,
  profile,
  uxImpact,
  workflowVersion,
  topic,
  migration,
  version,
  bump,
  joinVersion,
  backlogText,
  owner = {},
}) {
  const normalizedTitle = normalizeTitle(title);
  const deliveryProfile = validateDeliveryProfile(profile);
  const normalizedUxImpact = normalizeUxImpact(uxImpact);
  const worktreeTopic = validateTopic(topic);
  const migrationAssessment = MIGRATION_ASSESSMENTS[migration];
  if (!migrationAssessment) {
    throw new RequirementError(
      `invalid migration assessment: ${migration ?? '<missing>'} (expected yes or no)`,
      { code: 'INVALID_MIGRATION_ASSESSMENT' },
    );
  }
  const modes = [version, bump, joinVersion].filter((value) => value !== undefined);
  if (modes.length !== 1) {
    throw new RequirementError(
      'start requires exactly one of version, bump, or joinVersion',
      { code: 'INVALID_VERSION_OPTIONS' },
    );
  }
  if (version !== undefined) validateVersion(version);
  if (bump !== undefined && !VERSION_BUMPS.has(bump)) {
    throw new RequirementError(`invalid version bump: ${bump}`, { code: 'INVALID_VERSION_BUMP' });
  }
  if (joinVersion !== undefined) validateVersion(joinVersion);

  let started;
  const result = await store.update({
    operation: `start ${type} requirement`,
    mutate(snapshot) {
      const id = nextRequirementId({ type, backlogText, snapshot });
      let target = version;
      if (bump !== undefined) {
        target = bumpVersion(highestRegisteredVersion(snapshot), bump);
      } else if (joinVersion !== undefined) {
        if (!snapshot.has(versionPath(joinVersion))) {
          throw new RequirementError(`version is not registered: ${joinVersion}`, {
            code: 'VERSION_NOT_FOUND',
            exitCode: 12,
          });
        }
        target = joinVersion;
      }
      const branch = `feature/${target}/${worktreeTopic}`;
      const now = store.clock().toISOString();
      const initialLifecycle = normalizedUxImpact === 'admin-ui' ? 'todo' : 'in_dev';
      snapshot.writeJson(requirementPath(id), {
        schemaVersion: 1,
        id,
        title: normalizedTitle,
        deliveryProfile,
        ...(normalizedUxImpact ? { uxImpact: normalizedUxImpact } : {}),
        ...(workflowVersion === 2 ? { workflowVersion: 2, workflowEpoch: 0, validationEpoch: 0 } : {}),
        // The history records the actual start state, without fabricated
        // per-state advances. Admin UI must pass its UX review first.
        lifecycle: initialLifecycle,
        lifecycleHistory: [{
          type: 'start',
          from: null,
          to: initialLifecycle,
          at: now,
          actor: owner.agent ?? 'unknown',
        }],
        version: target,
        migrationAssessment,
        owner: {
          sessionId: owner.sessionId ?? null,
          agent: owner.agent ?? 'unknown',
          user: owner.user ?? 'unknown',
          host: owner.host ?? 'unknown',
        },
        branch,
        resources: emptyResources(),
        dependsOn: [],
        createdAt: now,
        updatedAt: now,
      });
      registerVersionMembership(snapshot, id, target);
      started = { id, version: target, branch, migrationAssessment, lifecycle: initialLifecycle,
        ...(normalizedUxImpact ? { uxImpact: normalizedUxImpact } : {}) };
    },
  });
  return { ...started, ...result };
}

export async function setRequirementUxImpact({ store, id, uxImpact, reason, actor = 'unknown' }) {
  const requirementId = validateRequirementId(id);
  if (uxImpact !== 'admin-ui') {
    throw new RequirementError('UX impact can only be upgraded to admin-ui', {
      code: 'UX_IMPACT_DOWNGRADE_FORBIDDEN', exitCode: 12,
    });
  }
  if (typeof reason !== 'string' || reason.trim().length < 10 || reason.includes('\n')) {
    throw new RequirementError('a single-line reason of at least 10 characters is required', {
      code: 'INVALID_UX_IMPACT_REASON', exitCode: 12,
    });
  }
  const normalizedReason = reason.trim();
  const result = await store.update({
    operation: `upgrade UX impact ${requirementId}`,
    auditData: { requirementId, uxImpact, reason: normalizedReason },
    mutate(snapshot) {
      const path = requirementPath(requirementId);
      if (!snapshot.has(path)) throw missingRequirement(requirementId);
      const fact = snapshot.readJson(path);
      if (fact.uxImpact !== 'none') {
        throw new RequirementError('only a new none declaration can be upgraded', {
          code: 'UX_IMPACT_UPGRADE_NOT_ALLOWED', exitCode: 14,
        });
      }
      const now = store.clock().toISOString();
      fact.uxImpact = uxImpact;
      fact.uxImpactHistory = [...(fact.uxImpactHistory ?? []), {
        from: 'none', to: uxImpact, reason: normalizedReason, actor, at: now,
      }];
      fact.updatedAt = now;
      snapshot.writeJson(path, fact);
    },
  });
  return { id: requirementId, uxImpact, ...result };
}

// I-243 review: the profile upgrade is a governance fact, so the audit record
// and history carry the same owner identity the rest of the coordination
// surface derives from ownerFromEnvironment (agent + session). The CLI handler
// passes that object; library callers may omit it in tests.
function profileActor(actor) {
  return {
    agent: (actor && typeof actor === 'object' && actor.agent) || 'unknown',
    sessionId: (actor && typeof actor === 'object' && actor.sessionId) || null,
  };
}

export async function setRequirementProfile({ store, id, profile, reason, actor = {} }) {
  const requirementId = validateRequirementId(id);
  const auditActor = profileActor(actor);
  if (profile !== 'runtime') {
    throw new RequirementError('delivery profile can only be upgraded to runtime', {
      code: 'PROFILE_CHANGE_NOT_ALLOWED', exitCode: 12,
    });
  }
  if (typeof reason !== 'string' || reason.trim().length < 10 || /[\r\n]/.test(reason)) {
    throw new RequirementError('a single-line reason of at least 10 characters is required', {
      code: 'INVALID_PROFILE_REASON', exitCode: 12,
    });
  }
  const normalizedReason = reason.trim();
  const result = await store.update({
    operation: `upgrade delivery profile ${requirementId}`,
    auditData: {
      requirementId,
      deliveryProfile: profile,
      reason: normalizedReason,
      actor: auditActor.agent,
      sessionId: auditActor.sessionId,
    },
    mutate(snapshot) {
      const path = requirementPath(requirementId);
      if (!snapshot.has(path)) throw missingRequirement(requirementId);
      const fact = snapshot.readJson(path);
      // A repeated correction is an explicit error, never a silent no-op:
      // the operator must see that the profile already changed.
      if (fact.deliveryProfile === profile) {
        throw new RequirementError(`${requirementId} already uses delivery profile ${profile}`, {
          code: 'PROFILE_ALREADY_RUNTIME', exitCode: 14,
        });
      }
      // Legacy/imported requirements predate the explicit UX declaration and
      // are UX-exempt in evaluateUxReadiness. Upgrading one to runtime would
      // let it skip the admin UX gate forever, so it must declare uxImpact
      // (admin-ui|none) before the delivery profile can change.
      if (!['none', 'admin-ui'].includes(fact.uxImpact)) {
        throw new RequirementError(
          'requirement must declare uxImpact (admin-ui|none) before upgrading to runtime',
          { code: 'PROFILE_UX_IMPACT_UNDECLARED', exitCode: 14 },
        );
      }
      if (
        !['governance', 'tooling'].includes(fact.deliveryProfile)
        || fact.lifecycle !== 'in_dev'
        || fact.mergeStatus != null
        || fact.mergedCommit != null
      ) {
        throw new RequirementError(
          'only an unmerged in-dev governance or tooling requirement can upgrade to runtime',
          { code: 'PROFILE_STATE_NOT_ALLOWED', exitCode: 14 },
        );
      }
      const now = store.clock().toISOString();
      fact.profileHistory = [...(fact.profileHistory ?? []), {
        from: fact.deliveryProfile,
        to: profile,
        reason: normalizedReason,
        actor: auditActor.agent,
        sessionId: auditActor.sessionId,
        at: now,
      }];
      fact.deliveryProfile = profile;
      fact.updatedAt = now;
      snapshot.writeJson(path, fact);
    },
  });
  return { id: requirementId, deliveryProfile: profile, ...result };
}

// I-243 review：migrationAssessment 与 resources.databaseTables 是需求事实，
// start 之后仍可能被证实写错（例如后补 schema 迁移）。两个纠正命令都要求
// 单行原因，写入 operation 审计与需求内历史；终态（merged/done/cancelled）
// 的需求事实不可再改，避免已收尾事实被追溯改写。
const TERMINAL_REQUIREMENT_LIFECYCLES = new Set(['merged', 'done', 'cancelled']);
const DATABASE_TABLE_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

function validateAuditReason(reason, code) {
  if (typeof reason !== 'string' || reason.trim().length < 10 || /[\r\n]/.test(reason)) {
    throw new RequirementError('a single-line reason of at least 10 characters is required', {
      code, exitCode: 12,
    });
  }
  return reason.trim();
}

function assertCorrectableLifecycle(requirementId, fact, code) {
  if (TERMINAL_REQUIREMENT_LIFECYCLES.has(fact.lifecycle)) {
    throw new RequirementError(
      `${requirementId} is ${fact.lifecycle}; requirement facts cannot change after the terminal state`,
      { code, exitCode: 14 },
    );
  }
}

function normalizeDatabaseTables(tables) {
  if (!Array.isArray(tables) || tables.length === 0) {
    throw new RequirementError('at least one database table is required', {
      code: 'INVALID_DATABASE_TABLES', exitCode: 12,
    });
  }
  const normalized = sortedUnique(tables.map((table) => (
    typeof table === 'string' ? table.trim() : ''
  )));
  const invalid = normalized.filter((table) => !DATABASE_TABLE_NAME_PATTERN.test(table));
  if (invalid.length > 0) {
    throw new RequirementError(
      `invalid database table name(s): ${invalid.map((table) => table || '<empty>').join(', ')}`,
      { code: 'INVALID_DATABASE_TABLES', exitCode: 12 },
    );
  }
  return normalized;
}

export async function setRequirementMigration({
  store,
  id,
  migration,
  reason,
  actor = {},
}) {
  const requirementId = validateRequirementId(id);
  const auditActor = profileActor(actor);
  const migrationAssessment = MIGRATION_ASSESSMENTS[migration];
  if (!migrationAssessment) {
    throw new RequirementError(
      `invalid migration assessment: ${migration ?? '<missing>'} (expected yes or no)`,
      { code: 'INVALID_MIGRATION_ASSESSMENT', exitCode: 12 },
    );
  }
  const normalizedReason = validateAuditReason(reason, 'INVALID_MIGRATION_REASON');
  const result = await store.update({
    operation: `set migration assessment ${requirementId}`,
    auditData: {
      requirementId,
      migrationAssessment,
      reason: normalizedReason,
      actor: auditActor.agent,
      sessionId: auditActor.sessionId,
    },
    mutate(snapshot) {
      const path = requirementPath(requirementId);
      if (!snapshot.has(path)) throw missingRequirement(requirementId);
      const fact = snapshot.readJson(path);
      assertCorrectableLifecycle(requirementId, fact, 'MIGRATION_STATE_NOT_ALLOWED');
      // A repeated correction is an explicit error, never a silent no-op:
      // the operator must see that the recorded fact already matches.
      if (fact.migrationAssessment === migrationAssessment) {
        throw new RequirementError(
          `${requirementId} already declares migration assessment ${migrationAssessment}`,
          { code: 'MIGRATION_ALREADY_SET', exitCode: 14 },
        );
      }
      const now = store.clock().toISOString();
      fact.migrationAssessmentHistory = [
        ...(fact.migrationAssessmentHistory ?? []),
        {
          from: fact.migrationAssessment ?? null,
          to: migrationAssessment,
          reason: normalizedReason,
          actor: auditActor.agent,
          sessionId: auditActor.sessionId,
          at: now,
        },
      ];
      fact.migrationAssessment = migrationAssessment;
      fact.updatedAt = now;
      snapshot.writeJson(path, fact);
    },
  });
  return { id: requirementId, migrationAssessment, ...result };
}

export async function setRequirementDatabaseTables({
  store,
  id,
  tables,
  reason,
  actor = {},
}) {
  const requirementId = validateRequirementId(id);
  const auditActor = profileActor(actor);
  const normalizedTables = normalizeDatabaseTables(tables);
  const normalizedReason = validateAuditReason(reason, 'INVALID_DATABASE_TABLES_REASON');
  let previousTables = [];
  const result = await store.update({
    operation: `set database tables ${requirementId}`,
    auditData: {
      requirementId,
      databaseTables: normalizedTables,
      reason: normalizedReason,
      actor: auditActor.agent,
      sessionId: auditActor.sessionId,
    },
    mutate(snapshot) {
      const path = requirementPath(requirementId);
      if (!snapshot.has(path)) throw missingRequirement(requirementId);
      const fact = snapshot.readJson(path);
      assertCorrectableLifecycle(requirementId, fact, 'DATABASE_TABLES_STATE_NOT_ALLOWED');
      previousTables = [...(fact.resources?.databaseTables ?? [])];
      if (
        previousTables.length === normalizedTables.length
        && previousTables.every((table, index) => table === normalizedTables[index])
      ) {
        throw new RequirementError(
          `${requirementId} already declares database tables: ${normalizedTables.join(', ')}`,
          { code: 'DATABASE_TABLES_UNCHANGED', exitCode: 14 },
        );
      }
      const now = store.clock().toISOString();
      fact.resources = {
        ...emptyResources(),
        ...(fact.resources ?? {}),
        databaseTables: normalizedTables,
      };
      fact.databaseTablesHistory = [
        ...(fact.databaseTablesHistory ?? []),
        {
          from: previousTables,
          to: normalizedTables,
          reason: normalizedReason,
          actor: auditActor.agent,
          sessionId: auditActor.sessionId,
          at: now,
        },
      ];
      fact.updatedAt = now;
      snapshot.writeJson(path, fact);
    },
  });
  return { id: requirementId, databaseTables: normalizedTables, previousTables, ...result };
}

/**
 * I-243 review：已合并需求的返工事实纠正。
 *
 * `lifecycle fail` 现在会清空 merge 事实，但历史记录（或在修复前已 fail 的记录）
 * 仍可能保留旧 mergedCommit。该命令提供受审计的纠正入口：只允许在非终态使用，
 * 清空 mergeStatus/mergedCommit/mergedAt，并在 mergeHistory 中保留旧值。
 */
export async function clearRequirementMerge({ store, id, reason, actor = {} }) {
  const requirementId = validateRequirementId(id);
  const auditActor = profileActor(actor);
  const normalizedReason = validateAuditReason(reason, 'INVALID_MERGE_REASON');
  let previous = null;
  const result = await store.update({
    operation: `clear merge fact ${requirementId}`,
    auditData: {
      requirementId,
      reason: normalizedReason,
      actor: auditActor.agent,
      sessionId: auditActor.sessionId,
    },
    mutate(snapshot) {
      const path = requirementPath(requirementId);
      if (!snapshot.has(path)) throw missingRequirement(requirementId);
      const fact = snapshot.readJson(path);
      assertCorrectableLifecycle(requirementId, fact, 'MERGE_STATE_NOT_ALLOWED');
      if (!fact.mergedCommit && fact.mergeStatus !== 'merged') {
        throw new RequirementError(
          `${requirementId} has no merge fact to clear`,
          { code: 'MERGE_FACT_ABSENT', exitCode: 14 },
        );
      }
      previous = {
        mergeStatus: fact.mergeStatus ?? null,
        mergedCommit: fact.mergedCommit ?? null,
        mergedAt: fact.mergedAt ?? null,
      };
      const now = store.clock().toISOString();
      fact.mergeStatus = null;
      fact.mergedCommit = null;
      fact.mergedAt = null;
      fact.mergeHistory = [
        ...(fact.mergeHistory ?? []),
        { from: previous, to: null, reason: normalizedReason, actor: auditActor.agent, sessionId: auditActor.sessionId, at: now },
      ];
      fact.updatedAt = now;
      snapshot.writeJson(path, fact);
    },
  });
  return { id: requirementId, previousMerge: previous, ...result };
}

export async function importExistingRequirement({
  store,
  id,
  profile,
  branch,
  backlogText,
  owner = {},
}) {
  const requirementId = validateRequirementId(id);
  const deliveryProfile = validateDeliveryProfile(profile);
  const requirementBranch = normalizeBranch(branch);
  const currentRow = backlogRows(backlogText).get(requirementId);
  if (!currentRow) {
    throw new RequirementError(`BACKLOG row is missing for ${requirementId}`, {
      code: 'REQUIREMENT_NOT_IN_BACKLOG',
    });
  }
  const lifecycle = BACKLOG_LIFECYCLES[currentRow.status];
  if (!lifecycle) {
    throw new RequirementError(`unsupported BACKLOG status for ${requirementId}: ${currentRow.status}`, {
      code: 'INVALID_REQUIREMENT_LIFECYCLE',
    });
  }
  const version = currentRow.version === '-' ? null : validateVersion(currentRow.version);
  if (!version && !['todo', 'reviewing'].includes(lifecycle)) {
    throw new RequirementError(`${requirementId} must have a Version before import`, {
      code: 'INVALID_VERSION',
    });
  }

  const result = await store.update({
    operation: `import existing requirement ${requirementId}`,
    mutate(snapshot) {
      const path = requirementPath(requirementId);
      if (snapshot.has(path)) {
        throw new RequirementError(`requirement is already coordinated: ${requirementId}`, {
          code: 'REQUIREMENT_ALREADY_CLAIMED',
        });
      }
      if (
        !snapshot.has('baseline/BACKLOG.md')
        || !backlogRows(snapshot.readText('baseline/BACKLOG.md')).has(requirementId)
      ) {
        throw new RequirementError(
          `${requirementId} was not present in the coordination initialization baseline`,
          { code: 'REQUIREMENT_NOT_IN_BASELINE' },
        );
      }

      const now = store.clock().toISOString();
      snapshot.writeJson(path, {
        schemaVersion: 1,
        id: requirementId,
        title: normalizeTitle(currentRow.title),
        deliveryProfile,
        lifecycle,
        version,
        owner: {
          sessionId: owner.sessionId ?? null,
          agent: owner.agent ?? 'unknown',
          user: owner.user ?? 'unknown',
          host: owner.host ?? 'unknown',
        },
        branch: requirementBranch,
        resources: emptyResources(),
        dependsOn: [],
        lifecycleHistory: [{
          type: 'import',
          from: null,
          to: lifecycle,
          at: now,
        }],
        importedFromBaseline: true,
        createdAt: now,
        updatedAt: now,
      });

      if (version) {
        registerVersionMembership(snapshot, requirementId, version);
      }
    },
  });
  return {
    id: requirementId,
    lifecycle,
    version,
    branch: requirementBranch,
    ...result,
  };
}

function missingRequirement(id) {
  return new RequirementError(`requirement is not claimed: ${id}`, {
    code: 'REQUIREMENT_NOT_FOUND',
  });
}

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

// I-130 (D2): the versions/ registry is enumerated and compared numerically
// (v0.10.0 > v0.9.9) — lexicographic ordering would pick the wrong maximum.
const VERSION_TRIPLES_PATTERN = /^v(\d+)\.(\d+)\.(\d+)$/;
const VERSION_BUMPS = new Set(['major', 'minor', 'patch']);

function versionTriples(version) {
  return VERSION_TRIPLES_PATTERN.exec(version).slice(1).map(Number);
}

function compareVersions(left, right) {
  const [leftMajor, leftMinor, leftPatch] = versionTriples(left);
  const [rightMajor, rightMinor, rightPatch] = versionTriples(right);
  return (leftMajor - rightMajor) || (leftMinor - rightMinor) || (leftPatch - rightPatch);
}

export function highestRegisteredVersion(snapshot) {
  return snapshot.paths()
    .map((path) => /^versions\/(v\d+\.\d+\.\d+)\.json$/.exec(path)?.[1])
    .filter(Boolean)
    .sort(compareVersions)
    .at(-1) ?? null;
}

// An empty registry bumps from the v0.0.0 floor: patch -> v0.0.1,
// minor -> v0.1.0, major -> v1.0.0.
export function bumpVersion(version, bump) {
  if (!VERSION_BUMPS.has(bump ?? '')) {
    throw new RequirementError(`invalid version bump: ${bump ?? '<missing>'}`, {
      code: 'INVALID_VERSION_BUMP',
    });
  }
  const [major, minor, patch] = version === null || version === undefined
    ? [0, 0, 0]
    : versionTriples(validateVersion(version));
  if (bump === 'major') return `v${major + 1}.0.0`;
  if (bump === 'minor') return `v${major}.${minor + 1}.0`;
  return `v${major}.${minor}.${patch + 1}`;
}

// I-130 (D2): single write point for versions/<version>.json membership —
// every version binding path (exact, bump, join, import) goes through here.
export function registerVersionMembership(snapshot, id, version) {
  const targetPath = versionPath(version);
  const targetVersion = snapshot.has(targetPath)
    ? snapshot.readJson(targetPath)
    : { schemaVersion: 1, version: validateVersion(version), requirements: [] };
  targetVersion.requirements = sortedUnique([
    ...targetVersion.requirements,
    validateRequirementId(id),
  ]);
  snapshot.writeJson(targetPath, targetVersion);
}

// Bind (or, with force, rebind) the requirement to a feature branch. A
// conflicting rebind without force fails closed so coordination state can
// never silently drift; the explicit force path is used when multiple
// requirements are merged onto one branch and must share the gate identity.
export async function bindRequirementBranch({ store, id, branch, force = false }) {
  validateRequirementId(id);
  const requirementBranch = normalizeBranch(branch);
  const result = await store.update({
    operation: `bind ${id} to branch ${requirementBranch}`,
    mutate(snapshot) {
      const path = requirementPath(id);
      if (!snapshot.has(path)) throw missingRequirement(id);
      const requirement = snapshot.readJson(path);
      if (requirement.branch && requirement.branch !== requirementBranch && !force) {
        throw new RequirementError(
          `${id} is already bound to ${requirement.branch}`,
          {
            code: 'BRANCH_ALREADY_BOUND',
            data: { currentBranch: requirement.branch, requestedBranch: requirementBranch },
          },
        );
      }
      snapshot.writeJson(path, {
        ...requirement,
        branch: requirementBranch,
        updatedAt: store.clock().toISOString(),
      });
    },
  });
  return { id, branch: requirementBranch, ...result };
}

// I-130 (D2): three mutually exclusive binding modes — an exact version, a
// semver bump computed from the highest registered version, or joining an
// already registered version. All modes share the same registry write point.
export async function bindRequirementVersion({
  store,
  id,
  version,
  bump,
  joinVersion,
  force = false,
}) {
  validateRequirementId(id);
  const modes = [version, bump, joinVersion].filter((value) => value !== undefined);
  if (modes.length !== 1) {
    throw new RequirementError(
      'bind-version requires exactly one of version, bump, or joinVersion',
      { code: 'INVALID_VERSION_OPTIONS' },
    );
  }
  if (version !== undefined) validateVersion(version);
  if (bump !== undefined && !VERSION_BUMPS.has(bump)) {
    throw new RequirementError(`invalid version bump: ${bump}`, { code: 'INVALID_VERSION_BUMP' });
  }
  if (joinVersion !== undefined) validateVersion(joinVersion);
  let boundVersion;
  const result = await store.update({
    operation: `bind ${id} to a release version`,
    mutate(snapshot) {
      const path = requirementPath(id);
      if (!snapshot.has(path)) throw missingRequirement(id);
      let target = version;
      if (bump !== undefined) {
        target = bumpVersion(highestRegisteredVersion(snapshot), bump);
      } else if (joinVersion !== undefined) {
        if (!snapshot.has(versionPath(joinVersion))) {
          throw new RequirementError(`version is not registered: ${joinVersion}`, {
            code: 'VERSION_NOT_FOUND',
            exitCode: 12,
          });
        }
        target = joinVersion;
      }
      const requirement = snapshot.readJson(path);
      if (requirement.version && requirement.version !== target && !force) {
        throw new RequirementError(
          `${id} is already bound to ${requirement.version}`,
          {
            code: 'VERSION_ALREADY_BOUND',
            data: { currentVersion: requirement.version, requestedVersion: target },
          },
        );
      }

      if (requirement.version && requirement.version !== target) {
        const oldPath = versionPath(requirement.version);
        if (snapshot.has(oldPath)) {
          const oldVersion = snapshot.readJson(oldPath);
          oldVersion.requirements = oldVersion.requirements.filter((item) => item !== id);
          snapshot.writeJson(oldPath, oldVersion);
        }
      }

      registerVersionMembership(snapshot, id, target);
      snapshot.writeJson(path, {
        ...requirement,
        version: target,
        updatedAt: store.clock().toISOString(),
      });
      boundVersion = target;
    },
  });
  return { id, version: boundVersion, ...result };
}

function normalizeResources(resources = {}) {
  return Object.fromEntries(RESOURCE_KEYS.map((key) => {
    const values = resources[key] ?? [];
    if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
      throw new RequirementError(`resource ${key} must be a string array`, {
        code: 'INVALID_RESOURCES',
      });
    }
    return [key, sortedUnique(values.map((value) => value.trim()).filter(Boolean))];
  }));
}

function globPrefix(value) {
  return value.endsWith('/**') ? value.slice(0, -3) : null;
}

export function resourceValuesOverlap(left, right) {
  if (left === right) return true;
  const leftPrefix = globPrefix(left);
  const rightPrefix = globPrefix(right);
  return (leftPrefix !== null && (right === leftPrefix || right.startsWith(`${leftPrefix}/`)))
    || (rightPrefix !== null && (left === rightPrefix || left.startsWith(`${rightPrefix}/`)));
}

function overlappingValues(leftValues, rightValues) {
  return leftValues.filter((left) => (
    rightValues.some((right) => resourceValuesOverlap(left, right))
  ));
}

const COORDINATION_PROJECTION_FILES = new Set(['BACKLOG.md']);

export function resourceValueCoversPath(pattern, path) {
  if (pattern === path) return true;
  const prefix = globPrefix(pattern);
  return prefix !== null && (path === prefix || path.startsWith(`${prefix}/`));
}

export function overlappingResources(leftResources = {}, rightResources = {}) {
  const overlaps = {};
  for (const key of RESOURCE_KEYS) {
    const leftValues = key === 'files'
      ? (leftResources[key] ?? []).filter((value) => !COORDINATION_PROJECTION_FILES.has(value))
      : (leftResources[key] ?? []);
    const rightValues = key === 'files'
      ? (rightResources[key] ?? []).filter((value) => !COORDINATION_PROJECTION_FILES.has(value))
      : (rightResources[key] ?? []);
    const values = overlappingValues(leftValues, rightValues);
    if (values.length > 0) overlaps[key] = values;
  }
  return overlaps;
}

export function requirementIsActive(requirement) {
  const validMergedFact = requirement.mergeStatus === 'merged'
    && /^[0-9a-f]{40}$/.test(requirement.mergedCommit ?? '');
  return requirement.lifecycle !== 'done'
    && requirement.lifecycle !== 'merged'
    && requirement.lifecycle !== 'cancelled'
    && !validMergedFact;
}

function resourceWarnings(snapshot, id, resources) {
  return requirementDocuments(snapshot)
    .filter((requirement) => requirement.id !== id && requirementIsActive(requirement))
    .map((requirement) => {
      const overlaps = overlappingResources(resources, requirement.resources);
      return { requirementId: requirement.id, overlaps };
    })
    .filter(({ overlaps }) => Object.keys(overlaps).length > 0);
}

function normalizeDependencies(id, dependsOn = []) {
  if (!Array.isArray(dependsOn)) {
    throw new RequirementError('dependsOn must be a requirement id array', {
      code: 'INVALID_DEPENDENCIES',
    });
  }
  const normalized = sortedUnique(dependsOn.map(validateRequirementId));
  if (normalized.includes(id)) {
    throw new RequirementError(`${id} cannot depend on itself`, {
      code: 'DEPENDENCY_CYCLE',
    });
  }
  return normalized;
}

export function dependencyReaches(snapshot, from, target, visited = new Set()) {
  if (from === target) return true;
  if (visited.has(from)) return false;
  visited.add(from);
  const path = requirementPath(from);
  if (!snapshot.has(path)) return false;
  return (snapshot.readJson(path).dependsOn ?? []).some((dependency) => (
    dependencyReaches(snapshot, dependency, target, visited)
  ));
}

export async function declareRequirementResources({
  store,
  id,
  resources,
  dependsOn = [],
}) {
  validateRequirementId(id);
  const normalized = normalizeResources(resources);
  const dependencies = normalizeDependencies(id, dependsOn);
  let warnings = [];
  const result = await store.update({
    operation: `declare resources for ${id}`,
    mutate(snapshot) {
      const path = requirementPath(id);
      if (!snapshot.has(path)) throw missingRequirement(id);
      for (const dependency of dependencies) {
        if (!snapshot.has(requirementPath(dependency))) {
          throw new RequirementError(`dependency is not coordinated: ${dependency}`, {
            code: 'DEPENDENCY_NOT_FOUND',
            data: { requirementId: id, dependency },
          });
        }
        if (dependencyReaches(snapshot, dependency, id)) {
          throw new RequirementError(`${id} dependency graph would contain a cycle`, {
            code: 'DEPENDENCY_CYCLE',
            data: { requirementId: id, dependency },
          });
        }
      }
      warnings = resourceWarnings(snapshot, id, normalized);
      snapshot.writeJson(path, {
        ...snapshot.readJson(path),
        resources: normalized,
        dependsOn: dependencies,
        updatedAt: store.clock().toISOString(),
      });
    },
  });
  return {
    id,
    resources: normalized,
    dependsOn: dependencies,
    warnings,
    ...result,
  };
}

// ---------------------------------------------------------------------------
// I-134 (F4): declare-resources --auto inference. Changed paths come from
// `git diff --name-only <base>...HEAD` (source 'diff') plus uncommitted
// `git status --porcelain` entries (source 'uncommitted'); services are
// inferred by the shared path classifier (source 'classifier'). The fixed
// convergence rule — files sharing one directory collapse into a single
// dir/** entry once the directory holds at least AUTO_DECLARE_COLLAPSE_
// THRESHOLD inferred files — is pinned by tests and documented in the
// command help. The fixed exclusion list below covers the process files
// every requirement touches; they stay declarable explicitly but are never
// inferred.
// ---------------------------------------------------------------------------

const AUTO_DECLARE_EXACT_EXCLUDES = new Set(['BACKLOG.md']);
const AUTO_DECLARE_COLLAPSE_THRESHOLD = 3;

function autoDeclareExcluded(path, id) {
  return AUTO_DECLARE_EXACT_EXCLUDES.has(path)
    || path.startsWith(`docs/product/current/${id}-`);
}

function statusPorcelainPaths(cwd) {
  const result = runGitResult(cwd, ['status', '--porcelain']);
  if (result.error || result.status !== 0) {
    const message = result.stderr || result.error?.message || 'git command failed';
    throw new RequirementError(`git status --porcelain failed: ${message.trim()}`, {
      code: 'RECONCILE_GIT_ERROR',
      exitCode: 13,
    });
  }
  // The raw stdout is split untrimmed on purpose: runGit's trim() would eat
  // the significant leading status space of the first porcelain line.
  return result.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      let path = line.slice(3);
      const renameIndex = path.indexOf(' -> ');
      if (renameIndex !== -1) path = path.slice(renameIndex + 4);
      if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
      return path;
    });
}

function posixDirectory(path) {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

function collapseInferredFiles(entries) {
  const collapsed = new Map();
  const byDirectory = new Map();
  for (const entry of entries) {
    if (entry.value.endsWith('/**')) {
      collapsed.set(entry.value, entry.source);
      continue;
    }
    const directory = posixDirectory(entry.value);
    if (!byDirectory.has(directory)) byDirectory.set(directory, []);
    byDirectory.get(directory).push(entry);
  }
  for (const [directory, members] of byDirectory) {
    // Root scripts mix release, coordination and test launchers. A scripts/**
    // claim overstates ownership and collides with unrelated requirements.
    if (directory !== '' && directory !== 'scripts' && members.length >= AUTO_DECLARE_COLLAPSE_THRESHOLD) {
      // A collapsed entry keeps 'diff' as its source when any member came
      // from the committed diff; otherwise it is 'uncommitted'.
      const source = members.some((member) => member.source === 'diff')
        ? 'diff'
        : 'uncommitted';
      collapsed.set(`${directory}/**`, source);
      continue;
    }
    for (const member of members) collapsed.set(member.value, member.source);
  }
  return [...collapsed.entries()]
    .map(([value, source]) => ({ value, source }))
    .sort((left, right) => left.value.localeCompare(right.value));
}

export function inferRequirementResources({ cwd, id, base = 'origin/main' }) {
  const requirementId = validateRequirementId(id);
  const entries = [];
  const seen = new Set();
  const collect = (paths, source) => {
    for (const raw of paths) {
      if (autoDeclareExcluded(raw, requirementId) || seen.has(raw)) continue;
      seen.add(raw);
      // An untracked directory arrives with a trailing slash; everything
      // inside is new, so it collapses to a dir/** entry directly.
      entries.push({ value: raw.endsWith('/') ? `${raw}**` : raw, source });
    }
  };
  collect(
    runGit(cwd, ['diff', '--name-only', `${base}...HEAD`]).split('\n').filter(Boolean),
    'diff',
  );
  collect(statusPorcelainPaths(cwd), 'uncommitted');
  const services = classifyChangedPaths(entries.map((entry) => entry.value))
    .affectedServices
    .map((value) => ({ value, source: 'classifier' }));
  return { files: collapseInferredFiles(entries), services };
}

// ---------------------------------------------------------------------------
// I-134 (F8): requirement cancel. A non-terminal requirement lands at the
// cancelled terminal state with an auditable history event; the BACKLOG row
// projects 🚫 Cancelled through the same cell rewrite as lifecycle advances
// (publishBacklogProjection stays a CLI concern, exactly like advance).
// Lifecycles before in_dev cancel directly; in_dev and later require force.
// Worktrees/branches and held leases are deliberately not touched — callers
// surface cleanup hints instead.
// ---------------------------------------------------------------------------

const FORCE_FREE_CANCEL_LIFECYCLES = new Set(['todo', 'reviewing', 'req_confirmed', 'tech_design']);

export async function cancelRequirement({
  store,
  cwd,
  id,
  reason,
  force = false,
  actor,
}) {
  const requirementId = validateRequirementId(id);
  const normalizedReason = typeof reason === 'string' ? reason.trim() : '';
  // Same reason convention as breakLease: a single auditable line.
  if (normalizedReason.length < 10) {
    throw new RequirementError('cancel reason must be at least 10 characters', {
      code: 'INVALID_CANCEL_REASON',
    });
  }
  if (normalizedReason.length > 500 || /[\r\n]/.test(normalizedReason)) {
    throw new RequirementError('cancel reason must be a single line of at most 500 characters', {
      code: 'INVALID_CANCEL_REASON',
    });
  }
  let from;
  const update = await store.update({
    operation: `cancel requirement ${requirementId}`,
    auditData: {
      kind: 'requirement-cancel',
      requirementId,
      reason: normalizedReason,
      force: force === true,
    },
    mutate(snapshot) {
      const path = requirementPath(requirementId);
      if (!snapshot.has(path)) throw missingRequirement(requirementId);
      const requirement = snapshot.readJson(path);
      from = requirement.lifecycle;
      // Idempotent re-cancel: the terminal fact already exists.
      if (from === 'cancelled') return;
      if (from === 'done') {
        throw new RequirementError(`${requirementId} is already done and cannot be cancelled`, {
          code: 'CANCEL_TERMINAL_STATE',
          data: { requirementId, lifecycle: from },
        });
      }
      if (!FORCE_FREE_CANCEL_LIFECYCLES.has(from) && force !== true) {
        throw new RequirementError(
          `${requirementId} is ${from}; cancelling in_dev or later requires --force`,
          {
            code: 'CANCEL_NEEDS_FORCE',
            data: { requirementId, lifecycle: from },
          },
        );
      }
      const now = store.clock().toISOString();
      snapshot.writeJson(path, {
        ...requirement,
        lifecycle: 'cancelled',
        lifecycleHistory: [
          ...(requirement.lifecycleHistory ?? []),
          {
            type: 'cancel',
            from,
            to: 'cancelled',
            at: now,
            actor: actor ?? 'unknown',
            reason: normalizedReason,
          },
        ],
        updatedAt: now,
      });
    },
  });

  // Same projection semantics as advanceLifecycle: the coordination cancel
  // already landed, so a row-rewrite failure surfaces as PROJECTION_UNCERTAIN
  // (exit 15). A requirement without a BACKLOG row (zombie registration)
  // skips the rewrite — the cancelled fact is the source of truth.
  let projection;
  try {
    const rows = backlogRows(readFileSync(join(cwd, 'BACKLOG.md'), 'utf8'));
    projection = rows.has(requirementId)
      ? projectBacklog({ cwd, id: requirementId, from, to: 'cancelled' })
      : { changed: false, status: BACKLOG_STATUSES.cancelled, skipped: 'missing-backlog-row' };
  } catch (error) {
    throw new RequirementError(
      'coordination requirement was cancelled but the BACKLOG projection failed; reconcile the projection manually',
      {
        code: 'PROJECTION_UNCERTAIN',
        exitCode: 15,
        data: {
          id: requirementId,
          lifecycle: 'cancelled',
          projectionError: error instanceof Error ? error.message : String(error),
        },
      },
    );
  }
  return {
    id: requirementId,
    from,
    lifecycle: 'cancelled',
    reason: normalizedReason,
    changed: update.changed,
    projection,
    operationId: update.operationId,
    coordinationSha: update.sha,
  };
}

function completionDocumentAt(context, plan) {
  const source = textAt(context.cwd, context.commit, plan.evidence.path);
  if (!source) return null;
  try {
    return JSON.parse(source);
  } catch {
    return null;
  }
}

function jsonAt(cwd, commit, path) {
  const source = textAt(cwd, commit, path);
  if (!source) return null;
  try {
    return JSON.parse(source);
  } catch {
    return null;
  }
}

function firstMatchingMainCommit({ cwd, target, base, matches }) {
  const range = (
    typeof base === 'string'
    && /^[0-9a-f]{40}$/.test(base)
    && runGitResult(cwd, ['merge-base', '--is-ancestor', base, target]).status === 0
  ) ? `${base}..${target}` : target;
  const commits = runGit(cwd, ['rev-list', '--first-parent', '--reverse', range])
    .split('\n').filter(Boolean);
  return commits.find((candidate) => matches(candidate)) ?? null;
}

function recoveredFeatureMerge({ cwd, target, requirement, headRows }) {
  if (
    requirement.lifecycle !== 'test_passed'
    || requirement.mergedCommit
    || headRows.get(requirement.id)?.status !== '✅ Test Passed'
  ) return null;
  let path;
  try {
    path = completionEvidencePath({ cwd, commit: target, id: requirement.id })
      .replace(/COMPLETION\.json$/, 'TEST_EVIDENCE.json');
  } catch {
    return null;
  }
  const source = textAt(cwd, target, path);
  const evidence = jsonAt(cwd, target, path);
  if (
    !source
    || evidence?.schemaVersion !== 1
    || evidence?.outcome !== 'passed'
    || evidence?.requirement?.id !== requirement.id
    || evidence?.requirement?.version !== requirement.version
    || evidence?.requirement?.deliveryProfile !== requirement.deliveryProfile
  ) return null;
  return firstMatchingMainCommit({
    cwd,
    target,
    base: evidence.mainBase,
    matches(candidate) {
      return textAt(cwd, candidate, path) === source
        && backlogRows(textAt(cwd, candidate, 'BACKLOG.md')).get(requirement.id)?.status
          === '✅ Test Passed';
    },
  });
}

function recoveredCompletionMerge({ cwd, target, requirement, headRows }) {
  if (
    !['merged', 'done'].includes(requirement.lifecycle)
    || requirement.completion?.status !== 'pending'
    || headRows.get(requirement.id)?.status !== '✔️ Done'
  ) return null;
  const path = requirement.completion?.evidencePath;
  if (typeof path !== 'string' || path.length === 0) return null;
  const source = textAt(cwd, target, path);
  const evidence = jsonAt(cwd, target, path);
  if (
    !source
    || evidence?.schemaVersion !== 1
    || evidence?.requirementId !== requirement.id
    || evidence?.deliveryProfile !== requirement.deliveryProfile
    || evidence?.mergedCommit !== requirement.mergedCommit
  ) return null;
  return firstMatchingMainCommit({
    cwd,
    target,
    base: requirement.mergedCommit,
    matches(candidate) {
      return textAt(cwd, candidate, path) === source
        && backlogRows(textAt(cwd, candidate, 'BACKLOG.md')).get(requirement.id)?.status
          === '✔️ Done';
    },
  });
}

// I-243 review：只从待 reconcile 的 main commit 读取证据，确保刷新依据是已合入
// main 的事实，而不是工作区里可能未提交的文件。
function testedCommitAt({ cwd, target, id }) {
  let path;
  try {
    path = completionEvidencePath({ cwd, commit: target, id })
      .replace(/COMPLETION\.json$/, 'TEST_EVIDENCE.json');
  } catch {
    return null;
  }
  const evidence = jsonAt(cwd, target, path);
  return /^[0-9a-f]{40}$/.test(evidence?.testedCommit ?? '')
    ? evidence.testedCommit
    : null;
}

// I-243 review：需求返工后 testedCommit 前移，旧 mergedCommit 可能只是历史
// merge（不覆盖新测试 commit）。只有当本次 reconcile 的 main commit 真正包含
// testedCommit、且旧事实不覆盖它时，才把合并事实刷新到该 main commit；否则
// 保持原事实不动（幂等 replay 不产生写入）。
function staleMergeRefresh({ cwd, target, requirement }) {
  if (
    requirement.lifecycle !== 'test_passed'
    || requirement.mergeStatus !== 'merged'
    || !/^[0-9a-f]{40}$/.test(requirement.mergedCommit ?? '')
  ) return null;
  const testedCommit = testedCommitAt({ cwd, target, id: requirement.id });
  if (!testedCommit) return null;
  if (
    runGitResult(cwd, [
      'merge-base', '--is-ancestor', testedCommit, requirement.mergedCommit,
    ]).status === 0
  ) return null;
  if (
    runGitResult(cwd, ['merge-base', '--is-ancestor', testedCommit, target]).status !== 0
  ) return null;
  return { testedCommit };
}

export async function reconcileMergedRequirements({ store, cwd, commit, base }) {
  const context = { cwd, ...changedCommitContext({ cwd, commit, base }) };
  const initial = await store.readSnapshot();
  const ids = new Set(context.ids.filter((id) => initial.has(requirementPath(id))));
  const recoveredFeatureCommits = new Map();
  const recoveredCompletionCommits = new Map();
  const refreshedMerges = new Map();
  for (const requirement of requirementDocuments(initial)) {
    if (
      ['merged', 'done'].includes(requirement.lifecycle)
      && requirement.completion?.status === 'pending'
      && requirement.deliveryProfile !== 'runtime'
    ) {
      ids.add(requirement.id);
      const completedCommit = recoveredCompletionMerge({
        cwd,
        target: context.commit,
        requirement,
        headRows: context.headRows,
      });
      if (completedCommit) recoveredCompletionCommits.set(requirement.id, completedCommit);
      continue;
    }
    if (requirement.lifecycle !== 'test_passed') continue;
    if (!requirement.mergedCommit) {
      const mergedCommit = recoveredFeatureMerge({
        cwd,
        target: context.commit,
        requirement,
        headRows: context.headRows,
      });
      if (mergedCommit) {
        ids.add(requirement.id);
        recoveredFeatureCommits.set(requirement.id, mergedCommit);
      }
      continue;
    }
    const refresh = staleMergeRefresh({
      cwd,
      target: context.commit,
      requirement,
    });
    if (refresh) {
      ids.add(requirement.id);
      refreshedMerges.set(requirement.id, refresh);
    }
  }
  if (ids.size === 0) {
    return {
      action: 'none',
      commit: context.commit,
      base: context.base,
      transitions: [],
      completions: [],
      repairs: [],
      coordinationSha: initial.sha,
      changed: false,
    };
  }

  let transitions = [];
  let completions = [];
  let repairs = [];
  const update = await store.update({
    operation: `reconcile main commit ${context.commit.slice(0, 12)}`,
    auditData: {
      kind: 'main-reconcile',
      commit: context.commit,
      requirementIds: [...ids].sort(),
    },
    mutate(snapshot) {
      transitions = [];
      completions = [];
      repairs = [];
      for (const id of [...ids].sort()) {
        const path = requirementPath(id);
        if (!snapshot.has(path)) continue;
        const requirement = snapshot.readJson(path);
        const now = store.clock().toISOString();

        if (context.completionIds.has(id) || recoveredCompletionCommits.has(id)) {
          if (requirement.completion?.status === 'done') continue;
          if (!['merged', 'done'].includes(requirement.lifecycle)) {
            throw new RequirementError(`${id} completion merged before coordination reached merged`, {
              code: 'COMPLETION_NOT_MERGED',
              data: { requirementId: id, lifecycle: requirement.lifecycle },
            });
          }
          const recoveredCompletionCommit = recoveredCompletionCommits.get(id);
          const completionBase = recoveredCompletionCommit
            ? firstParent(cwd, recoveredCompletionCommit)
            : context.base;
          const expectedPlan = completionPlan({
            cwd,
            commit: requirement.mergedCommit,
            id,
            requirement,
            row: backlogRows(textAt(cwd, completionBase, 'BACKLOG.md')).get(id),
            clock: store.clock,
          });
          const evidence = completionDocumentAt(context, expectedPlan);
          if (
            context.headRows.get(id)?.status !== '✔️ Done'
            || evidence?.schemaVersion !== 1
            || evidence?.requirementId !== id
            || evidence?.deliveryProfile !== requirement.deliveryProfile
            || evidence?.mergedCommit !== requirement.mergedCommit
          ) {
            throw new RequirementError(`${id} completion merge metadata is invalid`, {
              code: 'COMPLETION_EVIDENCE_INVALID',
              data: { requirementId: id },
            });
          }
          snapshot.writeJson(path, {
            ...requirement,
            lifecycle: 'done',
            mergeStatus: 'merged',
            completion: {
              ...requirement.completion,
              status: 'done',
              completedCommit: recoveredCompletionCommit ?? context.commit,
              completedAt: now,
            },
            lifecycleHistory: requirement.lifecycle === 'done'
              ? requirement.lifecycleHistory
              : [
                ...(requirement.lifecycleHistory ?? []),
                { type: 'advance', from: 'merged', to: 'done', at: now },
              ],
            updatedAt: now,
          });
          if (requirement.lifecycle === 'done') {
            repairs.push({ requirementId: id, completedCommit: recoveredCompletionCommit ?? context.commit });
          } else {
            transitions.push({ requirementId: id, from: 'merged', to: 'done' });
          }
          continue;
        }

        if (
          requirement.mergedCommit
          && requirement.lifecycle === 'merged'
          && requirement.completion?.status === 'pending'
          && requirement.deliveryProfile !== 'runtime'
        ) {
          completions.push(completionPlan({
            cwd,
            commit: requirement.mergedCommit,
            id,
            requirement,
            row: context.headRows.get(id),
            clock: store.clock,
          }));
          continue;
        }
        // I-243 review：旧 merge 事实不覆盖 testedCommit，而本次 main commit
        // 已覆盖它——刷新合并事实。写入前按当前 snapshot 复核（store.update
        // 可能因 CAS 重放 mutate），并保持幂等：仍覆盖或未合入时不写。
        const refresh = refreshedMerges.get(id);
        if (refresh && requirement.mergedCommit && requirement.lifecycle === 'test_passed') {
          const stillStale = runGitResult(cwd, [
            'merge-base', '--is-ancestor', refresh.testedCommit, requirement.mergedCommit,
          ]).status !== 0;
          const mergedInto = runGitResult(cwd, [
            'merge-base', '--is-ancestor', refresh.testedCommit, context.commit,
          ]).status === 0;
          if (stillStale && mergedInto) {
            snapshot.writeJson(path, {
              ...requirement,
              mergeStatus: 'merged',
              mergedCommit: context.commit,
              mergedAt: now,
              mergeHistory: [
                ...(requirement.mergeHistory ?? []),
                {
                  from: requirement.mergedCommit,
                  to: context.commit,
                  testedCommit: refresh.testedCommit,
                  reason: 'reconciled merge contains the tested commit',
                  at: now,
                },
              ],
              updatedAt: now,
            });
            transitions.push({
              requirementId: id,
              from: 'test_passed',
              to: 'test_passed',
              mergeStatus: 'refreshed',
              previousMergedCommit: requirement.mergedCommit,
              mergedCommit: context.commit,
              testedCommit: refresh.testedCommit,
            });
            continue;
          }
        }
        if (requirement.mergedCommit || requirement.lifecycle === 'done') continue;
        if (requirement.lifecycle !== 'test_passed') {
          throw new RequirementError(`${id} feature merged before Test Passed`, {
            code: 'FEATURE_NOT_TEST_PASSED',
            data: { requirementId: id, lifecycle: requirement.lifecycle },
          });
        }

        const mergedCommit = recoveredFeatureCommits.get(id) ?? context.commit;
        if (requirement.deliveryProfile === 'runtime') {
          snapshot.writeJson(path, {
            ...requirement,
            mergeStatus: 'merged',
            mergedCommit,
            mergedAt: now,
            updatedAt: now,
          });
          transitions.push({
            requirementId: id,
            from: 'test_passed',
            to: 'test_passed',
            mergeStatus: 'merged',
            projection: 'pending_release',
          });
          continue;
        }

        const plan = completionPlan({
          cwd,
          commit: mergedCommit,
          id,
          requirement,
          row: context.headRows.get(id),
          clock: store.clock,
        });
        snapshot.writeJson(path, {
          ...requirement,
          lifecycle: 'merged',
          mergeStatus: 'merged',
          mergedCommit,
          mergedAt: now,
          completion: {
            status: 'pending',
            evidencePath: plan.evidence.path,
            requestedAt: now,
          },
          lifecycleHistory: [
            ...(requirement.lifecycleHistory ?? []),
            { type: 'advance', from: 'test_passed', to: 'merged', at: now },
          ],
          updatedAt: now,
        });
        transitions.push({ requirementId: id, from: 'test_passed', to: 'merged' });
        completions.push(plan);
      }
    },
  });

  return {
    action: completions.length > 0
      ? 'open-completion-pr'
      : (transitions.length > 0 ? 'mark-merged' : (repairs.length > 0 ? 'repair-completion' : 'none')),
    commit: context.commit,
    base: context.base,
    transitions,
    completions,
    repairs,
    coordinationSha: update.sha,
    changed: update.changed,
  };
}

export async function planRequirementCompletion({ store, cwd, id, commit }) {
  const requirementId = validateRequirementId(id);
  const target = resolvedCommit(cwd, commit);
  const snapshot = await store.readSnapshot();
  const path = requirementPath(requirementId);
  if (!snapshot.has(path)) {
    throw new RequirementError(`requirement is not claimed: ${requirementId}`, {
      code: 'REQUIREMENT_NOT_FOUND',
    });
  }
  const requirement = snapshot.readJson(path);
  // I-121 实测修正：按 I-118 设计文档「prod_deployed 后即 dispatch」，
  // plan-completion 必须接受 prod_deployed（done 保留用于幂等重试），
  // 否则 advance-done 门禁（要求 COMPLETION.json 已存在）与 plan-completion
  // 互锁，runtime 需求无法收尾。
  const completableLifecycle = requirement.lifecycle === 'prod_deployed'
    || requirement.lifecycle === 'done';
  if (
    requirement.deliveryProfile !== 'runtime'
    || !completableLifecycle
    || requirement.mergeStatus !== 'merged'
    || !/^[0-9a-f]{40}$/.test(requirement.mergedCommit ?? '')
  ) {
    throw new RequirementError(`${requirementId} is not ready for runtime completion`, {
      code: 'COMPLETION_NOT_READY',
      data: {
        requirementId,
        deliveryProfile: requirement.deliveryProfile ?? null,
        lifecycle: requirement.lifecycle ?? null,
        mergeStatus: requirement.mergeStatus ?? null,
      },
    });
  }
  const row = backlogRows(textAt(cwd, target, 'BACKLOG.md')).get(requirementId);
  const allowedStatuses = new Set(['📋 Prod Planning', '🚀 Prod Deployed']);
  // I-118：行已是 ✔️ Done 时幂等收尾——completion 事实（COMPLETION.json 且 mergedCommit 一致）
  // 已在 target commit 上存在时返回 no-op，使 workflow 可安全重试，并收敛 I-115 式
  // 先投影后收尾的存量状态；事实缺失时仍拒绝（不得放宽合法性校验）。
  if (row?.status === '✔️ Done') {
    let document = null;
    try {
      document = jsonAt(cwd, target, completionEvidencePath({ cwd, commit: target, id: requirementId }));
    } catch {
      document = null;
    }
    if (document?.schemaVersion === 1
      && document.requirementId === requirementId
      && document.mergedCommit === requirement.mergedCommit) {
      return {
        action: 'already-completed',
        commit: target,
        transitions: [],
        completions: [],
      };
    }
  }
  if (!allowedStatuses.has(row?.status)) {
    throw new RequirementError(
      `${requirementId} main BACKLOG is not at a runtime completion source`,
      {
        code: 'COMPLETION_BACKLOG_INVALID',
        data: { requirementId, status: row?.status ?? null },
      },
    );
  }
  const completion = completionPlan({
    cwd,
    commit: requirement.mergedCommit,
    id: requirementId,
    requirement,
    row,
    clock: store.clock,
    allowedStatuses,
  });
  return {
    action: 'open-completion-pr',
    commit: target,
    transitions: [],
    completions: [completion],
  };
}

function completionFromPlan(plan, requirementId) {
  const document = plan?.data ?? plan;
  const completions = document?.completions;
  if (!Array.isArray(completions)) {
    throw new RequirementError('completion plan does not contain completions', {
      code: 'INVALID_COMPLETION_PLAN',
    });
  }
  const matches = completions.filter((item) => item?.requirementId === requirementId);
  if (matches.length !== 1) {
    throw new RequirementError(`completion plan must contain exactly one entry for ${requirementId}`, {
      code: 'INVALID_COMPLETION_PLAN',
    });
  }
  return matches[0];
}

export function applyCompletionPatch({ cwd, plan, requirementId }) {
  const id = validateRequirementId(requirementId);
  const completion = completionFromPlan(plan, id);
  const sourceStatuses = completion.deliveryProfile === 'runtime'
    ? ['📋 Prod Planning', '🚀 Prod Deployed']
    : ['✅ Test Passed'];
  const sourceStatus = sourceStatuses.find((status) => (
    completion.backlog?.before?.includes(`| ${status} |`)
  ));
  if (
    completion.backlog?.path !== 'BACKLOG.md'
    || typeof completion.backlog.before !== 'string'
    || typeof completion.backlog.after !== 'string'
    || !completion.backlog.before.startsWith(`| ${id} |`)
    || !completion.backlog.after.startsWith(`| ${id} |`)
    || !sourceStatus
    || !completion.backlog.after.includes('| ✔️ Done |')
    || completion.backlog.after !== completion.backlog.before.replace(
      `| ${sourceStatus} |`,
      '| ✔️ Done |',
    )
  ) {
    throw new RequirementError(`invalid BACKLOG completion patch for ${id}`, {
      code: 'INVALID_COMPLETION_PLAN',
    });
  }
  const expectedEvidence = new RegExp(
    `^docs/product/current/${id.replace('-', '\\-')}-[^/]+/COMPLETION\\.json$`,
  );
  if (
    !expectedEvidence.test(completion.evidence?.path ?? '')
    || completion.evidence?.document?.schemaVersion !== 1
    || completion.evidence?.document?.requirementId !== id
    || !/^[0-9a-f]{40}$/.test(completion.evidence?.document?.mergedCommit ?? '')
    || !/^\d{4}-\d{2}-\d{2}T/.test(completion.evidence?.document?.generatedAt ?? '')
  ) {
    throw new RequirementError(`invalid completion evidence patch for ${id}`, {
      code: 'INVALID_COMPLETION_PLAN',
    });
  }
  validateDeliveryProfile(completion.evidence.document.deliveryProfile);

  const backlogPath = resolve(cwd, 'BACKLOG.md');
  const backlog = readFileSync(backlogPath, 'utf8');
  const occurrences = backlog.split('\n')
    .filter((line) => line === completion.backlog.before).length;
  if (occurrences !== 1) {
    throw new RequirementError(`BACKLOG completion source row changed for ${id}`, {
      code: 'COMPLETION_PATCH_STALE',
    });
  }
  const evidencePath = resolve(cwd, completion.evidence.path);
  if (!evidencePath.startsWith(`${resolve(cwd)}/`)) {
    throw new RequirementError('completion evidence path escapes the repository', {
      code: 'INVALID_COMPLETION_PLAN',
    });
  }
  if (existsSync(evidencePath)) {
    throw new RequirementError(`completion evidence already exists for ${id}`, {
      code: 'COMPLETION_PATCH_EXISTS',
    });
  }

  writeFileSync(backlogPath, backlog.replace(
    completion.backlog.before,
    completion.backlog.after,
  ));
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify({
    schemaVersion: 1,
    requirementId: id,
    deliveryProfile: completion.evidence.document.deliveryProfile,
    mergedCommit: completion.evidence.document.mergedCommit,
    generatedAt: completion.evidence.document.generatedAt,
  }, null, 2)}\n`);
  return {
    requirementId: id,
    paths: ['BACKLOG.md', completion.evidence.path],
  };
}

export async function readCoordinationStatus(store) {
  const snapshot = await store.readSnapshot();
  const locks = {};
  for (const resource of ['dev', 'prod', 'prod-build']) {
    const path = `locks/${resource}.json`;
    if (snapshot.has(path)) locks[resource] = snapshot.readJson(path);
  }
  // I-128 (M7): agents need the full blocking picture in one call — the dev
  // freeze fact blocks every shared-dev entry point, a red regression blocks
  // merges, and approvals gate the auto-release path.
  const freeze = snapshot.has('freezes/dev.json') ? snapshot.readJson('freezes/dev.json') : null;
  const regression = snapshot.has('regressions/red.json')
    ? snapshot.readJson('regressions/red.json')
    : null;
  const releaseApprovals = Object.fromEntries(
    snapshot.paths()
      .filter((path) => /^release-approvals\/[^/]+\.json$/.test(path))
      .map((path) => [
        path.slice('release-approvals/'.length, -'.json'.length),
        snapshot.readJson(path),
      ]),
  );
  return {
    initialized: true,
    sha: snapshot.sha,
    requirements: requirementDocuments(snapshot),
    versions: versionDocuments(snapshot).map(({ version, requirements }) => ({
      version,
      requirements,
    })),
    locks,
    freeze,
    regression,
    releaseApprovals,
  };
}

// I-128 (M7): single-requirement lookup so agents do not have to pull the
// full status document to inspect one requirement.
export async function showRequirement({ store, id }) {
  const requirementId = validateRequirementId(id);
  const snapshot = await store.readSnapshot();
  const path = requirementPath(requirementId);
  if (!snapshot.has(path)) throw missingRequirement(requirementId);
  return snapshot.readJson(path);
}
