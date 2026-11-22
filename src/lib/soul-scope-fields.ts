/**
 * Soul is scoped to an `agentId` and has no dedicated or enforced per-user
 * scope field (schemas/memory.graphql).
 * A write that would store a non-empty `scopeTag` or a non-empty `tags` array
 * is refused by name when earlier guards permit the request, whatever the tag's
 * prefix: POST and PUT check the request body, PATCH the merged row
 * (flair#1540).
 *
 * The predicate runs in the server's write policy. The refusal name is
 * imported by `flair import` and `flair restore`, which report a row refused
 * with it; `flair rem restore` reports its generic HTTP error and imports
 * neither.
 */

/** The named refusal for a Soul write that would store a non-empty `scopeTag` or a non-empty `tags` array. */
export const SOUL_SCOPE_FIELDS_REFUSAL = "soul_scope_fields_not_writable";

/**
 * Whether a row would carry a non-empty `scopeTag` or a non-empty `tags`
 * array. POST and PUT pass the request body; PATCH passes the merged row.
 */
export function suppliesSoulScopeFields(content: any): boolean {
  const scopeTag = content?.scopeTag;
  if (scopeTag !== undefined && scopeTag !== null && scopeTag !== "") return true;
  const tags = content?.tags;
  return Array.isArray(tags) && tags.length > 0;
}
