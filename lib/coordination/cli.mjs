import {
  doctorCommand,
  initCommand,
  migrateSchemaCommand,
  reconcileCommand,
  statusCommand,
} from './commands/misc.mjs';
import candidateCommand from './commands/candidate.mjs';
import deploymentCommand from './commands/deployment.mjs';
import evidenceCommand from './commands/evidence.mjs';
import freezeCommand from './commands/freeze.mjs';
import gateCommand from './commands/gate.mjs';
import guardCommand from './commands/guard.mjs';
import lifecycleCommand from './commands/lifecycle.mjs';
import lockCommand from './commands/lock.mjs';
import manifestCommand from './commands/manifest.mjs';
import migrationCommand from './commands/migration.mjs';
import planCommand from './commands/plan.mjs';
import regressionCommand from './commands/regression.mjs';
import releaseApprovalCommand from './commands/release-approval.mjs';
import requirementCommand from './commands/requirement.mjs';
import sessionCommand from './commands/session.mjs';
import telemetryCommand from './commands/telemetry.mjs';
import testCommand from './commands/test.mjs';
import whatNextCommand from './commands/what-next.mjs';
import worktreeCommand from './commands/worktree.mjs';
import uxCommand from './commands/ux.mjs';
import reviewCommand from './commands/review.mjs';
import environmentCommand from './commands/environment.mjs';
import {
  CoordinationError,
  EXIT,
  createGuardStore,
  dispatchKey,
  success,
  usageError,
} from './commands/helpers.mjs';

export {
  CoordinationError,
  EXIT,
  createGuardStore,
};

// I-132 (F1): the registry is the single source of truth — the command set,
// the option whitelist, the dispatch table and the global help are all
// derived from the command modules' metadata. The order below pins the
// Commands: listing order in the global help.
// I-134 (F5): exported (with the option sets below) so the API reference
// generator renders from the exact same source — the document can never
// drift from the CLI.
export const REGISTRY = [
  initCommand,
  statusCommand,
  migrateSchemaCommand,
  requirementCommand,
  uxCommand,
  reviewCommand,
  environmentCommand,
  sessionCommand,
  worktreeCommand,
  lockCommand,
  candidateCommand,
  regressionCommand,
  telemetryCommand,
  freezeCommand,
  releaseApprovalCommand,
  lifecycleCommand,
  testCommand,
  evidenceCommand,
  gateCommand,
  reconcileCommand,
  doctorCommand,
  deploymentCommand,
  guardCommand,
  whatNextCommand,
  planCommand,
  manifestCommand,
  migrationCommand,
];

export const COMMANDS = new Set(REGISTRY.map((module) => module.command));

const BOOLEAN_OPTIONS = new Set([
  'allow-service-override',
  'auto',
  'dry-run',
  'force',
  'issue-ticket',
  'join',
]);

const REPEATABLE_OPTIONS = new Set([
  'config-key',
  'database-table',
  'depends-on',
  'file',
  'service',
  'shared',
  'target',
]);

const HELP = `Usage: pnpm coord <command> [options]

Commands:
${REGISTRY.map(({ command, summary }) => `  ${command.padEnd(16)}  ${summary}`).join('\n')}

Global options:
  --json        Emit one machine-readable JSON document
  --reuse-sha=<40-hex>  Skip the first coordination fetch, reusing a previously
                observed coordinationSha (writes stay CAS-safe)
  -h, --help    Show this help

Notes:
  With --json, success is one JSON document on stdout; failures go to stderr
  with a machine-readable code (CLI_USAGE means the invocation itself is
  wrong; any other code is a gate/state rejection).
`;

// I-128 (H4): every command declares the options it actually consumes; an
// undeclared option is rejected instead of silently ignored (e.g. a stray
// --dry-run on a write command must never execute for real). The whitelist
// is derived from the registry (I-132, F1); a registry completeness test
// pins every entry against the original hand-maintained table.
const COMMAND_OPTION_WHITELIST = new Map(
  REGISTRY.flatMap((module) => module.subcommands.map((subcommand) => [
    subcommand.key,
    subcommand.options,
  ])),
);

const SUBCOMMAND_INDEX = new Map(
  REGISTRY.flatMap((module) => module.subcommands.map((subcommand) => [
    subcommand.key,
    subcommand,
  ])),
);

