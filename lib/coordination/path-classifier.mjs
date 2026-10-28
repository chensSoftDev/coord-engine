// 统一 changed-path 分类器（I-113）：输出受影响服务、阻塞/异步检查、
// candidate runtime paths、风险标签、docs-only 与未知路径。
// 所有数组确定性排序；未知路径保守 fail closed（不跳过任何阻塞检查）。

const SERVICE_BY_PREFIX = [
  ['apps/account-api/', 'account'],
  ['apps/admin/', 'admin'],
  ['apps/api/', 'api'],
  ['apps/gateway-api/', 'gateway'],
  ['apps/web/', 'web'],
];
const ALL_SERVICES = SERVICE_BY_PREFIX.map(([, service]) => service).sort();

const COORDINATION_PREFIXES = [
  // I-249: 引擎以 .coord-engine submodule 挂载后，整个子模块都属于协调基建。
  '.coord-engine/',
  'docs/product/',
  'docs/releases/',
  'scripts/lib/coordination/',
  'scripts/test/coordination/',
];

const RELEASE_SCRIPT_PATTERN = /^scripts\/(?:deploy-config|deploy|rollback|release|release-dev|release-dev-frontend|release-prod|release-rollback|smoke|merge-pr|preflight|local-ci|validate-release-manifest)\.sh$/;
const RELEASE_EXTRA_PATTERNS = [
  /^scripts\/lib\/release-.*\.sh$/,
  /^scripts\/test-release-.*\.sh$/,
  /^scripts\/test-backend-dockerfiles\.sh$/,
];
const MIGRATION_PATH_PATTERNS = [
  /^apps\/(?:api|account-api)\/src\/database\//,
  /^scripts\/(?:init-db|migration-preflight)\.sh$/,
  /^scripts\/run-.*\.sh$/,
  /^deploy\/mysql[^/]*\.env/,
];
const SHARED_MANIFEST_PATHS = new Set(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']);

function serviceFor(path) {
  for (const [prefix, service] of SERVICE_BY_PREFIX) {
    if (path.startsWith(prefix)) return service;
  }
  return null;
}

// I-243 review: these top-level scripts only build the coordination/CI gate.
// Unlike an arbitrary unknown path they cannot affect a runtime service, so
// they must not trigger the unknown-path fail-closed all-services rule when a
// release diff includes their changes.
function isCoordinationPath(path) {
  return path === 'BACKLOG.md'
    || path === 'scripts/check-admin-ui-spec.mjs'
    || path === 'scripts/classify-changed-paths.mjs'
    || path === 'scripts/coordination.mjs'
    || path === 'scripts/lib/e2e-targets.mjs'
    || path === 'scripts/local-e2e.mjs'
    || path === 'scripts/mixed-frontend.mjs'
    || COORDINATION_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function isReleaseToolingPath(path) {
  return path.startsWith('deploy/')
    || path === 'scripts/validate-mixed-release.mjs'
    || RELEASE_SCRIPT_PATTERN.test(path)
    || RELEASE_EXTRA_PATTERNS.some((pattern) => pattern.test(path));
}

function isMigrationPath(path) {
  return MIGRATION_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

function isContainerBuildPath(path) {
  return path === '.dockerignore'
    || /^docker-compose(?:[.-][^/]*)?\.yml$/.test(path)
    || /(^|\/)Dockerfile(?:\.|$)/.test(path);
}

function isDocsPath(path) {
  return path.startsWith('docs/')
    || /^[^/]+\.md$/.test(path);
}

// B-161：agent 工具/技能目录（gitlink 或普通文件）只面向 AI 助手，不影响任何
// 运行时服务；按 docs 口径计入 docs-closure，不再落入 unknown-path fail closed
// 导致版本列车被强制要求全服务发布。
const AGENT_TOOLING_PATH_PATTERN = /^(?:\.agents|\.ai|\.claude|\.shared-skills|\.superpowers|\.vscode)(?:\/|$)/;

function isAgentToolingPath(path) {
  return AGENT_TOOLING_PATH_PATTERN.test(path);
}

export function classifyChangedPaths(paths, { prototypeOnlyLockfile = false } = {}) {
  const list = Array.isArray(paths) ? paths : [];
  const services = new Set();
  const blockingChecks = new Set();
  const riskTags = new Set();
  const runtimePaths = new Set();
  const unknownPaths = new Set();
  let docsPaths = 0;

  const requireAllServices = () => {
    for (const service of ALL_SERVICES) {
      services.add(service);
      blockingChecks.add(`service:${service}`);
    }
  };

  for (const entry of list) {
    const path = String(entry);
    let matched = false;

    // I-243 review: a proven prototype-only lockfile change may skip service
    // coverage (its importer is the UX prototype), but it stays a dependency
    // lockfile change for risk reporting and the security audit.
    if (path.startsWith('apps/ux-prototype/')) {
      docsPaths += 1;
      blockingChecks.add('docs-closure');
      continue;
    }
    if (path === 'pnpm-lock.yaml' && prototypeOnlyLockfile) {
      docsPaths += 1;
      blockingChecks.add('docs-closure');
      riskTags.add('dependency-lockfile');
      continue;
    }

    const service = serviceFor(path);
    if (service) {
      matched = true;
      services.add(service);
      blockingChecks.add(`service:${service}`);
      runtimePaths.add(path);
    }
    if (isMigrationPath(path)) {
      matched = true;
      blockingChecks.add('migration-check');
      riskTags.add('database-migration');
    }
    if (isCoordinationPath(path)) {
      matched = true;
      blockingChecks.add('coordination-gate');
    }
    if (isReleaseToolingPath(path)) {
      matched = true;
      blockingChecks.add('release-contracts');
      // deploy/** 是部署运行时输入；release 脚本本身不进入 candidate 指纹。
      if (path.startsWith('deploy/')) runtimePaths.add(path);
    }
    if (path.startsWith('.github/workflows/')) {
      matched = true;
      blockingChecks.add('release-contracts');
      riskTags.add('ci-workflow');
    }
    if (SHARED_MANIFEST_PATHS.has(path)) {
      matched = true;
      requireAllServices();
      riskTags.add(path === 'pnpm-lock.yaml' ? 'dependency-lockfile' : 'dependency-manifest');
      runtimePaths.add(path);
    }
    if (isContainerBuildPath(path)) {
      matched = true;
      requireAllServices();
      blockingChecks.add('release-contracts');
      riskTags.add('container-build');
      runtimePaths.add(path);
    }
    if (isDocsPath(path)) {
      matched = true;
      docsPaths += 1;
      blockingChecks.add('docs-closure');
    }
    if (isAgentToolingPath(path)) {
      matched = true;
      docsPaths += 1;
      blockingChecks.add('docs-closure');
    }

    if (!matched) unknownPaths.add(path);
  }

  // 未知路径无法证明任何检查可跳过：保守 fail closed。
  if (unknownPaths.size > 0) {
    riskTags.add('unknown-path');
    requireAllServices();
    for (const check of ['coordination-gate', 'docs-closure', 'migration-check', 'release-contracts']) {
      blockingChecks.add(check);
    }
  }

  const asyncChecks = new Set();
  if (
    services.size > 0
    || riskTags.has('ci-workflow')
    || riskTags.has('unknown-path')
  ) {
    asyncChecks.add('full-regression');
  }
  if (riskTags.has('dependency-lockfile') || riskTags.has('dependency-manifest')) {
    asyncChecks.add('security-audit');
  }

  return {
    affectedServices: [...services].sort(),
    blockingChecks: [...blockingChecks].sort(),
    asyncChecks: [...asyncChecks].sort(),
    candidateRuntimePaths: [...runtimePaths].sort(),
    riskTags: [...riskTags].sort(),
    docsOnly: list.length > 0 && docsPaths === list.length,
    unknownPaths: [...unknownPaths].sort(),
  };
}
