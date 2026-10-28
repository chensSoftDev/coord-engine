import {
  createStore,
  requirePositionals,
  requiredOption,
  usageError,
} from './helpers.mjs';
import { recordDeployment } from '../deployments.mjs';
import { loadSession } from '../worktrees.mjs';

export default {
  command: 'deployment',
  summary: 'Record a successful shared-environment deployment',
  subcommands: [
    {
      key: 'deployment record',
      usage: 'deployment record <stage> --requirement <ID> --snapshot <file>',
      summary: 'Record a successful shared-environment deployment',
      options: ['requirement', 'snapshot'],
      handler: async ({ parsed, ctx }) => {
        const { env, clock, cwd } = ctx;
        requirePositionals(parsed, ['record', null]);
        const [, stage] = parsed.positionals;
        if (
          Object.hasOwn(parsed.options, 'version')
          || Object.hasOwn(parsed.options, 'commit')
          || Object.hasOwn(parsed.options, 'service')
        ) {
          throw usageError('deployment facts must come from --snapshot, not manual options');
        }
        const result = await recordDeployment({
          store: createStore(env, clock),
          cwd,
          stage,
          requirementId: requiredOption(parsed, 'requirement'),
          snapshotPath: requiredOption(parsed, 'snapshot'),
          session: loadSession({ cwd, sessionId: env.COORD_SESSION_ID }),
          clock,
        });
        return {
          message: `recorded ${stage} deployment for ${result.deployment.requirementId}`,
          data: result,
        };
      },
    },
  ],
};
