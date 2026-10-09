import { expect, test } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { rawTableWriteSites } from "../helpers/raw-table-writers";

/**
 * memory-skill-writer-coverage.test.ts — the coverage gate for flair#1542's
 * SkillScan-on-every-skill-write rule.
 *
 * A skill is a Memory tagged "skill". The SkillScan gate (resources/skill-write.ts's
 * skillScanGate) lives INSIDE Memory.post() and Memory.put() — the two central
 * write paths — so any write that flows through them is gated automatically.
 * The risk this test closes is a NEW raw Memory write site that persists a
 * skill-tagged row WITHOUT routing through post()/put() (e.g. a future
 * `databases.flair.Memory.put(...)` in some new module): that site would write
 * a skill with NO SkillScan gate and NO forced durability, silently reopening
 * the exact hole flair#1542 closes.
 *
 * Same discipline as test/unit/soul-writer-coverage.test.ts: enumerate EVERY
 * raw Memory write site (put/update/patch/patchRecord/patchRecordSilent, plus
 * every table alias) via rawTableWriteSites, and require an explicit
 * classification for each. The classification is the policy — every sink that
 * can carry a skill-tagged row is declared GATED (SkillScan + forced
 * durability), REJECTING (400 skill_write_path), or SKIPPING
 * (skill_not_federated); every other sink is declared non-skill (writes
 * non-skill rows, a different table, or is a read-only alias). A new
 * unclassified writer fails the build — the "unscanned skill-writer" tripwire.
 */

const classified = new Map<string, string>();
const add = (file: string, sites: string[], reason: string) => {
  for (const site of sites) classified.set(`resources/${file}.ts:${site}`, reason);
};

// ── GATED skill-writer sinks (run SkillScan + forced durability) ──
add("MemoryArchive", ["writer:Memory.put#1"], "Guarded by Memory.put().");
add("Memory", ["writer:cls.create#1", "writer:(databases as any).flair.Memory.post#1", "writer:(databases as any).flair.Memory.put#2"],
  "Skill-writer: routes through the SkillScan gate + forced durability in Memory.post()/put() (flair#1542).");
add("MemoryFeed", ["writer:(databases as any).flair.Memory.put#1"],
  "Dedup expiry repair (flair#2358): re-writes the row read in its transaction with expiresAt set; content and tags stay as stored.");
add("skill-version-write", ["writer:(databases as any).flair.Memory.put#1", "writer:(databases as any).flair.Memory.put#2"],
  "Memory post/put and FeedMemories scan the merged successor body before calling this writer; delete only closes the stored head.");
add("skill-version-write", ["alias-source:(databases as any).flair?.Memory#1"],
  "Read-only alias (resolveSkillHead searches the live skill head).");
add("Memory", ["writer:super.patch#1"],
  "Re-embed request (flair#2296): writes embedding, embeddingModel and updatedAt only, no skill content.");

// ── REJECTING skill-writer sinks (400 skill_write_path) ──
add("Memory", ["writer:super.patch#2"],
  "Skill-writer: REJECTS skill-tagged patches (400 skill_write_path) — patch() routes past put()'s gate (flair#1542).");
add("AgentSeed", ["writer:(databases as any).flair.Memory.put#1"],
  "Skill-writer: REJECTS skill-tagged starter memories (400 skill_write_path) — admin-only seed bypasses the gate (flair#1542).");

// ── SKIPPING skill-writer sinks (skill_not_federated) ──
add("Federation", ["writer:table.put#1"],
  "Skill-writer: SKIPS skill-tagged rows (skill_not_federated) — skills are local, never synced (flair#1542).");

// ── Non-skill writers inside Memory.ts ──
add("Memory", ["writer:super.put#1"],
  "Admin-only _reindex re-PUT (reindex_admin_only gate) — re-embeds an existing record byte-for-byte, preserves existing content/tags, not a new skill write.");
add("Memory", ["writer:(databases as any).flair.Memory.put#1"],
  "closeSupersededRecord: read-modify-write close of an existing record (stamps validTo), preserves existing content/tags — not a new skill write.");
add("Memory", ["writer:patchRecord#1"],
  "derivedFrom/lastReflected bookkeeping patch — never writes skill content.");
