export interface PlaywrightGuardCacheEntry {
  required: boolean;
  message: string;
  expiresAtMs: number | null;
}

export interface PlaywrightGuardRunnerResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export function guardPlaywrightTarget(options: {
  target: string;
  requirementId?: string;
  env?: NodeJS.ProcessEnv;
  rootDir?: string;
  cache?: Map<string, PlaywrightGuardCacheEntry>;
  clock?: () => Date;
  runner?: (input: {
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
  }) => PlaywrightGuardRunnerResult;
  resolveRevision?: (input: { cwd: string }) => { branch: string; commit: string } | null;
}): void;
