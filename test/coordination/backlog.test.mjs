import assert from 'node:assert/strict';
import test from 'node:test';

import { parseBacklogRows } from '../../lib/coordination/backlog.mjs';

// I-128 (M9): the shared parser must keep every field name the four former
// module-local copies relied on.
test('parseBacklogRows returns the superset shape used by all former call sites', () => {
  const rows = parseBacklogRows([
    '| ID | 需求描述 | 需迁移 | 当前状态 | Version | 备注 |',
    '|----|----------|--------|----------|---------|------|',
    '| I-001 | 标题 | 是 | 🔨 In Dev | v0.9.8 | 备注 |',
    '| B-042 | other | 否 | ⚪ Todo | - | n |',
  ].join('\n'));

  assert.equal(rows.size, 2);
  const row = rows.get('I-001');
  assert.equal(row.title, '标题');
  assert.equal(row.description, '标题');
  assert.equal(row.migration, '是');
  assert.equal(row.migrationRequired, true);
  assert.equal(row.status, '🔨 In Dev');
  assert.equal(row.version, 'v0.9.8');
  assert.equal(row.notes, '备注');
  assert.equal(row.line, '| I-001 | 标题 | 是 | 🔨 In Dev | v0.9.8 | 备注 |');
  assert.equal(rows.get('B-042').migrationRequired, false);
});
