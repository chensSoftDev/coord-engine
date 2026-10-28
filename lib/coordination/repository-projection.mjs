import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class RepositoryProjectionError extends Error {
  constructor(message, { code = 'PROJECTION_UNCERTAIN', exitCode = 15, data = {}, cause } = {}) {
    super(message, { cause });
    this.name = 'RepositoryProjectionError';
    this.code = code;
    this.exitCode = exitCode;
    this.data = data;
  }
}

function gitResult(cwd, args) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function git(cwd, args) {
  const result = gitResult(cwd, args);
  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.error?.message || 'git command failed').trim();
    throw new RepositoryProjectionError(`git ${args.join(' ')} failed: ${detail}`, {
      code: 'PROJECTION_GIT_ERROR',
      exitCode: 13,
      data: { args },
      cause: result.error,
    });
  }
  return result.stdout.trim();
}

function projectionUncertain({ cwd, id, ids, remote, branch, reason, cause, data = {} }) {
  // I-131 (E5): a batch projection reconciles every advanced requirement;
  // the single-ID shape stays unchanged for the classic path.
  const scopeIds = ids ?? [id];
  const dirty = Boolean(git(cwd, ['status', '--porcelain']));
  const requiredActions = [
    `git fetch ${remote} ${branch}`,
    `git rebase ${remote}/${branch}`,
    ...scopeIds.map((scopeId) => `pnpm coord reconcile ${scopeId} --json`),
  ];
  if (dirty) {
    requiredActions.unshift(
      `git stash push --include-untracked --message coordination-projection-${scopeIds.join('-')}`,
    );
    requiredActions.splice(requiredActions.length - scopeIds.length, 0, 'git stash pop --index');
  }
  return new RepositoryProjectionError(
    reason ?? `${remote}/${branch} is not an ancestor of the local projection commit`,
    {
      data: {
        id,
        ...(ids ? { ids: scopeIds } : {}),
        branch,
        requiredActions,
        ...data,
      },
      cause,
    },
  );
}

function backlogField(value, name) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || /[|\r\n]/.test(normalized)) {
    throw new RepositoryProjectionError(`invalid BACKLOG ${name}`, {
      code: 'BACKLOG_PROJECTION_CONFLICT',
      exitCode: 14,
    });
  }
  return normalized;
}

