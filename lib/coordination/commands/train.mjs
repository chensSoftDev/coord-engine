import { createStore, requirePositionals, requiredOption, usageError } from './helpers.mjs';
import {
  addTrainMember,
  closeTrain,
  createTrain,
  promoteTrainCandidate,
  recordTrainCandidate,
  showTrain,
} from '../trains.mjs';

export default {
  command: 'train',
  summary: 'Create and manage Version integration trains',
  subcommands: [
    {
      key: 'train create',
      usage: 'train create <version> [--base <ref>]',
      summary: 'Create train/<version> from a fixed base commit',
      options: ['base'],
      handler: async ({ parsed, ctx }) => {
        const { env, clock, cwd } = ctx;
        requirePositionals(parsed, ['create', null]);
        const [, version] = parsed.positionals;
        const result = await createTrain({ store: createStore(env, clock), cwd, version, base: parsed.options.base ?? 'origin/main', clock });
        return { message: `created train/${version}`, data: result };
      },
    },
    {
      key: 'train add',
      usage: 'train add <version> <ID>',
      summary: 'Add a same-Version requirement to the train',
      options: [],
      handler: async ({ parsed, ctx }) => {
        const { env, clock } = ctx;
        requirePositionals(parsed, ['add', null, null]);
        const [, version, requirementId] = parsed.positionals;
        const result = await addTrainMember({ store: createStore(env, clock), version, requirementId, clock });
        return { message: `added ${requirementId} to train/${version}`, data: result };
      },
    },
    {
      key: 'train candidate',
      usage: 'train candidate <version> --commit <sha>',
      summary: 'Record an immutable train candidate commit',
      options: ['commit'],
      handler: async ({ parsed, ctx }) => {
        const { env, clock, cwd } = ctx;
        requirePositionals(parsed, ['candidate', null]);
        const [, version] = parsed.positionals;
        const result = await recordTrainCandidate({ store: createStore(env, clock), cwd, version, commit: requiredOption(parsed, 'commit'), clock });
        return { message: `recorded train candidate for ${version}`, data: result };
      },
    },
    {
      key: 'train promote',
      usage: 'train promote <version> --commit <sha>',
      summary: 'Bind the candidate to the main merge commit after train integration',
      options: ['commit'],
      handler: async ({ parsed, ctx }) => {
        const { env, clock, cwd } = ctx;
        requirePositionals(parsed, ['promote', null]);
        const [, version] = parsed.positionals;
        const result = await promoteTrainCandidate({ store: createStore(env, clock), cwd, version, commit: requiredOption(parsed, 'commit'), clock });
        return { message: `promoted train/${version}`, data: result };
      },
    },
    {
      key: 'train show',
      usage: 'train show <version>',
      summary: 'Show the Version train and immutable candidate baseline',
      options: [],
      handler: async ({ parsed, ctx }) => {
        const { env, clock } = ctx;
        requirePositionals(parsed, ['show', null]);
        const [, version] = parsed.positionals;
        const train = await showTrain({ store: createStore(env, clock), version });
        if (!train) throw usageError(`${version} has no train`);
        return { message: `train/${version}`, data: { train } };
      },
    },
    {
      key: 'train close',
      usage: 'train close <version>',
      summary: 'Close a Version train after release completion',
      options: [],
      handler: async ({ parsed, ctx }) => {
        const { env, clock } = ctx;
        requirePositionals(parsed, ['close', null]);
        const [, version] = parsed.positionals;
        const result = await closeTrain({ store: createStore(env, clock), version, clock });
        return { message: `closed train/${version}`, data: result };
      },
    },
  ],
};