add("Memory", ["writer:(databases as any).flair.Memory.delete#1"],
  "Memory.delete(): removal, not a write.");
add("Memory", ["alias-source:(databases as any).flair.Memory#1", "alias-source:(databases as any).flair.Memory#2"],
  "Read-only table alias (get/search) — no write through this handle.");

// ── Non-skill writers in other modules ──
add("MemoryFeed", ["alias-source:(databases as any).flair.Memory#1", "writer:writeBackCommittedRow#1"],
  "Non-skill feed write through the shared write-back helper (flair#2354); a skill-tagged feed write returns earlier through the skill version writer (FeedMemories.post's isSkillWrite branch).");
add("MemoryMaintenance", ["writer:(databases as any).flair.Memory.delete#1", "writer:(databases as any).flair.Memory.update#1"],
  "Maintenance (archive/expiry) — non-skill.");
add("MemoryMaintenance", ["writer:table.delete#1"],
  "A1': MemoryHostSource pointer cascade — a different table, never skill content.");

// ── Physical removal (MemoryPurge) ──
add("MemoryPurge", ["writer:memory.delete#1"],
  "Physical-removal path: removes the named rows (and a skill row's lineage) through the raw table handle — a removal, not a skill write, so the post/put SkillScan gate does not apply.");
add("MemoryPurge", ["alias-source:(databases as any).flair?.Memory#1"],
  "Read handle (MemoryPurge reads each row and searches a skill lineage); its delete is the site classified above.");
add("MemoryReflect", ["writer:patchRecordSilent#1"],
  "lastReflected stamp — non-skill.");
add("MemoryReindex", ["writer:writeBackCommittedRow#1"],
  "Admin-only reindex re-PUT through the shared write-back helper (flair#2354): re-writes the row it reads, not a new skill write.");
add("hit-tracking", [
  "writer:this.pending.delete#1",
  "writer:this.cache.delete#1",
  "writer:this.tails.delete#1",
  "writer:this.pending.delete#2",
  "writer:this.tables.stats.put#1",
  "writer:table.put#1",
  "writer:table.delete#1",
], "MemoryHitStat ledger and in-memory maps — not a Memory/skill writer.");
add("auth-middleware", ["writer:writeBackCommittedRow#1"],
  "Auth bookkeeping (embedding backfill) — non-skill, through the shared write-back helper (flair#2354).");
add("usage-recording", ["writer:(databases as any).flair.Memory.put#1"],
  "usageCount increment (targeted get-then-put) — non-skill.");
add("promotion-stamp", ["writer:writeBackCommittedRow#1"],
  "Promotion status stamp — non-skill, through the shared write-back helper (flair#2354).");
add("promotion-stamp", ["writer:table.put#1"],
  "Promotion status stamp in the manual promotion's own write transaction — non-skill.");
add("migrations/graph-heal", ["writer:table.put#1"],
  "Migration backfill — non-skill.");
add("migrations/embedding-stamp", ["writer:table.put#1"],
  "Content-suffix migration embeds skillEmbedText(row), staging embedding/embeddingModel; a change visible at the committed re-read aborts. Later changes follow Harper's timestamp order (PR residual-gap note).");
add("migrations/synthetic-test-migration", ["alias-source:(databases as unknown as { flair: { Memory: MemoryTableLike } }).flair.Memory#1", "writer:writeBackCommittedRow#1"],
  "Migration backfill through the shared write-back helper — non-skill (flair#2354).");
add("migrations/visibility-backfill", ["alias-source:(databases as unknown as { flair: { Memory: MemoryTableLike } }).flair.Memory#1", "writer:writeBackCommittedRow#1"],
  "Migration backfill through the shared write-back helper — non-skill (flair#2354).");

// ── Other tables (conservative sink enumeration false-positives) ──
add("AgentSeed", ["writer:(databases as any).flair.Agent.put#1", "writer:(databases as any).flair.Soul.put#1"],
  "Other tables in the provisioning module, included by conservative sink enumeration.");
add("Federation", ["writer:(databases as any).flair.Instance.put#1", "writer:(databases as any).flair.PairingToken.put#1", "writer:(databases as any).flair.Peer.put#1", "writer:(databases as any).flair.Peer.put#2", "writer:(databases as any).flair.Peer.put#3", "writer:(databases as any).flair.SyncLog.put#1"],
  "Other tables in the federation module, included by conservative sink enumeration.");
