import assert from 'node:assert/strict';
import test from 'node:test';

import { GitCoordinationStore } from '../../lib/coordination/git-store.mjs';
import { main } from '../../lib/coordination/cli.mjs';
import { claimRequirement, setRequirementProfile, setRequirementUxImpact, startRequirement } from '../../lib/coordination/requirements.mjs';
import { createGitFixture, createMemoryIo } from './fixtures.mjs';

function createStore(fixture) {
  return new GitCoordinationStore({
    cwd: fixture.clientA,
    remote: 'origin',
    branch: 'coordination',
    tempRoot: fixture.tempRoot,
    clock: () => new Date('2026-10-15T00:00:00.000Z'),
  });
}

test('claim stores the explicit admin UI impact on a new requirement', async (t) => {
  const fixture = createGitFixture(t);
  const store = createStore(fixture);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const result = await claimRequirement({
    store, type: 'I', title: 'Admin task', profile: 'runtime', uxImpact: 'admin-ui',
    backlogText: '| I-001 | fixture |\n',
  });
  const fact = (await store.readSnapshot()).readJson(`requirements/${result.id}.json`);
  assert.equal(fact.uxImpact, 'admin-ui');
  assert.equal(fact.lifecycle, 'todo');
});

test('admin UI start stops at Todo while none keeps the existing shortcut', async (t) => {
  const fixture = createGitFixture(t);
  const store = createStore(fixture);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const base = {
    store, type: 'I', profile: 'runtime', topic: 'admin-task', migration: 'no',
    bump: 'patch', backlogText: '| I-001 | fixture |\n',
  };
  const admin = await startRequirement({ ...base, title: 'Admin task', uxImpact: 'admin-ui' });
  const none = await startRequirement({ ...base, title: 'Internal task', topic: 'internal-task', uxImpact: 'none' });
  const snapshot = await store.readSnapshot();
  assert.equal(snapshot.readJson(`requirements/${admin.id}.json`).lifecycle, 'todo');
  assert.equal(snapshot.readJson(`requirements/${admin.id}.json`).uxImpact, 'admin-ui');
  assert.equal(snapshot.readJson(`requirements/${none.id}.json`).lifecycle, 'in_dev');
  assert.equal(snapshot.readJson(`requirements/${none.id}.json`).uxImpact, 'none');
});

test('CLI claim rejects missing UX impact before allocating an ID', async (t) => {
  const fixture = createGitFixture(t);
  const store = createStore(fixture);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const memory = createMemoryIo();
  const exit = await main([
    'requirement', 'claim', '--type', 'I', '--title', 'Missing UX', '--profile', 'tooling', '--json',
  ], {
    ...memory.io,
    env: { COORD_CWD: fixture.clientA, COORD_REMOTE: 'origin', COORD_TEMP_ROOT: fixture.tempRoot },
  });
  assert.equal(exit, 12);
  assert.equal(JSON.parse(memory.stderr.join('')).code, 'MISSING_UX_IMPACT');
});

test('CLI claim rejects an invalid UX impact', async (t) => {
  const fixture = createGitFixture(t);
  const memory = createMemoryIo();
  const exit = await main([
    'requirement', 'claim', '--type', 'I', '--title', 'Invalid UX', '--profile', 'tooling',
    '--ux-impact', 'maybe', '--json',
  ], {
    ...memory.io,
    env: { COORD_CWD: fixture.clientA, COORD_REMOTE: 'origin', COORD_TEMP_ROOT: fixture.tempRoot },
  });
  assert.equal(exit, 12);
  assert.equal(JSON.parse(memory.stderr.join('')).code, 'INVALID_UX_IMPACT');
});

test('CLI start rejects a missing UX impact before allocating an ID', async (t) => {
  const fixture = createGitFixture(t);
  const memory = createMemoryIo();
  const exit = await main([
    'requirement', 'start', '--type', 'I', '--title', 'Missing UX',
    '--profile', 'runtime', '--topic', 'missing-ux', '--migration', 'no',
    '--version', 'v0.9.1', '--json',
  ], {
    ...memory.io,
    env: { COORD_CWD: fixture.clientA, COORD_REMOTE: 'origin', COORD_TEMP_ROOT: fixture.tempRoot },
  });
  assert.equal(exit, 12);
  assert.equal(JSON.parse(memory.stderr.join('')).code, 'MISSING_UX_IMPACT');
});

