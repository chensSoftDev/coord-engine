import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyAdminUxImpact } from '../../lib/coordination/ux-impact.mjs';
import { prototypeOnlyLockfileChange } from '../../lib/coordination/prototype-lockfile.mjs';

test('employee-visible admin paths are distinguished from API, tests and ambiguous helpers', () => {
  const result = classifyAdminUxImpact([
    'apps/admin/app/production/page.tsx',
    'apps/admin/components/OrderForm.tsx',
    'apps/admin/app/globals.css',
    'apps/admin/lib/messages.ts',
    'apps/admin/app/api/orders/route.ts',
    'apps/admin/components/OrderForm.test.tsx',
    'apps/admin/lib/format.ts',
  ]);
  assert.equal(result.visible.length, 4);
  assert.equal(result.internal.length, 2);
  assert.deepEqual(result.review, ['apps/admin/lib/format.ts']);
});

test('lockfile exception accepts a new importer only when its dependencies are newly declared', () => {
  const base = `lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\n  apps/admin:\n    dependencies:\n      react:\n        version: 18.3.1\n\npackages:\n\n  react@18.3.1:\n    resolution: {}\n\nsnapshots:\n\n  react@18.3.1: {}\n`;
  const head = base.replace('  apps/admin:', `  apps/ux-prototype:\n    dependencies:\n      react:\n        version: 18.3.1\n\n  apps/admin:`);
  const basePackage = null; // the prototype package itself is introduced in this range
  const headPackage = JSON.stringify({ name: '@luggage/ux-prototype', dependencies: { react: '18.3.1' } });
  assert.equal(prototypeOnlyLockfileChange(base, head, {
    basePackageJson: basePackage, headPackageJson: headPackage,
  }), true);
  assert.equal(prototypeOnlyLockfileChange(base, head, {
    basePackageJson: basePackage, headPackageJson: JSON.stringify({ name: '@luggage/ux-prototype' }),
  }), false);
  assert.equal(prototypeOnlyLockfileChange(base, head), false);
  assert.equal(prototypeOnlyLockfileChange(base, head.replace('18.3.1: {}', '18.4.0: {}'), {
    basePackageJson: basePackage, headPackageJson: headPackage,
  }), false);
  assert.equal(prototypeOnlyLockfileChange(base, head.replace('  apps/admin:', '  apps/web:'), {
    basePackageJson: basePackage, headPackageJson: headPackage,
  }), false);
  assert.equal(prototypeOnlyLockfileChange(base, head.replace("'9.0'", "'10.0'"), {
    basePackageJson: basePackage, headPackageJson: headPackage,
  }), false);
});

const EXISTING_PROTOTYPE_LOCK = `lockfileVersion: '9.0'\n\nimporters:\n\n  apps/ux-prototype:\n    dependencies:\n      antd:\n        specifier: 6.3.5\n        version: 6.3.5\n\n  apps/admin:\n    dependencies:\n      react:\n        version: 18.3.1\n\npackages:\n\n  antd@6.3.5:\n    resolution: {}\n\n  icons@6.1.1:\n    resolution: {}\n\nsnapshots:\n\n  antd@6.3.5: {}\n\n  icons@6.1.1: {}\n`;
const EXISTING_PROTOTYPE_HEAD_LOCK = EXISTING_PROTOTYPE_LOCK
  .replace('      antd:', '      icons:\n        specifier: 6.1.1\n        version: 6.1.1\n      antd:');
const BASE_PROTOTYPE_PACKAGE = JSON.stringify({
  name: '@luggage/ux-prototype', dependencies: { antd: '6.3.5' },
});
const HEAD_PROTOTYPE_PACKAGE = JSON.stringify({
  name: '@luggage/ux-prototype', dependencies: { antd: '6.3.5', icons: '6.1.1' },
});

test('lockfile exception binds prototype importer additions to the same-range package.json', () => {
  const change = (head = EXISTING_PROTOTYPE_HEAD_LOCK, headPackage = HEAD_PROTOTYPE_PACKAGE) => (
    prototypeOnlyLockfileChange(EXISTING_PROTOTYPE_LOCK, head, {
      basePackageJson: BASE_PROTOTYPE_PACKAGE,
      headPackageJson: headPackage,
    })
  );
  // Positive: only the prototype package graph changed and the dependency is
  // newly declared in apps/ux-prototype/package.json.
  assert.equal(change(), true);
  // Existing entry state may not drift even with a valid package declaration.
  assert.equal(change(EXISTING_PROTOTYPE_HEAD_LOCK.replace('version: 6.3.5', 'version: 6.4.0')), false);
  // Another workspace importer changing in the same range is never prototype-only.
  assert.equal(change(EXISTING_PROTOTYPE_HEAD_LOCK.replace('version: 18.3.1', 'version: 18.4.0')), false);
  // A lockfile-only dependency addition without a package.json declaration fails.
  assert.equal(change(EXISTING_PROTOTYPE_HEAD_LOCK, BASE_PROTOTYPE_PACKAGE), false);
  // The declaration must be in the matching importer section.
  assert.equal(change(EXISTING_PROTOTYPE_HEAD_LOCK, JSON.stringify({
    name: '@luggage/ux-prototype',
    dependencies: { antd: '6.3.5' },
    devDependencies: { icons: '6.1.1' },
  })), false);
  // Missing package evidence fails closed rather than trusting the lockfile.
  assert.equal(prototypeOnlyLockfileChange(EXISTING_PROTOTYPE_LOCK, EXISTING_PROTOTYPE_HEAD_LOCK), false);
});

test('lockfile exception matches quoted scoped dependency keys against package.json', () => {
  // Real pnpm lockfiles quote scoped importer keys (`'@ant-design/icons':`);
  // package.json names never include those quotes.
  const base = `lockfileVersion: '9.0'\n\nimporters:\n\n  apps/ux-prototype:\n    dependencies:\n      antd:\n        specifier: 6.3.5\n        version: 6.3.5\n\npackages:\n\n  antd@6.3.5:\n    resolution: {}\n\n  '@ant-design/icons@6.1.1':\n    resolution: {}\n\nsnapshots:\n\n  antd@6.3.5: {}\n\n  '@ant-design/icons@6.1.1': {}\n`;
  const head = base.replace('      antd:', `      '@ant-design/icons':\n        specifier: ^6.1.1\n        version: 6.1.1\n      antd:`);
  assert.equal(prototypeOnlyLockfileChange(base, head, {
    basePackageJson: JSON.stringify({ dependencies: { antd: '6.3.5' } }),
    headPackageJson: JSON.stringify({
      dependencies: { '@ant-design/icons': '^6.1.1', antd: '6.3.5' },
    }),
  }), true);
});

test('lockfile exception rejects an unchanged package.json or a removed declaration', () => {
  // This is the "package.json unchanged but lockfile changed" negative case:
  // the base already declared icons, so the head adds no new declaration.
  const basePackage = JSON.stringify({
    name: '@luggage/ux-prototype', dependencies: { antd: '6.3.5', icons: '6.1.1' },
  });
  assert.equal(prototypeOnlyLockfileChange(EXISTING_PROTOTYPE_LOCK, EXISTING_PROTOTYPE_HEAD_LOCK, {
    basePackageJson: basePackage,
    headPackageJson: basePackage,
  }), false);
  assert.equal(prototypeOnlyLockfileChange(EXISTING_PROTOTYPE_LOCK, EXISTING_PROTOTYPE_HEAD_LOCK, {
    basePackageJson: basePackage,
    headPackageJson: JSON.stringify({ name: '@luggage/ux-prototype', dependencies: { antd: '6.3.5' } }),
  }), false);
});
