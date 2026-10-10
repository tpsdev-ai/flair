export async function readExactTableCount(
  opsPost: (body: Record<string, unknown>, context: string) => Promise<unknown>,
  table: string,
): Promise<number> {
  const parsed: any = await opsPost(
    { operation: "describe_table", database: "flair", table, exact_count: true },
    `${table} row count`,
  );
  const n = parsed?.record_count;
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`${table} row count via the operations API: response carried no record_count`);
  }
  return n;
}

/**
 * The exact count of the rows a bounded table read matches — those with
 * `attribute` at or after `since` — through the operations API (`describe_table`
 * counts a whole table, not a range). The bounded deletion-history read is
 * bracketed against this the way a whole-table read is bracketed against
 * `readExactTableCount`: a result the count does not match is a read error, never
 * a history that would read as an unexplained loss.
 */
export async function readExactCountSince(
  opsPost: (body: Record<string, unknown>, context: string) => Promise<unknown>,
  table: string,
  attribute: string,
  since: string,
): Promise<number> {
  const parsed: any = await opsPost(
    { operation: "sql", sql: `SELECT COUNT(*) AS n FROM flair.${table} WHERE ${attribute} >= '${since}'` },
    `${table} bounded row count`,
  );
  const row = Array.isArray(parsed) ? parsed[0] : Array.isArray(parsed?.results) ? parsed.results[0] : undefined;
  const n = row?.n;
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`${table} bounded row count via the operations API: response carried no n`);
  }
  return n;
}
