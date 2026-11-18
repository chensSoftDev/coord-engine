import { createStore, requirePositionals } from './helpers.mjs';
import { auditBranches } from '../branch-audit.mjs';
import { coordinationStats } from '../stats.mjs';

export default {
  command: 'stats',
  summary: 'Summarize coordination, Version, train and iteration issue facts',
  subcommands: [
    {
      key: 'stats',
      usage: 'stats',
      summary: 'Show lifecycle, Version, train, branch and issue counts',
      options: [],
      handler: async ({ parsed, ctx }) => {
        const { env, clock, cwd } = ctx;
        requirePositionals(parsed, []);
        const store = createStore(env, clock);
        const snapshot = await store.readSnapshot();
        let branchAudit = null;
        try {
          branchAudit = auditBranches({ cwd, snapshot, remote: store.remote });
        } catch (error) {
          branchAudit = { findings: [], summary: { unavailable: true, message: error.message } };
        }
        return {
          message: 'coordination stats',
          data: coordinationStats({ cwd, snapshot, branchAudit }),
        };
      },
    },
  ],
};
