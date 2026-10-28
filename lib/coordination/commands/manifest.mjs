import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CoordinationError,
  createStore,
  requirePositionals,
  usageError,
} from './helpers.mjs';
import { requirementDocuments } from '../requirements.mjs';
import { assertVersion } from '../validation.mjs';

const TEMPLATE_PATH = join('deploy', 'release-manifests', '_example.env');

// I-132 (F5): render deploy/release-manifests/<version>.env from the
// repository template — the four fields are replaced in place so the
// template comments survive, and an empty runtime service set keeps an
// explicit fill-in hint next to the empty value.
function renderManifest({ template, version, requirements, profile, servicesValue }) {
  return template.split('\n').map((line) => {
    if (line.startsWith('RELEASE_VERSION=')) return `RELEASE_VERSION=${version}`;
    if (line.startsWith('RELEASE_REQUIREMENTS=')) {
      return `RELEASE_REQUIREMENTS=${requirements.join(',')}`;
    }
    if (line.startsWith('RELEASE_DELIVERY_PROFILE=')) {
      return `RELEASE_DELIVERY_PROFILE=${profile}`;
    }
    if (line.startsWith('RELEASE_SERVICES=')) {
      return servicesValue.length > 0
        ? `RELEASE_SERVICES=${servicesValue}`
        : [
          '# TODO: no resources.services declared on the bound requirements —',
          '# fill in the service set manually (account,api,gateway,web,admin).',
          'RELEASE_SERVICES=',
        ].join('\n');
    }
    return line;
  }).join('\n');
}

// I-132 (F5): scaffold a release manifest from the requirements bound to a
// version. Workspace-only: it never writes coordination state and never
// pushes; an existing manifest requires --force to overwrite.
export default {
  command: 'manifest',
  summary: 'Scaffold release manifests',
  subcommands: [
    {
      key: 'manifest init',
      usage: 'manifest init <version> [--force]',
      summary: 'Scaffold deploy/release-manifests/<version>.env from the bound requirements',
      options: ['force'],
      handler: async ({ parsed, ctx }) => {
        const { env, clock, cwd } = ctx;
        requirePositionals(parsed, ['init', null]);
        const [, version] = parsed.positionals;
        try {
          assertVersion(version);
        } catch (error) {
          throw usageError(error.message);
        }
        const store = createStore(env, clock);
        const snapshot = await store.readSnapshot();
        const bound = requirementDocuments(snapshot)
          .filter((requirement) => requirement.version === version);
        if (bound.length === 0) {
          throw usageError(
            `no requirements are bound to ${version}; bind one first with pnpm coord requirement bind-version <ID> ${version} --json`,
          );
        }
        const profiles = new Set(bound.map((requirement) => requirement.deliveryProfile));
        const profile = profiles.has('runtime')
          ? 'runtime'
          : profiles.size === 1 && profiles.has('governance')
            ? 'governance'
            : 'tooling';
        const hints = [];
        if (profile === 'runtime' && profiles.size > 1) {
          hints.push('mixed delivery profiles bound to this version; runtime wins (deployment gates apply)');
        }
        const services = profile === 'runtime'
          ? [...new Set(bound.flatMap((requirement) => requirement.resources?.services ?? []))]
            .sort()
          : [];
        const servicesValue = profile === 'runtime' ? services.join(',') : 'none';
        const templatePath = join(cwd, TEMPLATE_PATH);
        let template;
        try {
          template = readFileSync(templatePath, 'utf8');
        } catch (error) {
          throw new CoordinationError(
            `cannot read the release manifest template: ${TEMPLATE_PATH}`,
            { code: 'MANIFEST_TEMPLATE_MISSING', cause: error },
          );
        }
        const relativePath = `deploy/release-manifests/${version}.env`;
        if (existsSync(join(cwd, relativePath)) && parsed.options.force !== true) {
          throw new CoordinationError(
            `release manifest already exists: ${relativePath} (use --force to overwrite)`,
            { code: 'MANIFEST_EXISTS', data: { path: relativePath, version } },
          );
        }
        const requirements = bound.map((requirement) => requirement.id);
        writeFileSync(
          join(cwd, relativePath),
          renderManifest({ template, version, requirements, profile, servicesValue }),
        );
        return {
          message: `initialized release manifest for ${version}`,
          data: {
            path: relativePath,
            version,
            requirements,
            profile,
            services: servicesValue,
            validateCommand: `./scripts/validate-release-manifest.sh --version ${version} --target HEAD`,
            hints,
          },
        };
      },
    },
  ],
};
