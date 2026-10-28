// Candidate 身份（I-113 Task 4）：候选以完整 source commit + 运行时输入指纹
// 标识，绑定 coordination requirement 的 feature branch 可达性。修复迭代只
// 生成 immutable candidate fact，绝不创建 SemVer tag；candidate 事实存放在
// coordination branch 的 candidates/<requirement>/<candidate>.json，作废时
// 保留审计链。candidate source commit 与最终 release commit（合并后创建
// Version tag 的 main commit）分离，由 release tooling 在合并后做等价校验。

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { assertRequirementId } from './validation.mjs';
import { actor, knownSession } from './leases.mjs';

const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const CANDIDATE_ID_PATTERN = /^candidate-[A-Z]-\d{3}-[a-f0-9]{40}-[a-f0-9]{64}$/;

export class CandidateError extends Error {
  constructor(message, { code, exitCode = 14, data = {}, cause } = {}) {
    super(message, { cause });
    this.name = 'CandidateError';
    this.code = code;
    this.exitCode = exitCode;
    this.data = data;
  }
}

function runGit(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    throw new CandidateError(`git ${args.join(' ')} failed`, {
      code: 'GIT_CANDIDATE_ERROR',
      exitCode: 13,
    });
  }
  return result.stdout.trim();
}

function candidateDirectory(requirementId) {
  return `candidates/${assertRequirementId(requirementId)}`;
}

function candidatePath(requirementId, id) {
  return `${candidateDirectory(requirementId)}/${id}.json`;
}

function validateCandidateId(id) {
  if (typeof id !== 'string' || !CANDIDATE_ID_PATTERN.test(id)) {
    throw new CandidateError(`invalid candidate id: ${id ?? '<missing>'}`, {
      code: 'INVALID_CANDIDATE_ID',
    });
  }
  return id;
}

// Deterministic candidate identity: requirement + full source commit +
// runtime input fingerprint. No SemVer tag is ever created for a candidate.
export function candidateId({ requirementId, sourceCommit, fingerprint }) {
  const safeId = assertRequirementId(requirementId);
  if (!COMMIT_PATTERN.test(sourceCommit ?? '')) {
    throw new CandidateError('candidate source commit must be a full 40-character SHA', {
      code: 'INVALID_CANDIDATE_REF',
    });
  }
  if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new CandidateError('candidate fingerprint must be a 64-character SHA-256', {
      code: 'INVALID_CANDIDATE_FINGERPRINT',
    });
  }
  return `candidate-${safeId}-${sourceCommit}-${fingerprint}`;
}

function requirementFromSnapshot(snapshot, requirementId) {
  const safeId = assertRequirementId(requirementId);
  const path = `requirements/${safeId}.json`;
  if (!snapshot.has(path)) {
    throw new CandidateError(`requirement is not claimed: ${safeId}`, {
      code: 'REQUIREMENT_NOT_FOUND',
      data: { requirementId: safeId },
    });
  }
  return snapshot.readJson(path);
}

// Full commit reachable from the requirement's bound branch (or from the
// merged main revision for already-merged requirements).
export async function assertCandidateRef({
  store,
  cwd,
  requirementId,
  ref,
}) {
  const safeId = assertRequirementId(requirementId);
  if (!COMMIT_PATTERN.test(ref ?? '')) {
    throw new CandidateError(`candidate ref must be a full 40-character SHA: ${ref ?? '<missing>'}`, {
      code: 'INVALID_CANDIDATE_REF',
      data: { requirementId: safeId, ref: ref ?? null },
    });
  }
  const snapshot = await store.readSnapshot();
  const requirement = requirementFromSnapshot(snapshot, safeId);
  const branch = requirement.branch;
  if (!branch) {
    throw new CandidateError(`${safeId} must be bound to a branch before creating candidates`, {
      code: 'BRANCH_REQUIRED',
      data: { requirementId: safeId },
    });
  }
  const resolved = runGit(cwd, ['rev-parse', `${ref}^{commit}`]);
  const reachableFromBranch = spawnSync(
    'git',
    ['merge-base', '--is-ancestor', resolved, `origin/${branch}`],
    { cwd, stdio: ['ignore', 'ignore', 'ignore'] },
  ).status === 0;
  const mergedMain = requirement.deliveryProfile === 'runtime'
    && requirement.mergeStatus === 'merged'
    && typeof requirement.mergedCommit === 'string'
    && spawnSync(
      'git',
      ['merge-base', '--is-ancestor', resolved, requirement.mergedCommit],
      { cwd, stdio: ['ignore', 'ignore', 'ignore'] },
    ).status === 0;
  if (!reachableFromBranch && !mergedMain) {
    throw new CandidateError(`candidate ref is not reachable from ${branch}`, {
      code: 'CANDIDATE_REF_UNREACHABLE',
      data: { requirementId: safeId, branch, ref: resolved },
    });
  }
  return { commit: resolved, branch, requirementId: safeId };
}

