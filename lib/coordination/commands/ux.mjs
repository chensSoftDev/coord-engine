import { createStore, readClaimedRequirement, requirePositionals, requiredOption } from './helpers.mjs';
import { inspectUxArtifacts } from '../ux-artifacts.mjs';
import { evaluateUxReadiness, recordUxApproval, revokeUxApproval, showUxApproval } from '../ux-approvals.mjs';
import { loadSession } from '../worktrees.mjs';

export default {
  command: 'ux',
  summary: 'Prepare, record, show, or revoke a requirement UX review',
  subcommands: [
    {
      key: 'ux prepare', usage: 'ux prepare <ID>', summary: 'Inspect the committed UX review package', options: [],
      handler: async ({ parsed, ctx }) => {
        requirePositionals(parsed, ['prepare', null]);
        const [, id] = parsed.positionals;
        const store = createStore(ctx.env, ctx.clock);
        const snapshot = await store.readSnapshot();
        const requirement = readClaimedRequirement(snapshot, id);
        const artifacts = inspectUxArtifacts({ cwd: ctx.cwd, id, requireFeedbackDefinitions: requirement.workflowVersion === 2 });
        const readiness = evaluateUxReadiness({ snapshot, cwd: ctx.cwd, requirement });
        return {
          message: `${id} UX review package ${artifacts.ok ? 'ready for review' : 'incomplete'}`,
          data: {
            requirementId: id, uxImpact: requirement.uxImpact ?? 'legacy',
            version: requirement.version, ...artifacts, readiness,
            command: 'pnpm ux:prototype',
          },
        };
      },
    },
    {
      key: 'ux approve',
      usage: 'ux approve <ID> --authorized-by <user> --instruction-ref user-message:<id>',
      summary: 'Record explicit user approval of the current committed UX package',
      options: ['authorized-by', 'instruction-ref'],
      handler: async ({ parsed, ctx }) => {
        requirePositionals(parsed, ['approve', null]);
        const [, id] = parsed.positionals;
        const result = await recordUxApproval({
          store: createStore(ctx.env, ctx.clock), cwd: ctx.cwd, id,
          authorizedBy: requiredOption(parsed, 'authorized-by'),
          instructionRef: requiredOption(parsed, 'instruction-ref'),
          session: loadSession({ cwd: ctx.cwd, sessionId: ctx.env.COORD_SESSION_ID }),
          env: ctx.env, clock: ctx.clock,
        });
        return { message: `recorded UX approval for ${id}`, data: result };
      },
    },
    {
      key: 'ux show', usage: 'ux show <ID>', summary: 'Show current UX approval and readiness', options: [],
      handler: async ({ parsed, ctx }) => {
        requirePositionals(parsed, ['show', null]);
        const [, id] = parsed.positionals;
        const store = createStore(ctx.env, ctx.clock);
        const snapshot = await store.readSnapshot();
        const requirement = readClaimedRequirement(snapshot, id);
        const approval = showUxApproval({ snapshot, id });
        const readiness = evaluateUxReadiness({ snapshot, cwd: ctx.cwd, requirement });
        return { message: `${id} UX ${readiness.ok ? 'ready' : 'pending'}`, data: { requirementId: id, approval, readiness } };
      },
    },
    {
      key: 'ux revoke', usage: 'ux revoke <ID> --reason <reason>', summary: 'Revoke a recorded UX approval', options: ['reason'],
      handler: async ({ parsed, ctx }) => {
        requirePositionals(parsed, ['revoke', null]);
        const [, id] = parsed.positionals;
        const result = await revokeUxApproval({
          store: createStore(ctx.env, ctx.clock), cwd: ctx.cwd, id,
          reason: requiredOption(parsed, 'reason'),
          session: loadSession({ cwd: ctx.cwd, sessionId: ctx.env.COORD_SESSION_ID }),
          env: ctx.env, clock: ctx.clock,
        });
        return { message: `revoked UX approval for ${id}`, data: result };
      },
    },
  ],
};
