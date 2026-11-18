import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { assertRequirementId, assertVersion } from './validation.mjs';

const SHA = /^[a-f0-9]{40}$/;
const TRAIN_BRANCH = /^train\/v\d+\.\d+\.\d+$/;
const TRAIN_STATUSES = new Set(['open', 'candidate', 'merged', 'closed']);

export class TrainError extends Error {
  constructor(message, { code = 'INVALID_TRAIN', exitCode = 14, data = {}, cause } = {}) {
    super(message, { cause });
    this.name = 'TrainError';
    this.code = code;
    this.exitCode = exitCode;
    this.data = data;
  }
}

function validVersion(version) {
  try { return assertVersion(version); } catch (cause) {
    throw new TrainError(cause.message, { code: 'INVALID_VERSION', cause });
  }
}

function validSha(value, name) {
  if (!SHA.test(value ?? '')) throw new TrainError(`${name} must be a full 40-character SHA`, { code: 'INVALID_TRAIN_COMMIT' });
  return value;
}

export function trainBranch(version) {
  return `train/${validVersion(version)}`;
}

export function trainPath(version) {
  return `versions/${validVersion(version)}.json`;
}

function runGit(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    if (allowFailure) return null;
    throw new TrainError(`git ${args.join(' ')} failed: ${(result.stderr || result.error?.message || '').trim()}`, {
      code: 'GIT_TRAIN_ERROR',
      exitCode: 13,
      cause: result.error,
    });
  }
  return result.stdout.trim();
}

function resolveCommit(cwd, ref) {
  try { return runGit(cwd, ['rev-parse', '--verify', `${ref}^{commit}`]); } catch (cause) {
    throw new TrainError(`invalid train base ref: ${ref}`, { code: 'INVALID_TRAIN_BASE', cause });
  }
}

function isAncestor(cwd, ancestor, descendant) {
  return spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
    cwd,
    stdio: ['ignore', 'ignore', 'ignore'],
  }).status === 0;
}

function readVersion(snapshot, version) {
  const normalized = validVersion(version);
  const path = trainPath(normalized);
  if (!snapshot.has(path)) throw new TrainError(`version is not registered: ${normalized}`, { code: 'VERSION_NOT_FOUND' });
  const fact = snapshot.readJson(path);
  if (!fact || typeof fact !== 'object' || fact.version !== normalized || !Array.isArray(fact.requirements)) {
    throw new TrainError(`invalid version fact: ${normalized}`, { code: 'INVALID_VERSION_FACT' });
  }
  return { path, fact };
}

export function validateTrainFact(fact, version) {
  const normalized = validVersion(version ?? fact?.version);
  if (!fact || typeof fact !== 'object' || fact.version !== normalized) throw new TrainError('invalid train fact', { code: 'INVALID_TRAIN_STATE' });
  if (!TRAIN_BRANCH.test(fact.branch ?? '') || fact.branch !== trainBranch(normalized)) throw new TrainError('train fact has an invalid branch', { code: 'INVALID_TRAIN_STATE' });
  validSha(fact.baseCommit, 'baseCommit');
  if (fact.candidateCommit !== null) validSha(fact.candidateCommit, 'candidateCommit');
  if (!TRAIN_STATUSES.has(fact.status)) throw new TrainError(`invalid train status: ${fact.status}`, { code: 'INVALID_TRAIN_STATE' });
  if (!Array.isArray(fact.members) || fact.members.some((id) => { try { assertRequirementId(id); return false; } catch { return true; } })) {
    throw new TrainError('train members must be requirement ids', { code: 'INVALID_TRAIN_STATE' });
  }
  return fact;
}

