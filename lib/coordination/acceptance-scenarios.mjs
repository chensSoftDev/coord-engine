import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, lstatSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { isSafeReviewPath, reviewRepository } from './feedback.mjs';
import { loadE2eExpectations, assertE2eResults } from '../e2e-coverage.mjs';
import { gitCommonDir } from './worktrees.mjs';
import { classifyRevisionRange } from './revision-policy.mjs';
import { evaluateUxReadiness } from './ux-approvals.mjs';
import { collectUxItemExecution, resolveUxItemPlan, validateUxItemHandoff } from './ux-item-acceptance.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const text = value => typeof value === 'string' && value.trim().length > 0 && !value.includes('\0');
const identifier = value => /^[A-Za-z][A-Za-z0-9_-]{1,95}$/.test(value ?? '');
const strings = value => Array.isArray(value) && value.every(text);
const fail = (message, code = 'SCENARIO_HANDOFF_INVALID') => {
  throw Object.assign(new Error(message), { code, exitCode: 14 });
};

export function scenarioAcceptanceRequired({ requirement, snapshot }) {
  if (requirement?.scenarioAcceptanceVersion !== 1 || requirement.workflowVersion !== 2 || requirement.deliveryProfile !== 'runtime') return false;
  const mixedPath = `environments/${requirement.id}/mixed-dev.json`;
  const mixed = snapshot?.has?.(mixedPath) ? snapshot.readJson(mixedPath) : null;
  return requirement.uxImpact === 'admin-ui' || (requirement.resources?.services ?? requirement.services ?? []).some(s => ['web', 'admin'].includes(s))
    || (mixed?.mode === 'mixed-dev' && !mixed.invalidated);
}

export function parseAcceptanceScenarios(source, requirementId) {
  const blocks = [...source.matchAll(/```acceptance-scenarios[ \t]*\r?\n([\s\S]*?)```/g)];
  if (!blocks.length) fail('define the executable design scenarios before coding', 'ACCEPTANCE_SCENARIOS_REQUIRED');
  const invalid = () => fail('design scenarios need unique IDs, executable steps, UX references, data, outcomes, cleanup and an acyclic dependency graph', 'ACCEPTANCE_SCENARIOS_INVALID');
  let plan;
  try { plan = JSON.parse(blocks[0][1]); } catch { invalid(); }
  if (blocks.length !== 1 || plan?.schemaVersion !== 1 || plan.requirementId !== requirementId || !isSafeReviewPath(plan.baselineSource)
    || !Array.isArray(plan.scenarios) || !plan.scenarios.length) invalid();
  const ids = new Set();
  for (const s of plan.scenarios) {
    if (!identifier(s?.id) || ids.has(s.id) || !['business', 'ui-ux'].includes(s.kind)
      || !['title', 'role', 'entry', 'testData', 'result', 'recovery', 'cleanup', 'isolation'].every(k => text(s[k]))
      || typeof s.changesData !== 'boolean' || !strings(s.uxRefs) || !s.uxRefs.length
      || !strings(s.dependsOn) || new Set(s.dependsOn).size !== s.dependsOn.length
      || !Array.isArray(s.steps) || !s.steps.length || s.steps.some(step => !text(step?.action) || !text(step?.expected))) invalid();
    ids.add(s.id);
  }
  if (!['business', 'ui-ux'].every(kind => plan.scenarios.some(s => s.kind === kind))) invalid();
  const visiting = new Set(), visited = new Set(), byId = new Map(plan.scenarios.map(s => [s.id, s]));
  const visit = id => {
    if (!ids.has(id) || visiting.has(id)) invalid();
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).dependsOn) visit(dependency);
    visiting.delete(id); visited.add(id);
  };
  for (const id of ids) visit(id);
  return plan;
}

function readRequired(repo, path, code, maximumBytes = 1024 * 1024) {
  if (!isSafeReviewPath(path) || !repo.regular(path) || repo.dirty([path])) fail(`commit the regular acceptance input: ${path}`, code);
  const source = repo.read(path);
  if (!source.trim() || Buffer.byteLength(source) > maximumBytes) fail(`acceptance input is empty or too large: ${path}`, code);
  return source;
}

