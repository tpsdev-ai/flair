import { expect, test } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { rawTableWriteSites } from "../helpers/raw-table-writers";

/**
 * seed-id-writer-coverage.test.ts — flair#2141 S2: classify raw Memory write
 * sites detected by the inventory helper for the reserved id.
 *
 * The guarded Resource paths require the operator source: an authenticated
 * Basic administrator or a deliberate internal call. No storage hook sees
 * every Memory write, so those paths call a reserved-id decision before
 * writing (`reservedSeedWriteDenial`, or `reservedSeedFeedWriteDenial` for the
 * feed, which refuses a reserved seed id outright). This test inventories raw
 * Memory write sites in its supported source patterns and classifies each as:
 *
 *   GUARDED     — the decision runs on the ids this write can land on;
 *   OPERATOR    — the route already requires the operator source;
 *   BOOKKEEPING — lastReflected and embedding backfill update selected fields;
 *                 usage recording intends to change only usageCount but
 *                 re-PUTs the stored row and can take an agent-supplied id;
 *   SERVER      — the server selects the rows (a sweep, a migration, a row it
 *                 just wrote under a generated id), or another table, or a
 *                 read-only alias.
 *
 * A new raw writer detected by the inventory fails until classified. This
 * test does not establish coverage for every possible write path.
 */

const classified = new Map<string, string>();
const add = (file: string, sites: string[], reason: string) => {
  for (const site of sites) classified.set(`resources/${file}.ts:${site}`, reason);
};

// ── GUARDED ──
add("Memory", [
  "writer:cls.create#1", "writer:(databases as any).flair.Memory.post#1",
  "writer:(databases as any).flair.Memory.put#2",
  "writer:super.put#1",
  "writer:super.patch#1",
  "writer:super.patch#2",
  "writer:(databases as any).flair.Memory.delete#1",
], "GUARDED: Memory.post/put/patch/delete call the decision on the URL and body ids first (the put _reindex branch included).");
add("Memory", ["writer:(databases as any).flair.Memory.put#1"],
  "GUARDED: closeSupersededRecord closes `supersedes`, which validateAndAuthorizeSupersedes ran through the decision before the new row was written.");
add("MemoryFeed", ["writer:(databases as any).flair.Memory.put#1"],
  "GUARDED: FeedMemories.post calls the decision on the body id before the raw put.");
add("MemoryFeed", ["writer:(databases as any).flair.Memory.put#2"],
  "GUARDED: the dedup expiry repair (flair#2358) calls the decision on the id it writes before the raw put.");
add("Federation", ["writer:table.put#1"],
  "GUARDED: the merge skips a reserved id (seed_id_not_federated) before the put.");
add("skill-version-write", ["writer:(databases as any).flair.Memory.put#1", "writer:(databases as any).flair.Memory.put#2"],
  "GUARDED: the transactional skill writer (flair#2139 S2) is reached only after Memory.post/put/delete or FeedMemories ran the reserved-id decision on the write's ids; the successor upsert and predecessor close ride the same transaction.");
add("skill-version-write", ["alias-source:(databases as any).flair?.Memory#1"],
  "SERVER: a table handle (resolveSkillHead searches the live skill head).");

// ── OPERATOR ──
add("AgentSeed", ["writer:(databases as any).flair.Memory.put#1"],
  "OPERATOR: POST /AgentSeed requires the operator source (authorizeSoulWrite), the authority the reservation asks for.");
add("MemoryPurge", ["writer:memory.delete#1"],
  "OPERATOR: POST /MemoryPurge requires the operator source (soulWriteSource in allowCreate), the authority the reservation asks for.");

// ── BOOKKEEPING (deliberately open; see the distinctions above) ──
add("Memory", ["writer:patchRecord#1"],
  "BOOKKEEPING: lastReflected on each derivedFrom source of a new row.");
add("usage-recording", ["writer:(databases as any).flair.Memory.put#1"],
  "BOOKKEEPING: usageCount + 1 on a row the caller can read; the rest of the row is the stored row.");
add("auth-middleware", ["writer:patchRecord#1"],
  "BOOKKEEPING: the embedding backfill for the id of a Memory write that already succeeded (and so passed the decision).");
add("MemoryReflect", ["writer:patchRecordSilent#1"],
  "BOOKKEEPING: lastReflected on the rows a reflection run read.");

