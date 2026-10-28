import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GitCoordinationStore } from '../git-store.mjs';
import {
  EvidenceError,
  validateTestEvidence,
} from '../evidence.mjs';
import { FreezeError, showFreeze } from '../freezes.mjs';
import {
  assertLease,
  currentRevision,
  revisionMatchesDeployment,
} from '../leases.mjs';
import {
  advanceLifecycle,
  deploymentCovers,
  lifecycleContextFromRepository,
  completionFactPresentFromRepository,
  lifecycleEvidenceShaFromRepository,
} from '../lifecycle.mjs';
import {
  assertBacklogProjectionClean,
  assertProjectionBranch,
  publishBacklogProjection,
} from '../repository-projection.mjs';
import { classifyRevisionRange } from '../revision-policy.mjs';
import {
  WorktreeError,
  gitCommonDir,
  loadSession,
} from '../worktrees.mjs';
import { assertRequirementId } from '../validation.mjs';
import { validateMixedEnvironment } from '../mixed-environments.mjs';

export const EXIT = Object.freeze({
  OK: 0,
  OCCUPIED: 10,
  STALE: 11,
  INVALID_TRANSITION: 12,
  REMOTE_ERROR: 13,
  GATE_FAILED: 14,
  UNCERTAIN: 15,
});

// I-249: 引擎可被 consuming 项目以 submodule 挂载（.coord-engine/，自路径推导
// 恰好仍指向项目根），也可在自身仓库内独立运行（推导会越出仓库根）。项目根
// 因此优先取 COORD_CWD（guard.sh 等既有调用方）与含 package.json 的 cwd，
// 自路径推导仅作兜底。
function resolveProjectRoot() {
  if (process.env.COORD_CWD) return resolve(process.env.COORD_CWD);
  const workingRoot = resolve(process.cwd());
  if (existsSync(join(workingRoot, 'package.json'))) return workingRoot;
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
}

export const PROJECT_ROOT = resolveProjectRoot();

export function dispatchKey(parsed) {
  // reconcile's first positional is a requirement id, not a subcommand.
  if (parsed.command === 'reconcile') {
    return parsed.positionals.length === 1 ? 'reconcile <id>' : 'reconcile';
  }
  // I-132 (F3/F4): what-next and plan take a requirement id as their first
  // positional — a value, not a subcommand (same shape as reconcile <id>).
  if (parsed.command === 'what-next' || parsed.command === 'plan') {
    return parsed.command;
  }
  return [parsed.command, parsed.positionals[0]].filter(Boolean).join(' ');
}

export class CoordinationError extends Error {
  constructor(message, {
    code = 'GATE_FAILED',
    exitCode = EXIT.GATE_FAILED,
    data = {},
    cause,
  } = {}) {
    super(message, { cause });
    this.name = 'CoordinationError';
    this.code = code;
    this.exitCode = exitCode;
    this.data = data;
  }
}

export function usageError(message) {
  return new CoordinationError(message, {
    code: 'CLI_USAGE',
    exitCode: EXIT.GATE_FAILED,
  });
}

export function success(message, data = {}) {
  return {
    ok: true,
    code: 'OK',
    exitCode: EXIT.OK,
    message,
    data,
  };
}

export function createStore(env, clock) {
  const options = {
    cwd: env.COORD_CWD ?? process.cwd(),
    remote: env.COORD_REMOTE ?? 'origin',
    branch: env.COORD_BRANCH ?? 'coordination',
    // One CLI command reads the same ref several times (I-127, H2); a short
    // process-local TTL collapses those fetches. Library callers keep the
    // conservative default (always fetch).
    fetchTtlMs: 10_000,
  };
  if (env.COORD_TEMP_ROOT) options.tempRoot = env.COORD_TEMP_ROOT;
  // I-131 (E6): --reuse-sha is mapped into the environment by executeBuiltin.
  if (env.COORD_REUSE_SHA) options.reuseSha = env.COORD_REUSE_SHA;
  options.clock = clock;
  return new GitCoordinationStore(options);
}

