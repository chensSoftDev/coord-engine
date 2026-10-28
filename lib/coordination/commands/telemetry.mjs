import {
  requirePositionals,
  requiredOption,
} from './helpers.mjs';
import {
  aggregatePhaseDurations,
  recordPhaseEvent,
} from '../telemetry.mjs';

export default {
  command: 'telemetry',
  summary: 'Record/aggregate SLA phase timing events',
  subcommands: [
    {
      key: 'telemetry record',
      usage: 'telemetry record <ID> --phase <phase> --started-at <iso> [--commit <sha>] [--candidate <id>] [--ended-at <iso>]',
      summary: 'Record an SLA phase timing event',
      options: ['phase', 'commit', 'candidate', 'started-at', 'ended-at'],
      handler: async ({ parsed, ctx }) => {
        const { cwd } = ctx;
        requirePositionals(parsed, ['record', null]);
        const [, id] = parsed.positionals;
        const event = recordPhaseEvent({
          cwd,
          requirementId: id,
          phase: requiredOption(parsed, 'phase'),
          commit: parsed.options.commit ?? null,
          candidateId: parsed.options.candidate ?? null,
          startedAt: requiredOption(parsed, 'started-at'),
          endedAt: parsed.options['ended-at'] ?? null,
        });
        return { message: `recorded telemetry ${event.phase} for ${id}`, data: { event } };
      },
    },
    {
      key: 'telemetry aggregate',
      usage: 'telemetry aggregate <ID>',
      summary: 'Aggregate SLA phase durations',
      options: [],
      handler: async ({ parsed, ctx }) => {
        const { cwd } = ctx;
        requirePositionals(parsed, ['aggregate', null]);
        const [, id] = parsed.positionals;
        const aggregated = aggregatePhaseDurations({ cwd, requirementId: id });
        return { message: `telemetry aggregated for ${id}`, data: aggregated };
      },
    },
  ],
};