// ── SERVER ──
add("MemoryMaintenance", ["writer:(databases as any).flair.Memory.delete#1", "writer:(databases as any).flair.Memory.update#1"],
  "SERVER: the sweep selects rows by state (expired ephemeral, closed, old session notes). The seed row is persistent and closing it by supersede requires the operator-source decision.");
add("MemoryMaintenance", ["writer:table.delete#1"], "SERVER: MemoryHostSource pointer rows, another table.");
add("MemoryReindex", ["writer:Memory.put#1"], "SERVER: admin-only re-PUT of each stored row with its own stored fields.");
add("promotion-stamp", ["writer:table.put#1"],
  "SERVER: stamps a row the promotion just wrote through Memory.put under a server-generated id.");
add("migrations/embedding-stamp", [
  "writer:table.put#1",
], "SERVER: the migration re-embeds a server-selected row through the raw table handle when its id ends in the `.content` property suffix — an id the by-id HTTP regen path cannot address.");
add("migrations/graph-heal", ["writer:table.put#1"], "SERVER: boot migration over server-selected rows.");
add("migrations/synthetic-test-migration", ["writer:table.put#1"], "SERVER: boot migration over server-selected rows.");
add("migrations/visibility-backfill", ["writer:table.put#1"], "SERVER: boot migration over server-selected rows.");
add("hit-tracking", [
  "writer:this.pending.delete#1",
  "writer:this.cache.delete#1",
  "writer:this.tails.delete#1",
  "writer:this.pending.delete#2",
  "writer:this.tables.stats.put#1",
  "writer:table.put#1",
  "writer:table.delete#1",
], "SERVER: the MemoryHitStat table and in-memory maps, not Memory rows.");
add("AgentSeed", ["writer:(databases as any).flair.Agent.put#1", "writer:(databases as any).flair.Soul.put#1"], "SERVER: other tables.");
add("Federation", [
  "writer:(databases as any).flair.Instance.put#1",
  "writer:(databases as any).flair.PairingToken.put#1",
  "writer:(databases as any).flair.Peer.put#1",
  "writer:(databases as any).flair.Peer.put#2",
  "writer:(databases as any).flair.Peer.put#3",
  "writer:(databases as any).flair.SyncLog.put#1",
], "SERVER: other tables.");
add("MemoryReflect", ["writer:(databases as any).flair.MemoryCandidate.put#1"], "SERVER: another table.");
add("usage-recording", ["writer:(databases as any).flair.MemoryUsage.put#1"], "SERVER: another table.");
for (const [file, alias] of [
  ["Memory", "alias-source:(databases as any).flair.Memory#1"],
  ["Memory", "alias-source:(databases as any).flair.Memory#2"],
  ["AdminMemory", "alias-source:(databases as any).flair.Memory#1"],
  ["Federation", "alias-source:(databases as any).flair.Memory#1"],
  ["MemoryReflect", "alias-source:(databases as any).flair.Memory#1"],
  ["MemoryReindex", "alias-source:(databases as any).flair.Memory#1"],
  ["auth-middleware", "alias-source:(databases as any).flair.Memory#1"],
  ["promotion-stamp", "alias-source:(databases as any).flair.Memory#1"],
  ["hit-tracking", "alias-source:(databases as any).flair?.Memory#1"],
  ["health", "alias-source:db.flair?.Memory#1"],
  ["migration-boot", "alias-source:flair?.Memory#1"],
  ["bm25-index-service", "alias-source:(databases as any).flair?.Memory#1"],
  ["MemoryPurge", "alias-source:(databases as any).flair?.Memory#1"],
  ["embedding-space-guard", "alias-source:(databases as unknown as { flair: { Memory: MemoryTableLike } }).flair.Memory#1"],
  ["migrations/embedding-stamp", "alias-source:(databases as unknown as { flair: { Memory: MemoryTableLike } }).flair.Memory#1"],
  ["migrations/graph-heal", "alias-source:(databases as unknown as { flair: { Memory: MemoryTableLike } }).flair.Memory#1"],
  ["migrations/synthetic-test-migration", "alias-source:(databases as unknown as { flair: { Memory: MemoryTableLike } }).flair.Memory#1"],
  ["migrations/visibility-backfill", "alias-source:(databases as unknown as { flair: { Memory: MemoryTableLike } }).flair.Memory#1"],
]) {
  add(file, [alias], "SERVER: a table handle; its writes, if any, are the sites classified above.");
}