export function readAcceptanceScenarios({ cwd, requirement, ref = 'HEAD' }) {
  const repo = reviewRepository({ cwd, ref });
  const candidates = [...repo.entries.keys()].filter(p => p.startsWith(`docs/product/current/${requirement.id}-`) && p.endsWith('/TECH_DESIGN.md'));
  if (candidates.length !== 1) fail('commit exactly one TECH_DESIGN.md with the scenario contract', 'ACCEPTANCE_SCENARIOS_REQUIRED');
  const path = candidates[0], root = path.slice(0, -'/TECH_DESIGN.md'.length);
  const plan = parseAcceptanceScenarios(readRequired(repo, path, 'ACCEPTANCE_SCENARIOS_REQUIRED'), requirement.id);
  if (requirement.uxImpact === 'admin-ui' && plan.baselineSource !== `${root}/UX_SPEC.md` && !plan.baselineSource.startsWith('apps/ux-prototype/')) {
    fail('design baseline must reference this requirement UX or its approved prototype', 'ACCEPTANCE_SCENARIOS_INVALID');
  }
  readRequired(repo, plan.baselineSource, 'ACCEPTANCE_SCENARIOS_INVALID');
  return { repo, root, plan, planSha256: hash(JSON.stringify(plan)) };
}

export function renderUserAcceptanceGuide(plan) {
  const lines = [`# ${plan.requirementId} 用户验收流程`, '',
    '本清单由研发设计场景生成。Agent 应先完成全部场景自验，再提供当前冻结候选的入口、身份、自验结果和本清单。请在当前候选操作；步骤与预期不符时记录场景编号、实际结果和截图，由 Agent 分类修复。', '',
    `设计基线：${plan.baselineSource}`, '', '## 验收清单', '',
    ...plan.scenarios.map(s => `- [ ] ${s.id}：${s.title}`), '', '## 详细流程', ''];
  for (const s of plan.scenarios) {
    lines.push(`### ${s.id}：${s.title}`, '', `岗位：${s.role}`, '', `入口：${s.entry}`, '', `前置数据：${s.testData}`, '',
      `前置场景：${s.dependsOn.join('、') || '无'}`, '', `设计任务／画面：${s.uxRefs.join('、')}`, '');
    s.steps.forEach((step, index) => lines.push(`${index + 1}. ${step.action}`, `   预期：${step.expected}`, ''));
    lines.push(`最终结果：${s.result}`, '', `异常与恢复：${s.recovery}`, '', `数据清理：${s.cleanup}`, '',
      `数据隔离：${s.isolation}`, '');
  }
  lines.push('## 验收结果', '', '请在聊天中逐项告知通过或问题；本指南保持原样。用户的直接确认仅针对本次候选，不能复用到另一个版本。', '');
  return lines.join('\n');
}

