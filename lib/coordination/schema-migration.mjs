import { lockFromSnapshot } from './leases.mjs';

// I-130 (D4): coordination state schema v2. The root schema.json and every
// locks/*.json document are written at this version; all other document kinds
// (requirements, versions, deployments, operations, …) keep their own format
// version. Reads tolerate v1 until this migration has run.
export const STATE_SCHEMA_VERSION = 2;

export class SchemaMigrationError extends Error {
  constructor(message, { code, exitCode = 14, data = {}, cause } = {}) {
    super(message, { cause });
    this.name = 'SchemaMigrationError';
    this.code = code;
    this.exitCode = exitCode;
    this.data = data;
  }
}

function isLockPath(path) {
  return path.startsWith('locks/') && path.endsWith('.json');
}

function lockResource(path) {
  return path.slice('locks/'.length, -'.json'.length);
}

// Flag-day migration to schema v2 in a single coordination update: rewrite the
// root schema.json and every locks/*.json document in place, preserving all
// other content. An active lease acquired before Lease v2 has no `version`
// field; converting it would require guessing the bound version, so the
// migration refuses and names the resources to release first. The mutation is
// atomic: when it throws, nothing is committed. Rewriting a v2 document
// produces byte-identical content, so a fully migrated state is a no-op
// (store.update reports changed=false).
export async function migrateSchema({ store }) {
  return store.update({
    operation: 'migrate coordination state to schema v2',
    mutate(snapshot) {
      const blocking = [];
      for (const path of snapshot.paths().filter(isLockPath)) {
        const lock = lockFromSnapshot(snapshot, lockResource(path));
        if (lock.active !== null && typeof lock.active.version !== 'string') {
          blocking.push(lockResource(path));
        }
      }
      if (blocking.length > 0) {
        throw new SchemaMigrationError(
          `active lease(s) predate schema v2 and have no version; release them first: ${blocking.map((resource) => `pnpm coord lock release ${resource}`).join(', ')}`,
          {
            code: 'LOCK_VERSION_MISSING',
            exitCode: 12,
            data: { resources: blocking },
          },
        );
      }

      const schema = snapshot.readJson('schema.json');
      snapshot.writeJson('schema.json', { ...schema, schemaVersion: STATE_SCHEMA_VERSION });
      for (const path of snapshot.paths().filter(isLockPath)) {
        const lock = lockFromSnapshot(snapshot, lockResource(path));
        snapshot.writeJson(path, { ...lock, schemaVersion: STATE_SCHEMA_VERSION });
      }
    },
  });
}
