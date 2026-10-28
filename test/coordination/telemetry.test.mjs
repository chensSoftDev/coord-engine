import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  aggregatePhaseDurations,
  recordPhaseEvent,
} from '../../lib/coordination/telemetry.mjs';
import { gitCommonDir } from '../../lib/coordination/worktrees.mjs';
import { createGitFixture } from './fixtures.mjs';

// I-113 Task 6 (telemetry slice): SLA phase timing uses a structured event
// stream in the unversioned Git common dir — never per-step Git commits —
// and aggregates into the final candidate evidence.

function setupTelemetryFixture(t) {
  const fixture = createGitFixture(t);
  return { fixture, cwd: fixture.clientA };
}

test('recordPhaseEvent writes a structured event into the unversioned telemetry directory', (t) => {
  const { cwd } = setupTelemetryFixture(t);
  const event = recordPhaseEvent({
    cwd,
    requirementId: 'I-113',
    phase: 'machine_verify',
    commit: 'a'.repeat(40),
    candidateId: 'candidate-I-113-x',
    startedAt: '2026-08-14T00:00:00.000Z',
    endedAt: '2026-08-14T00:30:00.000Z',
  });

  assert.equal(event.schemaVersion, 1);
  assert.equal(event.requirementId, 'I-113');
  assert.equal(event.phase, 'machine_verify');
  assert.equal(event.durationMs, 30 * 60 * 1000);
  assert.equal(event.commit, 'a'.repeat(40));

  const directory = join(gitCommonDir(cwd), 'coordination', 'telemetry');
  assert.equal(existsSync(directory), true);
  const files = readdirSync(directory);
  assert.equal(files.length, 1);
  assert.match(files[0], /^I-113-[0-9a-f-]+\.json$/);
});

test('recordPhaseEvent rejects invalid phases, dates, and missing requirement ids', (t) => {
  const { cwd } = setupTelemetryFixture(t);
  for (const phase of ['unknown_phase', '', null]) {
    assert.throws(
      () => recordPhaseEvent({
        cwd,
        requirementId: 'I-113',
        phase,
        startedAt: '2026-08-14T00:00:00.000Z',
      }),
      (error) => error.code === 'TELEMETRY_WRITE_FAILED',
    );
  }
  assert.throws(
    () => recordPhaseEvent({
      cwd,
      requirementId: 'I-113',
      phase: 'dev_queue',
      startedAt: 'not-a-date',
    }),
    (error) => error.code === 'INVALID_TELEMETRY_DATE',
  );
  assert.throws(
    () => recordPhaseEvent({
      cwd,
      requirementId: '  ',
      phase: 'dev_queue',
      startedAt: '2026-08-14T00:00:00.000Z',
    }),
    (error) => error.code === 'INVALID_TELEMETRY_REQUIREMENT',
  );
});

test('aggregatePhaseDurations sums per-phase durations across events', (t) => {
  const { cwd } = setupTelemetryFixture(t);
  recordPhaseEvent({
    cwd,
    requirementId: 'I-113',
    phase: 'dev_queue',
    startedAt: '2026-08-14T00:00:00.000Z',
    endedAt: '2026-08-14T00:10:00.000Z',
  });
  recordPhaseEvent({
    cwd,
    requirementId: 'I-113',
    phase: 'machine_verify',
    startedAt: '2026-08-14T00:10:00.000Z',
    endedAt: '2026-08-14T00:40:00.000Z',
  });
  recordPhaseEvent({
    cwd,
    requirementId: 'I-113',
    phase: 'human_wait',
    startedAt: '2026-08-14T00:40:00.000Z',
    endedAt: '2026-08-15T00:40:00.000Z',
  });

  const aggregated = aggregatePhaseDurations({ cwd, requirementId: 'I-113' });
  assert.deepEqual(aggregated.phases, {
    dev_queue: 10 * 60 * 1000,
    machine_verify: 30 * 60 * 1000,
    human_wait: 24 * 60 * 60 * 1000,
  });
  assert.equal(aggregated.totalMs, (10 + 30 + 24 * 60) * 60 * 1000);
  assert.equal(aggregated.events.length, 3);
});
