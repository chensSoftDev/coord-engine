import { createStore, requirePositionals } from './helpers.mjs';
import { auditBranches } from '../branch-audit.mjs';

export default {
  command: 'branch',
  summary: 'Audit requirement, train, remote and worktree branches',
  subcommands: [
    {
      key: 'branch audit',
      usage: 'branch audit',
      summary: 'Report branch ownership and legacy/orphan findings without changing refs',
      options: [],
      handler: async ({ parsed, ctx }) => {
        const { env, clock, cwd } = ctx;
        requirePositionals(parsed, ['audit']);
        const store = createStore(env, clock);
        const snapshot = await store.readSnapshot();
        const result = auditBranches({ cwd, snapshot, remote: store.remote });
        return {
          message: result.ok ? 'branch audit passed' : `branch audit found ${result.findings.length} finding(s)`,
          data: result,
        };
      },
    },
  ],
};
