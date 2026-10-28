import {
  createStore,
  requirePositionals,
  requiredOption,
} from './helpers.mjs';
import {
  preflightRepositoryGate,
  readGateEvent,
  validateRepositoryGate,
} from '../gate.mjs';

export default {
  command: 'gate',
  summary: 'Validate pull request and merge-group gates',
  subcommands: [
    {
      key: 'gate validate',
      usage: 'gate validate --event <file> --head <sha> --base <sha>',
      summary: 'Validate the repository coordination gate for a GitHub event',
      options: ['event', 'head', 'base'],
      handler: async ({ parsed, ctx }) => {
        const { env, clock, cwd } = ctx;
        requirePositionals(parsed, ['validate']);
        const result = await validateRepositoryGate({
          cwd,
          store: createStore(env, clock),
          event: readGateEvent(requiredOption(parsed, 'event')),
          head: requiredOption(parsed, 'head'),
          base: requiredOption(parsed, 'base'),
        });
        return { message: 'repository coordination gate passed', data: result };
      },
    },
    {
      key: 'gate preflight',
      usage: 'gate preflight --head <sha> --base <sha>',
      summary: 'Run the repository coordination gate preflight checks',
      options: ['head', 'base'],
      handler: async ({ parsed, ctx }) => {
        const { env, clock, cwd } = ctx;
        requirePositionals(parsed, ['preflight']);
        const result = await preflightRepositoryGate({
          cwd,
          store: createStore(env, clock),
          head: requiredOption(parsed, 'head'),
          base: requiredOption(parsed, 'base'),
        });
        return { message: 'repository coordination gate passed', data: result };
      },
    },
  ],
};
