/**
 * originator-instance-writer-coverage.test.ts — flair#1965 round 3.
 *
 * The server-stamped `originatorInstanceId` contract is only as good as the set
 * of writers that honour it. The four resource classes share ONE delegate
 * (resources/originator-instance.ts); every OTHER writer that CREATES a synced
 * row does so through a RAW table handle (`(databases as any).flair.<Table>.put`),
 * bypassing those classes' post()/put()/patch(), so it must apply the rule
 * itself.
 *
 * Round 2 pinned a FIXED list of files for ONE substring each, which could not
 * detect a NEW raw writer (and, per review, stayed green even when a stamp call
 * was removed from a file that had another stamp call). This version ENUMERATES
 * the raw write sites instead: it scans resources/ for the raw synced-table
 * write idiom — a literal `.flair.<Table>.<verb>(` call, or a call of the
 * shared write-back helper under any alias, keyed by the table its first
 * argument names (see writeBackTable) — groups the sites by (file, table,
 * verb), and
 * requires a REVIEWED policy entry with an expected count for every one. A new
 * site — a new file, a new table/verb in a known file, or an extra call in a
 * known file — has no policy entry (or the wrong count) and fails the lane.
 *
 * The literal idiom cannot see a writer that resolves the table handle through a
 * variable first (the federation merge builds `{ Memory: databases.flair.Memory,
 * ... }` and calls `table.put(...)`); those are listed as explicit DYNAMIC
 * exceptions below and each is asserted to still exist. Harper's administrator
 * ops API (`:9925`) is outside the repo and cannot be enumerated here.
 *
 * Verified by a mutation: appending an unstamped `(databases as any).flair.Soul.put(...)`
 * to a resources file turns the enumeration test RED (see the round-3 report).
 */
import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { writerHelperCalls } from "../helpers/raw-table-writers";

const SYNCED_TABLES = ["Memory", "Soul", "Agent", "Relationship"] as const;
const WRITE_VERBS = ["put", "post", "patch", "delete"] as const;

/** The literal raw synced-table write idiom, e.g. `(databases as any).flair.Memory.put(`. */
const RAW_WRITE_RE = new RegExp(
  `\\.flair\\.(${SYNCED_TABLES.join("|")})\\.(${WRITE_VERBS.join("|")})\\s*\\(`,
  "g",
);

/**
 * The synced table a write-back call's first argument names: a literal
 * `.flair.<Table>` in the argument, or in the initializer of a same-file
 * variable the argument names (every binding of that name must agree). Any
 * other argument resolves to "?", and such a site needs its own reviewed
 * policy entry, so an unreviewed one fails the gate (flair#2354).
 */
function writeBackTable(call: ts.CallExpression): string {
  const tableIn = (text: string) => text.match(new RegExp(`\\.flair\\??\\.(${SYNCED_TABLES.join("|")})\\b`))?.[1];
  const arg = call.arguments[0];
  if (!arg) return "?";
  const direct = tableIn(arg.getText());
  if (direct) return direct;
  let expr: ts.Expression = arg;
  while (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isNonNullExpression(expr)) expr = expr.expression;
  if (!ts.isIdentifier(expr)) return "?";
  const name = expr.text;
  const tables = new Set<string | undefined>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      tables.add(node.initializer ? tableIn(node.initializer.getText()) : undefined);
    }
    if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.name.text === name) tables.add(undefined);
    ts.forEachChild(node, visit);
  };
  visit(call.getSourceFile());
  const [only] = [...tables];
  return tables.size === 1 && only ? only : "?";
}

type Disposition = "stamped-create" | "update-only" | "resource-internal";

/**
 * The reviewed policy: key `file|table|verb` -> { count, disposition, note }.
 * A raw writer that CREATES a synced-table row is `stamped-create`; one that
 * only re-writes an EXISTING row is `update-only`; a resource's own raw
 * persistence (the row already carries the value decided above it) is
 * `resource-internal`. Every entry is asserted to be present with its count.
 * A key whose sites differ lists one entry per disposition; their counts sum.
 */
