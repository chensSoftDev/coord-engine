import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  CoordinationError,
  createStore,
  localCoordinationSummary,
  requirePositionals,
  requiredOption,
  usageError,
} from './helpers.mjs';
import { reconcileLeaseOperation } from '../leases.mjs';
import { BACKLOG_STATUSES, reconcileLifecycle } from '../lifecycle.mjs';
import { parseBacklogRows } from '../backlog.mjs';
import { readCoordinationStatus, requirementDocuments } from '../requirements.mjs';
import { migrateSchema } from '../schema-migration.mjs';
import {
  assertBacklogProjectionScoped,
  assertProjectionBranch,
  publishBacklogProjection,
} from '../repository-projection.mjs';

export const initCommand = {
  command: 'init',
  summary: 'Initialize the coordination branch',
  subcommands: [
    {
      key: 'init',
      usage: 'init',
      summary: 'Initialize the coordination branch',
      options: [],
      handler: async ({ parsed, ctx }) => {
        const { env, clock } = ctx;
        requirePositionals(parsed, []);
        const result = await createStore(env, clock).initialize({ fromBacklog: 'BACKLOG.md' });
        return {
          message: result.created
            ? 'initialized coordination state'
            : 'coordination state already initialized',
          data: result,
        };
      },
    },
  ],
};

export const statusCommand = {
  command: 'status',
  summary: 'Show coordination state',
  subcommands: [
    {
      key: 'status',
      usage: 'status',
      summary: 'Show coordination state',
      options: [],
      handler: async ({ parsed, ctx }) => {
        const { env, clock } = ctx;
        if (parsed.positionals.length > 0) {
          throw usageError('status does not accept arguments');
        }
        const store = createStore(env, clock);
        const sha = store.fetchSha({ allowMissing: true });
        if (!sha) {
          return {
            message: 'coordination state is not initialized',
            data: { initialized: false },
          };
        }
        const status = await readCoordinationStatus(store);
        return { message: 'coordination status', data: status };
      },
    },
  ],
};

export const migrateSchemaCommand = {
  command: 'migrate-schema',
  summary: 'Rewrite the root schema and locks to schema v2',
  subcommands: [
    {
      key: 'migrate-schema',
      usage: 'migrate-schema',
      summary: 'Rewrite the root schema and locks to schema v2',
      options: [],
      handler: async ({ parsed, ctx }) => {
        const { env, clock } = ctx;
        requirePositionals(parsed, []);
        const result = await migrateSchema({ store: createStore(env, clock) });
        return {
          message: result.changed
            ? 'migrated coordination state to schema v2'
            : 'coordination state is already at schema v2',
          data: result,
        };
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// I-134 (F7): doctor health checks. All three checks are strictly read-only
// and each runs under its own try/catch — a single failing check reports an
// error entry and never sinks the others or the doctor command itself.
// ---------------------------------------------------------------------------

const HEALTH_FEATURE_BRANCH = /^feature\/v\d+\.\d+\.\d+\//;
const HEALTH_WORKTREE_ID = /^((?:I|F|B)-\d{3,})-[^/]+$/;
const HEALTH_TERMINAL_LIFECYCLES = new Set(['done', 'cancelled']);

function gitLines(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.error?.message || 'git command failed').trim();
    throw new Error(`git ${args.join(' ')} failed: ${detail}`);
  }
  return result.stdout.split('\n').filter(Boolean);
}

function healthWorktrees(cwd) {
  const entries = [];
  let current = null;
  for (const line of gitLines(cwd, ['worktree', 'list', '--porcelain'])) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), branch: null };
      entries.push(current);
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    }
  }
  return entries;
}

function staleLeaseEntries(locks, now) {
  return locks
    .filter((lock) => (
      lock?.active
      && Number.isFinite(Date.parse(lock.active.expiresAt))
      && Date.parse(lock.active.expiresAt) < now
    ))
    .map((lock) => ({
      resource: lock.resource,
      holder: lock.active.holder?.id ?? null,
      sessionId: lock.active.sessionId ?? null,
      expiredAt: lock.active.expiresAt,
      remediation: `pnpm coord lock break ${lock.resource} --reason <text> --force --json`,
    }))
    .sort((left, right) => left.resource.localeCompare(right.resource));
}

