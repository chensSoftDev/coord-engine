import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createGitFixture, runGit } from './fixtures.mjs';
import { serviceRuntimeInputs } from '../../lib/coordination/mixed-environments.mjs';
import { classifyRevisionRange } from '../../lib/coordination/revision-policy.mjs';

const testInputs = ['scripts/local-e2e.mjs', 'scripts/run-dev-e2e-data-cleanup-docker.sh', 'scripts/lib/e2e-readiness.mjs', 'scripts/lib/e2e-coverage.mjs', 'docker-compose.e2e.yml'];
function put(cwd, path, content) { mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), content); }
function commit(cwd, message) { runGit(cwd, ['add', '.']); runGit(cwd, ['commit', '-m', message]); return runGit(cwd, ['rev-parse', 'HEAD']); }
function fixture(t, { extraCopy } = {}) {
  const { clientA: cwd } = createGitFixture(t);
  const services = {};
  for (const service of ['api', 'web']) {
    services[service] = { includes: [`apps/${service}/**`], excludes: [] };
    put(cwd, `apps/${service}/Dockerfile`, `FROM node:22-alpine\nCOPY apps/${service} ./app\n${service === 'api' && extraCopy ? `COPY ${extraCopy} ./tools\n` : ''}`);
    put(cwd, `apps/${service}/source.js`, 'export const version = 1;\n');
  }
  if (extraCopy) services.api.includes.push(extraCopy === 'scripts' ? 'scripts/**' : extraCopy);
  put(cwd, '.agents/runtime-artifact-inputs.json', JSON.stringify({ schemaVersion: 1, services }));
  for (const path of [...testInputs, 'scripts/deploy.sh', 'scripts/unknown-helper.mjs']) put(cwd, path, '# original\n');
  commit(cwd, 'runtime fingerprint fixture');
  return cwd;
}

test('only the declared E2E launcher, helpers, cleanup and compose mutations preserve service inputs', t => {
  const cwd = fixture(t); const original = serviceRuntimeInputs({ cwd, services: ['api', 'web'] });
  for (const path of testInputs) {
    const fromSha = runGit(cwd, ['rev-parse', 'HEAD']);
    put(cwd, path, '# updated test orchestration\n'); const toSha = commit(cwd, `test-only edit ${path}`);
    assert.equal(classifyRevisionRange({ cwd, requirementId: 'I-099', fromSha, toSha }).classification, 'deployment-neutral');
    assert.deepEqual(serviceRuntimeInputs({ cwd, services: ['api', 'web'] }), original, path);
  }
  for (const path of ['scripts/deploy.sh', 'scripts/unknown-helper.mjs']) {
    const before = serviceRuntimeInputs({ cwd, services: ['api', 'web'] });
    put(cwd, path, '# updated actual or unknown runtime helper\n'); commit(cwd, `runtime edit ${path}`);
    const after = serviceRuntimeInputs({ cwd, services: ['api', 'web'] });
    assert.notEqual(after.api, before.api, path); assert.notEqual(after.web, before.web, path);
  }
});

for (const extraCopy of ['scripts/local-e2e.mjs', 'scripts']) test(`Docker COPY ${extraCopy} keeps test tooling in that service identity`, t => {
  const cwd = fixture(t, { extraCopy }); const before = serviceRuntimeInputs({ cwd, services: ['api', 'web'] });
  put(cwd, 'scripts/local-e2e.mjs', '# changed copied tool\n'); commit(cwd, 'copied test tool change');
  const after = serviceRuntimeInputs({ cwd, services: ['api', 'web'] });
  assert.notEqual(after.api, before.api);
  assert.equal(after.web, before.web);
});

test('a copied app config remains a runtime input even when the declaration excludes it', t => {
  const cwd = fixture(t);
  const path = '.agents/runtime-artifact-inputs.json'; const declaration = JSON.parse(readFileSync(join(cwd, path), 'utf8'));
  declaration.services.web.excludes.push('apps/web/playwright.config.ts');
  put(cwd, path, JSON.stringify(declaration)); put(cwd, 'apps/web/playwright.config.ts', 'export default {};\n');
  commit(cwd, 'declared app test config');
  const before = serviceRuntimeInputs({ cwd, services: ['web'] });
  put(cwd, 'apps/web/playwright.config.ts', 'export default { workers: 1 };\n'); commit(cwd, 'copied config mutation');
  assert.notEqual(serviceRuntimeInputs({ cwd, services: ['web'] }).web, before.web);
});