function currentBranchRef(cwd, branch, remote) {
  return runGit(cwd, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`], { allowFailure: true })
    ?? runGit(cwd, ['rev-parse', '--verify', `refs/remotes/${remote}/${branch}^{commit}`], { allowFailure: true });
}

function pushBranch(cwd, remote, branch) {
  try {
    runGit(cwd, ['push', '--no-verify', remote, `${branch}:refs/heads/${branch}`]);
  } catch (cause) {
    throw new TrainError(`unable to publish ${branch}`, { code: 'TRAIN_BRANCH_PUBLISH_FAILED', exitCode: 13, cause });
  }
}

export async function createTrain({ store, cwd, version, base = 'origin/main', clock = () => new Date() }) {
  const normalized = validVersion(version);
  const branch = trainBranch(normalized);
  const baseCommit = resolveCommit(cwd, base);
  const existingBranch = currentBranchRef(cwd, branch, store.remote);
  if (existingBranch && existingBranch !== baseCommit) {
    throw new TrainError(`${branch} already exists at ${existingBranch}, expected ${baseCommit}`, { code: 'TRAIN_BRANCH_EXISTS' });
  }
  if (!existingBranch) {
    runGit(cwd, ['branch', branch, baseCommit]);
    pushBranch(cwd, store.remote, branch);
  } else if (!runGit(cwd, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`], { allowFailure: true })) {
    runGit(cwd, ['branch', branch, `${store.remote}/${branch}`]);
  }
  const repositoryRoot = runGit(cwd, ['rev-parse', '--show-toplevel']);
  const worktreePath = join(repositoryRoot, '.worktrees', `train-${normalized}`);
  mkdirSync(join(repositoryRoot, '.worktrees'), { recursive: true });
  if (!existsSync(worktreePath)) runGit(cwd, ['worktree', 'add', worktreePath, branch]);
  else if (runGit(worktreePath, ['branch', '--show-current']) !== branch) {
    throw new TrainError(`${worktreePath} is already a worktree for another branch`, { code: 'TRAIN_WORKTREE_CONFLICT' });
  }
  let train;
  const result = await store.update({
    operation: `create train ${normalized}`,
    auditData: { kind: 'train', version: normalized, branch, baseCommit },
    mutate(snapshot) {
      const { path, fact } = readVersion(snapshot, normalized);
      if (fact.train) {
        validateTrainFact(fact.train, normalized);
        if (fact.train.baseCommit !== baseCommit || fact.train.branch !== branch) throw new TrainError(`${normalized} already has a different train`, { code: 'TRAIN_ALREADY_BOUND' });
        train = fact.train;
        return;
      }
      const now = clock().toISOString();
      train = {
        schemaVersion: 1,
        version: normalized,
        branch,
        baseCommit,
        candidateCommit: null,
        status: 'open',
        members: [...new Set(fact.requirements)].sort(),
        createdAt: now,
        updatedAt: now,
      };
      snapshot.writeJson(path, { ...fact, train });
    },
  });
  return { version: normalized, branch, path: worktreePath, train, ...result };
}

export async function addTrainMember({ store, version, requirementId, clock = () => new Date() }) {
  const normalized = validVersion(version);
  const id = (() => { try { return assertRequirementId(requirementId); } catch (cause) { throw new TrainError(cause.message, { code: 'INVALID_REQUIREMENT_ID', cause }); } })();
  let train;
  const result = await store.update({
    operation: `add ${id} to train ${normalized}`,
    auditData: { kind: 'train-member', version: normalized, requirementId: id },
    mutate(snapshot) {
      const versionFact = readVersion(snapshot, normalized).fact;
      if (!versionFact.train) throw new TrainError(`${normalized} has no train; create it first`, { code: 'TRAIN_NOT_FOUND' });
      train = validateTrainFact(versionFact.train, normalized);
      const reqPath = `requirements/${id}.json`;
      if (!snapshot.has(reqPath)) throw new TrainError(`requirement is not coordinated: ${id}`, { code: 'REQUIREMENT_NOT_FOUND' });
      const requirement = snapshot.readJson(reqPath);
      if (requirement.version !== normalized) throw new TrainError(`${id} is bound to ${requirement.version ?? '<unbound>'}, not ${normalized}`, { code: 'TRAIN_VERSION_MISMATCH' });
      if (train.status === 'closed' || train.status === 'merged') throw new TrainError(`${normalized} train is ${train.status}`, { code: 'TRAIN_TERMINAL' });
      const members = [...new Set([...train.members, id])].sort();
      train = { ...train, members, updatedAt: clock().toISOString() };
      snapshot.writeJson(trainPath(normalized), { ...versionFact, train });
    },
  });
  return { version: normalized, requirementId: id, train, ...result };
}

