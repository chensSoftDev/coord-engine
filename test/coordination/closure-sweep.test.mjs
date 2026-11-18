import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateClosure } from '../../lib/coordination/closure-sweep.mjs';

test('closure sweep reports terminal refs and unresolved high-severity issues', () => {
  const result = evaluateClosure({
    requirements: [{ id: 'I-001', lifecycle: 'done', branch: 'feature/I-001/fix', mergeStatus: 'merged', mergedCommit: 'a'.repeat(40) }],
    trains: [{ version: 'v0.35.0', branch: 'train/v0.35.0', status: 'closed' }],
    remoteBranches: new Set(['feature/I-001/fix', 'train/v0.35.0']),
    worktrees: [{ path: '/tmp/I-001-fix', branch: 'feature/I-001/fix' }],
    mainCommit: 'b'.repeat(40),
    isAncestor: () => false,
    issues: [{ version: 'v0.35.0', issueId: 'VI-001', severity: 'P1', status: 'open' }],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings.map((finding) => finding.code).sort(), [
    'FEATURE_REMOTE_REF_REMAINS',
    'FEATURE_WORKTREE_REMAINS',
    'MERGED_COMMIT_NOT_IN_MAIN',
    'TRAIN_REMOTE_REF_REMAINS',
    'VERSION_ISSUE_REMAINS',
  ]);
});

test('closure sweep passes after terminal refs and issues are resolved', () => {
  const result = evaluateClosure({
    requirements: [{ id: 'I-001', lifecycle: 'done', branch: 'feature/I-001/fix', mergeStatus: 'merged', mergedCommit: 'a'.repeat(40) }],
    trains: [{ version: 'v0.35.0', branch: 'train/v0.35.0', status: 'closed' }],
    remoteBranches: new Set(),
    worktrees: [],
    mainCommit: 'b'.repeat(40),
    isAncestor: () => true,
    issues: [{ version: 'v0.35.0', issueId: 'VI-001', severity: 'P1', status: 'resolved' }],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.findings, []);
});