// I-131 (E6 review fix): exported for tests — the reuse-sha forwarding is
// pinned by a unit test.
export function createGuardStore(guardTrustRoot, env, clock) {
  // An explicit trust root (tests) always wins; otherwise the guard honors the
  // same COORD_* overrides as every other store so a bogus COORD_REMOTE really
  // does prove that a code path never touched the remote (I-127).
  const options = {
    cwd: guardTrustRoot?.cwd ?? PROJECT_ROOT,
    remote: guardTrustRoot?.remote ?? env.COORD_REMOTE ?? 'origin',
    branch: guardTrustRoot?.branch ?? env.COORD_BRANCH ?? 'coordination',
    fetchTtlMs: 10_000, // see createStore
    clock,
  };
  const tempRoot = guardTrustRoot?.tempRoot ?? env.COORD_TEMP_ROOT;
  if (tempRoot) options.tempRoot = tempRoot;
  // I-131 (E6): --reuse-sha is a global option — the guard store honors it
  // like every other store.
  if (env.COORD_REUSE_SHA) options.reuseSha = env.COORD_REUSE_SHA;
  return new GitCoordinationStore(options);
}

export function ownerFromEnvironment(env) {
  return {
    sessionId: env.COORD_SESSION_ID ?? null,
    agent: env.COORD_AGENT ?? 'unknown',
    user: env.COORD_USER ?? env.USER ?? 'unknown',
    host: env.COORD_HOST ?? hostname(),
  };
}

export function requirePositionals(parsed, expected) {
  if (
    parsed.positionals.length !== expected.length
    || parsed.positionals.some((value, index) => (
      expected[index] !== null && value !== expected[index]
    ))
  ) {
    throw usageError(`invalid ${parsed.command} command arguments`);
  }
}

export function requiredOption(parsed, name) {
  const value = parsed.options[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw usageError(`missing required option: --${name}`);
  }
  return value;
}

// I-132 (review N6): entry-point requirement id validation with the same
// shape the advance path applies (lifecycle.mjs requirementId) — an invalid
// format fails fast with INVALID_REQUIREMENT_ID before any coordination
// read, instead of surfacing as a confusing REQUIREMENT_NOT_FOUND.
export function validateRequirementId(id) {
  try {
    return assertRequirementId(id);
  } catch (error) {
    throw new CoordinationError(error.message, {
      code: 'INVALID_REQUIREMENT_ID',
      cause: error,
    });
  }
}

export function arrayOption(parsed, name) {
  return parsed.options[name] ?? [];
}

// Complex payloads follow the repository's file-based convention
// (`deployment record --snapshot`, `requirement apply-completion --plan`):
// the deployment snapshot bound into a freeze fact is read from a JSON file,
// never parsed from inline argv. The file must contain a JSON value; whether
// that value is an acceptable binding (a plain object) is decided by the
// freeze state machine's requireBinding, not by the CLI.
export function jsonFileOption(parsed, name, cwd) {
  const path = requiredOption(parsed, name);
  let value;
  try {
    value = JSON.parse(readFileSync(resolve(cwd, path), 'utf8'));
  } catch (error) {
    throw new FreezeError(`cannot read --${name} as a JSON file: ${path}`, {
      code: 'INVALID_FREEZE_SNAPSHOT',
      cause: error,
    });
  }
  return value;
}

