import assert from 'node:assert/strict';
import test from 'node:test';
const execution = await import('../../lib/coordination/test-execution.mjs').catch(() => ({}));

test('test failures classify deterministic configuration and only transient network is retryable', () => {
  assert.equal(typeof execution.classifyTestFailure, 'function');
  for (const [stderr, kind] of [['sh: vitest: command not found', 'readiness'], ["Table 'luggage.ord_orders' doesn't exist", 'schema'], ['AssertionError: expected 1 got 0', 'product'], ['cleanup failed: missing fixture', 'fixture'], ['terminated SIGTERM', 'interrupted'], ['unrecognized failure', 'unknown']]) {
    const failure = execution.classifyTestFailure({ exitCode: 1, stderr });
    assert.equal(failure.kind, kind); assert.equal(failure.retryable, false);
  }
  assert.equal(execution.classifyTestFailure({ exitCode: 1, stderr: 'connect ETIMEDOUT' }).retryable, true);
  assert.equal(execution.classifyTestFailure({ exitCode: 1, stderr: 'AssertionError: expected ETIMEDOUT' }).retryable, false);
});

test('local checks are independent of lease and deploy; shared checks keep immutable identity', () => {
  assert.equal(typeof execution.checkEnvironmentIdentity, 'function');
  const env = { kind: 'shared-dev', devLease: { expiresAt: 'old' }, devSnapshot: { commit: 'a', schema: 1 }, targets: { api: 'dev' } };
  assert.equal(execution.checkEnvironmentIdentity(['pnpm', 'run', 'lint'], env), null);
  assert.deepEqual(execution.checkEnvironmentIdentity(['pnpm', 'e2e'], env), execution.checkEnvironmentIdentity(['pnpm', 'e2e'], { ...env, devLease: { expiresAt: 'new' } }));
  assert.notDeepEqual(execution.checkEnvironmentIdentity(['pnpm', 'e2e'], env), execution.checkEnvironmentIdentity(['pnpm', 'e2e'], { ...env, devSnapshot: { commit: 'b', schema: 2 } }));
});

test('explicit assertion failures cannot be masked by environment keywords elsewhere in a suite log', () => {
  for (const unrelated of ["Table 'luggage.ord_orders' doesn't exist", 'vitest: command not found', 'cleanup failed', 'connect ETIMEDOUT']) {
    const failure = execution.classifyTestFailure({ exitCode: 1,
      stdout: `passing fixture exercised: ${unrelated}\nAssertionError [ERR_ASSERTION]: parent repository must not change` });
    assert.equal(failure.kind, 'product');
    assert.equal(failure.retryable, false);
  }
});

test('resource budget serializes heavy and unknown commands, independent lightweight checks can overlap', () => {
  assert.equal(typeof execution.executionBatches, 'function');
  const commands = [['pnpm', 'build'], ['pnpm', 'test:admin'], ['bash', 'scripts/unknown.sh'], ['bash', 'scripts/test-release-flow.sh'], ['bash', 'scripts/test-release-services.sh']];
  const batches = execution.executionBatches(commands, { budget: 2 });
  assert.deepEqual(batches.map(batch => batch.length), [1, 1, 1, 2]);
});

test('local checks keep caller environment while only shared commands receive mixed execution overrides', () => {
  const args = { requirement: { id: 'I-002', acceptanceWorkflowVersion: 1 }, profile: 'runtime',
    environment: { kind: 'mixed-dev', mixedEnvironment: { frontend: { app: 'admin', baseUrl: 'http://127.0.0.1:13112' } } },
    env: { E2E_DEVELOPMENT_ITERATION: '1', API_BASE_URL: 'caller-value' } };
  assert.deepEqual(execution.commandExecutionEnvironment({ ...args, argv: ['pnpm', 'test:admin'] }), { ...args.env, GIT_TERMINAL_PROMPT: '0' });
  const shared = execution.commandExecutionEnvironment({ ...args, argv: ['pnpm', 'e2e'] });
  assert.equal(shared.E2E_DEVELOPMENT_ITERATION, '0');
  assert.equal(shared.API_BASE_URL, 'https://api-dev.hongli-ruian.com/api');
  assert.equal(shared.E2E_EXPECTATIONS_REQUIRED, '1');
  assert.equal(shared.ADMIN_BASE_URL, 'http://127.0.0.1:13112');
});
