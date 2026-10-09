import { expect, test } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { rawTableWriteSites } from "../helpers/raw-table-writers";

/**
 * memory-embedding-writer-coverage.test.ts — the coverage gate for the
 * vector-space guard's write-maintained latch (embedding-space-guard slice 1).
 *
 * THE LATCH (resources/embedding-space-guard.ts) stays cheap by trusting that
 * every write which can land a FOREIGN-space embeddingModel calls
 * noteWriteStamp() so the O(1) "uniform" recall/dedup consult trips instead of
 * cosining a foreign vector. The guarded write path (Memory.post()/put()) does
 * this. The risk this test closes — and the exact hole K&S found in review #1554,
 * same class as flair#1537/#1543 — is a RAW Memory write site OUTSIDE that path
 * that persists an externally-sourced embeddingModel WITHOUT tripping the latch
 * (the federation sync-in LWW merge did precisely this).
 *
 * Same discipline as memory-skill-writer-coverage.test.ts: enumerate EVERY raw
 * Memory write site via rawTableWriteSites and require an explicit policy for
 * each. A NEW unclassified writer fails the build ("unscanned embedding-writer").
 *
 * Policies:
 *   LATCH        — a raw put of a full Memory record that can carry an
 *                  EXTERNALLY-sourced embeddingModel (federation sync-in). The
 *                  owning file MUST call noteWriteStamp (asserted below). This is
 *                  the fails-on-unfixed anchor: drop the trip and this reds.
 *   GATED        — Memory.ts's own post()/put() write path, which already calls
 *                  noteWriteStamp (slice 1). The owning file MUST call it too.
 *   LOCAL        — replaces an existing row's stamp with the current local
 *                  model ID and a locally computed vector.
 *   DELEGATED    — embedding handling belongs to Memory.post()/put().
 *   ECHO         — preserves an EXISTING row's embeddingModel.
 *   UNLATCHED    — a write that can carry a caller-supplied stamp without
 *                  noteWriteStamp.
 *   NON_EMBED    — writes no embeddingModel (starter and feed rows), or a partial
 *                  update/patch/delete that never touches the stamp.
 *   OTHER_TABLE  — writes on other tables or in-memory maps, included by
 *                  rawTableWriteSites's conservative sink enumeration.
 *
 * Out-of-band writes that bypass ALL resource writers (a direct ops-API insert)
 * are outside this test's reach; the boot scan (on restart) and a change-feed
 * backstop (tracked follow-up) cover those.
 */

type Policy = "LATCH" | "GATED" | "LOCAL" | "DELEGATED" | "ECHO" | "UNLATCHED" | "NON_EMBED" | "OTHER_TABLE";
const classified = new Map<string, { policy: Policy; reason: string }>();
const add = (file: string, sites: string[], policy: Policy, reason: string) => {
  for (const site of sites) classified.set(`resources/${file}.ts:${site}`, { policy, reason });
};

// ── LATCH: raw put that can land an externally-sourced foreign stamp ──
add("Federation", ["writer:table.put#1"], "LATCH",
  "Federation sync-in LWW merge (applyMergedRecordToTable) — a remote-win copies the REMOTE embeddingModel; must trip the latch via noteWriteStamp.");

// ── GATED: Memory.ts's own post()/put() write path (calls noteWriteStamp) ──
// The writes go through the base TABLE (`databases.flair.Memory`) with the
// shared request context so a direct/internal caller is atomic (A1'' 0a).
add("Memory", ["writer:cls.create#1", "writer:(databases as any).flair.Memory.post#1"], "GATED", "Memory.post() write — stamps + noteWriteStamp (slice 1).");
add("Memory", ["writer:(databases as any).flair.Memory.put#3"], "GATED", "Memory.put() main write — stamps + noteWriteStamp (slice 1).");
add("Memory", ["writer:super.put#1"], "GATED", "Memory.put() _reindex re-PUT — writes supplied embedding fields without regenerating; calls noteWriteStamp on the submitted model.");
// ── LOCAL: replaces a stored stamp with the current local model ID ──
add("Memory", ["writer:(databases as any).flair.Memory.put#2"], "LOCAL",
  "Memory.patch() re-embed: puts the re-read row with a locally computed vector, getModelId() and updatedAt; noteWriteStamp.");
add("migrations/embedding-stamp", ["writer:table.put#1"], "LOCAL",
  "Content-suffix fallback: replaces the stored embedding and stamp with a locally computed vector and current model ID.");

// ── DELEGATED: embedding handling occurs in the resource write path ──
add("MemoryArchive", ["writer:Memory.put#1"], "DELEGATED", "Existing row through Memory.put().");

