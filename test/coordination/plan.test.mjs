import assert from 'node:assert/strict';
import test from 'node:test';

import { GitCoordinationStore } from '../../lib/coordination/git-store.mjs';
import { main } from '../../lib/coordination/cli.mjs';
import { TRANSITIONS } from '../../lib/coordination/lifecycle.mjs';
import { PLAN_GATES } from '../../lib/coordination/commands/plan.mjs';
import {
  bindRequirementVersion,
  claimRequirement,
} from '../../lib/coordination/requirements.mjs';
import { createGitFixture, createMemoryIo, runGit } from './fixtures.mjs';

// I-132 (F4): plan lists the remaining lifecycle path from the current state
// to done with static gate annotations. It is read-only — no coordination
// write, no commit, no BACKLOG change.

async function setupFixture(t, { profile = 'tooling', lifecycle = 'in_dev' } = {}) {
  const fixture = createGitFixture(t);
  const clock = () => new Date('2026-07-17T00:00:00.000Z');
  const store = new GitCoordinationStore({
    cwd: fixture.clientA,
    remote: 'origin',
    branch: 'coordination',
    tempRoot: fixture.tempRoot,
    clock,
  });
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const claimed = await claimRequirement({
    store,
    type: 'I',
    title: 'Plan requirement',
    profile,
    backlogText: '| I-001 | fixture |\n',
  });
  await bindRequirementVersion({ store, id: claimed.id, version: 'v0.2.32' });
  await store.update({
    operation: `prepare ${claimed.id} lifecycle`,
    mutate(snapshot) {
      const path = `requirements/${claimed.id}.json`;
      snapshot.writeJson(path, { ...snapshot.readJson(path), lifecycle });
    },
  });
  return { fixture, store, id: claimed.id, clock };
}

async function runPlan(context, id = context.id, extra = []) {
  const memory = createMemoryIo();
  const exitCode = await main(['plan', id, ...extra, '--json'], {
    env: {
      ...process.env,
      COORD_CWD: context.fixture.clientA,
      COORD_REMOTE: 'origin',
      COORD_BRANCH: 'coordination',
      COORD_TEMP_ROOT: context.fixture.tempRoot,
    },
    clock: context.clock,
    ...memory.io,
  });
  return { exitCode, memory };
}

test('plan rejects an unclaimed requirement', async (t) => {
  const context = await setupFixture(t);
  const { exitCode, memory } = await runPlan(context, 'I-999');

  assert.equal(exitCode, 14);
  assert.equal(JSON.parse(memory.stderr.join('')).code, 'REQUIREMENT_NOT_FOUND');
});

test('plan rejects an invalid requirement id', async (t) => {
  const context = await setupFixture(t);
  const { exitCode, memory } = await runPlan(context, 'I-57');

  assert.equal(exitCode, 14);
  const error = JSON.parse(memory.stderr.join(''));
  assert.equal(error.code, 'INVALID_REQUIREMENT_ID');
  assert.match(error.message, /invalid requirement id: I-57/);
});

test('plan lists the tooling path from in_dev to done', async (t) => {
  const context = await setupFixture(t);
  const headBefore = runGit(context.fixture.clientA, ['rev-parse', 'HEAD']);
  const shaBefore = (await context.store.readSnapshot()).sha;

  const { exitCode, memory } = await runPlan(context);

  assert.equal(exitCode, 0, memory.stderr.join(''));
  const result = JSON.parse(memory.stdout.join(''));
  assert.equal(result.data.id, context.id);
  assert.equal(result.data.profile, 'tooling');
  assert.equal(result.data.version, 'v0.2.32');
  assert.equal(result.data.lifecycle, 'in_dev');
  assert.equal(result.data.lifecycleLabel, '🔨 In Dev');
  assert.deepEqual(result.data.steps, [
    {
      state: 'in_dev',
      label: '🔨 In Dev',
      command: null,
      gates: 'migration resolved + version bound',
      current: true,
    },
    {
      state: 'testing',
      label: '🧪 Testing',
      command: `pnpm coord lifecycle next ${context.id}`,
      gates: 'migration resolved + version bound + release manifest + migration draft (if required)',
      current: false,
    },
    {
      state: 'test_passed',
      label: '✅ Test Passed',
      command: `pnpm coord lifecycle next ${context.id}`,
      gates: 'migration resolved + version bound + test evidence passed at HEAD',
      current: false,
    },
    {
      state: 'merged',
      label: '✅ Test Passed',
      command: `pnpm coord lifecycle next ${context.id}`,
      gates: 'migration resolved + version bound',
      current: false,
    },
    {
      state: 'done',
      label: '✔️ Done',
      command: `pnpm coord lifecycle next ${context.id}`,
      gates: 'migration resolved + version bound',
      current: false,
    },
  ]);
  assert.equal(result.message, `${context.id} plan: 4 advance(s) from in_dev to done`);

  // Read-only: no coordination write, no commit.
  assert.equal((await context.store.readSnapshot()).sha, shaBefore);
  assert.equal(runGit(context.fixture.clientA, ['rev-parse', 'HEAD']), headBefore);
});

