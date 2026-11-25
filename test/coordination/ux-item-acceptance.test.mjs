import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';

import { reviewRepository } from '../../lib/coordination/feedback.mjs';
import {
  collectUxItemExecution,
  parseUxItemChecklist,
  resolveUxItemPlan,
  validateUxItemHandoff,
} from '../../lib/coordination/ux-item-acceptance.mjs';
import { createGitFixture, runGit } from './fixtures.mjs';

const root = 'docs/product/current/I-002-orders';
const specPath = `${root}/UX_SPEC.md`;
const requirement = { id: 'I-002', version: 'v0.1.0' };
const hash = value => createHash('sha256').update(value).digest('hex');
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64');
const item = {
  id: 'UI-002', scenarioId: 'UX-002',
  context: { view: 'order-detail', state: 'in-progress', baselineRoute: '/?requirement=I-002',
    actualRoute: '/admin/production-orders/:id', width: 320, height: 240 },
  visualExpected: 'The production detail is above the tab switcher.',
  actions: [{ id: 'open', action: 'Open the order details.', expected: 'The lines are present.' },
    { id: 'save', action: 'Save the new note.', expected: 'The note appears in the detail.' }],
  finalExpected: 'The open order shows the saved note.', changesData: true,
};
const checklist = { schemaVersion: 1, requirementId: requirement.id, items: [item] };
const spec = document => '# UX\n\n```ux-item-checks\n' + JSON.stringify(document) + '\n```\n';

function png(color, width = 320, height = 240) {
  const chunk = (type, data) => {
    const payload = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of payload) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const framed = Buffer.alloc(8 + payload.length);
    framed.writeUInt32BE(data.length);
    payload.copy(framed, 4);
    framed.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 4 + payload.length);
    return framed;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 0;
  const scanline = Buffer.alloc(width + 1, color);
  scanline[0] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(Array(height).fill(scanline)))), chunk('IEND', Buffer.alloc(0))]);
}

