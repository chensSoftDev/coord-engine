import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { assertStateDocument } from './validation.mjs';

const TEMP_PREFIX = 'luggage-coordination-';

class GitCommandError extends Error {
  constructor(args, result) {
    const stderr = result.stderr || result.error?.message || 'git command failed';
    super(`git ${args.join(' ')} failed: ${stderr.trim()}`);
    this.name = 'GitCommandError';
    this.args = args;
    this.status = result.status;
    this.stdout = result.stdout ?? '';
    this.stderr = result.stderr ?? '';
  }
}

export class GitStoreError extends Error {
  constructor(message, { code, exitCode, cause, data = {} }) {
    super(message, { cause });
    this.name = 'GitStoreError';
    this.code = code;
    this.exitCode = exitCode;
    this.data = data;
  }
}

// I-128 (L12): git invocations must fail fast instead of hanging forever on
// network stalls or credential prompts; ssh stays non-interactive unless the
// caller explicitly configured its own GIT_SSH_COMMAND.
const GIT_TIMEOUT_MS = 120_000;

function gitEnv() {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
  };
}

function runGit(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: gitEnv(),
    timeout: GIT_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0) {
    throw new GitCommandError(args, result);
  }
  return result.stdout;
}

// Snapshot reads go through a single `cat-file --batch` process: the output is
// binary-framed (`<sha> blob <size>\n<bytes>\n` per object) and currently runs
// ~1.4MB for the whole branch, well above the 1MB spawnSync default.
const BATCH_MAX_BYTES = 64 * 1024 * 1024;

function runGitBuffer(cwd, args, { input } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    input,
    encoding: 'buffer',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: BATCH_MAX_BYTES,
    env: gitEnv(),
    timeout: GIT_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0) {
    throw new GitCommandError(args, {
      status: result.status,
      stdout: '',
      stderr: result.stderr ? result.stderr.toString('utf8') : '',
      error: result.error,
    });
  }
  return result.stdout;
}

function safeStatePath(path) {
  if (typeof path !== 'string' || path.length === 0 || isAbsolute(path)) {
    throw new TypeError(`invalid coordination state path: ${path ?? '<missing>'}`);
  }
  const normalized = normalize(path);
  if (normalized === '..' || normalized.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new TypeError(`invalid coordination state path: ${path}`);
  }
  return normalized;
}

export class CoordinationSnapshot {
  constructor({ sha, files }) {
    this.sha = sha;
    this.files = new Map(files);
    this.originalFiles = new Map(files);
    this.changedPaths = new Set();
  }

  has(path) {
    return this.files.has(safeStatePath(path));
  }

  paths() {
    return [...this.files.keys()].sort();
  }

  readText(path) {
    const safePath = safeStatePath(path);
    if (!this.files.has(safePath)) {
      throw new GitStoreError(`coordination state file is missing: ${safePath}`, {
        code: 'STATE_FILE_MISSING',
        exitCode: 14,
      });
    }
    return this.files.get(safePath);
  }

  readJson(path) {
    const safePath = safeStatePath(path);
    try {
      return JSON.parse(this.readText(safePath));
    } catch (error) {
      if (error instanceof GitStoreError) throw error;
      throw new GitStoreError(`invalid coordination JSON: ${safePath}`, {
        code: 'INVALID_STATE_JSON',
        exitCode: 14,
        cause: error,
      });
    }
  }

  writeText(path, value) {
    const safePath = safeStatePath(path);
    if (typeof value !== 'string') {
      throw new TypeError(`coordination state must be text: ${safePath}`);
    }
    this.files.set(safePath, value);
    this.changedPaths.add(safePath);
  }

  writeJson(path, value) {
    this.writeText(path, `${JSON.stringify(value, null, 2)}\n`);
  }

  delete(path) {
    const safePath = safeStatePath(path);
    this.files.delete(safePath);
    this.changedPaths.add(safePath);
  }

  hasChanges() {
    return [...this.changedPaths].some((path) => (
      this.files.get(path) !== this.originalFiles.get(path)
    ));
  }
}

