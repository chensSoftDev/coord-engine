import assert from 'node:assert/strict';
import test from 'node:test';

import { COMMANDS } from '../../lib/coordination/cli.mjs';
import miscCommands, {
  doctorCommand,
  initCommand,
  migrateSchemaCommand,
  reconcileCommand,
  statusCommand,
} from '../../lib/coordination/commands/misc.mjs';
import candidateCommand from '../../lib/coordination/commands/candidate.mjs';
import deploymentCommand from '../../lib/coordination/commands/deployment.mjs';
import evidenceCommand from '../../lib/coordination/commands/evidence.mjs';
import freezeCommand from '../../lib/coordination/commands/freeze.mjs';
import gateCommand from '../../lib/coordination/commands/gate.mjs';
import guardCommand from '../../lib/coordination/commands/guard.mjs';
import lifecycleCommand from '../../lib/coordination/commands/lifecycle.mjs';
import lockCommand from '../../lib/coordination/commands/lock.mjs';
import manifestCommand from '../../lib/coordination/commands/manifest.mjs';
import migrationCommand from '../../lib/coordination/commands/migration.mjs';
import planCommand from '../../lib/coordination/commands/plan.mjs';
import regressionCommand from '../../lib/coordination/commands/regression.mjs';
import releaseApprovalCommand from '../../lib/coordination/commands/release-approval.mjs';
import requirementCommand from '../../lib/coordination/commands/requirement.mjs';
import sessionCommand from '../../lib/coordination/commands/session.mjs';
import telemetryCommand from '../../lib/coordination/commands/telemetry.mjs';
import testCommand from '../../lib/coordination/commands/test.mjs';
import whatNextCommand from '../../lib/coordination/commands/what-next.mjs';
import worktreeCommand from '../../lib/coordination/commands/worktree.mjs';
import uxCommand from '../../lib/coordination/commands/ux.mjs';
import reviewCommand from '../../lib/coordination/commands/review.mjs';
import environmentCommand from '../../lib/coordination/commands/environment.mjs';

// I-132 (F1): the registry must cover exactly the expected command set —
// no more, no less. The list started as the pre-split command set; F3/F4
// appended the new what-next and plan modules.
const MODULES = [
  ...miscCommands,
  candidateCommand,
  deploymentCommand,
  evidenceCommand,
  freezeCommand,
  gateCommand,
  guardCommand,
  lifecycleCommand,
  lockCommand,
  regressionCommand,
  releaseApprovalCommand,
  requirementCommand,
  sessionCommand,
  telemetryCommand,
  testCommand,
  worktreeCommand,
  uxCommand,
  reviewCommand,
  environmentCommand,
  whatNextCommand,
  planCommand,
  manifestCommand,
  migrationCommand,
];

// The command option whitelist contract, frozen as a literal table. It
// started as the pre-split COMMAND_OPTION_WHITELIST snapshot (the F1
// refactor derives the runtime whitelist from the command modules, so every
// pre-split entry must match this table exactly — I-128, H4 behavior is
// pinned) and has since been extended with the I-132 F3-F6 additions
// (what-next, plan, manifest init, migration draft, lifecycle --dry-run)
// and the I-134 additions (freeze unfreeze — the deprecated freeze
// accept/reject/release aliases reuse their original keys and rows —
// declare-resources --auto, requirement cancel):
// it is the current contract, not a historical snapshot.
const ORIGINAL_COMMAND_OPTION_WHITELIST = new Map(Object.entries({
  init: [],
  doctor: [],
  status: [],
  'migrate-schema': [],
  'session init': ['agent', 'user'],
  'session show': [],
  'worktree create': ['topic'],
  'worktree join': ['path'],
  'requirement claim': ['type', 'title', 'profile', 'ux-impact', 'migration'],
  'requirement start': ['type', 'title', 'profile', 'ux-impact', 'topic', 'migration', 'version', 'bump', 'join-version'],
  'requirement set-ux-impact': ['reason'],
  'requirement enable-workflow': ['reason'],
  'requirement set-profile': ['reason'],
  'requirement set-migration': ['migration', 'reason'],
  'requirement allow-ux-review': ['paths', 'reason'],
  'requirement clear-merge': ['reason'],
  'requirement set-database-tables': ['database-table', 'reason'],
  'requirement import-existing': ['profile', 'branch'],
  'requirement show': [],
  'requirement bind-version': ['force', 'bump', 'join-version'],
  'requirement bind-branch': ['force'],
  'requirement declare-resources': ['file', 'service', 'database-table', 'config-key', 'shared', 'depends-on', 'auto'],
  'requirement cancel': ['reason', 'force'],
  'requirement reconcile-merged': ['commit', 'base'],
  'requirement plan-completion': ['commit'],
  'requirement apply-completion': ['plan', 'requirement'],
  'lock acquire': ['requirement', 'ttl'],
  'lock renew': ['ttl'],
  'lock assert': ['requirement', 'commit'],
  'lock release': [],
  'lock break': ['reason', 'force'],
  'freeze show': [],
  'freeze enter': ['requirement', 'candidate', 'deployment-snapshot', 'evidence'],
  'freeze unfreeze': ['requirement', 'outcome', 'reason', 'authorized-by', 'instruction-ref'],
  'freeze accept': ['requirement', 'reason', 'authorized-by', 'instruction-ref'],
  'freeze reject': ['requirement', 'reason'],
  'freeze release': ['requirement', 'reason'],
  'release-approval record': ['authorized-by', 'instruction-ref'],
  'release-approval show': [],
  'release-approval revoke': ['reason'],
  'ux prepare': [],
  'ux approve': ['authorized-by', 'instruction-ref'],
  'ux show': [],
  'ux revoke': ['reason'],
  'candidate record': ['ref', 'service'],
  'candidate show': ['candidate'],
  'candidate void': ['candidate', 'reason'],
  'candidate assert-ref': ['ref'],
  'candidate assert-equivalent': ['candidate', 'release-commit'],
  'regression record': ['commit', 'service', 'log', 'classification', 'runner', 'owner'],
  'regression show': [],
  'regression clear': ['reason', 'owner'],
  'regression resolve': ['service'],
  'telemetry record': ['phase', 'commit', 'candidate', 'started-at', 'ended-at'],
  'telemetry aggregate': [],
  'guard shared-env': ['stage', 'target', 'requirement', 'commit', 'dry-run', 'issue-ticket', 'release-approval'],
  'deployment record': ['requirement', 'snapshot'],
  'lifecycle advance': ['to', 'dry-run'],
  'lifecycle next': ['dry-run'],
  'lifecycle batch-next': ['dry-run'],
  'lifecycle fail': ['reason', 'evidence-sha'],
  'lifecycle rework': ['kind', 'reason', 'instruction-ref'],
  'review prepare': ['stage'],
  'review show': ['stage'],
  'review record': ['stage', 'report'],
  'review verify': ['stage', 'report'],
  'environment prepare': ['app', 'base-url'],
  'environment record': ['app', 'base-url'],
  'environment show': [],
  'test run': [],
  'evidence validate': ['head', 'base'],
  'gate validate': ['event', 'head', 'base'],
  'gate preflight': ['head', 'base'],
  reconcile: ['operation'],
  'reconcile <id>': [],
  'what-next': [],
  plan: [],
  'manifest init': ['force'],
  'migration draft': ['force'],
}));

