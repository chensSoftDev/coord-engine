// dev freeze fact（I-113 Task 3）：机器验证全绿后，把 active dev lease 原子
// 转换为无自动 TTL 的 awaiting_human freeze fact，并绑定 candidateId、dev
// 部署快照与机器验证证据（三者缺一即拒绝）。lease 槽位在同一次 coordination
// 更新中清空；freeze 的清除只属于后续 accept/reject/release 路径，不在本切片内。
// lease 持有/过期/身份判定复用 leases.mjs 的窄公共原语
// consumeActiveLeaseInSnapshot，本模块不复制所有权语义；协调写入复用窄内部导出
// updateLeaseState（audit metadata kind='lease'、action='freeze'、本地 operation
// record pending/uncertain/applied），使 exit 15 不确定推送与 acquire/release/break
// 一样可由 reconcileLeaseOperation 闭环并清理本地 lease token。
// I-247（生产事故 2026-10-31）：freeze 事实锚定 enter 时的当前修订 commit（而非
// 只在显式 renew 时浮动的 lease commit），并在 workflow v2 冻结前按发布清单
// 校验 dev 部署快照的服务覆盖，缺口不再推迟到 release-prod 才暴露。

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { assertRequirementId, normalizeDuration } from './validation.mjs';
import { isBacklogProjectionDescendant } from './repository-projection.mjs';
import { classifyRevisionRange } from './revision-policy.mjs';
import {
  actor,
  assertLease,
  consumeActiveLeaseInSnapshot,
  currentRevision,
  freezeFactFromSnapshot,
  knownSession,
  lockFromSnapshot,
  releaseLocalLeaseToken,
  resolvedToken,
  updateLeaseState,
  writeLocalLeaseToken,
} from './leases.mjs';
import { evidencePath, parseManifest, validateTestEvidence } from './evidence.mjs';
import { evaluateReviewReadiness } from './reviews.mjs';
import { scenarioAcceptanceRequired, validateScenarioHandoff } from './acceptance-scenarios.mjs';
import { inspectFeedbackArtifacts } from './feedback.mjs';
import { revisionMatchesDeployment } from './leases.mjs';
import { uiAcceptanceRequired, validateUiAcceptanceReport, userAcceptanceStageRequired, resolveAcceptanceFact,
  acceptanceAttemptId, acceptanceAttemptPath } from './ui-acceptance.mjs';
import { projectBacklog } from './lifecycle.mjs';
import { assertMixedSourcesClean, frontendContentIdentity, probeManagedFrontend, validateMixedEnvironment } from './mixed-environments.mjs';
import { evaluateUxReadiness } from './ux-approvals.mjs';

const FREEZE_RESOURCE = 'dev';
const FREEZE_STATE = 'awaiting_human';
const DEFAULT_REJECT_TTL = '8h';

