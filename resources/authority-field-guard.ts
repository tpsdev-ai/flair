/** Workflow verdicts can only be stamped by their trusted raw-table paths.
 * Keep unchanged echoes compatible with full-row clients, and preserve omitted
 * stamps on PUT; omission must not erase a verdict. No admin/body bypass. */
export const AUTHORITY_FIELDS = {
  Memory: ["promotionStatus", "promotedAt", "promotedBy"],
} as const;

export async function guardAuthorityFields(
  getExisting: () => unknown,
  content: any,
  table: keyof typeof AUTHORITY_FIELDS,
): Promise<Response | null> {
  const existing = await getExisting() as Record<string, unknown> | undefined;
  for (const field of AUTHORITY_FIELDS[table]) {
    if (Object.hasOwn(content, field) && content[field] !== existing?.[field]) {
      return new Response(JSON.stringify({ error: `forbidden: ${field} is set by the promotion workflow` }), {
        status: 403, headers: { "content-type": "application/json" },
      });
    }
  }
  for (const field of AUTHORITY_FIELDS[table]) {
    if (existing && Object.hasOwn(existing, field)) content[field] = existing[field];
  }
  return null;
}

/** Drop workflow stamps from a request-origin raw write. Unconditional: even
 * stamps the guard would restore onto an omitted-field update must not land
 * through ingest paths that are not a promotion-stamp site. */
export function stripAuthorityFields(
  record: Record<string, unknown>,
  table: keyof typeof AUTHORITY_FIELDS,
): void {
  for (const field of AUTHORITY_FIELDS[table]) delete record[field];
}
