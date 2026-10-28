import {
  CoordinationError,
  EXIT,
  buildLifecycleContext,
  createStore,
  readClaimedRequirement,
  requirePositionals,
  requiredOption,
  runLifecycleAdvance,
  usageError,
} from './helpers.mjs';
import {
  LifecycleError,
  advanceLifecycleBatch,
  evaluateTransitionPrecheck,
  failLifecycle,
  lifecycleEvidenceShaFromRepository,
  successorState,
} from '../lifecycle.mjs';
import {
  assertBacklogProjectionClean,
  assertProjectionBranch,
  publishBacklogProjection,
} from '../repository-projection.mjs';
import { reworkLifecycle } from '../rework.mjs';
import { loadSession } from '../worktrees.mjs';

// I-132 (F6): --dry-run runs the full read path (repository probes, context
// build and the F3 precheck) and skips the coordination update and the
// BACKLOG projection publish. A gate failure exits 14 with the same
// requiredActions the real path would report — a dry run never writes
// state, so there is nothing to reconcile and exit 15 does not apply;
// success exits 0 with wouldAdvance: true.
async function dryRunAdvance({ env, clock, cwd, id, to, store, snapshot }) {
  const requirement = readClaimedRequirement(snapshot, id);
  assertBacklogProjectionClean({ cwd, id });
  assertProjectionBranch({
    cwd,
    id,
    branch: requirement.branch,
    mergedCommit: requirement.mergeStatus === 'merged' ? requirement.mergedCommit : null,
  });
  const context = await buildLifecycleContext({
    store,
    env,
    clock,
    cwd,
    snapshot,
    id,
    requirement,
    to,
  });
  const precheck = evaluateTransitionPrecheck({
    snapshot,
    cwd,
    id,
    to,
    requirement,
    context,
    clock,
  });
  if (!precheck.ok) {
    throw new LifecycleError(`lifecycle gates failed for ${id}: ${precheck.from} -> ${to} (dry run)`, {
      code: 'LIFECYCLE_GATE_FAILED',
      exitCode: EXIT.GATE_FAILED,
      data: {
        dryRun: true,
        id,
        from: precheck.from,
        to,
        ok: false,
        missing: precheck.missing,
        requiredActions: precheck.result.requiredActions,
      },
    });
  }
  return {
    message: `would advance ${id} from ${precheck.from} to ${to} (dry run)`,
    data: {
      dryRun: true,
      id,
      from: precheck.from,
      to,
      ok: true,
      wouldAdvance: true,
    },
  };
}