// I-128 (L17): doctor previously only reported abandoned temp worktrees; the
// local coordination directory (.git/coordination) is where sessions, lease
// tokens and lease operation records (including 'uncertain' ones) live, so
// surface them read-only for diagnostics.
export function localCoordinationSummary(cwd) {
  const base = join(gitCommonDir(cwd), 'coordination');
  const list = (name) => {
    try {
      return readdirSync(join(base, name), { withFileTypes: true });
    } catch {
      return [];
    }
  };
  const sessionFiles = list('sessions')
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'));
  const operations = list('lease-operations')
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => {
      try {
        return JSON.parse(readFileSync(join(base, 'lease-operations', entry.name), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return {
    sessions: {
      count: sessionFiles.length,
      hasCurrent: list('sessions').some((entry) => entry.isFile() && entry.name === 'current'),
    },
    leaseTokens: list('lease-tokens')
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name.slice(0, -'.json'.length))
      .sort(),
    leaseOperations: {
      total: operations.length,
      byStatus: operations.reduce((counts, record) => ({
        ...counts,
        [record.status ?? 'unknown']: (counts[record.status ?? 'unknown'] ?? 0) + 1,
      }), {}),
    },
  };
}

// I-131 (E1/E5): the lifecycle context build for one advance — shared by
// `advance --to`, `next` and every item of `batch-next` so the gate inputs
// can never drift between entry points.
// I-132 (F3): passing `collect` (an array) switches the throwing probes
// (lease assertion, freeze/evidence validation) into try/collect mode so the
// read-only what-next command can report every blocker in one pass; without
// it the behavior is byte-identical to the original throwing path.
export async function buildLifecycleContext({ store, env, clock, cwd, snapshot, id, requirement, to, collect }) {
  const collectProbe = async (run, onFailure) => {
    if (!collect) return run();
    try {
      return await run();
    } catch (error) {
      collect.push(onFailure(error));
      return undefined;
    }
  };
  // I-132 (review N3): a session-load failure (WorktreeError from
  // loadSession — no session, stale pointer or corrupt metadata) cannot be
  // fixed by acquiring a lease — point at session init first; only an
  // actual lease-state failure points at lock acquire.
  const leaseFailure = (resource) => (error) => ({
    code: 'LEASE_MISSING',
    message: error.message,
    remediation: error instanceof WorktreeError
      ? 'pnpm coord session init --agent <name> --user <name> --json'
      : `pnpm coord lock acquire ${resource} --requirement ${id} --ttl 8h --json`,
  });
  const lifecycleContext = lifecycleContextFromRepository({
    cwd,
    id,
    version: requirement.version,
  });
  // I-130 (review fix): the dev gate in lifecycle.mjs is a pure function,
  // so the deployment drift check (which needs git) is computed here and
  // passed in as data. The anchor is the immutable devSnapshot.commit —
  // never the floating lease commit — and the tolerance is the shared
  // revision policy: the whole range up to HEAD must not be
  // runtime-affecting (BACKLOG projections, docs, evidence-neutral commits
  // are tolerated; anything else fails closed).
  if (
    requirement.deliveryProfile === 'runtime'
    && ['dev_deployed', 'testing', 'test_passed'].includes(to)
  ) {
    const devDeployment = snapshot.has('deployments/dev.json')
      ? snapshot.readJson('deployments/dev.json')
      : null;
    lifecycleContext.devRevisionMatches = Boolean(
      deploymentCovers(devDeployment, id)
      && typeof devDeployment.commit === 'string'
      && revisionMatchesDeployment({
        cwd,
        requirementId: id,
        fromCommit: devDeployment.commit,
        toCommit: lifecycleContext.currentCommit,
      }).matches,
    );
  }
  if (requirement.deliveryProfile === 'runtime' && ['dev_deployed', 'testing', 'test_passed'].includes(to)) {
    const mixedPath = `environments/${id}/mixed-dev.json`;
    if (snapshot.has(mixedPath)) {
      const mixedEnvironment = snapshot.readJson(mixedPath);
      lifecycleContext.mixedEnvironment = mixedEnvironment;
      const valid = await collectProbe(() => validateMixedEnvironment({
        cwd, requirement, environment: mixedEnvironment,
        devLease: snapshot.has('locks/dev.json') ? snapshot.readJson('locks/dev.json').active : null,
        devSnapshot: snapshot.has('deployments/dev.json') ? snapshot.readJson('deployments/dev.json') : null,
        freeze: snapshot.has('freezes/dev.json') ? snapshot.readJson('freezes/dev.json') : null,
        clock,
      }), error => ({ code: error.code ?? 'MIXED_ENVIRONMENT_INVALID', message: error.message,
        remediation: `restart the committed frontend and pnpm coord environment record ${id} --app admin|web --base-url <origin> --json` }));
      lifecycleContext.mixedEnvironmentValid = valid === true;
    }
  }
  // I-160：prod 侧同一漂移政策——列车逐条 record+advance 时 BACKLOG 投影 commit 会领先
  // 已部署 commit（tag），整个区间非 runtime-affecting 即容忍，替代钉住 tag 的收尾绕行。
  if (
    requirement.deliveryProfile === 'runtime'
    && to === 'prod_deployed'
  ) {
    const prodDeployment = snapshot.has('deployments/prod.json')
      ? snapshot.readJson('deployments/prod.json')
      : null;
    lifecycleContext.prodRevisionMatches = Boolean(
      deploymentCovers(prodDeployment, id)
      && typeof prodDeployment.commit === 'string'
      && revisionMatchesDeployment({
        cwd,
        requirementId: id,
        fromCommit: prodDeployment.commit,
        toCommit: lifecycleContext.currentCommit,
      }).matches,
    );
  }
  // I-118：runtime 的 prod_deployed -> done 门禁需完成事实（COMPLETION.json 已合并且 mergedCommit 匹配）
  if (to === 'done' && requirement.deliveryProfile === 'runtime') {
    lifecycleContext.completionFactPresent = completionFactPresentFromRepository({
      cwd,
      id,
      mergedCommit: requirement.mergedCommit,
    });
  }
  if (
    requirement.deliveryProfile === 'runtime'
    && ['dev_deployed', 'testing', 'prod_deployed'].includes(to)
  ) {
    const resource = to === 'prod_deployed' ? 'prod' : 'dev';
    const asserted = await collectProbe(
      () => assertLease({
        store,
        cwd,
        resource,
        requirementId: id,
        commit: 'HEAD',
        session: loadSession({ cwd, sessionId: env.COORD_SESSION_ID }),
        clock,
      }),
      leaseFailure(resource),
    );
    if (asserted !== undefined) {
      if (resource === 'prod') lifecycleContext.assertedProdLease = asserted;
      else {
        lifecycleContext.assertedDevLease = asserted;
      }
    }
  }
  if (to === 'test_passed') {
    let assertedDevLease;
    let deployment;
    let freezeEvidence = null;
    if (requirement.deliveryProfile === 'runtime') {
      const current = await store.readSnapshot();
      deployment = current.has('deployments/dev.json')
        ? current.readJson('deployments/dev.json')
        : null;
      const freeze = await showFreeze({ store, resource: 'dev' });
      // I-113 Task 3: after machine verification the dev lease is consumed
      // by the durable awaiting_human freeze fact. Advancing to Test
      // Passed accepts a matching freeze fact as the machine verification
      // evidence: same requirement, machine verification evidence bound to
      // the current TEST_EVIDENCE.json, and commit identity preserved.
      let freezeUsable = false;
      if (freeze && freeze.requirementId === id) {
        freezeUsable = await collectProbe(
          async () => {
            const evidenceSha = lifecycleEvidenceShaFromRepository({ cwd, id });
            const revision = currentRevision(cwd);
            const drift = freeze.commit === revision.commit ? { valid: true, classification: 'evidence-neutral' }
              : classifyRevisionRange({ cwd, requirementId: id, fromSha: freeze.commit, toSha: revision.commit });
            const commitMatches = drift.valid && drift.classification === 'evidence-neutral';
            if (freeze.machineVerificationEvidence !== evidenceSha || !commitMatches) {
              throw new FreezeError(
                'the dev freeze fact does not match the current test evidence or commit',
                {
                  code: 'FREEZE_EVIDENCE_MISMATCH',
                  exitCode: EXIT.STALE,
                  data: {
                    requirementId: id,
                    freezeCommit: freeze.commit,
                    currentCommit: revision.commit,
                    evidenceMatches: freeze.machineVerificationEvidence === evidenceSha,
                  },
                },
              );
            }
            return true;
          },
          (error) => ({
            code: error.code ?? 'FREEZE_EVIDENCE_MISMATCH',
            message: error.message,
            remediation: 'refresh TEST_EVIDENCE.json at the current commit, or acquire a fresh dev lease',
          }),
        ) === true;
      }
      if (freezeUsable) {
        freezeEvidence = freeze;
        lifecycleContext.assertedDevLease = freeze;
        lifecycleContext.devRevisionMatches = true;
      } else {
        assertedDevLease = await collectProbe(
          () => assertLease({
            store,
            cwd,
            resource: 'dev',
            requirementId: id,
            commit: 'HEAD',
            session: loadSession({ cwd, sessionId: env.COORD_SESSION_ID }),
            clock,
          }),
          leaseFailure('dev'),
        );
        if (assertedDevLease !== undefined) {
          lifecycleContext.assertedDevLease = assertedDevLease;
        }
      }
    }
    const validation = await collectProbe(
      () => validateTestEvidence({
        cwd,
        id,
        requirement,
        deployment,
        mixedEnvironment: snapshot.has(`environments/${id}/mixed-dev.json`) ? snapshot.readJson(`environments/${id}/mixed-dev.json`) : null,
        lease: assertedDevLease,
        freeze: freezeEvidence,
        clock,
      }),
      (error) => ({
        code: error.code ?? 'TEST_EVIDENCE_INVALID',
        message: error.message,
        remediation: `fix the evidence and re-validate: pnpm coord evidence validate ${id} --head HEAD --base origin/main --json`,
      }),
    );
    if (validation !== undefined) {
      if (validation.requiredActions.length > 0) {
        if (!collect) {
          throw new EvidenceError('local CI must be rerun against the current main base', {
            code: 'TEST_EVIDENCE_INVALID',
            data: { requiredActions: validation.requiredActions },
          });
        }
        // I-132 (F3): collect mode keeps the soft rerun actions and leaves
        // the evidence out of the context — the precheck then reports the
        // same run_required_tests gate the advance path would hit.
        for (const action of validation.requiredActions) {
          collect.push({
            code: action,
            message: 'local CI must be rerun against the current main base',
            remediation: `rerun local CI and refresh TEST_EVIDENCE.json, then pnpm coord evidence validate ${id} --head HEAD --base origin/main --json`,
          });
        }
      } else {
        if (freezeEvidence) {
          lifecycleContext.hasFreezeEvidence = true;
          lifecycleContext.freeze = freezeEvidence;
          lifecycleContext.freezeEvidenceMatches = true;
        }
        lifecycleContext.testEvidence = validation.evidence;
        // Evidence-neutral closures (TEST_EVIDENCE/CHECKLIST/ACCEPTANCE-only
        // commits after testing) keep the evidence valid; the tested commit
        // recorded for the gate is the final HEAD so testEvidenceValid's
        // strict equality against currentCommit holds.
        lifecycleContext.testedCommit = validation.toleratedCommitRange?.to
          ?? validation.testedCommit;
      }
    }
  }
  return lifecycleContext;
}

export function readClaimedRequirement(snapshot, id) {
  const requirementPath = `requirements/${id}.json`;
  if (!snapshot.has(requirementPath)) {
    throw new CoordinationError(`requirement is not claimed: ${id}`, {
      code: 'REQUIREMENT_NOT_FOUND',
    });
  }
  return snapshot.readJson(requirementPath);
}

// I-131 (E1): the full advance path (gates + coordination update + BACKLOG
// projection publish). `advance --to` is the explicit form; `next` resolves
// the unique successor and lands here unchanged. Callers that already hold a
// store/snapshot (next, batch-next) pass them through so the whole command
// costs exactly one coordination fetch.
export async function runLifecycleAdvance({ env, clock, id, to, store, snapshot }) {
  const cwd = env.COORD_CWD ?? process.cwd();
  const effectiveStore = store ?? createStore(env, clock);
  const effectiveSnapshot = snapshot ?? await effectiveStore.readSnapshot();
  const requirement = readClaimedRequirement(effectiveSnapshot, id);
  assertBacklogProjectionClean({ cwd, id });
  const projectionBranch = assertProjectionBranch({
    cwd,
    id,
    branch: requirement.branch,
    mergedCommit: requirement.mergeStatus === 'merged' ? requirement.mergedCommit : null,
  });
  const lifecycleContext = await buildLifecycleContext({
    store: effectiveStore,
    env,
    clock,
    cwd,
    snapshot: effectiveSnapshot,
    id,
    requirement,
    to,
  });
  const result = await advanceLifecycle({
    store: effectiveStore,
    cwd,
    id,
    to,
    context: lifecycleContext,
    clock,
  });
  const published = publishBacklogProjection({
    cwd,
    remote: effectiveStore.remote,
    branch: projectionBranch,
    id,
    message: `docs(docs): project ${id} to ${result.lifecycle} [${id}]`,
  });
  return success(`advanced ${id} to ${result.lifecycle}`, { ...result, published });
}