function executionCoverage({ cwd, requirement, report, contracts, testedCommit, frontendIdentity, itemPlan }) {
  const invalid = () => fail('attach the actual current Playwright coverage and execution reports, with matching hashes and passed business cases', 'SCENARIO_E2E_EXECUTION_REQUIRED');
  if (!Array.isArray(report.e2eReports) || !report.e2eReports.length) invalid();
  const covered = new Set(), artifacts = {}, uxItems = [];
  try {
    const reportsRoot = realpathSync(join(gitCommonDir(cwd), 'coordination/e2e-reports', requirement.id));
    const read = path => {
      const actual = realpathSync(path);
      if (!actual.startsWith(`${reportsRoot}${sep}`) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) invalid();
      return readFileSync(actual);
    };
    for (const reference of report.e2eReports) {
      const bytes = read(reference.path);
      if (hash(bytes) !== reference.sha256) invalid();
      const receipt = JSON.parse(bytes);
      const contract = contracts.find(c => c.app === receipt.app && c.mode === receipt.mode);
      if (!contract || receipt.requirementId !== requirement.id || !['passed', 'flaky'].includes(receipt.outcome)
        || receipt.mode !== (frontendIdentity ? 'mixed-dev' : 'shared-dev')
        || receipt.expectations?.sha256 !== contract.sha256 || !/^[a-f0-9]{40}$/.test(receipt.commit ?? '')
        || !/^[a-f0-9]{40}$/.test(testedCommit ?? '')) invalid();
      let drift = receipt.commit === testedCommit ? { valid: true, classification: 'evidence-neutral' }
        : classifyRevisionRange({ cwd, requirementId: requirement.id, fromSha: receipt.commit, toSha: testedCommit });
      // E2E may run after a TEST_EVIDENCE-only commit. Compare the real
      // ancestor to its descendant in either direction, without accepting
      // test/application changes or unrelated branch histories.
      if (!drift.valid) drift = classifyRevisionRange({ cwd, requirementId: requirement.id, fromSha: testedCommit, toSha: receipt.commit });
      if (!drift.valid || drift.classification !== 'evidence-neutral') invalid();
      if (dirname(receipt.executionReport?.path ?? '') !== dirname(reference.path)) invalid();
      const execution = read(receipt.executionReport.path);
      if (hash(execution) !== receipt.executionReport.sha256) invalid();
      const cases = assertE2eResults({ cwd, contract, report: JSON.parse(execution),
        onPassedCase: itemPlan ? args => uxItems.push(...collectUxItemExecution(args)) : undefined });
      for (const c of cases) covered.add(c.id);
      artifacts[reference.path] = reference.sha256;
      artifacts[receipt.executionReport.path] = receipt.executionReport.sha256;
    }
  } catch (e) { if (e.code === 'SCENARIO_E2E_EXECUTION_REQUIRED' || e.code?.startsWith('UX_ITEM_')) throw e; invalid(); }
  return { covered, artifacts, uxItems };
}

function requireApprovedUxItemPlan({ cwd, requirement, snapshot, ref, design }) {
  if (requirement.uxItemAcceptanceVersion !== 1) return null;
  if (!snapshot) fail('the current prototype approval is required', 'UX_ITEM_APPROVAL_REQUIRED');
  const readiness = evaluateUxReadiness({ snapshot, cwd, requirement, ref });
  if (!readiness.ok || !readiness.approval) {
    fail(readiness.detail ?? 'the prototype source must match the current direct UX approval', 'UX_ITEM_APPROVAL_REQUIRED');
  }
  return resolveUxItemPlan({ cwd, requirement, approval: readiness.approval, ref, design });
}