test("raw Memory write sites detected by the inventory are classified for the reserved seed id", () => {
  const sites = [...new Glob("{resources,src}/**/*.ts").scanSync(".")].flatMap((file) => rawTableWriteSites(file, readFileSync(file, "utf8"), "Memory"));
  expect(sites.filter((site) => !classified.has(site.key)).map((site) => site.key)).toEqual([]);
  expect([...classified.keys()].filter((key) => !sites.some((site) => site.key === key))).toEqual([]);
});

/**
 * The end of a guard decision that STOPS the method on a denial:
 * `const X = [await ]<call>(...);` immediately followed by `if (X) return X;`
 * (or `if (X.denial) return X.denial;` when `denialField` is given). -1 when
 * the decision is absent or its denial is not returned right there, so a
 * decision whose result is ignored fails the checks below.
 */
function denialReturnEnd(body: string, call: string, denialField?: string): number {
  const escaped = call.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const result = denialField ? `\\1\\.${denialField}` : "\\1";
  const re = new RegExp(`const (\\w+) = (?:await )?${escaped}\\([\\s\\S]*?\\);\\s*if \\(${result}\\) return ${result};`);
  const match = re.exec(body);
  return match ? match.index + match[0].length : -1;
}

/** The end of `recordSkip("<reason>");` immediately followed by `continue;`; -1 otherwise. */
function skipContinueEnd(src: string, reason: string): number {
  const match = new RegExp(`recordSkip\\("${reason}"\\);\\s*continue;`).exec(src);
  return match ? match.index + match[0].length : -1;
}

const WRITES = ["super.put(", "super.patch(", "writeMemoryRowPost(", ".flair.Memory.put(", ".flair.Memory.post(", ".flair.Memory.delete("];

/** Every write in `body` (each of `writes`) sits after `stop`. */
function expectWritesAfter(body: string, stop: number, label: string, writes: string[] = WRITES): void {
  expect(stop, `${label}: the decision is missing or its denial does not stop the method`).toBeGreaterThan(-1);
  for (const write of writes) {
    const at = body.indexOf(write);
    if (at !== -1) expect(at, `${label}: ${write} before the decision stops the method`).toBeGreaterThan(stop);
  }
}

