import assert from 'node:assert/strict';
import test from 'node:test';

import { auditBranches } from '../../lib/coordination/branch-audit.mjs';
import { createGitFixture, runGit } from './fixtures.mjs';

test('branch audit reports a primary checkout drift and missing registered train ref', (t) => {
  const fixture = createGitFixture(t);
  runGit(fixture.clientA, ['switch', '-c', 'feature/I-001/example']);
  const snapshot = {
    paths: () => ['requirements/I-001.json', 'versions/v0.35.0.json'],
    readJson(path) {
      if (path === 'requirements/I-001.json') {
        return { id: 'I-001', lifecycle: 'in_dev', branch: 'feature/I-001/example' };
      }
      return {
        version: 'v0.35.0', requirements: ['I-001'], train: {
          version: 'v0.35.0', branch: 'train/v0.35.0', baseCommit: runGit(fixture.clientA, ['rev-parse', 'main']), candidateCommit: null, status: 'open', members: ['I-001'],
        },
      };
    },
  };
  const result = auditBranches({ cwd: fixture.clientA, snapshot, remote: 'origin' });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((finding) => finding.code === 'PRIMARY_WORKTREE_NOT_MAIN'));
  assert.ok(result.findings.some((finding) => finding.code === 'TRAIN_REMOTE_BRANCH_MISSING'));
});
