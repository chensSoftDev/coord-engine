import {
  arrayOption,
  createStore,
  requirePositionals,
  requiredOption,
} from './helpers.mjs';
import {
  assertCandidateMergeEquivalent,
  assertCandidateRef,
  recordCandidate,
  showCandidate,
  voidCandidate,
} from '../candidates.mjs';
import { loadSession } from '../worktrees.mjs';

export default {
  command: 'candidate',
  summary: 'Record/show/void immutable release candidates',
  subcommands: [
    {
      key: 'candidate record',
      usage: 'candidate record <ID> --ref <sha> [--service <name>]...',
      summary: 'Record an immutable release candidate',
      options: ['ref', 'service'],
      handler: async ({ parsed, ctx }) => {
        const { env, clock, cwd } = ctx;
        requirePositionals(parsed, ['record', null]);
        const [, id] = parsed.positionals;
        const services = arrayOption(parsed, 'service');
        const result = await recordCandidate({
          store: createStore(env, clock),
          cwd,
          requirementId: id,
          sourceCommit: requiredOption(parsed, 'ref'),
          services,
          runtimeInputs: {},
          buildArgs: {},
          requiredTestSet: [],
          session: loadSession({ cwd, sessionId: env.COORD_SESSION_ID }),
          clock,
        });
        return { message: `recorded candidate ${result.candidateId}`, data: result };
      },
    },
    {
      key: 'candidate show',
      usage: 'candidate show <ID> --candidate <candidate-id>',
      summary: 'Show a recorded release candidate',
      options: ['candidate'],
      handler: async ({ parsed, ctx }) => {
        const { env, clock } = ctx;
        requirePositionals(parsed, ['show', null]);
        const [, id] = parsed.positionals;
        const candidate = await showCandidate({
          store: createStore(env, clock),
          requirementId: id,
          candidateId: requiredOption(parsed, 'candidate'),
        });
        return { message: `candidate ${candidate.candidateId}`, data: { candidate } };
      },
    },
    {
      key: 'candidate void',
      usage: 'candidate void <ID> --candidate <candidate-id> --reason <reason>',
      summary: 'Void a recorded release candidate',
      options: ['candidate', 'reason'],
      handler: async ({ parsed, ctx }) => {
        const { env, clock, cwd } = ctx;
        requirePositionals(parsed, ['void', null]);
        const [, id] = parsed.positionals;
        const result = await voidCandidate({
          store: createStore(env, clock),
          cwd,
          requirementId: id,
          candidateId: requiredOption(parsed, 'candidate'),
          reason: requiredOption(parsed, 'reason'),
          session: loadSession({ cwd, sessionId: env.COORD_SESSION_ID }),
          clock,
        });
        return { message: `voided candidate ${result.candidateId}`, data: result };
      },
    },
    {
      key: 'candidate assert-ref',
      usage: 'candidate assert-ref <ID> --ref <sha>',
      summary: 'Assert a candidate ref is reachable from the requirement branch',
      options: ['ref'],
      handler: async ({ parsed, ctx }) => {
        const { env, clock, cwd } = ctx;
        requirePositionals(parsed, ['assert-ref', null]);
        const [, id] = parsed.positionals;
        const result = await assertCandidateRef({
          store: createStore(env, clock),
          cwd,
          requirementId: id,
          ref: requiredOption(parsed, 'ref'),
        });
        return {
          message: `candidate ref ${result.commit} is reachable from ${result.branch}`,
          data: result,
        };
      },
    },
    {
      key: 'candidate assert-equivalent',
      usage: 'candidate assert-equivalent <ID> --candidate <candidate-id> --release-commit <sha>',
      summary: 'Assert a candidate is equivalent to a release commit',
      options: ['candidate', 'release-commit'],
      handler: async ({ parsed, ctx }) => {
        const { env, clock, cwd } = ctx;
        requirePositionals(parsed, ['assert-equivalent', null]);
        const [, id] = parsed.positionals;
        const result = await assertCandidateMergeEquivalent({
          store: createStore(env, clock),
          cwd,
          requirementId: id,
          candidateId: requiredOption(parsed, 'candidate'),
          releaseCommit: requiredOption(parsed, 'release-commit'),
          runtimeInputs: {},
        });
        return {
          message: `candidate ${result.candidateId} is equivalent for ${result.releaseCommit}`,
          data: result,
        };
      },
    },
  ],
};
