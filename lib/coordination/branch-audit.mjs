import { basename } from 'node:path';
import { spawnSync } from 'node:child_process';

import { requirementDocuments } from './requirements.mjs';

const REQUIREMENT_FEATURE_BRANCH = /^feature\/((?:I|F|B)-\d{3,})\/[a-z0-9][a-z0-9-]{0,62}$/;
const LEGACY_FEATURE_BRANCH = /^feature\/v\d+\.\d+\.\d+\/[a-z0-9][a-z0-9-]{0,62}$/;
const TRAIN_BRANCH = /^train\/v\d+\.\d+\.\d+$/;
const ACTIVE_LIFECYCLES = new Set(['reviewing', 'req_confirmed', 'tech_design', 'in_dev', 'dev_deployed', 'testing', 'test_passed', 'prod_planning', 'prod_deployed', 'merged']);

function gitLines(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.error?.message || 'git command failed').trim();
    throw new Error(`git ${args.join(' ')} failed: ${detail}`);
  }
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

function remoteBranches(cwd, remote) {
  return new Set(gitLines(cwd, [
    'for-each-ref', `refs/remotes/${remote}`, '--format=%(refname:strip=3)',
  ]).filter((branch) => branch !== 'HEAD'));
}

function worktrees(cwd) {
  const entries = [];
  let current = null;
  for (const line of gitLines(cwd, ['worktree', 'list', '--porcelain'])) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), branch: null };
      entries.push(current);
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    }
  }
  return entries;
}

function finding(code, message, data = {}) {
  return { code, message, ...data };
}

function branchKind(branch) {
  if (branch === 'main') return 'main';
  if (REQUIREMENT_FEATURE_BRANCH.test(branch)) return 'requirement';
  if (LEGACY_FEATURE_BRANCH.test(branch)) return 'legacy-feature';
  if (TRAIN_BRANCH.test(branch)) return 'train';
  if (branch?.startsWith('automation/')) return 'automation';
  return 'other';
}