function normalizedServices(value) {
  const services = Array.isArray(value) ? value : [];
  const normalized = [...new Set(services.map((service) => String(service).trim()).filter(Boolean))].sort();
  if (normalized.some((service) => !/^[a-z0-9-]+$/.test(service))) {
    throw new CandidateError('candidate services contain an invalid service name', {
      code: 'INVALID_CANDIDATE_SERVICES',
      data: { services: normalized },
    });
  }
  return normalized;
}

function inputFingerprint(runtimeInputs) {
  return createHash('sha256').update(JSON.stringify(
    Object.fromEntries(Object.entries(runtimeInputs ?? {}).sort()),
  )).digest('hex');
}

function validCandidateFact(snapshot, requirementId, id) {
  const path = candidatePath(requirementId, id);
  if (!snapshot.has(path)) return null;
  let fact;
  try {
    fact = snapshot.readJson(path);
  } catch (error) {
    throw new CandidateError('invalid candidate fact', {
      code: 'INVALID_CANDIDATE_STATE',
      cause: error,
    });
  }
  const valid = fact !== null
    && typeof fact === 'object'
    && !Array.isArray(fact)
    && fact.schemaVersion === 1
    && fact.candidateId === id
    && fact.requirementId === assertRequirementId(requirementId)
    && COMMIT_PATTERN.test(fact.sourceCommit ?? '')
    && typeof fact.branch === 'string'
    && Array.isArray(fact.services)
    && (fact.status === 'active' || fact.status === 'voided');
  if (!valid) throw new CandidateError('invalid candidate fact', {
    code: 'INVALID_CANDIDATE_STATE',
  });
  return fact;
}

export async function showCandidate({ store, requirementId, candidateId }) {
  const safeId = assertRequirementId(requirementId);
  const id = validateCandidateId(candidateId);
  const snapshot = await store.readSnapshot();
  return validCandidateFact(snapshot, safeId, id);
}

// Record an immutable candidate fact. The source commit must be a full SHA
// reachable from the requirement's bound branch; every fix iteration records
// a new candidate rather than reusing or re-tagging an older one.
export async function recordCandidate({
  store,
  cwd,
  requirementId,
  sourceCommit,
  services,
  runtimeInputs,
  buildArgs,
  requiredTestSet,
  session = null,
  clock = () => new Date(),
}) {
  const safeId = assertRequirementId(requirementId);
  const { commit, branch } = await assertCandidateRef({
    store,
    cwd,
    requirementId: safeId,
    ref: sourceCommit,
  });
  const normalized = normalizedServices(services);
  const fingerprint = inputFingerprint(runtimeInputs);
  const id = candidateId({ requirementId: safeId, sourceCommit: commit, fingerprint });
  const localSession = session ? knownSession(cwd, session) : null;
  const now = clock();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new CandidateError('candidate clock returned an invalid date', {
      code: 'INVALID_CANDIDATE_CLOCK',
    });
  }

  let fact;
  const update = await store.update({
    operation: `record candidate ${id} for ${safeId}`,
    auditData: {
      kind: 'candidate',
      action: 'record',
      requirementId: safeId,
      candidateId: id,
      sourceCommit: commit,
    },
    mutate(snapshot) {
      const existing = validCandidateFact(snapshot, safeId, id);
      if (existing) {
        throw new CandidateError(`candidate already exists: ${id}`, {
          code: 'CANDIDATE_EXISTS',
          data: { requirementId: safeId, candidateId: id },
        });
      }
      fact = {
        schemaVersion: 1,
        candidateId: id,
        requirementId: safeId,
        sourceCommit: commit,
        branch,
        services: normalized,
        runtimeInputs: Object.fromEntries(Object.entries(runtimeInputs ?? {}).sort()),
        runtimeInputsSha256: fingerprint,
        buildArgs: buildArgs ?? {},
        requiredTestSet: Array.isArray(requiredTestSet) ? requiredTestSet : [],
        status: 'active',
        recordedAt: now.toISOString(),
        ...(localSession ? { actor: actor(localSession) } : {}),
      };
      snapshot.writeJson(candidatePath(safeId, id), fact);
    },
  });

  return {
    ...fact,
    operationId: update.operationId,
    coordinationSha: update.sha,
  };
}

