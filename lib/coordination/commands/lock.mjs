import {
  createStore,
  requirePositionals,
  requiredOption,
} from './helpers.mjs';
import {
  acquireLease,
  assertLease,
  breakLease,
  releaseLease,
  renewLease,
} from '../leases.mjs';
import { loadSession } from '../worktrees.mjs';

export default {
  command: 'lock',
  summary: 'Acquire, renew, assert, or release a lease',
  subcommands: [
    {
      key: 'lock acquire',
      usage: 'lock acquire <resource> --requirement <ID> --ttl <ttl>',
      summary: 'Acquire a shared-environment lease',
      options: ['requirement', 'ttl'],
      handler: async ({ parsed, ctx }) => {
        const { env, clock, cwd } = ctx;
        requirePositionals(parsed, ['acquire', null]);
        const [, resource] = parsed.positionals;
        const result = await acquireLease({
          store: createStore(env, clock),
          cwd,
          resource,
          requirementId: requiredOption(parsed, 'requirement'),
          ttl: requiredOption(parsed, 'ttl'),
          session: loadSession({ cwd, sessionId: env.COORD_SESSION_ID }),
          clock,
        });
        return { message: `acquired ${resource} lease`, data: result };
      },
    },
    {
      key: 'lock renew',
      usage: 'lock renew <resource> --ttl <ttl>',
      summary: 'Renew a held lease',
      options: ['ttl'],
      handler: async ({ parsed, ctx }) => {
        const { env, clock, cwd } = ctx;
        requirePositionals(parsed, ['renew', null]);
        const [, resource] = parsed.positionals;
        const result = await renewLease({
          store: createStore(env, clock),
          cwd,
          resource,
          ttl: requiredOption(parsed, 'ttl'),
          session: loadSession({ cwd, sessionId: env.COORD_SESSION_ID }),
          clock,
        });
        return { message: `renewed ${resource} lease`, data: result };
      },
    },
    {
      key: 'lock assert',
      usage: 'lock assert <resource> --requirement <ID> --commit <sha>',
      summary: 'Assert a held lease against a requirement and commit',
      options: ['requirement', 'commit'],
      handler: async ({ parsed, ctx }) => {
        const { env, clock, cwd } = ctx;
        requirePositionals(parsed, ['assert', null]);
        const [, resource] = parsed.positionals;
        const result = await assertLease({
          store: createStore(env, clock),
          cwd,
          resource,
          requirementId: requiredOption(parsed, 'requirement'),
          commit: requiredOption(parsed, 'commit'),
          session: loadSession({ cwd, sessionId: env.COORD_SESSION_ID }),
          clock,
        });
        return { message: `asserted ${resource} lease`, data: result };
      },
    },
    {
      key: 'lock release',
      usage: 'lock release <resource>',
      summary: 'Release a held lease',
      options: [],
      handler: async ({ parsed, ctx }) => {
        const { env, clock, cwd } = ctx;
        requirePositionals(parsed, ['release', null]);
        const [, resource] = parsed.positionals;
        const result = await releaseLease({
          store: createStore(env, clock),
          cwd,
          resource,
          session: loadSession({ cwd, sessionId: env.COORD_SESSION_ID }),
          clock,
        });
        return { message: `released ${resource} lease`, data: result };
      },
    },
    {
      key: 'lock break',
      usage: 'lock break <resource> --reason <reason> [--force]',
      summary: 'Break a lease held by another session',
      options: ['reason', 'force'],
      handler: async ({ parsed, ctx }) => {
        const { env, clock, cwd } = ctx;
        requirePositionals(parsed, ['break', null]);
        const [, resource] = parsed.positionals;
        const result = await breakLease({
          store: createStore(env, clock),
          cwd,
          resource,
          reason: requiredOption(parsed, 'reason'),
          force: parsed.options.force === true,
          session: loadSession({ cwd, sessionId: env.COORD_SESSION_ID }),
          clock,
        });
        return { message: `broke ${resource} lease`, data: result };
      },
    },
  ],
};
