/**
 * hnsw-graph-heal-e2e.test.ts — proves the recall graph-heal (the schema-driven
 * HNSW rebuild) end-to-end against REAL Harper, and FAILS if the `M: 16`
 * trigger is reverted.
 *
 * BACKGROUND — the bug and the fix:
 *   Prod recall collapsed because a bulk in-place re-embed (every Memory row
 *   rewritten via `PUT /Memory`) left the HNSW graph stale: an *older* Harper's
 *   incremental HNSW update dropped/asymmetrized reverse edges, so a fresh
 *   index of the exact same vectors found the true neighbors while the live
 *   graph did not. The fix is entirely flair-side: `schemas/memory.graphql`
 *   declares the embedding index's `M` explicitly (`@indexed(type: "HNSW",
 *   M: 16)` — 16 is Harper's own default, a ZERO behavior change). Every
 *   pre-fix install persisted the HNSW descriptor with NO options, so on the
 *   first boot after upgrade Harper structurally diffs the descriptor against
 *   the schema (`canonicalizeIndexOptions` does NOT inject defaults —
 *   `{type:"HNSW"}` and `{type:"HNSW",M:16}` are different canonical keys) and
 *   CLEARS + REBUILDS the graph cleanly from the already-correct stored
 *   vectors. No re-embed.
 *
 * WHY THIS TEST ASSERTS THE REBUILD DIRECTLY (not a recall crater→recover):
 *   The installed Harper (5.1.22) already fixes the incremental-update bug in
 *   its HNSW `index()` path (it reconstructs `existingVector` from the stored
 *   node and does the reverse-edge cleanup the old build skipped —
 *   node_modules/@harperfast/harper/.../HierarchicalNavigableSmallWorld.js).
 *   Empirically confirmed here: NO in-Harper write path (REST `PUT`, ops-API
 *   `insert`/`update`) leaves a stale graph against this version — recall is
 *   always correct, so a "stale graph" can't be synthesized to heal. The
 *   corruption this fix heals was produced by an EARLIER Harper and lives on
 *   disk in existing prod stores. So the faithful, deterministic thing to
 *   prove against the shipping Harper is the FIX'S MECHANISM: that the `M: 16`
 *   descriptor diff makes Harper actually CLEAR + REBUILD the embedding index
 *   on the upgrade boot, and that the rebuild preserves the data (recall stays
 *   correct — the clean rebuild-from-stored-vectors that heals a corrupted
 *   store).
 *
 * PROOF (ONE shared data dir):
 *   Boot 1 — BARE `@indexed(type: "HNSW")` (a temp overlay of the worktree
 *     with only memory.graphql patched): seed rows, confirm recall works,
 *     confirm the persisted descriptor is bare (no `M`). Record the boot log
 *     length so boot 2's log can be read from that offset.
 *   Boot 2 — the WORKTREE component (shipping `M: 16` schema), SAME data dir:
 *     Harper emits `reindex flair.Memory.embedding: reason=structural-options-
 *     changed` (its own explainability log for a structural-diff rebuild —
 *     databases.js) and rebuilds the graph. Assert that log line appears, the
 *     descriptor is now `M: 16`, and recall is still correct after the rebuild.
 *
 * MUST FAIL IF THE M:16 TRIGGER IS REVERTED: the overlay ALWAYS strips M:16 to
 * bare; boot 2 uses the worktree schema as-is. If the worktree is reverted to
 * bare, both boots present an identical descriptor → NO structural diff → the
 * `structural-options-changed` reindex is NEVER logged and the descriptor
 * never gains `M` → both boot-2 assertions fail.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, rm, readdir, readFile, writeFile, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { getModelId } from "../../resources/embeddings-provider.ts";

// ── Tunables ────────────────────────────────────────────────────────────────
const N_ROWS = 200;
const DIM = 48;
const N_PROBES = 20;
const AGENT_ID = "__flair_graph_heal_e2e_agent__";
const CURRENT_MODEL_ID = getModelId(); // real id → the always-on embedding-stamp migration leaves these rows alone
const SEARCH_LIMIT = 10;

// The exact Harper explainability log for a structural-diff rebuild of the
// embedding HNSW index (node_modules/@harperfast/harper/.../databases.js:
// `reindex ${db}.${table}.${attr}: reason=structural-options-changed`). Matched
// without the DB-name prefix to stay robust.
const REBUILD_LOG_MARK = "Memory.embedding: reason=structural-options-changed";

// ── Deterministic vectors (no embedding model needed) ─────────────────────────
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randUnit(seed: number): number[] {
  const rng = mulberry32(seed);
  const v = Array.from({ length: DIM }, () => rng() * 2 - 1);
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}
const rowId = (i: number) => `gh-row-${i}`;
const VEC = Array.from({ length: N_ROWS }, (_, i) => randUnit(0x9e37 ^ i));
// Each probe is a row's own vector → that row is its unique nearest (cosine 1).
const PROBE_ROWS = Array.from({ length: N_PROBES }, (_, j) => Math.floor((j * N_ROWS) / N_PROBES));

let harper: HarperInstance;
let installDir: string;
let overlayDir: string;
let authHeader: string;

let recallBareBuild = -1;
let recallAfterHeal = -1;
let bareDescriptor: any = null;
let healedDescriptor: any = null;
let rebuildLogged = false;

const httpBase = () => harper.httpURL;

async function opsCall(body: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ops call failed: HTTP ${res.status} — ${await res.text()}`);
  return res.json();
}

async function embeddingDescriptor(): Promise<any> {
  const d = await opsCall({ operation: "describe_table", database: "flair", table: "Memory" });
  return (d.attributes || []).find((a: any) => a.attribute === "embedding" || a.name === "embedding")?.indexed ?? null;
}

async function semanticRank1(q: number[]): Promise<string | null> {
  const res = await fetch(`${httpBase()}/SemanticSearch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: JSON.stringify({ agentId: AGENT_ID, queryEmbedding: q, limit: SEARCH_LIMIT }),
  });
  if (!res.ok) throw new Error(`SemanticSearch HTTP ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { results?: Array<{ id: string }> };
  return body.results && body.results.length > 0 ? body.results[0].id : null;
}

/** recall@1 over the probes: each probe is a row's own vector, so its true nearest is that row. Errors → miss. */
async function measureRecall(): Promise<number> {
  let hits = 0;
  for (const r of PROBE_ROWS) {
    let got: string | null = null;
    try {
      got = await semanticRank1(VEC[r]);
    } catch {
      got = null;
    }
    if (got === rowId(r)) hits++;
  }
  return hits / PROBE_ROWS.length;
}