test('plan lists the full runtime path including deployment states', async (t) => {
  const context = await setupFixture(t, { profile: 'runtime' });
  const { exitCode, memory } = await runPlan(context);

  assert.equal(exitCode, 0, memory.stderr.join(''));
  const result = JSON.parse(memory.stdout.join(''));
  assert.deepEqual(
    result.data.steps.map(({ state }) => state),
    ['in_dev', 'dev_deployed', 'testing', 'test_passed', 'prod_planning', 'prod_deployed', 'done'],
  );
  const byState = Object.fromEntries(result.data.steps.map((step) => [step.state, step]));
  assert.equal(
    byState.dev_deployed.gates,
    'migration resolved + version bound + release manifest + migration draft (if required) + lease(dev) + dev deployment snapshot at HEAD',
  );
  assert.equal(
    byState.prod_deployed.gates,
    'migration resolved + version bound + tested commit merged + lease(prod) + prod deployment snapshot covering HEAD',
  );
  assert.equal(
    byState.done.gates,
    'migration resolved + version bound + completion fact merged (local plan-completion + apply-completion)',
  );
});

test('plan from a mid-path state lists only the remaining steps', async (t) => {
  const context = await setupFixture(t, { lifecycle: 'testing' });
  const { exitCode, memory } = await runPlan(context);

  assert.equal(exitCode, 0, memory.stderr.join(''));
  const result = JSON.parse(memory.stdout.join(''));
  assert.deepEqual(
    result.data.steps.map(({ state }) => state),
    ['testing', 'test_passed', 'merged', 'done'],
  );
  assert.equal(result.data.steps[0].current, true);
  assert.equal(result.data.steps[0].command, null);
  assert.equal(result.message, `${context.id} plan: 3 advance(s) from testing to done`);
});

test('plan of a terminal requirement is an empty path', async (t) => {
  const context = await setupFixture(t, { lifecycle: 'done' });
  const { exitCode, memory } = await runPlan(context);

  assert.equal(exitCode, 0, memory.stderr.join(''));
  const result = JSON.parse(memory.stdout.join(''));
  assert.equal(result.message, `${context.id} is at terminal state done`);
  assert.deepEqual(result.data.steps, []);
});

test('the static gates table covers every reachable state of every profile', () => {
  for (const [profile, transitions] of Object.entries(TRANSITIONS)) {
    const reachable = new Set([...Object.keys(transitions), 'done']);
    for (const state of reachable) {
      const gates = PLAN_GATES[profile]?.[state];
      assert.equal(typeof gates, 'string', `${profile}:${state} has no gates annotation`);
      assert.ok(gates.length > 0, `${profile}:${state} has an empty gates annotation`);
    }
    assert.deepEqual(
      Object.keys(PLAN_GATES[profile]).sort(),
      [...reachable].sort(),
      `${profile} gates table drifts from the reachable state set`,
    );
  }
});

test('plan rejects stray positionals and undeclared options', async (t) => {
  const context = await setupFixture(t);

  const stray = await runPlan(context, context.id, ['extra']);
  assert.equal(stray.exitCode, 14);
  assert.equal(JSON.parse(stray.memory.stderr.join('')).code, 'CLI_USAGE');

  const option = await runPlan(context, context.id, ['--force']);
  assert.equal(option.exitCode, 14);
  const error = JSON.parse(option.memory.stderr.join(''));
  assert.equal(error.code, 'CLI_USAGE');
  assert.match(error.message, /plan does not accept option\(s\): --force/);
});
