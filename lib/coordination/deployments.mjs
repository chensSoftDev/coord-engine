import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

import { assertVersionLease } from './leases.mjs';
import {
  assertRequirementId,
  assertVersion,
} from './validation.mjs';

const STAGES = new Set(['dev', 'prod']);
const SERVICES = new Set(['account', 'api', 'gateway', 'web', 'admin']);
const SERVICE_PREFIX = Object.freeze({
  account: 'ACCOUNT',
  api: 'API',
  gateway: 'GATEWAY',
  web: 'WEB',
  admin: 'ADMIN',
});
const IMAGE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40,64}$/;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const MAX_SNAPSHOT_BYTES = 1024 * 1024;

export class DeploymentError extends Error {
  constructor(message, { code, exitCode = 14, data = {}, cause } = {}) {
    super(message, { cause });
    this.name = 'DeploymentError';
    this.code = code;
    this.exitCode = exitCode;
    this.data = data;
  }
}

function validStage(stage) {
  if (!STAGES.has(stage)) {
    throw new DeploymentError(`invalid deployment stage: ${stage ?? '<missing>'}`, {
      code: 'INVALID_DEPLOYMENT_STAGE',
    });
  }
  return stage;
}

function validRequirementId(id) {
  try {
    return assertRequirementId(id);
  } catch (error) {
    throw new DeploymentError(error.message, { code: 'INVALID_REQUIREMENT_ID', cause: error });
  }
}

function validVersion(version) {
  try {
    return assertVersion(version);
  } catch (error) {
    throw new DeploymentError(error.message, { code: 'INVALID_VERSION', cause: error });
  }
}

function isAncestor(cwd, ancestor, descendant) {
  return spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
    cwd,
    stdio: ['ignore', 'ignore', 'ignore'],
  }).status === 0;
}

function normalizedServices(value) {
  const values = Array.isArray(value) ? value : String(value ?? '').split(',');
  const normalized = [...new Set(values.map((service) => service.trim()).filter(Boolean))].sort();
  if (normalized.length === 0 || normalized.some((service) => !SERVICES.has(service))) {
    throw new DeploymentError('deployment services contain an unsupported service', {
      code: 'INVALID_DEPLOYMENT_SERVICES',
      data: { services: normalized },
    });
  }
  return normalized;
}

function sha256(source) {
  return createHash('sha256').update(source).digest('hex');
}

function readRepositoryFile(cwd, path, label) {
  if (typeof path !== 'string' || path.length === 0) {
    throw new DeploymentError(`${label} path is required`, {
      code: 'DEPLOYMENT_SNAPSHOT_REQUIRED',
    });
  }
  try {
    const root = realpathSync(cwd);
    const absolute = realpathSync(resolve(root, path));
    const repositoryPath = relative(root, absolute);
    if (
      repositoryPath === ''
      || repositoryPath === '..'
      || repositoryPath.startsWith(`..${sep}`)
      || resolve(root, repositoryPath) !== absolute
    ) {
      throw new DeploymentError(`${label} must be inside the repository`, {
        code: 'INVALID_DEPLOYMENT_SNAPSHOT_PATH',
      });
    }
    const source = readFileSync(absolute);
    if (source.length > MAX_SNAPSHOT_BYTES) {
      throw new DeploymentError(`${label} is too large`, {
        code: 'INVALID_DEPLOYMENT_SNAPSHOT',
      });
    }
    return {
      path: repositoryPath.split(sep).join('/'),
      source,
    };
  } catch (error) {
    if (error instanceof DeploymentError) throw error;
    throw new DeploymentError(`cannot read ${label}: ${path}`, {
      code: 'INVALID_DEPLOYMENT_SNAPSHOT_PATH',
      cause: error,
    });
  }
}

function parseEnv(source, label) {
  const fields = {};
  for (const rawLine of source.toString('utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || Object.hasOwn(fields, match[1])) {
      throw new DeploymentError(`invalid ${label} line`, {
        code: 'INVALID_DEPLOYMENT_SNAPSHOT',
        data: { line: rawLine },
      });
    }
    fields[match[1]] = match[2];
  }
  return fields;
}

