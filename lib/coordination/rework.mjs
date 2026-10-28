import { LifecycleError, projectBacklog } from './lifecycle.mjs';
import { assertRequirementId } from './validation.mjs';
import { invalidateWorkflowFacts } from './workflow-facts.mjs';

const TERMINAL = new Set(['prod_deployed', 'merged', 'done', 'cancelled']);
const REWORKABLE = new Set(['reviewing', 'req_confirmed', 'tech_design', 'in_dev', 'dev_deployed', 'testing', 'test_passed', 'prod_planning']);

export function reworkTransition({ from, kind, reason, instructionRef }) {
  if (TERMINAL.has(from)) {
    throw new LifecycleError('production or terminal facts require a new requirement or an explicitly authorized recovery plan', {
      code: 'REWORK_TERMINAL_STATE', exitCode: 12,
      data: { from, remediation: 'record a new requirement; production rollback requires explicit authorization' },
    });
  }
  if (!['correction', 'ux', 'requirements'].includes(kind)) {
    throw new LifecycleError('rework kind must be correction, ux or requirements', { code: 'INVALID_REWORK_KIND', exitCode: 12 });
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
      : ['reviewing', 'req_confirmed', 'tech_design'].includes(from) ? from : 'in_dev';
  return { from, to, kind, reason: reason.trim(), instructionRef: instructionRef.trim() };
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
