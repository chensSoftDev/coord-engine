import { LifecycleError, projectBacklog } from './lifecycle.mjs';
import { assertRequirementId } from './validation.mjs';
import { invalidateWorkflowFacts } from './workflow-facts.mjs';
import { createHash } from 'node:crypto';
import { resolveAcceptanceFact } from './ui-acceptance.mjs';

const TERMINAL = new Set(['prod_deployed', 'merged', 'done', 'cancelled']);
const REWORKABLE = new Set(['reviewing', 'req_confirmed', 'tech_design', 'in_dev', 'dev_deployed', 'testing', 'user_acceptance', 'test_passed', 'prod_planning']);

export function reworkTransition({ from, kind, reason, instructionRef }) {
  if (TERMINAL.has(from)) {
    throw new LifecycleError('production or terminal facts require a new requirement or an explicitly authorized recovery plan', {
      code: 'REWORK_TERMINAL_STATE', exitCode: 12,
      data: { from, remediation: 'record a new requirement; production rollback requires explicit authorization' },
    });
  }
  if (!['correction', 'design', 'ux', 'requirements'].includes(kind)) {
    throw new LifecycleError('rework kind must be correction, design, ux or requirements', { code: 'INVALID_REWORK_KIND', exitCode: 12 });
  }
  if (!REWORKABLE.has(from)) {
    throw new LifecycleError(`cannot rework from ${from}`, { code: 'INVALID_TRANSITION', exitCode: 12 });
  }
  if (typeof reason !== 'string' || reason.trim().length < 10 || reason.trim().length > 500 || /[\r\n]/.test(reason)) {
    throw new LifecycleError('rework requires a single-line reason between 10 and 500 characters', { code: 'INVALID_REWORK_REASON', exitCode: 12 });
  }
  if (typeof instructionRef !== 'string' || instructionRef.trim().length < 8 || /[\r\n]/.test(instructionRef)) {
    throw new LifecycleError('reference the user feedback or observed failure that requires rework', { code: 'INVALID_REWORK_INSTRUCTION', exitCode: 12 });
  }
  const to = kind === 'requirements' ? 'reviewing'
    : kind === 'ux' ? (from === 'reviewing' ? 'reviewing' : 'req_confirmed')
      : kind === 'design' ? (['reviewing', 'req_confirmed'].includes(from) ? from : 'tech_design')
      : ['reviewing', 'req_confirmed', 'tech_design'].includes(from) ? from : 'in_dev';
  return { from, to, kind, reason: reason.trim(), instructionRef: instructionRef.trim() };
}

export function planReworkBatch({ requirement, batch }) {
  const invalid = () => { throw new LifecycleError('feedback batch requires a stable batch ID, unique feedback IDs and explicit supported classifications', { code: 'INVALID_REWORK_BATCH', exitCode: 12 }); };
  if (batch?.schemaVersion !== 1 || !/^[A-Za-z][A-Za-z0-9_-]{2,63}$/.test(batch.batchId ?? '')
    || !Array.isArray(batch.items) || !batch.items.length || batch.items.length > 200) invalid();
  const ids = new Set();
  const priority = ['correction', 'design', 'ux', 'requirements'];
  for (const item of batch.items) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{1,63}$/.test(item?.feedbackId ?? '') || ids.has(item.feedbackId) || !priority.includes(item.kind)) invalid();
    ids.add(item.feedbackId);
  }
  const kind = priority[Math.max(...batch.items.map(item => priority.indexOf(item.kind)))];
  const transition = reworkTransition({ from: requirement.lifecycle, kind, reason: batch.reason, instructionRef: batch.instructionRef });
  return { ...transition, batchId: batch.batchId, candidateId: batch.candidateId ?? null,
    items: structuredClone(batch.items) };
}

