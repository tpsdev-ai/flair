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
add("Federation", ["writer:table.put#1"],
  "GUARDED: the merge skips a reserved id (seed_id_not_federated) before the put.");
add("skill-version-write", ["writer:(databases as any).flair.Memory.put#1", "writer:(databases as any).flair.Memory.put#2"],
  "GUARDED: the transactional skill writer (flair#2139 S2) is reached only after Memory.post/put/delete or FeedMemories ran the reserved-id decision on the write's ids; the successor upsert and predecessor close ride the same transaction.");
add("skill-version-write", ["alias-source:(databases as any).flair?.Memory#1"],
  "SERVER: a table handle (resolveSkillHead searches the live skill head).");

// ── OPERATOR ──
add("AgentSeed", ["writer:(databases as any).flair.Memory.put#1"],
  "OPERATOR: POST /AgentSeed requires the operator source (authorizeSoulWrite), the authority the reservation asks for.");

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

/** The body of `  async <name>(` up to the next class method. */
function methodBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  expect(start, `${signature} not found`).toBeGreaterThan(-1);
  const next = src.indexOf("\n  async ", start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

test("each GUARDED path runs the decision before it writes", () => {
  const memory = readFileSync("resources/Memory.ts", "utf8");
  for (const signature of ["  async post(content: any, context?: any) {", "  async put(content: any, query?: any) {", "  async patch(content: any, query?: any) {"]) {
    const body = methodBody(memory, signature);
    const check = body.indexOf('refuseReservedSeedWrite("Memory", writeTargetIds(this, content)');
    expect(check, `${signature} does not call the decision`).toBeGreaterThan(-1);
    expect(body.indexOf("if (seedDenial) return seedDenial;"), signature).toBeGreaterThan(check);
    for (const write of ["super.put(", "super.patch(", "writeMemoryRowPost(", ".flair.Memory.put("]) {
      const at = body.indexOf(write);
      if (at !== -1) expect(at, `${signature}: ${write} before the decision`).toBeGreaterThan(check);
    }
  }
  const del = methodBody(memory, "  async delete(id: any) {");
  const delCheck = del.indexOf('reservedSeedWriteDenial(\n      "Memory", [id,');
  expect(delCheck, "delete() does not call the decision on its id").toBeGreaterThan(-1);
  expect(del.indexOf(".flair.Memory.delete(")).toBeGreaterThan(delCheck);

  const supersede = memory.slice(memory.indexOf("async function validateAndAuthorizeSupersedes("));
  expect(supersede.slice(0, supersede.indexOf("\n}\n"))).toContain('reservedSeedWriteDenial("Memory", [content.supersedes], ctx, auth)');
  expect(memory.match(/validateAndAuthorizeSupersedes\(content, auth, ctx\)/g)?.length).toBe(2);

  const feed = readFileSync("resources/MemoryFeed.ts", "utf8");
  const feedCheck = feed.indexOf('reservedSeedFeedWriteDenial("Memory", [...writeTargetIds(this, content), content?.supersedes])');
  expect(feedCheck).toBeGreaterThan(-1);
  expect(feed.indexOf(".flair.Memory.put(")).toBeGreaterThan(feedCheck);

  const federation = readFileSync("resources/Federation.ts", "utf8");
  const skip = federation.indexOf('recordSkip("seed_id_not_federated")');
  expect(skip).toBeGreaterThan(-1);
  expect(federation.indexOf("await table.put(", skip)).toBeGreaterThan(skip);
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