function evidenceNeutralDescendant(cwd, id, fromSha, toSha) {
  try {
    const drift = classifyRevisionRange({ cwd, requirementId: id, fromSha, toSha });
    return drift.valid && drift.classification === 'evidence-neutral';
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// I-247（生产事故 2026-10-31）：混合全量清单冻结的早期服务覆盖校验。
// 一次 backend-only dev 部署（serviceSnapshots 缺 web/admin）曾连续通过
// freeze enter 与人工 accept，直到 release-prod 的混合等价校验才暴露缺口。
// 修复在创建 freeze fact 之前，按发布清单 RELEASE_SERVICES 逐服务核对
// 调用方传入的 dev 部署快照，把拦截点提前到冻结入口。
// ---------------------------------------------------------------------------

// 判断某个清单服务在 dev 部署快照里是否有可用的不可变身份。事实形状与
// mixed-environments.mjs deployedFrontendInputs 保持一致：serviceSnapshots
// 里的显式事实优先；否则回退到顶层 services/commit/artifacts 兜底事实。
// 两条路径都要求 40 位 commit、sha256 imageId、非空且无空白的 imageTag、
// manifest/sourceSnapshot 的 64 位 sha256，且不得是 serviceOverride。
function usableDevServiceFact(deployment, service) {
  const hex = (value, length) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
  // 顶层兜底事实必须来自一次 schemaVersion 2 的 dev 全量记录（与
  // deployedFrontendInputs 的顶层约束一致），服务覆盖记录不可作为发布身份。
  if (
    deployment?.schemaVersion !== 2
    || deployment?.stage !== 'dev'
    || deployment?.serviceOverride === true
    || !hex(deployment?.commit, 40)
    || !hex(deployment?.manifest?.sha256, 64)
    || !hex(deployment?.sourceSnapshot?.sha256, 64)
    || (deployment?.serviceSnapshots != null && (typeof deployment.serviceSnapshots !== 'object' || Array.isArray(deployment.serviceSnapshots)))
  ) {
    return false;
  }
  // 显式记录但畸形的服务事实不允许回退到别的快照（fail-closed）。
  const fact = Object.hasOwn(deployment.serviceSnapshots ?? {}, service)
    ? deployment.serviceSnapshots[service]
    : Array.isArray(deployment.services) && deployment.services.includes(service)
      ? {
        commit: deployment.commit,
        artifact: deployment.artifacts?.[service],
        manifest: deployment.manifest,
        sourceSnapshot: deployment.sourceSnapshot,
      }
      : null;
  return fact?.serviceOverride !== true
    && hex(fact?.commit, 40)
    && /^sha256:[a-f0-9]{64}$/.test(fact?.artifact?.imageId ?? '')
    && typeof fact?.artifact?.imageTag === 'string'
    && fact.artifact.imageTag !== ''
    && !/\s/.test(fact.artifact.imageTag)
    && hex(fact?.manifest?.sha256, 64)
    && hex(fact?.sourceSnapshot?.sha256, 64);
}

// 读取 deploy/release-manifests/<freeze version>.env 的 RELEASE_SERVICES 并
// 校验每个服务都有可用的 dev 身份。清单缺失时静默跳过——非发布流程
// （尚未生成清单）的冻结行为保持不变。
export function assertReleaseServiceCoverage({ cwd, requirement, deploymentSnapshot, mixedEnvironment }) {
  const version = requirement?.version;
  if (typeof version !== 'string' || version.trim() === '') return;
  const manifestFile = resolve(cwd, 'deploy', 'release-manifests', `${version}.env`);
  if (!existsSync(manifestFile)) return;
  const fields = parseManifest(readFileSync(manifestFile, 'utf8'));
  const services = fields.RELEASE_SERVICES === 'none'
    ? []
    : (fields.RELEASE_SERVICES ?? '').split(',').map((service) => service.trim()).filter(Boolean);
  const local = mixedEnvironment && !mixedEnvironment.invalidated && mixedEnvironment.requirementId === requirement.id
    && mixedEnvironment.version === requirement.version && mixedEnvironment.frontend?.buildValidated === true
    && /^[a-f0-9]{64}$/.test(mixedEnvironment.frontend?.inputsSha256 ?? '')
    && JSON.stringify(mixedEnvironment.backend?.deployment) === JSON.stringify(deploymentSnapshot)
    ? mixedEnvironment.frontend.app : null;
  const missing = services.filter((service) => service !== local && !usableDevServiceFact(deploymentSnapshot, service));
  if (missing.length > 0) {
    throw new FreezeError(
      `dev 部署快照缺少发布清单声明的服务身份：${missing.join(', ')}`
        + `（清单 deploy/release-manifests/${version}.env，快照 commit ${deploymentSnapshot?.commit ?? '<missing>'}）。`
        + '请先把缺失服务部署到 dev 并执行 pnpm coord deployment record dev，再重新 freeze enter；'
        + '每个发布服务须有当前候选内的不可变身份；本地受控主前端以外的前端仍须真实 dev 快照。',
      {
        code: 'FREEZE_SERVICE_COVERAGE_MISSING',
        exitCode: 11,
        data: { version, manifestServices: services, missing },
      },
    );
  }
}

function projectAcceptance({ cwd, id, from, to }) {
  try { return projectBacklog({ cwd, id, from, to }); }
  catch (cause) { throw new FreezeError('acceptance fact saved; reconcile its lifecycle projection before continuing', {
    code: 'PROJECTION_UNCERTAIN', exitCode: 15, cause,
    data: { id, lifecycle: to, requiredActions: [`pnpm coord reconcile ${id} --json`] },
  }); }
}

function advanceAcceptance(snapshot, id, from, to, at) {
  const path = `requirements/${id}.json`;
  const requirement = snapshot.readJson(path);
  if (requirement.lifecycle !== from) throw new FreezeError(`expected ${from} before acceptance transition`, { code: 'ACCEPTANCE_STATE_INVALID', exitCode: 12 });
  snapshot.writeJson(path, { ...requirement, lifecycle: to, updatedAt: at,
    lifecycleHistory: [...(requirement.lifecycleHistory ?? []), { type: 'advance', from, to, at }] });
}

function assertAcceptanceSourcesClean(cwd, id) {
  try { assertMixedSourcesClean({ cwd, requirementId: id }); }
  catch (cause) { throw new FreezeError('commit verified sources before recording the human acceptance candidate or decision', {
    code: 'FREEZE_DIRTY_SOURCES', cause,
  }); }
}

export class FreezeError extends Error {
  constructor(message, { code, exitCode = 14, data = {}, cause } = {}) {
    super(message, { cause });
    this.name = 'FreezeError';
    this.code = code;
    this.exitCode = exitCode;
    this.data = data;
  }
}

function freezePath(resource) {
  return `freezes/${resource}.json`;
}

function validateId(id) {
  try {
    return assertRequirementId(id);
  } catch (error) {
    throw new FreezeError(error.message, { code: 'INVALID_REQUIREMENT_ID', cause: error });
  }
}

function nowFrom(clock) {
  const now = clock();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new FreezeError('freeze clock returned an invalid date', {
      code: 'INVALID_FREEZE_CLOCK',
    });
  }
  return now;
}

function requireBinding({ candidateId, deploymentSnapshot, machineVerificationEvidence }) {
  const missing = [];
  if (typeof candidateId !== 'string' || candidateId.trim() === '') missing.push('candidateId');
  if (
    deploymentSnapshot === null
    || typeof deploymentSnapshot !== 'object'
    || Array.isArray(deploymentSnapshot)
  ) {
    missing.push('deploymentSnapshot');
  }
  if (typeof machineVerificationEvidence !== 'string' || machineVerificationEvidence.trim() === '') {
    missing.push('machineVerificationEvidence');
  }
  if (missing.length > 0) {
    throw new FreezeError(
      `freeze requires ${missing.join(', ')}`,
      { code: 'MISSING_FREEZE_BINDING', data: { missing } },
    );
  }
}

// Read the current durable freeze fact for a resource, or null when the
// resource is not frozen. Parsing and validation come from the shared
// freezeFactFromSnapshot helper in leases.mjs: a malformed fact fails closed
// with INVALID_FREEZE_STATE.
export async function showFreeze({ store, resource = FREEZE_RESOURCE }) {
  if (resource !== FREEZE_RESOURCE) {
    throw new FreezeError(`freeze facts only apply to the dev resource: ${resource}`, {
      code: 'INVALID_FREEZE_RESOURCE',
    });
  }
  const snapshot = await store.readSnapshot();
  return freezeFactFromSnapshot(snapshot, resource);
}

async function probeSharedAcceptanceFrontend({ candidate, evidence, baseUrl, fetcher, clock }) {
  const mismatch = () => { throw new FreezeError('resume must use the verified shared frontend and deployment identity', { code: 'ACCEPTANCE_FRONTEND_IDENTITY_CHANGED' }); };
  if (evidence?.outcome !== 'passed' || evidence.environment?.kind !== 'shared-dev'
    || evidence.requirement?.id !== candidate.requirementId || evidence.requirement.version !== candidate.version
    || (evidence.requirement.validationEpoch ?? 0) !== candidate.validationEpoch
    || JSON.stringify(evidence.environment.devSnapshot) !== JSON.stringify(candidate.deploymentSnapshot)) mismatch();
  const services = (candidate.deploymentSnapshot.services ?? []).filter(service => ['admin', 'web'].includes(service));
  if (!services.length || services.some(service => !usableDevServiceFact(candidate.deploymentSnapshot, service))) mismatch();
  const targets = services.map(service => {
    const expected = `https://${service}-dev.hongli-ruian.com`;
    const recorded = evidence.environment.targets?.[service === 'admin' ? 'adminBaseUrl' : 'e2eBaseUrl'];
    if (recorded && recorded.replace(/\/$/, '') !== expected) mismatch();
    return expected;
  });
  if (typeof baseUrl !== 'string' || !targets.includes(baseUrl.replace(/\/$/, ''))) mismatch();
  for (const origin of targets) {
    try {
      const response = await fetcher(`${origin}/api/health`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
      if (!response.ok || (await response.json()).status !== 'ok') throw new Error('frontend health did not pass');
    } catch (cause) {
      throw new FreezeError(`shared frontend health is unavailable: ${origin}`, { code: 'ACCEPTANCE_FRONTEND_UNHEALTHY', cause });
    }
  }
  return { mode: 'shared-dev', targets, checkedAt: clock().toISOString() };
}

export async function resumeFreeze({ store, cwd, requirementId, baseUrl, session, clock = () => new Date(), fetcher = fetch }) {
  const id = validateId(requirementId);
  const localSession = knownSession(cwd, session);
  const before = await store.readSnapshot();
  const candidate = resolveAcceptanceFact(before, id);
  const requirement = before.readJson(`requirements/${id}.json`);
  const mixedPath = `environments/${id}/mixed-dev.json`;
  const environment = before.has(mixedPath) ? before.readJson(mixedPath) : null;
  if (!candidate?.attemptId || candidate.acceptance || !['active', 'paused'].includes(candidate.windowState)
    || requirement.lifecycle !== 'user_acceptance' || candidate.version !== requirement.version
    || candidate.validationEpoch !== (requirement.validationEpoch ?? 0)
    || (candidate.mixedEnvironmentIdentity ? environment?.schemaVersion !== 2 : environment !== null)) {
    throw new FreezeError('resume requires the current pending acceptance attempt; released candidates require a classified feedback batch', {
      code: 'ACCEPTANCE_RESUME_INVALID', data: { requiredActions: [`pnpm coord lifecycle rework-batch ${id} --batch <file> --json`] },
    });
  }
  assertAcceptanceSourcesClean(cwd, id);
  const revision = currentRevision(cwd);
  if (revision.branch !== candidate.branch || (revision.commit !== candidate.commit
    && !evidenceNeutralDescendant(cwd, id, candidate.commit, revision.commit))) {
    throw new FreezeError('candidate inputs changed; classify the change before resuming', { code: 'FREEZE_EVIDENCE_MISMATCH', exitCode: 11 });
  }
  const evidenceBytes = readFileSync(evidencePath({ cwd, id }));
  const evidenceSha = createHash('sha256').update(evidenceBytes).digest('hex');
  if (evidenceSha !== candidate.machineVerificationEvidence) throw new FreezeError('machine evidence changed after freezing', { code: 'FREEZE_EVIDENCE_MISMATCH', exitCode: 11 });
  const occupied = freezeFactFromSnapshot(before, 'dev');
  if (occupied && (occupied.requirementId !== id || occupied.attemptId !== candidate.attemptId)) {
    throw new FreezeError('another candidate owns the human acceptance window', { code: 'FREEZE_EXISTS', exitCode: 10 });
  }
  let lease = null;
  if (!occupied) lease = await assertLease({ store, cwd, resource: 'dev', requirementId: id, session: localSession, clock });
  const deployment = before.has('deployments/dev.json') ? before.readJson('deployments/dev.json') : null;
  let frontend;
  let resumedEnvironment;
  let health;
  if (environment) {
    frontend = await probeManagedFrontend({ cwd, baseUrl });
    if (JSON.stringify(frontendContentIdentity(frontend)) !== JSON.stringify(frontendContentIdentity(environment.frontend))) {
      throw new FreezeError('resume must use the exact preserved frontend artifact', { code: 'MIXED_FRONTEND_IDENTITY_CHANGED', exitCode: 11 });
    }
    resumedEnvironment = { ...environment, frontend };
    await validateMixedEnvironment({ cwd, requirement, environment: resumedEnvironment, devLease: lease,
      devSnapshot: deployment, freeze: candidate, clock });
  } else {
    if (JSON.stringify(deployment) !== JSON.stringify(candidate.deploymentSnapshot)) {
      throw new FreezeError('shared deployment changed after candidate verification', { code: 'ACCEPTANCE_DEPLOYMENT_CHANGED', exitCode: 11 });
    }
    health = await probeSharedAcceptanceFrontend({ candidate, evidence: JSON.parse(evidenceBytes), baseUrl, fetcher, clock });
  }
  const update = await store.update({ operation: `resume human acceptance ${id}`, auditData: { requirementId: id, attemptId: candidate.attemptId, actor: actor(localSession) }, mutate(snapshot) {
    const latest = resolveAcceptanceFact(snapshot, id);
    const currentRequirement = snapshot.readJson(`requirements/${id}.json`);
    const currentEnvironment = snapshot.has(mixedPath) ? snapshot.readJson(mixedPath) : null;
    if (latest?.attemptId !== candidate.attemptId || latest.acceptance || latest.validationEpoch !== (snapshot.readJson(`requirements/${id}.json`).validationEpoch ?? 0)
      || latest.windowState !== candidate.windowState || currentRequirement.lifecycle !== 'user_acceptance'
      || currentRequirement.version !== candidate.version
      || (environment ? !currentEnvironment || currentEnvironment.invalidated || currentEnvironment.identitySha256 !== environment.identitySha256 : currentEnvironment !== null)
      || JSON.stringify(snapshot.readJson('deployments/dev.json')) !== JSON.stringify(candidate.deploymentSnapshot)) {
      throw new FreezeError('candidate or backend identity changed while resuming', { code: 'FREEZE_EVIDENCE_MISMATCH', exitCode: 11 });
    }
    assertAcceptanceSourcesClean(cwd, id);
    if (currentRevision(cwd).commit !== revision.commit
      || createHash('sha256').update(readFileSync(evidencePath({ cwd, id }))).digest('hex') !== evidenceSha) {
      throw new FreezeError('candidate sources or evidence changed while resuming', { code: 'FREEZE_EVIDENCE_MISMATCH', exitCode: 11 });
    }
    const currentWindow = freezeFactFromSnapshot(snapshot, 'dev');
    if (currentWindow && (currentWindow.requirementId !== id || currentWindow.attemptId !== candidate.attemptId)) {
      throw new FreezeError('another candidate owns dev', { code: 'FREEZE_EXISTS', exitCode: 10 });
    }
    if (!currentWindow) {
      if (!lease) throw new FreezeError('acceptance window was paused during resume; acquire its lease', { code: 'ACCEPTANCE_RESUME_INVALID' });
      consumeActiveLeaseInSnapshot({ snapshot, cwd, resource: 'dev', requirementId: id, session: localSession,
        ownerToken: lease.ownerToken, now: nowFrom(clock), eventType: 'freeze', eventActor: actor(localSession) });
    }
    const { windowState, ...frozen } = latest;
    snapshot.writeJson('freezes/dev.json', frozen);
    if (resumedEnvironment) snapshot.writeJson(mixedPath, resumedEnvironment);
    snapshot.writeJson(`acceptance/${id}/current.json`, { schemaVersion: 1, requirementId: id, attemptId: candidate.attemptId,
      state: 'active', resumedAt: clock().toISOString(), ...(frontend ? { instanceId: frontend.instanceId } : { health }) });
  } });
  if (lease) releaseLocalLeaseToken({ cwd, resource: 'dev', session: localSession });
  return { ...candidate, windowState: 'active', ...(frontend ? { frontend } : { health }),
    limitations: ['Resume verifies the recorded deployment snapshot and frontend content/health; it does not prove absence of out-of-band database schema or fixture changes.'],
    operationId: update.operationId, coordinationSha: update.sha };
}

// Atomically convert the caller's active dev lease into a durable freeze fact
// bound to candidateId, the dev deployment snapshot and the machine
// verification evidence. The session must hold the lease for the same
// requirement at the current working-tree revision; the conversion is a single
// coordination update so the queue never observes a state where both the lease
// is gone and the freeze is missing.
export async function enterFreeze({
  store,
  cwd,
  resource = FREEZE_RESOURCE,
  requirementId,
  candidateId,
  deploymentSnapshot,
  machineVerificationEvidence,
  session,
  clock = () => new Date(),
}) {
  if (resource !== FREEZE_RESOURCE) {
    throw new FreezeError(`freeze facts only apply to the dev resource: ${resource}`, {
      code: 'INVALID_FREEZE_RESOURCE',
    });
  }
  const safeId = validateId(requirementId);
  requireBinding({ candidateId, deploymentSnapshot, machineVerificationEvidence });
  const localSession = knownSession(cwd, session);
  const revision = currentRevision(cwd);
  const initial = await store.readSnapshot();
  const initialRequirement = initial.has(`requirements/${safeId}.json`) ? initial.readJson(`requirements/${safeId}.json`) : null;
  const existingAttempt = resolveAcceptanceFact(initial, safeId);
  const mixedIdentity = snapshot => snapshot.has(`environments/${safeId}/mixed-dev.json`)
    ? snapshot.readJson(`environments/${safeId}/mixed-dev.json`).identitySha256 : null;
  const scenarioHandoff = scenarioAcceptanceRequired({ requirement: initialRequirement, snapshot: initial })
    ? validateScenarioHandoff({ cwd, requirement: initialRequirement, machineVerificationEvidence, frontendIdentity: mixedIdentity(initial),
      expectedBinding: existingAttempt?.candidateId === candidateId && existingAttempt.machineVerificationEvidence === machineVerificationEvidence
        && existingAttempt.requirementId === safeId && existingAttempt.version === initialRequirement.version
        && existingAttempt.validationEpoch === (initialRequirement.validationEpoch ?? 0) && existingAttempt.windowState === 'active'
        ? existingAttempt.scenarioHandoff : undefined }) : null;
  if (userAcceptanceStageRequired({ requirement: initialRequirement, snapshot: initial })) assertAcceptanceSourcesClean(cwd, safeId);
  if (existingAttempt?.attemptId && existingAttempt.candidateId === candidateId
    && existingAttempt.machineVerificationEvidence === machineVerificationEvidence && existingAttempt.windowState === 'active') {
    if (existingAttempt.branch !== revision.branch || !evidenceNeutralDescendant(cwd, safeId, existingAttempt.commit, revision.commit)) {
      throw new FreezeError('existing candidate differs from the current inputs', { code: 'FREEZE_EVIDENCE_MISMATCH', exitCode: 11 });
    }
    return { ...existingAttempt, reused: true, lifecycleTransition: { from: 'testing', to: 'user_acceptance' },
      projection: projectAcceptance({ cwd, id: safeId, from: 'testing', to: 'user_acceptance' }) };
  }

  // Resolve the caller's owner token up front so updateLeaseState can write
  // the durable local operation record before the push. A prior successful
  // freeze deletes the local token, so on NOT_HOLDER re-check the remote
  // freeze fact first: a second conversion must still report FREEZE_EXISTS
  // (or INVALID_FREEZE_STATE for a malformed fact), preserving the error
  // precedence of the atomic mutate checks below.
  let ownerToken;
  try {
    ownerToken = resolvedToken({ cwd, resource, session: localSession });
  } catch (error) {
    const existing = freezeFactFromSnapshot(await store.readSnapshot(), resource);
    if (existing) {
      throw new FreezeError(`${resource} is already frozen by ${existing.requirementId}`, {
        code: 'FREEZE_EXISTS',
        exitCode: 10,
        data: { resource, requirementId: existing.requirementId },
      });
    }
    throw error;
  }

  let workflowBinding = null;
  const preflight = await store.readSnapshot();
  const requirementPath = `requirements/${safeId}.json`;
  const preflightRequirement = preflight.has(requirementPath) ? preflight.readJson(requirementPath) : null;
  if (preflightRequirement?.workflowVersion === 2) {
    // I-247：创建 freeze fact 之前先做发布清单服务覆盖校验（仅 workflow v2，
    // 即绑定 mixed environment identity 的同一路径）。放在评审/机器验证读取
    // 之前，让缺口以 FREEZE_SERVICE_COVERAGE_MISSING 独立暴露，而不是被
    // 包装成 FREEZE_VERIFICATION_REQUIRED，补救指令保持直接可执行。
    const mixedPath = `environments/${safeId}/mixed-dev.json`;
    assertReleaseServiceCoverage({ cwd, requirement: preflightRequirement, deploymentSnapshot,
      mixedEnvironment: preflight.has(mixedPath) ? preflight.readJson(mixedPath) : null });
    if (userAcceptanceStageRequired({ requirement: preflightRequirement, snapshot: preflight }) && preflightRequirement.lifecycle !== 'testing') {
      throw new FreezeError('enter the human acceptance stage from Testing after machine verification', { code: 'ACCEPTANCE_STATE_INVALID', exitCode: 12 });
    }
    try {
      const review = evaluateReviewReadiness({ snapshot: preflight, cwd, requirement: preflightRequirement, stage: 'verification' });
      if (!review.ok) throw new Error('current verification review is incomplete');
      const deployment = preflight.has('deployments/dev.json') ? preflight.readJson('deployments/dev.json') : null;
      if (JSON.stringify(deployment) !== JSON.stringify(deploymentSnapshot)) throw new Error('freeze snapshot is not the current trusted dev deployment');
      const actualSha = createHash('sha256').update(readFileSync(evidencePath({ cwd, id: safeId }))).digest('hex');
      if (actualSha !== machineVerificationEvidence) throw new Error('freeze evidence digest differs from TEST_EVIDENCE.json');
      const lease = await assertLease({ store, cwd, resource, requirementId: safeId, session: localSession, clock });
      const mixedPath = `environments/${safeId}/mixed-dev.json`;
      await validateTestEvidence({ cwd, id: safeId, requirement: preflightRequirement, deployment, lease,
        mixedEnvironment: preflight.has(mixedPath) ? preflight.readJson(mixedPath) : null, clock });
      workflowBinding = {
        ...(scenarioHandoff ? { scenarioHandoff } : {}),
        validationEpoch: preflightRequirement.validationEpoch ?? 0,
        feedbackFingerprint: inspectFeedbackArtifacts({ cwd, id: safeId }).fingerprint,
        verificationReview: { reviewId: review.review.reviewId, subjectFingerprint: review.subjectFingerprint,
          reportHash: (review.verification ?? review.review).reportHash },
        ...(preflight.has(mixedPath) ? { mixedEnvironmentIdentity: preflight.readJson(mixedPath).identitySha256 } : {}),
      };
    } catch (cause) {
      throw new FreezeError('complete the current review and machine verification before freezing for human acceptance', {
        code: 'FREEZE_VERIFICATION_REQUIRED', cause, data: { detail: cause.message },
      });
    }
  }
  let fact;
  const update = await updateLeaseState({
    store,
    cwd,
    resource,
    action: 'freeze',
    ownerToken,
    session: localSession,
    requirementId: safeId,
    clock,
    operation: `freeze ${resource} for ${safeId}`,
    mutate(snapshot) {
      const now = nowFrom(clock);
      // The shared helper fails closed: a malformed existing fact propagates
      // INVALID_FREEZE_STATE and is never overwritten; only a valid fact is
      // reported as FREEZE_EXISTS.
      const existing = freezeFactFromSnapshot(snapshot, resource);
      if (existing) {
        throw new FreezeError(`${resource} is already frozen by ${existing.requirementId}`, {
          code: 'FREEZE_EXISTS',
          exitCode: 10,
          data: { resource, requirementId: existing.requirementId },
        });
      }
      const requirementPath = `requirements/${safeId}.json`;
      if (!snapshot.has(requirementPath)) {
        throw new FreezeError(`requirement is not claimed: ${safeId}`, {
          code: 'REQUIREMENT_NOT_FOUND',
          data: { requirementId: safeId },
        });
      }
      // I-130 (D1): the freeze binds the lease's bound version, so the
      // requirement must carry one and the lease must match it.
      const requirement = snapshot.readJson(requirementPath);
      if (scenarioAcceptanceRequired({ requirement, snapshot })) {
        if (!scenarioHandoff) throw new FreezeError('complete the full scenario self-check and user guide before handoff', { code: 'AGENT_SELF_CHECK_REQUIRED' });
        validateScenarioHandoff({ cwd, requirement, machineVerificationEvidence, frontendIdentity: mixedIdentity(snapshot), expectedBinding: scenarioHandoff });
      }
      if (requirement.workflowVersion === 2 && (!workflowBinding
        || workflowBinding.validationEpoch !== (requirement.validationEpoch ?? 0)
        || !evaluateReviewReadiness({ snapshot, cwd, requirement, stage: 'verification' }).ok
        || JSON.stringify(snapshot.readJson('deployments/dev.json')) !== JSON.stringify(deploymentSnapshot)
        || (workflowBinding.mixedEnvironmentIdentity && (!snapshot.has(`environments/${safeId}/mixed-dev.json`)
          || snapshot.readJson(`environments/${safeId}/mixed-dev.json`).identitySha256 !== workflowBinding.mixedEnvironmentIdentity
          || snapshot.readJson(`environments/${safeId}/mixed-dev.json`).invalidated)))) {
        throw new FreezeError('verified workflow inputs changed before the freeze could be recorded', { code: 'FREEZE_VERIFICATION_REQUIRED' });
      }
      if (typeof requirement.version !== 'string' || requirement.version.trim() === '') {
        throw new FreezeError(`${safeId} is not bound to a release version`, {
          code: 'REQUIREMENT_VERSION_UNBOUND',
          exitCode: 12,
          data: { requirementId: safeId },
        });
      }
      // Revision identity is part of the lease binding: a stale worktree must
      // not convert someone else's verified state into a freeze. The tolerance
      // check still anchors on the lease's verified commit — an identical
      // revision, a pure BACKLOG.md projection commit on top of it (an audit
      // closure of the same deployed commit), or, for workflow v2, an
      // evidence-neutral descendant are tolerated; anything beyond that keeps
      // failing closed below with LEASE_REVISION_MISMATCH.
      const lock = lockFromSnapshot(snapshot, resource);
      const commitMatches = lock.active?.commit === revision.commit
        || isBacklogProjectionDescendant({
          cwd,
          ancestor: lock.active?.commit,
          descendant: revision.commit,
        }) || (requirement.workflowVersion === 2
          && evidenceNeutralDescendant(cwd, safeId, lock.active?.commit, revision.commit));
      if (lock.active?.branch !== revision.branch || !commitMatches) {
        throw new FreezeError('working tree revision no longer matches the active lease', {
          code: 'LEASE_REVISION_MISMATCH',
          exitCode: 11,
          data: {
            resource,
            branch: revision.branch,
            commit: revision.commit,
            leaseBranch: lock.active?.branch ?? null,
            leaseCommit: lock.active?.commit ?? null,
          },
        });
      }
      if (lock.active?.version !== requirement.version) {
        throw new FreezeError(
          `${resource} lease is bound to ${lock.active?.version ?? '<no version>'}, not ${requirement.version}`,
          {
            code: 'LEASE_VERSION_MISMATCH',
            exitCode: 11,
            data: {
              resource,
              requirementId: safeId,
              leaseVersion: lock.active?.version ?? null,
              requirementVersion: requirement.version,
            },
          },
        );
      }
      const previous = consumeActiveLeaseInSnapshot({
        snapshot,
        cwd,
        resource,
        requirementId: safeId,
        session: localSession,
        ownerToken,
        now,
        eventType: 'freeze',
        eventActor: actor(localSession),
      });
      fact = {
        schemaVersion: 1,
        resource,
        state: FREEZE_STATE,
        requirementId: safeId,
        // I-130 (D1): the freeze fact carries the lease's bound version so the
        // evidence chain stays version-identifiable after the lease is gone.
        version: previous.version,
        candidateId,
        deploymentSnapshot,
        machineVerificationEvidence,
        branch: previous.branch,
        // I-247（生产事故 2026-10-31）：freeze 锚定 enter 时的当前修订 commit
        // （上方容差检查已确认它相对 lease commit 的漂移可容忍），而不是
        // previous.commit——lease 只在显式 renew 时才浮动到分支尖端，取锁后
        // 落下的证据/文档提交会让 lease commit 过期；若 freeze 沿用过期的
        // lease commit，accept 路径以 freeze.commit 为起点的漂移分类会把
        // 已容忍的漂移误判成非中性，触发 FREEZE_EVIDENCE_MISMATCH 与整轮
        // correction 返工。
        commit: revision.commit,
        frozenAt: now.toISOString(),
        actor: actor(localSession),
        ...(workflowBinding ?? {}),
      };
      if (userAcceptanceStageRequired({ requirement, snapshot })) {
        const attemptId = acceptanceAttemptId(fact);
        fact = { ...fact, attemptId };
        const path = acceptanceAttemptPath(safeId, attemptId);
        if (snapshot.has(path)) throw new FreezeError('this attempt already exists; resume or rework it instead of replacing it', { code: 'ACCEPTANCE_ATTEMPT_EXISTS' });
        snapshot.writeJson(path, fact);
        snapshot.writeJson(`acceptance/${safeId}/current.json`, { schemaVersion: 1, requirementId: safeId, attemptId, state: 'active' });
        advanceAcceptance(snapshot, safeId, 'testing', 'user_acceptance', now.toISOString());
      }
      snapshot.writeJson(freezePath(resource), fact);
    },
  });

  releaseLocalLeaseToken({ cwd, resource, session: localSession });
  return {
    ...fact,
    ...(fact.attemptId ? { lifecycleTransition: { from: 'testing', to: 'user_acceptance' },
      projection: projectAcceptance({ cwd, id: safeId, from: 'testing', to: 'user_acceptance' }) } : {}),
    operationId: update.operationId,
    coordinationSha: update.sha,
  };
}

// ---------------------------------------------------------------------------
// Human decision paths (I-113 Task 3): the durable awaiting_human freeze fact
// can only be cleared by an explicit human decision. acceptFreeze records the
// acceptance on the fact (the freeze persists until prod success); rejectFreeze
// atomically converts the fact back into a fresh machine_verifying dev lease
// for the same requirement so no other requirement can grab the slot in
// between; releaseFreeze clears the fact and returns dev to available. All
// three require an auditable reason and record the acting session.
// ---------------------------------------------------------------------------

function requireDecisionReason(reason) {
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new FreezeError('a human freeze decision requires a reason', {
      code: 'MISSING_FREEZE_REASON',
      data: { missing: ['reason'] },
    });
  }
  return reason.trim();
}

function requireFreezeBinding({ fact, requirementId }) {
  if (!fact) {
    throw new FreezeError('dev is not frozen; no human decision is pending', {
      code: 'FREEZE_NOT_FOUND',
      data: { resource: FREEZE_RESOURCE },
    });
  }
  if (fact.requirementId !== requirementId) {
    throw new FreezeError(`the dev freeze is held for ${fact.requirementId}, not ${requirementId}`, {
      code: 'FREEZE_REQUIREMENT_MISMATCH',
      data: { resource: FREEZE_RESOURCE, requirementId, frozenFor: fact.requirementId },
    });
  }
}

function freezeAudit(store, action, requirementId, reason, session) {
  return {
    kind: 'freeze',
    action,
    resource: FREEZE_RESOURCE,
    requirementId,
    reason,
    sessionId: session.sessionId,
  };
}

// I-134 (F3): unfreezeFact is the single implementation of the human freeze
// decision. The shared preamble (resource/id/reason/session validation) runs
// once; the outcome selects the mutate body, audit action, operation label
// and result shape. The accept/reject/release exports below stay as thin
// wrappers so existing callers and tests are unaffected.
const UNFREEZE_OUTCOMES = Object.freeze(['accepted', 'rejected', 'released', 'paused']);

// Record the human acceptance on the freeze fact (accepted). The fact is not
// cleared: per the shared-dev design the freeze stays until the production
// release succeeds (released) or the release smoke fails and the candidate is
// sent back to machine verification (rejected, an atomic conversion back into
// a fresh machine_verifying dev lease so no other requirement can grab the
// slot in between). released clears the fact and returns dev to available.
export async function unfreezeFact({
  outcome,
  store,
  cwd,
  resource = FREEZE_RESOURCE,
  requirementId,
  reason,
  authorizedBy,
  instructionRef,
  session,
  ttl = DEFAULT_REJECT_TTL,
  clock = () => new Date(),
}) {
  if (!UNFREEZE_OUTCOMES.includes(outcome)) {
    throw new FreezeError(`invalid unfreeze outcome: ${outcome ?? '<missing>'}`, {
      code: 'INVALID_UNFREEZE_OUTCOME',
      data: { outcomes: [...UNFREEZE_OUTCOMES] },
    });
  }
  if (resource !== FREEZE_RESOURCE) {
    throw new FreezeError(`freeze facts only apply to the dev resource: ${resource}`, {
      code: 'INVALID_FREEZE_RESOURCE',
    });
  }
  const safeId = validateId(requirementId);
  const decisionReason = requireDecisionReason(reason);
  const localSession = knownSession(cwd, session);

  if (outcome === 'accepted') {
    const now = nowFrom(clock);
    let fact;
    let reused = false;
    let lifecycle;
    const update = await store.update({
      operation: `accept freeze for ${safeId}`,
      auditData: freezeAudit(store, 'accept', safeId, decisionReason, localSession),
      mutate(snapshot) {
        let current = freezeFactFromSnapshot(snapshot, resource);
        const durable = resolveAcceptanceFact(snapshot, safeId);
        if ((!current || current.requirementId !== safeId) && durable?.attemptId && durable.acceptance) {
          if (durable.acceptance.instructionRef !== instructionRef || durable.acceptance.authorizedBy !== authorizedBy) {
            throw new FreezeError('candidate already accepted with another decision; historical acceptance is immutable', { code: 'ACCEPTANCE_DECISION_CONFLICT' });
          }
          lifecycle = snapshot.readJson(`requirements/${safeId}.json`).lifecycle;
          fact = durable; reused = true; return;
        }
        requireFreezeBinding({ fact: current, requirementId: safeId });
        const requirementPath = `requirements/${safeId}.json`;
        const requirement = snapshot.has(requirementPath) ? snapshot.readJson(requirementPath) : null;
        if (requirement?.workflowVersion === 2) {
          if (typeof authorizedBy !== 'string' || authorizedBy.trim().length < 2
            || !/^user-message:[A-Za-z0-9._:-]{6,}$/.test(instructionRef ?? '')) {
            throw new FreezeError('record the approving human and direct message for the current candidate', { code: 'FREEZE_ACCEPTANCE_AUTHORIZATION_REQUIRED' });
          }
          const revision = currentRevision(cwd);
          // B-248: accept and advance must share one tolerance line. The
          // advance gate only accepts evidence-neutral drift; letting accept
          // tolerate deployment-neutral drift here would approve a candidate
          // that advance then refuses, with no executable remediation left
          // under an active freeze. The null-policy fast paths (identical
          // commit, pure BACKLOG projection descendant) count as neutral.
          const acceptDriftNeutral = current.commit === revision.commit
            || (() => {
              const drift = revisionMatchesDeployment({
                cwd, requirementId: safeId, fromCommit: current.commit, toCommit: revision.commit,
              });
              return drift.matches
                && (drift.policy === null || drift.policy.classification === 'evidence-neutral');
            })();
          if (current.validationEpoch !== (requirement.validationEpoch ?? 0) || !acceptDriftNeutral) {
            throw new FreezeError('candidate drifted beyond evidence-neutral changes after machine verification; reject the freeze and reverify', { code: 'FREEZE_EVIDENCE_MISMATCH', exitCode: 11 });
          }
          if (current.mixedEnvironmentIdentity) {
            const path = `environments/${safeId}/mixed-dev.json`;
            if (!snapshot.has(path) || snapshot.readJson(path).invalidated
              || snapshot.readJson(path).identitySha256 !== current.mixedEnvironmentIdentity) {
              throw new FreezeError('mixed candidate changed before human acceptance', { code: 'FREEZE_EVIDENCE_MISMATCH', exitCode: 11 });
            }
          }
          if (current.attemptId) {
            assertAcceptanceSourcesClean(cwd, safeId);
            const review = evaluateReviewReadiness({ snapshot, cwd, requirement, stage: 'verification' });
            const ux = requirement.uxImpact === 'admin-ui' ? evaluateUxReadiness({ snapshot, cwd, requirement }) : { ok: true };
            if (!review.ok || !ux.ok || current.verificationReview?.subjectFingerprint !== review.subjectFingerprint) {
              throw new FreezeError('current verification and approved UX must still match the frozen candidate', { code: 'FREEZE_VERIFICATION_REQUIRED' });
            }
            if (current.feedbackFingerprint && inspectFeedbackArtifacts({ cwd, id: safeId }).fingerprint !== current.feedbackFingerprint) {
              throw new FreezeError('candidate feedback decisions changed before acceptance', { code: 'FREEZE_EVIDENCE_MISMATCH', exitCode: 11 });
            }
          }
        }
        const uiEvidence = uiAcceptanceRequired({ requirement, snapshot })
          ? validateUiAcceptanceReport({ cwd, requirement, freeze: current }) : null;
        fact = {
          ...current,
          acceptance: {
            acceptedAt: now.toISOString(),
            acceptedBy: actor(localSession),
            reason: decisionReason,
            ...(authorizedBy ? { authorizedBy: authorizedBy.trim() } : {}),
            ...(instructionRef ? { instructionRef } : {}),
            ...(uiEvidence ? { uiEvidenceSha256: uiEvidence.evidenceSha256 } : {}),
          },
        };
        if (current.attemptId && requirement?.acceptanceWorkflowVersion === 1) {
          const decisionPath = acceptanceAttemptPath(safeId, current.attemptId).replace(/\.json$/, '-decision.json');
          if (snapshot.has(decisionPath)) throw new FreezeError('acceptance decision is immutable', { code: 'ACCEPTANCE_DECISION_CONFLICT' });
          snapshot.writeJson(decisionPath, { schemaVersion: 1, requirementId: safeId, attemptId: current.attemptId, outcome, acceptance: fact.acceptance });
          snapshot.writeJson(`acceptance/${safeId}/current.json`, { schemaVersion: 1, requirementId: safeId, attemptId: current.attemptId, state: 'accepted' });
          advanceAcceptance(snapshot, safeId, 'user_acceptance', 'test_passed', now.toISOString());
          lifecycle = 'test_passed';
          snapshot.delete(freezePath(resource));
        } else snapshot.writeJson(freezePath(resource), fact);
      },
    });

    return {
      ...fact,
      ...(fact.attemptId ? { reused, lifecycle, lifecycleTransition: { from: 'user_acceptance', to: 'test_passed' },
        projection: projectAcceptance({ cwd, id: safeId, from: reused && lifecycle !== 'test_passed' ? lifecycle : 'user_acceptance', to: lifecycle }) } : {}),
      operationId: update.operationId,
      coordinationSha: update.sha,
    };
  }

  if (outcome === 'paused') {
    let fact;
    let reused = false;
    const update = await store.update({ operation: `pause human acceptance ${safeId}`, auditData: freezeAudit(store, 'pause', safeId, decisionReason, localSession), mutate(snapshot) {
      const current = freezeFactFromSnapshot(snapshot, resource);
      const durable = resolveAcceptanceFact(snapshot, safeId);
      if ((!current || current.requirementId !== safeId) && durable?.attemptId && durable.windowState === 'paused') {
        fact = durable; reused = true; return;
      }
      requireFreezeBinding({ fact: current, requirementId: safeId });
      if (!current.attemptId) throw new FreezeError('legacy freezes must be explicitly rejected or released', { code: 'ACCEPTANCE_WORKFLOW_REQUIRED' });
      fact = current;
      snapshot.writeJson(`acceptance/${safeId}/current.json`, { schemaVersion: 1, requirementId: safeId, attemptId: current.attemptId, state: 'paused', pausedAt: clock().toISOString(), reason: decisionReason });
      snapshot.delete(freezePath(resource));
    } });
    return { ...fact, reused, windowState: 'paused', released: true, operationId: update.operationId, coordinationSha: update.sha };
  }

  if (outcome === 'rejected') {
    const pending = resolveAcceptanceFact(await store.readSnapshot(), safeId);
    if (pending?.attemptId) throw new FreezeError('classify the human feedback and apply it once with lifecycle rework-batch', {
      code: 'ACCEPTANCE_BATCH_REQUIRED', data: { requiredActions: [`pnpm coord lifecycle rework-batch ${safeId} --batch <file> --json`] },
    });
    const ownerToken = randomUUID();
    const revision = currentRevision(cwd);
    let leaseDurationMs;
    try {
      leaseDurationMs = normalizeDuration(ttl);
    } catch (error) {
      throw new FreezeError(error.message, { code: 'INVALID_FREEZE_TTL', cause: error });
    }

    let fact;
    let lease;
    const update = await store.update({
      operation: `reject freeze for ${safeId} back to machine verification`,
      auditData: freezeAudit(store, 'reject', safeId, decisionReason, localSession),
      mutate(snapshot) {
        const now = nowFrom(clock);
        const current = freezeFactFromSnapshot(snapshot, resource);
        requireFreezeBinding({ fact: current, requirementId: safeId });
        // The rejecting worktree must still be on the frozen requirement's
        // branch; otherwise a cross-branch actor could hijack the requirement's
        // dev slot. Commits may have moved (fixes/docs), only the branch is
        // identity-critical for the resumed machine_verifying lease.
        if (current.branch !== revision.branch) {
          throw new FreezeError(
            `working tree branch ${revision.branch} no longer matches the frozen branch ${current.branch}`,
            {
              code: 'FREEZE_REVISION_MISMATCH',
              exitCode: 11,
              data: { resource, branch: revision.branch, frozenBranch: current.branch },
            },
          );
        }
        const lock = lockFromSnapshot(snapshot, resource);
        if (lock.active) {
          throw new FreezeError('the dev slot is unexpectedly occupied while frozen', {
            code: 'FREEZE_LEASE_CONFLICT',
            exitCode: 11,
            data: { resource, holderId: lock.active.holder?.id ?? null },
          });
        }
        fact = current;
        lease = {
          holder: { kind: 'requirement', id: safeId },
          // I-130 (D1): the resumed machine_verifying lease backfills the frozen
          // version (locks are written at schema v2).
          version: current.version,
          sessionId: localSession.sessionId,
          branch: revision.branch,
          commit: revision.commit,
          ownerToken,
          acquiredAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + leaseDurationMs).toISOString(),
        };
        snapshot.delete(freezePath(resource));
        snapshot.writeJson(`locks/${resource}.json`, {
          schemaVersion: 2,
          resource,
          active: lease,
          lastEvent: {
            type: 'reject',
            at: now.toISOString(),
            actor: actor(localSession),
            reason: decisionReason,
            previous: current,
          },
        });
      },
    });

    writeLocalLeaseToken({ cwd, resource, session: localSession, ownerToken });
    return {
      requirementId: safeId,
      reason: decisionReason,
      lease,
      previousFreeze: fact,
      operationId: update.operationId,
      coordinationSha: update.sha,
    };
  }

  // outcome === 'released': clear the freeze fact and return dev to
  // available. Used when the user explicitly cancels/releases the candidate,
  // or after the production release succeeded.
  let fact;
  let reused = false;
  const update = await store.update({
    operation: `release freeze for ${safeId}`,
    auditData: freezeAudit(store, 'release', safeId, decisionReason, localSession),
    mutate(snapshot) {
      const current = freezeFactFromSnapshot(snapshot, resource);
      const durable = resolveAcceptanceFact(snapshot, safeId);
      if ((!current || current.requirementId !== safeId) && durable?.attemptId && ['released', 'accepted'].includes(durable.windowState)) {
        fact = durable; reused = true; return;
      }
      if ((!current || current.requirementId !== safeId) && durable?.attemptId && durable.windowState === 'paused') fact = durable;
      else { requireFreezeBinding({ fact: current, requirementId: safeId }); fact = current; }
      if (fact.attemptId) {
        snapshot.writeJson(`acceptance/${safeId}/current.json`, { schemaVersion: 1, requirementId: safeId, attemptId: fact.attemptId,
          state: 'released', releasedAt: clock().toISOString(), reason: decisionReason });
      }
      if (current?.requirementId === safeId) snapshot.delete(freezePath(resource));
    },
  });

  return {
    requirementId: safeId,
    reason: decisionReason,
    released: true,
    reused,
    previousFreeze: fact,
    operationId: update.operationId,
    coordinationSha: update.sha,
  };
}

// I-134 (F3): the historical per-outcome entry points stay exported as thin
// wrappers over unfreezeFact — the outcome is the only difference.
export function acceptFreeze(args) {
  return unfreezeFact({ ...args, outcome: 'accepted' });
}

export function rejectFreeze(args) {
  return unfreezeFact({ ...args, outcome: 'rejected' });
}

export function releaseFreeze(args) {
  return unfreezeFact({ ...args, outcome: 'released' });
}
