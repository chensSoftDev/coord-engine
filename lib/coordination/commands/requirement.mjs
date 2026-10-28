import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { enableWorkflow } from '../workflow-facts.mjs';

import {
  CoordinationError,
  arrayOption,
  createStore,
  ownerFromEnvironment,
  readClaimedRequirement,
  requirePositionals,
  requiredOption,
  usageError,
  validateRequirementId,
} from './helpers.mjs';

function requiredUxImpact(parsed) {
  const value = parsed.options['ux-impact'];
  if (value === undefined) {
    throw new CoordinationError('new requirements must declare --ux-impact admin-ui|none', {
      code: 'MISSING_UX_IMPACT', exitCode: 12,
    });
  }
  if (!['admin-ui', 'none'].includes(value)) {
    throw new CoordinationError(`--ux-impact must be admin-ui or none: ${value}`, {
      code: 'INVALID_UX_IMPACT', exitCode: 12,
    });
  }
  return value;
}
import {
  allowRequirementUxReview,
  applyCompletionPatch,
  bindRequirementBranch,
  bindRequirementVersion,
  cancelRequirement,
  claimRequirement,
  declareRequirementResources,
  importExistingRequirement,
  inferRequirementResources,
  planRequirementCompletion,
  reconcileMergedRequirements,
  showRequirement,
  clearRequirementMerge,
  setRequirementDatabaseTables,
  setRequirementMigration,
  setRequirementProfile,
  setRequirementUxImpact,
  startRequirement,
} from '../requirements.mjs';
import {
  assertBacklogProjectionClean,
  assertProjectionBranch,
  publishBacklogProjection,
} from '../repository-projection.mjs';
import {
  createRequirementWorktree,
  loadSession,
} from '../worktrees.mjs';

// I-134 (F8): best-effort local lookup for cancel cleanup hints — the local
// worktree (if any) whose checked-out branch is the requirement's branch.
function worktreePathForBranch(cwd, branch) {
  if (!branch) return null;
  const result = spawnSync('git', ['worktree', 'list', '--porcelain'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.error || result.status !== 0) return null;
  let path = null;
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
    if (line === `branch refs/heads/${branch}`) return path;
  }
  return null;
}

