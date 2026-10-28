import { spawnSync } from 'node:child_process';

function lockSections(text) {
  if (typeof text !== 'string' || !/^lockfileVersion:/m.test(text)) return null;
  const sections = new Map();
  let current = null;
  for (const line of text.split('\n')) {
    const heading = /^([A-Za-z][A-Za-z0-9]*):\s*$/.exec(line);
    if (heading) {
      current = heading[1];
      sections.set(current, []);
    } else if (current) sections.get(current).push(line);
  }
  for (const key of ['importers', 'packages', 'snapshots']) if (!sections.has(key)) return null;
  return sections;
}

function blocks(lines) {
  const result = new Map();
  let key = null;
  for (const line of lines) {
    const match = /^  (\S.*):(?:\s*\{\})?\s*$/.exec(line);
    if (match) {
      key = match[1].replace(/^['"]|['"]$/g, '');
      result.set(key, []);
    } else if (key !== null) result.get(key).push(line);
  }
  for (const value of result.values()) {
    while (value.at(-1) === '') value.pop();
  }
  return result;
}

function sameMapEntries(base, head) {
  return [...base].every(([key, value]) => head.has(key) && JSON.stringify(value) === JSON.stringify(head.get(key)));
}

function importerEntries(lines) {
  const entries = new Map();
  const structure = [];
  let section = null;
  let key = null;
  for (const line of lines) {
    const group = /^    ([^ ]+):\s*$/.exec(line);
    const dependency = /^      ([^:]+):\s*$/.exec(line);
    if (group) {
      section = group[1];
      key = null;
      structure.push(line);
    } else if (dependency && section) {
      // pnpm quotes keys that contain scoped-name characters (e.g.
      // `'@ant-design/icons':`); package.json never includes those quotes.
      key = `${section}/${dependency[1].replace(/^['"]|['"]$/g, '')}`;
      entries.set(key, [line]);
    } else if (key) {
      entries.get(key).push(line);
    } else {
      structure.push(line);
    }
  }
  return { entries, structure };
}

const PROTOTYPE_PACKAGE_PATH = 'apps/ux-prototype/package.json';
const IMPORTER_DEPENDENCY_SECTIONS = new Set([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]);

function declaredDependencies(packageJson, section) {
  const value = packageJson?.[section];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return new Set();
  return new Set(Object.keys(value));
}

// I-243 review: a lockfile-only dependency addition inside the prototype
// importer must be backed by a same-range declaration in
// apps/ux-prototype/package.json. Otherwise a prototype importer change could
// smuggle an arbitrary dependency into the repository with no reviewable
// manifest change. Every added entry must be newly declared (base has no such
// name in that section, head does); the package file itself must differ.
function prototypeAdditionsBoundToPackage({
  basePackageJson,
  headPackageJson,
  addedEntries,
  basePackageMayBeAbsent = false,
}) {
  if (addedEntries.length === 0) return true;
  if (typeof headPackageJson !== 'string') return false;
  if (basePackageJson === null) {
    // The prototype package itself may be introduced in this range; in that
    // case the base declares nothing. An existing importer without a base
    // package file is inconsistent and fails closed.
    if (!basePackageMayBeAbsent) return false;
  } else if (typeof basePackageJson !== 'string' || basePackageJson === headPackageJson) {
    return false;
  }
  let headPackage;
  let basePackage = null;
  try {
    headPackage = JSON.parse(headPackageJson);
    if (basePackageJson !== null) basePackage = JSON.parse(basePackageJson);
  } catch {
    return false;
  }
  if (
    (basePackageJson !== null && (!basePackage || typeof basePackage !== 'object' || Array.isArray(basePackage)))
    || !headPackage || typeof headPackage !== 'object' || Array.isArray(headPackage)
  ) return false;
  for (const entry of addedEntries) {
    const separator = entry.indexOf('/');
    const section = entry.slice(0, separator);
    const name = entry.slice(separator + 1);
    if (!IMPORTER_DEPENDENCY_SECTIONS.has(section)) return false;
    const baseDeclared = basePackage === null
      ? new Set()
      : declaredDependencies(basePackage, section);
    const headDeclared = declaredDependencies(headPackage, section);
    if (baseDeclared.has(name) || !headDeclared.has(name)) return false;
  }
  return true;
}

function dependencies(lines) {
  const refs = [];
  let name = null;
  for (const line of lines) {
    const importerName = /^      (.+):\s*$/.exec(line);
    if (importerName) name = importerName[1].replace(/^['"]|['"]$/g, '');
    const version = /^        version: (.+)$/.exec(line);
    if (version && name && !version[1].startsWith('link:')) refs.push(`${name}@${version[1]}`);
    const snapshotDependency = /^      (.+): (.+)$/.exec(line);
    if (snapshotDependency && !snapshotDependency[2].startsWith('link:')) {
      refs.push(`${snapshotDependency[1].replace(/^['"]|['"]$/g, '')}@${snapshotDependency[2]}`);
    }
  }
  return refs;
}

function reachablePrototypeRefs(importer, snapshots) {
  const reachable = new Set();
  const queue = dependencies(importer);
  while (queue.length > 0) {
    const ref = queue.pop();
    if (reachable.has(ref)) continue;
    reachable.add(ref);
    const snapshot = snapshots.get(ref);
    if (snapshot) queue.push(...dependencies(snapshot));
  }
  return reachable;
}

/** Content that can affect the prototype without including unrelated workspace importers. */
export function prototypeLockReviewContent(text) {
  const sections = lockSections(text);
  if (!sections) return null;
  const importers = blocks(sections.get('importers'));
  const importer = importers.get('apps/ux-prototype');
  if (!importer) return null;
  const packages = blocks(sections.get('packages'));
  const snapshots = blocks(sections.get('snapshots'));
  const reachable = reachablePrototypeRefs(importer, snapshots);
  const result = { importer, packages: {}, snapshots: {} };
  for (const ref of [...reachable].sort()) {
    if (snapshots.has(ref)) result.snapshots[ref] = snapshots.get(ref);
    const baseRef = ref.split('(')[0];
    if (packages.has(baseRef)) result.packages[baseRef] = packages.get(baseRef);
  }
  return JSON.stringify(result);
}

/**
 * Fail closed unless existing lock state is identical and additions belong
 * only to the prototype graph. New prototype dependency entries must also be
 * newly declared in the same-range apps/ux-prototype/package.json.
 */
export function prototypeOnlyLockfileChange(baseText, headText, {
  basePackageJson = null,
  headPackageJson = null,
} = {}) {
  const base = lockSections(baseText);
  const head = lockSections(headText);
  if (!base || !head) return false;
  const scalarHeaders = (text) => text.split('\n')
    .filter((line) => /^[A-Za-z][A-Za-z0-9]*:\s*\S/.test(line)).join('\n');
  if (scalarHeaders(baseText) !== scalarHeaders(headText)) return false;
  const otherSections = new Set([...base.keys(), ...head.keys()]);
  for (const key of otherSections) {
    if (['importers', 'packages', 'snapshots'].includes(key)) continue;
    if (JSON.stringify(base.get(key)) !== JSON.stringify(head.get(key))) return false;
  }
  const baseImporters = blocks(base.get('importers'));
  const headImporters = blocks(head.get('importers'));
  const basePrototype = baseImporters.get('apps/ux-prototype');
  const headPrototype = headImporters.get('apps/ux-prototype');
  if (!headPrototype) return false;
  const otherImporters = new Map(baseImporters);
  otherImporters.delete('apps/ux-prototype');
  if (!sameMapEntries(otherImporters, headImporters)
    || headImporters.size !== baseImporters.size + (basePrototype ? 0 : 1)) return false;
  let addedEntries;
  if (basePrototype) {
    const before = importerEntries(basePrototype);
    const after = importerEntries(headPrototype);
    if (JSON.stringify(before.structure) !== JSON.stringify(after.structure)
      || !sameMapEntries(before.entries, after.entries)) return false;
    addedEntries = [...after.entries.keys()].filter((key) => !before.entries.has(key));
  } else {
    // A brand-new prototype importer is still a dependency declaration: every
    // entry it introduces must be backed by package.json in the same range.
    addedEntries = [...importerEntries(headPrototype).entries.keys()];
  }
  if (!prototypeAdditionsBoundToPackage({
    basePackageJson,
    headPackageJson,
    addedEntries,
    basePackageMayBeAbsent: !basePrototype,
  })) return false;
  const basePackages = blocks(base.get('packages'));
  const headPackages = blocks(head.get('packages'));
  const baseSnapshots = blocks(base.get('snapshots'));
  const headSnapshots = blocks(head.get('snapshots'));
  if (!sameMapEntries(basePackages, headPackages) || !sameMapEntries(baseSnapshots, headSnapshots)) return false;
  const reachable = reachablePrototypeRefs(headImporters.get('apps/ux-prototype'), headSnapshots);
  const newlyAdded = (before, after) => [...after.keys()].filter((key) => !before.has(key));
  for (const key of newlyAdded(baseSnapshots, headSnapshots)) if (!reachable.has(key)) return false;
  for (const key of newlyAdded(basePackages, headPackages)) {
    if (![...reachable].some((ref) => ref === key || ref.startsWith(`${key}(`))) return false;
  }
  return true;
}

export function provePrototypeOnlyLockfile({ cwd, base, head }) {
  const at = (ref, path) => {
    const result = spawnSync('git', ['show', `${ref}:${path}`], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024,
    });
    return result.status === 0 ? result.stdout : null;
  };
  return prototypeOnlyLockfileChange(at(base, 'pnpm-lock.yaml'), at(head, 'pnpm-lock.yaml'), {
    basePackageJson: at(base, PROTOTYPE_PACKAGE_PATH),
    headPackageJson: at(head, PROTOTYPE_PACKAGE_PATH),
  });
}
