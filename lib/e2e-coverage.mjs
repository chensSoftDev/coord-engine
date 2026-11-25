import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gitCommonDir } from './coordination/worktrees.mjs';

export class E2eCoverageError extends Error {
  constructor(message, code, data = {}) {
    super(message); this.name = 'E2eCoverageError'; this.code = code; this.exitCode = 1; this.data = data;
  }
}
const fail = (message, code, data) => { throw new E2eCoverageError(message, code, data); };
const sha256 = value => createHash('sha256').update(value).digest('hex');
const text = value => typeof value === 'string' && value.trim().length > 0 && !/[\r\n\0]/.test(value);
const safePath = value => text(value) && !isAbsolute(value) && !value.includes('\\') && !value.split('/').some(part => ['.', '..', ''].includes(part));
function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) fail('cannot inspect committed E2E inputs', 'E2E_SOURCE_UNAVAILABLE');
  return result.stdout;
}
function assertCommitted(cwd, path) {
  const file = join(cwd, path);
  if (!existsSync(file) || !lstatSync(file).isFile() || realpathSync(file) !== join(realpathSync(cwd), path)
    || !/^100(?:644|755) blob /.test(git(cwd, ['ls-tree', 'HEAD', '--', path]))
    || git(cwd, ['status', '--porcelain=v1', '--untracked-files=all', '--', path]).trim()
    || !readFileSync(file).equals(Buffer.from(git(cwd, ['show', `HEAD:${path}`])))) {
    fail(`commit the regular E2E input before verification: ${path}`, 'E2E_EXPECTATIONS_UNCOMMITTED', { path });
  }
}
const testKey = value => JSON.stringify([value.file, value.title, value.project]);

export function loadE2eExpectations({ cwd, requirementId, app, mode, required = false }) {
  if (!requirementId) {
    if (required) fail('formal E2E coverage requires REQUIREMENT_ID', 'E2E_EXPECTATIONS_REQUIRED');
    return null;
  }
  if (!/^(I|F|B)-\d{3,}$/.test(requirementId)) fail('invalid E2E requirement ID', 'E2E_EXPECTATIONS_INVALID');
  const root = join(cwd, 'docs/product/current');
  const directories = existsSync(root) ? readdirSync(root).filter(name => name.startsWith(`${requirementId}-`)) : [];
  const committed = git(cwd, ['ls-tree', '-r', '--name-only', 'HEAD', '--', 'docs/product/current']).split('\n')
    .filter(path => new RegExp(`^docs/product/current/${requirementId}-[^/]+/E2E_EXPECTATIONS\\.json$`).test(path));
  const candidates = [...new Set([...committed,
    ...directories.map(name => `docs/product/current/${name}/E2E_EXPECTATIONS.json`).filter(path => existsSync(join(cwd, path)))])];
  if (!candidates.length) {
    if (required) fail(`record E2E_EXPECTATIONS.json for ${requirementId} before formal E2E`, 'E2E_EXPECTATIONS_REQUIRED');
    return null;
  }
  if (candidates.length !== 1) fail('E2E expectation document is ambiguous', 'E2E_EXPECTATIONS_INVALID');
  const path = candidates[0];
  assertCommitted(cwd, path);
  const source = git(cwd, ['show', `HEAD:${path}`]);
  let document;
  try { document = JSON.parse(source); } catch { fail('invalid E2E expectation JSON', 'E2E_EXPECTATIONS_INVALID'); }
  const invalid = () => fail('E2E expectations require unique app/mode scopes and stable case id/file/title/project identities', 'E2E_EXPECTATIONS_INVALID');
  if (document?.schemaVersion !== 1 || document.requirementId !== requirementId || !Array.isArray(document.runs) || !document.runs.length) invalid();
  const scopes = new Set();
  for (const run of document.runs) {
    const scope = `${run?.app}/${run?.mode}`;
    if (!['web', 'admin'].includes(run?.app) || !['shared-dev', 'mixed-dev', 'local'].includes(run?.mode)
      || scopes.has(scope) || !Array.isArray(run.cases) || !run.cases.length) invalid();
    scopes.add(scope);
    const ids = new Set(), keys = new Set();
    for (const item of run.cases) {
      if (!/^[A-Za-z][A-Za-z0-9_-]{1,95}$/.test(item?.id ?? '') || ids.has(item.id) || !safePath(item.file)
        || !item.file.startsWith(`apps/${run.app}/`) || !text(item.title) || !text(item.project) || keys.has(testKey(item))) invalid();
      ids.add(item.id); keys.add(testKey(item));
    }
  }
  const run = document.runs.find(item => item.app === app && item.mode === mode);
  if (!run) fail(`declare expected ${app}/${mode} E2E cases before running this scope`, 'E2E_EXPECTATIONS_SCOPE_MISSING', { app, mode });
  for (const item of run.cases) assertCommitted(cwd, item.file);
  return { schemaVersion: 1, requirementId, app, mode, path, sha256: sha256(source), commit: git(cwd, ['rev-parse', 'HEAD']).trim(), cases: run.cases };
}

