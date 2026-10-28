import {
  createStore,
  readClaimedRequirement,
  requirePositionals,
  validateRequirementId,
} from './helpers.mjs';
import {
  BACKLOG_STATUSES,
  TRANSITIONS,
} from '../lifecycle.mjs';
import { evaluateUxReadiness } from '../ux-approvals.mjs';

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
    test_passed: 'migration resolved + version bound + lease(dev) + dev deployment snapshot at HEAD + test evidence passed at HEAD',
    prod_planning: 'migration resolved + version bound + tested commit merged into main',
    prod_deployed: 'migration resolved + version bound + tested commit merged + lease(prod) + prod deployment snapshot covering HEAD',
    done: 'migration resolved + version bound + completion fact merged (Coordination Complete workflow)',
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
        const profile = requirement.deliveryProfile;
        const base = {
          id,
          profile,
          version: requirement.version ?? null,
          lifecycle: requirement.lifecycle,
          lifecycleLabel: BACKLOG_STATUSES[requirement.lifecycle] ?? requirement.lifecycle,
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
          const next = (TRANSITIONS[profile]?.[cursor] ?? [])[0];
          if (!next) break;
          path.push(next);
          cursor = next;
        }
        const steps = path.map((state, index) => {
          const ux = state === 'tech_design' && requirement.uxImpact === 'admin-ui'
            ? evaluateUxReadiness({ snapshot, cwd, requirement })
            : null;
          return {
            state,
            label: BACKLOG_STATUSES[state] ?? state,
            command: index === 0 ? null : `pnpm coord lifecycle next ${id}`,
            gates: `${PLAN_GATES[profile]?.[state] ?? 'none'}${ux ? ' + current user-approved UX specification and prototype' : ''}`,
            ...(ux ? { uxMissing: ux.missing } : {}),
            current: index === 0,
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
