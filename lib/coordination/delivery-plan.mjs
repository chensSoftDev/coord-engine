import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DELIVERY_BUDGETS = Object.freeze({ design: 60, implementation: 210, verification: 60, acceptance: 30, release: 30, correction: 90 });
const work = (doneWhen, inputs, prepareEarly, humanDecision = false) => ({ doneWhen, inputs, prepareEarly, humanDecision });
const STAGES = Object.freeze({
  reviewing: work(['业务目标、范围、风险及验收人明确；按规模判断八小时容量'], ['原始反馈、当前实现与历史决定'], ['环境权限、schema、样本数据与发布依赖']),
  req_confirmed: work(['UX任务、状态、文案和原型由用户确认'], ['已确认需求、反馈定义、可操作原型'], ['技术可行性、迁移与不可逆风险'], true),
  tech_design: work(['逐场景验收契约和实现任务覆盖全部已采纳反馈；未决问题关闭'], ['当前UX确认、接口/schema、影响范围'], ['发布计划、回滚条件、运行环境canary、测试造数和清理']),
  in_dev: work(['每个场景实现并自验；异常/权限/交互与原型逐项核对；implementation review通过'], ['研发设计、验收契约、反馈追踪'], ['取得dev租约前运行pnpm verify:check保存本地检查凭据；真实启动/登录/关键操作；准备用户验收步骤']),
  dev_deployed: work(['目标服务身份、schema/seed与健康匹配'], ['匹配lease、部署receipt、迁移方案'], ['测试选择清单与fixture清理验证']),
  testing: work(['必选机器场景覆盖且通过；交互/视觉自查完成；verification review通过'], ['不可变候选、环境预检、测试输入、预期场景清单'], ['冻结候选、用户操作步骤、发布产物准备']),
  user_acceptance: work(['用户针对当前候选明确接受；反馈已分类处理'], ['机器与review证据、交互报告、视觉基线与实际截图'], ['发布计划、回滚入口、可复用构建产物'], true),
  test_passed: work(['通过Ready门禁并建立准确合并事实'], ['有效机器证据、适用人工接受事实、preflight'], ['生产参数与上次成功发布基线']),
  prod_planning: work(['发布/迁移/回滚方案就绪；获得必要生产授权'], ['已合并候选、参数绑定构建receipt、release review'], ['磁盘、健康、备份及幂等恢复准备'], true),
  prod_deployed: work(['精确生产receipt与验证结果登记；closure review完成'], ['本次成功部署、健康与业务smoke证据'], ['completion计划与断点恢复']),
  merged: work(['本地completion计划应用、合并及收敛'], ['准确main合并事实、closure review'], ['释放占用并归档长期事实']),
  done: work(['真实交付完成'], ['completion事实'], []),
});
export function stageWork(state) { return STAGES[state] ?? work(['按当前生命周期门禁完成'], ['需求与版本事实'], ['核对下一阶段缺项']); }
const millis = value => Date.parse(value ?? '');
const minutes = value => Math.round(value / 600) / 100;

// Only explicit intervals are execution/queue/rework facts. Unknown elapsed time
// remains unattributed; lifecycle duration must never masquerade as CPU time.
export function deliveryProgress({ requirement, uxApproval, intervals = [], now = new Date() }) {
  const history = (requirement.lifecycleHistory ?? []).filter(event => Number.isFinite(millis(event.at))).sort((a, b) => millis(a.at) - millis(b.at));
  const starts = [uxApproval?.authorizedAt, requirement.deliveryStartedAt, ...history.filter(event => event.to === 'tech_design').map(event => event.at)].map(millis).filter(Number.isFinite);
  const basic = { targetMinutes: 480, budgets: DELIVERY_BUDGETS, targetIsGuarantee: false, includesWaiting: true };
  if (!starts.length) return { ...basic, startedAt: null, elapsedMinutes: null, targetMet: null, reason: 'UX confirmation start has not been recorded' };
  const start = Math.min(...starts);
  const finish = history.find(event => event.to === 'prod_deployed' && millis(event.at) >= start);
  const end = Math.max(start, finish ? millis(finish.at) : now.getTime());
  const ranges = [...intervals];
  for (let index = 0; index < history.length; index += 1) {
    if (history[index].to === 'user_acceptance') ranges.push({ kind: 'humanWait', start: history[index].at, end: history[index + 1]?.at ?? new Date(end).toISOString() });
  }
  const normalized = ranges.filter(item => ['execution', 'queue', 'humanWait', 'rework'].includes(item.kind))
    .map(item => ({ kind: item.kind, start: Math.max(start, millis(item.start)), end: Math.min(end, millis(item.end)) }))
    .filter(item => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start);
  const points = [...new Set([start, end, ...normalized.flatMap(item => [item.start, item.end])])].sort((a, b) => a - b);
  const totals = { execution: 0, queue: 0, humanWait: 0, rework: 0, unattributed: 0 };
  for (let index = 1; index < points.length; index += 1) {
    const active = normalized.filter(item => item.start <= points[index - 1] && item.end >= points[index]);
    const category = ['rework', 'execution', 'queue', 'humanWait'].find(kind => active.some(item => item.kind === kind)) ?? 'unattributed';
    totals[category] += points[index] - points[index - 1];
  }
  const elapsed = minutes(end - start);
  return { ...basic, startedAt: new Date(start).toISOString(), finishedAt: finish?.at ?? null,
    completed: Boolean(finish), elapsedMinutes: elapsed, remainingMinutes: Math.max(0, 480 - elapsed), overdueMinutes: Math.max(0, elapsed - 480),
    targetMet: finish ? elapsed <= 480 : null, breakdown: Object.fromEntries(Object.entries(totals).map(([key, value]) => [`${key}Minutes`, minutes(value)])),
    note: 'Wall time includes all waiting. Unrecorded work stays unattributed; overlapping intervals are counted once.' };
}

export function repositoryDeliveryProgress({ cwd, snapshot, requirement, clock = () => new Date() }) {
  const intervals = [];
  const root = join(cwd, 'docs/product/current');
  const folders = existsSync(root) ? readdirSync(root).filter(name => name.startsWith(`${requirement.id}-`)) : [];
  if (folders.length === 1) {
    try {
      const evidence = JSON.parse(readFileSync(join(root, folders[0], 'TEST_EVIDENCE.json'), 'utf8'));
      for (const command of evidence.commands ?? []) if (!command.reused) intervals.push({ kind: 'execution', start: command.startedAt, end: command.finishedAt });
    } catch { /* missing evidence is not elapsed-time evidence */ }
  }
  const path = `ux-approvals/${requirement.id}.json`;
  return deliveryProgress({ requirement, uxApproval: snapshot.has(path) ? snapshot.readJson(path) : null, intervals, now: clock() });
}
