// regression-red 耐久事实（I-113 Task 6）：main/夜间全仓回归失败写入
// `regressions/red.json`，记录失败 scope、main commit、日志与分类。原因未知
// 或与当前 candidate 服务重叠时阻断 merge/prod；已确认 infra/flaky 或无重叠
// 失败不阻断 dev 开发，但必须有责任人和修复/豁免记录。coordination-gate、
// merge-pr.sh 与 prod guard 读取同一事实，修复或人工豁免有显式清除记录。

import { assertRequirementId } from './validation.mjs';
import { actor, knownSession } from './leases.mjs';

const REGRESSION_PATH = 'regressions/red.json';
const CLASSIFICATIONS = new Set(['unknown', 'infra_flaky', 'confirmed_bug']);
const SERVICES = new Set(['account', 'api', 'gateway', 'web', 'admin']);

export class RegressionError extends Error {
  constructor(message, { code, exitCode = 14, data = {}, cause } = {}) {
    super(message, { cause });
    this.name = 'RegressionError';
    this.code = code;
    this.exitCode = exitCode;
    this.data = data;
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function normalizedServices(value) {
  const services = Array.isArray(value) ? value : [];
  const normalized = [...new Set(services.map((service) => String(service).trim()).filter(Boolean))].sort();
  if (normalized.some((service) => !SERVICES.has(service))) {
    throw new RegressionError('regression scope contains an unsupported service', {
      code: 'INVALID_REGRESSION_SCOPE',
      data: { services: normalized },
    });
  }
  return normalized;
}

function validClassification(value) {
  if (!CLASSIFICATIONS.has(value)) {
    throw new RegressionError(`invalid regression classification: ${value ?? '<missing>'}`, {
      code: 'INVALID_REGRESSION_CLASSIFICATION',
      data: { classification: value ?? null },
    });
  }
  return value;
}

function regressionFactFromSnapshot(snapshot) {
  if (!snapshot.has(REGRESSION_PATH)) return null;
  let fact;
  try {
    fact = snapshot.readJson(REGRESSION_PATH);
  } catch (error) {
    throw new RegressionError('invalid regression-red fact', {
      code: 'INVALID_REGRESSION_STATE',
      cause: error,
    });
  }
  const valid = fact !== null
    && typeof fact === 'object'
    && !Array.isArray(fact)
    && fact.schemaVersion === 1
    && /^[a-f0-9]{40}$/.test(fact.mainCommit ?? '')
    && Array.isArray(fact.scope)
    && CLASSIFICATIONS.has(fact.classification)
    && isNonEmptyString(fact.logPath)
    && isNonEmptyString(fact.runner)
    && isNonEmptyString(fact.recordedAt)
    && !Number.isNaN(Date.parse(fact.recordedAt))
    && (fact.status === 'active' || fact.status === 'cleared');
  if (!valid) throw new RegressionError('invalid regression-red fact', {
    code: 'INVALID_REGRESSION_STATE',
  });
  return fact;
}

export async function showRegressionRed({ store }) {
  const snapshot = await store.readSnapshot();
  const fact = regressionFactFromSnapshot(snapshot);
  if (!fact || fact.status !== 'active') return null;
  return fact;
}

function requireOwner(owner) {
  if (!isNonEmptyString(owner)) {
    throw new RegressionError('a regression record requires an owner', {
      code: 'MISSING_REGRESSION_OWNER',
    });
  }
  return owner.trim();
}

// Record an active regression-red fact. Every asynchronous regression failure
// must land here so merge/prod guards can fail closed.
export async function recordRegressionRed({
  store,
  cwd,
  mainCommit,
  scope,
  logPath,
  classification,
  runner,
  owner = null,
  session = null,
  clock = () => new Date(),
}) {
  if (!/^[a-f0-9]{40}$/.test(mainCommit ?? '')) {
    throw new RegressionError('regression main commit must be a full 40-character SHA', {
      code: 'INVALID_REGRESSION_COMMIT',
    });
  }
  const services = normalizedServices(scope);
  const label = validClassification(classification);
  if (!isNonEmptyString(logPath) || !isNonEmptyString(runner)) {
    throw new RegressionError('regression log path and runner are required', {
      code: 'MISSING_REGRESSION_BINDING',
    });
  }
  // Only infra_flaky must carry an owner: a flaky harness is actionable by its
  // owner, while unknown/confirmed_bug keep the owner optional (I-128/L14).
  const factOwner = label === 'infra_flaky' ? requireOwner(owner) : (owner ? owner.trim() : null);
  const localSession = session ? knownSession(cwd, session) : null;
  const now = clock();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new RegressionError('regression clock returned an invalid date', {
      code: 'INVALID_REGRESSION_CLOCK',
    });
  }

  let fact;
  const update = await store.update({
    operation: 'record regression-red',
    auditData: {
      kind: 'regression',
      action: 'record',
      mainCommit,
      classification: label,
      runner,
    },
    mutate(snapshot) {
      fact = {
        schemaVersion: 1,
        mainCommit,
        scope: services,
        logPath: logPath.trim(),
        classification: label,
        runner: runner.trim(),
        ...(factOwner ? { owner: factOwner } : {}),
        status: 'active',
        recordedAt: now.toISOString(),
        ...(localSession ? { actor: actor(localSession) } : {}),
      };
      snapshot.writeJson(REGRESSION_PATH, fact);
    },
  });

  return {
    ...fact,
    operationId: update.operationId,
    coordinationSha: update.sha,
  };
}

// Resolve whether the current regression-red fact blocks a merge/release for
// the given services. Unknown cause blocks everything; a confirmed fact only
// blocks when the failed scope overlaps the requested services.
export async function resolveRegressionBlock({ store, services = [] }) {
  const snapshot = await store.readSnapshot();
  const fact = regressionFactFromSnapshot(snapshot);
  if (!fact || fact.status !== 'active') {
    return { blocked: false, code: null, fact: null };
  }
  if (fact.classification === 'unknown') {
    return { blocked: true, code: 'REGRESSION_RED_UNKNOWN', fact };
  }
  const requested = new Set(normalizedServices(services));
  const overlap = fact.scope.filter((service) => requested.has(service));
  if (overlap.length > 0) {
    return {
      blocked: true,
      code: 'REGRESSION_RED_SCOPE_OVERLAP',
      fact,
      overlap,
    };
  }
  return { blocked: false, code: null, fact };
}

// Clear the active fact with an explicit reason and owner (fix or exemption).
export async function clearRegressionRed({
  store,
  cwd,
  reason,
  owner,
  session = null,
  clock = () => new Date(),
}) {
  if (!isNonEmptyString(reason)) {
    throw new RegressionError('clearing regression-red requires a reason', {
      code: 'MISSING_REGRESSION_REASON',
    });
  }
  const factOwner = requireOwner(owner);
  const localSession = session ? knownSession(cwd, session) : null;
  const now = clock();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new RegressionError('regression clock returned an invalid date', {
      code: 'INVALID_REGRESSION_CLOCK',
    });
  }

