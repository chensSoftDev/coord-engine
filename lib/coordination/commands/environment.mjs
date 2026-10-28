import { createStore, readClaimedRequirement, requirePositionals, requiredOption } from './helpers.mjs';
import { assertVersionLease } from '../leases.mjs';
import { prepareMixedEnvironment, recordMixedEnvironment, showMixedEnvironment } from '../mixed-environments.mjs';
import { loadSession } from '../worktrees.mjs';

export default {
  command: 'environment', summary: 'Prepare, record and inspect mixed-dev runtime identity',
  subcommands: ['prepare', 'record', 'show'].map(action => ({
    key: `environment ${action}`,
    usage: `environment ${action} <ID>${action === 'show' ? '' : ' --app admin|web --base-url <loopback-origin>'}`,
    summary: `${action} the local frontend and shared dev backend identity`,
    options: action === 'show' ? [] : ['app', 'base-url'],
    handler: async ({ parsed, ctx: { cwd, env, clock } }) => {
      requirePositionals(parsed, [action, null]); const [, requirementId] = parsed.positionals;
      const store = createStore(env, clock);
      if (action === 'show') return { message: `mixed environment for ${requirementId}`, data: { environment: await showMixedEnvironment({ store, requirementId }) } };
      const options = { store, cwd, requirementId, app: requiredOption(parsed, 'app'), baseUrl: requiredOption(parsed, 'base-url'), session: loadSession({ cwd, sessionId: env.COORD_SESSION_ID }), clock };
      if (action === 'record') return { message: `recorded mixed environment for ${requirementId}`, data: await recordMixedEnvironment(options) };
      const devLease = await assertVersionLease({ ...options, resource: 'dev' });
      const snapshot = await store.readSnapshot();
      const environment = await prepareMixedEnvironment({ ...options, requirement: readClaimedRequirement(snapshot, requirementId), devLease, devSnapshot: snapshot.has('deployments/dev.json') ? snapshot.readJson('deployments/dev.json') : null });
      return { message: `prepared mixed environment for ${requirementId}`, data: { environment } };
    },
  })),
};
