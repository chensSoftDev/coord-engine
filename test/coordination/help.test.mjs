import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMMANDS,
  EXIT,
  executeBuiltin,
  main,
  parseArgs,
} from '../../lib/coordination/cli.mjs';
import { createMemoryIo } from './fixtures.mjs';

// I-132 (F2): per-command help is generated from the registry metadata —
// `coord <command> --help` shows the command group (summary + every
// subcommand's usage/summary/options), `coord <command> <sub> --help` shows
// the single subcommand, and bare `coord --help` keeps the global help.

test('global help stays unchanged for bare --help', async () => {
  const memory = createMemoryIo();
  const exitCode = await main(['--help'], { ...memory.io, env: {} });

  assert.equal(exitCode, EXIT.OK);
  const help = memory.stdout.join('');
  assert.match(help, /^Usage: pnpm coord <command> \[options\]/);
  assert.match(help, /Global options:/);
  assert.match(help, /Notes:/);
  for (const command of COMMANDS) {
    assert.match(help, new RegExp(`^  ${command}\\s`, 'm'), `missing command: ${command}`);
  }
});

test('command group help lists every subcommand with annotated options', async () => {
  const memory = createMemoryIo();
  const exitCode = await main(['lifecycle', '--help'], { ...memory.io, env: {} });

  assert.equal(exitCode, EXIT.OK);
  const help = memory.stdout.join('');
  assert.match(help, /^Usage: pnpm coord lifecycle <subcommand> \[options\]/);
  assert.match(help, /Advance \(advance\/next\/batch-next\) or fail a requirement lifecycle/);
  assert.match(help, /Subcommands:/);
  for (const usage of [
    'lifecycle advance <ID> --to <state> [--dry-run]',
    'lifecycle next <ID> [--dry-run]',
    'lifecycle batch-next <ID>... [--dry-run]',
    'lifecycle fail <ID> --reason <reason> [--evidence-sha <sha>]',
  ]) {
    assert.match(help, new RegExp(`^  ${usage.replace(/[.[\]]/g, '\\$&')}$`, 'm'));
  }
  assert.match(help, /options: --to \(required\), --dry-run \(optional, boolean\)/);
  assert.match(help, /options: --reason \(required\), --evidence-sha \(optional\)/);
});

test('subcommand help shows a single subcommand with its options detail', async () => {
  const memory = createMemoryIo();
  const exitCode = await main(['lifecycle', 'advance', '--help'], { ...memory.io, env: {} });

  assert.equal(exitCode, EXIT.OK);
  const help = memory.stdout.join('');
  assert.equal(help, [
    'Usage: pnpm coord lifecycle advance <ID> --to <state> [--dry-run]',
    '',
    'Advance a requirement lifecycle to an explicit state',
    '',
    'Options:',
    '  --to (required)',
    '  --dry-run (optional, boolean)',
    '',
  ].join('\n'));
});

test('option annotations mark boolean and repeatable options', async () => {
  const breakHelp = createMemoryIo();
  assert.equal(await main(['lock', 'break', '--help'], { ...breakHelp.io, env: {} }), EXIT.OK);
  assert.match(breakHelp.stdout.join(''), /--reason \(required\)/);
  assert.match(breakHelp.stdout.join(''), /--force \(optional, boolean\)/);

  const recordHelp = createMemoryIo();
  assert.equal(
    await main(['candidate', 'record', '--help'], { ...recordHelp.io, env: {} }),
    EXIT.OK,
  );
  assert.match(recordHelp.stdout.join(''), /--ref \(required\)/);
  assert.match(recordHelp.stdout.join(''), /--service \(optional, repeatable\)/);
});

test('reconcile <id> resolves to its special-case subcommand help', async () => {
  const memory = createMemoryIo();
  const exitCode = await main(['reconcile', 'I-001', '--help'], { ...memory.io, env: {} });

  assert.equal(exitCode, EXIT.OK);
  const help = memory.stdout.join('');
  assert.match(help, /^Usage: pnpm coord reconcile <ID>/);
  assert.doesNotMatch(help, /Subcommands:/);
});

test('reconcile group help shows the real entry forms instead of <subcommand>', async () => {
  const memory = createMemoryIo();
  const exitCode = await main(['reconcile', '--help'], { ...memory.io, env: {} });

  assert.equal(exitCode, EXIT.OK);
  const help = memory.stdout.join('');
  // reconcile has no subcommand concept: it takes <ID> or --operation.
  assert.match(help, /^Usage: pnpm coord reconcile <ID> \| reconcile --operation <operation-id>$/m);
  assert.doesNotMatch(help, /reconcile <subcommand>/);
  // Both entry forms are still listed.
  assert.match(help, /^  reconcile --operation <ID>$/m);
  assert.match(help, /^  reconcile <ID>$/m);
});

test('an unknown subcommand falls back to the command group help', async () => {
  const memory = createMemoryIo();
  const exitCode = await main(['lifecycle', 'bogus', '--help'], { ...memory.io, env: {} });

  assert.equal(exitCode, EXIT.OK);
  assert.match(memory.stdout.join(''), /Subcommands:/);
});

test('a bare-only command shows its own help instead of an empty group', async () => {
  const memory = createMemoryIo();
  const exitCode = await main(['status', '--help'], { ...memory.io, env: {} });

  assert.equal(exitCode, EXIT.OK);
  const help = memory.stdout.join('');
  assert.match(help, /^Usage: pnpm coord status$/m);
  assert.doesNotMatch(help, /Subcommands:/);
  // A subcommand without options emits no Options section.
  assert.doesNotMatch(help, /Options:/);
});

test('an unknown command with --help is still rejected by the parser', async () => {
  const memory = createMemoryIo();
  const exitCode = await main(['unknown', '--help', '--json'], { ...memory.io, env: {} });

  assert.equal(exitCode, EXIT.GATE_FAILED);
  const error = JSON.parse(memory.stderr.join(''));
  assert.equal(error.code, 'CLI_USAGE');
  assert.equal(error.message, 'unknown command: unknown');
});

test('help is wrapped in the stable JSON envelope under --json', async () => {
  const memory = createMemoryIo();
  const exitCode = await main(['lifecycle', '--help', '--json'], { ...memory.io, env: {} });

  assert.equal(exitCode, EXIT.OK);
  const result = JSON.parse(memory.stdout.join(''));
  assert.equal(result.ok, true);
  assert.equal(result.code, 'OK');
  assert.equal(result.exitCode, 0);
  assert.equal(result.message, 'help');
  assert.match(result.data.help, /Subcommands:/);
});

test('executeBuiltin returns command help without touching the environment', async () => {
  const result = await executeBuiltin(parseArgs(['lock', '--help']), { env: {} });

  assert.equal(result.ok, true);
  assert.match(result.data.help, /^Usage: pnpm coord lock <subcommand> \[options\]/);
  assert.match(result.data.help, /lock acquire <resource> --requirement <ID> --ttl <ttl>/);
});
