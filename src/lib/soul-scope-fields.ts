/**
 * Soul is scoped to an `agentId` and its schema has no `tags` or `scopeTag`
 * (schemas/memory.graphql), so a Soul row cannot record a per-user scope. A
 * write request that supplies either field is refused whatever the tag's
 * prefix, so the refusal does not depend on the `adk:` bridge (flair#1540).
 *
 * Shared with the replay writers (`flair import`, `flair restore`, REM
 * restore), which report the refusal by name.
 */

/** The named refusal for a Soul write request that supplies `scopeTag` or `tags`. */
export const SOUL_SCOPE_FIELDS_REFUSAL = "soul_scope_fields_not_writable";

/**
 * Whether a write request supplies a non-empty `scopeTag` or a non-empty
 * `tags` array. Callers pass the fields the request supplies — for a PATCH,
 * the fields the patch sets — never a row's stored fields.
 */
export function suppliesSoulScopeFields(content: any): boolean {
  const scopeTag = content?.scopeTag;
  if (scopeTag !== undefined && scopeTag !== null && scopeTag !== "") return true;
  const tags = content?.tags;
  return Array.isArray(tags) && tags.length > 0;
}
