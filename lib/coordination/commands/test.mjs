import {
  CoordinationError,
  EXIT,
  createStore,
  requirePositionals,
} from './helpers.mjs';
import {
  EvidenceError,
  runRequiredTests,
} from '../evidence.mjs';
import {
  failLifecycle,
  lifecycleEvidenceShaFromRepository,
} from '../lifecycle.mjs';
import {
  assertLease,
  releaseLease,
  revisionMatchesDeployment,
} from '../leases.mjs';
import {
  assertBacklogProjectionScoped,
  assertProjectionBranch,
  publishBacklogProjection,
} from '../repository-projection.mjs';
import { loadSession } from '../worktrees.mjs';
import { showMixedEnvironment, validateMixedEnvironment } from '../mixed-environments.mjs';

export default {
  command: 'test',
  summary: 'Run declared acceptance commands',
  subcommands: [
    {
      key: 'test run',
      usage: 'test run <ID>',
      summary: 'Run the declared acceptance commands for a requirement in testing',
      options: [],
      handler: async ({ parsed, ctx }) => {
        const { env, clock, cwd } = ctx;
        requirePositionals(parsed, ['run', null]);
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
        const projectionBranch = assertProjectionBranch({
          cwd,
          id,
          branch: requirement.branch,
          mergedCommit: requirement.mergeStatus === 'merged' ? requirement.mergedCommit : null,
        });
        if (requirement.lifecycle !== 'testing') {
          throw new CoordinationError(`${id} must be in testing before running required tests`, {
            code: 'INVALID_TRANSITION',
            exitCode: EXIT.INVALID_TRANSITION,
          });
        }
        let devLease = null;
        let devSnapshot = null;
        let runtimeSession = null;
        if (requirement.deliveryProfile === 'runtime') {
          runtimeSession = loadSession({ cwd, sessionId: env.COORD_SESSION_ID });
          devLease = await assertLease({
            store,
            cwd,
            resource: 'dev',
            requirementId: id,
            commit: 'HEAD',
            session: runtimeSession,
            clock,
          });
          const current = await store.readSnapshot();
          devSnapshot = current.has('deployments/dev.json')
            ? current.readJson('deployments/dev.json')
            : null;
        }
        const mixedEnvironment = requirement.deliveryProfile === 'runtime' ? await showMixedEnvironment({ store, requirementId: id }) : null;
        const run = await runRequiredTests({
          cwd,
          id,
          requirement,
          environment: {
            devLease,
            devSnapshot,
            ...(mixedEnvironment ? { mixedEnvironment } : {}),
            // I-130 (review fix): informational mirror of the drift tolerance
            // runRequiredTests computes internally — anchored on the immutable
            // deployment snapshot commit, never the floating lease commit.
            devRevisionMatches: devSnapshot ? revisionMatchesDeployment({
              cwd,
              requirementId: id,
              fromCommit: devSnapshot.commit,
              toCommit: 'HEAD',
            }).matches : true,
            authoritative: requirement.deliveryProfile === 'runtime',
            targets: {
              e2eBaseUrl: env.E2E_BASE_URL ?? null,
              adminBaseUrl: env.ADMIN_BASE_URL ?? null,
              ...(mixedEnvironment ? { apiBaseUrl: env.API_BASE_URL ?? null } : {}),
            },
          },
          clock,
          validateEnvironmentAfterRun: requirement.deliveryProfile === 'runtime'
            ? async () => {
              const currentLease = await assertLease({
                store,
                cwd,
                resource: 'dev',
                requirementId: id,
                commit: 'HEAD',
                session: runtimeSession,
                clock,
              });
              const current = await store.readSnapshot();
              const currentDeployment = current.has('deployments/dev.json')
                ? current.readJson('deployments/dev.json')
                : null;
              if (mixedEnvironment) {
                const currentMixed = await showMixedEnvironment({ store, requirementId: id });
                if (currentMixed?.identitySha256 !== mixedEnvironment.identitySha256 || currentMixed.invalidated === true) throw new EvidenceError('mixed environment fact changed while testing', { code: 'MIXED_IDENTITY_CHANGED' });
                await validateMixedEnvironment({ cwd, requirement, environment: mixedEnvironment, devLease: currentLease, devSnapshot: currentDeployment, clock });
              }
              if (JSON.stringify(currentDeployment) !== JSON.stringify(devSnapshot)) {
                throw new EvidenceError('dev deployment changed while required tests were running', {
                  code: 'DEV_DEPLOYMENT_CHANGED',
                });
              }
            }
            : undefined,
        });
        if (run.evidence.outcome !== 'passed') {
          let lifecycle;
          let published;
          let lifecycleFailure;
          try {
            assertBacklogProjectionScoped({ cwd, id });
            lifecycle = await failLifecycle({
              store,
              cwd,
              id,
              reason: 'one or more required test commands failed',
              evidenceSha: lifecycleEvidenceShaFromRepository({ cwd, id }),
              clock,
            });
            published = publishBacklogProjection({
              cwd,
              remote: store.remote,
              branch: projectionBranch,
              id,
              message: `docs(docs): project ${id} to ${lifecycle.lifecycle} [${id}]`,
            });
          } catch (error) {
            lifecycleFailure = error;
          }
          let leaseCleanup;
          if (requirement.deliveryProfile === 'runtime' && env.COORD_SESSION_ID) {
            try {
              const released = await releaseLease({
                store,
                cwd,
                resource: 'dev',
                session: loadSession({ cwd, sessionId: env.COORD_SESSION_ID }),
                clock,
              });
              leaseCleanup = {
                released: true,
                operationId: released.operationId,
              };
            } catch (error) {
              leaseCleanup = {
                released: false,
                code: typeof error?.code === 'string' ? error.code : 'LEASE_CLEANUP_FAILED',
                message: error instanceof Error ? error.message : String(error),
              };
            }
          }
          if (lifecycleFailure) {
            lifecycleFailure.data = {
              ...(lifecycleFailure.data ?? {}),
              evidencePath: run.path,
              ...(published ? { published } : {}),
              ...(leaseCleanup ? { leaseCleanup } : {}),
            };
            throw lifecycleFailure;
          }
          throw new EvidenceError(`required tests failed for ${id}`, {
            code: 'REQUIRED_TESTS_FAILED',
            data: {
              evidencePath: run.path,
              lifecycle,
              ...(published ? { published } : {}),
              ...(leaseCleanup ? { leaseCleanup } : {}),
            },
          });
        }
        return { message: `required tests passed for ${id}`, data: run };
      },
    },
  ],
};