add("MemoryReflect", ["writer:(databases as any).flair.MemoryCandidate.put#1"],
  "Other table (MemoryCandidate), included by conservative sink enumeration.");
add("usage-recording", ["writer:(databases as any).flair.MemoryUsage.put#1"],
  "Other table (MemoryUsage), included by conservative sink enumeration.");

// ── Read-only aliases (no write through these handles) ──
add("AdminMemory", ["alias-source:(databases as any).flair.Memory#1"],
  "Read-only admin alias.");
add("Federation", ["alias-source:(databases as any).flair.Memory#1"],
  "Read-only alias (merge reads the source record).");
add("MemoryReflect", ["alias-source:(databases as any).flair.Memory#1"],
  "Read-only alias (reflect reads source memories).");
add("MemoryReindex", ["alias-source:(databases as any).flair.Memory#1"],
  "Read-only alias (reindex reads rows to re-embed).");
add("auth-middleware", ["alias-source:(databases as any).flair.Memory#1"],
  "Read-only alias (auth reads rows).");
add("promotion-stamp", ["alias-source:(databases as any).flair.Memory#1"],
  "Read-only alias (promotion reads the row to stamp).");
add("hit-tracking", ["alias-source:(databases as any).flair?.Memory#1"],
  "Read-only seed of Memory.retrievalCount on first HitStat write.");
add("health", ["alias-source:db.flair?.Memory#1"],
  "Read-only alias (health check).");
add("migration-boot", ["alias-source:flair?.Memory#1"],
  "Read-only alias (migration boot).");
add("migrations/embedding-stamp", ["alias-source:(databases as unknown as { flair: { Memory: MemoryTableLike } }).flair.Memory#1"],
  "Read-only migration adapter alias.");
add("migrations/graph-heal", ["alias-source:(databases as unknown as { flair: { Memory: MemoryTableLike } }).flair.Memory#1"],
  "Read-only migration adapter alias.");
add("migrations/synthetic-test-migration", ["alias-source:(databases as unknown as { flair: { Memory: MemoryTableLike } }).flair.Memory#1"],
  "Read-only migration adapter alias.");
add("migrations/visibility-backfill", ["alias-source:(databases as unknown as { flair: { Memory: MemoryTableLike } }).flair.Memory#1"],
  "Read-only migration adapter alias.");
add("embedding-space-guard", ["alias-source:(databases as unknown as { flair: { Memory: MemoryTableLike } }).flair.Memory#1"],
  "Read-only alias — the vector-space guard scans distinct embeddingModel stamps (search only); no write through this handle.");
add("bm25-index-service", ["alias-source:(databases as any).flair?.Memory#1"],
  "Read-only boot probe — checks Memory.search is a function before the background index build. No write through this handle.");

test("every raw Memory write site has an explicit policy (no unscanned skill-writer)", () => {
  const sites = [...new Glob("resources/**/*.ts").scanSync(".")].flatMap(file => rawTableWriteSites(file, readFileSync(file, "utf8"), "Memory"));
  expect(sites.filter(site => !classified.has(site.key))).toEqual([]);
  expect([...classified.keys()].filter(key => !sites.some(site => site.key === key))).toEqual([]);
});

test("new direct, aliased, computed and helper mutation paths fail classification", () => {
  for (const source of [
    "databases.flair.Memory.put(row)",
    "const memory = databases.flair.Memory; memory.put(row)",
    "patchRecord(databases.flair.Memory, id, data)",
    'const db = databases.flair; db["Memory"].put(row)',
    "const { Memory: memory } = databases.flair; memory.put(id, row)",
    "const tables = { Memory: databases.flair.Memory }; tables[name].put(row)",
  ]) {
    const sites = rawTableWriteSites("resources/NewWriter.ts", source, "Memory");
    expect(sites.some(site => site.kind === "writer" && !classified.has(site.key))).toBe(true);
  }
  expect(rawTableWriteSites("example.ts", '// databases.flair.Memory.put(row)', "Memory")).toEqual([]);
});