export async function reworkLifecycleBatch({ store, cwd, id, batch, actor = 'unknown', clock = () => new Date() }) {
  assertRequirementId(id);
  // Validate before writing. The immutable digest prevents a retry from changing
  // the meaning of a batch that already moved the workflow.
  const canonical = value => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(key => [key, v[key]])) : v);
  const batchHash = createHash('sha256').update(canonical(batch)).digest('hex');
  let result;
  let lifecycle;
  let reused = false;
  const update = await store.update({ operation: `apply feedback batch ${id}/${batch?.batchId}`,
    auditData: { requirementId: id, batchId: batch?.batchId, batchHash, actor }, mutate(snapshot) {
      const path = `requirements/${id}.json`;
      if (!snapshot.has(path)) throw new LifecycleError(`requirement ${id} is absent`, { code: 'REQUIREMENT_NOT_FOUND' });
      const requirement = snapshot.readJson(path);
      lifecycle = requirement.lifecycle;
      if (!/^[A-Za-z][A-Za-z0-9_-]{2,63}$/.test(batch?.batchId ?? '')) planReworkBatch({ requirement, batch });
      const recordPath = `feedback-batches/${id}/${batch.batchId}.json`;
      if (snapshot.has(recordPath)) {
        result = snapshot.readJson(recordPath);
        if (result.batchHash !== batchHash) throw new LifecycleError('batch ID was already used for different feedback', { code: 'REWORK_BATCH_CONFLICT', exitCode: 12 });
        reused = true;
        return;
      }
      const plan = planReworkBatch({ requirement, batch });
      const candidate = resolveAcceptanceFact(snapshot, id);
      if (candidate && (plan.candidateId !== candidate.candidateId || !/^user-message:[A-Za-z0-9._:-]{6,}$/.test(plan.instructionRef))) {
        throw new LifecycleError('classify feedback against the exact current candidate using its direct human reference', { code: 'REWORK_CANDIDATE_MISMATCH', exitCode: 12 });
      }
      const at = clock().toISOString();
      let releasedEnvironment = false;
      if (snapshot.has('freezes/dev.json')) {
        const freeze = snapshot.readJson('freezes/dev.json');
        if (freeze.requirementId === id) {
          if (plan.candidateId !== freeze.candidateId || !/^user-message:[A-Za-z0-9._:-]{6,}$/.test(plan.instructionRef)) {
            throw new LifecycleError('reject the exact current candidate using the direct human feedback reference', { code: 'REWORK_CANDIDATE_MISMATCH', exitCode: 12 });
          }
          // Rework intentionally releases the human window. The next shared
          // operation must acquire its own lease; no lease is fabricated here.
          snapshot.delete('freezes/dev.json');
          releasedEnvironment = true;
        }
      }
      const invalidation = invalidateWorkflowFacts(snapshot, id, requirement, { ...plan, actor, at, cwd });
      snapshot.writeJson(path, { ...requirement, ...invalidation, lifecycle: plan.to,
        lifecycleHistory: [...(requirement.lifecycleHistory ?? []), { type: 'rework', ...plan, actor, at }], updatedAt: at });
      result = { schemaVersion: 1, id, batchHash, ...plan, lifecycle: plan.to, releasedEnvironment, actor, at };
      lifecycle = plan.to;
      snapshot.writeJson(recordPath, result);
    } });
  try {
    const projection = projectBacklog({ cwd, id, from: reused && lifecycle !== result.to ? lifecycle : result.from, to: lifecycle });
    return { ...result, lifecycle, reused, projection, coordinationSha: update.sha, operationId: update.operationId };
  } catch (cause) {
    throw new LifecycleError('feedback batch applied; reconcile its BACKLOG projection before continuing', { code: 'PROJECTION_UNCERTAIN', exitCode: 15, cause,
      data: { id, batchId: result.batchId, lifecycle, requiredActions: [`pnpm coord reconcile ${id} --json`] } });
  }
}

export async function reworkLifecycle({ store, cwd, id, kind, reason, instructionRef, actor = 'unknown', clock = () => new Date() }) {
  assertRequirementId(id);
  let transition;
  const update = await store.update({
    operation: `rework ${id} (${kind})`,
    auditData: { requirementId: id, kind, reason, instructionRef, actor },
    mutate(snapshot) {
      const path = `requirements/${id}.json`;
      if (!snapshot.has(path)) throw new LifecycleError(`requirement ${id} is absent`, { code: 'REQUIREMENT_NOT_FOUND' });
      const requirement = snapshot.readJson(path);
      transition = reworkTransition({ from: requirement.lifecycle, kind, reason, instructionRef });
      if (resolveAcceptanceFact(snapshot, id)?.attemptId) {
        throw new LifecycleError('classify candidate feedback once with lifecycle rework-batch', { code: 'REWORK_BATCH_REQUIRED', exitCode: 12,
          data: { requiredActions: [`pnpm coord lifecycle rework-batch ${id} --batch <file> --json`] } });
      }
      if (snapshot.has('freezes/dev.json')) {
        const freeze = snapshot.readJson('freezes/dev.json');
        if (freeze.requirementId === id) {
          throw new LifecycleError('reject the active acceptance freeze before rework; it will restore this requirement\'s dev lease', {
            code: 'REWORK_FROZEN', exitCode: 10,
            data: { requiredActions: [`pnpm coord freeze reject dev --requirement ${id} --reason <user-feedback>`] },
          });
        }
      }
      const at = clock().toISOString();
      const invalidation = invalidateWorkflowFacts(snapshot, id, requirement, { kind, reason, instructionRef, actor, at, cwd });
      snapshot.writeJson(path, { ...requirement, ...invalidation,
        lifecycle: transition.to,
        lifecycleHistory: [...(requirement.lifecycleHistory ?? []), { type: 'rework', ...transition, actor, at }],
        updatedAt: at });
    },
  });
  try {
    const projection = projectBacklog({ cwd, id, from: transition.from, to: transition.to });
    return { id, lifecycle: transition.to, kind, projection, coordinationSha: update.sha, operationId: update.operationId };
  } catch (cause) {
    throw new LifecycleError('rework coordination changed but BACKLOG projection needs reconciliation', {
      code: 'PROJECTION_UNCERTAIN', exitCode: 15, cause,
      data: { id, lifecycle: transition.to, coordinationSha: update.sha, operationId: update.operationId,
        requiredActions: [`pnpm coord reconcile ${id} --json`] },
    });
  }
}
