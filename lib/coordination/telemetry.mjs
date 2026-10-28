// SLA 分段计时（I-113 Task 6）：结构化事件流写入 Git common dir 下未版本化
// 的 `.git/coordination/telemetry/`，本地/远端 `coord` 共用同一载体。最终
// candidate 只把聚合摘要写入最终测试证据，不为单步骤创建 Git commit。
// 事件只记录耐久事实（需求、阶段、时间、commit、candidate），不采集
// 私有会话内容。

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { gitCommonDir } from './worktrees.mjs';

const TELEMETRY_SCHEMA_VERSION = 1;

export class TelemetryError extends Error {
  constructor(message, { code = 'TELEMETRY_WRITE_FAILED', exitCode = 14, cause } = {}) {
    super(message, { cause });
    this.name = 'TelemetryError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

function telemetryDirectory(cwd) {
  return join(gitCommonDir(cwd), 'coordination', 'telemetry');
}

function telemetryFile(cwd, requirementId, eventId) {
  return join(
    telemetryDirectory(cwd),
    `${requirementId}-${eventId}.json`,
  );
}

// Append a phase event for a requirement. Phase names follow the delivery
// timeline: dev_queue, machine_verify, human_wait, prod_build, prod_release.
export function recordPhaseEvent({
  cwd,
  requirementId,
  phase,
  commit = null,
  candidateId = null,
  startedAt,
  endedAt = null,
  extra = {},
}) {
  if (typeof requirementId !== 'string' || requirementId.trim() === '') {
    throw new TelemetryError('telemetry requirementId is required', {
      code: 'INVALID_TELEMETRY_REQUIREMENT',
    });
  }
  const phases = new Set([
    'dev_queue',
    'machine_verify',
    'human_wait',
    'prod_build',
    'prod_release',
  ]);
  if (!phases.has(phase)) {
    throw new TelemetryError(`invalid telemetry phase: ${phase ?? '<missing>'}`);

  }  const started = new Date(startedAt);
  if (Number.isNaN(started.getTime())) {
    throw new TelemetryError('telemetry startedAt must be a valid date', {
      code: 'INVALID_TELEMETRY_DATE',
    });
  }
  const ended = endedAt ? new Date(endedAt) : null;
  if (ended && Number.isNaN(ended.getTime())) {
    throw new TelemetryError('telemetry endedAt must be a valid date', {
      code: 'INVALID_TELEMETRY_DATE',
    });
  }
  const eventId = randomUUID();
  const event = {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    eventId,
    requirementId: requirementId.trim(),
    phase,
    startedAt: started.toISOString(),
    ...(ended ? { endedAt: ended.toISOString(), durationMs: ended.getTime() - started.getTime() } : {}),
    ...(commit ? { commit } : {}),
    ...(candidateId ? { candidateId } : {}),
    ...extra,
  };
  const directory = telemetryDirectory(cwd);
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(telemetryFile(cwd, requirementId.trim(), eventId), `${JSON.stringify(event, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    throw new TelemetryError(`cannot write telemetry event: ${error.message}`, { cause: error });
  }
  return event;
}

// Aggregate per-phase durations for a requirement by reading its events from
// the unversioned telemetry directory. Used to write the final candidate
// summary into the test evidence without creating per-step commits.
export function aggregatePhaseDurations({ cwd, requirementId }) {
  const directory = telemetryDirectory(cwd);
  const prefix = `${requirementId}-`;
  const events = [];
  try {
    for (const name of readdirSync(directory)) {
      if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
      try {
        const event = JSON.parse(readFileSync(join(directory, name), 'utf8'));
        if (
          event.schemaVersion === TELEMETRY_SCHEMA_VERSION
          && event.requirementId === requirementId
          && typeof event.durationMs === 'number'
        ) {
          events.push(event);
        }
      } catch {
        // Ignore malformed or partial events; only valid facts aggregate.
      }
    }
  } catch {
    return { phases: {}, totalMs: 0, events: [] };
  }
  const phases = {};
  let totalMs = 0;
  for (const event of events) {
    phases[event.phase] = (phases[event.phase] ?? 0) + event.durationMs;
    totalMs += event.durationMs;
  }
  return { phases, totalMs, events };
}
