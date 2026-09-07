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
add("Memory", ["writer:super.post#1", "writer:super.put#2"],
  "Skill-writer: routes through the SkillScan gate + forced durability in Memory.post()/put() (flair#1542).");
add("MemoryFeed", ["writer:(databases as any).flair.Memory.put#1"],
  "Skill-writer: runs the SkillScan gate + forced durability in FeedMemories.post() before the raw put (flair#1542).");

// ── REJECTING skill-writer sinks (400 skill_write_path) ──
add("Memory", ["writer:super.patch#1"],
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
add("Memory", ["writer:super.delete#1"],
  "Memory.delete(): removal, not a write.");
add("Memory", ["alias-source:(databases as any).flair.Memory#1", "alias-source:(databases as any).flair.Memory#2"],
  "Read-only table alias (get/search) — no write through this handle.");

// ── Non-skill writers in other modules ──
add("MemoryMaintenance", ["writer:(databases as any).flair.Memory.delete#1", "writer:(databases as any).flair.Memory.update#1"],
  "Maintenance (archive/expiry) — non-skill.");
add("MemoryReflect", ["writer:patchRecordSilent#1"],
  "lastReflected stamp — non-skill.");
add("MemoryReindex", ["writer:Memory.put#1"],
  "Admin-only re-embed re-PUT (reindex_admin_only gate) — preserves existing content, not a new skill write.");
add("SemanticSearch", ["writer:patchRecord#1"],
  "retrievalCount bump — non-skill.");
add("auth-middleware", ["writer:patchRecord#1"],
  "Auth bookkeeping — non-skill.");
add("usage-recording", ["writer:(databases as any).flair.Memory.put#1"],
  "usageCount increment (targeted get-then-put) — non-skill.");
add("promotion-stamp", ["writer:table.put#1"],
  "Promotion status stamp — non-skill.");
add("migrations/graph-heal", ["writer:table.put#1"],
  "Migration backfill — non-skill.");
add("migrations/synthetic-test-migration", ["writer:table.put#1"],
  "Migration backfill — non-skill.");
add("migrations/visibility-backfill", ["writer:table.put#1"],
  "Migration backfill — non-skill.");

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
add("SemanticSearch", ["alias-source:(databases as any).flair.Memory#1"],
  "Read-only alias (search reads rows).");
add("auth-middleware", ["alias-source:(databases as any).flair.Memory#1"],
  "Read-only alias (auth reads rows).");
add("promotion-stamp", ["alias-source:(databases as any).flair.Memory#1"],
  "Read-only alias (promotion reads the row to stamp).");
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
