import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createStore, readClaimedRequirement, requirePositionals, requiredOption } from './helpers.mjs';
import { isSafeReviewPath } from '../feedback.mjs';
import { ReviewError, prepareReview, showReview, recordReview, verifyReview } from '../reviews.mjs';
import { loadSession } from '../worktrees.mjs';

function readReport(cwd, value) {
  const path = isAbsolute(value) ? relative(cwd, value) : value;
  if (!isSafeReviewPath(path)) throw new ReviewError('--report must reference a regular JSON file inside the current repository without traversal', { code: 'REVIEW_REPORT_PATH_INVALID' });
  let cursor = resolve(cwd);
  try {
    for (const part of path.split('/')) {
      cursor = join(cursor, part);
      if (lstatSync(cursor).isSymbolicLink()) throw new Error('symlink');
    }
    const stat = lstatSync(cursor);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('report must be a regular file smaller than 1 MiB');
  } catch (error) {
    throw new ReviewError(`cannot use report ${path}: ${error.message}`, { code: 'REVIEW_REPORT_PATH_INVALID' });
  }
  try { return JSON.parse(readFileSync(cursor, 'utf8')); } catch (error) {
    throw new ReviewError(`cannot parse report ${path}: ${error.message}`, { code: 'REVIEW_REPORT_INVALID' });
  }
}

function readCommand(action, inspect) {
  return {
    key: `review ${action}`, usage: `review ${action} <ID> --stage <stage>`,
    summary: action === 'prepare' ? 'Inspect committed stage inputs and the remaining two-round review budget' : 'Show immutable review facts and current stage readiness',
    options: ['stage'],
    handler: async ({ parsed, ctx }) => {
      requirePositionals(parsed, [action, null]);
      const [, id] = parsed.positionals;
      const stage = requiredOption(parsed, 'stage');
      const snapshot = await createStore(ctx.env, ctx.clock).readSnapshot();
      const requirement = readClaimedRequirement(snapshot, id);
      const data = inspect({ snapshot, cwd: ctx.cwd, requirement, stage });
      return { message: `${id} ${stage} review ${action === 'prepare' ? 'package' : 'facts'}`, data };
    },
  };
}
function writeCommand(action, operation) {
  return {
    key: `review ${action}`, usage: `review ${action} <ID> --stage <stage> --report <file.json>`,
    summary: action === 'record' ? 'Record one immutable comprehensive review, with at most two rounds per stage/cycle' : 'Record one targeted verification of findings and any newly discovered blockers within the declared repair scope',
    options: ['stage', 'report'],
    handler: async ({ parsed, ctx }) => {
      requirePositionals(parsed, [action, null]);
      const [, id] = parsed.positionals;
      const stage = requiredOption(parsed, 'stage');
      const report = readReport(ctx.cwd, requiredOption(parsed, 'report'));
      const data = await operation({ store: createStore(ctx.env, ctx.clock), cwd: ctx.cwd, id, stage, report,
        session: loadSession({ cwd: ctx.cwd, sessionId: ctx.env.COORD_SESSION_ID }), clock: ctx.clock });
      return { message: `${action === 'record' ? 'recorded' : 'verified'} ${id} ${stage} review`, data };
    },
  };
}

export default {
  command: 'review', summary: 'Prepare, record, show or verify a stage review bound to committed inputs',
  subcommands: [readCommand('prepare', prepareReview), readCommand('show', showReview), writeCommand('record', recordReview), writeCommand('verify', verifyReview)],
};