function readGitBlob(cwd, commit, path) {
  const result = spawnSync('git', ['show', `${commit}:${path}`], {
    cwd,
    encoding: null,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: MAX_SNAPSHOT_BYTES,
  });
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    throw new DeploymentError(`release manifest is absent from deployment commit: ${commit}`, {
      code: 'DEPLOYMENT_MANIFEST_MISMATCH',
    });
  }
  return result.stdout;
}

function readDeploymentFacts({ cwd, snapshotPath, expectedStage, expectedRequirementId }) {
  const snapshotFile = readRepositoryFile(cwd, snapshotPath, 'deployment snapshot');
  const fields = parseEnv(snapshotFile.source, 'deployment snapshot');
  const stage = validStage(fields.STAGE);
  const requirementId = validRequirementId(fields.REQUIREMENT_ID);
  const version = validVersion(fields.RELEASE_VERSION);
  const services = normalizedServices(fields.RELEASE_SERVICES);
  const declaredServices = normalizedServices(fields.DECLARED_RELEASE_SERVICES);
  const serviceOverride = fields.SERVICE_OVERRIDE === 'true';
  const deploymentMode = fields.DEPLOYMENT_MODE ?? 'full';
  if (!['full', 'backend-only'].includes(deploymentMode) || (deploymentMode === 'backend-only' && (stage !== 'dev' || serviceOverride || services.join(',') !== declaredServices.filter(s => ['account', 'api', 'gateway'].includes(s)).join(',')))) {
    throw new DeploymentError('backend-only mode requires exactly the declared backend services on dev', { code: 'DEPLOYMENT_SERVICE_MISMATCH' });
  }
  if (stage !== expectedStage) {
    throw new DeploymentError('deployment snapshot does not match the requested stage or requirement', {
      code: 'DEPLOYMENT_SNAPSHOT_MISMATCH',
      data: { stage, requirementId },
    });
  }
  if (!COMMIT_PATTERN.test(fields.RELEASE_COMMIT_SHA ?? '')) {
    throw new DeploymentError('deployment snapshot is missing an immutable commit', {
      code: 'INVALID_DEPLOYMENT_COMMIT',
    });
  }
  const expectedDirectory = stage === 'dev' ? 'deploy/dev-releases' : 'deploy/releases';
  if (
    !snapshotFile.path.startsWith(`${expectedDirectory}/${version}/`)
    || !snapshotFile.path.endsWith('.env')
    || fields.DEPLOYMENT_STATUS !== 'success'
    || !UTC_TIMESTAMP_PATTERN.test(fields.SUCCEEDED_AT ?? '')
    || !Number.isFinite(Date.parse(fields.SUCCEEDED_AT))
    || Object.hasOwn(fields, 'INVALIDATED_AT')
  ) {
    throw new DeploymentError('deployment snapshot is not a final successful release artifact', {
      code: 'DEPLOYMENT_NOT_SUCCESSFUL',
    });
  }
  if (deploymentMode !== 'backend-only' && !serviceOverride && services.join(',') !== declaredServices.join(',')) {
    throw new DeploymentError('deployment snapshot contains an undeclared service override', {
      code: 'DEPLOYMENT_SERVICE_MISMATCH',
    });
  }

  const artifacts = {};
  for (const service of services) {
    const prefix = SERVICE_PREFIX[service];
    const imageId = fields[`${prefix}_IMAGE_ID`];
    const imageTag = fields[`${prefix}_IMAGE_TAG`];
    if (!IMAGE_ID_PATTERN.test(imageId ?? '') || !imageTag || /\s/.test(imageTag)) {
      throw new DeploymentError(`deployment snapshot lacks immutable artifact identity for ${service}`, {
        code: 'DEPLOYMENT_ARTIFACT_MISSING',
        data: { service },
      });
    }
    artifacts[service] = { imageId, imageTag };
  }

  const manifestPath = `deploy/release-manifests/${version}.env`;
  const manifestSource = readGitBlob(cwd, fields.RELEASE_COMMIT_SHA, manifestPath);
  const manifest = parseEnv(manifestSource, 'release manifest');
  const manifestRequirements = String(manifest.RELEASE_REQUIREMENTS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    manifest.RELEASE_VERSION !== version
    || manifest.RELEASE_DELIVERY_PROFILE !== 'runtime'
    || !manifestRequirements.includes(requirementId)
    || normalizedServices(manifest.RELEASE_SERVICES).join(',') !== declaredServices.join(',')
  ) {
    throw new DeploymentError('deployment snapshot does not match the release manifest', {
      code: 'DEPLOYMENT_MANIFEST_MISMATCH',
    });
  }
  // I-160：release train 共享一次 prod 部署。prod 快照的 REQUIREMENT_ID 允许与本次登记需求不同，
  // 前提是两者都在 deployed commit 的 manifest RELEASE_REQUIREMENTS 里（同一版本列车）；
  // dev 保持严格匹配——deployments/dev.json 会被证据闭包逐字比对（sameJson），
  // 列车共享登记会改变记录内容、打挂已完成 test run 的需求。
  const trainShared = expectedStage === 'prod'
    && manifestRequirements.includes(expectedRequirementId);
  if (requirementId !== expectedRequirementId && !trainShared) {
    throw new DeploymentError('deployment snapshot does not match the requested stage or requirement', {
      code: 'DEPLOYMENT_SNAPSHOT_MISMATCH',
      data: { stage, requirementId },
    });
  }

  return {
    stage,
    // 记录属主为本次请求的需求；快照自身的 REQUIREMENT_ID 保留在 sourceRequirementId
    requirementId: expectedRequirementId,
    sourceRequirementId: requirementId,
    version,
    commit: fields.RELEASE_COMMIT_SHA,
    branch: fields.RELEASE_BRANCH,
    services,
    declaredServices,
    serviceOverride,
    ...(deploymentMode === 'backend-only' ? { deploymentMode } : {}),
    artifacts,
    manifest: {
      path: manifestPath,
      sha256: sha256(manifestSource),
    },
    sourceSnapshot: {
      path: snapshotFile.path,
      sha256: sha256(snapshotFile.source),
    },
  };
}

