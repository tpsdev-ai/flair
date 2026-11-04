/**
 * The table a fake operations-API call addresses. A `sql` body carries the table in its
 * statement (`FROM flair.<table>`); every other operation names it in `table`. Fake
 * servers route on this instead of `body.table`, which a `sql` body does not set.
 */
export function opsTable(body: { table?: unknown; sql?: unknown }): string {
  if (typeof body.table === "string" && body.table.length > 0) return body.table;
  return /FROM\s+flair\.(\w+)/.exec(String(body.sql ?? ""))?.[1] ?? "";
}
