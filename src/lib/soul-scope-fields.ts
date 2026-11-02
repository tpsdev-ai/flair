/**
 * Soul is scoped to an `agentId` and has no dedicated or enforced per-user
 * scope field (schemas/memory.graphql).
 * A write request that supplies a non-empty `scopeTag` or a non-empty `tags`
 * array is refused by name when earlier guards permit the request, whatever
 * the tag's prefix (flair#1540).
 *
 * The predicate runs in the server's write policy. The refusal name is
 * imported by `flair import` and `flair restore`, which report a row refused
 * with it; `flair rem restore` reports its generic HTTP error and imports
 * neither.
 */

/** The named refusal for a Soul write request that supplies a non-empty `scopeTag` or a non-empty `tags` array. */
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
