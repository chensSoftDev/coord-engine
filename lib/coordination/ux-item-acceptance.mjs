import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { isSafeReviewPath, reviewRepository } from './feedback.mjs';

const SHA = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const checkFence = 'ux-item-checks';
const digest = data => createHash('sha256').update(data).digest('hex');
const text = value => typeof value === 'string' && value.trim().length > 0 && !value.includes('\0');
const id = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{1,95}$/.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const patternPart = value => /^:[A-Za-z][A-Za-z0-9]*$/.test(value);
const size = (width, height) => Number.isInteger(width) && width >= 320 && width <= 4096
  && Number.isInteger(height) && height >= 240 && height <= 4096;
const canonical = value => JSON.stringify(value, (_key, item) => object(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const match = (a, b) => canonical(a) === canonical(b);

function fail(message, code = 'UX_ITEM_HANDOFF_INVALID') {
  throw Object.assign(new Error(message), { code, exitCode: 14 });
}

function json(source, message, code) {
  try { return JSON.parse(source); } catch { fail(message, code); }
}

function routeParts(value, allowPattern) {
  if (!text(value) || !value.startsWith('/') || value.startsWith('//')
    || /[\\#\s\u0000-\u001f]|%2f|%5c/i.test(value)) return null;
  const [path, query = ''] = value.split(/\?(.*)/s);
  if (path !== '/' && path.endsWith('/')) return null;
  const segments = path.slice(1).split('/');
  if (segments.some(part => part === '.' || part === '..' || /^%(?:2e)(?:%2e)?$/i.test(part)
    || (part.includes(':') && (!allowPattern || !patternPart(part))))) return null;
  const params = new URLSearchParams(query);
  params.sort();
  return { segments, query: [...params] };
}

function routeMatches(pattern, actual) {
  const expected = routeParts(pattern, true), received = routeParts(actual, false);
  const onePart = (pattern, value) => patternPart(pattern) ? Boolean(value) : pattern === value;
  return expected && received && expected.segments.length === received.segments.length
    && expected.segments.every((part, position) => onePart(part, received.segments[position]))
    && expected.query.length === received.query.length
    && expected.query.every(([key, value], position) => key === received.query[position][0] && onePart(value, received.query[position][1]));
}

function entriesById(entries, key, message, code) {
  if (!Array.isArray(entries) || entries.some(entry => !object(entry) || !id(entry[key]))) fail(message, code);
  const result = new Map(entries.map(entry => [entry[key], entry]));
  if (result.size !== entries.length) fail(message, code);
  return result;
}

function validateItemList(document, requirementId) {
  const code = 'UX_ITEM_CHECKLIST_INVALID';
  const invalid = message => fail(message, code);
  if (document?.schemaVersion !== 1 || document.requirementId !== requirementId
    || !Array.isArray(document.items) || !document.items.length) invalid('define the UX items for this requirement');
  const items = entriesById(document.items, 'id', 'approved UX item IDs must be unique', code);
  for (const item of items.values()) {
    const context = item.context;
    if (!id(item.scenarioId) || !object(context) || !id(context.view) || !id(context.state)
      || !routeParts(context.baselineRoute, true) || !routeParts(context.actualRoute, true)
      || !size(context.width, context.height) || !text(item.visualExpected)
      || !text(item.finalExpected) || typeof item.changesData !== 'boolean') {
      invalid(`define both screen routes, state, viewport, visual expectation and final result for ${item.id}`);
    }
    const actions = entriesById(item.actions, 'id', `define unique action IDs for ${item.id}`, code);
    if (!actions.size || [...actions.values()].some(action => !text(action.action) || !text(action.expected))) {
      invalid(`define each browser action and observable result for ${item.id}`);
    }
  }
  return document.items;
}

export function parseUxItemChecklist(source, requirementId) {
  const blocks = [...source.matchAll(/^```ux-item-checks[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm)];
  if (blocks.length !== 1) fail(`define exactly one ${checkFence} block in the UX spec`, 'UX_ITEM_CHECKLIST_REQUIRED');
  const checklist = json(blocks[0][1], 'the UX checklist must use valid JSON', 'UX_ITEM_CHECKLIST_INVALID');
  validateItemList(checklist, requirementId);
  return checklist;
}

function readText(repo, path, code, { committedOnly = false } = {}) {
  if (!isSafeReviewPath(path) || !repo.regular(path) || (!committedOnly && repo.dirty([path]))) {
    fail(`commit the regular UX acceptance input: ${path}`, code);
  }
  const source = repo.read(path);
  if (!source.trim() || Buffer.byteLength(source) > 1024 * 1024) fail(`UX acceptance input is empty or too large: ${path}`, code);
  return source;
}

function approvedBridgeItems({ repo, root, approvedRepo, approval, requirementId, approvedBridgeSha256 }) {
  const code = 'UX_ITEM_BRIDGE_INVALID';
  const path = `${root}/UX_ITEM_BRIDGE.json`;
  const source = readText(repo, path, code);
  if (!SHA.test(approvedBridgeSha256 ?? '') || digest(source) !== approvedBridgeSha256) {
    fail('the legacy UX bridge must match its enrolled committed SHA256', code);
  }
  const bridge = json(source, 'the legacy UX bridge must use valid JSON', code);
  if (bridge.approvedCommit !== approval.approvedCommit || bridge.approvalFingerprint !== approval.fingerprint) {
    fail('the bridge must match the exact approved prototype', code);
  }
  validateItemList(bridge, requirementId);
  validateUxTrialCoverage({ repo: approvedRepo, checklist: bridge, requirementId, code });
  return { items: bridge.items, source: path, trialTasks: bridge.trialTasks };
}

export function validateUxTrialCoverage({ repo, checklist, requirementId, code = 'UX_ITEM_CHECKLIST_INVALID' }) {
  const declarationPath = `apps/ux-prototype/src/requirements/${requirementId}.json`;
  const declaration = json(readText(repo, declarationPath, code, { committedOnly: true }),
    'read the committed prototype requirement declaration', code);
  const tasks = declaration?.trialTasks;
  if (declaration.requirementId !== requirementId || !Array.isArray(tasks) || !tasks.length
    || !Array.isArray(checklist.trialTasks) || checklist.trialTasks.length !== tasks.length) {
    fail('map every declared prototype trial task to the UX checklist', code);
  }
  const mapped = new Map(), indexes = new Set(), ids = new Set(checklist.items.map(item => item.id));
  for (const task of checklist.trialTasks) {
    if (!Number.isInteger(task?.index) || task.index < 1 || task.index > tasks.length || indexes.has(task.index)
      || task.sha256 !== digest(JSON.stringify(tasks[task.index - 1])) || !Array.isArray(task.itemIds)
      || !task.itemIds.length || new Set(task.itemIds).size !== task.itemIds.length
      || task.itemIds.some(itemId => !ids.has(itemId))) fail('each trial task must map to its approved digest and UX item IDs exactly once', code);
    indexes.add(task.index);
    for (const itemId of task.itemIds) mapped.set(itemId, (mapped.get(itemId) ?? 0) + 1);
  }
  if (mapped.size !== ids.size) fail('every UX item must map to a trial task', code);
  if (checklist.trialTasks.some(task => !task.itemIds.some(itemId => mapped.get(itemId) === 1))) {
    fail('each trial task needs at least one distinct UX item', code);
  }
}

export function resolveUxItemPlan({ cwd, requirement, approval, ref = 'HEAD', design }) {
  const code = 'UX_ITEM_APPROVAL_REQUIRED';
  const { id: requirementId } = requirement;
  const { repo, root, plan } = design;
  const specPath = `${root}/UX_SPEC.md`;
  if (approval?.requirementId !== requirementId || approval.version !== requirement.version
    || !COMMIT.test(approval.approvedCommit ?? '') || !SHA.test(approval.fingerprint ?? '')
    || !/^user-message:[A-Za-z0-9._:-]{6,}$/.test(approval.instructionRef ?? '') || !text(approval.authorizedBy)
    || approval.revoked || approval.specPath !== specPath
    || spawnSync('git', ['merge-base', '--is-ancestor', approval.approvedCommit, repo.commit ?? ref], { cwd, stdio: 'ignore' }).status !== 0) {
    fail('the current candidate needs its current direct prototype approval', code);
  }
  const approvedRepo = reviewRepository({ cwd, ref: approval.approvedCommit });
  const approvedSpec = readText(approvedRepo, specPath, code, { committedOnly: true });
  const currentSpec = readText(repo, specPath, code);
  if (approvedSpec !== currentSpec) fail('the UX spec changed after prototype approval', code);
  const checklist = approvedSpec.includes('```' + checkFence) || requirement.uxItemAcceptanceBridge !== true
    ? { items: parseUxItemChecklist(approvedSpec, requirementId).items, source: specPath }
    : approvedBridgeItems({ repo, root, approvedRepo, approval, requirementId,
      approvedBridgeSha256: requirement.uxItemAcceptanceBridgeSha256 });
  const scenarioIds = new Set(plan.scenarios.map(scenario => scenario.id));
  if (checklist.items.some(item => !scenarioIds.has(item.scenarioId))) {
    fail('all approved UX items must map to an executable design scenario', 'UX_ITEM_CHECKLIST_INVALID');
  }
  const itemPlan = { requirementId, approvedCommit: approval.approvedCommit, approvalFingerprint: approval.fingerprint, ...checklist };
  return { ...itemPlan, sha256: digest(canonical(itemPlan)) };
}

// Playwright's JSON reporter keeps test.step nesting and inline attachment bodies
// for each attempt. Only the caller-validated passing attempt is inspected.
export function collectUxItemExecution({ caseId, result }) {
  if (result?.status !== 'passed') fail('only a passing browser attempt can provide UX evidence');
  const records = [];
  const visit = steps => {
    for (const step of steps ?? []) {
      if (!step.title?.startsWith('ux-item:')) {
        visit(step.steps);
        continue;
      }
      const itemId = step.title.slice('ux-item:'.length);
      if (!id(itemId) || step.error || !Array.isArray(step.steps) || step.steps.some(child => child.error)) {
        fail(`invalid browser checkpoint for ${itemId}`);
      }
      const attachment = (name, contentType, maxBytes) => {
        const attachments = (result.attachments ?? []).filter(entry => entry.name === name);
        const value = attachments[0];
        if (attachments.length !== 1 || value.contentType !== contentType || typeof value.body !== 'string'
          || value.body.length > 4 * Math.ceil(maxBytes / 3)) fail(`attach the browser capture ${name} to its passing attempt`);
        const bytes = Buffer.from(value.body, 'base64');
        if (bytes.length === 0 || bytes.length > maxBytes || bytes.toString('base64') !== value.body) {
          fail(`invalid inline browser attachment ${name}`);
        }
        return bytes;
      };
      const context = json(attachment(`ux-context:${itemId}`, 'application/json', 64 * 1024),
        `invalid browser context attachment for ${itemId}`);
      const screenshot = attachment(`ux-screenshot:${itemId}`, 'image/png', MAX_IMAGE_BYTES);
      records.push({ id: itemId, caseId, context, steps: step.steps.map(child => child.title), actualSha256: digest(screenshot) });
    }
  };
  visit(result.steps);
  return records;
}

function captureContext(capture) {
  const { route, view, state, width, height } = capture;
  return { route, view, state, width, height };
}

function captureMatches(capture, context, route) {
  return object(capture) && capture.view === context.view && capture.state === context.state
    && capture.width === context.width && capture.height === context.height && routeMatches(route, capture.route);
}

function readCapture({ repo, root, capture, itemId, artifact }) {
  const path = capture.path;
  if (!isSafeReviewPath(path) || !path.startsWith(`${root}/reviews/screenshots/`) || !path.endsWith('.png')
    || !repo.regular(path) || repo.dirty([path])) fail(`commit the ${artifact} PNG for item ${itemId}`);
  const result = spawnSync('git', ['show', `${repo.commit}:${path}`], { cwd: repo.cwd, maxBuffer: MAX_IMAGE_BYTES });
  if (result.status !== 0) fail(`could not read the committed ${artifact} PNG for ${itemId}`);
  const bytes = result.stdout;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const end = Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);
  if (bytes.length < 45 || bytes.length > MAX_IMAGE_BYTES || !bytes.subarray(0, 8).equals(signature)
    || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR'
    || !bytes.subarray(-12).equals(end) || bytes.readUInt32BE(16) !== capture.width
    || bytes.readUInt32BE(20) !== capture.height) fail(`the ${artifact} PNG dimensions or format differ for item ${itemId}`);
  return digest(bytes);
}

function evidenceOrigin(evidence) {
  const env = evidence.environment;
  if (env?.kind === 'mixed-dev') return env.mixedEnvironment?.frontend?.baseUrl;
  if (env?.kind === 'shared-dev') return env.targets?.adminBaseUrl ?? 'https://admin-dev.hongli-ruian.com';
  return null;
}

export function validateUxItemHandoff({ itemPlan, report, repo, root, evidence, execution, expectedBinding }) {
  const results = entriesById(report.uxItems, 'id', 'record one browser and visual result per approved UX item');
  if (results.size !== itemPlan.items.length || itemPlan.items.some(item => !results.has(item.id))) {
    fail('the current self-check must cover every approved UX item without omissions');
  }
  const available = expectedBinding?.executionItems ?? execution?.uxItems;
  const executed = entriesById(available, 'id', 'attach a unique passing browser checkpoint for each approved UX item');
  const executionItems = [], artifacts = {};
  const used = new Map();
  const origin = evidenceOrigin(evidence);
  const actualOrigin = typeof origin === 'string' ? origin.replace(/\/$/, '') : null;
  if (!actualOrigin) fail('UX item execution requires the machine-tested live frontend');
  for (const item of itemPlan.items) {
    const row = results.get(item.id), witness = executed.get(item.id);
    const { context } = item;
    if (row.outcome !== 'match' || !id(row.caseId) || !text(row.visualObserved) || !text(row.finalObserved)
      || !text(row.cleanupObserved) || (item.changesData && !text(row.readBackObserved))) {
      fail(`resolve any visual or workflow deviation before handoff for ${item.id}`);
    }
    const actions = entriesById(row.actions, 'id', `record observable results for every action in ${item.id}`);
    if (actions.size !== item.actions.length || item.actions.some(action => !text(actions.get(action.id)?.observed))) {
      fail(`record observable results for every action in ${item.id}`);
    }
    if (!captureMatches(row.baseline, context, context.baselineRoute) || !captureMatches(row.actual, context, context.actualRoute)) {
      fail(`the approved route, view, workflow state or viewport differs for ${item.id}`);
    }
    const baselineSha256 = readCapture({ repo, root, capture: row.baseline, itemId: item.id, artifact: 'prototype' });
    const actualSha256 = readCapture({ repo, root, capture: row.actual, itemId: item.id, artifact: 'actual' });
    if (baselineSha256 === actualSha256) fail(`a copied screenshot cannot prove visual consistency for ${item.id}`);
    for (const [capture, sha256, kind] of [[row.baseline, baselineSha256, 'baseline'], [row.actual, actualSha256, 'actual']]) {
      const identity = canonical({ kind, ...captureContext(capture) });
      if (used.has(sha256) && used.get(sha256) !== identity) fail(`a capture from another screen or state cannot prove ${item.id}`);
      used.set(sha256, identity);
      artifacts[capture.path] = sha256;
    }
    const steps = [...item.actions.map(action => `ux-action:${action.id}`), 'ux-final',
      ...(item.changesData ? ['ux-readback'] : []), 'ux-cleanup'];
    const observations = { actions: item.actions.map(action => ({ id: action.id, observed: actions.get(action.id).observed })),
      finalObserved: row.finalObserved, ...(item.changesData ? { readBackObserved: row.readBackObserved } : {}), cleanupObserved: row.cleanupObserved };
    const expectedContext = { origin: witness?.isolatedOrigin ?? actualOrigin, ...captureContext(row.actual), ...observations };
    if (witness?.caseId !== row.caseId || !match(witness.context, expectedContext)
      || witness.actualSha256 !== actualSha256 || !match(witness.steps, steps)) {
      fail(`prove each action, final result and capture for ${item.id} in the same current passing browser run`, 'UX_ITEM_BROWSER_EXECUTION_REQUIRED');
    }
    executionItems.push(witness);
  }
  const binding = { schemaVersion: 1, planSha256: itemPlan.sha256, machineVerificationEvidence: report.machineVerificationEvidence,
    testedCommit: evidence.testedCommit, frontendIdentity: report.frontendIdentity, itemCount: itemPlan.items.length,
    artifacts, executionItems, resultSha256: digest(canonical(report.uxItems)) };
  if (expectedBinding && !match(binding, expectedBinding)) fail('the frozen UX handoff differs from current visual and browser results');
  return binding;
}
