import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPOSITORY_LOCATORS = Object.freeze(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_CONFIG',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_GRAFT_FILE',
  'GIT_SHALLOW_FILE', 'GIT_NAMESPACE', 'GIT_QUARANTINE_PATH', 'GIT_IMPLICIT_WORK_TREE']);

export function assertIsolatedGitEnvironment(env = process.env) {
  const keys = REPOSITORY_LOCATORS.filter(key => env[key] !== undefined);
  if (keys.length) throw Object.assign(new Error(`Coordination tests refused repository locator variables: ${keys.join(', ')}`), {
    code: 'UNSAFE_FIXTURE_GIT_ENVIRONMENT', exitCode: 14,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { assertIsolatedGitEnvironment(); }
  catch (error) {
    process.stderr.write(`${error.code}: ${error.message}\n`);
    process.exitCode = error.exitCode;
  }
}