// Merge equivalence (I-113 Task 4): the releaseCommit (the merged main commit
// that receives the final Version tag) is only allowed to carry the prebuilt
// digest of an accepted candidate when every per-service runtime input
// fingerprint is byte-identical. Any runtime input change invalidates the
// candidate; pure state/release-doc changes keep it reusable. The candidate
// must be active — a voided candidate can never be promoted.
export async function assertCandidateMergeEquivalent({
  store,
  cwd,
  requirementId,
  candidateId,
  releaseCommit,
  runtimeInputs,
}) {
  const safeId = assertRequirementId(requirementId);
  const id = validateCandidateId(candidateId);
  if (!COMMIT_PATTERN.test(releaseCommit ?? '')) {
    throw new CandidateError('release commit must be a full 40-character SHA', {
      code: 'INVALID_CANDIDATE_REF',
      data: { requirementId: safeId, releaseCommit: releaseCommit ?? null },
    });
  }
  const snapshot = await store.readSnapshot();
  const fact = validCandidateFact(snapshot, safeId, id);
  if (!fact) {
    throw new CandidateError(`candidate not found: ${id}`, {
      code: 'CANDIDATE_NOT_FOUND',
      data: { requirementId: safeId, candidateId: id },
    });
  }
  if (fact.status !== 'active') {
    throw new CandidateError(`candidate is ${fact.status} and cannot be promoted: ${id}`, {
      code: 'CANDIDATE_VOIDED',
      data: { requirementId: safeId, candidateId: id, status: fact.status },
    });
  }
  const expected = inputFingerprint(runtimeInputs);
  if (expected !== fact.runtimeInputsSha256) {
    throw new CandidateError(
      'release commit runtime inputs no longer match the accepted candidate',
      {
        code: 'CANDIDATE_RUNTIME_INPUT_MISMATCH',
        exitCode: 11,
        data: {
          requirementId: safeId,
          candidateId: id,
          candidateInputsSha256: fact.runtimeInputsSha256,
          releaseInputsSha256: expected,
          services: fact.services,
        },
      },
    );
  }
  return {
    requirementId: safeId,
    candidateId: id,
    equivalent: true,
    releaseCommit,
    candidateSourceCommit: fact.sourceCommit,
    services: fact.services,
  };
}

// Void an immutable candidate. The fact is kept on the coordination branch
// with the void reason and actor for audit; a voided candidate must never be
// deployed or promoted.
export async function voidCandidate({
  store,
  cwd,
  requirementId,
  candidateId,
  reason,
  session = null,
  clock = () => new Date(),
}) {
  const safeId = assertRequirementId(requirementId);
  const id = validateCandidateId(candidateId);
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new CandidateError('voiding a candidate requires a reason', {
      code: 'MISSING_CANDIDATE_REASON',
    });
  }
  const localSession = session ? knownSession(cwd, session) : null;
  const now = clock();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new CandidateError('candidate clock returned an invalid date', {
      code: 'INVALID_CANDIDATE_CLOCK',
    });
  }

  let fact;
  const update = await store.update({
    operation: `void candidate ${id}`,
    auditData: {
      kind: 'candidate',
      action: 'void',
      requirementId: safeId,
      candidateId: id,
      reason: reason.trim(),
    },
    mutate(snapshot) {
      const current = validCandidateFact(snapshot, safeId, id);
      if (!current) {
        throw new CandidateError(`candidate not found: ${id}`, {
          code: 'CANDIDATE_NOT_FOUND',
          data: { requirementId: safeId, candidateId: id },
        });
      }
      fact = {
        ...current,
        status: 'voided',
        voidReason: reason.trim(),
        voidedAt: now.toISOString(),
        ...(localSession ? { voidedBy: actor(localSession) } : {}),
      };
      snapshot.writeJson(candidatePath(safeId, id), fact);
    },
  });

  return {
    ...fact,
    operationId: update.operationId,
    coordinationSha: update.sha,
  };
}
