import assert from 'node:assert/strict';
import test from 'node:test';
import { guardSharedEnvironment } from '../../lib/coordination/guard.mjs';

test('production workflow review is checked before a lease or reusable ticket can authorize side effects', async () => {
  let asserted = false;
  let workflowChecked = false;
  const options = { stage: 'prod', requirementId: 'I-002', targets: [],
    checkWorkflow: async () => { workflowChecked = true; throw Object.assign(new Error('release review missing'), { code: 'REVIEW_MISSING' }); },
    assertLease: async () => { asserted = true; return {}; } };
  await assert.rejects(guardSharedEnvironment(options), { code: 'REVIEW_MISSING' });
  assert.equal(workflowChecked, true);
  assert.equal(asserted, false);
  await assert.rejects(guardSharedEnvironment({ ...options, ticket: 'a-ticket', validateTicket: async () => ({}) }), { code: 'REVIEW_MISSING' });
});