// I-132 (F2): per-command and per-subcommand help, generated from the same
// registry metadata that drives dispatch and the option whitelist. An option
// is annotated required/optional from its bracketing in the usage string,
// and boolean/repeatable from the parser option sets.
// I-134 (F5, review): exported so the API reference generator reuses this
// exact rule instead of drifting on a local copy.
export function describeOption(subcommand, name) {
  // B-248: an option that only appears inside a "(--a | --b)" group is not
  // individually required — exactly one of the alternatives is. Annotate it
  // as such instead of rendering every member as (required).
  const annotations = [];
  if (subcommand.usage.includes(`[--${name}`)) {
    annotations.push('optional');
  } else if (new RegExp(`\\([^)]*--${name}[^)]*\\)`).test(subcommand.usage)) {
    annotations.push('required, exactly one of the grouped alternatives');
  } else {
    annotations.push('required');
  }
  if (BOOLEAN_OPTIONS.has(name)) annotations.push('boolean');
  if (REPEATABLE_OPTIONS.has(name)) annotations.push('repeatable');
  return `--${name} (${annotations.join(', ')})`;
}

function subcommandHelp(subcommand) {
  const options = subcommand.options.map((name) => `  ${describeOption(subcommand, name)}`);
  return `Usage: pnpm coord ${subcommand.usage}\n\n${subcommand.summary}\n${
    options.length > 0 ? `\nOptions:\n${options.join('\n')}\n` : ''}`;
}

// A module may override the generic `<subcommand>` usage line when its entry
// points are not subcommands (reconcile <ID> | --operation); a module whose
// only subcommand is the bare command itself (init, status, doctor, ...)
// shows that subcommand's usage instead of a misleading group line.
// I-134 (F5, review): exported so the API reference generator renders the
// module usage line with the exact same rule as the CLI help.
export function commandUsage(module) {
  if (module.groupUsage) return module.groupUsage;
  if (module.subcommands.length === 1 && module.subcommands[0].key === module.command) {
    return module.subcommands[0].usage;
  }
  return `${module.command} <subcommand> [options]`;
}

function commandHelp(module) {
  const lines = module.subcommands.map((subcommand) => {
    const options = subcommand.options.map((name) => describeOption(subcommand, name));
    return `  ${subcommand.usage}\n      ${subcommand.summary}${
      options.length > 0 ? `\n      options: ${options.join(', ')}` : ''}`;
  });
  const usage = commandUsage(module);
  return `Usage: pnpm coord ${usage}\n\n${module.summary}\n\nSubcommands:\n${lines.join('\n')}\n`;
}

function helpFor(parsed) {
  if (parsed.command === null) return HELP;
  const module = REGISTRY.find((entry) => entry.command === parsed.command);
  if (!module) return HELP;
  if (parsed.positionals.length > 0) {
    const subcommand = SUBCOMMAND_INDEX.get(dispatchKey(parsed))
      ?? SUBCOMMAND_INDEX.get(parsed.command);
    if (subcommand) return subcommandHelp(subcommand);
  }
  // A module whose only subcommand is the bare command itself (status,
  // doctor, ...) has no group to list — show the command help directly.
  if (module.subcommands.length === 1 && module.subcommands[0].key === module.command) {
    return subcommandHelp(module.subcommands[0]);
  }
  return commandHelp(module);
}

function enforceOptionWhitelist(parsed) {
  const key = dispatchKey(parsed);
  const allowed = COMMAND_OPTION_WHITELIST.get(key);
  // Unknown subcommands fall through to the dispatch usage error below.
  if (!allowed) return;
  const unknown = Object.keys(parsed.options).filter((name) => !allowed.includes(name));
  if (unknown.length > 0) {
    throw usageError(
      `${key} does not accept option(s): ${unknown.map((name) => `--${name}`).join(', ')}`,
    );
  }
}

function setOption(options, key, value) {
  if (REPEATABLE_OPTIONS.has(key)) {
    options[key] = [...(options[key] ?? []), value];
    return;
  }
  if (Object.hasOwn(options, key)) {
    throw usageError(`option may only be provided once: --${key}`);
  }
  options[key] = value;
}