function isMissingRemoteRef(error) {
  return error instanceof GitCommandError
    && /couldn't find remote ref|no such ref|not our ref/i.test(error.stderr);
}

function isStalePush(error) {
  return error instanceof GitCommandError
    && /stale info|fetch first|non-fast-forward|\[rejected\]|cannot lock ref.*expected|failed to update ref/i.test(error.stderr);
}

function isDefiniteRemoteFailure(error) {
  return error instanceof GitCommandError
    && /authentication failed|permission denied|protected branch|remote rejected/i.test(error.stderr);
}

function sanitizeOperation(value) {
  return String(value).replace(/[\r\n]+/g, ' ').trim().slice(0, 120) || 'update state';
}

function operationRecordPath(operationId) {
  if (
    typeof operationId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(operationId)
  ) {
    throw new TypeError(`invalid operation id: ${operationId ?? '<missing>'}`);
  }
  return `operations/by-id/${operationId}.json`;
}

function validateRootSchema(snapshot) {
  try {
    assertStateDocument(snapshot.readJson('schema.json'));
  } catch (error) {
    if (error instanceof GitStoreError) throw error;
    throw new GitStoreError(`invalid coordination schema: ${error.message}`, {
      code: 'INVALID_STATE_SCHEMA',
      exitCode: 14,
      cause: error,
    });
  }
}

export class GitCoordinationStore {
  constructor({
    cwd,
    remote = 'origin',
    branch = 'coordination',
    maxRetries = 5,
    tempRoot = tmpdir(),
    staleTempAgeMs = 15 * 60 * 1000,
    clock = () => new Date(),
    // Test hook: runs after a successful push; throwing here exercises the
    // uncertain-push-result recovery path. Production code never sets it —
    // its exceptions are deliberately classified as an uncertain push.
    afterPush = () => {},
    // Off by default: a cached ref can hide another process's concurrent push
    // for up to the TTL, so only the CLI composition root opts in (10s). Write
    // safety is unaffected: update() refreshes on retry and pushes with
    // --force-with-lease.
    fetchTtlMs = 0,
    // I-131 (E6): a previously observed coordination SHA (the last command's
    // coordinationSha) short-circuits the first fetch. Write safety is
    // unaffected: update() pushes with --force-with-lease CAS and retries
    // with a fresh fetch when the reused sha is stale.
    reuseSha = null,
  }) {
    if (reuseSha !== null && !/^[0-9a-f]{40}$/.test(reuseSha)) {
      throw new GitStoreError(`invalid reuseSha (expected a full 40-hex commit SHA): ${reuseSha}`, {
        code: 'INVALID_REUSE_SHA',
        exitCode: 14,
      });
    }
    this.cwd = resolve(cwd);
    this.remote = remote;
    this.branch = branch;
    this.maxRetries = maxRetries;
    this.tempRoot = resolve(tempRoot);
    this.staleTempAgeMs = staleTempAgeMs;
    this.clock = clock;
    this.afterPush = afterPush;
    this.fetchTtlMs = fetchTtlMs;
    this.reuseSha = reuseSha;
    this.reuseShaConsumed = false;
    // Process-local caches (I-127): one CLI invocation often reads the same
    // ref several times (status/guard/lifecycle). The snapshot cache is keyed
    // by commit sha and always safe; the fetch cache only kicks in when the
    // caller opted into a non-zero fetchTtlMs.
    this.fetchCache = null;
    this.snapshotCache = new Map();
    mkdirSync(this.tempRoot, { recursive: true });
  }

  remoteTrackingRef() {
    return `refs/remotes/${this.remote}/${this.branch}`;
  }

  remoteBranchRef() {
    return `refs/heads/${this.branch}`;
  }

