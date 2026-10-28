import {
  CoordinationError,
  createStore,
  requirePositionals,
} from './helpers.mjs';
import { runGit, validateTestEvidence } from '../evidence.mjs';
import { freezeFactFromSnapshot } from '../leases.mjs';

export default {
  command: 'evidence',
  summary: 'Validate machine-readable test evidence',
  subcommands: [
    {
      key: 'evidence validate',
      usage: 'evidence validate <ID> [--head <sha>] [--base <sha>]',
      summary: 'Validate machine-readable test evidence for a requirement',
      options: ['head', 'base'],
      handler: async ({ parsed, ctx }) => {
        const { env, clock, cwd } = ctx;
        requirePositionals(parsed, ['validate', null]);
        const [, id] = parsed.positionals;
        const store = createStore(env, clock);
        const snapshot = await store.readSnapshot();
        const requirementPath = `requirements/${id}.json`;
        if (!snapshot.has(requirementPath)) {
          throw new CoordinationError(`requirement is not claimed: ${id}`, {
            code: 'REQUIREMENT_NOT_FOUND',
          });
        }
        // B-248: --head/--base default to the live refs so a plain validate
        // cannot quietly self-check the evidence's own recorded commit. An
        // explicit --head that differs from the real HEAD flips the verdict
        // into a clearly labelled diagnostic, never a gate-equivalent pass.
        const actualHead = runGit(cwd, ['rev-parse', 'HEAD']);
        const requestedHead = parsed.options.head;
        const head = requestedHead ?? actualHead;
        const base = parsed.options.base ?? 'origin/main';
        const diagnostic = requestedHead !== undefined && requestedHead !== actualHead;
        const result = await validateTestEvidence({
          cwd,
          id,
          head,
          base,
          requirement: snapshot.readJson(requirementPath),
          deployment: snapshot.has('deployments/dev.json')
            ? snapshot.readJson('deployments/dev.json')
            : null,
          mixedEnvironment: snapshot.has(`environments/${id}/mixed-dev.json`)
            ? snapshot.readJson(`environments/${id}/mixed-dev.json`)
            : null,
          lease: snapshot.has('locks/dev.json') ? snapshot.readJson('locks/dev.json').active : null,
          // I-128 (M6): after the awaiting_human freeze conversion the dev lease
          // is consumed, so validate must consult the freeze fact exactly like
          // `lifecycle advance --to test_passed` does — otherwise it reports
          // DEV_LEASE_MISMATCH for evidence the advance path accepts.
          freeze: (() => {
            const fact = freezeFactFromSnapshot(snapshot, 'dev');
            return fact?.requirementId === id ? fact : null;
          })(),
          clock,
        });
        return {
          message: diagnostic
            ? `DIAGNOSTIC ONLY: --head ${requestedHead} differs from the real HEAD ${actualHead}; this verdict is not the gate verdict`
            : `test evidence is valid for ${id}`,
          data: diagnostic ? { ...result, diagnostic: true, actualHead } : result,
        };
      },
    },
  ],
};