export function assertE2eExecutionOptions({ extraArgs = [], skipUp, dryRun, help, destroy } = {}) {
  const forbidden = new Set(['--list', '--pass-with-no-tests', '--help', '-h', '--version', '-V', '--ui', '--ui-host', '--ui-port', '--debug', '--reporter']);
  const option = extraArgs.find(arg => forbidden.has(arg.split('=')[0]));
  if (skipUp || dryRun || help || destroy || option) {
    fail(`formal E2E must execute expected tests; diagnostic or reporter override option is forbidden: ${option ?? (skipUp ? '--skip-up' : dryRun ? '--dry-run' : help ? '--help' : '--destroy')}`,
      'E2E_NON_EXECUTING_OPTION');
  }
}

function reportTests({ cwd, report }) {
  if (!report || !Array.isArray(report.suites) || !Array.isArray(report.errors) || report.errors.length || !text(report.config?.rootDir)) {
    fail('Playwright JSON report is absent, invalid or contains collection/runtime errors', 'E2E_REPORT_INVALID');
  }
  const root = realpathSync(cwd);
  const reportRoot = report.config.rootDir;
  try { realpathSync(reportRoot); } catch { fail('Playwright report root does not exist', 'E2E_REPORT_INVALID'); }
  const result = [];
  const visit = (suites, titles = [], fileLevel = false) => {
    for (const suite of suites) {
      if (!Array.isArray(suite.specs) || (suite.suites && !Array.isArray(suite.suites))) fail('invalid Playwright suite report', 'E2E_REPORT_INVALID');
      const ancestors = fileLevel ? titles : [...titles, suite.title];
      for (const spec of suite.specs) {
        if (!text(spec.file) || !text(spec.title) || !Array.isArray(spec.tests)) fail('invalid Playwright spec report', 'E2E_REPORT_INVALID');
        let absoluteFile;
        try { absoluteFile = realpathSync(resolve(reportRoot, spec.file)); } catch { fail('Playwright report test file does not exist', 'E2E_REPORT_INVALID'); }
        const file = relative(root, absoluteFile).split(sep).join('/');
        if (!safePath(file)) fail('Playwright report references a test outside the repository', 'E2E_REPORT_INVALID');
        for (const test of spec.tests) result.push({ file, title: [...ancestors, spec.title].join(' › '), project: test.projectName,
          playwrightId: spec.id, test });
      }
      visit(suite.suites ?? [], ancestors);
    }
  };
  visit(report.suites, [], true);
  return result;
}
function expectedTests({ cwd, contract, report, execution }) {
  const observed = reportTests({ cwd, report });
  return contract.cases.map(expected => {
    const matches = observed.filter(actual => testKey(actual) === testKey(expected));
    const test = matches.length === 1 ? matches[0].test : null;
    if (!test || test.expectedStatus !== 'passed') {
      fail(`expected E2E case ${expected.id} is absent, ambiguous, skipped or marked as expected failure`, execution ? 'E2E_EXPECTED_CASE_NOT_PASSED' : 'E2E_EXPECTED_CASE_NOT_SELECTED', { caseId: expected.id });
    }
    return { expected, observed: matches[0], test };
  });
}
export function assertE2eSelection(args) {
  return expectedTests({ ...args, execution: false }).map(({ expected, observed }) => ({ ...expected, playwrightId: observed.playwrightId }));
}
export function assertE2eResults(args) {
  return expectedTests({ ...args, execution: true }).map(({ expected, observed, test }) => {
    if (!Array.isArray(test.results) || !test.results.length || test.results.at(-1).status !== 'passed' || !['expected', 'flaky'].includes(test.status)) {
      fail(`expected E2E case ${expected.id} did not execute and pass`, 'E2E_EXPECTED_CASE_NOT_PASSED', { caseId: expected.id });
    }
    args.onPassedCase?.({ caseId: expected.id, result: test.results.at(-1) });
    return { ...expected, playwrightId: observed.playwrightId, status: test.status === 'flaky' ? 'flaky' : 'passed',
      attempts: test.results.map(result => ({ status: result.status, retry: result.retry, duration: result.duration, startTime: result.startTime })) };
  });
}
function readReport(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { fail('Playwright did not produce a fresh valid JSON report', 'E2E_REPORT_INVALID', { path }); }
}
function defaultRunner({ cwd, command, env }) {
  return spawnSync(command[0], command.slice(1), { cwd, env, stdio: 'inherit' });
}

