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
 *   ECHO         — a get-then-put / re-PUT that re-writes an EXISTING local row's
 *                  own stamp (usageCount bump, supersede close, promotion stamp,
 *                  admin reindex, boot-migration backfill). No NEW space is
 *                  introduced — the row was already counted at boot or by its
 *                  original (guarded/federation) write.
 *   NON_EMBED    — writes no embeddingModel (starter/feed rows), or a partial
 *                  update/patch/delete that never touches the stamp.
 *   OTHER_TABLE  — a put on a different table, included by rawTableWriteSites's
 *                  conservative sink enumeration.
 *
 * Out-of-band writes that bypass ALL resource writers (a direct ops-API insert)
 * are outside this test's reach; the boot scan (on restart) and a change-feed
 * backstop (tracked follow-up) cover those.
 */

type Policy = "LATCH" | "GATED" | "ECHO" | "NON_EMBED" | "OTHER_TABLE";
const classified = new Map<string, { policy: Policy; reason: string }>();
const add = (file: string, sites: string[], policy: Policy, reason: string) => {
  for (const site of sites) classified.set(`resources/${file}.ts:${site}`, { policy, reason });
};

// ── LATCH: raw put that can land an externally-sourced foreign stamp ──
add("Federation", ["writer:table.put#1"], "LATCH",
  "Federation sync-in LWW merge (applyMergedRecordToTable) — a remote-win copies the REMOTE embeddingModel; must trip the latch via noteWriteStamp.");

// ── GATED: Memory.ts's own post()/put() write path (calls noteWriteStamp) ──
add("Memory", ["writer:super.post#1"], "GATED", "Memory.post() write — stamps + noteWriteStamp (slice 1).");
add("Memory", ["writer:super.put#2"], "GATED", "Memory.put() main write — stamps + noteWriteStamp (slice 1).");
add("Memory", ["writer:super.put#1"], "GATED", "Memory.put() _reindex re-PUT — noteWriteStamp (slice 1); current-space re-embed.");

// ── ECHO: re-writes an EXISTING local row's own stamp (no new space) ──
add("Memory", ["writer:(databases as any).flair.Memory.put#1"], "ECHO",
  "closeSupersededRecord: read-modify-write validTo close, re-writes the existing stamp.");
add("usage-recording", ["writer:(databases as any).flair.Memory.put#1"], "ECHO",
  "usageCount bump: get-then-put re-writes the existing row's own stamp.");
add("MemoryReindex", ["writer:Memory.put#1"], "ECHO",
  "Admin re-embed re-PUT of an existing local row — re-stamps current / preserves, never external.");
add("promotion-stamp", ["writer:table.put#1"], "ECHO",
  "Promotion status stamp: get-then-put re-writes the existing local row.");
add("migrations/graph-heal", ["writer:table.put#1"], "ECHO",
  "Boot migration re-PUT of existing rows (preserves stamp); the boot scan also runs.");
add("migrations/visibility-backfill", ["writer:table.put#1"], "ECHO",
  "Boot migration re-PUT of existing rows (preserves stamp); the boot scan also runs.");
add("migrations/synthetic-test-migration", ["writer:table.put#1"], "ECHO",
  "Test-only migration backfill of existing rows.");

// ── NON_EMBED: writes no stamp, or a partial update/patch/delete ──
add("AgentSeed", ["writer:(databases as any).flair.Memory.put#1"], "NON_EMBED",
  "Admin-only starter memories — the record carries no embedding/embeddingModel.");
add("MemoryFeed", ["writer:(databases as any).flair.Memory.put#1"], "NON_EMBED",
  "Feed rows — the record carries no embedding/embeddingModel.");
add("MemoryMaintenance", ["writer:(databases as any).flair.Memory.update#1", "writer:(databases as any).flair.Memory.delete#1"], "NON_EMBED",
  "Archive/expiry maintenance — partial update (archive fields) / delete; never touches the stamp.");
add("Memory", ["writer:patchRecord#1", "writer:super.patch#1", "writer:super.delete#1"], "NON_EMBED",
  "derivedFrom/lastReflected patch, patch(), delete() — never write embeddingModel.");
add("MemoryReflect", ["writer:patchRecordSilent#1"], "NON_EMBED", "lastReflected stamp — partial, non-embedding.");
add("SemanticSearch", ["writer:patchRecord#1"], "NON_EMBED", "retrievalCount bump — partial, non-embedding.");
add("auth-middleware", ["writer:patchRecord#1"], "NON_EMBED", "Auth bookkeeping patch — non-embedding.");

// ── OTHER_TABLE: conservative sink-enumeration false-positives ──
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
    `(policy LATCH); otherwise classify it ECHO / NON_EMBED / OTHER_TABLE with a reason (embedding-space-guard slice 1).`,
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
