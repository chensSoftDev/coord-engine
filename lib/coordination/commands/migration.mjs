import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CoordinationError,
  createStore,
  readClaimedRequirement,
  requirePositionals,
  validateRequirementId,
} from './helpers.mjs';

const TEMPLATE_PATH = join('docs', 'releases', '_TEMPLATE', 'MIGRATION.md');

// I-132 (F5): render docs/releases/PENDING/MIGRATION-<ID>.md from the
// repository template, replacing the <VERSION>/<ID> placeholders with the
// requirement facts. The draft only exists when the migration is required,
// so the template's `Yes / No` marker resolves to `Yes`.
function renderMigrationDraft({ template, id, title, version }) {
  return template
    .replaceAll('<VERSION>', version)
    .replace('Migration Required: `Yes / No`', 'Migration Required: `Yes`')
    .replace('- `<ID>`', `- \`${id}\` — ${title}`);
}

// I-132 (F5): scaffold the pending migration draft for a requirement whose
// start-time declaration (--migration yes → migrationAssessment 是) demands
// one. Workspace-only: it never writes coordination state and never pushes;
// an existing draft requires --force to overwrite.
export default {
  command: 'migration',
  summary: 'Scaffold migration drafts',
  subcommands: [
    {
      key: 'migration draft',
      usage: 'migration draft <ID> [--force]',
      summary: 'Scaffold docs/releases/PENDING/MIGRATION-<ID>.md from the template',
      options: ['force'],
      handler: async ({ parsed, ctx }) => {
        const { env, clock, cwd } = ctx;
        requirePositionals(parsed, ['draft', null]);
        const [, id] = parsed.positionals;
        validateRequirementId(id);
        const store = createStore(env, clock);
        const snapshot = await store.readSnapshot();
        const requirement = readClaimedRequirement(snapshot, id);
        if (requirement.migrationAssessment !== '是') {
          throw new CoordinationError(
            `migration draft is not required for ${id} (migrationAssessment: ${requirement.migrationAssessment ?? '<undeclared>'})`,
            {
              code: 'MIGRATION_NOT_REQUIRED',
              data: { id, migrationAssessment: requirement.migrationAssessment ?? null },
            },
          );
        }
        const relativePath = `docs/releases/PENDING/MIGRATION-${id}.md`;
        if (existsSync(join(cwd, relativePath)) && parsed.options.force !== true) {
          throw new CoordinationError(
            `migration draft already exists: ${relativePath} (use --force to overwrite)`,
            { code: 'MIGRATION_DRAFT_EXISTS', data: { path: relativePath, id } },
          );
        }
        let template;
        try {
          template = readFileSync(join(cwd, TEMPLATE_PATH), 'utf8');
        } catch (error) {
          throw new CoordinationError(
            `cannot read the migration template: ${TEMPLATE_PATH}`,
            { code: 'MIGRATION_TEMPLATE_MISSING', cause: error },
          );
        }
        const version = requirement.version ?? 'UNBOUND';
        const title = requirement.title ?? id;
        writeFileSync(
          join(cwd, relativePath),
          renderMigrationDraft({ template, id, title, version }),
        );
        return {
          message: `created migration draft for ${id}`,
          data: { path: relativePath, id, version, title },
        };
      },
    },
  ],
};
