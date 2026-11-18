import { requirementDocuments } from './requirements.mjs';
import { listVersionIssues } from './version-issues.mjs';

function increment(map, key) {
  map[key] = (map[key] ?? 0) + 1;
}

function counts(values) {
  return values.reduce((result, value) => {
    increment(result, value ?? 'unknown');
    return result;
  }, {});
}

export function coordinationStats({ cwd, snapshot, branchAudit = null }) {
  const requirements = requirementDocuments(snapshot);
  const versions = new Map();
  for (const requirement of requirements) {
    const version = requirement.version ?? '<unbound>';
    const entry = versions.get(version) ?? { version, requirements: [], lifecycle: {}, profiles: {} };
    entry.requirements.push(requirement.id);
    increment(entry.lifecycle, requirement.lifecycle);
    increment(entry.profiles, requirement.deliveryProfile);
    versions.set(version, entry);
  }
  const issueList = [];
  for (const version of versions.keys()) {
    if (version === '<unbound>') continue;
    try {
      issueList.push(...listVersionIssues({ cwd, version }).issues);
    } catch {
      // A malformed issue is reported as a blocking invalid record by the
      // gate; stats keeps the rest of the Version summary available.
    }
  }
  const trainFacts = [...snapshot.paths()]
    .filter((path) => /^versions\/v\d+\.\d+\.\d+\.json$/.test(path))
    .map((path) => snapshot.readJson(path))
    .filter((fact) => fact.train)
    .map((fact) => ({
      version: fact.version,
      branch: fact.train.branch,
      status: fact.train.status,
      members: fact.train.members ?? fact.requirements ?? [],
      baseCommit: fact.train.baseCommit,
      candidateCommit: fact.train.candidateCommit,
    }));
  return {
    requirements: {
      total: requirements.length,
      byLifecycle: counts(requirements.map((requirement) => requirement.lifecycle)),
      byProfile: counts(requirements.map((requirement) => requirement.deliveryProfile)),
      byVersion: counts(requirements.map((requirement) => requirement.version ?? '<unbound>')),
    },
    versions: [...versions.values()].map((entry) => ({
      ...entry,
      requirements: entry.requirements.sort(),
    })).sort((left, right) => left.version.localeCompare(right.version)),
    trains: {
      total: trainFacts.length,
      byStatus: counts(trainFacts.map((train) => train.status)),
      items: trainFacts.sort((left, right) => left.version.localeCompare(right.version)),
    },
    issues: {
      total: issueList.length,
      bySeverity: counts(issueList.map((issue) => issue.severity)),
      byStatus: counts(issueList.map((issue) => issue.status)),
      byCategory: counts(issueList.map((issue) => issue.category)),
      unresolvedP0P1: issueList
        .filter((issue) => ['P0', 'P1'].includes(issue.severity) && ['open', 'mitigated'].includes(issue.status))
        .map((issue) => ({ version: issue.version, issueId: issue.issueId, severity: issue.severity, status: issue.status }))
        .sort((left, right) => `${left.version}/${left.issueId}`.localeCompare(`${right.version}/${right.issueId}`)),
    },
    ...(branchAudit ? {
      branches: {
        findings: branchAudit.findings.length,
        summary: branchAudit.summary,
      },
    } : {}),
  };
}
