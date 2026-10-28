import {
  arrayOption,
  createStore,
  requirePositionals,
  requiredOption,
} from './helpers.mjs';
import {
  clearRegressionRed,
  recordRegressionRed,
  resolveRegressionBlock,
  showRegressionRed,
} from '../regressions.mjs';
import { loadSession } from '../worktrees.mjs';

export default {
  command: 'regression',
  summary: 'Record/show/clear/resolve the regression-red fact',
  subcommands: [
    {
      key: 'regression record',
      usage: 'regression record --commit <sha> --log <path> --classification <class> --runner <runner> [--service <name>]... [--owner <owner>]',
      summary: 'Record the regression-red fact',
      options: ['commit', 'service', 'log', 'classification', 'runner', 'owner'],
      handler: async ({ parsed, ctx }) => {
        const { env, clock, cwd } = ctx;
        requirePositionals(parsed, ['record']);
        const result = await recordRegressionRed({
          store: createStore(env, clock),
          cwd,
          mainCommit: requiredOption(parsed, 'commit'),
          scope: arrayOption(parsed, 'service'),
          logPath: requiredOption(parsed, 'log'),
          classification: requiredOption(parsed, 'classification'),
          runner: requiredOption(parsed, 'runner'),
          owner: parsed.options.owner,
          session: loadSession({ cwd, sessionId: env.COORD_SESSION_ID }),
          clock,
        });
        return { message: `recorded regression-red for ${result.mainCommit}`, data: result };
      },
    },
    {
      key: 'regression show',
      usage: 'regression show',
      summary: 'Show the regression-red fact',
      options: [],
      handler: async ({ parsed, ctx }) => {
        const { env, clock } = ctx;
        requirePositionals(parsed, ['show']);
        const fact = await showRegressionRed({ store: createStore(env, clock) });
        return {
          message: fact ? 'regression-red is active' : 'no active regression-red',
          data: { fact },
        };
      },
    },
    {
      key: 'regression clear',
      usage: 'regression clear --reason <reason> --owner <owner>',
      summary: 'Clear the regression-red fact',
      options: ['reason', 'owner'],
      handler: async ({ parsed, ctx }) => {
        const { env, clock, cwd } = ctx;
        requirePositionals(parsed, ['clear']);
        const result = await clearRegressionRed({
          store: createStore(env, clock),
          cwd,
          reason: requiredOption(parsed, 'reason'),
          owner: requiredOption(parsed, 'owner'),
          session: loadSession({ cwd, sessionId: env.COORD_SESSION_ID }),
          clock,
        });
        return { message: `cleared regression-red`, data: result };
      },
    },
    {
      key: 'regression resolve',
      usage: 'regression resolve [--service <name>]...',
      summary: 'Check whether regression-red blocks a release',
      options: ['service'],
      handler: async ({ parsed, ctx }) => {
        const { env, clock } = ctx;
        requirePositionals(parsed, ['resolve']);
        const result = await resolveRegressionBlock({
          store: createStore(env, clock),
          services: arrayOption(parsed, 'service'),
        });
        return {
          message: result.blocked
            ? 'regression-red blocks this release'
            : 'regression-red does not block',
          data: result,
        };
      },
    },
  ],
};
