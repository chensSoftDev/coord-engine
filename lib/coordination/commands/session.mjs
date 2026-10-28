import { hostname } from 'node:os';

import {
  requirePositionals,
  requiredOption,
} from './helpers.mjs';
import {
  initializeSession,
  loadSession,
} from '../worktrees.mjs';

export default {
  command: 'session',
  summary: 'Manage a tool-neutral session identity',
  subcommands: [
    {
      key: 'session init',
      usage: 'session init --agent <name> --user <name>',
      summary: 'Initialize a session identity',
      options: ['agent', 'user'],
      handler: async ({ parsed, ctx }) => {
        const { env, clock, cwd } = ctx;
        requirePositionals(parsed, ['init']);
        const session = initializeSession({
          cwd,
          agent: requiredOption(parsed, 'agent'),
          user: requiredOption(parsed, 'user'),
          host: env.COORD_HOST ?? hostname(),
          clock,
        });
        return { message: `initialized session ${session.sessionId}`, data: session };
      },
    },
    {
      key: 'session show',
      usage: 'session show',
      summary: 'Show the current session identity',
      options: [],
      handler: async ({ parsed, ctx }) => {
        const { env, cwd } = ctx;
        requirePositionals(parsed, ['show']);
        const session = loadSession({
          cwd,
          sessionId: env.COORD_SESSION_ID,
        });
        return { message: `session ${session.sessionId}`, data: session };
      },
    },
  ],
};
