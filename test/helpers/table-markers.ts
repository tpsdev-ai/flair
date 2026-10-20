/**
 * Marker rows for the table-subscription integration tests: every table in the
 * flair database with its primary key and attribute types, read from the
 * database itself, and a committed row whose primary key is a test's marker.
 * Each call goes through the operations API with the `op` the test passes,
 * which must target the test's own ephemeral Harper.
 */

/** Sends one operations-API request as an administrator. */
export type AdminOp = (body: Record<string, unknown>) => Promise<Response>;

export interface TableShape { primaryKey: string; types: Map<string, string | undefined> }

/** Tables in the flair database, each with its primary-key attribute and attribute types. */
export async function flairTableShapes(op: AdminOp): Promise<Map<string, TableShape>> {
  const res = await op({ operation: "describe_database", database: "flair" });
  const text = await res.text();
  if (res.status !== 200) throw new Error(`describe_database answered ${res.status}: ${text.slice(0, 200)}`);
  const body = JSON.parse(text);
  const out = new Map<string, TableShape>();
  for (const t of Object.keys(body).sort()) {
    const primaryKey = body[t]?.primary_key;
    if (typeof primaryKey !== "string") throw new Error(`describe_database names no primary key for ${t}`);
    const types = new Map<string, string | undefined>((body[t].attributes ?? []).map((a: any) => [String(a.attribute), typeof a.type === "string" ? a.type : undefined]));
    out.set(t, { primaryKey, types });
  }
  return out;
}

/** A value of `type` for a required attribute: the marker for text and ids. */
export function fillValue(type: string | undefined, marker: string): unknown {
  switch (type) {
    case "Int": case "Long": case "Float": case "BigInt": return 1;
    case "Boolean": return false;
    case "array": case "Array": return [];
    default: return marker;
  }
}

/**
 * Commit a row to `table` whose primary key is `key`, filling each attribute
 * the table requires (named by the table's own validation answer) from its
 * declared type. Answers the row.
 */
export async function commitMarkerRow(op: AdminOp, table: string, shape: TableShape, key: string): Promise<Record<string, unknown>> {
  const row: Record<string, unknown> = { [shape.primaryKey]: key };
  let last = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await op({ operation: "upsert", database: "flair", table, records: [row] });
    last = await res.text();
    if (res.status === 200) return row;
    const required = [...last.matchAll(/Property (\w+) is required/g)].map((m) => m[1]);
    const arrays = [...last.matchAll(/in property (\w+) must be an Array/g)].map((m) => m[1]);
    if (required.length === 0 && arrays.length === 0) break;
    for (const name of required) row[name] = fillValue(shape.types.get(name), key);
    for (const name of arrays) row[name] = [];
  }
  throw new Error(`could not commit a marker row to ${table}: ${last.slice(0, 300)}`);
}