test('a mistaken none declaration can only be upgraded with an audited reason', async (t) => {
  const fixture = createGitFixture(t);
  const store = createStore(fixture);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const claimed = await claimRequirement({
    store, type: 'I', title: 'Admin task', profile: 'runtime', uxImpact: 'none',
    backlogText: '| I-001 | fixture |\n',
  });
  await assert.rejects(
    setRequirementUxImpact({ store, id: claimed.id, uxImpact: 'admin-ui', reason: '' }),
    { code: 'INVALID_UX_IMPACT_REASON' },
  );
  await setRequirementUxImpact({
    store, id: claimed.id, uxImpact: 'admin-ui', reason: 'This changes an employee-facing page',
  });
  const fact = (await store.readSnapshot()).readJson(`requirements/${claimed.id}.json`);
  assert.equal(fact.uxImpact, 'admin-ui');
  assert.equal(fact.lifecycle, 'todo');
  assert.equal(fact.uxImpactHistory.at(-1).reason, 'This changes an employee-facing page');
  await assert.rejects(
    setRequirementUxImpact({ store, id: claimed.id, uxImpact: 'none', reason: 'Revert' }),
    { code: 'UX_IMPACT_DOWNGRADE_FORBIDDEN' },
  );
});

test('an unmerged in-dev requirement can upgrade its delivery profile with an audited actor', async (t) => {
  const fixture = createGitFixture(t);
  const store = createStore(fixture);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  for (const profile of ['governance', 'tooling']) {
    const started = await startRequirement({
      store, type: 'I', title: `${profile} task`, profile, uxImpact: 'none',
      topic: `${profile}-task`, migration: 'no', bump: 'patch',
      backlogText: '| I-001 | fixture |\n',
    });
    const result = await setRequirementProfile({
      store, id: started.id, profile: 'runtime',
      reason: 'Employee-facing admin pages are in scope',
      actor: { agent: 'review-agent', sessionId: 'session-review-1' },
    });
    assert.equal(result.deliveryProfile, 'runtime');
    const snapshot = await store.readSnapshot();
    const fact = snapshot.readJson(`requirements/${started.id}.json`);
    assert.equal(fact.deliveryProfile, 'runtime');
    assert.equal(fact.lifecycle, 'in_dev');
    assert.deepEqual(fact.profileHistory, [{
      from: profile, to: 'runtime', reason: 'Employee-facing admin pages are in scope',
      actor: 'review-agent', sessionId: 'session-review-1',
      at: '2026-10-15T00:00:00.000Z',
    }]);
    // The operation record carries the same actor identity as the history.
    assert.deepEqual(snapshot.readJson(`operations/by-id/${result.operationId}.json`).metadata, {
      requirementId: started.id,
      deliveryProfile: 'runtime',
      reason: 'Employee-facing admin pages are in scope',
      actor: 'review-agent',
      sessionId: 'session-review-1',
    });
  }
});

test('profile correction rejects legacy requirements without an explicit uxImpact', async (t) => {
  const fixture = createGitFixture(t);
  const store = createStore(fixture);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  // Library fixtures and pre-I-240 imports predate the explicit UX declaration.
  const started = await startRequirement({
    store, type: 'I', title: 'Legacy governance task', profile: 'governance',
    uxImpact: undefined, topic: 'legacy-governance-task', migration: 'no', bump: 'patch',
    backlogText: '| I-001 | fixture |\n',
  });
  const factBefore = (await store.readSnapshot()).readJson(`requirements/${started.id}.json`);
  assert.equal('uxImpact' in factBefore, false);
  await assert.rejects(
    setRequirementProfile({
      store, id: started.id, profile: 'runtime', reason: 'Runtime pages now included',
    }),
    { code: 'PROFILE_UX_IMPACT_UNDECLARED', exitCode: 14 },
  );
  const factAfter = (await store.readSnapshot()).readJson(`requirements/${started.id}.json`);
  assert.equal(factAfter.deliveryProfile, 'governance');
  assert.equal(factAfter.profileHistory, undefined);
});

test('profile correction rejects bad reason and keeps wrong-target/state codes distinct', async (t) => {
  const fixture = createGitFixture(t);
  const store = createStore(fixture);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const started = await startRequirement({
    store, type: 'I', title: 'Governance task', profile: 'governance', uxImpact: 'none',
    topic: 'governance-task', migration: 'no', bump: 'patch',
    backlogText: '| I-001 | fixture |\n',
  });
  const correction = { store, id: started.id, profile: 'runtime', reason: 'Runtime pages now included' };
  await assert.rejects(setRequirementProfile({ ...correction, reason: 'too short' }),
    { code: 'INVALID_PROFILE_REASON', exitCode: 12 });
  await assert.rejects(setRequirementProfile({ ...correction, reason: 'line one\rline two' }),
    { code: 'INVALID_PROFILE_REASON', exitCode: 12 });
  await assert.rejects(setRequirementProfile({ ...correction, reason: 'line one\nline two' }),
    { code: 'INVALID_PROFILE_REASON', exitCode: 12 });
  await assert.rejects(setRequirementProfile({ ...correction, profile: 'tooling' }),
    { code: 'PROFILE_CHANGE_NOT_ALLOWED', exitCode: 12 });
  await store.update({ operation: 'advance fixture', mutate(snapshot) {
    const path = `requirements/${started.id}.json`;
    snapshot.writeJson(path, { ...snapshot.readJson(path), lifecycle: 'test_passed' });
  } });
  await assert.rejects(setRequirementProfile(correction),
    { code: 'PROFILE_STATE_NOT_ALLOWED', exitCode: 14 });
  await store.update({ operation: 'set merged fixture', mutate(snapshot) {
    const path = `requirements/${started.id}.json`;
    snapshot.writeJson(path, {
      ...snapshot.readJson(path), lifecycle: 'in_dev',
      mergeStatus: 'merged', mergedCommit: '1'.repeat(40),
    });
  } });
  await assert.rejects(setRequirementProfile(correction),
    { code: 'PROFILE_STATE_NOT_ALLOWED', exitCode: 14 });
  const fact = (await store.readSnapshot()).readJson(`requirements/${started.id}.json`);
  assert.equal(fact.deliveryProfile, 'governance');
  assert.equal(fact.profileHistory, undefined);
});

