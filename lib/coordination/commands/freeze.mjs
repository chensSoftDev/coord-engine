import {
  createStore,
  jsonFileOption,
  requirePositionals,
  requiredOption,
  usageError,
} from './helpers.mjs';
import {
  enterFreeze,
  showFreeze,
  unfreezeFact,
} from '../freezes.mjs';
import { loadSession } from '../worktrees.mjs';

// I-134 (F3): one human decision entry point. `freeze unfreeze` takes the
// outcome from --outcome; the historical accept/reject/release subcommands
// stay as deprecated aliases that pin their outcome by subcommand and run
// the very same handler.
const UNFREEZE_OUTCOME_MESSAGES = Object.freeze({
  accepted: (result) => `accepted freeze for ${result.requirementId}`,
  rejected: (result) => (
    `rejected freeze for ${result.requirementId}; dev is machine_verifying again`
  ),
  released: (result) => `released freeze for ${result.requirementId}; dev is available`,
});
const LEGACY_OUTCOME_BY_SUBCOMMAND = Object.freeze({
  accept: 'accepted',
  reject: 'rejected',
  release: 'released',
});

async function unfreezeHandler({ parsed, ctx }) {
  const { env, clock, cwd } = ctx;
  requirePositionals(parsed, [null, null]);
  const [subcommand, resource] = parsed.positionals;
  const outcome = subcommand === 'unfreeze'
    ? parsed.options.outcome
    : LEGACY_OUTCOME_BY_SUBCOMMAND[subcommand];
  const message = UNFREEZE_OUTCOME_MESSAGES[outcome];
  if (!message) {
    throw usageError(
      `--outcome must be one of: ${Object.keys(UNFREEZE_OUTCOME_MESSAGES).join(', ')}`,
    );
  }
  const result = await unfreezeFact({
    outcome,
    store: createStore(env, clock),
    cwd,
    resource,
    requirementId: requiredOption(parsed, 'requirement'),
    reason: requiredOption(parsed, 'reason'),
    authorizedBy: parsed.options['authorized-by'],
    instructionRef: parsed.options['instruction-ref'],
    session: loadSession({ cwd, sessionId: env.COORD_SESSION_ID }),
    clock,
  });
  return { message: message(result), data: result };
}

export default {
  command: 'freeze',
  summary: 'Enter/show/unfreeze the durable dev freeze fact',
  subcommands: [
    {
      key: 'freeze show',
      usage: 'freeze show <resource>',
      summary: 'Show the freeze fact for a shared environment',
      options: [],
      handler: async ({ parsed, ctx }) => {
        const { env, clock } = ctx;
        requirePositionals(parsed, ['show', null]);
        const [, resource] = parsed.positionals;
        const freeze = await showFreeze({ store: createStore(env, clock), resource });
        return {
          message: freeze
            ? `${resource} is frozen by ${freeze.requirementId}`
            : `${resource} is not frozen`,
          data: { freeze },
        };
      },
    },
    {
      key: 'freeze enter',
      usage: 'freeze enter <resource> --requirement <ID> --candidate <candidate-id> --deployment-snapshot <file> --evidence <sha>',
      summary: 'Enter the durable freeze fact for a shared environment',
      options: ['requirement', 'candidate', 'deployment-snapshot', 'evidence'],
      handler: async ({ parsed, ctx }) => {
        const { env, clock, cwd } = ctx;
        requirePositionals(parsed, ['enter', null]);
        const [, resource] = parsed.positionals;
        const result = await enterFreeze({
          store: createStore(env, clock),
          cwd,
          resource,
          requirementId: requiredOption(parsed, 'requirement'),
          candidateId: requiredOption(parsed, 'candidate'),
          deploymentSnapshot: jsonFileOption(parsed, 'deployment-snapshot', cwd),
          machineVerificationEvidence: requiredOption(parsed, 'evidence'),
          session: loadSession({ cwd, sessionId: env.COORD_SESSION_ID }),
          clock,
        });
        return { message: `froze ${resource} for ${result.requirementId}`, data: result };
      },
    },
    {
      key: 'freeze unfreeze',
      usage: 'freeze unfreeze <resource> --requirement <ID> --outcome <accepted|rejected|released> --reason <reason> [--authorized-by <user>] [--instruction-ref user-message:<id>]',
      summary: 'Record direct human acceptance (UI requires committed interactive/visual evidence) or reject/release the dev freeze',
      options: ['requirement', 'outcome', 'reason', 'authorized-by', 'instruction-ref'],
      handler: unfreezeHandler,
    },
    {
      key: 'freeze accept',
      usage: 'freeze accept <resource> --requirement <ID> --reason <reason> [--authorized-by <user>] [--instruction-ref user-message:<id>]',
      summary: 'Accept the freeze fact (deprecated: use unfreeze --outcome accepted)',
      options: ['requirement', 'reason', 'authorized-by', 'instruction-ref'],
      handler: unfreezeHandler,
    },
    {
      key: 'freeze reject',
      usage: 'freeze reject <resource> --requirement <ID> --reason <reason>',
      summary: 'Reject the freeze fact (deprecated: use unfreeze --outcome rejected)',
      options: ['requirement', 'reason'],
      handler: unfreezeHandler,
    },
    {
      key: 'freeze release',
      usage: 'freeze release <resource> --requirement <ID> --reason <reason>',
      summary: 'Release the freeze fact (deprecated: use unfreeze --outcome released)',
      options: ['requirement', 'reason'],
      handler: unfreezeHandler,
    },
  ],
};