export async function runE2eWithCoverage({ cwd, contract, command, env = process.env, runner = defaultRunner, clock = () => new Date() }) {
  assertE2eExecutionOptions({ extraArgs: command });
  const current = () => {
    const latest = loadE2eExpectations({ cwd, ...contract, required: true });
    if (latest.commit !== contract.commit || latest.sha256 !== contract.sha256) fail('E2E source or expectations changed during verification', 'E2E_INPUTS_CHANGED');
  };
  current();
  const directory = join(gitCommonDir(cwd), 'coordination/e2e-reports', contract.requirementId, randomUUID());
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const selectionPath = join(directory, 'selection.json'), executionPath = join(directory, 'execution.json'), reportPath = join(directory, 'coverage.json');
  const receipt = { schemaVersion: 1, requirementId: contract.requirementId, app: contract.app, mode: contract.mode,
    commit: contract.commit, expectations: { path: contract.path, sha256: contract.sha256 }, startedAt: clock().toISOString(), reportPath };
  try {
    const listing = await runner({ cwd, command: [...command, '--list', '--reporter=json'],
      env: { ...env, PLAYWRIGHT_JSON_OUTPUT_FILE: selectionPath } });
    if (listing?.error || listing?.status !== 0) fail('Playwright listing failed before test execution', 'E2E_LIST_FAILED');
    receipt.selection = assertE2eSelection({ cwd, contract, report: readReport(selectionPath) });
    receipt.selectionReport = { path: selectionPath, sha256: sha256(readFileSync(selectionPath)) };
    current();
    const execution = await runner({ cwd, command: [...command, '--reporter=line,json'],
      env: { ...env, PLAYWRIGHT_JSON_OUTPUT_FILE: executionPath } });
    receipt.cases = assertE2eResults({ cwd, contract, report: readReport(executionPath) });
    receipt.executionReport = { path: executionPath, sha256: sha256(readFileSync(executionPath)) };
    if (execution?.error || execution?.status !== 0) fail('Playwright execution failed', 'E2E_EXECUTION_FAILED');
    current();
    receipt.outcome = receipt.cases.some(item => item.status === 'flaky') ? 'flaky' : 'passed';
    return receipt;
  } catch (error) {
    receipt.outcome = 'failed'; receipt.error = { code: error.code ?? 'E2E_EXECUTION_FAILED', message: error.message };
    throw error;
  } finally {
    receipt.completedAt = clock().toISOString();
    writeFileSync(reportPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  }
}