test('repeating a successful profile correction fails loudly instead of silently no-oping', async (t) => {
  const fixture = createGitFixture(t);
  const store = createStore(fixture);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const started = await startRequirement({
    store, type: 'I', title: 'Governance task', profile: 'governance', uxImpact: 'none',
    topic: 'governance-task', migration: 'no', bump: 'patch',
    backlogText: '| I-001 | fixture |\n',
  });
  const correction = { store, id: started.id, profile: 'runtime', reason: 'Runtime pages now included' };
  await setRequirementProfile(correction);
  await assert.rejects(setRequirementProfile(correction),
    { code: 'PROFILE_ALREADY_RUNTIME', exitCode: 14 });
  const fact = (await store.readSnapshot()).readJson(`requirements/${started.id}.json`);
  assert.equal(fact.profileHistory.length, 1);
});

test('CLI set-profile validates positionals and forwards the session actor into the audit record', async (t) => {
  const fixture = createGitFixture(t);
  const store = createStore(fixture);
  await store.initialize({ fromBacklog: 'BACKLOG.md' });
  const started = await startRequirement({
    store, type: 'I', title: 'Governance task', profile: 'governance', uxImpact: 'none',
    topic: 'governance-task', migration: 'no', bump: 'patch',
    backlogText: '| I-001 | fixture |\n',
  });
  const env = {
    COORD_CWD: fixture.clientA,
    COORD_REMOTE: 'origin',
    COORD_TEMP_ROOT: fixture.tempRoot,
    COORD_AGENT: 'cli-agent',
    COORD_SESSION_ID: 'session-cli-1',
  };
  const missing = createMemoryIo();
  assert.equal(await main(['requirement', 'set-profile', started.id, 'runtime', '--json'], {
    ...missing.io, env,
  }), 14);
  const wrongProfile = createMemoryIo();
  assert.equal(await main([
    'requirement', 'set-profile', started.id, 'tooling', '--reason',
    'Employee-facing admin pages are in scope', '--json',
  ], { ...wrongProfile.io, env }), 14);
  assert.equal(JSON.parse(wrongProfile.stderr.join('')).code, 'CLI_USAGE');
  const extra = createMemoryIo();
  assert.equal(await main([
    'requirement', 'set-profile', started.id, 'runtime', 'extra', '--reason',
    'Employee-facing admin pages are in scope', '--json',
  ], { ...extra.io, env }), 14);
  assert.equal(JSON.parse(extra.stderr.join('')).code, 'CLI_USAGE');
  const memory = createMemoryIo();
  assert.equal(await main([
    'requirement', 'set-profile', started.id, 'runtime', '--reason',
    'Employee-facing admin pages are in scope', '--json',
  ], { ...memory.io, env }), 0);
  const data = JSON.parse(memory.stdout.join('')).data;
  assert.equal(data.deliveryProfile, 'runtime');
  const snapshot = await store.readSnapshot();
  assert.equal(snapshot.readJson(`requirements/${started.id}.json`).deliveryProfile, 'runtime');
  assert.deepEqual(snapshot.readJson(`operations/by-id/${data.operationId}.json`).metadata, {
    requirementId: started.id,
    deliveryProfile: 'runtime',
    reason: 'Employee-facing admin pages are in scope',
    actor: 'cli-agent',
    sessionId: 'session-cli-1',
  });
  const duplicate = createMemoryIo();
  assert.equal(await main([
    'requirement', 'set-profile', started.id, 'runtime', '--reason',
    'Employee-facing admin pages are in scope', '--json',
  ], { ...duplicate.io, env }), 14);
  assert.equal(JSON.parse(duplicate.stderr.join('')).code, 'PROFILE_ALREADY_RUNTIME');
});