// ── ECHO: preserves an EXISTING row's stamp ──
add("Memory", ["writer:(databases as any).flair.Memory.put#1"], "ECHO",
  "closeSupersededRecord: read-modify-write validTo close, re-writes the existing stamp.");
add("usage-recording", ["writer:(databases as any).flair.Memory.put#1"], "ECHO",
  "usageCount bump: get-then-put re-writes the existing row's own stamp.");
add("MemoryReindex", ["writer:writeBackCommittedRow#1"], "ECHO",
  "Admin reindex re-PUT of an existing local row through the shared write-back helper (flair#2354): echoes the stored embedding and embeddingModel; no re-embed.");
add("promotion-stamp", ["writer:writeBackCommittedRow#1"], "ECHO",
  "Promotion status stamp: re-writes the existing local row through the shared write-back helper (flair#2354).");
add("promotion-stamp", ["writer:table.put#1"], "ECHO",
  "Promotion status stamp in the manual promotion's own write transaction: get-then-put re-writes the row it staged.");
add("migrations/visibility-backfill", ["writer:writeBackCommittedRow#1"], "ECHO",
  "Boot migration re-PUT of existing rows through the shared write-back helper (flair#2354); the boot scan also runs.");
add("migrations/synthetic-test-migration", ["writer:writeBackCommittedRow#1"], "ECHO",
  "Test-only migration backfill of existing rows through the shared write-back helper (flair#2354).");
add("skill-version-write", ["writer:(databases as any).flair.Memory.put#1"], "ECHO",
  "Memory's skill caller computes or retains the stamp and calls noteWriteStamp; FeedMemories refuses a body embedding or embeddingModel (flair#2354), so its skill successor carries the stored row's stamp or none.");
add("skill-version-write", ["writer:(databases as any).flair.Memory.put#2"], "ECHO",
  "flair#2139 S2 skill predecessor close: read-modify-write re-writes the existing row's own stamp.");

add("MemoryFeed", ["writer:(databases as any).flair.Memory.put#1"], "ECHO",
  "Dedup repair (flair#2358): read-modify-write re-writes the stored row's own stamp — only its expiresAt changes.");

// ── UNLATCHED: writes a stamp without tripping the latch ──
// The feed refuses a body embedding or embeddingModel (flair#2354), so its
// ingest is NON_EMBED and its skill successor ECHO.
add("Memory", ["writer:super.patch#1"], "UNLATCHED",
  "Memory.patch(): an ordinary PATCH stores a body's embedding and embeddingModel without noteWriteStamp; when redaction (flair#2407) discards them, it stores a locally computed vector and getModelId(), or null for both when the engine returns no vector.");

// ── NON_EMBED: writes no stamp, or a partial update/patch/delete ──
add("AgentSeed", ["writer:(databases as any).flair.Memory.put#1"], "NON_EMBED",
  "Admin-only starter memories — the record carries no embedding/embeddingModel.");
add("MemoryFeed", ["writer:writeBackCommittedRow#1"], "NON_EMBED",
  "Feed rows through the shared write-back helper (flair#2354): POST /FeedMemories refuses a body embedding or embeddingModel (400 feed_embedding_not_writable), so the record carries neither.");
add("MemoryMaintenance", ["writer:(databases as any).flair.Memory.update#1", "writer:(databases as any).flair.Memory.delete#1"], "NON_EMBED",
  "Archive/expiry maintenance — partial update (archive fields) / delete; never touches the stamp.");
// flair#1940 A1-iv item 6: Memory.ts no longer touches the MemoryHostSource
// table directly — pointer writes/deletes go through the host-pointer ADAPTER
// (resources/host-pointer-adapter.ts -> resources/host-pointer/registry.ts),
// which the conservative sink enumeration does not match. No Memory.ts table
// write site remains.
add("MemoryMaintenance", ["writer:table.delete#1"], "OTHER_TABLE",
  "MemoryHostSource pointer cascade (A1') — not the Memory table, never an embeddingModel.");
add("MemoryPurge", ["writer:memory.delete#1"], "NON_EMBED",
  "Physical removal — a delete; never writes embeddingModel.");
add("Memory", ["writer:patchRecord#1", "writer:(databases as any).flair.Memory.delete#1"], "NON_EMBED",
  "derivedFrom/lastReflected patch and delete() — never write embeddingModel.");
add("MemoryReflect", ["writer:patchRecordSilent#1"], "NON_EMBED", "lastReflected stamp — partial, non-embedding.");
add("hit-tracking", [
  "writer:this.pending.delete#1",
  "writer:this.cache.delete#1",
  "writer:this.tails.delete#1",
  "writer:this.pending.delete#2",
  "writer:this.tables.stats.put#1",
  "writer:table.put#1",
  "writer:table.delete#1",
], "OTHER_TABLE", "MemoryHitStat ledger and in-memory maps — not a Memory writer.");
add("auth-middleware", ["writer:writeBackCommittedRow#1"], "ECHO",
  "Embedding backfill through the shared write-back helper (flair#2354): writes a locally computed embedding vector and echoes the row's stored embeddingModel.");

