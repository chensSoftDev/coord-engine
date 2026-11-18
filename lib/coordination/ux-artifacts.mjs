import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { join, posix } from 'node:path';

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

function readReviewContent({ cwd, commit, reviewPaths, missing }) {
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
  return content;
}

function assertCleanWorktree(cwd, worktreePaths, missing) {
  const dirty = git(cwd, ['status', '--porcelain', '--untracked-files=all', '--', ...worktreePaths]).trim();
  if (dirty) missing.push('reviewed UX files have uncommitted changes');
}

function validateSpecChapters(spec, missing) {
  if (/示例：|\b(?:TODO|TBD)\b/.test(spec)) missing.push('UX_SPEC still contains template examples or placeholders');
  const bodies = sectionBodies(spec);
  const chapterOrder = [...spec.matchAll(/^##\s+\d+\.\s+(.+)\s*$/gm)].map((match) => match[1].trim());
  if (JSON.stringify(chapterOrder) !== JSON.stringify(CHAPTERS)) missing.push('UX_SPEC must contain the eight chapters in order');
  for (const name of CHAPTERS) {
    if (!bodies.get(name) || bodies.get(name).replace(/\|[-\s]+\|/g, '').length < 12) {
      missing.push(`UX_SPEC chapter ${name} is empty`);
    }
  }
}

function finishFingerprint({ cwd, id, ref, content, requireFeedbackDefinitions, missing }) {
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
  return hash.digest('hex');
}

// I-254: the prototype became one living model. `src/scenarios/index.ts` is the
// seam between the two fingerprint schemes — legacy branches still carry it and
// keep v1 semantics untouched, the restructured tree fingerprints only the
// requirement's focus closure.
const SCENARIO_REGISTRY_PATH = 'apps/ux-prototype/src/scenarios/index.ts';
const PROTOTYPE_SRC_PREFIX = 'apps/ux-prototype/src/';
const MODULES_PREFIX = 'apps/ux-prototype/src/admin/modules/';

/** Which fingerprint scheme the prototype tree at `ref` is shaped for. */
export function prototypeScheme({ cwd, ref = 'HEAD' }) {
  const commit = git(cwd, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  const entry = git(cwd, ['ls-tree', commit, '--', SCENARIO_REGISTRY_PATH]).trim();
  return entry ? 'v1-scenarios' : 'v2-focus';
}

function specDirectoryMatches(tree, id) {
  return [...new Set(tree
    .filter((path) => path.startsWith(`docs/product/current/${id}-`) && path.endsWith('/UX_SPEC.md'))
    .map((path) => path.slice(0, path.lastIndexOf('/'))))];
}

/** Inspect only committed review material. This checks structure, not usability. */
export function inspectUxArtifacts({ cwd, id, ref = 'HEAD', requireFeedbackDefinitions = false }) {
  assertRequirementId(id);
  const commit = git(cwd, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  const tree = git(cwd, ['ls-tree', '-r', '--name-only', commit]).trim().split('\n').filter(Boolean);
  const shared = { cwd, id, ref, commit, tree, requireFeedbackDefinitions };
  return tree.includes(SCENARIO_REGISTRY_PATH)
    ? inspectScenarioWorld(shared)
    : inspectFocusWorld(shared);
}

function inspectScenarioWorld({ cwd, id, ref, commit, tree, requireFeedbackDefinitions }) {
  const matches = specDirectoryMatches(tree, id);
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

  const content = readReviewContent({ cwd, commit, reviewPaths, missing });
  const worktreePaths = [
    `:(glob)docs/product/current/${id}-*/UX_SPEC.md`,
    'apps/ux-prototype/',
    ':(exclude)apps/ux-prototype/scripts/',
    'pnpm-lock.yaml',
  ];
  assertCleanWorktree(cwd, worktreePaths, missing);

  if (specPath && content.has(specPath)) {
    const spec = content.get(specPath);
    validateSpecChapters(spec, missing);
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
  const fingerprint = finishFingerprint({ cwd, id, ref, content, requireFeedbackDefinitions, missing });
  return {
    ok: missing.length === 0, scheme: 'v1-scenarios', specPath, scenarioPaths, scenario, screenIds, commit,
    fingerprint, missing,
  };
}

// --- v2 focus scheme (I-254 living prototype) ---------------------------------
//
// The requirement declares its lens in `src/requirements/<ID>.json`: which
// modules it iterates (focusModules) and what the user should try
// (trialTasks). The fingerprint covers the declaration, every file of the
// focus module directories, the module files' relative-import closure within
// `src/`, and a fixed shared set (shell/stores/registry/types + package
// config + lockfile). Everything else in the living prototype belongs to
// other requirements and must not stale this requirement's approval.

const SHARED_DIR_PREFIXES = [
  'apps/ux-prototype/src/shell/',
  'apps/ux-prototype/src/admin/shell/',
  'apps/ux-prototype/src/admin/stores/',
];
const SHARED_FILES = [
  'apps/ux-prototype/src/admin/registry.ts',
  'apps/ux-prototype/src/admin/modules/types.ts',
  'apps/ux-prototype/src/requirements/types.ts',
];
const PACKAGE_FILES = [
  'apps/ux-prototype/package.json',
  'apps/ux-prototype/vite.config.ts',
  'apps/ux-prototype/tsconfig.json',
  'pnpm-lock.yaml',
];
// A module name becomes a git pathspec and a tree prefix; keep it a single
// safe path segment so declarations cannot escape the modules directory.
const MODULE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const IMPORT_SPEC_PATTERNS = [
  // import/export ... from './x' (named, namespace, type-only and re-exports)
  /(?:^|[;\n])\s*(?:import|export)\s[\s\S]*?from\s*['"](\.[^'"]+)['"]/g,
  // side-effect import './x'
  /(?:^|[;\n])\s*import\s*['"](\.[^'"]+)['"]/g,
  // dynamic import('./x')
  /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
];
// Bare TS/Vite resolution order: the literal path first, then extension
// completion, then directory index. Unresolvable specs are simply outside the
// tree (uncommitted or non-source) and are skipped.
const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.css', '.json', '/index.ts', '/index.tsx'];
const PARSEABLE_SOURCE = /\.(?:[cm]?[jt]sx?|css|json)$/;

function resolveRelativeImport(fromFile, spec, treeSet) {
  const base = posix.normalize(posix.join(posix.dirname(fromFile), spec));
  for (const suffix of RESOLVE_SUFFIXES) {
    const candidate = `${base}${suffix}`;
    if (candidate.startsWith(PROTOTYPE_SRC_PREFIX) && treeSet.has(candidate)) return candidate;
  }
  return null;
}

/** Transitive relative-import closure from the focus module files, within src/. */
function reachableClosure({ cwd, commit, treeSet, roots }) {
  const closure = [];
  const seen = new Set(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.pop();
    closure.push(file);
    if (!PARSEABLE_SOURCE.test(file)) continue;
    const source = git(cwd, ['show', `${commit}:${file}`], { optional: true });
    if (source === null) continue;
    for (const pattern of IMPORT_SPEC_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of source.matchAll(pattern)) {
        const resolved = resolveRelativeImport(file, match[1], treeSet);
        if (resolved && !seen.has(resolved)) {
          seen.add(resolved);
          queue.push(resolved);
        }
      }
    }
  }
  return closure;
}

function inspectFocusWorld({ cwd, id, ref, commit, tree, requireFeedbackDefinitions }) {
  const treeSet = new Set(tree);
  const missing = [];
  const matches = specDirectoryMatches(tree, id);
  if (matches.length !== 1) missing.push(`expected one ${id} UX_SPEC.md, found ${matches.length}`);
  const specPath = matches.length === 1 ? `${matches[0]}/UX_SPEC.md` : null;

  const existingModules = new Set(tree
    .filter((path) => path.startsWith(MODULES_PREFIX))
    .map((path) => path.slice(MODULES_PREFIX.length).split('/')[0]));

  const declarationPath = `apps/ux-prototype/src/requirements/${id}.json`;
  let declaration = null;
  let focusModules = [];
  if (!treeSet.has(declarationPath)) {
    missing.push(`${declarationPath} missing (focusModules + trialTasks)`);
  } else {
    const raw = git(cwd, ['show', `${commit}:${declarationPath}`], { optional: true });
    if (raw === null) {
      missing.push(`${declarationPath} cannot be read`);
    } else {
      try {
        declaration = JSON.parse(raw);
      } catch { /* diagnosed below */ }
      if (declaration === null || typeof declaration !== 'object' || Array.isArray(declaration)) {
        missing.push(`${declarationPath} is invalid JSON`);
        declaration = null;
      }
    }
  }
  if (declaration) {
    if (declaration.requirementId !== id) missing.push('requirement declaration requirementId differs');
    const declaredFocus = Array.isArray(declaration.focusModules) ? declaration.focusModules : [];
    focusModules = declaredFocus.filter((name) => typeof name === 'string' && name.trim().length > 0);
    if (focusModules.length === 0 || focusModules.length !== declaredFocus.length) {
      missing.push('focusModules missing');
    }
    for (const name of focusModules) {
      if (!MODULE_NAME_PATTERN.test(name) || !existingModules.has(name)) {
        missing.push(`focus module ${name} directory missing`);
      }
    }
    const trialTasks = Array.isArray(declaration.trialTasks) ? declaration.trialTasks : [];
    const moduleKnown = (name) => focusModules.includes(name) || existingModules.has(name);
    if (trialTasks.length === 0 || trialTasks.some((task) => !task || typeof task !== 'object'
      || typeof task.moduleId !== 'string' || !moduleKnown(task.moduleId))) {
      missing.push('trialTasks missing or reference unknown modules');
    }
  }
  const focusDirs = focusModules.filter((name) => MODULE_NAME_PATTERN.test(name) && existingModules.has(name));
  const focusPaths = tree.filter((path) => focusDirs.some((dir) => path.startsWith(`${MODULES_PREFIX}${dir}/`)));
  const closurePaths = reachableClosure({ cwd, commit, treeSet, roots: focusPaths });
  const sharedPaths = tree.filter((path) => SHARED_DIR_PREFIXES.some((prefix) => path.startsWith(prefix)));
  const sharedFiles = SHARED_FILES.filter((path) => treeSet.has(path));
  const packageFiles = PACKAGE_FILES.filter((path) => treeSet.has(path));
  if (!treeSet.has('apps/ux-prototype/package.json')) missing.push('prototype package missing');

  const reviewPaths = [...new Set([
    specPath, declarationPath, ...focusPaths, ...closurePaths, ...sharedPaths, ...sharedFiles, ...packageFiles,
  ].filter(Boolean))].sort();
  const content = readReviewContent({ cwd, commit, reviewPaths, missing });
  const worktreePaths = [
    `:(glob)docs/product/current/${id}-*/UX_SPEC.md`,
    ...focusDirs.map((dir) => `${MODULES_PREFIX}${dir}/`),
    ...closurePaths,
    ...SHARED_DIR_PREFIXES.map((prefix) => `:(glob)${prefix}**`),
    ...sharedFiles,
    ...packageFiles,
    ':(exclude)apps/ux-prototype/scripts/',
  ];
  assertCleanWorktree(cwd, worktreePaths, missing);

  if (specPath && content.has(specPath)) validateSpecChapters(content.get(specPath), missing);
  const fingerprint = finishFingerprint({ cwd, id, ref, content, requireFeedbackDefinitions, missing });
  return {
    ok: missing.length === 0, scheme: 'v2-focus', specPath, declarationPath, declaration,
    focusModules: focusDirs, scenarioPaths: [], scenario: null, screenIds: [], commit,
    fingerprint, missing,
  };
}
