import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { createGitFixture, runGit } from './fixtures.mjs';
const receipts = await import('../../lib/coordination/check-receipts.mjs').catch(() => ({}));

// The checked application reads these switches from committed source.
function applicationFixture(t) {
  const fixture = createGitFixture(t);
  writeFileSync(join(fixture.clientA, 'app.mjs'), [
    'export const strict = process.env.SITEMAP_STRICT;',
    "export const mode = process.env['CUSTOM_FEATURE_MODE'];",
    "export const secret = config => config.getOrThrow<string>('JWT_SECRET');", ''].join('\n'));
  writeFileSync(join(fixture.clientA, 'deploy.sh'), '#!/bin/bash\necho "${DEPLOY_STAGE:-dev}"\n');
  runGit(fixture.clientA, ['add', 'app.mjs', 'deploy.sh']);
  runGit(fixture.clientA, ['commit', '-m', 'test: application reads switches']);
  return fixture;
}

test('canonical receipts bind inputs, toolchain and environment; logs must remain intact', t => {
  assert.equal(typeof receipts.receiptIdentity, 'function');
  const { clientA: cwd } = createGitFixture(t);
  const input = { declared: true, inputsSha256: 'a'.repeat(64), lockfilesSha256: 'b'.repeat(64), declaration: { sha256: 'c'.repeat(64) } };
  const first = receipts.receiptIdentity({ argv: ['pnpm', 'run', 'lint'], input, toolchain: { node: '22', env: 'same' } });
  const same = receipts.receiptIdentity({ argv: ['pnpm', 'lint'], input, toolchain: { node: '22', env: 'same' } });
  assert.equal(first.key, same.key);
  assert.notEqual(first.key, receipts.receiptIdentity({ argv: ['pnpm', 'lint'], input, toolchain: { node: '24', env: 'same' } }).key);
  assert.equal(receipts.receiptIdentity({ argv: ['pnpm', 'audit:prod'], input, toolchain: {} }), null, 'external audit cannot be reused indefinitely');
  const commonDirectory = join(cwd, '.git');
  const logPath = 'coordination/test-logs/I-001/one.log';
  mkdirSync(join(commonDirectory, 'coordination/test-logs/I-001'), { recursive: true });
  writeFileSync(join(commonDirectory, logPath), 'passed');
  receipts.writeCheckReceipt({ commonDirectory, identity: first, result: { outcome: 'passed', exitCode: 0, logPath }, testedCommit: 'd'.repeat(40) });
  assert.equal(receipts.readCheckReceipt({ commonDirectory, identity: same }).result.exitCode, 0);
  writeFileSync(join(commonDirectory, logPath), 'tampered');
  assert.equal(receipts.readCheckReceipt({ commonDirectory, identity: same }), null);
});

test('application switches read by the checked source take part without persisting values', t => {
  const { clientA: cwd } = applicationFixture(t);
  const toolchain = env => receipts.verificationToolchain({ cwd, env: { ...process.env, ...env } });
  const first = toolchain({ SITEMAP_STRICT: 'false', CUSTOM_FEATURE_MODE: 'first-secret' });
  assert.notEqual(first.environmentSha256, toolchain({ SITEMAP_STRICT: 'true', CUSTOM_FEATURE_MODE: 'first-secret' }).environmentSha256);
  assert.notEqual(first.environmentSha256, toolchain({ SITEMAP_STRICT: 'false', CUSTOM_FEATURE_MODE: 'second-secret' }).environmentSha256);
  assert.notEqual(first.environmentSha256, toolchain({ SITEMAP_STRICT: 'false', CUSTOM_FEATURE_MODE: 'first-secret', JWT_SECRET: 'fixture-config' }).environmentSha256,
    'a ConfigService key is an application switch too');
  assert.notEqual(first.environmentSha256, toolchain({ SITEMAP_STRICT: 'false', CUSTOM_FEATURE_MODE: 'first-secret', DEPLOY_STAGE: 'fixture-stage' }).environmentSha256,
    'a variable a committed shell script reads is an input too');
  assert.ok(!JSON.stringify(first).includes('first-secret'));
});

test('linked dotenv configuration participates in receipt identity', t => {
  const { clientA: cwd } = createGitFixture(t);
  const target = join(cwd, '.git/local-config');
  writeFileSync(target, 'SITEMAP_STRICT=false\n');
  symlinkSync(target, join(cwd, '.env.local'));
  const first = receipts.verificationToolchain({ cwd });
  writeFileSync(target, 'SITEMAP_STRICT=true\n');
  const second = receipts.verificationToolchain({ cwd });
  assert.notDeepEqual(first.files, second.files);
});