async function pollRecall(target: number, deadlineMs: number): Promise<number> {
  const deadline = Date.now() + deadlineMs;
  let last = 0;
  while (Date.now() < deadline) {
    last = await measureRecall();
    if (last >= target) return last;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return last;
}

const hdbLogPath = () => join(installDir, "log", "hdb.log");

async function readLogFrom(offset: number): Promise<string> {
  try {
    const full = await readFile(hdbLogPath(), "utf-8");
    return full.slice(offset);
  } catch {
    return "";
  }
}
async function logLength(): Promise<number> {
  try {
    return (await stat(hdbLogPath())).size;
  } catch {
    return 0;
  }
}

/** Poll boot-2's log (from `sinceOffset`) until the structural-rebuild line appears, or the deadline passes. */
async function pollRebuildLog(sinceOffset: number, deadlineMs: number): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if ((await readLogFrom(sinceOffset)).includes(REBUILD_LOG_MARK)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return (await readLogFrom(sinceOffset)).includes(REBUILD_LOG_MARK);
}

async function buildBareSchemaOverlay(worktreeRoot: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "flair-graph-heal-overlay-"));
  for (const entry of ["config.yaml", "dist", "node_modules", "package.json"]) {
    await symlink(join(worktreeRoot, entry), join(dir, entry));
  }
  await mkdir(join(dir, "schemas"));
  const schemaFiles = await readdir(join(worktreeRoot, "schemas"));
  for (const f of schemaFiles) {
    if (f === "memory.graphql") {
      const src = await readFile(join(worktreeRoot, "schemas", f), "utf-8");
      const bare = src.replace('@indexed(type: "HNSW", M: 16)', '@indexed(type: "HNSW")');
      if (bare === src) throw new Error("overlay: expected to strip `M: 16` from memory.graphql but found none");
      await writeFile(join(dir, "schemas", f), bare);
    } else {
      await symlink(join(worktreeRoot, "schemas", f), join(dir, "schemas", f));
    }
  }
  return dir;
}

