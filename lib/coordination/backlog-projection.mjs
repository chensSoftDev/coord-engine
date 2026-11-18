import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseBacklogRows } from './backlog.mjs';
import { BACKLOG_STATUSES } from './lifecycle.mjs';
import { requirementDocuments } from './requirements.mjs';

export class BacklogProjectionError extends Error {
  constructor(message, { code = 'BACKLOG_GENERATION_FAILED', exitCode = 14, data = {} } = {}) {
    super(message);
    this.name = 'BacklogProjectionError';
    this.code = code;
    this.exitCode = exitCode;
    this.data = data;
  }
}

function cell(value, name) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || /[|\r\n]/.test(normalized)) {
    throw new BacklogProjectionError(`invalid BACKLOG ${name}`, {
      code: 'BACKLOG_PROJECTION_CONFLICT',
      data: { field: name, value },
    });
  }
  return normalized;
}

function rowForRequirement(requirement, existing) {
  const migration = requirement.migrationAssessment
    ?? (existing?.migration === '是' ? '是' : existing?.migration === '否' ? '否' : null);
  if (!migration) {
    throw new BacklogProjectionError(`requirement ${requirement.id} has no resolved migration assessment`, {
      code: 'BACKLOG_MIGRATION_UNRESOLVED',
      data: { requirementId: requirement.id },
    });
  }
  const status = BACKLOG_STATUSES[requirement.lifecycle];
  if (!status) {
    throw new BacklogProjectionError(`requirement ${requirement.id} has unknown lifecycle ${requirement.lifecycle}`, {
      code: 'BACKLOG_LIFECYCLE_UNKNOWN',
      data: { requirementId: requirement.id, lifecycle: requirement.lifecycle },
    });
  }
  const version = requirement.version ?? existing?.version ?? '-';
  const notes = existing?.notes || `${requirement.deliveryProfile} requirement`;
  return `| ${cell(requirement.id, 'id')} | ${cell(requirement.title, 'title')} | ${cell(migration, 'migration')} | ${cell(status, 'status')} | ${cell(version, 'version')} | ${cell(notes, 'notes')} |`;
}

export function renderBacklogFromCoordination({ snapshot, currentSource }) {
  if (typeof currentSource !== 'string') throw new TypeError('currentSource must be text');
  const requirements = requirementDocuments(snapshot);
  const byId = new Map(requirements.map((requirement) => [requirement.id, requirement]));
  const rows = parseBacklogRows(currentSource);
  const emitted = new Set();
  const lines = currentSource.split(/\r?\n/).map((line) => {
    const id = line.split('|')[1]?.trim();
    const requirement = byId.get(id);
    if (!requirement) return line;
    if (emitted.has(id)) {
      throw new BacklogProjectionError(`BACKLOG contains duplicate rows for ${id}`, {
        code: 'BACKLOG_PROJECTION_CONFLICT',
        data: { requirementId: id },
      });
    }
    emitted.add(id);
    return rowForRequirement(requirement, rows.get(id));
  });
  const missing = requirements
    .filter((requirement) => !emitted.has(requirement.id))
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((requirement) => rowForRequirement(requirement, null));
  if (missing.length > 0) {
    while (lines.length > 0 && lines.at(-1) === '') lines.pop();
    lines.push(...missing, '');
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

export function syncBacklogFromCoordination({ cwd, snapshot, check = false }) {
  const path = join(cwd, 'BACKLOG.md');
  const currentSource = readFileSync(path, 'utf8');
  const rendered = renderBacklogFromCoordination({ snapshot, currentSource });
  const changed = rendered !== currentSource;
  if (check && changed) {
    throw new BacklogProjectionError('BACKLOG.md differs from coordination facts', {
      code: 'BACKLOG_GENERATION_DRIFT',
      data: { path: 'BACKLOG.md' },
    });
  }
  if (changed && !check) {
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, rendered, { mode: statSync(path).mode });
    renameSync(temporary, path);
  }
  return {
    path: 'BACKLOG.md',
    changed,
    requirements: requirementDocuments(snapshot).length,
  };
}
