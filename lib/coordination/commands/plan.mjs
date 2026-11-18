import {
  createStore,
  readClaimedRequirement,
  requirePositionals,
  validateRequirementId,
} from './helpers.mjs';
import {
  BACKLOG_STATUSES,
  lifecycleTransitions,
} from '../lifecycle.mjs';
import { evaluateUxReadiness } from '../ux-approvals.mjs';
import { repositoryDeliveryProgress, stageWork } from '../delivery-plan.mjs';
import { acceptanceRecovery } from '../workflow-policy.mjs';
import { userAcceptanceStageRequired } from '../ui-acceptance.mjs';

// I-132 (F4): static gate annotations per target state, mirroring the gates
// implemented in lifecycle.mjs requiredActions() ("migration resolved +
// version bound" is the base gate of every state after reviewing). Keep the
// two in sync — the plan test pins an entry for every reachable
// (profile, state) pair.
export const PLAN_GATES = Object.freeze({
  runtime: Object.freeze({
    todo: 'none',
    reviewing: 'none',
    req_confirmed: 'migration resolved + version bound',
    tech_design: 'migration resolved + version bound',
    in_dev: 'migration resolved + version bound',
    dev_deployed: 'migration resolved + version bound + release manifest + migration draft (if required) + lease(dev) + dev deployment snapshot at HEAD',
    testing: 'migration resolved + version bound + lease(dev) + dev deployment snapshot at HEAD',
    user_acceptance: 'current machine evidence + verification review + immutable candidate + human acceptance window',
    test_passed: 'migration resolved + version bound + valid machine evidence + matching dev lease or durable verified candidate + applicable direct human acceptance',
    prod_planning: 'migration resolved + version bound + tested commit merged into main',
    prod_deployed: 'migration resolved + version bound + tested commit merged + lease(prod) + prod deployment snapshot covering HEAD',
    done: 'migration resolved + version bound + completion fact merged (local plan-completion + apply-completion)',
  }),
  tooling: Object.freeze({
    todo: 'none',
    reviewing: 'none',
    req_confirmed: 'migration resolved + version bound',
    tech_design: 'migration resolved + version bound',
    in_dev: 'migration resolved + version bound',
    testing: 'migration resolved + version bound + release manifest + migration draft (if required)',
    test_passed: 'migration resolved + version bound + test evidence passed at HEAD',
    merged: 'migration resolved + version bound',
    done: 'migration resolved + version bound',
  }),
  governance: Object.freeze({
    todo: 'none',
    reviewing: 'none',
    req_confirmed: 'migration resolved + version bound',
    tech_design: 'migration resolved + version bound',
    in_dev: 'migration resolved + version bound',
    testing: 'migration resolved + version bound + release manifest + migration draft (if required)',
    test_passed: 'migration resolved + version bound + test evidence passed at HEAD',
    merged: 'migration resolved + version bound',
    done: 'migration resolved + version bound',
  }),
});

// I-132 (F4): read-only remaining-steps plan. It walks TRANSITIONS[profile]
// from the current state to done and annotates each step with the static
// gate summary above. Future gates (leases, evidence) cannot be evaluated
// yet, so the plan shows the path without predicting outcomes. It never
// writes coordination state and never pushes.
export default {
  command: 'plan',
  summary: 'Show the remaining lifecycle path and its gates',
  subcommands: [
    {
      key: 'plan',
      usage: 'plan <ID>',
      summary: 'List the states from the current one to done, with their gates',
      options: [],
      handler: async ({ parsed, ctx }) => {
        const { env, clock, cwd } = ctx;
        requirePositionals(parsed, [null]);
        const [id] = parsed.positionals;
        validateRequirementId(id);
        const store = createStore(env, clock);
        const snapshot = await store.readSnapshot();
        const requirement = readClaimedRequirement(snapshot, id);
        const recovery = acceptanceRecovery({ snapshot, requirement });
        const humanStage = userAcceptanceStageRequired({ requirement, snapshot });
        const profile = requirement.deliveryProfile;
        const base = {
          id,
          profile,
          version: requirement.version ?? null,
          lifecycle: requirement.lifecycle,
          lifecycleLabel: BACKLOG_STATUSES[requirement.lifecycle] ?? requirement.lifecycle,
          delivery: repositoryDeliveryProgress({ cwd, snapshot, requirement, clock }),
          ...(recovery ? { acceptanceRecovery: recovery } : {}),
        };
        if (['done', 'cancelled'].includes(requirement.lifecycle)) {
          return {
            message: `${id} is at terminal state ${requirement.lifecycle}`,
            data: { ...base, steps: [] },
          };
        }
        const path = [requirement.lifecycle];
        let cursor = requirement.lifecycle;
        while (cursor !== 'done') {
          const next = (lifecycleTransitions(requirement, { snapshot })?.[cursor] ?? [])[0];
          if (!next) break;
          path.push(next);
          cursor = next;
        }
        const steps = path.map((state, index) => {
          const ux = state === 'tech_design' && requirement.uxImpact === 'admin-ui'
            ? evaluateUxReadiness({ snapshot, cwd, requirement })
            : null;
          const command = index === 0
            ? (state === 'user_acceptance' && recovery ? recovery.command : null)
            : humanStage && state === 'user_acceptance'
              ? `pnpm coord freeze enter dev --requirement ${id} --candidate <id> --deployment-snapshot <file> --evidence <sha> --json`
              : humanStage && state === 'test_passed'
                ? `pnpm coord freeze unfreeze dev --requirement ${id} --outcome accepted --reason "<acceptance summary>" --authorized-by <user> --instruction-ref user-message:<id> --json`
                : `pnpm coord lifecycle next ${id}`;
          return {
            state,
            label: BACKLOG_STATUSES[state] ?? state,
            command,
            ...(index === 0 && state === 'user_acceptance' && recovery ? { preparationCommands: recovery.preparationCommands,
              requiresHumanDecision: recovery.requiresHumanDecision } : {}),
            gates: `${PLAN_GATES[profile]?.[state] ?? 'none'}${ux ? ' + current user-approved UX specification and prototype' : ''}`,
            ...(ux ? { uxMissing: ux.missing } : {}),
            current: index === 0,
            work: stageWork(state),
          };
        });
        return {
          message: `${id} plan: ${steps.length - 1} advance(s) from ${requirement.lifecycle} to done`,
          data: { ...base, steps },
        };
      },
    },
  ],
};
