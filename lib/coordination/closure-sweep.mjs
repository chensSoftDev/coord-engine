import { auditBranches } from './branch-audit.mjs';
import { requirementDocuments } from './requirements.mjs';
import { listVersionIssues } from './version-issues.mjs';
import { spawnSync } from 'node:child_process';

const TERMINAL = new Set(['done', 'cancelled']);

function finding(code, message, data = {}) {
  return { code, message, ...data };
}

export function evaluateClosure({ requirements, trains, remoteBranches, worktrees, mainCommit = null, isAncestor = () => true, issues = [] }) {
  const findings = [];
  const worktreeBranches = new Set(worktrees.filter((worktree) => worktree.branch).map((worktree) => worktree.branch));
  for (const requirement of requirements) {
    if (!TERMINAL.has(requirement.lifecycle)) continue;
    if (requirement.branch && remoteBranches.has(requirement.branch)) {
      findings.push(finding('FEATURE_REMOTE_REF_REMAINS', `${requirement.id} is terminal but ${requirement.branch} still exists remotely`, {
        requirementId: requirement.id, branch: requirement.branch,
      }));
    }
    if (requirement.branch && worktreeBranches.has(requirement.branch)) {
      findings.push(finding('FEATURE_WORKTREE_REMAINS', `${requirement.id} is terminal but its worktree remains`, {
        requirementId: requirement.id, branch: requirement.branch,
      }));
    }
    if (requirement.mergeStatus === 'merged' && requirement.mergedCommit && mainCommit
      && !isAncestor(requirement.mergedCommit, mainCommit)) {
      findings.push(finding('MERGED_COMMIT_NOT_IN_MAIN', `${requirement.id} merge commit is not reachable from main`, {
        requirementId: requirement.id, mergedCommit: requirement.mergedCommit, mainCommit,
      }));
    }
  }
  for (const train of trains) {
    if (['merged', 'closed'].includes(train.status) && remoteBranches.has(train.branch)) {
      findings.push(finding('TRAIN_REMOTE_REF_REMAINS', `${train.version} train is ${train.status} but ${train.branch} still exists remotely`, {
        version: train.version, branch: train.branch,
      }));
    }
  }
  for (const issue of issues) {
    if (['P0', 'P1'].includes(issue.severity) && ['open', 'mitigated'].includes(issue.status)) {
      findings.push(finding('VERSION_ISSUE_REMAINS', `${issue.version} still has unresolved ${issue.severity} issue ${issue.issueId}`, {
        version: issue.version, issueId: issue.issueId, severity: issue.severity, status: issue.status,
      }));
    }
  }
  return {
    ok: findings.length === 0,
    findings,
    summary: {
      errors: findings.length,
      terminalRequirements: requirements.filter((requirement) => TERMINAL.has(requirement.lifecycle)).length,
      terminalTrains: trains.filter((train) => ['merged', 'closed'].includes(train.status)).length,
      unresolvedP0P1: issues.filter((issue) => ['P0', 'P1'].includes(issue.severity) && ['open', 'mitigated'].includes(issue.status)).length,
    },
  };
}

export function closureSweep({ cwd, snapshot, remote = 'origin' }) {
  const audit = auditBranches({ cwd, snapshot, remote });
  const requirements = requirementDocuments(snapshot);
  const trains = snapshot.paths()
    .filter((path) => /^versions\/v\d+\.\d+\.\d+\.json$/.test(path))
    .map((path) => snapshot.readJson(path).train)
    .filter(Boolean);
  const issues = [...new Set(requirements
    .map((requirement) => requirement.version)
    .filter(Boolean))]
    .flatMap((version) => {
      try { return listVersionIssues({ cwd, version }).issues; } catch { return []; }
    });
  const mainCommitResult = spawnSync('git', ['rev-parse', '--verify', `${remote}/main^{commit}`], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const mainCommit = mainCommitResult.status === 0 ? mainCommitResult.stdout.trim() : null;
  const isAncestor = (ancestor, descendant) => spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
    cwd, stdio: ['ignore', 'ignore', 'ignore'],
  }).status === 0;
  const result = evaluateClosure({
    requirements,
    trains,
    remoteBranches: new Set(audit.remoteBranches),
    worktrees: audit.worktrees,
    mainCommit,
    issues,
    isAncestor,
  });
  return { ...result, branchAudit: audit };
}