function fixture(t, { legacy = false } = {}) {
  const { clientA: cwd } = createGitFixture(t);
  const write = (path, data) => {
    const target = join(cwd, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
  };
  const commit = () => {
    runGit(cwd, ['add', '.']);
    runGit(cwd, ['commit', '-m', 'test: UX acceptance fixture']);
    return runGit(cwd, ['rev-parse', 'HEAD']);
  };
  const trialTasks = [{ moduleId: 'production-orders', fixtureId: 'typical', note: 'Open details.' },
    { moduleId: 'production-orders', fixtureId: 'draft', note: 'Save order note.' }];
  write(specPath, legacy ? '# Approve the order detail\n' : spec(checklist));
  if (legacy) write('apps/ux-prototype/src/requirements/I-002.json', JSON.stringify({ requirementId: requirement.id, trialTasks }));
  const approvedCommit = commit();
  const approval = { requirementId: requirement.id, approvedCommit, specPath, version: requirement.version,
    fingerprint: 'a'.repeat(64), instructionRef: 'user-message:confirmed-design', authorizedBy: 'owner' };
  const design = () => ({ repo: reviewRepository({ cwd }), root, plan: { scenarios: [{ id: 'UX-002' }] } });
  const resolve = (requireBridge, bridgeSha256) => resolveUxItemPlan({
    cwd, requirement: { ...requirement, uxItemAcceptanceBridge: requireBridge, uxItemAcceptanceBridgeSha256: bridgeSha256 },
    approval, design: design(),
  });
  return { write, commit, approval, trialTasks, design, resolve };
}

function handoffFixture(t) {
  const repo = fixture(t);
  const appOrigin = 'https://admin-dev.hongli-ruian.com';
  const baselinePath = `${root}/reviews/screenshots/baseline.png`;
  const actualPath = `${root}/reviews/screenshots/actual.png`;
  const actual = png(150);
  repo.write(baselinePath, png(20));
  repo.write(actualPath, actual);
  repo.commit();
  const capture = { view: 'order-detail', state: 'in-progress', width: 320, height: 240 };
  const row = {
    id: 'UI-002', outcome: 'match', caseId: 'AC-002', visualObserved: 'Production details appeared above the tabs.',
    baseline: { path: baselinePath, route: '/?requirement=I-002', ...capture },
    actual: { path: actualPath, route: '/admin/production-orders/order-0036', ...capture },
    actions: [{ id: 'open', observed: 'The 0036 production lines loaded.' },
      { id: 'save', observed: 'The note changed in the order details.' }],
    finalObserved: 'The order displayed the new note.', readBackObserved: 'The note remained after reload.',
    cleanupObserved: 'Restored the original note.',
  };
  const { path: _path, ...actualContext } = row.actual;
  const context = { ...actualContext, origin: appOrigin, actions: row.actions, finalObserved: row.finalObserved,
    readBackObserved: row.readBackObserved, cleanupObserved: row.cleanupObserved };
  const attempt = { status: 'passed', steps: [{ title: 'ux-item:UI-002',
    steps: ['ux-action:open', 'ux-action:save', 'ux-final', 'ux-readback', 'ux-cleanup'].map(title => ({ title })) }],
  attachments: [{ name: 'ux-context:UI-002', contentType: 'application/json', body: encode(context) },
    { name: 'ux-screenshot:UI-002', contentType: 'image/png', body: actual.toString('base64') }] };
  const inputs = { itemPlan: repo.resolve(false), root, repo: repo.design().repo,
    evidence: { testedCommit: 'f'.repeat(40), environment: { kind: 'shared-dev' } },
    report: { machineVerificationEvidence: 'b'.repeat(64), frontendIdentity: null, uxItems: [row] },
    execution: { uxItems: collectUxItemExecution({ caseId: 'AC-002', result: attempt }) } };
  return { repo, inputs, row, attempt, actualPath, baselinePath };
}

test('parse the single approved checklist and reject missing and duplicated contracts', () => {
  assert.deepEqual(parseUxItemChecklist(spec(checklist), requirement.id), checklist);
  assert.throws(() => parseUxItemChecklist('# no checklist', requirement.id), { code: 'UX_ITEM_CHECKLIST_REQUIRED' });
  assert.throws(() => parseUxItemChecklist(spec(checklist).repeat(2), requirement.id), { code: 'UX_ITEM_CHECKLIST_REQUIRED' });
  assert.throws(() => parseUxItemChecklist(spec({ ...checklist, items: [item, item] }), requirement.id), { code: 'UX_ITEM_CHECKLIST_INVALID' });
});

test('use the approved Git tree and reject a changed design even when committed', t => {
  const { write, commit, resolve } = fixture(t);
  assert.equal(resolve(false).items[0].id, 'UI-002');
  write(specPath, spec({ ...checklist, items: [{ ...item, visualExpected: 'Move the production details below the tabs.' }] }));
  commit();
  assert.throws(() => resolve(false), { code: 'UX_ITEM_APPROVAL_REQUIRED' });
});

test('bridge exactly the approved historical trial tasks without amending the approval', t => {
  const { write, commit, approval, resolve, trialTasks } = fixture(t, { legacy: true });
  const items = [item, { ...item, id: 'UI-003', visualExpected: 'Show the saved order note.' }];
  const bridge = { ...checklist, items, approvedCommit: approval.approvedCommit, approvalFingerprint: approval.fingerprint,
    trialTasks: trialTasks.map((task, index) => ({ index: index + 1, sha256: hash(JSON.stringify(task)), itemIds: [items[index].id] })) };
  const path = `${root}/UX_ITEM_BRIDGE.json`;
  const storeBridge = data => {
    const source = JSON.stringify(data);
    write(path, source);
    commit();
    return hash(source);
  };
  const bridgeSha256 = storeBridge(bridge);
  assert.equal(resolve(true, bridgeSha256).approvedCommit, approval.approvedCommit);
  assert.throws(() => resolve(true), /must match its enrolled committed SHA256/);
  assert.throws(() => resolve(false), { code: 'UX_ITEM_CHECKLIST_REQUIRED' });
  const missingTask = storeBridge({ ...bridge, trialTasks: bridge.trialTasks.slice(0, 1) });
  assert.throws(() => resolve(true, bridgeSha256), /must match its enrolled committed SHA256/);
  assert.throws(() => resolve(true, missingTask), /map every declared prototype trial task/);
  const lumped = storeBridge({ ...bridge, items: [item], trialTasks: bridge.trialTasks.map(task => ({ ...task, itemIds: [item.id] })) });
  assert.throws(() => resolve(true, lumped), /each trial task needs at least one distinct UX item/);
});

test('seal and port the committed images and trusted operation witness', t => {
  const { inputs } = handoffFixture(t);
  const binding = validateUxItemHandoff(inputs);
  assert.equal(binding.itemCount, 1);
  assert.equal(binding.machineVerificationEvidence, inputs.report.machineVerificationEvidence);
  assert.equal(Object.keys(binding.artifacts).length, 2);
  assert.deepEqual(validateUxItemHandoff({ ...inputs, execution: undefined, expectedBinding: binding }), binding);
  const changed = structuredClone(inputs.report);
  changed.uxItems[0].visualObserved = 'Changed by an unrelated review after the freeze.';
  assert.throws(() => validateUxItemHandoff({ ...inputs, report: changed, expectedBinding: binding }), /frozen UX handoff differs/);
});

test('reject checklist placeholders, wrong visual context and missing individual operations', t => {
  const { inputs, row } = handoffFixture(t);
  const run = uxItems => validateUxItemHandoff({ ...inputs, report: { ...inputs.report, uxItems } });
  assert.throws(() => run([]), /every approved UX item/);
  assert.throws(() => run([{ ...row, outcome: 'proposed-improvement' }]), /resolve any visual or workflow deviation/);
  assert.throws(() => run([{ ...row, actual: { ...row.actual, route: '/admin/production-orders' } }]), /route, view, workflow state or viewport/);
  assert.throws(() => run([{ ...row, baseline: { ...row.baseline, state: 'draft' } }]), /route, view, workflow state or viewport/);
  assert.throws(() => run([{ ...row, actions: row.actions.slice(0, 1) }]), /observable results for every action/);
  assert.throws(() => run([{ ...row, readBackObserved: ' ' }]), /resolve any visual or workflow deviation/);
  assert.throws(() => run([{ ...row, finalObserved: 'Different from the actual browser result.' }]), { code: 'UX_ITEM_BROWSER_EXECUTION_REQUIRED' });
});

test('reject an unrelated passing case, missing readback marker, and screenshot copies', t => {
  const { inputs, attempt, row, actualPath, baselinePath, repo } = handoffFixture(t);
  const execute = result => ({ uxItems: collectUxItemExecution({ caseId: 'AC-002', result }) });
  assert.throws(() => validateUxItemHandoff({ ...inputs, execution: execute({ ...attempt, steps: [] }) }),
    { code: 'UX_ITEM_BROWSER_EXECUTION_REQUIRED' });
  const missing = structuredClone(attempt);
  missing.steps[0].steps.splice(3, 1);
  assert.throws(() => validateUxItemHandoff({ ...inputs, execution: execute(missing) }), { code: 'UX_ITEM_BROWSER_EXECUTION_REQUIRED' });
  assert.throws(() => execute({ ...attempt, status: 'failed' }), /passing browser attempt/);
  repo.write(actualPath, png(150, 321));
  repo.commit();
  assert.throws(() => validateUxItemHandoff({ ...inputs, repo: repo.design().repo }), /PNG dimensions or format differ/);
  assert.throws(() => validateUxItemHandoff({ ...inputs,
    report: { ...inputs.report, uxItems: [{ ...row, actual: { ...row.actual, path: baselinePath } }] } }), /copied screenshot/);
});

test('bind dynamic rows and fixed values in deep-link query parameters', t => {
  const { inputs, row } = handoffFixture(t);
  const planned = inputs.itemPlan.items[0];
  const original = inputs.execution.uxItems[0];
  const itemPlan = { ...inputs.itemPlan,
    items: [{ ...planned, context: { ...planned.context, actualRoute: '/admin/production-plans?orderId=:orderId&view=arrangement' } }] };
  const route = '/admin/production-plans?view=arrangement&orderId=order-0036';
  const capture = route => ({ ...row.actual, route });
  const planHandoff = route => validateUxItemHandoff({ ...inputs, itemPlan,
    report: { ...inputs.report, uxItems: [{ ...row, actual: capture(route) }] },
    execution: { uxItems: [{ ...original, context: { ...original.context, route } }] } });
  assert.equal(planHandoff(route).itemCount, 1);
  assert.throws(() => planHandoff(route.replace('arrangement', 'run')), /approved route/);
  assert.throws(() => planHandoff(route + '&unexpected=1'), /approved route/);
  assert.throws(() => planHandoff(route.replace('order-0036', '')), /approved route/);
});