export default {
  command: 'lifecycle',
  summary: 'Advance (advance/next/batch-next) or fail a requirement lifecycle',
  subcommands: [
    {
      key: 'lifecycle advance',
      usage: 'lifecycle advance <ID> --to <state> [--dry-run]',
      summary: 'Advance a requirement lifecycle to an explicit state',
      options: ['to', 'dry-run'],
      supportsDryRun: true,
      handler: async ({ parsed, ctx }) => {
        const { env, clock, cwd } = ctx;
        requirePositionals(parsed, ['advance', null]);
        const [, id] = parsed.positionals;
        const to = requiredOption(parsed, 'to');
        if (parsed.options['dry-run'] === true) {
          const store = createStore(env, clock);
          const snapshot = await store.readSnapshot();
          const { message, data } = await dryRunAdvance({
            env,
            clock,
            cwd,
            id,
            to,
            store,
            snapshot,
          });
          return { message, data };
        }
        const { message, data } = await runLifecycleAdvance({ env, clock, id, to });
        return { message, data };
      },
    },
    {
      // I-131 (E1): resolve the unique successor and reuse the full advance path.
      key: 'lifecycle next',
      usage: 'lifecycle next <ID> [--dry-run]',
      summary: 'Advance a requirement lifecycle to its unique successor state',
      options: ['dry-run'],
      supportsDryRun: true,
      handler: async ({ parsed, ctx }) => {
        const { env, clock, cwd } = ctx;
        requirePositionals(parsed, ['next', null]);
        const [, id] = parsed.positionals;
        const store = createStore(env, clock);
        const snapshot = await store.readSnapshot();
        const requirement = readClaimedRequirement(snapshot, id);
        const to = successorState({
          profile: requirement.deliveryProfile,
          from: requirement.lifecycle,
        });
        if (parsed.options['dry-run'] === true) {
          const { message, data } = await dryRunAdvance({
            env,
            clock,
            cwd,
            id,
            to,
            store,
            snapshot,
          });
          return { message, data };
        }
        const { message, data } = await runLifecycleAdvance({ env, clock, id, to, store, snapshot });
        return { message, data };
      },
    },
    {
      // I-131 (E5): one atomic coordination update for a batch of co-branch
      // requirements; gates are evaluated per ID and any failure aborts the
      // whole batch, then all BACKLOG rows publish in a single commit.
      key: 'lifecycle batch-next',
      usage: 'lifecycle batch-next <ID>... [--dry-run]',
      summary: 'Advance a batch of co-branch requirements in one atomic update',
      options: ['dry-run'],
      supportsDryRun: true,
      handler: async ({ parsed, ctx }) => {
        const { env, clock, cwd } = ctx;
        if (parsed.positionals.length < 2) {
          throw usageError('invalid lifecycle command arguments');
        }
        const ids = parsed.positionals.slice(1);
        if (new Set(ids).size !== ids.length) {
          throw usageError('lifecycle batch-next does not accept duplicate requirement ids');
        }
        const store = createStore(env, clock);
        const snapshot = await store.readSnapshot();
        const items = [];
        const requirements = new Map();
        let projectionBranch = null;
        for (const id of ids) {
          const requirement = readClaimedRequirement(snapshot, id);
          requirements.set(id, requirement);
          assertBacklogProjectionClean({ cwd, id });
          projectionBranch = assertProjectionBranch({
            cwd,
            id,
            branch: requirement.branch,
            mergedCommit: requirement.mergeStatus === 'merged' ? requirement.mergedCommit : null,
          });
          const to = successorState({
            profile: requirement.deliveryProfile,
            from: requirement.lifecycle,
          });
          items.push({
            id,
            to,
            context: await buildLifecycleContext({
              store,
              env,
              clock,
              cwd,
              snapshot,
              id,
              requirement,
              to,
            }),
          });
        }
        if (parsed.options['dry-run'] === true) {
          const evaluations = items.map(({ id, to, context }) => ({
            id,
            to,
            precheck: evaluateTransitionPrecheck({
              snapshot,
              cwd,
              id,
              to,
              requirement: requirements.get(id),
              context,
              clock,
            }),
          }));
          if (evaluations.some(({ precheck }) => !precheck.ok)) {
            throw new LifecycleError(
              `lifecycle batch gates failed for ${
                evaluations.filter(({ precheck }) => !precheck.ok).map(({ id }) => id).join(', ')
              } (dry run)`,
              {
                code: 'LIFECYCLE_GATE_FAILED',
                exitCode: EXIT.GATE_FAILED,
                data: {
                  dryRun: true,
                  ok: false,
                  results: evaluations.map(({ id, to, precheck }) => ({
                    id,
                    from: precheck.from,
                    to,
                    allowed: precheck.ok,
                    missing: precheck.missing,
                    requiredActions: precheck.result.requiredActions,
                  })),
                },
              },
            );
          }
          return {
            message: `would batch advance ${ids.join(', ')} (dry run)`,
            data: {
              dryRun: true,
              ok: true,
              wouldAdvance: true,
              results: evaluations.map(({ id, to, precheck }) => ({
                id,
                from: precheck.from,
                to,
              })),
            },
          };
        }
        const result = await advanceLifecycleBatch({ store, cwd, items, clock });
        const published = publishBacklogProjection({
          cwd,
          remote: store.remote,
          branch: projectionBranch,
          id: ids[0],
          ids,
          message: `docs(docs): batch project ${
            result.results.map(({ id, lifecycle }) => `${id} to ${lifecycle} [${id}]`).join('; ')
          }`,
        });
        return { message: `batch advanced ${ids.join(', ')}`, data: { ...result, published } };
      },
    },
    {
      key: 'lifecycle rework',
      usage: 'lifecycle rework <ID> --kind correction|ux|requirements --reason <reason> --instruction-ref <ref>',
      summary: 'Return feedback to the appropriate decision or implementation stage and invalidate derived facts',
      options: ['kind', 'reason', 'instruction-ref'],
      handler: async ({ parsed, ctx }) => {
        const { env, clock, cwd } = ctx;
        requirePositionals(parsed, ['rework', null]);
        const [, id] = parsed.positionals;
        const store = createStore(env, clock);
        const snapshot = await store.readSnapshot();
        const requirement = readClaimedRequirement(snapshot, id);
        assertBacklogProjectionClean({ cwd, id });
        const branch = assertProjectionBranch({ cwd, id, branch: requirement.branch,
          mergedCommit: requirement.mergeStatus === 'merged' ? requirement.mergedCommit : null });
        const result = await reworkLifecycle({ store, cwd, id, kind: requiredOption(parsed, 'kind'),
          reason: requiredOption(parsed, 'reason'), instructionRef: requiredOption(parsed, 'instruction-ref'),
          actor: loadSession({ cwd, sessionId: env.COORD_SESSION_ID }), clock });
        const published = publishBacklogProjection({ cwd, remote: store.remote, branch, id,
          message: `docs(docs): rework ${id} to ${result.lifecycle} [${id}]` });
        return { message: `returned ${id} to ${result.lifecycle} for ${result.kind}`, data: { ...result, published } };
      },
    },
    {
      key: 'lifecycle fail',
      usage: 'lifecycle fail <ID> --reason <reason> [--evidence-sha <sha>]',
      summary: 'Return a requirement lifecycle to in_dev',
      options: ['reason', 'evidence-sha'],
      handler: async ({ parsed, ctx }) => {
        const { env, clock, cwd } = ctx;
        requirePositionals(parsed, ['fail', null]);
        const [, id] = parsed.positionals;
        const store = createStore(env, clock);
        const snapshot = await store.readSnapshot();
        const requirementPath = `requirements/${id}.json`;
        if (!snapshot.has(requirementPath)) {
          throw new CoordinationError(`requirement is not claimed: ${id}`, {
            code: 'REQUIREMENT_NOT_FOUND',
          });
        }
        const requirement = snapshot.readJson(requirementPath);
        assertBacklogProjectionClean({ cwd, id });
        const projectionBranch = assertProjectionBranch({
          cwd,
          id,
          branch: requirement.branch,
          mergedCommit: requirement.mergeStatus === 'merged' ? requirement.mergedCommit : null,
        });
        const evidenceSha = typeof parsed.options['evidence-sha'] === 'string'
          ? parsed.options['evidence-sha']
          : lifecycleEvidenceShaFromRepository({ cwd, id });
        const result = await failLifecycle({
          store,
          cwd,
          id,
          reason: requiredOption(parsed, 'reason'),
          evidenceSha,
          clock,
        });
        const published = publishBacklogProjection({
          cwd,
          remote: store.remote,
          branch: projectionBranch,
          id,
          message: `docs(docs): project ${id} to ${result.lifecycle} [${id}]`,
        });
        return { message: `returned ${id} to in_dev`, data: { ...result, published } };
      },
    },
  ],
};
