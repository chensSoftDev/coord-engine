import assert from 'node:assert/strict';
import test from 'node:test';
const plan = await import('../../lib/coordination/delivery-plan.mjs').catch(() => ({}));

test('delivery target includes waiting and overlapping execution is not counted twice', () => {
  assert.equal(typeof plan.deliveryProgress, 'function');
  const result = plan.deliveryProgress({ requirement: { lifecycle: 'user_acceptance', lifecycleHistory: [
    { to: 'tech_design', at: '2026-11-04T00:00:00Z' },
    { to: 'user_acceptance', at: '2026-11-04T07:00:00Z' },
  ] }, now: new Date('2026-11-04T09:00:00Z'), intervals: [
    { kind: 'execution', start: '2026-11-04T01:00:00Z', end: '2026-11-04T02:00:00Z' },
    { kind: 'execution', start: '2026-11-04T01:30:00Z', end: '2026-11-04T02:30:00Z' },
  ] });
  assert.equal(result.elapsedMinutes, 540);
  assert.equal(result.overdueMinutes, 60);
  assert.equal(result.breakdown.executionMinutes, 90);
  assert.equal(result.breakdown.humanWaitMinutes, 120);
  assert.equal(result.breakdown.unattributedMinutes, 330);
  assert.equal(result.targetMinutes, 480);
  assert.equal(Object.values(result.budgets).reduce((sum, item) => sum + item, 0), 480);
});

test('a rework does not reset delivery start and production verification stops the clock', () => {
  assert.equal(typeof plan.deliveryProgress, 'function');
  const result = plan.deliveryProgress({ requirement: { lifecycleHistory: [
    { to: 'tech_design', at: '2026-11-04T00:00:00Z' },
    { to: 'tech_design', at: '2026-11-04T03:00:00Z' },
    { to: 'prod_deployed', at: '2026-11-04T07:30:00Z' },
  ] }, uxApproval: { authorizedAt: '2026-11-04T03:00:00Z' }, now: new Date('2026-11-05T00:00:00Z') });
  assert.equal(result.elapsedMinutes, 450);
  assert.equal(result.completed, true);
  assert.equal(result.targetMet, true);
  assert.equal(plan.deliveryProgress({ requirement: {}, now: new Date() }).elapsedMinutes, null);
});

test('stage work names completion, required inputs, early work and human stop', () => {
  assert.equal(typeof plan.stageWork, 'function');
  for (const state of ['tech_design', 'in_dev', 'testing', 'user_acceptance', 'prod_planning']) {
    const work = plan.stageWork(state);
    assert.ok(work.doneWhen.length);
    assert.ok(work.inputs.length);
    assert.ok(work.prepareEarly.length);
  }
  assert.equal(plan.stageWork('user_acceptance').humanDecision, true);
  assert.equal(plan.stageWork('prod_planning').humanDecision, true);
});
