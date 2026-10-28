import {
  createStore,
  requirePositionals,
  requiredOption,
} from './helpers.mjs';
import {
  createRequirementWorktree,
  joinRequirementWorktree,
  loadSession,
} from '../worktrees.mjs';

export default {
  command: 'worktree',
  summary: 'Create or join requirement worktrees',
  subcommands: [
    {
      key: 'worktree create',
      usage: 'worktree create <ID> --topic <topic>',
      summary: 'Create a requirement worktree',
      options: ['topic'],
      handler: async ({ parsed, ctx }) => {
        const { env, clock, cwd } = ctx;
        requirePositionals(parsed, ['create', null]);
        const [, id] = parsed.positionals;
        const result = await createRequirementWorktree({
          cwd,
          store: createStore(env, clock),
          id,
          topic: requiredOption(parsed, 'topic'),
          session: loadSession({ cwd, sessionId: env.COORD_SESSION_ID }),
        });
        return { message: `created worktree for ${id}`, data: result };
      },
    },
    {
      key: 'worktree join',
      usage: 'worktree join <ID> --path <path>',
      summary: 'Join an existing requirement worktree',
      options: ['path'],
      handler: async ({ parsed, ctx }) => {
        const { env, clock, cwd } = ctx;
        requirePositionals(parsed, ['join', null]);
        const [, id] = parsed.positionals;
        const result = await joinRequirementWorktree({
          cwd,
          store: createStore(env, clock),
          id,
          path: requiredOption(parsed, 'path'),
          session: loadSession({ cwd, sessionId: env.COORD_SESSION_ID }),
        });
        return { message: `joined worktree for ${id}`, data: result };
      },
    },
  ],
};
