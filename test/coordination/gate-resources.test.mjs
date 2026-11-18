import assert from 'node:assert/strict';
import test from 'node:test';

import { validateRepositoryGate } from '../../lib/coordination/gate.mjs';
import { REQUIREMENT_ID, setupFeatureGate, expectGateFailure, gateFailureCodes } from './gate-fixtures.mjs';

test('feature gate enforces resource coverage and serializes active overlaps', async (t) => {
  await t.test('own requirement records and BACKLOG projection are implicit', async subtest => {
    const context = await setupFeatureGate(subtest);
    await context.store.update({ operation: 'remove implicit resource declarations', mutate(snapshot) {
      const path = `requirements/${REQUIREMENT_ID}.json`;
      const requirement = snapshot.readJson(path);
      snapshot.writeJson(path, { ...requirement, resources: { ...requirement.resources,
        files: requirement.resources.files.filter(file => file !== 'BACKLOG.md' && file !== 'docs/**') } });
    } });
    assert.equal((await validateRepositoryGate({ cwd: context.fixture.clientA, store: context.store,
      event: context.event, head: context.head, base: 'origin/main' })).valid, true);
  });
  await t.test('undeclared changed path', async (subtest) => {
    const context = await setupFeatureGate(subtest);
    await context.store.update({
      operation: 'remove script resource coverage',
      mutate(snapshot) {
        const path = `requirements/${REQUIREMENT_ID}.json`;
        const requirement = snapshot.readJson(path);
        snapshot.writeJson(path, {
          ...requirement,
          resources: { ...requirement.resources, files: ['BACKLOG.md'] },
        });
      },
    });
    await expectGateFailure(context, 'RESOURCE_DECLARATION_INCOMPLETE');
  });

  const prepareOverlap = async (context, {
    currentDependsOn = [],
    siblingDependsOn = [],
    siblingMergeStatus = null,
  } = {}) => {
    await context.store.update({
      operation: 'prepare overlapping active requirement',
      mutate(snapshot) {
        const currentPath = `requirements/${REQUIREMENT_ID}.json`;
        snapshot.writeJson(currentPath, {
          ...snapshot.readJson(currentPath),
          dependsOn: currentDependsOn,
        });
        snapshot.writeJson('requirements/I-099.json', {
          schemaVersion: 1,
          id: 'I-099',
          title: 'Overlapping requirement',
          deliveryProfile: 'runtime',
          lifecycle: siblingMergeStatus === 'merged' ? 'test_passed' : 'in_dev',
          mergeStatus: siblingMergeStatus,
          ...(siblingMergeStatus === 'merged' ? { mergedCommit: '1'.repeat(40) } : {}),
          resources: {
            files: ['scripts/**'],
            services: [],
            databaseTables: [],
            configKeys: [],
            sharedResources: [],
          },
          dependsOn: siblingDependsOn,
        });
      },
    });
  };

  await t.test('unresolved active overlap', async (subtest) => {
    const context = await setupFeatureGate(subtest);
    await prepareOverlap(context);
    await expectGateFailure(context, 'RESOURCE_CONFLICT_UNRESOLVED');
  });

  await t.test('current requirement waits for overlapping dependency', async (subtest) => {
    const context = await setupFeatureGate(subtest);
    await prepareOverlap(context, { currentDependsOn: ['I-099'] });
    const codes = await gateFailureCodes(context);
    assert.equal(codes.includes('DEPENDENCY_NOT_MERGED'), true);
    assert.equal(codes.includes('RESOURCE_CONFLICT_UNRESOLVED'), false);
  });

  await t.test('overlapping requirement waits for current requirement', async (subtest) => {
    const context = await setupFeatureGate(subtest);
    await prepareOverlap(context, { siblingDependsOn: [REQUIREMENT_ID] });
    const result = await validateRepositoryGate({
      cwd: context.fixture.clientA,
      store: context.store,
      event: context.event,
      head: context.head,
      base: 'origin/main',
    });
    assert.equal(result.valid, true);
  });

  await t.test('merged runtime overlap is inactive', async (subtest) => {
    const context = await setupFeatureGate(subtest);
    await prepareOverlap(context, { siblingMergeStatus: 'merged' });
    const result = await validateRepositoryGate({
      cwd: context.fixture.clientA,
      store: context.store,
      event: context.event,
      head: context.head,
      base: 'origin/main',
    });
    assert.equal(result.valid, true);
  });

  await t.test('shared BACKLOG projection does not serialize unrelated business resources', async (subtest) => {
    const context = await setupFeatureGate(subtest);
    await context.store.update({
      operation: 'add unrelated active requirement sharing only BACKLOG',
      mutate(snapshot) {
        snapshot.writeJson('requirements/I-099.json', {
          schemaVersion: 1,
          id: 'I-099',
          deliveryProfile: 'tooling',
          lifecycle: 'in_dev',
          resources: { files: ['BACKLOG.md', 'unrelated/**'] },
          dependsOn: [],
        });
      },
    });
    const result = await validateRepositoryGate({
      cwd: context.fixture.clientA,
      store: context.store,
      event: context.event,
      head: context.head,
      base: context.base,
    });
    assert.equal(result.valid, true);
  });
});

test('feature gate accepts a runtime dependency after its main merge fact is recorded', async (t) => {
  const context = await setupFeatureGate(t);
  await context.store.update({
    operation: 'add merged runtime dependency',
    mutate(snapshot) {
      const path = `requirements/${REQUIREMENT_ID}.json`;
      snapshot.writeJson(path, { ...snapshot.readJson(path), dependsOn: ['I-099'] });
      snapshot.writeJson('requirements/I-099.json', {
        schemaVersion: 1,
        id: 'I-099',
        deliveryProfile: 'runtime',
        lifecycle: 'test_passed',
        mergeStatus: 'merged',
        mergedCommit: '1234567890123456789012345678901234567890',
      });
    },
  });

  const result = await validateRepositoryGate({
    cwd: context.fixture.clientA,
    store: context.store,
    event: context.event,
    head: context.head,
    base: 'origin/main',
  });
  assert.equal(result.valid, true);
});