export function auditBranches({ cwd, snapshot, remote = 'origin' }) {
  const requirements = requirementDocuments(snapshot);
  const byId = new Map(requirements.map((requirement) => [requirement.id, requirement]));
  const byBranch = new Map();
  const findings = [];
  const refs = remoteBranches(cwd, remote);
  const localWorktrees = worktrees(cwd);
  const repositoryRoot = gitLines(cwd, ['rev-parse', '--show-toplevel'])[0];
  const primary = localWorktrees.find((worktree) => worktree.path === repositoryRoot);
  if (primary && primary.branch !== 'main') {
    findings.push(finding('PRIMARY_WORKTREE_NOT_MAIN', `${repositoryRoot} is checked out on ${primary.branch ?? '<detached>'}; keep the primary checkout on main`, { path: repositoryRoot, branch: primary.branch }));
  }
  for (const path of snapshot.paths().filter((candidate) => /^versions\/v\d+\.\d+\.\d+\.json$/.test(candidate))) {
    const versionFact = snapshot.readJson(path);
    const train = versionFact.train;
    if (!train) continue;
    const branch = train.branch ?? `train/${versionFact.version}`;
    if (!refs.has(branch)) findings.push(finding('TRAIN_REMOTE_BRANCH_MISSING', `${remote}/${branch} is missing for ${versionFact.version}`, { version: versionFact.version, branch }));
    if (train.candidateCommit && spawnSync('git', ['merge-base', '--is-ancestor', train.baseCommit, train.candidateCommit], { cwd, stdio: ['ignore', 'ignore', 'ignore'] }).status !== 0) {
      findings.push(finding('TRAIN_CANDIDATE_OUT_OF_RANGE', `${versionFact.version} candidate is not based on baseCommit`, { version: versionFact.version, branch, baseCommit: train.baseCommit, candidateCommit: train.candidateCommit }));
    }
  }

  for (const requirement of requirements) {
    const branch = requirement.branch ?? null;
    if (!branch) {
      if (ACTIVE_LIFECYCLES.has(requirement.lifecycle)) {
        findings.push(finding('BRANCH_MISSING', `${requirement.id} has no branch binding`, { requirementId: requirement.id }));
      }
      continue;
    }
    const owners = byBranch.get(branch) ?? [];
    owners.push(requirement.id);
    byBranch.set(branch, owners);
    const kind = branchKind(branch);
    if (kind === 'main') {
      findings.push(finding('MAIN_BOUND', `${requirement.id} is bound to main`, { requirementId: requirement.id, branch }));
    } else if (kind === 'requirement') {
      const id = REQUIREMENT_FEATURE_BRANCH.exec(branch)[1];
      if (id !== requirement.id) {
        findings.push(finding('BRANCH_ID_MISMATCH', `${requirement.id} is bound to ${branch}`, { requirementId: requirement.id, branch, branchRequirementId: id }));
      }
    } else if (kind === 'legacy-feature') {
      findings.push(finding('LEGACY_VERSION_BRANCH', `${requirement.id} uses a version-derived feature branch`, { requirementId: requirement.id, branch }));
    } else if (kind === 'automation') {
      findings.push(finding('AUTOMATION_BRANCH_BINDING', `${requirement.id} is bound to an automation branch`, { requirementId: requirement.id, branch }));
    } else if (kind === 'train') {
      findings.push(finding('REQUIREMENT_BOUND_TO_TRAIN', `${requirement.id} is bound directly to a Version train`, { requirementId: requirement.id, branch }));
    } else if (kind !== 'train') {
      findings.push(finding('UNKNOWN_BRANCH_KIND', `${requirement.id} uses an unsupported branch name`, { requirementId: requirement.id, branch }));
    }
    if (!refs.has(branch) && !['done', 'cancelled'].includes(requirement.lifecycle)) {
      findings.push(finding('REMOTE_BRANCH_MISSING', `${remote}/${branch} is missing for active ${requirement.id}`, { requirementId: requirement.id, branch }));
    }
  }

  for (const [branch, owners] of byBranch) {
    if (owners.length > 1) {
      findings.push(finding('DUPLICATE_BRANCH_BINDING', `${branch} is shared by ${owners.join(', ')}`, { branch, requirementIds: owners }));
    }
  }

  for (const worktree of localWorktrees) {
    if (!worktree.branch) continue;
    const kind = branchKind(worktree.branch);
    if (!['requirement', 'legacy-feature', 'automation', 'train'].includes(kind)) continue;
    const match = REQUIREMENT_FEATURE_BRANCH.exec(worktree.branch);
    const requirement = match ? byId.get(match[1]) : requirements.find((candidate) => candidate.branch === worktree.branch);
    if (kind === 'train') {
      const version = worktree.branch.slice('train/'.length);
      if (!snapshot.has(`versions/${version}.json`)) {
        findings.push(finding('UNREGISTERED_TRAIN_WORKTREE', `${worktree.path} uses unregistered ${worktree.branch}`, { path: worktree.path, branch: worktree.branch, version }));
      }
      continue;
    }
    if (!requirement) {
      findings.push(finding('ORPHAN_WORKTREE', `${worktree.path} has no coordinated requirement`, { path: worktree.path, branch: worktree.branch, basename: basename(worktree.path) }));
    } else if (requirement.branch !== worktree.branch && requirement.mergeStatus !== 'merged') {
      findings.push(finding('WORKTREE_BRANCH_MISMATCH', `${worktree.path} does not match ${requirement.id} binding`, { path: worktree.path, branch: worktree.branch, requirementId: requirement.id, expectedBranch: requirement.branch }));
    }
  }

  for (const branch of refs) {
    const kind = branchKind(branch);
    if (kind === 'train') {
      const version = branch.slice('train/'.length);
      if (!snapshot.has(`versions/${version}.json`)) {
        findings.push(finding('UNREGISTERED_TRAIN_BRANCH', `${remote}/${branch} has no registered Version`, { branch, version }));
      }
    } else if (['requirement', 'legacy-feature', 'automation'].includes(kind) && !byBranch.has(branch)) {
      findings.push(finding('ORPHAN_REMOTE_BRANCH', `${remote}/${branch} has no coordination owner`, { branch }));
    }
  }

  return {
    ok: findings.length === 0,
    remote,
    requirements: requirements.length,
    remoteBranches: [...refs].sort(),
    worktrees: localWorktrees,
    findings,
    summary: {
      errors: findings.length,
      legacy: findings.filter((item) => item.code === 'LEGACY_VERSION_BRANCH').length,
      duplicates: findings.filter((item) => item.code === 'DUPLICATE_BRANCH_BINDING').length,
      orphaned: findings.filter((item) => item.code.startsWith('ORPHAN_') || item.code.startsWith('UNREGISTERED_')).length,
    },
  };
}
