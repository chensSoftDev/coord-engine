import { spawnSync } from 'node:child_process';
import { delimiter } from 'node:path';

// Git (and platform launchers such as macOS xcrun) adds compiler/search inputs
// before invoking hooks. Probe that real environment for every local entrypoint
// so both the receipt and the executed command describe the same inputs.
export function gitExecutionEnvironment({ cwd, env = process.env }) {
  const input = { ...env, GIT_TERMINAL_PROMPT: '0' };
  let effective;
  let localNames;
  try {
    const local = spawnSync('git', ['rev-parse', '--local-env-vars'], {
      cwd, env: input, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
    });
    if (local.error || local.status !== 0) throw new Error();
    localNames = local.stdout.trim().split('\n');
    if (localNames.some(name => !/^GIT_[A-Z0-9_]+$/.test(name))
      || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_CONFIG_PARAMETERS']
        .some(name => !localNames.includes(name))) throw new Error();
    // The shell fragment is fixed. Node's executable and program are separate
    // argv entries; no caller paths or environment values become shell source.
    const result = spawnSync('git', [
      '-c', 'alias.luggage-verification-environment=!f() { exec "$@"; }; f',
      'luggage-verification-environment', process.execPath,
      '-e', 'process.stdout.write(JSON.stringify(process.env))',
    ], { cwd, env: input, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error();
    effective = JSON.parse(result.stdout);
    if (!effective || typeof effective !== 'object' || Array.isArray(effective)
      || Object.values(effective).some(value => typeof value !== 'string')
      || typeof effective.PATH !== 'string' || typeof effective.GIT_EXEC_PATH !== 'string'
      || effective.GIT_TERMINAL_PROMPT !== '0') throw new Error();
  } catch {
    // Neither subprocess output nor JSON parse errors may expose environment
    // values. A failed probe cannot authorize a receipt or a different runner.
    throw Object.assign(new Error('Unable to determine the Git execution environment'), {
      code: 'VERIFICATION_ENVIRONMENT_UNAVAILABLE', exitCode: 14,
    });
  }
  // In a linked worktree Git exports GIT_DIR for its shell alias. Passing that
  // to checks would redirect their nested repositories back to this worktree.
  // Undo only probe changes to Git-local variables, retaining all original
  // caller configuration and repository inputs byte for byte.
  for (const name of localNames) {
    if (input[name] !== undefined) effective[name] = String(input[name]);
    else delete effective[name];
  }
  // Hooks may provide an empty prefix while direct callers omit it. Both
  // describe this same cwd; a caller's nonempty prefix remains an input.
  effective.GIT_PREFIX = input.GIT_PREFIX === undefined ? '' : String(input.GIT_PREFIX);
  // Every Git invocation prepends its exec directory. Keep that first lookup
  // and remove identical later copies; all other PATH order and duplicates
  // remain meaningful inputs and are passed unchanged to the actual command.
  const paths = effective.PATH.split(delimiter);
  if (paths[0] === effective.GIT_EXEC_PATH) {
    effective.PATH = [paths[0], ...paths.slice(1).filter(path => path !== paths[0])].join(delimiter);
  }
  return effective;
}