type PolicyEntry = { count: number; disposition: Disposition; note: string };
const POLICY: Record<string, PolicyEntry | PolicyEntry[]> = {
  // Raw CREATE writers — must apply the rule themselves.
  "resources/AgentSeed.ts|Agent|put": { count: 1, disposition: "stamped-create", note: "POST /AgentSeed raw Agent create" },
  "resources/AgentSeed.ts|Soul|put": { count: 1, disposition: "stamped-create", note: "POST /AgentSeed raw Soul create" },
  "resources/AgentSeed.ts|Memory|put": { count: 1, disposition: "stamped-create", note: "POST /AgentSeed raw starter-Memory create" },
  "resources/XAA.ts|Agent|put": { count: 1, disposition: "stamped-create", note: "IdP principal raw Agent create" },
  "resources/mcp-handler.ts|Agent|put": { count: 1, disposition: "stamped-create", note: "JIT OAuth principal raw Agent create" },
  "resources/MemoryFeed.ts|Memory|write-back": { count: 1, disposition: "stamped-create", note: "POST /FeedMemories raw Memory create/update, through the shared write-back helper (flair#2354); its plan applies applyOriginatorInstanceId" },
  "resources/auth-middleware.ts|Memory|write-back": { count: 1, disposition: "update-only", note: "embedding backfill on an EXISTING row, through the shared write-back helper (flair#2354)" },
  "resources/MemoryReindex.ts|Memory|write-back": { count: 1, disposition: "update-only", note: "admin reindex re-PUT of an EXISTING row; buildReindexRow keeps the stored originatorInstanceId (flair#2354)" },
  "resources/promotion-stamp.ts|Memory|write-back": { count: 1, disposition: "update-only", note: "auto-promotion verdict stamp on the row its Memory write produced (flair#2354)" },
  // Write-back calls whose table argument is not resolvable here ("?").
  "resources/table-helpers.ts|?|write-back": { count: 1, disposition: "update-only", note: "patchRecord: merges a patch into an EXISTING row of the table its caller passes; it throws when the row is absent" },
  "resources/migrations/visibility-backfill.ts|?|write-back": { count: 1, disposition: "update-only", note: "boot migration re-PUT of EXISTING rows of its injected table" },
  "resources/migrations/synthetic-test-migration.ts|?|write-back": { count: 1, disposition: "update-only", note: "test-only boot migration re-PUT of EXISTING rows of its injected table" },
  "resources/MemoryFeed.ts|Memory|put": [
    { count: 1, disposition: "update-only", note: "dedup expiry repair of an EXISTING row (flair#2358)" },
  ],
  "resources/skill-version-write.ts|Memory|put": { count: 2, disposition: "resource-internal", note: "Memory and FeedMemories stamp successors in their transaction plans; predecessor closes retain stored stamps." },
  // Update-only / resource-internal raw writes — they re-write an existing row.
  "resources/Memory.ts|Memory|post": { count: 1, disposition: "resource-internal", note: "Memory writeMemoryRowPost fallback (content already stamped)" },
  "resources/Memory.ts|Memory|put": { count: 3, disposition: "resource-internal", note: "Memory.put shared-txn persist + closeSupersededRecord + re-embed" },
  "resources/Memory.ts|Memory|delete": { count: 1, disposition: "resource-internal", note: "Memory.delete raw table delete" },
  "resources/MemoryMaintenance.ts|Memory|delete": { count: 1, disposition: "resource-internal", note: "reap/delete of existing rows" },
  "resources/usage-recording.ts|Memory|put": { count: 1, disposition: "update-only", note: "usage counters on an EXISTING row" },
};

/**
 * Raw synced-table writers that resolve the table handle through a VARIABLE, so
 * the literal idiom above cannot see them. Each is an explicit exception to the
 * stamping rule (reviewed), and is asserted to still exist.
 */
const DYNAMIC_RAW_WRITE_EXCEPTIONS: Array<{ file: string; marker: string; note: string }> = [
  {
    file: "resources/Federation.ts",
    marker: "table.put(mergedData)",
    note: "FederationSync.post merge — applies a verified, non-revoked peer's rows via a resolved table handle",
  },
];

/** Directory scan (recursive), skipping test files. */
function resourceSources(root = "resources"): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return resourceSources(path);
    return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [path] : [];
  });
}

