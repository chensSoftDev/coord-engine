import {
  CoordinationError,
  createStore,
  requirePositionals,
  requiredOption,
} from './helpers.mjs';
import { validateTestEvidence } from '../evidence.mjs';
import { freezeFactFromSnapshot } from '../leases.mjs';

export default {
  command: 'evidence',
  summary: 'Validate machine-readable test evidence',
  subcommands: [
    {
      key: 'evidence validate',
      usage: 'evidence validate <ID> --head <sha> --base <sha>',
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
        const result = await validateTestEvidence({
          cwd,
          id,
          head: requiredOption(parsed, 'head'),
          base: requiredOption(parsed, 'base'),
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
        return { message: `test evidence is valid for ${id}`, data: result };
      },
    },
  ],
};