export function parseArgs(argv) {
  let command = null;
  let json = false;
  let help = false;
  const positionals = [];
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === '--json') {
      json = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      help = true;
      continue;
    }
    if (!token.startsWith('-')) {
      if (command === null) {
        command = token;
      } else {
        positionals.push(token);
      }
      continue;
    }
    if (!token.startsWith('--')) {
      throw usageError(`unknown option: ${token}`);
    }

    const equalsIndex = token.indexOf('=');
    if (equalsIndex > 2) {
      const key = token.slice(2, equalsIndex);
      const value = token.slice(equalsIndex + 1);
      if (value.length === 0) {
        throw usageError(`option requires a value: --${key}`);
      }
      setOption(options, key, value);
      continue;
    }

    const key = token.slice(2);
    if (BOOLEAN_OPTIONS.has(key)) {
      setOption(options, key, true);
      continue;
    }

    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw usageError(`option requires a value: --${key}`);
    }
    setOption(options, key, value);
    index += 1;
  }

  if (command === null && !help) {
    throw usageError('a command is required');
  }
  if (command !== null && !COMMANDS.has(command)) {
    throw usageError(`unknown command: ${command}`);
  }

  // I-131 (E6): --reuse-sha is a global option (every command may reuse the
  // previous command's coordinationSha), so it is plucked here instead of
  // per-command whitelists. Duplicate detection is inherited from setOption.
  const { 'reuse-sha': reuseSha, ...commandOptions } = options;

  return {
    command,
    positionals,
    options: commandOptions,
    ...(reuseSha !== undefined ? { reuseSha } : {}),
    json,
    help,
  };
}

export async function executeBuiltin(parsed, {
  env,
  clock = () => new Date(),
  guardTrustRoot,
}) {
  if (parsed.help) {
    return success('help', { help: helpFor(parsed) });
  }
  // I-131 (E6): validate the global reuse SHA once and inject it into the
  // environment every store is created from.
  if (parsed.reuseSha !== undefined) {
    if (!/^[0-9a-f]{40}$/.test(parsed.reuseSha)) {
      throw usageError('--reuse-sha must be a full 40-character hex commit SHA');
    }
    env = { ...env, COORD_REUSE_SHA: parsed.reuseSha };
  }
  enforceOptionWhitelist(parsed);
  const ctx = {
    env,
    clock,
    cwd: env.COORD_CWD ?? process.cwd(),
    guardTrustRoot,
  };
  // Bare top-level commands (init, status, ...) keep their own usage errors
  // for stray positionals, so a full-key miss falls back to the bare command.
  const subcommand = SUBCOMMAND_INDEX.get(dispatchKey(parsed))
    ?? SUBCOMMAND_INDEX.get(parsed.command);
  if (subcommand) {
    const { message, data } = await subcommand.handler({ parsed, ctx });
    return success(message, data);
  }
  const knownSubcommands = [...COMMAND_OPTION_WHITELIST.keys()]
    .filter((key) => key.startsWith(`${parsed.command} `))
    .map((key) => key.slice(parsed.command.length + 1))
    .filter((sub) => sub !== '<id>');
  throw usageError(
    knownSubcommands.length > 0
      ? `unknown ${parsed.command} subcommand: ${parsed.positionals[0] ?? '<missing>'}; expected one of: ${knownSubcommands.join(', ')}`
      : `command is not implemented yet: ${parsed.command}`,
  );
}

function errorResult(error) {
  if (error instanceof CoordinationError) {
    return {
      ok: false,
      code: error.code,
      exitCode: error.exitCode,
      message: error.message,
      data: error.data,
    };
  }
  if (
    error instanceof Error
    && typeof error.code === 'string'
    && Number.isInteger(error.exitCode)
  ) {
    return {
      ok: false,
      code: error.code,
      exitCode: error.exitCode,
      message: error.message,
      data: error.data ?? {},
    };
  }
  return {
    ok: false,
    code: 'UNEXPECTED_ERROR',
    exitCode: EXIT.GATE_FAILED,
    message: error instanceof Error ? error.message : String(error),
    data: {},
  };
}

function writeResult(result, { json, stdout, stderr }) {
  const target = result.ok ? stdout : stderr;
  if (json) {
    target.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (result.ok && result.data.help) {
    target.write(result.data.help);
    return;
  }
  target.write(`${result.message}\n`);
}

export async function main(argv, {
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  execute = executeBuiltin,
  clock = () => new Date(),
  guardTrustRoot,
} = {}) {
  const wantsJson = argv.includes('--json');
  try {
    const parsed = parseArgs(argv);
    const result = await execute(parsed, { env, clock, guardTrustRoot });
    writeResult(result, { json: parsed.json, stdout, stderr });
    return result.exitCode;
  } catch (error) {
    const result = errorResult(error);
    writeResult(result, { json: wantsJson, stdout, stderr });
    return result.exitCode;
  }
}
