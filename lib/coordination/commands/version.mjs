import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { createStore, requirePositionals, requiredOption, usageError } from './helpers.mjs';
import {
  listVersionIssues,
  recordVersionIssue,
  updateVersionIssue,
} from '../version-issues.mjs';

function repeatable(parsed, name) {
  const value = parsed.options[name];
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

export default {
  command: 'version',
  summary: 'Manage release Version facts and iteration issues',
  subcommands: [
    {
      key: 'version issue record',
      usage: 'version issue record <version> --file <path>',
      summary: 'Validate and record one fixed-format version iteration issue',
      options: ['file'],
      handler: async ({ parsed, ctx }) => {
        const { cwd, clock } = ctx;
        requirePositionals(parsed, ['issue', 'record', null]);
        const [, , version] = parsed.positionals;
        const file = requiredOption(parsed, 'file');
        let issue;
        try { issue = JSON.parse(readFileSync(isAbsolute(file) ? file : join(cwd, file), 'utf8')); } catch (error) { throw usageError(`cannot read issue file: ${error.message}`); }
        const result = recordVersionIssue({ cwd, version, issue, clock });
        return { message: `recorded ${result.issue.issueId} for ${version}`, data: result };
      },
    },
    {
      key: 'version issue update',
      usage: 'version issue update <version> <issue-id> --status <status> --note <note> [--root-cause <text>] [--decision <text>] [--fix-requirement <ID>] [--evidence <path>] [--command <argv>] [--verified-at <ISO>]',
      summary: 'Append an issue timeline event and update its repair facts',
      options: ['status', 'note', 'root-cause', 'decision', 'fix-requirement', 'evidence', 'command', 'verified-at'],
      handler: async ({ parsed, ctx }) => {
        requirePositionals(parsed, ['issue', 'update', null, null]);
        const [, , version, issueId] = parsed.positionals;
        const result = updateVersionIssue({
          cwd: ctx.cwd,
          version,
          issueId,
          status: requiredOption(parsed, 'status'),
          note: requiredOption(parsed, 'note'),
          actor: ctx.env.COORD_AGENT ?? 'unknown',
          rootCause: parsed.options['root-cause'],
          decision: parsed.options.decision,
          fixRequirementId: parsed.options['fix-requirement'],
          evidence: repeatable(parsed, 'evidence'),
          commands: repeatable(parsed, 'command'),
          verifiedAt: parsed.options['verified-at'] ?? null,
          clock: ctx.clock,
        });
        return { message: `updated ${issueId} for ${version}`, data: result };
      },
    },
    {
      key: 'version issue list',
      usage: 'version issue list <version>',
      summary: 'List fixed-format iteration issues for a Version',
      options: [],
      handler: async ({ parsed, ctx }) => {
        requirePositionals(parsed, ['issue', 'list', null]);
        const [, , version] = parsed.positionals;
        const result = listVersionIssues({ cwd: ctx.cwd, version });
        return { message: `${version} has ${result.issues.length} iteration issue(s)`, data: result };
      },
    },
  ],
};
