import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { coordinationStats } from '../../lib/coordination/stats.mjs';

function makeSnapshot() {
  const files = new Map([
    ['requirements/I-001.json', {
      id: 'I-001', lifecycle: 'in_dev', deliveryProfile: 'tooling', version: 'v0.35.0',
    }],
    ['requirements/B-002.json', {
      id: 'B-002', lifecycle: 'test_passed', deliveryProfile: 'runtime', version: 'v0.35.0',
    }],
    ['versions/v0.35.0.json', {
      version: 'v0.35.0', requirements: ['I-001', 'B-002'], train: {
        branch: 'train/v0.35.0', status: 'candidate', members: ['B-002', 'I-001'],
        baseCommit: 'a'.repeat(40), candidateCommit: 'b'.repeat(40),
      },
    }],
  ]);
  return {
    paths: () => [...files.keys()],
    readJson: (path) => files.get(path),
  };
}

test('coordination stats aggregate requirements, trains and version issues', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'coord-stats-'));
  const issues = join(cwd, 'docs/releases/PENDING/v0.35.0/iteration-issues');
  mkdirSync(issues, { recursive: true });
  writeFileSync(join(issues, 'VI-001.json'), JSON.stringify({
    schemaVersion: 1, issueId: 'VI-001', version: 'v0.35.0', requirementIds: ['I-001'],
    category: 'correction', severity: 'P1', status: 'open', phase: 'testing',
    detectedAt: '2026-11-08T00:00:00Z', detectedBy: { agent: 'test', user: 'developer' },
    summary: 'summary', symptom: 'symptom', impact: 'impact',
    reproduction: { command: ['pnpm test'], environment: 'local', steps: ['run'] },
    rootCause: null, decision: null, fixPlan: { ownerRequirementId: 'I-001', dependsOn: [], acceptance: ['fixed'] },
    verification: { commands: [], evidence: [], verifiedAt: null },
    timeline: [{ at: '2026-11-08T00:00:00Z', status: 'open', actor: 'test', note: 'detected' }],
  }));
  const result = coordinationStats({ cwd, snapshot: makeSnapshot(), branchAudit: { findings: [], summary: { errors: 0 } } });
  assert.equal(result.requirements.total, 2);
  assert.equal(result.trains.byStatus.candidate, 1);
  assert.deepEqual(result.issues.unresolvedP0P1, [{ version: 'v0.35.0', issueId: 'VI-001', severity: 'P1', status: 'open' }]);
});
