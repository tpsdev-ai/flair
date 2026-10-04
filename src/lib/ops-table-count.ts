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