// ── OTHER_TABLE: conservative sink-enumeration false-positives ──
add("migrations/graph-heal", ["writer:table.put#1"], "OTHER_TABLE", "Graph-heal OrgEvent ledger.");
add("AgentSeed", ["writer:(databases as any).flair.Agent.put#1", "writer:(databases as any).flair.Soul.put#1"], "OTHER_TABLE", "Agent/Soul tables.");
add("Federation", [
  "writer:(databases as any).flair.Instance.put#1",
  "writer:(databases as any).flair.Peer.put#1",
  "writer:(databases as any).flair.Peer.put#2",
  "writer:(databases as any).flair.Peer.put#3",
  "writer:(databases as any).flair.PairingToken.put#1",
  "writer:(databases as any).flair.SyncLog.put#1",
], "OTHER_TABLE", "Federation control tables.");
add("MemoryReflect", ["writer:(databases as any).flair.MemoryCandidate.put#1"], "OTHER_TABLE", "MemoryCandidate table.");
add("usage-recording", ["writer:(databases as any).flair.MemoryUsage.put#1"], "OTHER_TABLE", "MemoryUsage table.");

function enumerateWriterSites() {
  return [...new Glob("resources/**/*.ts").scanSync(".")]
    .flatMap(file => rawTableWriteSites(file, readFileSync(file, "utf8"), "Memory"))
    .filter(site => site.kind === "writer");
}

test("every raw Memory write site has an explicit latch policy (no unscanned embedding-writer)", () => {
  const sites = enumerateWriterSites();
  const unclassified = sites.filter(site => !classified.has(site.key)).map(s => s.key);
  expect(unclassified,
    `Unclassified raw Memory writer(s): ${JSON.stringify(unclassified)}. A new raw Memory writer must be ` +
    `classified in this test. If it can persist an externally-sourced embeddingModel, wire noteWriteStamp() ` +
    `(policy LATCH); otherwise classify it GATED / LOCAL / DELEGATED / ECHO / UNLATCHED / NON_EMBED / OTHER_TABLE with a reason (embedding-space-guard slice 1).`,
  ).toEqual([]);
  const stale = [...classified.keys()].filter(key => !sites.some(site => site.key === key));
  expect(stale, `Stale classification(s) with no matching site: ${JSON.stringify(stale)}`).toEqual([]);
});

test("every LATCH/GATED writer's file trips the latch (calls noteWriteStamp) — fails-on-unfixed", () => {
  const mustTrip = new Set<string>();
  for (const [key, { policy }] of classified) {
    if (policy === "LATCH" || policy === "GATED") mustTrip.add(key.split(":")[0]); // the file path
  }
  const missing = [...mustTrip].filter(file => !readFileSync(file, "utf8").includes("noteWriteStamp("));
  expect(missing,
    `These files own a LATCH/GATED Memory writer but never call noteWriteStamp(): ${JSON.stringify(missing)}. ` +
    `A raw write that can land a foreign embeddingModel must trip the vector-space guard's latch, or the next ` +
    `recall cosines a foreign vector = mixed-space garbage (embedding-space-guard slice 1).`,
  ).toEqual([]);
  expect(mustTrip.has("resources/Federation.ts")).toBe(true); // the hole this test exists to keep closed
});

test("an aliased write-back call is an enumerated writer, and an unfollowable helper reference fails (flair#2354)", () => {
  const file = "resources/zz-fixture-aliased-write-back.ts";
  const head = ['import { databases } from "harper";'];
  const call = 'await wb((databases as any).flair.Memory, id, (row: any) => ({ write: { ...row } }), { label: "fixture-aliased" });';
  for (const binding of ['import { writeBackCommittedRow as wb } from "./write-back.js";',
    'import { writeBackCommittedRow } from "./write-back.js";\nconst wb = writeBackCommittedRow;']) {
    const source = [...head, binding, "export async function fixture(id: string) {", `  ${call}`, "}"].join("\n");
    const writers = rawTableWriteSites(file, source, "Memory").filter((site) => site.kind === "writer").map((site) => site.key);
    expect(writers).toContain(`${file}:writer:wb#1`);
    expect(classified.has(`${file}:writer:wb#1`)).toBe(false);
  }
  const escaping = [...head, 'import { writeBackCommittedRow } from "./write-back.js";',
    "export const helpers = { run: writeBackCommittedRow, table: (databases as any).flair.Memory };"].join("\n");
  expect(() => rawTableWriteSites(file, escaping, "Memory")).toThrow("unresolved writer-helper reference");
});
