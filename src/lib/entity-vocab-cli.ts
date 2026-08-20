/**
 * entity-vocab-cli.ts — CLI-side copy of the attention-plane entity
 * vocabulary validator (resources/entity-vocab.ts is the canonical module).
 *
 * INLINED, not imported: cross-boundary imports from src/ into resources/
 * don't survive npm packaging — tsconfig.cli.json compiles with
 * `rootDir: "src"`, so dist/cli.js has no resources/ module it can resolve
 * at the same relative path. This is the same reason src/cli.ts inlines the
 * federation crypto helpers (see the note beside `sortKeys()` there) and the
 * private-visibility filter. The two files MUST stay in sync:
 * test/unit/cli-entities-option.test.ts imports BOTH and pins ENTITY_TYPES
 * equality, validator parity across a known-answer table, and the
 * entityFormatHint() string — drift fails CI rather than shipping.
 *
 * Used by the `--entities <csv>` option on `flair memory add`,
 * `flair workspace set`, and `flair orgevent` (flair#1288): the CLI validates
 * before any signing/network work so a malformed entity is rejected
 * client-side with an error that names the `type:value` format and
 * enumerates the closed type set. The server independently re-validates on
 * every write path (resources/Memory.ts / WorkspaceState.ts / OrgEvent.ts via
 * invalidEntitiesResponse) — this module is UX, not the security gate.
 */

/** The closed set of entity types. Mirror of resources/entity-vocab.ts — extend BOTH together. */
export const ENTITY_TYPES = [
  "repo",
  "issue",
  "customer",
  "subsystem",
  "agent",
  "person",
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

const ENTITY_TYPE_SET: ReadonlySet<string> = new Set(ENTITY_TYPES);

/**
 * A "slug" value: lowercase alphanumeric segments joined by single `-` or
 * `_` separators. Used for `customer:`, `subsystem:`, `agent:`, `person:`.
 */
const SLUG_RE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

/** A single repo path segment (owner or name): lowercase alphanumeric with `.`, `-`, `_` internal. */
const REPO_SEGMENT_RE = /^[a-z0-9]+(?:[.\-_][a-z0-9]+)*$/;

/** `<owner>/<name>` — both segments valid, exactly one `/`. */
function isValidRepoValue(value: string): boolean {
  const parts = value.split("/");
  if (parts.length !== 2) return false;
  const [owner, name] = parts;
  return REPO_SEGMENT_RE.test(owner) && REPO_SEGMENT_RE.test(name);
}

/** `<owner>/<name>#<n>` — a valid repo value, `#`, then a positive integer (no leading zero). */
function isValidIssueValue(value: string): boolean {
  const hashIndex = value.indexOf("#");
  if (hashIndex === -1) return false;
  const repoPart = value.slice(0, hashIndex);
  const numberPart = value.slice(hashIndex + 1);
  if (!/^[1-9][0-9]*$/.test(numberPart)) return false;
  return isValidRepoValue(repoPart);
}

function isValidSlugValue(value: string): boolean {
  return SLUG_RE.test(value);
}

const VALUE_VALIDATORS: Record<EntityType, (value: string) => boolean> = {
  repo: isValidRepoValue,
  issue: isValidIssueValue,
  customer: isValidSlugValue,
  subsystem: isValidSlugValue,
  agent: isValidSlugValue,
  person: isValidSlugValue,
};

/** Split an entity string on its first `:` into { type, value }; null if it can't be well-formed. */
function parseEntity(entity: string): { type: string; value: string } | null {
  if (typeof entity !== "string" || entity.length === 0) return null;
  const colonIndex = entity.indexOf(":");
  if (colonIndex <= 0) return null; // no colon, or colon is the first char (empty type)
  const type = entity.slice(0, colonIndex);
  const value = entity.slice(colonIndex + 1);
  if (value.length === 0) return null;
  return { type, value };
}

/** Full validation: well-formed `type:value`, type in the closed set, value matches the type's grammar. */
export function isValidEntity(entity: unknown): entity is string {
  if (typeof entity !== "string") return false;
  const parsed = parseEntity(entity);
  if (!parsed) return false;
  if (!ENTITY_TYPE_SET.has(parsed.type)) return false;
  return VALUE_VALIDATORS[parsed.type as EntityType](parsed.value);
}

/**
 * Canonical "what does well-formed look like" hint (flair#1288): names the
 * `type:value` format AND enumerates the closed type set, so the rejection
 * enables a response. Must produce the EXACT string resources/entity-vocab.ts's
 * entityFormatHint() produces — the sync test compares them verbatim.
 */
export function entityFormatHint(): string {
  return `entities are 'type:value' vocabulary strings (e.g. 'repo:owner/name'); valid types: ${ENTITY_TYPES.join(", ")}`;
}

export interface ParsedEntitiesOption {
  /** Every non-empty trimmed element of the CSV, in input order (valid or not). */
  entities: string[];
  /** The subset that failed vocabulary validation. Empty means all valid. */
  invalid: string[];
}

/**
 * Parse a `--entities <csv>` option value: comma-split, trim, drop empties —
 * the same list-option convention `--tags <csv>` / `--derived-from <csv>`
 * already use (safe here because no entity grammar admits a comma) — then
 * validate each element against the vocabulary.
 */
export function parseEntitiesCsv(csv: string): ParsedEntitiesOption {
  const entities = String(csv).split(",").map((x) => x.trim()).filter(Boolean);
  const invalid = entities.filter((e) => !isValidEntity(e));
  return { entities, invalid };
}
