import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  ensureInitialBacklogRow,
  publishBacklogProjection,
} from './repository-projection.mjs';
import { assertRequirementId } from './validation.mjs';
import { BACKLOG_STATUSES } from './lifecycle.mjs';

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AGENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const TOPIC_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export class WorktreeError extends Error {
  constructor(message, { code, exitCode = 14, data = {} }) {
    super(message);
    this.name = 'WorktreeError';
    this.code = code;
    this.exitCode = exitCode;
    this.data = data;
  }
}

function runGitResult(cwd, args) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runGit(cwd, args) {
  const result = runGitResult(cwd, args);
  if (result.error || result.status !== 0) {
    const message = result.stderr || result.error?.message || 'git command failed';
    throw new WorktreeError(`git ${args.join(' ')} failed: ${message.trim()}`, {
      code: 'GIT_WORKTREE_ERROR',
      exitCode: 13,
    });
  }
  return result.stdout.trim();
}

function commonDir(cwd) {
  return realpathSync(resolve(cwd, runGit(cwd, ['rev-parse', '--git-common-dir'])));
}

export function gitCommonDir(cwd) {
  return commonDir(cwd);
}

// I-249: 新建/加入的 worktree 不会自动检出 submodule（引擎自身所在的
// .coord-engine、.shared-skills 等），缺失会让 worktree 内的 pnpm coord 与
// skills 入口直接不可用。init 幂等，仓库没有 .gitmodules 时是 no-op。
export function ensureSubmodulesInitialized(cwd) {
  if (!existsSync(join(cwd, '.gitmodules'))) return;
  runGit(cwd, ['submodule', 'update', '--init']);
}

function coordinationLocalDir(cwd) {
  return join(commonDir(cwd), 'coordination');
}

function validateText(value, name) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (normalized.length === 0 || normalized.length > 100 || /[\r\n]/.test(normalized)) {
    throw new WorktreeError(`invalid session ${name}`, {
      code: 'INVALID_SESSION_IDENTITY',
    });
  }
  return normalized;
}

function validateSessionId(sessionId) {
  if (!SESSION_ID_PATTERN.test(sessionId ?? '')) {
    throw new WorktreeError(
      `invalid session id: ${sessionId ?? '<missing>'}; run 'pnpm coord session init --agent <agent> --user <user>' or export COORD_SESSION_ID (the sessions/current pointer is used when it is unset)`,
      { code: 'INVALID_SESSION_ID' },
    );
  }
  return sessionId;
}

function sessionPath(cwd, sessionId) {
  return join(coordinationLocalDir(cwd), 'sessions', `${validateSessionId(sessionId)}.json`);
}

function currentSessionPath(cwd) {
  return join(coordinationLocalDir(cwd), 'sessions', 'current');
}

