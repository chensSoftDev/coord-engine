import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import {
  listVersionIssues,
  recordVersionIssue,
  updateVersionIssue,
} from '../../lib/coordination/version-issues.mjs';

const clock = () => new Date('2026-11-08T00:00:00.000Z');

function issue(overrides = {}) {
  return {
    schemaVersion: 1,
    issueId: 'VI-001',
    version: 'v0.35.0',
    requirementIds: ['I-275'],
    category: 'correction',
    severity: 'P1',
    status: 'open',
    phase: 'testing',
    detectedAt: '2026-11-08T00:00:00.000Z',
    detectedBy: { agent: 'codex', user: 'developer' },
    summary: 'candidate drift was not explained',
    symptom: 'manifest comparison included unrelated paths',
    impact: 'release validation was blocked',
    reproduction: { command: ['pnpm coord gate preflight'], environment: 'local', steps: ['prepare candidate', 'add a new main requirement'] },
    rootCause: null,
    decision: null,
    fixPlan: { ownerRequirementId: 'I-275', dependsOn: [], acceptance: ['comparison uses the fixed candidate baseline'] },
    verification: { commands: [], evidence: [], verifiedAt: null },
    timeline: [{ at: '2026-11-08T00:00:00.000Z', status: 'open', actor: 'codex', note: 'issue detected' }],
    ...overrides,
  };
}

test('version issues are stored independently and indexed by Version', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'version-issues-'));
  recordVersionIssue({ cwd, version: 'v0.35.0', issue: issue(), clock });
  const result = listVersionIssues({ cwd, version: 'v0.35.0' });
  assert.deepEqual(result.unresolved, ['VI-001']);
  assert.equal(result.issues[0].category, 'correction');
});

test('resolved issues require verification and timeline is append-only', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'version-issues-'));
  recordVersionIssue({ cwd, version: 'v0.35.0', issue: issue(), clock });
  assert.throws(
    () => updateVersionIssue({ cwd, version: 'v0.35.0', issueId: 'VI-001', status: 'resolved', note: 'claimed fixed', actor: 'codex', clock }),
    error => error.code === 'ISSUE_VERIFICATION_REQUIRED',
  );
  const updated = updateVersionIssue({
    cwd,
    version: 'v0.35.0',
    issueId: 'VI-001',
    status: 'resolved',
    note: 'verified against the candidate',
    actor: 'codex',
    rootCause: 'candidate comparison used a floating main reference',
    commands: ['pnpm test:coordination'],
    evidence: ['docs/product/current/I-275-coord-efficiency-closure/TEST_EVIDENCE.json'],
    verifiedAt: '2026-11-08T01:00:00.000Z',
    clock,
  });
  assert.equal(updated.issue.timeline.length, 2);
  assert.deepEqual(listVersionIssues({ cwd, version: 'v0.35.0' }).unresolved, []);
  assert.throws(
    () => updateVersionIssue({ cwd, version: 'v0.35.0', issueId: 'VI-001', status: 'open', note: 'reopen', actor: 'codex', clock }),
    error => error.code === 'VERSION_ISSUE_TERMINAL',
  );
});

test('status changes follow the issue lifecycle and resolved records keep a root cause', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'version-issues-'));
  recordVersionIssue({ cwd, version: 'v0.35.0', issue: issue(), clock });
  assert.throws(
    () => updateVersionIssue({ cwd, version: 'v0.35.0', issueId: 'VI-001', status: 'resolved', note: 'missing root cause', actor: 'codex', commands: ['pnpm test'], evidence: ['evidence.json'], verifiedAt: '2026-11-08T01:00:00.000Z', clock }),
    error => error.code === 'ISSUE_VERIFICATION_REQUIRED',
  );
  const mitigated = updateVersionIssue({ cwd, version: 'v0.35.0', issueId: 'VI-001', status: 'mitigated', note: 'temporary guard is in place', actor: 'codex', clock });
  assert.equal(mitigated.issue.status, 'mitigated');
  assert.throws(
    () => updateVersionIssue({ cwd, version: 'v0.35.0', issueId: 'VI-001', status: 'open', note: 'reopened for a new symptom', actor: 'codex', clock }),
    error => error.code === 'VERSION_ISSUE_INVALID_TRANSITION',
  );
});
