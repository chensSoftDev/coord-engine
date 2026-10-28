#!/usr/bin/env node

// COORD_API_REFERENCE.md 生成器（I-134 F5）。
// 数据源是本引擎 lib/coordination/cli.mjs 导出的 commands registry（I-132 的
// 单源架构）：文档与 CLI metadata 永不漂移，`--check` 把这一点钉进
// test:coordination 套件。无第三方依赖。
// 引擎以 submodule 挂载后（I-249），TARGET 解析自调用方的 cwd（即 consuming
// 项目的 docs/ops/），引擎仓库内不保存该文档。

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REGISTRY, commandUsage, describeOption } from '../lib/coordination/cli.mjs';

const ROOT_DIR = process.env.COORD_CWD ?? process.cwd();
const TARGET = join(ROOT_DIR, 'docs', 'ops', 'COORD_API_REFERENCE.md');

const USAGE = `Usage: node .coord-engine/scripts/generate-api-reference.mjs [--check]

Regenerate the consuming project's docs/ops/COORD_API_REFERENCE.md from the
coordination CLI command registry (coord-engine lib/coordination/cli.mjs).
The document is machine generated; never edit it by hand.

Options:
  --check   compare only; exit 1 when the committed document drifted
  --help    show this message
`;

function cell(value) {
  return value.replace(/\|/g, '\\|');
}

export function renderApiReference() {
  const sections = REGISTRY.map((module) => {
    const rows = module.subcommands.map((subcommand) => {
      const options = subcommand.options.length > 0
        ? subcommand.options.map((name) => describeOption(subcommand, name)).join('<br>')
        : '—';
      const dryRun = subcommand.options.includes('dry-run') ? '✓' : '—';
      return `| \`${cell(subcommand.usage)}\` | ${cell(options)} | ${cell(subcommand.summary)} | ${dryRun} |`;
    });
    // Same rule as the CLI help (cli.mjs commandUsage): an explicit
    // groupUsage wins; a module whose only subcommand is the bare command
    // itself shows that subcommand's usage; everything else is a group.
    return `## pnpm coord ${module.command}\n\n${module.summary}\n\nUsage: \`pnpm coord ${commandUsage(module)}\`\n\n| Usage | Options | Summary | Dry-run |\n|---|---|---|---|\n${rows.join('\n')}`;
  });
  return `# Coordination CLI API Reference

> 机器生成，勿手改。重新生成：\`node .coord-engine/scripts/generate-api-reference.mjs\`
> （漂移检查：\`--check\`，由 test:coordination 套件强制执行）。
> 数据源：coord-engine（\`.coord-engine\` submodule）\`lib/coordination/cli.mjs\` 的 commands registry（I-132 单源架构）。

全局选项：\`--json\`（机器可读 JSON 输出）、\`--reuse-sha=<40-hex>\`（跳过首次
coordination fetch，复用已观测的 coordinationSha）、\`-h/--help\`。
支持 dry-run 的子命令在 Dry-run 列以 ✓ 标注。

${sections.join('\n\n')}
`;
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const check = argv.includes('--check');
  const document = renderApiReference();
  if (check) {
    let current = null;
    try {
      current = readFileSync(TARGET, 'utf8');
    } catch {
      current = null;
    }
    if (current !== document) {
      process.stderr.write(
        'docs/ops/COORD_API_REFERENCE.md is out of date; regenerate with: node .coord-engine/scripts/generate-api-reference.mjs\n',
      );
      return 1;
    }
    process.stdout.write('docs/ops/COORD_API_REFERENCE.md is up to date\n');
    return 0;
  }
  writeFileSync(TARGET, document);
  process.stdout.write('wrote docs/ops/COORD_API_REFERENCE.md\n');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
