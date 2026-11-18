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
  subcommands: ['record', 'resume'].map(action => (
    {
      key: `deployment ${action}`,
      usage: `deployment ${action} <stage> --requirement <ID> --snapshot <file>`,
      summary: action === 'resume' ? 'Resume recording without replacing a newer successful deployment' : 'Record a successful shared-environment deployment',
      options: ['requirement', 'snapshot'],
      handler: async ({ parsed, ctx }) => {
        const { env, clock, cwd } = ctx;
        requirePositionals(parsed, [action, null]);
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
          resume: action === 'resume',
          clock,
        });
        return {
          message: `recorded ${stage} deployment for ${result.deployment.requirementId}`,
          data: result,
        };
      },
    }
  )),
};