// I-128 (H1): the most recent locally initialized session is the default
// identity, so agents do not have to thread COORD_SESSION_ID through every
// shell. An explicitly empty COORD_SESSION_ID stays invalid (fail-closed
// tests rely on that); only an *unset* variable falls back to the pointer.
function readCurrentSessionId(cwd) {
  try {
    const value = readFileSync(currentSessionPath(cwd), 'utf8').trim();
    return SESSION_ID_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function initializeSession({
  cwd,
  agent,
  user,
  host,
  clock = () => new Date(),
}) {
  if (!AGENT_PATTERN.test(agent ?? '')) {
    throw new WorktreeError(`invalid session agent: ${agent ?? '<missing>'}`, {
      code: 'INVALID_SESSION_IDENTITY',
    });
  }
  const sessionsDir = join(coordinationLocalDir(cwd), 'sessions');
  mkdirSync(sessionsDir, { recursive: true });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const session = {
      schemaVersion: 1,
      sessionId: randomUUID(),
      agent,
      user: validateText(user, 'user'),
      host: validateText(host, 'host'),
      createdAt: clock().toISOString(),
    };
    try {
      writeFileSync(
        sessionPath(cwd, session.sessionId),
        `${JSON.stringify(session, null, 2)}\n`,
        { flag: 'wx', mode: 0o600 },
      );
      writeFileSync(currentSessionPath(cwd), `${session.sessionId}\n`, { mode: 0o600 });
      return session;
    } catch (error) {
      if (error.code !== 'EEXIST' || attempt === 2) throw error;
    }
  }
  throw new WorktreeError('failed to allocate session id', {
    code: 'SESSION_ID_COLLISION',
  });
}

export function loadSession({ cwd, sessionId }) {
  const effectiveSessionId = sessionId ?? readCurrentSessionId(cwd);
  const path = sessionPath(cwd, effectiveSessionId);
  if (!existsSync(path)) {
    throw new WorktreeError(`session is not initialized: ${effectiveSessionId}`, {
      code: 'SESSION_NOT_FOUND',
    });
  }
  const session = JSON.parse(readFileSync(path, 'utf8'));
  if (session.schemaVersion !== 1 || session.sessionId !== effectiveSessionId) {
    throw new WorktreeError(`invalid local session metadata: ${effectiveSessionId}`, {
      code: 'INVALID_SESSION_METADATA',
    });
  }
  return session;
}

function validateRequirementId(id) {
  try {
    return assertRequirementId(id);
  } catch (error) {
    throw new WorktreeError(error.message, { code: 'INVALID_REQUIREMENT_ID' });
  }
}

function workstreamsDir(cwd) {
  return join(coordinationLocalDir(cwd), 'workstreams');
}

function bindingPath(cwd, id) {
  return join(workstreamsDir(cwd), `${validateRequirementId(id)}.json`);
}

function writeBinding(cwd, binding) {
  const directory = workstreamsDir(cwd);
  mkdirSync(directory, { recursive: true });
  const target = bindingPath(cwd, binding.requirementId);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(binding, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
}

export function readWorkstreamBinding({ cwd, id }) {
  const path = bindingPath(cwd, id);
  if (!existsSync(path)) {
    throw new WorktreeError(`workstream is not bound locally: ${id}`, {
      code: 'WORKSTREAM_NOT_FOUND',
    });
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

function allBindings(cwd) {
  const directory = workstreamsDir(cwd);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => /^(I|F|B)-\d{3,}\.json$/.test(name))
    .map((name) => JSON.parse(readFileSync(join(directory, name), 'utf8')));
}

function ensureKnownSession(cwd, session) {
  if (!session || typeof session !== 'object') {
    throw new WorktreeError('a session is required', { code: 'SESSION_REQUIRED' });
  }
  return loadSession({ cwd, sessionId: session.sessionId });
}

function requirementFromSnapshot(snapshot, id) {
  const path = `requirements/${validateRequirementId(id)}.json`;
  if (!snapshot.has(path)) {
    throw new WorktreeError(`requirement is not claimed: ${id}`, {
      code: 'REQUIREMENT_NOT_FOUND',
    });
  }
  return snapshot.readJson(path);
}

function ensureWorktreeDirectoryIgnored(cwd) {
  const root = runGit(cwd, ['rev-parse', '--show-toplevel']);
  mkdirSync(join(root, '.worktrees'), { recursive: true });
  const result = runGitResult(cwd, ['check-ignore', '-q', '.worktrees/']);
  if (result.status !== 0) {
    throw new WorktreeError('.worktrees must be ignored before creating worktrees', {
      code: 'WORKTREE_DIRECTORY_NOT_IGNORED',
    });
  }
  return root;
}

function validateTopic(topic) {
  if (!TOPIC_PATTERN.test(topic ?? '')) {
    throw new WorktreeError(`invalid worktree topic: ${topic ?? '<missing>'}`, {
      code: 'INVALID_WORKTREE_TOPIC',
    });
  }
  return topic;
}

// I-130 (D3): requirement start validates the topic before the coordination
// write, so a bad topic cannot leave a half-initialized requirement.
export { validateTopic };

function addSessionToBinding(binding, sessionId, clock) {
  return {
    ...binding,
    sessions: [...new Set([...(binding.sessions ?? []), sessionId])].sort(),
    updatedAt: clock().toISOString(),
  };
}

function registerAndPublishRequirement({ path, store, requirement, id, branch }) {
  // I-130 (D3): the BACKLOG migration column projects the requirement's
  // declared migrationAssessment; requirements claimed the old way (claim,
  // import-existing) have no such field and fall back to 待评审.
  const migration = requirement.migrationAssessment ?? '待评审';
  // I-131 (E2): the status column projects requirement.lifecycle — start
  // lands at in_dev (🔨 In Dev), the old claim path stays at todo (⚪ Todo).
  const status = BACKLOG_STATUSES[requirement.lifecycle] ?? '⚪ Todo';
  ensureInitialBacklogRow({
    cwd: path,
    id,
    title: requirement.title,
    migration,
    status,
    version: requirement.version,
    notes: migration === '待评审'
      ? `profile=${requirement.deliveryProfile}; migration and resources unresolved at Todo`
      : `profile=${requirement.deliveryProfile}; migration declared ${migration} at start; resources unresolved at Todo`,
  });
  try {
    return publishBacklogProjection({
      cwd: path,
      remote: store.remote,
      branch,
      id,
      message: `docs(docs): register ${id} requirement [${id}]`,
    });
  } catch (error) {
    // I-128 (M10): a freshly claimed requirement has no lifecycle history, so
    // `coord reconcile <id>` cannot replay a failed registration projection.
    // Re-running `worktree create` is idempotent and closes out the
    // registration — point operators there instead of at the dead end.
    if (Array.isArray(error?.data?.requiredActions)) {
      error.data.requiredActions.unshift(
        `re-run 'pnpm coord worktree create ${id} --topic <topic> --json' (idempotent: completes the registration)`,
      );
    }
    throw error;
  }
}

async function bindRequirementBranch({ store, id, branch, session }) {
  return store.update({
    operation: `bind worktree branch for ${id}`,
    mutate(remoteSnapshot) {
      const remoteRequirement = requirementFromSnapshot(remoteSnapshot, id);
      if (remoteRequirement.branch && remoteRequirement.branch !== branch) {
        throw new WorktreeError(
          `${id} is already bound to ${remoteRequirement.branch}`,
          { code: 'BRANCH_ALREADY_BOUND' },
        );
      }
      remoteSnapshot.writeJson(`requirements/${id}.json`, {
        ...remoteRequirement,
        branch,
        owner: {
          ...remoteRequirement.owner,
          sessionId: session.sessionId,
          agent: session.agent,
          user: session.user,
          host: session.host,
        },
        updatedAt: store.clock().toISOString(),
      });
    },
  });
}

export async function createRequirementWorktree({
  cwd,
  store,
  id,
  topic,
  session,
  clock = () => new Date(),
}) {
  const knownSession = ensureKnownSession(cwd, session);
  validateTopic(topic);
  const root = ensureWorktreeDirectoryIgnored(cwd);
  const snapshot = await store.readSnapshot();
  const requirement = requirementFromSnapshot(snapshot, id);
  if (!requirement.version) {
    throw new WorktreeError(`${id} must be bound to a version before creating a worktree`, {
      code: 'VERSION_REQUIRED',
    });
  }

  const path = join(root, '.worktrees', `${id}-${topic}`);
  const branch = `feature/${requirement.version}/${topic}`;
  if (existsSync(path)) {
    const binding = allBindings(cwd).find((candidate) => candidate.requirementId === id);
    const actualBranch = runGit(path, ['branch', '--show-current']);
    if (
      actualBranch !== branch
      || (requirement.branch && requirement.branch !== branch)
      || (binding && (
        resolve(binding.path) !== resolve(path)
        || binding.branch !== branch
      ))
    ) {
      throw new WorktreeError(`worktree path already exists: ${path}`, {
        code: 'WORKTREE_PATH_EXISTS',
      });
    }
    if (!requirement.branch) {
      await bindRequirementBranch({ store, id, branch, session: knownSession });
    }
    const recovered = binding
      ? addSessionToBinding(binding, knownSession.sessionId, clock)
      : {
        schemaVersion: 1,
        requirementId: id,
        branch,
        path: realpathSync(path),
        sessions: [knownSession.sessionId],
        createdAt: clock().toISOString(),
        updatedAt: clock().toISOString(),
      };
    writeBinding(cwd, recovered);
    ensureSubmodulesInitialized(path);
    registerAndPublishRequirement({ path, store, requirement, id, branch });
    return recovered;
  }
  const conflicting = allBindings(cwd).find((binding) => (
    resolve(binding.path) === resolve(path) && binding.requirementId !== id
  ));
  if (conflicting) {
    throw new WorktreeError(`worktree is already bound to ${conflicting.requirementId}`, {
      code: 'WORKTREE_ALREADY_BOUND',
    });
  }

  mkdirSync(dirname(path), { recursive: true });
  const mainRef = `refs/remotes/${store.remote}/main`;
  // B-248: another machine may have created and pushed this feature branch
  // already. Recreating it from main would later fail the registration push
  // as non-fast-forward (PROJECTION_UNCERTAIN); fail early with the actual
  // recovery paths instead of a raw git error.
  const remoteBranch = runGitResult(cwd, ['ls-remote', '--heads', store.remote, branch]);
  if (remoteBranch.status === 0 && remoteBranch.stdout.trim()) {
    throw new WorktreeError(
      `remote branch ${branch} already exists; join it from an existing checkout (pnpm coord worktree join ${id} --path <path>) or fetch it and rebuild the local worktree on that branch instead of recreating from main`,
      { code: 'REMOTE_BRANCH_EXISTS' },
    );
  }
  runGit(cwd, [
    'fetch',
    '--no-tags',
    store.remote,
    `+refs/heads/main:${mainRef}`,
  ]);
  runGit(cwd, ['worktree', 'add', '-b', branch, path, mainRef]);
  ensureSubmodulesInitialized(path);
  try {
    await bindRequirementBranch({ store, id, branch, session: knownSession });
  } catch (error) {
    runGitResult(cwd, ['worktree', 'remove', '--force', path]);
    throw error;
  }

  const binding = {
    schemaVersion: 1,
    requirementId: id,
    branch,
    path: realpathSync(path),
    sessions: [knownSession.sessionId],
    createdAt: clock().toISOString(),
    updatedAt: clock().toISOString(),
  };
  writeBinding(cwd, binding);
  registerAndPublishRequirement({ path, store, requirement, id, branch });
  return binding;
}

export async function joinRequirementWorktree({
  cwd,
  store,
  id,
  path,
  session,
  clock = () => new Date(),
}) {
  const knownSession = ensureKnownSession(cwd, session);
  if (!existsSync(path)) {
    throw new WorktreeError(`worktree path does not exist: ${path}`, {
      code: 'WORKTREE_NOT_FOUND',
    });
  }
  const normalizedPath = realpathSync(runGit(path, ['rev-parse', '--show-toplevel']));
  if (commonDir(normalizedPath) !== commonDir(cwd)) {
    throw new WorktreeError('worktree belongs to a different Git repository', {
      code: 'FOREIGN_WORKTREE',
    });
  }
  const conflicting = allBindings(cwd).find((binding) => (
    resolve(binding.path) === normalizedPath && binding.requirementId !== id
  ));
  if (conflicting) {
    throw new WorktreeError(`worktree is already bound to ${conflicting.requirementId}`, {
      code: 'WORKTREE_ALREADY_BOUND',
    });
  }

  const requirement = requirementFromSnapshot(await store.readSnapshot(), id);
  const branch = runGit(normalizedPath, ['branch', '--show-current']);
  if (!requirement.branch || requirement.branch !== branch) {
    throw new WorktreeError(
      `worktree branch ${branch || '<detached>'} does not match ${id} branch ${requirement.branch ?? '<unbound>'}`,
      { code: 'WORKTREE_BRANCH_MISMATCH' },
    );
  }

  ensureSubmodulesInitialized(normalizedPath);

  let binding;
  const localPath = bindingPath(cwd, id);
  if (existsSync(localPath)) {
    binding = readWorkstreamBinding({ cwd, id });
    if (resolve(binding.path) !== normalizedPath) {
      throw new WorktreeError(`${id} is already bound to another local worktree`, {
        code: 'WORKSTREAM_ALREADY_BOUND',
      });
    }
  } else {
    binding = {
      schemaVersion: 1,
      requirementId: id,
      branch,
      path: normalizedPath,
      sessions: [],
      createdAt: clock().toISOString(),
      updatedAt: clock().toISOString(),
    };
  }
  binding = addSessionToBinding(binding, knownSession.sessionId, clock);
  writeBinding(cwd, binding);
  return binding;
}
