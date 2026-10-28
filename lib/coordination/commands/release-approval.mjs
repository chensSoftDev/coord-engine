import {
  createStore,
  requirePositionals,
  requiredOption,
} from './helpers.mjs';
import {
  recordReleaseApproval,
  revokeReleaseApproval,
  showReleaseApproval,
} from '../approvals.mjs';
import { loadSession } from '../worktrees.mjs';

export default {
  command: 'release-approval',
  summary: 'Record/show/revoke the auto-release approval fact',
  subcommands: [
    {
      key: 'release-approval record',
      usage: 'release-approval record <ID> --authorized-by <name> --instruction-ref <ref>',
      summary: 'Record the auto-release approval fact',
      options: ['authorized-by', 'instruction-ref'],
      handler: async ({ parsed, ctx }) => {
        const { env, clock, cwd } = ctx;
        requirePositionals(parsed, ['record', null]);
        const [, id] = parsed.positionals;
        const result = await recordReleaseApproval({
          store: createStore(env, clock),
          cwd,
          requirementId: id,
          authorizedBy: requiredOption(parsed, 'authorized-by'),
          instructionRef: requiredOption(parsed, 'instruction-ref'),
          session: loadSession({ cwd, sessionId: env.COORD_SESSION_ID }),
          env,
          clock,
        });
        return {
          message: `recorded release approval for ${result.requirementId}`,
          data: result,
        };
      },
    },
    {
      key: 'release-approval show',
      usage: 'release-approval show <ID>',
      summary: 'Show the auto-release approval fact',
      options: [],
      handler: async ({ parsed, ctx }) => {
        const { env, clock } = ctx;
        requirePositionals(parsed, ['show', null]);
        const [, id] = parsed.positionals;
        const approval = await showReleaseApproval({
          store: createStore(env, clock),
          requirementId: id,
        });
        return {
          message: approval
            ? `release approval active for ${id}`
            : `no active release approval for ${id}`,
          data: { approval },
        };
      },
    },
    {
      key: 'release-approval revoke',
      usage: 'release-approval revoke <ID> --reason <reason>',
      summary: 'Revoke the auto-release approval fact',
      options: ['reason'],
      handler: async ({ parsed, ctx }) => {
        const { env, clock, cwd } = ctx;
        requirePositionals(parsed, ['revoke', null]);
        const [, id] = parsed.positionals;
        const result = await revokeReleaseApproval({
          store: createStore(env, clock),
          cwd,
          requirementId: id,
          reason: requiredOption(parsed, 'reason'),
          session: loadSession({ cwd, sessionId: env.COORD_SESSION_ID }),
          clock,
        });
        return {
          message: `revoked release approval for ${result.requirementId}`,
          data: result,
        };
      },
    },
  ],
};
