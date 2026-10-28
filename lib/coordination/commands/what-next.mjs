import {
  buildLifecycleContext,
  createStore,
  readClaimedRequirement,
  requirePositionals,
  validateRequirementId,
} from './helpers.mjs';
import {
  BACKLOG_STATUSES,
  evaluateTransitionPrecheck,
  successorState,
} from '../lifecycle.mjs';
import {
  assertBacklogProjectionClean,
  assertProjectionBranch,
} from '../repository-projection.mjs';

// I-132 (F3): read-only "what do I do next" diagnostic. It runs the same
// repository probes and context build the advance path runs (in collect
// mode, so every blocker surfaces in one pass) and evaluates the same
// gate precheck — the advance path and this command can never drift apart.
// It never writes coordination state, never touches BACKLOG.md and never
// pushes; exit is 0 unless the requirement does not exist or the invocation
// is malformed.
export default {
  command: 'what-next',
  summary: 'Diagnose the next lifecycle step and its missing prerequisites',
  subcommands: [
    {
      key: 'what-next',
      usage: 'what-next <ID>',
      summary: 'Show the next lifecycle step and what still blocks it',
      options: [],
      handler: async ({ parsed, ctx }) => {
        const { env, clock, cwd } = ctx;
        requirePositionals(parsed, [null]);
        const [id] = parsed.positionals;
        validateRequirementId(id);
        const store = createStore(env, clock);
        const snapshot = await store.readSnapshot();
        const requirement = readClaimedRequirement(snapshot, id);
        const base = {
          id,
          profile: requirement.deliveryProfile,
          version: requirement.version ?? null,
          lifecycle: requirement.lifecycle,
          lifecycleLabel: BACKLOG_STATUSES[requirement.lifecycle] ?? requirement.lifecycle,
        };
        if (['done', 'cancelled'].includes(requirement.lifecycle)) {
          return {
            message: 'already at terminal state',
            data: { ...base, next: null, missing: [], hints: [] },
          };
        }
        const to = successorState({
          profile: requirement.deliveryProfile,
          from: requirement.lifecycle,
        });
        const missing = [];
        // The same repository probes runLifecycleAdvance performs — errors
        // are collected instead of thrown so one run lists every blocker.
        try {
          assertBacklogProjectionClean({ cwd, id });
        } catch (error) {
          missing.push({
            code: error.code ?? 'BACKLOG_PROJECTION_DIRTY',
            message: error.message,
            remediation: 'commit or stash the BACKLOG.md changes, then retry',
          });
        }
        let branchUsable = true;
        if (!requirement.branch) {
          missing.push({
            code: 'BRANCH_MISMATCH',
            message: `no branch is bound to ${id}`,
            remediation: `pnpm coord requirement bind-branch ${id} <branch> --json`,
          });
          branchUsable = false;
        } else {
          try {
            assertProjectionBranch({
              cwd,
              id,
              branch: requirement.branch,
              mergedCommit: requirement.mergeStatus === 'merged' ? requirement.mergedCommit : null,
            });
          } catch (error) {
            missing.push({
              code: error.code ?? 'BRANCH_MISMATCH',
              message: error.message,
              remediation: `switch to the requirement branch: git switch ${requirement.branch}`,
            });
            branchUsable = false;
          }
        }
        if (branchUsable) {
          // Gate inputs read from this checkout (manifest, migration draft,
          // BACKLOG row) are only meaningful on the requirement branch, so
          // they are skipped when the branch probe failed. A context that
          // cannot even be built is reported as a blocker instead of
          // failing the diagnostic — what-next stays read-only and exit 0.
          try {
            const context = await buildLifecycleContext({
              store,
              env,
              clock,
              cwd,
              snapshot,
              id,
              requirement,
              to,
              collect: missing,
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
            missing.push(...precheck.missing);
          } catch (error) {
            missing.push({
              code: error.code ?? 'CONTEXT_UNAVAILABLE',
              message: error.message,
              remediation: null,
            });
          }
        }
        return {
          message: missing.length === 0
            ? `${id} can advance to ${to}`
            : `${id} has ${missing.length} blocker(s) before ${to}`,
          data: {
            ...base,
            next: {
              state: to,
              command: `pnpm coord lifecycle next ${id}`,
              dryRunCommand: `pnpm coord lifecycle next ${id} --dry-run`,
            },
            missing,
            hints: missing.length === 0
              ? ['all gates are satisfied; run the next command to advance']
              : ['resolve the missing items above, then re-run this diagnostic or the dry-run command'],
          },
        };
      },
    },
  ],
};