function orphanWorktreeEntries({ worktrees, requirements, remoteBranches, remote }) {
  const byId = new Map(requirements.map((requirement) => [requirement.id, requirement]));
  return worktrees
    .filter((worktree) => worktree.branch && HEALTH_FEATURE_BRANCH.test(worktree.branch))
    .map((worktree) => {
      const idMatch = HEALTH_WORKTREE_ID.exec(basename(worktree.path));
      const requirement = (idMatch && byId.get(idMatch[1]))
        || requirements.find((candidate) => candidate.branch === worktree.branch)
        || null;
      const reasons = [];
      if (requirement && HEALTH_TERMINAL_LIFECYCLES.has(requirement.lifecycle)) {
        reasons.push(`requirement ${requirement.id} is ${requirement.lifecycle}`);
      }
      if (!requirement) {
        reasons.push(idMatch
          ? `requirement ${idMatch[1]} is not coordinated`
          : 'no requirement is bound to the branch');
      }
      if (!remoteBranches.has(`${remote}/${worktree.branch}`)) {
        reasons.push(`remote branch ${remote}/${worktree.branch} is gone`);
      }
      return reasons.length > 0
        ? {
          path: worktree.path,
          branch: worktree.branch,
          requirementId: requirement?.id ?? (idMatch?.[1] ?? null),
          reasons,
          remediation: `git worktree remove ${JSON.stringify(worktree.path)} && git branch -D ${worktree.branch}`,
        }
        : null;
    })
    .filter(Boolean)
    .sort((left, right) => left.path.localeCompare(right.path));
}

function backlogMismatchEntries({ requirements, rows }) {
  return requirements
    .map((requirement) => {
      const expected = BACKLOG_STATUSES[requirement.lifecycle] ?? null;
      const row = rows.get(requirement.id);
      if (!row) {
        // A missing row only counts for a non-terminal lifecycle — terminal
        // projections may legitimately be absent (e.g. cancelled cleanups).
        return HEALTH_TERMINAL_LIFECYCLES.has(requirement.lifecycle)
          ? null
          : {
            requirementId: requirement.id,
            coordinationLifecycle: requirement.lifecycle,
            expectedStatus: expected,
            backlogStatus: null,
            remediation: `pnpm coord reconcile ${requirement.id} --json`,
          };
      }
      return expected && row.status !== expected
        ? {
          requirementId: requirement.id,
          coordinationLifecycle: requirement.lifecycle,
          expectedStatus: expected,
          backlogStatus: row.status,
          remediation: `pnpm coord reconcile ${requirement.id} --json`,
        }
        : null;
    })
    .filter(Boolean)
    .sort((left, right) => left.requirementId.localeCompare(right.requirementId));
}

async function readLocksAndRequirements(store) {
  const snapshot = await store.readSnapshot();
  return {
    locks: snapshot.paths()
      .filter((path) => /^locks\/[^/]+\.json$/.test(path))
      .map((path) => snapshot.readJson(path)),
    requirements: requirementDocuments(snapshot),
  };
}

// I-134 (F7): exported for tests — the doctor handler reports the returned
// health document verbatim under data.health.
export async function collectHealth({ store, cwd, clock = () => new Date(), remote }) {
  const effectiveRemote = remote ?? store.remote ?? 'origin';
  const health = {};
  const attempt = async (key, collect) => {
    try {
      health[key] = await collect();
    } catch (error) {
      health[key] = { error: error instanceof Error ? error.message : String(error) };
    }
  };
  await attempt('staleLeases', async () => (
    staleLeaseEntries((await readLocksAndRequirements(store)).locks, clock().getTime())
  ));
  await attempt('orphanWorktrees', async () => orphanWorktreeEntries({
    requirements: (await readLocksAndRequirements(store)).requirements,
    worktrees: healthWorktrees(cwd),
    remoteBranches: new Set(gitLines(cwd, ['branch', '-r', '--format=%(refname:short)'])),
    remote: effectiveRemote,
  }));
  await attempt('backlogMismatch', async () => backlogMismatchEntries({
    requirements: (await readLocksAndRequirements(store)).requirements,
    rows: parseBacklogRows(readFileSync(join(cwd, 'BACKLOG.md'), 'utf8')),
  }));
  return health;
}

