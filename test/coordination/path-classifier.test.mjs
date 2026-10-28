import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyChangedPaths } from '../../lib/coordination/path-classifier.mjs';

const ALL_SERVICES = ['account', 'admin', 'api', 'gateway', 'web'];
const ALL_SERVICE_CHECKS = ALL_SERVICES.map((service) => `service:${service}`);
const FAIL_CLOSED_CHECKS = [
  'coordination-gate',
  'docs-closure',
  'migration-check',
  'release-contracts',
  ...ALL_SERVICE_CHECKS,
].sort();

// 稳定 JSON 契约：changed paths → 受影响服务 / 阻塞与异步检查 / candidate runtime paths /
// 风险标签 / docs-only / 未知路径。所有数组确定性排序；未知路径保守 fail closed。
const CASES = [
  {
    name: 'empty change set runs nothing',
    paths: [],
    expected: {
      affectedServices: [],
      blockingChecks: [],
      asyncChecks: [],
      candidateRuntimePaths: [],
      riskTags: [],
      docsOnly: false,
      unknownPaths: [],
    },
  },
  {
    name: 'web only',
    paths: ['apps/web/app/page.tsx'],
    expected: {
      affectedServices: ['web'],
      blockingChecks: ['service:web'],
      asyncChecks: ['full-regression'],
      candidateRuntimePaths: ['apps/web/app/page.tsx'],
      riskTags: [],
      docsOnly: false,
      unknownPaths: [],
    },
  },
  {
    name: 'admin only',
    paths: ['apps/admin/src/pages/index.tsx'],
    expected: {
      affectedServices: ['admin'],
      blockingChecks: ['service:admin'],
      asyncChecks: ['full-regression'],
      candidateRuntimePaths: ['apps/admin/src/pages/index.tsx'],
      riskTags: [],
      docsOnly: false,
      unknownPaths: [],
    },
  },
  {
    name: 'account-api only',
    paths: ['apps/account-api/src/main.ts'],
    expected: {
      affectedServices: ['account'],
      blockingChecks: ['service:account'],
      asyncChecks: ['full-regression'],
      candidateRuntimePaths: ['apps/account-api/src/main.ts'],
      riskTags: [],
      docsOnly: false,
      unknownPaths: [],
    },
  },
  {
    name: 'api only, not confused with account-api',
    paths: ['apps/api/src/main.ts'],
    expected: {
      affectedServices: ['api'],
      blockingChecks: ['service:api'],
      asyncChecks: ['full-regression'],
      candidateRuntimePaths: ['apps/api/src/main.ts'],
      riskTags: [],
      docsOnly: false,
      unknownPaths: [],
    },
  },
  {
    name: 'gateway-api only',
    paths: ['apps/gateway-api/src/main.ts'],
    expected: {
      affectedServices: ['gateway'],
      blockingChecks: ['service:gateway'],
      asyncChecks: ['full-regression'],
      candidateRuntimePaths: ['apps/gateway-api/src/main.ts'],
      riskTags: [],
      docsOnly: false,
      unknownPaths: [],
    },
  },
  {
    name: 'api migration adds migration check and risk tag',
    paths: ['apps/api/src/database/migrations/1750000000000-AddTable.ts'],
    expected: {
      affectedServices: ['api'],
      blockingChecks: ['migration-check', 'service:api'],
      asyncChecks: ['full-regression'],
      candidateRuntimePaths: ['apps/api/src/database/migrations/1750000000000-AddTable.ts'],
      riskTags: ['database-migration'],
      docsOnly: false,
      unknownPaths: [],
    },
  },
  {
    name: 'database ops scripts require migration check without services',
    paths: ['scripts/init-db.sh', 'scripts/run-api-migrations-docker.sh'],
    expected: {
      affectedServices: [],
      blockingChecks: ['migration-check'],
      asyncChecks: [],
      candidateRuntimePaths: [],
      riskTags: ['database-migration'],
      docsOnly: false,
      unknownPaths: [],
    },
  },
  {
    name: 'coordination modules and tests gate only on coordination',
    paths: [
      'scripts/coordination.mjs',
      'scripts/classify-changed-paths.mjs',
      'scripts/lib/coordination/gate.mjs',
      'scripts/test/coordination/gate.test.mjs',
      // I-249: 引擎以 .coord-engine submodule 挂载，子模块内全部是协调基建。
      '.coord-engine/lib/coordination/gate.mjs',
      '.coord-engine/test/coordination/gate.test.mjs',
    ],
    expected: {
      affectedServices: [],
      blockingChecks: ['coordination-gate'],
      asyncChecks: [],
      candidateRuntimePaths: [],
      riskTags: [],
      docsOnly: false,
      unknownPaths: [],
    },
  },
  {
    name: 'backlog and requirement/release docs are docs-only coordination closure',
    paths: ['BACKLOG.md', 'docs/releases/PENDING/MIGRATION-I-113.md'],
    expected: {
      affectedServices: [],
      blockingChecks: ['coordination-gate', 'docs-closure'],
      asyncChecks: [],
      candidateRuntimePaths: [],
      riskTags: [],
      docsOnly: true,
      unknownPaths: [],
    },
  },
  {
    name: 'admin UI spec checker runs as coordination gate',
    paths: ['scripts/check-admin-ui-spec.mjs'],
    expected: {
      affectedServices: [],
      blockingChecks: ['coordination-gate'],
      asyncChecks: [],
      candidateRuntimePaths: [],
      riskTags: [],
      docsOnly: false,
      unknownPaths: [],
    },
  },
  {
    name: 'release tooling scripts run release contracts only',
    paths: [
      'scripts/release.sh',
      'scripts/local-ci.sh',
      'scripts/lib/release-common.sh',
      'scripts/test-release-flow.sh',
      'scripts/merge-pr.sh',
    ],
    expected: {
      affectedServices: [],
      blockingChecks: ['release-contracts'],
      asyncChecks: [],
      candidateRuntimePaths: [],
      riskTags: [],
      docsOnly: false,
      unknownPaths: [],
    },
  },
  {
    name: 'deploy env and manifests are release runtime inputs',
    paths: ['deploy/release-manifests/v0.9.1.env', 'deploy/api.env.example'],
    expected: {
      affectedServices: [],
      blockingChecks: ['release-contracts'],
      asyncChecks: [],
      candidateRuntimePaths: ['deploy/api.env.example', 'deploy/release-manifests/v0.9.1.env'],
      riskTags: [],
      docsOnly: false,
      unknownPaths: [],
    },
  },
  {
    name: 'workflow changes are high risk and run release contracts',
    paths: ['.github/workflows/ci.yml'],
    expected: {
      affectedServices: [],
      blockingChecks: ['release-contracts'],
      asyncChecks: ['full-regression'],
      candidateRuntimePaths: [],
      riskTags: ['ci-workflow'],
      docsOnly: false,
      unknownPaths: [],
    },
  },
  {
    name: 'lockfile change rebuilds every service with a security audit',
    paths: ['pnpm-lock.yaml'],
    expected: {
      affectedServices: ALL_SERVICES,
      blockingChecks: ALL_SERVICE_CHECKS,
      asyncChecks: ['full-regression', 'security-audit'],
      candidateRuntimePaths: ['pnpm-lock.yaml'],
      riskTags: ['dependency-lockfile'],
      docsOnly: false,
      unknownPaths: [],
    },
  },
  {
    name: 'root package manifest change rebuilds every service',
    paths: ['package.json'],
    expected: {
      affectedServices: ALL_SERVICES,
      blockingChecks: ALL_SERVICE_CHECKS,
      asyncChecks: ['full-regression', 'security-audit'],
      candidateRuntimePaths: ['package.json'],
      riskTags: ['dependency-manifest'],
      docsOnly: false,
      unknownPaths: [],
    },
  },
  {
    name: 'container build inputs rebuild every service and run release contracts',
    paths: ['docker-compose.yml', 'apps/api/Dockerfile', '.dockerignore'],
    expected: {
      affectedServices: ALL_SERVICES,
      blockingChecks: ['release-contracts', ...ALL_SERVICE_CHECKS],
      asyncChecks: ['full-regression'],
      candidateRuntimePaths: ['.dockerignore', 'apps/api/Dockerfile', 'docker-compose.yml'],
      riskTags: ['container-build'],
      docsOnly: false,
      unknownPaths: [],
    },
  },
  {
    name: 'docs-only changes run docs closure without service checks',
    paths: ['docs/ops/DEPLOY.md', 'README.md', 'AGENTS.md'],
    expected: {
      affectedServices: [],
      blockingChecks: ['docs-closure'],
      asyncChecks: [],
      candidateRuntimePaths: [],
      riskTags: [],
      docsOnly: true,
      unknownPaths: [],
    },
  },
  {
    name: 'cross-service change includes both sides with sorted output',
    paths: ['apps/web/app/page.tsx', 'apps/api/src/main.ts', 'apps/gateway-api/src/main.ts'],
    expected: {
      affectedServices: ['api', 'gateway', 'web'],
      blockingChecks: ['service:api', 'service:gateway', 'service:web'],
      asyncChecks: ['full-regression'],
      candidateRuntimePaths: [
        'apps/api/src/main.ts',
        'apps/gateway-api/src/main.ts',
        'apps/web/app/page.tsx',
      ],
      riskTags: [],
      docsOnly: false,
      unknownPaths: [],
    },
  },
  {
    name: 'unknown paths fail closed to every blocking check',
    paths: ['.github/dependabot.yml'],
    expected: {
      affectedServices: ALL_SERVICES,
      blockingChecks: FAIL_CLOSED_CHECKS,
      asyncChecks: ['full-regression'],
      candidateRuntimePaths: [],
      riskTags: ['unknown-path'],
      docsOnly: false,
      unknownPaths: ['.github/dependabot.yml'],
    },
  },
  {
    name: 'unknown paths mixed with docs stay fail closed and not docs-only',
    paths: ['docs/ops/DEPLOY.md', 'vendor/custom.bin'],
    expected: {
      affectedServices: ALL_SERVICES,
      blockingChecks: FAIL_CLOSED_CHECKS,
      asyncChecks: ['full-regression'],
      candidateRuntimePaths: [],
      riskTags: ['unknown-path'],
      docsOnly: false,
      unknownPaths: ['vendor/custom.bin'],
    },
  },
  {
    // B-161：agent 工具/技能路径（含 .shared-skills gitlink）按 docs 口径闭合，
    // 不触发服务发布，避免版本列车被 fail closed 强制要求全服务。
    name: 'agent tooling paths close as docs without services',
    paths: ['.shared-skills', '.agents/skills-config.json', '.ai/skills/project-review/SKILL.md', '.claude/settings.json', '.superpowers/x.md', '.vscode/settings.json'],
    expected: {
      affectedServices: [],
      blockingChecks: ['docs-closure'],
      asyncChecks: [],
      candidateRuntimePaths: [],
      riskTags: [],
      docsOnly: true,
      unknownPaths: [],
    },
  },
  {
    name: 'mixed frontend launcher is coordination tooling and production validator is release tooling',
    paths: ['scripts/mixed-frontend.mjs', 'scripts/local-e2e.mjs', 'scripts/lib/e2e-targets.mjs', 'scripts/validate-mixed-release.mjs'],
    expected: {
      affectedServices: [], blockingChecks: ['coordination-gate', 'release-contracts'],
      asyncChecks: [], candidateRuntimePaths: [], riskTags: [], docsOnly: false, unknownPaths: [],
    },
  },
  {
    name: 'agent tooling path mixed with api keeps api service scope',
    paths: ['.shared-skills', 'apps/api/src/main.ts'],
    expected: {
      affectedServices: ['api'],
      blockingChecks: ['docs-closure', 'service:api'],
      asyncChecks: ['full-regression'],
      candidateRuntimePaths: ['apps/api/src/main.ts'],
      riskTags: [],
      docsOnly: false,
      unknownPaths: [],
    },
  },
];

