import {
  EXIT,
  CoordinationError,
  PROJECT_ROOT,
  arrayOption,
  createGuardStore,
  requirePositionals,
  requiredOption,
  usageError,
} from './helpers.mjs';
import {
  ApprovalError,
  showReleaseApproval,
} from '../approvals.mjs';
import { FreezeError, showFreeze } from '../freezes.mjs';
import {
  guardSharedEnvironment,
  issueGuardTicket,
  loadSharedEnvironmentPolicy,
  refreshGuardTicket,
  validateGuardTicket,
} from '../guard.mjs';
import { assertLease, currentRevision } from '../leases.mjs';
import { evaluateReviewReadiness } from '../reviews.mjs';
import { humanAcceptanceReadiness } from '../workflow-policy.mjs';
import { loadSession } from '../worktrees.mjs';

export default {
  command: 'guard',
  summary: 'Enforce a shared-environment lease',
  subcommands: [
    {
      key: 'guard shared-env',
      usage: 'guard shared-env --stage <stage> [--target <name>]... [--requirement <ID>] [--commit <sha>] [--dry-run] [--issue-ticket] [--release-approval <ID>]',
      summary: 'Enforce a shared-environment lease for a deploy/test stage',
      options: ['stage', 'target', 'requirement', 'commit', 'dry-run', 'issue-ticket', 'release-approval'],
      handler: async ({ parsed, ctx }) => {
        const { env, clock, guardTrustRoot } = ctx;
        requirePositionals(parsed, ['shared-env']);
        const cwd = guardTrustRoot?.cwd ?? PROJECT_ROOT;
        const store = createGuardStore(guardTrustRoot, env, clock);
        if (Object.hasOwn(parsed.options, 'ticket')) {
          throw usageError('guard tickets must be passed through COORD_GUARD_TICKET');
        }
        const ticket = env.COORD_GUARD_TICKET;
        const issueTicket = parsed.options['issue-ticket'] === true;
        if ((ticket || issueTicket) && parsed.options['dry-run'] === true) {
          throw usageError('guard tickets are not available in dry-run mode');
        }
        // Filled by checkSession before any coordination snapshot read; assertLease
        // only runs on the non-ticket path, where the session is already loaded.
        let guardSession = null;
        const result = await guardSharedEnvironment({
          cwd,
          policy: loadSharedEnvironmentPolicy({ cwd }),
          stage: requiredOption(parsed, 'stage'),
          targets: arrayOption(parsed, 'target'),
          requirementId: parsed.options.requirement,
          commit: parsed.options.commit ?? 'HEAD',
          dryRun: parsed.options['dry-run'] === true,
          ticket,
          checkSession: async () => {
            // Ticket assertions authenticate with the ticket, not the session.
            if (ticket) return;
            guardSession = loadSession({ cwd, sessionId: env.COORD_SESSION_ID });
          },
          checkWorkflow: async ({ resource, requirementId }) => {
            if (resource !== 'prod') return;
            const snapshot = await store.readSnapshot();
            const path = `requirements/${requirementId}.json`;
            if (!snapshot.has(path)) return;
            const requirement = snapshot.readJson(path);
            if (requirement.workflowVersion !== 2) return;
            const review = evaluateReviewReadiness({ snapshot, cwd, requirement, stage: 'release' });
            const acceptance = humanAcceptanceReadiness({ snapshot, cwd, requirement, currentCommit: currentRevision(cwd).commit });
            const missing = [...review.missing, ...acceptance.missing];
            if (missing.length) throw new CoordinationError('complete release review and current acceptance before production side effects', {
              code: missing[0].code, data: { requirementId, missing },
            });
          },
          checkFreeze: async ({ resource }) => {
            if (resource !== 'dev') return;
            const freeze = await showFreeze({ store, resource });
            if (freeze) {
              throw new FreezeError(`${resource} is frozen awaiting a human decision`, {
                code: 'FREEZE_ACTIVE',
                exitCode: EXIT.OCCUPIED,
                data: {
                  resource,
                  requirementId: freeze.requirementId,
                  candidateId: freeze.candidateId,
                },
              });
            }
          },
          // The auto-release path is declared explicitly: only then does the
          // prod guard read the durable approval fact and fail closed when it is
          // missing, revoked, or mismatched. The default manual path never
          // infers authorization from test state.
          ...(parsed.options['release-approval'] !== undefined
            ? {
              checkReleaseApproval: async ({ resource }) => {
                if (resource !== 'prod') return;
                const approval = await showReleaseApproval({
                  store,
                  requirementId: parsed.options['release-approval'],
                });
                if (!approval) {
                  throw new ApprovalError(
                    `no active release approval for ${parsed.options['release-approval']}`,
                    {
                      code: 'RELEASE_APPROVAL_REQUIRED',
                      exitCode: EXIT.GATE_FAILED,
                      data: {
                        requirementId: parsed.options['release-approval'],
                        expected: parsed.options.requirement ?? null,
                      },
                    },
                  );
                }
                if (approval.requirementId !== parsed.options.requirement) {
                  throw new ApprovalError(
                    `release approval for ${approval.requirementId} does not match this requirement`,
                    {
                      code: 'RELEASE_APPROVAL_MISMATCH',
                      exitCode: EXIT.GATE_FAILED,
                      data: {
                        approvalRequirement: approval.requirementId,
                        requirementId: parsed.options.requirement ?? null,
                      },
                    },
                  );
                }
              },
            }
            : {}),
          assertLease: async ({ resource, requirementId, commit }) => assertLease({
            store,
            cwd,
            resource,
            requirementId,
            commit,
            session: guardSession ?? loadSession({ cwd, sessionId: env.COORD_SESSION_ID }),
            clock,
          }),
          validateTicket: async ({ resource, requirementId, commit, ticket: value }) => (
            validateGuardTicket({
              store,
              cwd,
              ticket: value,
              stage: resource,
              requirementId,
              commit,
              clock,
              allowExpired: issueTicket,
            })
          ),
        });
        if (!result.required) {
          return { message: 'target is not a configured shared environment', data: result };
        }
        if (result.dryRun) {
          return {
            message: `would assert ${result.stage} lease for ${result.requirementId}`,
            data: result,
          };
        }
        if (issueTicket) {
          const issued = ticket
            ? await refreshGuardTicket({
              store,
              cwd,
              ticket,
              stage: result.stage,
              requirementId: result.requirementId,
              commit: result.commit,
              clock,
            })
            : await issueGuardTicket({
              store,
              cwd,
              stage: result.stage,
              requirementId: result.requirementId,
              commit: result.commit,
              lease: result.assertion,
              clock,
            });
          return {
            message: `issued ${result.stage} guard ticket for ${result.requirementId}`,
            data: {
              ...result,
              guardTicket: issued,
            },
          };
        }
        return {
          message: `asserted ${result.stage} lease for ${result.requirementId}`,
          data: result,
        };
      },
    },
  ],
};
