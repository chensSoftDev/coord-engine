import { createStore, requirePositionals } from './helpers.mjs';
import { closureSweep } from '../closure-sweep.mjs';

export default {
  command: 'closure',
  summary: 'Audit terminal requirements, trains and Version issues',
  subcommands: [
    {
      key: 'closure sweep',
      usage: 'closure sweep',
      summary: 'Find terminal refs, stale worktrees and unresolved Version issues',
      options: [],
      handler: async ({ parsed, ctx }) => {
        const { env, clock, cwd } = ctx;
        requirePositionals(parsed, ['sweep']);
        const store = createStore(env, clock);
        const snapshot = await store.readSnapshot();
        const result = closureSweep({ cwd, snapshot, remote: store.remote });
        return {
          message: result.ok ? 'closure sweep passed' : `closure sweep found ${result.findings.length} finding(s)`,
          data: result,
        };
      },
    },
  ],
};