export const doctorCommand = {
  command: 'doctor',
  summary: 'Inspect and clean local coordination artifacts',
  subcommands: [
    {
      key: 'doctor',
      usage: 'doctor',
      summary: 'Inspect and clean local coordination artifacts',
      options: [],
      handler: async ({ parsed, ctx }) => {
        const { env, clock, cwd } = ctx;
        requirePositionals(parsed, []);
        const store = createStore(env, clock);
        const result = await store.doctor();
        let local = null;
        try {
          local = localCoordinationSummary(cwd);
        } catch {
          // Diagnostics must never fail the command that gathers them.
        }
        // I-130 (D4): surface schema drift after the v2 flag-day so operators can
        // see at a glance whether `migrate-schema` still needs to run.
        let schema = null;
        try {
          const snapshot = await store.readSnapshot();
          const root = snapshot.readJson('schema.json')?.schemaVersion ?? null;
          const locksMissingVersion = snapshot.paths()
            .filter((path) => path.startsWith('locks/') && path.endsWith('.json'))
            .map((path) => snapshot.readJson(path))
            .filter((lock) => lock?.active && typeof lock.active.version !== 'string')
            .map((lock) => lock.resource);
          schema = { root, locksMissingVersion };
          if (root !== 2 || locksMissingVersion.length > 0) {
            schema.hint = 'run `pnpm coord migrate-schema` to upgrade coordination state to v2';
          }
        } catch {
          // Schema diagnostics are best-effort like the rest of doctor.
        }
        // I-134 (F7): read-only health checks (stale leases, orphan
        // worktrees, BACKLOG/coordination mismatches). A failing check
        // reports an error entry and never sinks the others.
        let health = null;
        try {
          health = await collectHealth({ store, cwd, clock });
        } catch {
          // Health diagnostics are best-effort like the rest of doctor.
        }
        return {
          message: 'coordination diagnostics completed',
          data: { ...result, local, schema, health },
        };
      },
    },
  ],
};

export const reconcileCommand = {
  command: 'reconcile',
  summary: 'Recover an uncertain or partially applied operation',
  // I-132 (review N4): reconcile has no subcommand concept — it takes a
  // requirement id or --operation, so the group help shows the real forms
  // instead of the generic `<subcommand>` placeholder.
  groupUsage: 'reconcile <ID> | reconcile --operation <operation-id>',
  subcommands: [
    {
      key: 'reconcile',
      usage: 'reconcile --operation <ID>',
      summary: 'Recover an uncertain or partially applied lease operation',
      options: ['operation'],
      handler: async ({ parsed, ctx }) => {
        const { env, clock, cwd } = ctx;
        requirePositionals(parsed, []);
        const result = await reconcileLeaseOperation({
          store: createStore(env, clock),
          cwd,
          operationId: requiredOption(parsed, 'operation'),
        });
        return { message: `reconciled ${result.operationId}`, data: result };
      },
    },
    {
      key: 'reconcile <id>',
      usage: 'reconcile <ID>',
      summary: 'Recover a requirement lifecycle from an uncertain state',
      options: [],
      handler: async ({ parsed, ctx }) => {
        const { env, clock, cwd } = ctx;
        requirePositionals(parsed, [null]);
        const [id] = parsed.positionals;
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
        assertBacklogProjectionScoped({ cwd, id });
        const result = await reconcileLifecycle({
          store,
          cwd,
          id,
        });
        const published = publishBacklogProjection({
          cwd,
          remote: store.remote,
          branch: projectionBranch,
          id,
          message: `docs(docs): project ${id} to ${result.lifecycle} [${id}]`,
        });
        return { message: `reconciled ${id}`, data: { ...result, published } };
      },
    },
  ],
};

export default [
  initCommand,
  statusCommand,
  migrateSchemaCommand,
  doctorCommand,
  reconcileCommand,
];