test('I-276: host, agent session and unread variables never invalidate a receipt', t => {
  const { clientA: cwd } = applicationFixture(t);
  const base = { ...process.env, SITEMAP_STRICT: 'false' };
  const first = receipts.verificationEnvironmentFingerprint(base, { cwd });
  for (const [key, value] of [['ZCODE_SESSION_ID', 'fixture-session-two'], ['CLAUDE_SESSION_ID', 'fixture-session-two'],
    ['ZCODE_APP_VERSION', 'fixture-upgrade'], ['ZCODE_OFFICIAL_ENDPOINT_TOKEN', 'fixture-rotated'], ['SSH_AUTH_SOCK', '/tmp/fixture.sock'],
    ['TMPDIR', '/tmp/fixture-tmp/'], ['COORD_SESSION_ID', 'fixture-session'], ['CODEX_TOOL_CALL_ID', 'fixture-call-two'],
    ['npm_config_reporter', 'silent'], ['npm_config_loglevel', 'silent'],
    ['UNREAD_FEATURE_MODE', 'fixture-unread']]) {
    assert.equal(receipts.verificationEnvironmentFingerprint({ ...base, [key]: value }, { cwd }), first, `${key} must not invalidate a receipt`);
  }
});

test('I-276: toolchain, compiler and executable search switches stay significant', t => {
  const { clientA: cwd } = createGitFixture(t);
  const base = { ...process.env, PATH: `/tmp/luggage-first${delimiter}/tmp/luggage-second` };
  const first = receipts.verificationEnvironmentFingerprint(base, { cwd });
  for (const [key, value] of [['CI', 'luggage-fixture'], ['TZ', 'Pacific/Chatham'], ['NODE_OPTIONS', '--luggage-fixture'],
    ['CPATH', '/tmp/luggage-include'], ['SDKROOT', '/tmp/luggage-sdk'], ['ESLINT_USE_FLAT_CONFIG', 'luggage-fixture'],
    ['PATH', `/tmp/luggage-second${delimiter}/tmp/luggage-first`]]) {
    assert.notEqual(receipts.verificationEnvironmentFingerprint({ ...base, [key]: value }, { cwd }), first, `${key} must invalidate a receipt`);
  }
});

test('I-276: the same checkout under another worktree path reuses its receipt', t => {
  const { clientA, clientB } = createGitFixture(t);
  const env = cwd => ({ ...process.env, PATH: `${join(cwd, 'node_modules/.bin')}${delimiter}/usr/bin`, PNPM_SCRIPT_SRC_DIR: cwd });
  assert.equal(receipts.verificationEnvironmentFingerprint(env(clientA), { cwd: clientA }),
    receipts.verificationEnvironmentFingerprint(env(clientB), { cwd: clientB }));
});

test('I-276: pnpm install timestamps do not change the toolchain identity', t => {
  const { clientA: cwd } = createGitFixture(t);
  mkdirSync(join(cwd, 'node_modules'), { recursive: true });
  const install = (prunedAt, storeDir = '/store') => writeFileSync(join(cwd, 'node_modules/.modules.yaml'),
    JSON.stringify({ layoutVersion: 5, prunedAt, storeDir }, null, 2));
  install('Mon, 09 Nov 2026 01:00:00 GMT');
  const first = receipts.verificationToolchain({ cwd }).files;
  install('Mon, 09 Nov 2026 09:00:00 GMT');
  assert.deepEqual(receipts.verificationToolchain({ cwd }).files, first);
  install('Mon, 09 Nov 2026 09:00:00 GMT', '/other-store');
  assert.notDeepEqual(receipts.verificationToolchain({ cwd }).files, first);
});

test('I-276: without a readable source tree every variable stays significant', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'luggage-receipt-no-git-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  assert.equal(receipts.referencedEnvironmentNames(cwd), null);
  const env = { ...process.env, UNREAD_FEATURE_MODE: 'first' };
  assert.notEqual(receipts.verificationEnvironmentFingerprint(env, { cwd }),
    receipts.verificationEnvironmentFingerprint({ ...env, UNREAD_FEATURE_MODE: 'second' }, { cwd }));
});