  let cleared;
  const update = await store.update({
    operation: 'clear regression-red',
    auditData: {
      kind: 'regression',
      action: 'clear',
      reason: reason.trim(),
      owner: factOwner,
    },
    mutate(snapshot) {
      const current = regressionFactFromSnapshot(snapshot);
      if (!current || current.status !== 'active') {
        throw new RegressionError('no active regression-red fact to clear', {
          code: 'REGRESSION_RED_NOT_FOUND',
          data: {},
        });
      }
      cleared = {
        ...current,
        status: 'cleared',
        clearReason: reason.trim(),
        clearedBy: factOwner,
        clearedAt: now.toISOString(),
        ...(localSession ? { clearedActor: actor(localSession) } : {}),
      };
      snapshot.writeJson(REGRESSION_PATH, cleared);
    },
  });

  return {
    ...cleared,
    operationId: update.operationId,
    coordinationSha: update.sha,
  };
}

// Narrow helper for guard consumers that only need a requirement-scoped block
// check; kept for symmetry with the other coordination fact modules.
export function assertRegressionRequirementId(id) {
  try {
    return assertRequirementId(id);
  } catch (error) {
    throw new RegressionError(error.message, {
      code: 'INVALID_REQUIREMENT_ID',
      cause: error,
    });
  }
}