  fetchSha({ allowMissing = false, fresh = false } = {}) {
    // I-131 (E6): the first read reuses the caller-provided SHA instead of
    // fetching; it also seeds the fetch cache so same-process follow-up
    // reads stay consistent. Retries (fresh: true) always really fetch, and
    // initialize() (allowMissing: true) must always touch the remote to
    // decide whether the branch exists — a reuse sha never fakes that.
    if (!fresh && !allowMissing && this.reuseSha && !this.reuseShaConsumed) {
      this.reuseShaConsumed = true;
      this.fetchCache = { sha: this.reuseSha, at: this.clock().getTime() };
      return this.reuseSha;
    }
    if (
      !fresh
      && this.fetchCache
      && this.clock().getTime() - this.fetchCache.at < this.fetchTtlMs
    ) {
      return this.fetchCache.sha;
    }
    try {
      runGit(this.cwd, [
        'fetch',
        '--force',
        '--no-tags',
        this.remote,
        `+${this.remoteBranchRef()}:${this.remoteTrackingRef()}`,
      ]);
    } catch (error) {
      if (allowMissing && isMissingRemoteRef(error)) return null;
      throw new GitStoreError(`failed to fetch ${this.remote}/${this.branch}`, {
        code: 'REMOTE_ERROR',
        exitCode: 13,
        cause: error,
      });
    }
    const sha = runGit(this.cwd, ['rev-parse', this.remoteTrackingRef()]).trim();
    this.fetchCache = { sha, at: this.clock().getTime() };
    return sha;
  }

  loadSnapshot(sha) {
    let files = this.snapshotCache.get(sha);
    if (!files) {
      files = this.readSnapshotFiles(sha);
      // A CLI process handles a handful of distinct shas at most; keep the
      // cache bounded so a pathological loop cannot grow it without limit.
      if (this.snapshotCache.size >= 4) {
        this.snapshotCache.delete(this.snapshotCache.keys().next().value);
      }
      this.snapshotCache.set(sha, files);
    }
    // CoordinationSnapshot copies the file list, so cached entries stay
    // immutable even though callers mutate the returned snapshot.
    const snapshot = new CoordinationSnapshot({ sha, files });
    validateRootSchema(snapshot);
    return snapshot;
  }

  // Batch replacement for the previous per-file `git show` loop (I-127): one
  // `ls-tree` plus one `cat-file --batch` read the whole tree in two spawns
  // instead of thousands (~38s -> ~0.1s on a 3.4k-file branch).
  readSnapshotFiles(sha) {
    const tree = runGit(this.cwd, ['ls-tree', '-r', '-z', sha]);
    const entries = tree.split('\0').filter(Boolean).map((entry) => {
      const tab = entry.indexOf('\t');
      const [, type, objectSha] = entry.slice(0, tab).split(' ');
      return { type, objectSha, path: entry.slice(tab + 1) };
    });
    for (const entry of entries) {
      if (entry.type !== 'blob') {
        throw new GitStoreError(
          `unexpected ${entry.type} entry in coordination tree: ${entry.path}`,
          { code: 'INVALID_STATE_TREE', exitCode: 14 },
        );
      }
    }
    if (entries.length === 0) return [];
    const input = Buffer.from(`${entries.map((entry) => entry.objectSha).join('\n')}\n`, 'utf8');
    const output = runGitBuffer(this.cwd, ['cat-file', '--batch'], { input });
    const files = [];
    let offset = 0;
    for (const entry of entries) {
      const headerEnd = output.indexOf(0x0a, offset);
      const header = headerEnd === -1 ? '' : output.toString('utf8', offset, headerEnd);
      const [headerSha, headerType, sizeText] = header.split(' ');
      const size = Number(sizeText);
      if (
        headerSha !== entry.objectSha
        || headerType !== 'blob'
        || !Number.isSafeInteger(size)
        || headerEnd + 1 + size >= output.length
      ) {
        throw new GitStoreError(`corrupt batch response for coordination blob: ${entry.path}`, {
          code: 'INVALID_STATE_TREE',
          exitCode: 14,
        });
      }
      const start = headerEnd + 1;
      files.push([entry.path, output.toString('utf8', start, start + size)]);
      offset = start + size + 1; // each batch record ends with a newline
    }
    return files;
  }

  async readSnapshot() {
    const sha = this.fetchSha();
    return this.loadSnapshot(sha);
  }