export function validateScenarioHandoff({ cwd, requirement, snapshot, machineVerificationEvidence, frontendIdentity = null, ref = 'HEAD', expectedBinding }) {
  const design = readAcceptanceScenarios({ cwd, requirement, ref });
  const { repo, root, plan, planSha256 } = design;
  const itemPlan = requireApprovedUxItemPlan({ cwd, requirement, snapshot, ref, design });
  const guidePath = `${root}/USER_ACCEPTANCE.md`;
  const guide = readRequired(repo, guidePath, 'USER_ACCEPTANCE_GUIDE_REQUIRED');
  if (guide !== renderUserAcceptanceGuide(plan)) fail('regenerate the complete user checklist and detailed workflow from the current design', 'USER_ACCEPTANCE_GUIDE_REQUIRED');
  if (!/^[a-f0-9]{64}$/.test(machineVerificationEvidence ?? '')) fail('self-check must bind the current machine evidence digest');
  const reportPath = `${root}/self-check/${machineVerificationEvidence}/AGENT_SELF_CHECK.json`;
  const source = readRequired(repo, reportPath, 'AGENT_SELF_CHECK_REQUIRED');
  let report;
  try { report = JSON.parse(source); } catch { fail('self-check report is invalid JSON'); }
  if (report?.schemaVersion !== 1 || report.requirementId !== requirement.id || report.planSha256 !== planSha256
    || report.machineVerificationEvidence !== machineVerificationEvidence || report.frontendIdentity !== frontendIdentity
    || !Array.isArray(report.results) || report.results.length !== plan.scenarios.length) fail('self-check does not cover the current design, machine evidence and frontend');
  const expectationPath = `${root}/E2E_EXPECTATIONS.json`;
  let expectations;
  try { expectations = JSON.parse(readRequired(repo, expectationPath, 'SCENARIO_E2E_COVERAGE_MISSING')); } catch (e) {
    if (e.code) throw e;
    fail('commit the real browser test coverage declaration', 'SCENARIO_E2E_COVERAGE_MISSING');
  }
  if (!Array.isArray(expectations.runs) || !expectations.runs.length) fail('declare real browser cases for every business scenario', 'SCENARIO_E2E_COVERAGE_MISSING');
  const covered = new Set(), contracts = [];
  for (const run of expectations.runs) {
    const contract = loadE2eExpectations({ cwd, requirementId: requirement.id, app: run.app, mode: run.mode, required: true });
    contracts.push(contract);
    for (const c of contract.cases) covered.add(c.id);
  }
  const ids = new Set(), artifacts = {}, actualScreenshots = new Set();
  for (const s of plan.scenarios) {
    if (s.kind === 'business' && !covered.has(s.id)) fail(`business journey ${s.id} has no expected browser test`, 'SCENARIO_E2E_COVERAGE_MISSING');
    const r = report.results.find(r => r.scenarioId === s.id);
    if (!r || ids.has(r.scenarioId) || r.outcome !== 'pass' || r.channel !== 'browser' || r.backend !== 'live'
      || r.initialLoad !== 'pass' || r.finalResult !== 'pass' || r.cleanup !== 'pass'
      || (s.changesData && r.readBack !== 'pass') || !Array.isArray(r.issues) || r.issues.length
      || !strings(r.observations) || r.observations.length !== s.steps.length || !strings(r.evidence) || !r.evidence.length) {
      fail(`execute every step of ${s.id}, including real data loading, result, readback and cleanup; close all issues before handoff`);
    }
    ids.add(r.scenarioId);
    const paths = [...r.evidence];
    if (s.kind === 'ui-ux') {
      if (!r.baselineScreenshot?.startsWith(`${root}/reviews/screenshots/`) || !r.actualScreenshot?.startsWith(`${root}/reviews/screenshots/`)
        || !/\.(png|webp)$/.test(r.baselineScreenshot) || !/\.(png|webp)$/.test(r.actualScreenshot)) fail(`capture the baseline and actual state of ${s.id}`);
      paths.push(r.baselineScreenshot, r.actualScreenshot);
    }
    for (const path of paths) {
      if (!path.startsWith(`${root}/`)) fail('self-check evidence must belong to this requirement');
      readRequired(repo, path, 'SCENARIO_HANDOFF_INVALID', 32 * 1024 * 1024);
      const bytes = readFileSync(join(cwd, path));
      if (paths.includes(path) && /\.(png|webp)$/.test(path)) {
        const png = path.endsWith('.png') && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        const webp = path.endsWith('.webp') && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
        if (bytes.length < 16 || bytes.length > 10 * 1024 * 1024 || (!png && !webp)) fail('self-check screenshot is invalid');
      }
      artifacts[path] = hash(bytes);
    }
    if (s.kind === 'ui-ux' && artifacts[r.baselineScreenshot] === artifacts[r.actualScreenshot]) fail('a copied screenshot cannot prove design consistency');
    if (s.kind === 'ui-ux') {
      if (actualScreenshots.has(artifacts[r.actualScreenshot])) fail('capture each distinct UI scenario instead of reusing one actual screenshot');
      actualScreenshots.add(artifacts[r.actualScreenshot]);
    }
  }
  let evidence;
  try {
    const bytes = readRequired(repo, `${root}/TEST_EVIDENCE.json`, 'SCENARIO_E2E_EXECUTION_REQUIRED');
    if (hash(bytes) !== machineVerificationEvidence) fail('the self-check is not bound to the actual machine evidence file');
    evidence = JSON.parse(bytes);
  } catch (e) { if (e.code) throw e; fail('machine evidence is not valid JSON'); }
  // The initial freeze seals verified local raw reports into durable digests.
  // Later acceptance/release checks use that trusted binding, so they remain
  // portable to another checkout without requiring the original laptop logs.
  const execution = expectedBinding?.executionEvidence
    ? { covered: new Set(expectedBinding.executionEvidence.scenarioIds), artifacts: expectedBinding.executionEvidence.artifacts }
    : executionCoverage({ cwd, requirement, report, contracts, testedCommit: evidence.testedCommit, frontendIdentity, itemPlan });
  for (const s of plan.scenarios.filter(s => s.kind === 'business')) {
    if (!execution.covered.has(s.id)) fail(`business journey ${s.id} never executed`, 'SCENARIO_E2E_EXECUTION_REQUIRED');
  }
  Object.assign(artifacts, execution.artifacts);
  const uxItemHandoff = itemPlan ? validateUxItemHandoff({
    itemPlan, report, repo, root, evidence, execution, expectedBinding: expectedBinding?.uxItemHandoff,
  }) : null;
  const binding = { schemaVersion: 1, planSha256, guidePath, guideSha256: hash(guide), reportPath,
    selfCheckSha256: hash(JSON.stringify({ report: hash(source), artifacts })), scenarioCount: plan.scenarios.length,
    executionEvidence: { scenarioIds: [...execution.covered], artifacts: execution.artifacts },
    ...(uxItemHandoff ? { uxItemHandoff } : {}) };
  if (expectedBinding && JSON.stringify(binding) !== JSON.stringify(expectedBinding)) fail('the frozen handoff differs from current self-check or user guide');
  return binding;
}