export async function recordTrainCandidate({ store, cwd, version, commit, clock = () => new Date() }) {
  const normalized = validVersion(version);
  const candidateCommit = resolveCommit(cwd, validSha(commit, 'commit'));
  let train;
  const result = await store.update({
    operation: `record train candidate ${normalized}`,
    auditData: { kind: 'train-candidate', version: normalized, candidateCommit },
    mutate(snapshot) {
      const versionFact = readVersion(snapshot, normalized).fact;
      if (!versionFact.train) throw new TrainError(`${normalized} has no train; create it first`, { code: 'TRAIN_NOT_FOUND' });
      train = validateTrainFact(versionFact.train, normalized);
      if (train.status === 'closed' || train.status === 'merged') throw new TrainError(`${normalized} train is ${train.status}`, { code: 'TRAIN_TERMINAL' });
      if (!isAncestor(cwd, train.baseCommit, candidateCommit)) throw new TrainError('candidate commit is not based on the train baseCommit', { code: 'TRAIN_CANDIDATE_OUT_OF_RANGE' });
      if (train.candidateCommit && train.candidateCommit !== candidateCommit) throw new TrainError('candidateCommit is immutable; create a new train candidate after remediation', { code: 'TRAIN_CANDIDATE_IMMUTABLE' });
      train = { ...train, candidateCommit, status: 'candidate', updatedAt: clock().toISOString() };
      snapshot.writeJson(trainPath(normalized), { ...versionFact, train });
    },
  });
  return { version: normalized, candidateCommit, train, ...result };
}

export async function promoteTrainCandidate({ store, cwd, version, commit, clock = () => new Date() }) {
  const normalized = validVersion(version);
  const releaseCommit = resolveCommit(cwd, validSha(commit, 'commit'));
  let train;
  const result = await store.update({
    operation: `promote train ${normalized}`,
    auditData: { kind: 'train-promote', version: normalized, releaseCommit },
    mutate(snapshot) {
      const versionFact = readVersion(snapshot, normalized).fact;
      if (!versionFact.train) throw new TrainError(`${normalized} has no train`, { code: 'TRAIN_NOT_FOUND' });
      train = validateTrainFact(versionFact.train, normalized);
      if (train.status !== 'candidate') throw new TrainError('train must be in candidate status before promotion', { code: 'TRAIN_CANDIDATE_REQUIRED' });
      if (!isAncestor(cwd, train.candidateCommit, releaseCommit)) throw new TrainError('release commit must contain the recorded train candidate', { code: 'TRAIN_PROMOTION_OUT_OF_RANGE' });
      train = { ...train, candidateCommit: releaseCommit, status: 'merged', updatedAt: clock().toISOString() };
      snapshot.writeJson(trainPath(normalized), { ...versionFact, train });
    },
  });
  return { version: normalized, releaseCommit, train, ...result };
}

export async function closeTrain({ store, version, clock = () => new Date() }) {
  const normalized = validVersion(version);
  let train;
  const result = await store.update({
    operation: `close train ${normalized}`,
    auditData: { kind: 'train-close', version: normalized },
    mutate(snapshot) {
      const versionFact = readVersion(snapshot, normalized).fact;
      if (!versionFact.train) throw new TrainError(`${normalized} has no train`, { code: 'TRAIN_NOT_FOUND' });
      train = validateTrainFact(versionFact.train, normalized);
      train = { ...train, status: 'closed', updatedAt: clock().toISOString() };
      snapshot.writeJson(trainPath(normalized), { ...versionFact, train });
    },
  });
  return { version: normalized, train, ...result };
}

export async function showTrain({ store, version }) {
  const snapshot = await store.readSnapshot();
  const { fact } = readVersion(snapshot, version);
  return fact.train ? validateTrainFact(fact.train, version) : null;
}

export async function resolveTrainBaseline({ store, cwd, version }) {
  const train = await showTrain({ store, version });
  if (!train) return null;
  const commit = train.candidateCommit ?? train.baseCommit;
  validSha(commit, 'train baseline');
  resolveCommit(cwd, commit);
  return { version: train.version, branch: train.branch, status: train.status, baseCommit: train.baseCommit, candidateCommit: train.candidateCommit, commit };
}