  async initialize({ fromBacklog } = {}) {
    if (fromBacklog !== undefined && fromBacklog !== 'BACKLOG.md') {
      throw new TypeError('fromBacklog must be BACKLOG.md at the repository root');
    }
    const existingSha = this.fetchSha({ allowMissing: true });
    if (existingSha) {
      this.loadSnapshot(existingSha);
      return { created: false, sha: existingSha };
    }

    const tempPath = mkdtempSync(join(this.tempRoot, `${TEMP_PREFIX}init-`));
    try {
      runGit(tempPath, ['init', `--initial-branch=${this.branch}`, '.']);
      runGit(tempPath, ['config', 'user.name', 'Luggage Coordination']);
      runGit(tempPath, ['config', 'user.email', 'coordination@local.invalid']);
      const remoteUrl = runGit(this.cwd, ['remote', 'get-url', this.remote]).trim();
      runGit(tempPath, ['remote', 'add', this.remote, remoteUrl]);

      const snapshot = new CoordinationSnapshot({ sha: null, files: [] });
      snapshot.writeJson('schema.json', {
        schemaVersion: 2,
        initializedAt: this.clock().toISOString(),
      });
      if (fromBacklog) {
        snapshot.writeText(
          'baseline/BACKLOG.md',
          runGit(this.cwd, ['show', 'HEAD:BACKLOG.md']),
        );
      }
      this.materializeSnapshot(tempPath, snapshot);
      runGit(tempPath, ['add', '-A']);
      runGit(tempPath, ['commit', '-m', 'coord: initialize coordination state']);
      const sha = runGit(tempPath, ['rev-parse', 'HEAD']).trim();
      try {
        runGit(tempPath, [
          'push',
          // I-130 (D5): see update() — coordination pushes never run hooks.
          '--no-verify',
          `--force-with-lease=${this.remoteBranchRef()}:`,
          this.remote,
          `HEAD:${this.remoteBranchRef()}`,
        ]);
      } catch (error) {
        if (isStalePush(error)) {
          const winnerSha = this.fetchSha();
          return { created: false, sha: winnerSha };
        }
        throw error;
      }
      return { created: true, sha };
    } catch (error) {
      if (error instanceof GitStoreError) throw error;
      throw new GitStoreError(`failed to initialize ${this.remote}/${this.branch}`, {
        code: 'REMOTE_ERROR',
        exitCode: 13,
        cause: error,
      });
    } finally {
      rmSync(tempPath, { recursive: true, force: true });
    }
  }

  materializeSnapshot(root, snapshot) {
    for (const path of snapshot.changedPaths) {
      const target = join(root, path);
      if (!snapshot.files.has(path)) {
        if (existsSync(target)) unlinkSync(target);
        continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, snapshot.files.get(path));
    }
  }

  cleanupWorktree(tempPath) {
    try {
      runGit(this.cwd, ['worktree', 'remove', '--force', tempPath]);
    } catch {
      rmSync(tempPath, { recursive: true, force: true });
      try {
        runGit(this.cwd, ['worktree', 'prune']);
      } catch {
        // The original operation error is more useful than cleanup failure.
      }
    }
  }