export function evaluateScenarioReadiness({ cwd, requirement, snapshot, stage, ref = 'HEAD' }) {
  if (!scenarioAcceptanceRequired({ requirement, snapshot }) || !['design', 'implementation', 'verification', 'release', 'closure'].includes(stage)) return { ok: true, missing: [] };
  try {
    const design = readAcceptanceScenarios({ cwd, requirement, ref });
    if (stage !== 'verification') requireApprovedUxItemPlan({ cwd, requirement, snapshot, ref, design });
    if (stage === 'verification') {
      const evidence = readRequired(design.repo, `${design.root}/TEST_EVIDENCE.json`, 'AGENT_SELF_CHECK_REQUIRED');
      const mixedPath = `environments/${requirement.id}/mixed-dev.json`;
      const frontendIdentity = snapshot?.has?.(mixedPath) ? snapshot.readJson(mixedPath).identitySha256 : null;
      const machineVerificationEvidence = hash(evidence);
      const pointerPath = `acceptance/${requirement.id}/current.json`;
      let candidate = null;
      if (snapshot?.has?.(pointerPath)) {
        const pointer = snapshot.readJson(pointerPath);
        const path = `acceptance/${requirement.id}/${pointer.attemptId}.json`;
        if (pointer.requirementId === requirement.id && !pointer.invalidated && ['active', 'paused', 'accepted'].includes(pointer.state)
          && /^attempt-[a-f0-9]{16,64}$/.test(pointer.attemptId ?? '') && snapshot.has(path)) {
          const fact = snapshot.readJson(path);
          if (fact.attemptId === pointer.attemptId) candidate = fact;
        }
      } else if (snapshot?.has?.('freezes/dev.json')) candidate = snapshot.readJson('freezes/dev.json');
      const matches = candidate?.requirementId === requirement.id && candidate.version === requirement.version
        && candidate.validationEpoch === (requirement.validationEpoch ?? 0)
        && candidate.machineVerificationEvidence === machineVerificationEvidence
        && (candidate.mixedEnvironmentIdentity ?? null) === frontendIdentity;
      validateScenarioHandoff({ cwd, requirement, snapshot, ref, machineVerificationEvidence, frontendIdentity,
        expectedBinding: matches ? candidate.scenarioHandoff : undefined });
    }
    return { ok: true, missing: [] };
  } catch (e) { return { ok: false, missing: [{ code: e.code ?? 'SCENARIO_HANDOFF_INVALID', message: e.message }] }; }
}