const allSubcommands = MODULES.flatMap((module) => module.subcommands);

test('every COMMANDS member has a command module with complete metadata', () => {
  assert.equal(MODULES.length, COMMANDS.size);
  const byCommand = new Map(MODULES.map((module) => [module.command, module]));
  for (const command of COMMANDS) {
    const module = byCommand.get(command);
    assert.ok(module, `missing command module for: ${command}`);
    assert.equal(typeof module.summary, 'string');
    assert.ok(module.summary.length > 0, `empty summary for: ${command}`);
    assert.ok(Array.isArray(module.subcommands), `subcommands missing for: ${command}`);
    assert.ok(module.subcommands.length > 0, `no subcommands for: ${command}`);
  }
});

test('every command module is exposed through COMMANDS', () => {
  for (const module of MODULES) {
    assert.ok(
      COMMANDS.has(module.command),
      `command module is not exposed through COMMANDS: ${module.command}`,
    );
  }
});

test('subcommand keys are unique and namespaced under their command', () => {
  const keys = allSubcommands.map((subcommand) => subcommand.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const module of MODULES) {
    for (const subcommand of module.subcommands) {
      assert.ok(
        subcommand.key === module.command
          || subcommand.key.startsWith(`${module.command} `),
        `subcommand key ${subcommand.key} is not namespaced under ${module.command}`,
      );
    }
  }
});

test('every subcommand key exists in the original whitelist with identical options', () => {
  assert.equal(allSubcommands.length, ORIGINAL_COMMAND_OPTION_WHITELIST.size);
  for (const subcommand of allSubcommands) {
    assert.ok(
      ORIGINAL_COMMAND_OPTION_WHITELIST.has(subcommand.key),
      `subcommand key not in the original whitelist: ${subcommand.key}`,
    );
    assert.deepEqual(
      subcommand.options,
      ORIGINAL_COMMAND_OPTION_WHITELIST.get(subcommand.key),
      `options drifted for: ${subcommand.key}`,
    );
  }
});

test('every original whitelist entry is backed by a registry subcommand', () => {
  const keys = new Set(allSubcommands.map((subcommand) => subcommand.key));
  for (const key of ORIGINAL_COMMAND_OPTION_WHITELIST.keys()) {
    assert.ok(keys.has(key), `original whitelist entry lost in the split: ${key}`);
  }
});

test('every subcommand has usage, summary, options, and a handler', () => {
  for (const subcommand of allSubcommands) {
    assert.equal(typeof subcommand.usage, 'string', `usage missing for: ${subcommand.key}`);
    assert.ok(subcommand.usage.length > 0, `usage empty for: ${subcommand.key}`);
    assert.equal(typeof subcommand.summary, 'string', `summary missing for: ${subcommand.key}`);
    assert.ok(subcommand.summary.length > 0, `summary empty for: ${subcommand.key}`);
    assert.ok(Array.isArray(subcommand.options), `options missing for: ${subcommand.key}`);
    assert.equal(typeof subcommand.handler, 'function', `handler missing for: ${subcommand.key}`);
  }
});

test('misc keeps both reconcile dispatch keys (bare operation and <id> special case)', () => {
  const keys = reconcileCommand.subcommands.map((subcommand) => subcommand.key);
  assert.deepEqual(keys.sort(), ['reconcile', 'reconcile <id>']);
  for (const subcommand of reconcileCommand.subcommands) {
    assert.equal(typeof subcommand.handler, 'function');
  }
});

test('misc default export carries exactly the five misc command modules', () => {
  assert.deepEqual(
    miscCommands.map((module) => module.command).sort(),
    ['doctor', 'init', 'migrate-schema', 'reconcile', 'status'],
  );
  assert.deepEqual(miscCommands, [
    initCommand,
    statusCommand,
    migrateSchemaCommand,
    doctorCommand,
    reconcileCommand,
  ]);
});