export default {
  command: 'requirement',
  summary: 'Claim and manage requirements',
  subcommands: [
    {
      key: 'requirement claim',
      usage: 'requirement claim --type <type> --title <title> --profile <profile> --ux-impact admin-ui|none [--migration yes|no]',
      summary: 'Claim the next requirement id',
      options: ['type', 'title', 'profile', 'ux-impact', 'migration'],
      handler: async ({ parsed, ctx }) => {
        const { env, clock } = ctx;
        requirePositionals(parsed, ['claim']);
        const store = createStore(env, clock);
        const migration = parsed.options.migration;
        if (migration !== undefined && !['yes', 'no'].includes(migration)) {
          throw usageError('--migration must be yes or no');
        }
        const result = await claimRequirement({
          store,
          type: requiredOption(parsed, 'type'),
          title: requiredOption(parsed, 'title'),
          profile: requiredOption(parsed, 'profile'),
          uxImpact: requiredUxImpact(parsed),
          ...(migration !== undefined ? { migration } : {}),
          workflowVersion: 2,
          backlogText: readFileSync(join(store.cwd, 'BACKLOG.md'), 'utf8'),
          owner: ownerFromEnvironment(env),
        });
        return {
          message: `claimed ${result.id}`,
          data: {
            requirementId: result.id,
            coordinationSha: result.sha,
            attempts: result.attempts,
            next: `pnpm coord requirement bind-version ${result.id} <version>`,
          },
        };
      },
    },
    {
      // I-130 (D3): one-shot start = claim + bind-version + bind-branch +
      // worktree create. The old four-step commands stay available; start is
      // their composed shortcut with an upfront migration declaration.
      key: 'requirement start',
      usage: 'requirement start --type <type> --title <title> --profile <profile> --ux-impact admin-ui|none --topic <topic> --migration yes|no (--version <v> | --bump <part> | --join-version <v>)',
      summary: 'Claim, bind version/branch, and create a worktree in one step',
      options: ['type', 'title', 'profile', 'ux-impact', 'topic', 'migration', 'version', 'bump', 'join-version'],
      handler: async ({ parsed, ctx }) => {
        const { env, clock, cwd } = ctx;
        requirePositionals(parsed, ['start']);
        const version = parsed.options.version;
        const bump = parsed.options.bump;
        const joinVersion = parsed.options['join-version'];
        const modes = [version, bump, joinVersion].filter((value) => value !== undefined);
        if (modes.length !== 1) {
          throw usageError(
            'requirement start requires exactly one of --version, --bump, or --join-version',
          );
        }
        const migration = requiredOption(parsed, 'migration');
        if (!['yes', 'no'].includes(migration)) {
          throw usageError('--migration must be yes or no');
        }
        const topic = requiredOption(parsed, 'topic');
        const store = createStore(env, clock);
        const started = await startRequirement({
          store,
          type: requiredOption(parsed, 'type'),
          title: requiredOption(parsed, 'title'),
          profile: requiredOption(parsed, 'profile'),
          uxImpact: requiredUxImpact(parsed),
          workflowVersion: 2,
          topic,
          migration,
          version,
          bump,
          joinVersion,
          backlogText: readFileSync(join(cwd, 'BACKLOG.md'), 'utf8'),
          owner: ownerFromEnvironment(env),
        });
        let worktree;
        try {
          worktree = await createRequirementWorktree({
            cwd,
            store,
            id: started.id,
            topic,
            session: loadSession({ cwd, sessionId: env.COORD_SESSION_ID }),
          });
        } catch (error) {
          // The coordination write already claimed the id; re-running start would
          // allocate a fresh one. Point the operator at the idempotent recovery
          // command that completes the worktree + BACKLOG registration instead.
          const recovery = `pnpm coord worktree create ${started.id} --topic ${topic}`;
          throw new CoordinationError(
            `${started.id} is claimed but worktree creation failed: ${error.message}; recover with: ${recovery}`,
            {
              code: error?.code ?? 'WORKTREE_CREATE_FAILED',
              exitCode: error?.exitCode,
              data: { requirementId: started.id, recovery },
              cause: error,
            },
          );
        }
        return { message: `started ${started.id}`, data: { ...started, worktree } };
      },
    },
    {
      key: 'requirement enable-workflow',
      usage: 'requirement enable-workflow <ID> --reason <reason>',
      summary: 'Explicitly enroll an existing non-terminal requirement in the closed-loop workflow',
      options: ['reason'],
      handler: async ({ parsed, ctx }) => {
        requirePositionals(parsed, ['enable-workflow', null]);
        const [, id] = parsed.positionals;
        const result = await enableWorkflow({ store: createStore(ctx.env, ctx.clock), id,
          reason: requiredOption(parsed, 'reason'), actor: ownerFromEnvironment(ctx.env), clock: ctx.clock });
        return { message: `enabled closed-loop workflow for ${id}`, data: { id, workflowVersion: 2, ...result } };
      },
    },
    {
      key: 'requirement set-profile',
      usage: 'requirement set-profile <ID> runtime --reason <reason>',
      summary: 'Upgrade an unmerged in-dev governance/tooling requirement to runtime with an audit reason',
      options: ['reason'],
      handler: async ({ parsed, ctx }) => {
        requirePositionals(parsed, ['set-profile', null, 'runtime']);
        const [, id, profile] = parsed.positionals;
        const result = await setRequirementProfile({
          store: createStore(ctx.env, ctx.clock),
          id,
          profile,
          reason: requiredOption(parsed, 'reason'),
          actor: ownerFromEnvironment(ctx.env),
        });
        return { message: `upgraded ${result.id} delivery profile`, data: result };
      },
    },
    {
      key: 'requirement set-ux-impact',
      usage: 'requirement set-ux-impact <ID> admin-ui --reason <reason>',
      summary: 'Upgrade a mistaken none declaration to admin-ui with an audit reason',
      options: ['reason'],
      handler: async ({ parsed, ctx }) => {
        requirePositionals(parsed, ['set-ux-impact', null, 'admin-ui']);
        const [, id, uxImpact] = parsed.positionals;
        const result = await setRequirementUxImpact({
          store: createStore(ctx.env, ctx.clock),
          id,
          uxImpact,
          reason: requiredOption(parsed, 'reason'),
          actor: ownerFromEnvironment(ctx.env).agent,
        });
        return { message: `upgraded ${result.id} UX impact`, data: result };
      },
    },
    {
      // I-243 review：start 时声明的 migrationAssessment 事后可纠正，纠正必须
      // 带原因进入 operation 审计与需求内历史；终态需求拒绝。
      key: 'requirement set-migration',
      usage: 'requirement set-migration <ID> --migration yes|no --reason <reason>',
      summary: 'Correct the recorded migration assessment with an audit reason',
      options: ['migration', 'reason'],
      handler: async ({ parsed, ctx }) => {
        requirePositionals(parsed, ['set-migration', null]);
        const [, id] = parsed.positionals;
        const result = await setRequirementMigration({
          store: createStore(ctx.env, ctx.clock),
          id,
          migration: requiredOption(parsed, 'migration'),
          reason: requiredOption(parsed, 'reason'),
          actor: ownerFromEnvironment(ctx.env),
          // B-248：coordination 事实写入后同步投影 BACKLOG 迁移列，消除双账本。
          cwd: ctx.cwd,
        });
        return {
          message: `set ${result.id} migration assessment to ${result.migrationAssessment}`,
          data: result,
        };
      },
    },
    {
      // B-248：uxImpact=none 的需求触碰 admin review 桶路径（hooks/lib/utils/
      // config）会被 gate 判 UX_IMPACT_REVIEW_UNRESOLVED；确属不影响员工可见
      // 行为的技术改动，用该命令为指定路径记录带理由的豁免，进入审计与需求事实。
      key: 'requirement allow-ux-review',
      usage: 'requirement allow-ux-review <ID> --paths <apps/admin/...,...> --reason <reason>',
      summary: 'Record an audited override carrying admin review-bucket paths on a none declaration',
      options: ['paths', 'reason'],
      handler: async ({ parsed, ctx }) => {
        requirePositionals(parsed, ['allow-ux-review', null]);
        const [, id] = parsed.positionals;
        const result = await allowRequirementUxReview({
          store: createStore(ctx.env, ctx.clock),
          id,
          paths: requiredOption(parsed, 'paths'),
          reason: requiredOption(parsed, 'reason'),
          actor: ownerFromEnvironment(ctx.env),
        });
        return { message: `recorded ux review override for ${result.id}`, data: result };
      },
    },
    {
      // I-243 review：resources.databaseTables 在 start 后由该命令单独维护，
      // 不改动 files/services 等其它资源声明；--database-table 可重复。
      key: 'requirement set-database-tables',
      usage: 'requirement set-database-tables <ID> --database-table <name>... --reason <reason>',
      summary: 'Set the database tables a requirement touches with an audit reason',
      options: ['database-table', 'reason'],
      handler: async ({ parsed, ctx }) => {
        requirePositionals(parsed, ['set-database-tables', null]);
        const [, id] = parsed.positionals;
        const tables = arrayOption(parsed, 'database-table');
        if (tables.length === 0) {
          throw usageError('missing required option: --database-table');
        }
        const result = await setRequirementDatabaseTables({
          store: createStore(ctx.env, ctx.clock),
          id,
          tables,
          reason: requiredOption(parsed, 'reason'),
          actor: ownerFromEnvironment(ctx.env),
        });
        return {
          message: `set ${result.id} database tables`,
          data: result,
        };
      },
    },
    {
      // I-243 review：修复前已 fail 的历史记录仍可能带旧 merge 事实；提供受审计纠正入口。
      key: 'requirement clear-merge',
      usage: 'requirement clear-merge <ID> --reason <reason>',
      summary: 'Clear a stale merge fact from a reworked requirement with an audit reason',
      options: ['reason'],
      handler: async ({ parsed, ctx }) => {
        requirePositionals(parsed, ['clear-merge', null]);
        const [, id] = parsed.positionals;
        const result = await clearRequirementMerge({
          store: createStore(ctx.env, ctx.clock),
          id,
          reason: requiredOption(parsed, 'reason'),
          actor: ownerFromEnvironment(ctx.env),
        });
        return { message: `cleared merge fact for ${result.id}`, data: result };
      },
    },
    {
      key: 'requirement import-existing',
      usage: 'requirement import-existing <ID> --profile <profile> --branch <branch>',
      summary: 'Import an already-claimed requirement into coordination state',
      options: ['profile', 'branch'],
      handler: async ({ parsed, ctx }) => {
        const { env, clock, cwd } = ctx;
        requirePositionals(parsed, ['import-existing', null]);
        const [, id] = parsed.positionals;
        const result = await importExistingRequirement({
          store: createStore(env, clock),
          id,
          profile: requiredOption(parsed, 'profile'),
          branch: requiredOption(parsed, 'branch'),
          backlogText: readFileSync(join(cwd, 'BACKLOG.md'), 'utf8'),
          owner: ownerFromEnvironment(env),
        });
        return { message: `imported existing requirement ${result.id}`, data: result };
      },
    },
    {
      key: 'requirement show',
      usage: 'requirement show <ID>',
      summary: 'Show a claimed requirement',
      options: [],
      handler: async ({ parsed, ctx }) => {
        const { env, clock } = ctx;
        requirePositionals(parsed, ['show', null]);
        const [, id] = parsed.positionals;
        const result = await showRequirement({ store: createStore(env, clock), id });
        return { message: `requirement ${result.id}`, data: result };
      },
    },
    {
      key: 'requirement bind-version',
      usage: 'requirement bind-version <ID> (<version> | --bump <part> | --join-version <v>) [--force]',
      summary: 'Bind a requirement to a release version',
      options: ['force', 'bump', 'join-version'],
      handler: async ({ parsed, ctx }) => {
        const { env, clock } = ctx;
        // I-130 (D2): exactly one of <version>, --bump, or --join-version.
        if (parsed.positionals.length < 2 || parsed.positionals.length > 3) {
          throw usageError('invalid requirement command arguments');
        }
        const [, id, positionalVersion] = parsed.positionals;
        const bump = parsed.options.bump;
        const joinVersion = parsed.options['join-version'];
        const modes = [positionalVersion, bump, joinVersion]
          .filter((value) => value !== undefined);
        if (modes.length !== 1) {
          throw usageError(
            'bind-version requires exactly one of <version>, --bump, or --join-version',
          );
        }
        const result = await bindRequirementVersion({
          store: createStore(env, clock),
          id,
          version: positionalVersion,
          bump,
          joinVersion,
          force: parsed.options.force === true,
        });
        return { message: `bound ${id} to ${result.version}`, data: result };
      },
    },
    {
      key: 'requirement bind-branch',
      usage: 'requirement bind-branch <ID> <branch> [--force]',
      summary: 'Bind a requirement to a feature branch',
      options: ['force'],
      handler: async ({ parsed, ctx }) => {
        const { env, clock } = ctx;
        requirePositionals(parsed, ['bind-branch', null, null]);
        const [, id, branch] = parsed.positionals;
        const result = await bindRequirementBranch({
          store: createStore(env, clock),
          id,
          branch,
          force: parsed.options.force === true,
        });
        return { message: `bound ${id} to branch ${result.branch}`, data: result };
      },
    },
    {
      key: 'requirement declare-resources',
      usage: 'requirement declare-resources <ID> [--auto] [--file <path>]... [--service <name>]... [--database-table <name>]... [--config-key <key>]... [--shared <resource>]... [--depends-on <ID>]...',
      summary: 'Declare the resources a requirement touches (--auto infers from git diff origin/main...HEAD + uncommitted; ≥3 files in one directory collapse to dir/** except root scripts; BACKLOG.md and docs/product/current/<ID>-* are excluded)',
      options: ['file', 'service', 'database-table', 'config-key', 'shared', 'depends-on', 'auto'],
      handler: async ({ parsed, ctx }) => {
        const { env, clock, cwd } = ctx;
        requirePositionals(parsed, ['declare-resources', null]);
        const [, id] = parsed.positionals;
        const store = createStore(env, clock);
        const explicit = {
          files: arrayOption(parsed, 'file'),
          services: arrayOption(parsed, 'service'),
          databaseTables: arrayOption(parsed, 'database-table'),
          configKeys: arrayOption(parsed, 'config-key'),
          sharedResources: arrayOption(parsed, 'shared'),
        };
        const dependsOn = arrayOption(parsed, 'depends-on');
        const resources = { ...explicit };
        // I-134 (F4): --auto unions the git-derived inference (diff +
        // uncommitted + classifier) with the explicit options; the inference
        // provenance is echoed back under data.inferred.
        let inferred = null;
        if (parsed.options.auto === true) {
          inferred = inferRequirementResources({ cwd, id, base: `${store.remote}/main` });
          const explicitCount = Object.values(explicit).flat().length + dependsOn.length;
          if (inferred.files.length === 0 && inferred.services.length === 0 && explicitCount === 0) {
            throw usageError(
              `nothing to declare for ${id}: no changed files inferred and no explicit options given`,
            );
          }
          resources.files = [...resources.files, ...inferred.files.map(({ value }) => value)];
          resources.services = [...resources.services, ...inferred.services.map(({ value }) => value)];
        }
        const result = await declareRequirementResources({
          store,
          id,
          resources,
          dependsOn,
        });
        return {
          message: `declared resources for ${id}`,
          data: { ...result, ...(inferred ? { inferred } : {}) },
        };
      },
    },
    {
      // I-134 (F8): administrative terminal cancel. The projection mirrors
      // advance (clean-check + branch assertion up front, coordination
      // update, row rewrite, publish); the worktree/branch and held leases
      // are reported as cleanup hints, never auto-removed.
      key: 'requirement cancel',
      usage: 'requirement cancel <ID> --reason <reason> [--force]',
      summary: 'Cancel a non-terminal requirement (in_dev and later needs --force)',
      options: ['reason', 'force'],
      handler: async ({ parsed, ctx }) => {
        const { env, clock, cwd } = ctx;
        requirePositionals(parsed, ['cancel', null]);
        const [, id] = parsed.positionals;
        validateRequirementId(id);
        const store = createStore(env, clock);
        const requirement = readClaimedRequirement(await store.readSnapshot(), id);
        let projectionBranch = null;
        // I-134 (review): an already-cancelled requirement is an idempotent
        // no-op — the terminal fact exists, so the projection was already
        // published or deliberately skipped. Re-running cancel after the
        // worktree/branch was cleaned up (or from another checkout) must not
        // trip the clean/branch assertions below.
        if (requirement.branch && requirement.lifecycle !== 'cancelled') {
          assertBacklogProjectionClean({ cwd, id });
          projectionBranch = assertProjectionBranch({
            cwd,
            id,
            branch: requirement.branch,
            mergedCommit: requirement.mergeStatus === 'merged' ? requirement.mergedCommit : null,
          });
        }
        const result = await cancelRequirement({
          store,
          cwd,
          id,
          reason: requiredOption(parsed, 'reason'),
          force: parsed.options.force === true,
          actor: ownerFromEnvironment(env).agent,
        });
        // A requirement never bound to a branch has no projection target;
        // the cancelled coordination fact stands alone.
        let published = null;
        if (projectionBranch) {
          published = publishBacklogProjection({
            cwd,
            remote: store.remote,
            branch: projectionBranch,
            id,
            message: `docs(docs): project ${id} to cancelled [${id}]`,
          });
        }
        const snapshot = await store.readSnapshot();
        const heldResources = snapshot.paths()
          .filter((path) => /^locks\/[^/]+\.json$/.test(path))
          .map((path) => snapshot.readJson(path))
          .filter((lock) => lock?.active?.holder?.id === id)
          .map((lock) => lock.resource)
          .sort();
        const cleanupHints = [];
        if (heldResources.length > 0) {
          cleanupHints.push(
            `release the held lease(s): ${heldResources.map((resource) => `pnpm coord lock release ${resource} --json`).join('; ')} (or break from another session: pnpm coord lock break <resource> --reason <text> --force --json)`,
          );
        }
        const worktreePath = worktreePathForBranch(cwd, requirement.branch);
        if (worktreePath) {
          cleanupHints.push(`remove the worktree: git worktree remove ${JSON.stringify(worktreePath)}`);
        }
        if (requirement.branch) {
          cleanupHints.push(
            `delete the branch when done: git branch -D ${requirement.branch} && git push ${store.remote} --delete ${requirement.branch}`,
          );
        }
        return {
          message: result.changed ? `cancelled ${id}` : `${id} is already cancelled`,
          data: { ...result, published, cleanupHints },
        };
      },
    },
    {
      key: 'requirement reconcile-merged',
      usage: 'requirement reconcile-merged --commit <sha> [--base <sha>]',
      summary: 'Reconcile requirements merged by a main commit',
      options: ['commit', 'base'],
      handler: async ({ parsed, ctx }) => {
        const { env, clock, cwd } = ctx;
        requirePositionals(parsed, ['reconcile-merged']);
        const result = await reconcileMergedRequirements({
          store: createStore(env, clock),
          cwd,
          commit: requiredOption(parsed, 'commit'),
          base: parsed.options.base,
        });
        return {
          message: `reconciled main commit with action ${result.action}`,
          data: result,
        };
      },
    },
    {
      key: 'requirement plan-completion',
      usage: 'requirement plan-completion <ID> --commit <sha>',
      summary: 'Plan the runtime completion patch for a merged requirement',
      options: ['commit'],
      handler: async ({ parsed, ctx }) => {
        const { env, clock, cwd } = ctx;
        requirePositionals(parsed, ['plan-completion', null]);
        const [, id] = parsed.positionals;
        const result = await planRequirementCompletion({
          store: createStore(env, clock),
          cwd,
          id,
          commit: requiredOption(parsed, 'commit'),
        });
        return { message: `planned runtime completion for ${id}`, data: result };
      },
    },
    {
      key: 'requirement apply-completion',
      usage: 'requirement apply-completion --plan <file> --requirement <ID>',
      summary: 'Apply a planned runtime completion patch',
      options: ['plan', 'requirement'],
      handler: async ({ parsed, ctx }) => {
        const { env, cwd } = ctx;
        requirePositionals(parsed, ['apply-completion']);
        const planPath = requiredOption(parsed, 'plan');
        let plan;
        try {
          plan = JSON.parse(readFileSync(planPath, 'utf8'));
        } catch (error) {
          throw new CoordinationError(`invalid completion plan: ${planPath}`, {
            code: 'INVALID_COMPLETION_PLAN',
            cause: error,
          });
        }
        const result = applyCompletionPatch({
          cwd,
          plan,
          requirementId: requiredOption(parsed, 'requirement'),
        });
        return {
          message: `applied completion patch for ${result.requirementId}`,
          data: result,
        };
      },
    },
  ],
};