/** The body of `  async <name>(` up to the next class method. */
function methodBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  expect(start, `${signature} not found`).toBeGreaterThan(-1);
  const next = src.indexOf("\n  async ", start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

test("the listed entry paths run the decision, and its denial stops the path before it writes", () => {
  const memory = readFileSync("resources/Memory.ts", "utf8");
  for (const signature of ["  async post(content: any, context?: any) {", "  async put(content: any, query?: any) {", "  async patch(content: any, query?: any) {"]) {
    const body = methodBody(memory, signature);
    expect(body, `${signature} does not call the decision`).toContain('refuseReservedSeedWrite("Memory", writeTargetIds(this, content)');
    expectWritesAfter(body, denialReturnEnd(body, "refuseReservedSeedWrite"), signature);
  }
  const del = methodBody(memory, "  async delete(id: any) {");
  expect(del, "delete() does not call the decision on its id").toContain('reservedSeedWriteDenial(\n      "Memory", [id,');
  expectWritesAfter(del, denialReturnEnd(del, "reservedSeedWriteDenial"), "delete()");

  const supersede = memory.slice(memory.indexOf("async function validateAndAuthorizeSupersedes("));
  const supersedeBody = supersede.slice(0, supersede.indexOf("\n}\n"));
  expect(supersedeBody).toContain('reservedSeedWriteDenial("Memory", [content.supersedes], ctx, auth)');
  expect(supersedeBody, "the supersede decision's denial is not returned").toMatch(/const seedDenial = reservedSeedWriteDenial\("Memory", \[content\.supersedes\], ctx, auth\);\s*if \(seedDenial\) return refuse\(seedDenial\);/);
  for (const signature of ["  async post(content: any, context?: any) {", "  async put(content: any, query?: any) {"]) {
    const body = methodBody(memory, signature);
    expect(body, `${signature} does not validate supersedes`).toContain("validateAndAuthorizeSupersedes(content, auth, ctx,");
    // The _reindex branch of put() writes earlier but never reaches a supersede;
    // the new-row write and the close must come after the denial returns.
    expectWritesAfter(body, denialReturnEnd(body, "validateAndAuthorizeSupersedes", "denial"), `${signature} supersedes`,
      ["writeMemoryRowPost(", ".flair.Memory.put(", "closeSupersededIfNeeded("]);
  }

  const feed = readFileSync("resources/MemoryFeed.ts", "utf8");
  expect(feed).toContain('reservedSeedFeedWriteDenial("Memory", [...writeTargetIds(this, content), content?.supersedes])');
  expectWritesAfter(feed, denialReturnEnd(feed, "reservedSeedFeedWriteDenial"), "FeedMemories.post");

  const federation = readFileSync("resources/Federation.ts", "utf8");
  const skip = skipContinueEnd(federation, "seed_id_not_federated");
  expect(skip, "the seed skip does not stop the record").toBeGreaterThan(-1);
  expect(federation.indexOf("await table.put(", skip)).toBeGreaterThan(skip);
});

test("the listed entry paths run the .content-suffix id decision on the ids it writes, and its denial stops the path before it writes", () => {
  // The decision's inputs: the bound id and body ids (writeTargetIds), and the
  // request target too (#2343 added it for POST), so a suffix only in the URL counts.
  const memory = readFileSync("resources/Memory.ts", "utf8");
  for (const [signature, call] of [
    ["  async post(content: any, context?: any) {", "refuseContentSuffixId(writeTargetIds(this, content), context);"],
    ["  async put(content: any, query?: any) {", "refuseContentSuffixId(writeTargetIds(this, content), query);"],
    ["  async patch(content: any, query?: any) {", "refuseContentSuffixId(writeTargetIds(this, content), query);"],
  ] as const) {
    const body = methodBody(memory, signature);
    expect(body, `${signature} does not run the decision on its write ids`).toContain(`const contentSuffixDenial = ${call}`);
    expectWritesAfter(body, denialReturnEnd(body, "refuseContentSuffixId"), signature);
  }
  const del = methodBody(memory, "  async delete(id: any) {");
  expect(del, "delete() does not run the decision on its id").toContain(
    "refuseContentSuffixId(\n      [id, ...writeTargetIds(this, id && typeof id === \"object\" ? id : undefined)], id,\n    );",
  );
  expectWritesAfter(del, denialReturnEnd(del, "refuseContentSuffixId"), "delete()");

  const feed = readFileSync("resources/MemoryFeed.ts", "utf8");
  expect(feed, "FeedMemories.post does not run the decision on its write ids").toContain("const contentSuffixDenial = refuseContentSuffixId(writeTargetIds(this, content));");
  expectWritesAfter(feed, denialReturnEnd(feed, "refuseContentSuffixId"), "FeedMemories.post");

  // The federation merge: the predicate runs on the id of the row it writes
  // (`mergedData`), the skip stops the record, and the put of that row follows.
  const federation = readFileSync("resources/Federation.ts", "utf8");
  const guard = /if \(record\.table === "Memory" && endsWithContentSelectorSuffix\(mergedData\.id\)\) \{\s*recordSkip\("content_suffix_id_not_federated"\);\s*continue;/.exec(federation);
  expect(guard, "the federation merge does not test endsWithContentSelectorSuffix(mergedData.id) before skipping, or the skip does not stop the record").not.toBeNull();
  const skip = skipContinueEnd(federation, "content_suffix_id_not_federated");
  expect(skip).toBe(guard!.index + guard![0].length);
  expect(federation.indexOf("await table.put(mergedData);", skip), "the merge does not write the row the predicate checked after the skip").toBeGreaterThan(skip);
});

test("a new direct, aliased or computed Memory writer fails classification", () => {
  for (const source of [
    "databases.flair.Memory.put(row)",
    "const memory = databases.flair.Memory; memory.delete(id)",
    "patchRecord(databases.flair.Memory, id, data)",
    'const db = databases.flair; db["Memory"].patch(row)',
  ]) {
    const sites = rawTableWriteSites("resources/NewWriter.ts", source, "Memory");
    expect(sites.some((site) => site.kind === "writer" && !classified.has(site.key)), source).toBe(true);
  }
});