describe("recall HNSW graph-heal — schema-driven clean rebuild (real Harper)", () => {
  beforeAll(async () => {
    const worktreeRoot = process.cwd();
    installDir = await mkdtemp(join(tmpdir(), "flair-graph-heal-data-"));
    overlayDir = await buildBareSchemaOverlay(worktreeRoot);

    // ── Boot 1: BARE `@indexed(type: "HNSW")` schema ────────────────────────
    harper = await startHarper({ cwd: overlayDir, harperBinDir: worktreeRoot, installDir });
    authHeader = "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64");

    const now = new Date().toISOString();
    const records = Array.from({ length: N_ROWS }, (_, i) => ({
      id: rowId(i),
      agentId: AGENT_ID,
      content: `graph-heal-e2e row ${i}`,
      embedding: VEC[i],
      embeddingModel: CURRENT_MODEL_ID, // real id → embedding-stamp never re-embeds these
      createdAt: now,
    }));
    for (let i = 0; i < records.length; i += 100) {
      await opsCall({ operation: "insert", database: "flair", table: "Memory", records: records.slice(i, i + 100) });
    }

    recallBareBuild = await pollRecall(0.9, 60_000);
    bareDescriptor = await embeddingDescriptor();
    const boot1LogEnd = await logLength();

    await stopHarper(harper, { keepInstallDir: true });

    // ── Boot 2: WORKTREE component (shipping `M: 16` schema), SAME data dir ──
    // The bare→M:16 descriptor diff makes Harper clear + rebuild the embedding
    // index; it logs `...Memory.embedding: reason=structural-options-changed`.
    harper = await startHarper({ cwd: worktreeRoot, installDir });
    rebuildLogged = await pollRebuildLog(boot1LogEnd, 60_000);
    recallAfterHeal = await pollRecall(0.9, 120_000);
    healedDescriptor = await embeddingDescriptor();
  }, 420_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper, { keepInstallDir: true }).catch(() => {});
    await rm(installDir, { recursive: true, force: true, maxRetries: 4 }).catch(() => {});
    await rm(overlayDir, { recursive: true, force: true, maxRetries: 4 }).catch(() => {});
  });

  test("the bare-schema build serves recall correctly and persists a bare HNSW descriptor (no explicit M)", () => {
    console.log(
      `[graph-heal-e2e] recallBareBuild=${recallBareBuild.toFixed(2)} recallAfterHeal=${recallAfterHeal.toFixed(2)} ` +
        `rebuildLogged=${rebuildLogged} bareDescriptor=${JSON.stringify(bareDescriptor)} healedDescriptor=${JSON.stringify(healedDescriptor)}`,
    );
    expect(recallBareBuild).toBeGreaterThanOrEqual(0.9);
    expect(bareDescriptor).toEqual({ type: "HNSW" }); // no `M` — the pre-fix on-disk shape every upgrade heals from
  });

  test("the M:16 schema descriptor diff makes Harper CLEAR + REBUILD the embedding graph on the upgrade boot (fails if reverted)", () => {
    // Harper's own explainability log proves a structural-diff rebuild RAN —
    // reason `structural-options-changed`, i.e. the bare→M:16 diff, not
    // crash-recovery or a fresh new-index. Reverting M:16 removes the diff, so
    // this line is never emitted.
    expect(rebuildLogged).toBe(true);
    // And the persisted descriptor now carries the explicit M (string form is
    // how Harper stores the GraphQL int arg — describe_table returns M:"16").
    expect(healedDescriptor?.type).toBe("HNSW");
    expect(String(healedDescriptor?.M)).toBe("16");
    // The change is real: the descriptor differs from the bare pre-fix shape.
    expect(JSON.stringify(healedDescriptor)).not.toEqual(JSON.stringify(bareDescriptor));
  });

  test("the clean rebuild preserves the data — recall stays correct after the heal (rebuilt from the stored vectors, no loss)", () => {
    expect(recallAfterHeal).toBeGreaterThanOrEqual(0.9);
  });
});
