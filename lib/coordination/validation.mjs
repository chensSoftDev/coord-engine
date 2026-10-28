const REQUIREMENT_ID_PATTERN = /^(I|F|B)-\d{3,}$/;
const VERSION_PATTERN = /^v\d+\.\d+\.\d+$/;
const DELIVERY_PROFILES = new Set(['runtime', 'tooling', 'governance']);
const MIN_DURATION_MS = 5 * 60 * 1000;
const MAX_DURATION_MS = 8 * 60 * 60 * 1000;
const GIT_REVISION_PATTERN = /^(?:HEAD|[0-9a-f]{7,40}|(?:refs\/)?[A-Za-z0-9][A-Za-z0-9._/-]*)$/;

export function assertRequirementId(value) {
  if (typeof value !== 'string' || !REQUIREMENT_ID_PATTERN.test(value)) {
    throw new TypeError(`invalid requirement id: ${value ?? '<missing>'}`);
  }
  return value;
}

export function assertVersion(value) {
  if (typeof value !== 'string' || !VERSION_PATTERN.test(value)) {
    throw new TypeError(`invalid version: ${value ?? '<missing>'}`);
  }
  return value;
}

export function assertDeliveryProfile(value) {
  if (!DELIVERY_PROFILES.has(value)) {
    throw new TypeError(`invalid delivery profile: ${value ?? '<missing>'}`);
  }
  return value;
}

export function normalizeDuration(value) {
  const match = /^(\d+)(m|h)$/.exec(value ?? '');
  if (!match) {
    throw new TypeError(`invalid duration: ${value ?? '<missing>'}`);
  }

  const amount = Number.parseInt(match[1], 10);
  const durationMs = amount * (match[2] === 'h' ? 60 * 60 * 1000 : 60 * 1000);
  if (durationMs < MIN_DURATION_MS || durationMs > MAX_DURATION_MS) {
    throw new RangeError('duration must be between 5m and 8h');
  }
  return durationMs;
}

export function assertStateDocument(document) {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new TypeError('state document must be an object');
  }
  // I-130 (D4): schema v2 is the write target; v1 stays readable so
  // pre-migration state keeps loading until `coord migrate-schema` runs.
  if (document.schemaVersion !== 1 && document.schemaVersion !== 2) {
    throw new TypeError(`unsupported schema version: ${document.schemaVersion ?? '<missing>'}`);
  }
  return document;
}

export function assertGitRevision(value) {
  if (
    typeof value !== 'string'
    || !GIT_REVISION_PATTERN.test(value)
    || value.includes('..')
    || value.includes('//')
    || value.endsWith('/')
    || value.endsWith('.')
  ) {
    throw new TypeError(`invalid git revision: ${value ?? '<missing>'}`);
  }
  return value;
}
