import { createStore, requirePositionals } from './helpers.mjs';
import { syncBacklogFromCoordination } from '../backlog-projection.mjs';

export default {
  command: 'backlog',
  summary: 'Regenerate the full BACKLOG projection from coordination facts',
  subcommands: [
    {
      key: 'backlog generate',
      usage: 'backlog generate [--check]',
      summary: 'Synchronize every coordinated requirement row in BACKLOG.md',
      options: ['check'],
      handler: async ({ parsed, ctx }) => {
        const { env, clock, cwd } = ctx;
        requirePositionals(parsed, ['generate']);
        const snapshot = await createStore(env, clock).readSnapshot();
        const result = syncBacklogFromCoordination({
          cwd,
          snapshot,
          check: parsed.options.check === true,
        });
        return {
          message: result.changed ? 'regenerated BACKLOG.md' : 'BACKLOG.md is synchronized',
          data: result,
        };
      },
    },
  ],
};
