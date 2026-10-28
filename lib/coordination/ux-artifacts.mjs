import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';

import { assertRequirementId } from './validation.mjs';
import { inspectFeedbackArtifacts } from './feedback.mjs';
import { prototypeLockReviewContent } from './prototype-lockfile.mjs';

function git(cwd, args, { optional = false } = {}) {
  const result = spawnSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    if (optional) return null;
    throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function sectionBodies(markdown) {
  const sections = new Map();
  const matches = [...markdown.matchAll(/^##\s+\d+\.\s+(.+)\s*$/gm)];
  for (let index = 0; index < matches.length; index += 1) {
    const name = matches[index][1].trim();
    const from = matches[index].index + matches[index][0].length;
    const to = matches[index + 1]?.index ?? markdown.length;
    sections.set(name, markdown.slice(from, to).trim());
  }
  return sections;
}

const CHAPTERS = [
  '岗位与证据', '关键任务', '操作流程', '页面与信息层级',
  '交互与文案', '状态矩阵', '原型与试用任务', '评审决定',
];

/** Inspect only committed review material. This checks structure, not usability. */
export function inspectUxArtifacts({ cwd, id, ref = 'HEAD', requireFeedbackDefinitions = false }) {
  assertRequirementId(id);
  const commit = git(cwd, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  const tree = git(cwd, ['ls-tree', '-r', '--name-only', commit]).trim().split('\n').filter(Boolean);
  const matches = [...new Set(tree
    .filter((path) => path.startsWith(`docs/product/current/${id}-`) && path.endsWith('/UX_SPEC.md'))
    .map((path) => path.slice(0, path.lastIndexOf('/'))))];
  const scenarioPrefix = `apps/ux-prototype/src/scenarios/${id}/`;
  const scenarioPaths = tree.filter((path) => path.startsWith(scenarioPrefix));
  // Every tracked prototype file can affect the reviewed experience through imports,
  // assets or build configuration. Review the whole local tool conservatively —
  // except the local tooling scripts: they never enter the reviewed experience
  // (not imported by scenarios, not part of the build), and hashing them made
  // every in-flight UX approval stale whenever unrelated tooling changed
  // (the I-244 fingerprint-drift incident).
  const prototypePaths = tree.filter((path) => path.startsWith('apps/ux-prototype/')
    && !path.startsWith('apps/ux-prototype/scripts/'));
  const sharedPaths = prototypePaths.filter((path) => path.startsWith('apps/ux-prototype/src/shell/')
    || path.startsWith('apps/ux-prototype/src/theme/'));
  const packagePaths = [
    'apps/ux-prototype/package.json', 'apps/ux-prototype/src/main.tsx',
    'apps/ux-prototype/src/scenarios/index.ts', 'apps/ux-prototype/src/scenarios/manifest.ts',
    'apps/ux-prototype/vite.config.ts', 'pnpm-lock.yaml',
  ].filter((path) => tree.includes(path));
  const specPath = matches.length === 1 ? `${matches[0]}/UX_SPEC.md` : null;
  const reviewPaths = [...new Set([specPath, ...prototypePaths, 'pnpm-lock.yaml'].filter((path) => path && tree.includes(path)))].sort();
  const missing = [];
  if (matches.length !== 1) missing.push(`expected one ${id} UX_SPEC.md, found ${matches.length}`);
  if (!scenarioPaths.includes(`${scenarioPrefix}metadata.json`)) missing.push(`${scenarioPrefix}metadata.json missing`);
  if (!scenarioPaths.includes(`${scenarioPrefix}manifest.ts`)) missing.push(`${scenarioPrefix}manifest.ts missing`);
  if (scenarioPaths.length < 3) missing.push(`${id} scenario has no interactive screen source`);
  if (sharedPaths.length === 0) missing.push('prototype shell/theme missing');
  if (!packagePaths.includes('apps/ux-prototype/package.json')) missing.push('prototype package missing');

  const content = new Map();
  for (const path of reviewPaths) {
    const entry = git(cwd, ['ls-tree', commit, '--', path]).trim();
    if (entry.startsWith('120000 ')) { missing.push(`${path} is a symlink`); continue; }
    const value = git(cwd, ['show', `${commit}:${path}`], { optional: true });
    if (value === null) { missing.push(`${path} cannot be read`); continue; }
    content.set(path, value);
    try {
      if (lstatSync(join(cwd, path)).isSymbolicLink()) missing.push(`${path} is a symlink`);
    } catch { /* absent worktree files are checked by status below */ }
  }
  const worktreePaths = [
    `:(glob)docs/product/current/${id}-*/UX_SPEC.md`,
    'apps/ux-prototype/',
    ':(exclude)apps/ux-prototype/scripts/',
    'pnpm-lock.yaml',
  ];
  const dirty = git(cwd, ['status', '--porcelain', '--untracked-files=all', '--', ...worktreePaths]).trim();
  if (dirty) missing.push('reviewed UX files have uncommitted changes');

  if (specPath && content.has(specPath)) {
    const spec = content.get(specPath);
    if (/示例：|\b(?:TODO|TBD)\b/.test(spec)) missing.push('UX_SPEC still contains template examples or placeholders');
    const bodies = sectionBodies(spec);
    const chapterOrder = [...spec.matchAll(/^##\s+\d+\.\s+(.+)\s*$/gm)].map((match) => match[1].trim());
    if (JSON.stringify(chapterOrder) !== JSON.stringify(CHAPTERS)) missing.push('UX_SPEC must contain the eight chapters in order');
    for (const name of CHAPTERS) {
      if (!bodies.get(name) || bodies.get(name).replace(/\|[-\s]+\|/g, '').length < 12) {
        missing.push(`UX_SPEC chapter ${name} is empty`);
      }
    }
    const metadataPath = `${scenarioPrefix}metadata.json`;
    if (content.has(metadataPath)) {
      try {
        const metadata = JSON.parse(content.get(metadataPath));
        const screens = Array.isArray(metadata.screens) ? metadata.screens : [];
        const screenIds = screens.map((screen) => screen.id);
        if (metadata.requirementId !== id) missing.push('scenario requirementId differs');
        if (!metadata.role || !metadata.taskId || !metadata.title) missing.push('scenario role/task/title missing');
        if (metadata.taskId && !spec.includes(metadata.taskId)) missing.push(`task ${metadata.taskId} missing from UX_SPEC`);
        if (!metadata.entryState || !metadata.fixtures?.some((fixture) => fixture.id === metadata.entryState)) {
          missing.push('scenario entryState is unavailable');
        }
        if (screens.length < 1 || new Set(screenIds).size !== screenIds.length) missing.push('scenario screens missing or duplicated');
        const cited = [...new Set(spec.match(/\bS\d{2,}\b/g) ?? [])];
        for (const screenId of cited) if (!screenIds.includes(screenId)) missing.push(`screen ${screenId} missing from scenario manifest`);
        for (const screenId of screenIds) {
          if (!/^S\d{2,}$/.test(screenId) || !cited.includes(screenId)) {
            missing.push(`scenario screen ${screenId} is not documented in UX_SPEC`);
          }
        }
      } catch { missing.push('scenario metadata.json is invalid'); }
    }
  }
  const metadata = content.get(`${scenarioPrefix}metadata.json`);
  let screenIds = [];
  let scenario = null;
  try {
    scenario = JSON.parse(metadata ?? '{}');
    screenIds = scenario.screens?.map((screen) => screen.id) ?? [];
  } catch { /* diagnosed above */ }
  const interactiveSource = scenarioPaths.some((path) => /\.[jt]sx$/.test(path)
    && /onClick|onSubmit|<button|<Button/.test(content.get(path) ?? ''));
  if (!interactiveSource) missing.push('scenario has no interactive primary action source');
  const registry = content.get('apps/ux-prototype/src/scenarios/index.ts') ?? '';
  const registryImport = registry.match(new RegExp(`import\\s*\\{\\s*([A-Za-z_$][\\w$]*)\\s*\\}\\s*from\\s*['"]\\./${id}/manifest['"]`));
  const registryList = registry.match(/export\s+const\s+scenarios[^=]*=\s*\[([^\]]*)\]/s)?.[1] ?? '';
  if (!registryImport || !new RegExp(`\\b${registryImport[1]}\\b`).test(registryList)) {
    missing.push(`${id} scenario is not registered in scenarios/index.ts`);
  }
  const hash = createHash('sha256');
  for (const path of [...content.keys()].sort()) {
    const value = path === 'pnpm-lock.yaml'
      ? prototypeLockReviewContent(content.get(path))
      : content.get(path);
    if (value === null) missing.push('prototype lockfile importer is invalid');
    hash.update(path).update('\0').update(value ?? '').update('\0');
  }
  if (requireFeedbackDefinitions) {
    const definitions = inspectFeedbackArtifacts({ cwd, id, ref });
    for (const item of definitions.definitionMissing) missing.push(`${item.code}: ${item.message}`);
    // TRACEABILITY grows through design and implementation. Only the decisions
    // themselves belong to the user-approved UX identity.
    if (definitions.definitionsOk) hash.update('feedback-definitions\0').update(definitions.fingerprint).update('\0');
  }
  return {
    ok: missing.length === 0, specPath, scenarioPaths, scenario, screenIds, commit,
    fingerprint: hash.digest('hex'), missing,
  };
}