// I-130 (D1): lease identity is ownership + the bound version; the floating
// commit is informational and never compared.
function sameLease(active, asserted) {
  return active
    && active.holder?.id === asserted.holder?.id
    && active.version === asserted.version
    && active.sessionId === asserted.sessionId
    && active.branch === asserted.branch
    && active.ownerToken === asserted.ownerToken;
}

export async function recordDeployment({
  store,
  cwd,
  stage,
  requirementId,
  snapshotPath,
  session,
  clock = () => new Date(),
}) {
  const deploymentStage = validStage(stage);
  const id = validRequirementId(requirementId);
  const facts = readDeploymentFacts({
    cwd,
    snapshotPath,
    expectedStage: deploymentStage,
    expectedRequirementId: id,
  });
  const lease = await assertVersionLease({
    store,
    cwd,
    resource: deploymentStage,
    requirementId: id,
    session,
    clock,
  });
  // I-134 (F1): the snapshot commit no longer participates in the lease
  // assertion (the lease floats to the branch tip on renew, so a neutral
  // commit like a BACKLOG projection must not invalidate the record).
  // assertVersionLease exempts only the commit leg; the branch leg still
  // pins the working tree to the lease branch (I-134 review). The commit
  // floor moves here instead: the deployed artifact must come from this
  // branch's own history — a snapshot built on a foreign commit is rejected.
  if (!isAncestor(cwd, facts.commit, 'HEAD')) {
    throw new DeploymentError(
      `deployment snapshot commit is not an ancestor of HEAD: ${facts.commit}`,
      {
        code: 'DEPLOYMENT_SNAPSHOT_FOREIGN',
        data: { stage: deploymentStage, requirementId: id, commit: facts.commit },
      },
    );
  }
  // I-134 (F1): the lease assertion is version-level and the ancestor check
  // above pins the snapshot commit into HEAD's history, so a branch-name
  // difference in the snapshot (RELEASE_BRANCH=HEAD from a detached tag
  // checkout) is always a checkout-style artifact; the recorded branch stays
  // the lease branch.

  let deployment;
  const update = await store.update({
    operation: `record ${deploymentStage} deployment for ${id}`,
    auditData: {
      kind: 'deployment',
      stage: deploymentStage,
      requirementId: id,
      version: facts.version,
      commit: facts.commit,
      snapshotSha256: facts.sourceSnapshot.sha256,
    },
    mutate(snapshot) {
      const requirementPath = `requirements/${id}.json`;
      if (!snapshot.has(requirementPath)) {
        throw new DeploymentError(`requirement is not coordinated: ${id}`, {
          code: 'REQUIREMENT_NOT_FOUND',
        });
      }
      const requirement = snapshot.readJson(requirementPath);
      if (requirement.deliveryProfile !== 'runtime') {
        throw new DeploymentError(`${id} does not use the runtime delivery profile`, {
          code: 'DEPLOYMENT_PROFILE_MISMATCH',
        });
      }
      if (
        deploymentStage === 'prod'
        && (
          requirement.mergeStatus !== 'merged'
          || (
            requirement.mergedCommit !== facts.commit
            && !isAncestor(cwd, requirement.mergedCommit, facts.commit)
          )
        )
      ) {
        throw new DeploymentError(`${id} production commit is not recorded as merged`, {
          code: 'DEPLOYMENT_NOT_MERGED',
        });
      }
      if (requirement.version !== facts.version) {
        throw new DeploymentError(
          `${id} is bound to ${requirement.version ?? '<unbound>'}, not ${facts.version}`,
          { code: 'DEPLOYMENT_VERSION_MISMATCH' },
        );
      }
      const lockPath = `locks/${deploymentStage}.json`;
      const active = snapshot.has(lockPath) ? snapshot.readJson(lockPath).active : null;
      if (!sameLease(active, lease) || Date.parse(active.expiresAt) <= clock().getTime()) {
        throw new DeploymentError(`${deploymentStage} lease changed before deployment recording`, {
          code: 'STALE_DEPLOYMENT_LEASE',
          exitCode: 11,
        });
      }
      // I-160：同一部署事实（同版本/同 commit/同服务集合）被列车内多个需求登记时，
      // 累积 requirementIds 而不是互相覆盖——prod 门禁按成员匹配（lifecycle.mjs
      // deploymentCovers），首个登记者的 requirementId 保持不变以保证记录稳定。
      // dev 不走共享登记（证据闭包逐字比对 deployments/dev.json），此处仍天然单条覆盖。
      const deploymentPath = `deployments/${deploymentStage}.json`;
      const previous = snapshot.has(deploymentPath) ? snapshot.readJson(deploymentPath) : null;
      const sameFact = previous
        && previous.version === facts.version
        && previous.commit === facts.commit
        && JSON.stringify(previous.services) === JSON.stringify(facts.services);
      const requirementIds = sameFact
        ? [...new Set([...(previous.requirementIds ?? [previous.requirementId]), id])].sort()
        : [id];
      deployment = {
        schemaVersion: 2,
        stage: deploymentStage,
        requirementId: sameFact ? previous.requirementId : id,
        requirementIds,
        sourceRequirementId: facts.sourceRequirementId,
        version: facts.version,
        // I-130 (D1): the record binds the snapshot's immutable deployed
        // commit, not the floating lease commit.
        commit: facts.commit,
        branch: lease.branch,
        services: facts.services,
        declaredServices: facts.declaredServices,
        serviceOverride: facts.serviceOverride,
        ...(facts.deploymentMode ? { deploymentMode: facts.deploymentMode } : {}),
        ...(deploymentStage === 'dev' ? { serviceSnapshots: {
          ...Object.fromEntries((previous?.services ?? []).filter(s => previous.artifacts?.[s]).map(s => [s, { commit: previous.commit, version: previous.version, artifact: previous.artifacts[s], serviceOverride: previous.serviceOverride === true, manifest: previous.manifest, sourceSnapshot: previous.sourceSnapshot }])),
          ...(previous?.serviceSnapshots ?? {}),
          ...Object.fromEntries(facts.services.map(s => [s, { commit: facts.commit, version: facts.version, artifact: facts.artifacts[s], serviceOverride: facts.serviceOverride === true, manifest: facts.manifest, sourceSnapshot: facts.sourceSnapshot }])),
        } } : {}),
        artifacts: facts.artifacts,
        manifest: facts.manifest,
        sourceSnapshot: facts.sourceSnapshot,
        ...(requirement.mergedCommit ? { mergedCommit: requirement.mergedCommit } : {}),
        sessionId: lease.sessionId,
        recordedAt: clock().toISOString(),
      };
      snapshot.writeJson(deploymentPath, deployment);
    },
  });
  return {
    deployment,
    operationId: update.operationId,
    coordinationSha: update.sha,
  };
}
