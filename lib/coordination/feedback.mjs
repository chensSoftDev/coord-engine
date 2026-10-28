import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { join, posix } from 'node:path';
import { assertRequirementId } from './validation.mjs';

export const REVIEW_STAGES = Object.freeze(['requirements', 'ux', 'design', 'implementation', 'verification', 'release', 'closure']);
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const issue = (code, message) => ({ code, message });
const canonicalJson = (value) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

/** A reference is a repository file, never a glob, absolute path or line suffix. */
export function isSafeReviewPath(path) {
  return typeof path === 'string' && path.length > 0 && !/[\\\0\r\n:]/.test(path)
    && !path.startsWith('/') && path !== '.' && posix.normalize(path) === path
    && !path.split('/').some((part) => part === '..' || part === '.' || part === '.git' || part === '');
}

export function reviewRepository({ cwd, ref = 'HEAD' }) {
  const commit = git(cwd, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  const entries = new Map(git(cwd, ['ls-tree', '-r', '-z', commit]).split('\0').filter(Boolean).map((entry) => {
    const [metadata, path] = entry.split('\t');
    const [mode, type, oid] = metadata.split(' ');
    return [path, { mode, type, oid }];
  }));
  const regular = (path) => {
    if (!isSafeReviewPath(path) || !['100644', '100755'].includes(entries.get(path)?.mode)) return false;
    // Check every on-disk ancestor too: a directory symlink may hide a tracked file.
    let cursor = cwd;
    for (const part of path.split('/')) {
      cursor = join(cursor, part);
      try { if (lstatSync(cursor).isSymbolicLink()) return false; } catch { /* git/status diagnoses missing files */ }
    }
    return true;
  };
  const contents = new Map();
  let changed;
  const changedPaths = () => {
    if (changed) return changed;
    changed = new Set();
    const rows = git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']).split('\0').filter(Boolean);
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      changed.add(row.slice(3));
      if (/[RC]/.test(row.slice(0, 2))) changed.add(rows[++index]);
    }
    return changed;
  };
  return { cwd, commit, entries, regular, changedPaths,
    read(path) { if (!contents.has(path)) contents.set(path, git(cwd, ['show', `${commit}:${path}`])); return contents.get(path); },
    dirty: (paths) => paths.some((path) => changedPaths().has(path)) };
}

