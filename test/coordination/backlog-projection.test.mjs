import assert from 'node:assert/strict';
import test from 'node:test';

import { renderBacklogFromCoordination } from '../../lib/coordination/backlog-projection.mjs';

function snapshot(requirements) {
  return {
    paths: () => requirements.map((requirement) => `requirements/${requirement.id}.json`),
    readJson: (path) => requirements.find((requirement) => `requirements/${requirement.id}.json` === path),
  };
}

test('full BACKLOG generation updates coordinated rows and preserves unmanaged rows', () => {
  const source = [
    '# Backlog',
    '',
    '| ID | Title | Migration | Status | Version | Notes |',
    '| I-001 | Existing | 否 | ⚪ Todo | - | keep this note |',
    '| F-999 | Legacy | 否 | ✔️ Done | v0.1.0 | unmanaged row |',
    '',
  ].join('\n');
  const rendered = renderBacklogFromCoordination({
    snapshot: snapshot([{
      id: 'I-001',
      title: 'Existing updated',
      migrationAssessment: '是',
      lifecycle: 'testing',
      version: 'v0.35.0',
      deliveryProfile: 'tooling',
    }, {
      id: 'B-002',
      title: 'New requirement',
      migrationAssessment: '否',
      lifecycle: 'in_dev',
      version: 'v0.36.0',
      deliveryProfile: 'runtime',
    }]),
    currentSource: source,
  });
  assert.ok(rendered.includes('| I-001 | Existing updated | 是 | 🧪 Testing | v0.35.0 | keep this note |'));
  assert.ok(rendered.includes('| F-999 | Legacy | 否 | ✔️ Done | v0.1.0 | unmanaged row |'));
  assert.ok(rendered.includes('| B-002 | New requirement | 否 | 🔨 In Dev | v0.36.0 | runtime requirement |'));
});

test('full BACKLOG generation fails closed when a coordinated requirement has no migration fact', () => {
  assert.throws(() => renderBacklogFromCoordination({
    snapshot: snapshot([{
      id: 'I-001', title: 'Missing migration', lifecycle: 'in_dev', version: 'v0.35.0', deliveryProfile: 'tooling',
    }]),
    currentSource: '| I-001 | Missing migration | 待评审 | 🔨 In Dev | v0.35.0 | pending |\n',
  }), error => error.code === 'BACKLOG_MIGRATION_UNRESOLVED');
});