test('classifyChangedPaths table contract', () => {
  for (const { name, paths, expected } of CASES) {
    const actual = classifyChangedPaths(paths);
    assert.deepEqual(actual, expected, name);

    // 输入顺序与重复项不影响输出：JSON 稳定且确定性排序。
    const shuffled = classifyChangedPaths([...paths].reverse().concat(paths));
    assert.equal(JSON.stringify(shuffled), JSON.stringify(actual), `${name} deterministic`);
  }
});

test('prototype-only lockfile skips service coverage but keeps the lockfile security surface', () => {
  // The proven prototype-only case may skip application service coverage, but
  // the change is still a dependency lockfile input: risk tag + security audit
  // survive, and docsOnly only suppresses the per-service matrix.
  assert.deepEqual(
    classifyChangedPaths(['apps/ux-prototype/package.json', 'pnpm-lock.yaml'], {
      prototypeOnlyLockfile: true,
    }),
    {
      affectedServices: [],
      blockingChecks: ['docs-closure'],
      asyncChecks: ['security-audit'],
      candidateRuntimePaths: [],
      riskTags: ['dependency-lockfile'],
      docsOnly: true,
      unknownPaths: [],
    },
  );

  // Without the proof, the same lockfile change fails closed to every service.
  const unproven = classifyChangedPaths(['pnpm-lock.yaml']);
  assert.deepEqual(unproven.affectedServices, ALL_SERVICES);
  assert.ok(unproven.riskTags.includes('dependency-lockfile'));
  assert.ok(unproven.asyncChecks.includes('security-audit'));
});