/** Checks structural provenance and references; it cannot prove semantic correctness. */
export function inspectFeedbackArtifacts({ cwd, id, ref = 'HEAD' }) {
  assertRequirementId(id);
  const repository = reviewRepository({ cwd, ref });
  const roots = [...new Set([...repository.entries.keys()]
    .filter((path) => path.startsWith(`docs/product/current/${id}-`) && path.endsWith('/FEEDBACK.json'))
    .map((path) => path.slice(0, path.lastIndexOf('/'))))];
  const missing = [];
  if ([...repository.changedPaths()].some((path) => path.startsWith(`docs/product/current/${id}-`) && path.endsWith('/FEEDBACK.json'))) {
    missing.push(issue('FEEDBACK_ARTIFACTS_DIRTY', 'feedback definitions have uncommitted changes, including possible duplicate definitions'));
  }
  let feedback = null; let traceability = null;
  const definitionPaths = roots.length === 1 ? [`${roots[0]}/FEEDBACK.json`] : [];
  const traceabilityPath = roots.length === 1 ? `${roots[0]}/TRACEABILITY.json` : null;
  if (roots.length !== 1) missing.push(issue('FEEDBACK_DEFINITIONS_MISSING', `expected one ${id} FEEDBACK.json, found ${roots.length}`));
  const read = (path, code) => {
    if (!repository.regular(path)) { missing.push(issue(code, `${path} must be a tracked regular file`)); return null; }
    if (repository.dirty([path])) missing.push(issue('FEEDBACK_ARTIFACTS_DIRTY', `${path} has uncommitted changes`));
    try { return JSON.parse(repository.read(path)); } catch { missing.push(issue(code, `${path} is not valid JSON`)); return null; }
  };
  if (definitionPaths.length) feedback = read(definitionPaths[0], 'FEEDBACK_DEFINITIONS_INVALID');
  const ids = new Set();
  const sourceValid = (source) => {
    if (!text(source) || /[\r\n\0]/.test(source)) return false;
    if (/^(?:user-message|review|issue|document):[A-Za-z0-9][A-Za-z0-9._:/#-]{2,}$/.test(source)) return true;
    if (source.startsWith('repo:')) return repository.regular(source.slice(5));
    try { const url = new URL(source); return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password; } catch { return false; }
  };
  if (feedback) {
    if (feedback.schemaVersion !== 1 || feedback.requirementId !== id || !Array.isArray(feedback.items)) {
      missing.push(issue('FEEDBACK_DEFINITIONS_INVALID', 'FEEDBACK.json needs schemaVersion 1, matching requirementId and items array'));
    } else for (const item of feedback.items) {
      if (!item || !/^[A-Za-z][A-Za-z0-9_-]{1,63}$/.test(item.id ?? '') || ids.has(item.id)
        || !sourceValid(item.source) || !text(item.expected) || !['accepted', 'deferred', 'rejected', 'pending'].includes(item.decision)
        || (['deferred', 'rejected'].includes(item.decision) && (!text(item.reason) || !sourceValid(item.decisionSource)))) {
        missing.push(issue('FEEDBACK_DEFINITIONS_INVALID', `feedback ${item?.id ?? '<missing>'} needs a unique stable ID, source, decision and expected result`));
      }
      ids.add(item?.id);
    }
  }
  const definitionMissing = [...missing];
  if (traceabilityPath && repository.entries.has(traceabilityPath)) {
    traceability = read(traceabilityPath, 'FEEDBACK_TRACEABILITY_INVALID');
    if (traceability && (traceability.schemaVersion !== 1 || traceability.requirementId !== id || !Array.isArray(traceability.items))) {
      missing.push(issue('FEEDBACK_TRACEABILITY_INVALID', 'TRACEABILITY.json needs schemaVersion 1, matching requirementId and items array'));
    } else if (traceability) {
      const mapped = new Set();
      for (const item of traceability.items) {
        if (!item || !ids.has(item.feedbackId) || mapped.has(item.feedbackId)) {
          missing.push(issue('FEEDBACK_TRACEABILITY_INVALID', `unknown or duplicate feedback mapping ${item?.feedbackId ?? '<missing>'}`));
        }
        mapped.add(item?.feedbackId);
        for (const stage of ['design', 'implementation', 'verification']) {
          if (item?.[stage] === undefined) continue;
          if (!Array.isArray(item[stage]) || item[stage].some((path) => !repository.regular(path))) {
            missing.push(issue('FEEDBACK_REFERENCE_INVALID', `${item?.feedbackId} ${stage} references must be tracked regular repository files`));
          } else if (repository.dirty(item[stage])) missing.push(issue('FEEDBACK_ARTIFACTS_DIRTY', `${item?.feedbackId} ${stage} references have uncommitted changes`));
        }
      }
    }
  }
  const hash = createHash('sha256');
  for (const path of definitionPaths) if (repository.regular(path) && feedback) {
    const semantic = { ...feedback, items: Array.isArray(feedback.items)
      ? [...feedback.items].sort((left, right) => String(left?.id ?? '').localeCompare(String(right?.id ?? '')))
      : feedback.items };
    hash.update(path).update('\0').update(canonicalJson(semantic)).update('\0');
  }
  return { ok: missing.length === 0, missing, definitionsOk: definitionMissing.length === 0, definitionMissing,
    definitionPaths, fingerprint: hash.digest('hex'),
    feedback, traceability, traceabilityPath, commit: repository.commit };
}

export function evaluateFeedbackReadiness({ cwd, requirement, stage, ref = 'HEAD', report }) {
  if (requirement.workflowVersion === undefined) return { ok: true, exempt: 'legacy', missing: [] };
  if (requirement.workflowVersion !== 2 || !REVIEW_STAGES.includes(stage)) {
    return { ok: false, missing: [issue('FEEDBACK_SCOPE_INVALID', 'workflowVersion 2 and a supported review stage are required')] };
  }
  let artifacts;
  try { artifacts = inspectFeedbackArtifacts({ cwd, id: requirement.id, ref }); } catch (error) {
    return { ok: false, missing: [issue('FEEDBACK_ARTIFACTS_INVALID', error.message)] };
  }
  const missing = [...artifacts.missing];
  const items = Array.isArray(artifacts.feedback?.items) ? artifacts.feedback.items : [];
  if (stage !== 'requirements' && items.some((item) => item?.decision === 'pending')) {
    missing.push(issue('FEEDBACK_DECISION_PENDING', 'resolve every pending feedback decision before design'));
  }
  const stageIndex = REVIEW_STAGES.indexOf(stage);
  const requiredMappings = ['design', 'implementation', 'verification'].filter((mapping) => REVIEW_STAGES.indexOf(mapping) <= stageIndex);
  const accepted = items.filter((item) => item?.decision === 'accepted');
  for (const item of accepted) {
    const mapping = artifacts.traceability?.items?.find?.((entry) => entry?.feedbackId === item.id);
    for (const kind of requiredMappings) if (!Array.isArray(mapping?.[kind]) || mapping[kind].length === 0) {
      missing.push(issue('FEEDBACK_MAPPING_MISSING', `${item.id} needs a ${kind} mapping in TRACEABILITY.json`));
    }
    if (report && !report.feedbackIds?.includes(item.id)) {
      missing.push(issue('FEEDBACK_REVIEW_COVERAGE_MISSING', `${item.id} is absent from the review report feedbackIds`));
    }
  }
  if (report && (!Array.isArray(report.feedbackIds) || report.feedbackIds.some((id) => !accepted.some((item) => item.id === id))
    || new Set(report.feedbackIds).size !== report.feedbackIds.length)) {
    missing.push(issue('FEEDBACK_REVIEW_COVERAGE_INVALID', 'report feedbackIds must contain each accepted feedback ID once and no unknown IDs'));
  }
  return { ok: missing.length === 0, missing, artifacts };
}