export function ensureInitialBacklogRow({
  cwd,
  id,
  title,
  migration,
  status,
  version,
  notes,
}) {
  const normalizedId = backlogField(id, 'id');
  const expected = `| ${normalizedId} | ${backlogField(title, 'title')} | ${backlogField(migration, 'migration')} | ${backlogField(status, 'status')} | ${backlogField(version, 'version')} | ${backlogField(notes, 'notes')} |`;
  const path = join(cwd, 'BACKLOG.md');
  const original = readFileSync(path, 'utf8');
  const matches = original.split(/\r?\n/).filter((line) => (
    line.split('|')[1]?.trim() === normalizedId
  ));
  if (matches.length > 1 || (matches.length === 1 && matches[0] !== expected)) {
    throw new RepositoryProjectionError(`BACKLOG registration conflicts for ${normalizedId}`, {
      code: 'BACKLOG_PROJECTION_CONFLICT',
      exitCode: 14,
      data: { id: normalizedId, expected, actual: matches },
    });
  }
  if (matches.length === 1) return { changed: false, row: expected };

  const separator = original.length === 0 || original.endsWith('\n') ? '' : '\n';
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${original}${separator}${expected}\n`, { mode: statSync(path).mode });
  renameSync(temporary, path);
  return { changed: true, row: expected };
}

function remoteBranchExists(cwd, remote, branch) {
  const result = gitResult(cwd, [
    'ls-remote', '--exit-code', '--heads', remote, `refs/heads/${branch}`,
  ]);
  if (result.status === 0) return true;
  if (result.status === 2) return false;
  const detail = (result.stderr || result.error?.message || 'git ls-remote failed').trim();
  throw new RepositoryProjectionError(`cannot inspect ${remote}/${branch}: ${detail}`, {
    code: 'PROJECTION_GIT_ERROR',
    exitCode: 13,
  });
}

export function assertBacklogProjectionClean({ cwd, id }) {
  const status = git(cwd, ['status', '--porcelain', '--', 'BACKLOG.md']);
  if (status) {
    throw new RepositoryProjectionError(
      `BACKLOG.md has uncommitted changes before lifecycle update for ${id}`,
      {
        code: 'BACKLOG_PROJECTION_DIRTY',
        exitCode: 14,
        data: { id, status },
      },
    );
  }
}

export function isBacklogProjectionDescendant({ cwd, ancestor, descendant = 'HEAD' }) {
  if (!/^[0-9a-f]{7,40}$/.test(ancestor ?? '')) return false;
  if (gitResult(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]).status !== 0) {
    return false;
  }
  const changed = gitResult(cwd, ['diff', '--name-only', `${ancestor}..${descendant}`]);
  if (changed.error || changed.status !== 0) return false;
  return changed.stdout.split(/\r?\n/).filter(Boolean).every((path) => path === 'BACKLOG.md');
}

export function assertProjectionBranch({ cwd, id, branch, mergedCommit = null }) {
  const currentBranch = git(cwd, ['branch', '--show-current']);
  if (currentBranch === branch) return currentBranch;
  const isMergedDescendant = (
    currentBranch
    && /^[0-9a-f]{40}$/.test(mergedCommit ?? '')
    && gitResult(cwd, ['merge-base', '--is-ancestor', mergedCommit, 'HEAD']).status === 0
  );
  if (!isMergedDescendant) {
    throw new RepositoryProjectionError(
      `cannot publish ${id} from ${currentBranch || 'detached HEAD'}; expected ${branch}`,
      {
        code: 'BRANCH_MISMATCH',
        exitCode: 14,
        data: { id, branch, currentBranch: currentBranch || null },
      },
    );
  }
  return currentBranch;
}

function withoutRequirementRow(source, id) {
  return source.split(/\r?\n/).filter((line) => (
    line.split('|')[1]?.trim() !== id
  )).join('\n');
}

// I-131 (E5): `ids` scopes the check to a batch of rows; the single-ID
// call shape is unchanged.
export function assertBacklogProjectionScoped({ cwd, id, ids }) {
  const scopeIds = ids ?? [id];
  const current = readFileSync(join(cwd, 'BACKLOG.md'), 'utf8');
  const committedResult = gitResult(cwd, ['show', 'HEAD:BACKLOG.md']);
  if (committedResult.error || committedResult.status !== 0) {
    const detail = (
      committedResult.stderr
      || committedResult.error?.message
      || 'git show HEAD:BACKLOG.md failed'
    ).trim();
    throw new RepositoryProjectionError(`cannot inspect committed BACKLOG.md: ${detail}`, {
      code: 'PROJECTION_GIT_ERROR',
      exitCode: 13,
      cause: committedResult.error,
    });
  }
  const committed = committedResult.stdout;
  const strip = (source) => scopeIds.reduce(
    (text, scopeId) => withoutRequirementRow(text, scopeId),
    source,
  );
  if (strip(current) !== strip(committed)) {
    throw new RepositoryProjectionError(
      `BACKLOG.md contains changes outside ${scopeIds.join(', ')}`,
      {
        code: 'BACKLOG_PROJECTION_SCOPE_DIRTY',
        exitCode: 14,
        data: { id, ...(ids ? { ids: scopeIds } : {}) },
      },
    );
  }
}

export function publishBacklogProjection({ cwd, remote, branch, id, ids, message }) {
  try {
    assertProjectionBranch({ cwd, id, branch });
    let committed = false;
    if (git(cwd, ['status', '--porcelain', '--', 'BACKLOG.md'])) {
      assertBacklogProjectionScoped({ cwd, id, ids });
      git(cwd, ['commit', '--only', '-m', message, '--', 'BACKLOG.md']);
      committed = true;
    }

    if (remoteBranchExists(cwd, remote, branch)) {
      git(cwd, ['fetch', '--no-tags', remote, branch]);
      const remoteRef = `refs/remotes/${remote}/${branch}`;
      if (gitResult(cwd, ['merge-base', '--is-ancestor', remoteRef, 'HEAD']).status !== 0) {
        throw projectionUncertain({ cwd, id, ids, remote, branch });
      }
    }
    // I-130 (D5): every coordination-internal push skips local hooks — the
    // product pre-push CI must never gate high-frequency machine pushes
    // (state branch, BACKLOG projection, worktree registration).
    const pushArgs = ['push', '--no-verify', '--set-upstream', remote, `HEAD:refs/heads/${branch}`];
    const push = gitResult(cwd, pushArgs);
    if (push.error || push.status !== 0) {
      const detail = (push.stderr || push.error?.message || 'git push failed').trim();
      throw projectionUncertain({
        cwd,
        id,
        ids,
        remote,
        branch,
        reason: `git ${pushArgs.join(' ')} failed: ${detail}`,
        cause: push.error,
      });
    }
    return {
      committed,
      pushed: true,
      head: git(cwd, ['rev-parse', 'HEAD']),
    };
  } catch (error) {
    if (error?.code === 'PROJECTION_UNCERTAIN') throw error;
    throw projectionUncertain({
      cwd,
      id,
      ids,
      remote,
      branch,
      reason: 'coordination changed but repository projection could not be proven complete',
      cause: error,
      data: {
        projectionError: error instanceof Error ? error.message : String(error),
        projectionCode: error?.code ?? null,
      },
    });
  }
}
