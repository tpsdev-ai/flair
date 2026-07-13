/**
 * entity-vocab.ts — the attention-plane entity vocabulary convention + validator.
 *
 * Foundation slice of the attention plane (flair#675, spec: FLAIR-ATTENTION-PLANE.md).
 * One vocabulary, used everywhere an entity is referenced: a namespaced
 * `type:value` string, lowercased type, drawn from a CLOSED, documented type
 * set. See docs/entity-vocabulary.md for the full convention writeup — this
 * module is the single source of truth the docs describe and every write
 * path (WorkspaceState, OrgEvent, Memory, and eventually Relationship) should
 * validate against before persisting an `entities` value.
 *
 * Matching is exact on the full `type:value` string — no prefix/regex
 * matching, no case-folding beyond what's enforced here. This keeps the
 * planned attention query (a future slice — NOT built here) a plain indexed
 * equality lookup, not a scan.
 *
 * This module does ONLY vocabulary validation. It does not read/write any
 * table, does not implement the attention query, and does not do collision
 * surfacing — those are separate follow-up slices (see FLAIR-ATTENTION-PLANE.md
 * Phase 1 query / Phase 2 collision surfacing).
 */

/** The closed set of entity types. Extend deliberately — this list IS the vocabulary. */
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

export function isEntityType(type: string): type is EntityType {
  return ENTITY_TYPE_SET.has(type);
}

/**
 * A "slug" value: lowercase alphanumeric segments joined by single `-` or
 * `_` separators. No leading/trailing separators, no doubled separators, no
 * empty string. Used for `customer:`, `subsystem:`, `agent:`, `person:`.
 */
const SLUG_RE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

/**
 * A single repo path segment (owner or name): lowercase alphanumeric with
 * `.`, `-`, `_` allowed as internal separators (covers real-world repo/owner
 * names like `tpsdev-ai`, `harper.fast`). No leading/trailing separator.
 */
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

/**
 * Split an entity string on its first `:` into { type, value }. Returns null
 * for anything that can't possibly be a well-formed entity string (no colon,
 * empty type, empty value) — callers still need isValidEntity()/type-set
 * membership to confirm it's actually valid.
 */
export function parseEntity(entity: string): { type: string; value: string } | null {
  if (typeof entity !== "string" || entity.length === 0) return null;
  const colonIndex = entity.indexOf(":");
  if (colonIndex <= 0) return null; // no colon, or colon is the first char (empty type)
  const type = entity.slice(0, colonIndex);
  const value = entity.slice(colonIndex + 1);
  if (value.length === 0) return null;
  return { type, value };
}

/**
 * Full validation: well-formed `type:value`, type is in the closed set, and
 * the value matches that type's grammar. This is the ONE gate every write
 * path should call before persisting an entity string.
 */
export function isValidEntity(entity: unknown): entity is string {
  if (typeof entity !== "string") return false;
  const parsed = parseEntity(entity);
  if (!parsed) return false;
  if (!isEntityType(parsed.type)) return false;
  return VALUE_VALIDATORS[parsed.type](parsed.value);
}

export interface EntityValidationResult {
  valid: boolean;
  /** The subset of the input that failed validation (as their original string form). */
  invalid: string[];
}

/**
 * Validate an `entities` field value (expected: string[] | undefined | null).
 * `undefined`/`null` is treated as valid — the field is additive/optional,
 * absence is not an error (mirrors Presence's `activityUpdatedAt` pattern).
 * A non-array, non-null/undefined value is reported invalid as a whole.
 */
export function validateEntities(entities: unknown): EntityValidationResult {
  if (entities === undefined || entities === null) return { valid: true, invalid: [] };
  if (!Array.isArray(entities)) return { valid: false, invalid: [String(entities)] };

  const invalid: string[] = [];
  for (const entity of entities) {
    if (!isValidEntity(entity)) invalid.push(typeof entity === "string" ? entity : String(entity));
  }
  return { valid: invalid.length === 0, invalid };
}

/**
 * Convenience helper for Harper resource write paths (WorkspaceState.ts,
 * OrgEvent.ts, Memory.ts): validates `content.entities` and returns a ready-
 * to-return 400 Response on failure, or `null` if the field is absent/valid.
 * Callers just do: `const err = invalidEntitiesResponse(content.entities); if (err) return err;`
 */
export function invalidEntitiesResponse(entities: unknown): Response | null {
  const result = validateEntities(entities);
  if (result.valid) return null;
  return new Response(
    JSON.stringify({ error: "invalid_entities", invalid: result.invalid }),
    { status: 400, headers: { "Content-Type": "application/json" } },
  );
}
