import test from 'node:test';

import { runGit } from './fixtures.mjs';
import {
  REQUIREMENT_ID,
  expectGateFailure,
  setupFeatureGate,
  writeDocument,
} from './gate-fixtures.mjs';

// I-275：版本列车存在未决 P0/P1 iteration issue 时，gate 必须 fail-closed
// （VERSION_ISSUES_UNRESOLVED），防止带病候选进入发布 diff。用例自旧
// gate.test.mjs（已拆分）移植，归属列车/version-issues 主题。
test('version trains fail closed on unresolved P0/P1 iteration issues', async (t) => {
  const context = await setupFeatureGate(t, { uxImpact: 'none' });
  const issuePath = 'docs/releases/PENDING/v0.2.32/iteration-issues/VI-001.json';
  writeDocument(context.fixture.clientA, issuePath, `${JSON.stringify({
    schemaVersion: 1,
    issueId: 'VI-001',
    version: 'v0.2.32',
    requirementIds: [REQUIREMENT_ID],
    category: 'correction',
    severity: 'P1',
    status: 'open',
    phase: 'testing',
    detectedAt: '2026-07-17T00:00:00.000Z',
    detectedBy: { agent: 'gate-test', user: 'developer' },
    summary: 'candidate drift is still present',
    symptom: 'unrelated main changes enter the release diff',
    impact: 'release validation cannot be trusted',
    reproduction: {
      command: ['pnpm coord gate preflight'],
      environment: 'local',
      steps: ['prepare the candidate', 'append another main requirement'],
    },
    rootCause: null,
    decision: null,
    fixPlan: {
      ownerRequirementId: REQUIREMENT_ID,
      dependsOn: [],
      acceptance: ['candidate comparison uses a fixed commit'],
    },
    verification: { commands: [], evidence: [], verifiedAt: null },
    timeline: [{
      at: '2026-07-17T00:00:00.000Z',
      status: 'open',
      actor: 'gate-test',
      note: 'issue detected',
    }],
  }, null, 2)}\n`);
  runGit(context.fixture.clientA, ['add', issuePath]);
  runGit(context.fixture.clientA, ['commit', '-m', 'test: record unresolved version issue']);
  context.head = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  context.event.pull_request.head.sha = context.head;
  await expectGateFailure(context, 'VERSION_ISSUES_UNRESOLVED');
});