/** Strip block + line comments so a doc example never counts as a write site. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Enumerate raw synced-table write sites in ONE source string. */
function enumerateRawWriteSites(src: string, file: string): Map<string, number> {
  const counts = new Map<string, number>();
  const code = stripComments(src);
  const re = new RegExp(RAW_WRITE_RE.source, "g");
  for (const match of code.matchAll(re)) {
    const key = `${file}|${match[1]}|${match[2]}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  // Calls of the shared write-back helper under any import or local alias
  // (writerHelperCalls throws on a reference it cannot follow to a call).
  for (const call of writerHelperCalls(file, src)) {
    if (call.helper !== "writeBackCommittedRow") continue;
    const key = `${file}|${writeBackTable(call.call)}|write-back`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function enumerateAll(): Map<string, number> {
  const all = new Map<string, number>();
  for (const file of resourceSources()) {
    for (const [key, n] of enumerateRawWriteSites(readFileSync(file, "utf8"), file)) {
      all.set(key, (all.get(key) ?? 0) + n);
    }
  }
  return all;
}

test("the detector finds a raw write site (self-proof: a synthetic unstamped writer is detected)", () => {
  const synthetic = `async function leak(id) {\n  await (databases as any).flair.Relationship.put({ id });\n}\n`;
  const found = enumerateRawWriteSites(synthetic, "resources/__synthetic__.ts");
  expect([...found.keys()]).toEqual(["resources/__synthetic__.ts|Relationship|put"]);
});

test("an aliased write-back call and one whose table is passed through a variable are enumerated (flair#2354)", () => {
  const aliased = [
    'import { writeBackCommittedRow as wb } from "./write-back.js";',
    "async function leak(id) {",
    '  await wb((databases as any).flair.Soul, id, (row) => ({ write: row }), { label: "fixture" });',
    "}",
  ].join("\n");
  expect([...enumerateRawWriteSites(aliased, "resources/__aliased__.ts").keys()]).toEqual(["resources/__aliased__.ts|Soul|write-back"]);
  const variable = [
    'import { writeBackCommittedRow } from "./write-back.js";',
    "const target = (databases as any).flair.Agent;",
    "async function leak(id) {",
    '  await writeBackCommittedRow(target, id, (row) => ({ write: row }), { label: "fixture" });',
    "}",
  ].join("\n");
  expect([...enumerateRawWriteSites(variable, "resources/__variable__.ts").keys()]).toEqual(["resources/__variable__.ts|Agent|write-back"]);
  const unresolved = [
    'import { writeBackCommittedRow } from "./write-back.js";',
    "async function leak(table, id) {",
    '  await writeBackCommittedRow(table, id, (row) => ({ write: row }), { label: "fixture" });',
    "}",
  ].join("\n");
  expect([...enumerateRawWriteSites(unresolved, "resources/__unresolved__.ts").keys()]).toEqual(["resources/__unresolved__.ts|?|write-back"]);
  expect(POLICY["resources/__unresolved__.ts|?|write-back"]).toBeUndefined();
});

test("every raw synced-table write site under resources/ has a reviewed policy entry with the expected count", () => {
  const detected = enumerateAll();
  const undetectedInPolicy: string[] = [];
  const countMismatch: string[] = [];
  // 1. every detected site must be reviewed (a NEW site fails here)
  for (const [key, count] of detected) {
    const entry = POLICY[key];
    const expected = entry ? [entry].flat().reduce((n, e) => n + e.count, 0) : 0;
    if (!entry) undetectedInPolicy.push(`${key} (x${count})`);
    else if (expected !== count) countMismatch.push(`${key}: policy ${expected}, detected ${count}`);
  }
  // 2. every policy entry must still exist (a removed/relocated site is caught)
  const stale = Object.keys(POLICY).filter((key) => !detected.has(key));
  expect({ undetectedInPolicy, countMismatch, stale }).toEqual({ undetectedInPolicy: [], countMismatch: [], stale: [] });
});

test("every stamped raw create writer applies the shared rule; dynamic exceptions still exist", () => {
  const missingStamp = Object.entries(POLICY)
    .filter(([, entry]) => [entry].flat().some((e) => e.disposition === "stamped-create"))
    .filter(([key]) => {
      const file = key.split("|")[0];
      const src = readFileSync(file, "utf8");
      return !(src.includes("stampOriginatorOnCreate(") || src.includes("applyOriginatorInstanceId("));
    })
    .map(([key]) => key);
  expect(missingStamp).toEqual([]);

  const missingDynamic = DYNAMIC_RAW_WRITE_EXCEPTIONS
    .filter(({ file, marker }) => !readFileSync(file, "utf8").includes(marker))
    .map(({ file }) => file);
  expect(missingDynamic).toEqual([]);
});

// The four resource writers (Memory, Soul, Agent, Relationship) are checked on
// their REST write routes, not by source text: see
// test/integration/collection-post-attribution.test.ts, which sends a
// collection POST to each, a PUT to a new and an existing id for Memory,
// Relationship and Soul, and a PATCH for Agent, each with a body-supplied
// originatorInstanceId, and reads back the stored value.