  async update({ operation, operationId = randomUUID(), auditData = {}, mutate }) {
    if (typeof mutate !== 'function') {
      throw new TypeError('update requires a mutate function');
    }
    if (auditData === null || typeof auditData !== 'object' || Array.isArray(auditData)) {
      throw new TypeError('update auditData must be an object');
    }
    const auditPath = operationRecordPath(operationId);

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      // Retries must observe the ref that just rejected our push, not the
      // process-local TTL cache.
      const expectedSha = this.fetchSha({ fresh: attempt > 0 });
      const snapshot = this.loadSnapshot(expectedSha);
      await mutate(snapshot);
      validateRootSchema(snapshot);
      if (!snapshot.hasChanges()) {
        return {
          sha: expectedSha,
          operationId,
          attempts: attempt + 1,
          recovered: false,
          changed: false,
        };
      }

      const auditRecord = {
        schemaVersion: 1,
        operationId,
        operation: sanitizeOperation(operation),
        createdAt: this.clock().toISOString(),
        ...(Object.keys(auditData).length > 0 ? { metadata: auditData } : {}),
      };
      snapshot.writeJson(auditPath, auditRecord);
      snapshot.writeJson('operations/last.json', auditRecord);

      const tempPath = mkdtempSync(join(this.tempRoot, `${TEMP_PREFIX}update-`));
      let newSha;
      try {
        runGit(this.cwd, ['worktree', 'add', '--detach', tempPath, expectedSha]);
        this.materializeSnapshot(tempPath, snapshot);
        runGit(tempPath, ['add', '-A']);
        runGit(tempPath, [
          '-c',
          'user.name=Luggage Coordination',
          '-c',
          'user.email=coordination@local.invalid',
          'commit',
          '-m',
          `coord: ${sanitizeOperation(operation)} [${operationId}]`,
        ]);
        newSha = runGit(tempPath, ['rev-parse', 'HEAD']).trim();

        try {
          runGit(tempPath, [
            'push',
            // I-130 (D5): the local pre-push hook runs the product CI, which
            // cannot pass in this temp worktree (no package.json) and must
            // never gate the machine-state coordination branch.
            '--no-verify',
            `--force-with-lease=${this.remoteBranchRef()}:${expectedSha}`,
            this.remote,
            `HEAD:${this.remoteBranchRef()}`,
          ]);
          // The remote ref now points at newSha; keep the process-local cache
          // truthful so follow-up reads in this process stay consistent.
          this.fetchCache = { sha: newSha, at: this.clock().getTime() };
          await this.afterPush({ operationId, expectedSha, newSha });
        } catch (error) {
          if (isStalePush(error)) {
            if (attempt < this.maxRetries) {
              // I-128 (L13): jittered backoff so concurrent writers do not
              // retry in lockstep and collide again on the same ref.
              const delay = Math.min(250 * 2 ** attempt, 4000)
                + Math.floor(Math.random() * 250);
              await new Promise((resolve) => { setTimeout(resolve, delay); });
              continue;
            }
            throw new GitStoreError('coordination ref changed during update', {
              code: 'STALE_COORDINATION_REF',
              exitCode: 11,
              cause: error,
              data: { expectedSha },
            });
          }
          if (isDefiniteRemoteFailure(error)) {
            throw new GitStoreError('coordination push was rejected', {
              code: 'REMOTE_ERROR',
              exitCode: 13,
              cause: error,
            });
          }
          const reconciliation = await this.reconcileOperation(operationId).catch(() => null);
          if (reconciliation?.applied) {
            return {
              sha: reconciliation.sha,
              operationId,
              attempts: attempt + 1,
              recovered: true,
              changed: true,
            };
          }
          throw new GitStoreError('coordination push result is uncertain; reconcile before continuing', {
            code: 'UNCERTAIN_PUSH_RESULT',
            exitCode: 15,
            cause: error,
            data: { operationId },
          });
        }

        return {
          sha: newSha,
          operationId,
          attempts: attempt + 1,
          recovered: false,
          changed: true,
        };
      } finally {
        this.cleanupWorktree(tempPath);
      }
    }

    throw new GitStoreError('coordination update exhausted retries', {
      code: 'STALE_COORDINATION_REF',
      exitCode: 11,
    });
  }

  async reconcileOperation(operationId) {
    const snapshot = await this.readSnapshot();
    const auditPath = operationRecordPath(operationId);
    if (!snapshot.has(auditPath)) {
      return { applied: false, sha: snapshot.sha };
    }
    const operation = snapshot.readJson(auditPath);
    return {
      applied: operation.operationId === operationId,
      sha: snapshot.sha,
      operation,
    };
  }

  async doctor() {
    const removed = [];
    const now = this.clock().getTime();
    for (const name of readdirSync(this.tempRoot).sort()) {
      if (!name.startsWith(TEMP_PREFIX)) continue;
      const path = join(this.tempRoot, name);
      if (now - statSync(path).mtimeMs < this.staleTempAgeMs) continue;
      this.cleanupWorktree(path);
      rmSync(path, { recursive: true, force: true });
      removed.push(name);
    }
    return { removed };
  }
}
