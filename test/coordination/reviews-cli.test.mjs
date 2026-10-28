import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { GitCoordinationStore } from '../../lib/coordination/git-store.mjs';
import { initializeSession } from '../../lib/coordination/worktrees.mjs';
import { createGitFixture, runGit } from './fixtures.mjs';

const command = (await import('../../lib/coordination/commands/review.mjs').catch(() => ({}))).default;
async function setup(t) {
  assert.equal(command?.command, 'review', 'review CLI module is implemented');
  const fixture = createGitFixture(t); const cwd = fixture.clientA;
  const store = new GitCoordinationStore({ cwd, tempRoot: fixture.tempRoot });
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const requirement = { schemaVersion: 1, id: 'I-002', workflowVersion: 2, version: 'v0.9.1', branch: 'main' };
  await store.update({ operation: 'seed review fixture', mutate(snapshot) { snapshot.writeJson('requirements/I-002.json', requirement); } });
  const doc = 'docs/product/current/I-002-task';
  mkdirSync(join(cwd, doc, 'reviews'), { recursive: true });
  writeFileSync(join(cwd, doc, 'FEEDBACK.json'), JSON.stringify({ schemaVersion: 1, requirementId: 'I-002', items: [] }));
  writeFileSync(join(cwd, 'task.mjs'), 'export const task = true;\n');
  runGit(cwd, ['add', '.']); runGit(cwd, ['commit', '-m', 'test: review CLI input']);
  const session = initializeSession({ cwd, agent: 'review-cli-test', user: 'owner', host: 'host' });
  const ctx = { cwd, clock: () => new Date('2026-10-26T00:00:00Z'), env: { COORD_CWD: cwd, COORD_TEMP_ROOT: fixture.tempRoot, COORD_SESSION_ID: session.sessionId } };
  const call = (action, options = {}) => command.subcommands.find((item) => item.key === `review ${action}`).handler({ parsed: { command: 'review', positionals: [action, 'I-002'], options: { stage: 'implementation', ...options } }, ctx });
  return { cwd, store, doc, call };
}

test('prepare/show are read only; record stores a report and show exposes current readiness', async (t) => {
  const s = await setup(t);
  const before = (await s.store.readSnapshot()).sha;
  const prepared = await s.call('prepare'); await s.call('show');
  assert.equal((await s.store.readSnapshot()).sha, before);
  assert.equal(prepared.data.roundsUsed, 0);
  const reportPath = `${s.doc}/reviews/implementation-round-1.json`;
  writeFileSync(join(s.cwd, reportPath), JSON.stringify({ schemaVersion: 1, requirementId: 'I-002', stage: 'implementation',
    subjectFingerprint: prepared.data.subjectFingerprint, verdict: 'pass', findings: [], feedbackIds: [] }));
  const recorded = await s.call('record', { report: reportPath });
  assert.equal(recorded.data.round, 1);
  assert.equal((await s.call('show')).data.readiness.ok, true);
});

test('CLI rejects traversal, symlink reports and malformed JSON before mutation', async (t) => {
  const s = await setup(t);
  const before = (await s.store.readSnapshot()).sha;
  await assert.rejects(s.call('record', { report: '../outside.json' }), { code: 'REVIEW_REPORT_PATH_INVALID' });
  writeFileSync(join(s.cwd, 'report.json'), '{}');
  symlinkSync('report.json', join(s.cwd, 'linked.json'));
  await assert.rejects(s.call('record', { report: 'linked.json' }), { code: 'REVIEW_REPORT_PATH_INVALID' });
  const reportPath = `${s.doc}/reviews/implementation-round-1.json`;
  writeFileSync(join(s.cwd, reportPath), '{invalid');
  await assert.rejects(s.call('record', { report: reportPath }), { code: 'REVIEW_REPORT_INVALID' });
  assert.equal((await s.store.readSnapshot()).sha, before);
});
