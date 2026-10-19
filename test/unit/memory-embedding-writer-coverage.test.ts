import { expect, test } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import ts from "typescript";
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
add("write-journal", ["writer:this.transactions.delete#1", "writer:this.staged.delete#1"], "OTHER_TABLE", "In-memory journal bookkeeping.");

add("Federation", ["writer:writeBackCommittedRow#1"], "OTHER_TABLE",
  "The Presence receipt branch (flair#2578 slice 1): its table is always Presence; it writes no Memory row.");
add("Federation", ["writer:writeBackCommittedRow#2"], "LATCH",
  "Federation sync-in calls noteFederationMergedMemory on the selected row; it checks the Memory embeddingModel via noteWriteStamp and ignores other tables.");

// ── GATED: Memory.ts's own post()/put()/patch() write path (calls noteWriteStamp) ──
// The writes go through the base TABLE (`databases.flair.Memory`) with the
// shared request context so a direct/internal caller is atomic (A1'' 0a).
add("Memory", ["writer:cls.create#1", "writer:(databases as any).flair.Memory.post#1"], "GATED", "Memory.post() write — stamps + noteWriteStamp (slice 1).");
add("Memory", ["writer:(databases as any).flair.Memory.put#4"], "GATED", "Memory.put() main write — stamps + noteWriteStamp (slice 1).");
add("Memory", ["writer:(databases as any).flair.Memory.put#3"], "GATED", "Memory.put() _reindex re-PUT (flair#2450: through the table, inside the shared write transaction, after the committed-row confirm) — writes supplied embedding fields without regenerating; calls noteWriteStamp on the submitted model.");
// flair#2425 — an ordinary PATCH merges the body (including a caller-supplied
// embedding/embeddingModel) into the row; it now calls noteWriteStamp too.
add("Memory", ["writer:super.patch#1"], "GATED",
  "Memory.patch() ordinary write — a partial merge that can store a caller-supplied embedding stamp; calls noteWriteStamp (flair#2425).");
// ── LOCAL: replaces a stored stamp with the current local model ID ──
add("Memory", ["writer:(databases as any).flair.Memory.update#1"], "LOCAL",
  "Memory.patch() re-embed (flair#2465): an incremental update of only embedding/embeddingModel/updatedAt for a locally computed vector and getModelId(); noteWriteStamp.");
add("migrations/embedding-stamp", ["writer:table.update#1"], "LOCAL",
  "Content-suffix fallback (flair#2465): an incremental update of only embedding/embeddingModel/updatedAt for a locally computed vector and current model ID — never a full-row put. Written under the id's per-id Memory write lock, taken once after the vector is computed (flair#2478).");

// ── DELEGATED: embedding handling occurs in the resource write path ──
add("MemoryArchive", ["writer:Memory.put#1"], "DELEGATED", "Existing row through Memory.put().");
add("AutoPromoteCandidates", ["writer:MemoryCls.put#1"], "DELEGATED", "The promoted row is written through Memory.put() (static Cls.put routes through its override).");
add("AutoPromoteCandidates", ["writer:(databases as any).flair.MemoryCandidate.put#1", "writer:(databases as any).flair.MemoryCandidate.put#2"], "OTHER_TABLE", "MemoryCandidate writes (the recorded promoted-row identity and the status update) — not a Memory row.");

// ── ECHO: preserves an EXISTING row's stamp ──
add("Memory", ["writer:table.put#1"], "ECHO",
  "Skill DELETE retry preserves the stored embeddingModel and any nonempty vector; it computes no embedding.");
add("Memory", ["writer:(databases as any).flair.Memory.put#1"], "ECHO",
  "closeSupersededRecord: read-modify-write validTo close, re-writes the existing stamp.");
add("Memory", ["writer:(databases as any).flair.Memory.put#2"], "ECHO",
  "stageGrantedClose: read-modify-write validTo close staged in the successor's transaction, re-writes the existing stamp.");
add("MemoryReindex", ["writer:writeBackCommittedRow#1"], "ECHO",
  "Admin reindex re-PUT of an existing local row through the shared write-back helper (flair#2354): echoes the stored embedding and embeddingModel; no re-embed.");
add("promotion-stamp", ["writer:writeBackCommittedRow#1"], "ECHO",
  "Promotion status stamp: re-writes the existing local row through the shared write-back helper (flair#2354).");
add("promotion-stamp", ["writer:table.update#1"], "ECHO",
  "Promotion status stamp in the manual promotion's own write transaction: an incremental update of only the verdict fields (flair#2478 slice 2).");
add("migrations/visibility-backfill", ["writer:writeBackCommittedRow#1"], "ECHO",
  "Boot migration re-PUT of existing rows through the shared write-back helper (flair#2354); the boot scan also runs.");
add("skill-version-write", ["writer:(databases as any).flair.Memory.put#1"], "ECHO",
  "Memory's skill caller computes or retains the stamp and calls noteWriteStamp; FeedMemories refuses a body embedding or embeddingModel (flair#2354), so its skill successor carries the stored row's stamp or none.");
add("skill-version-write", ["writer:(databases as any).flair.Memory.put#2"], "ECHO",
  "flair#2139 S2 skill predecessor close: read-modify-write re-writes the existing row's own stamp.");
add("skill-version-write", ["writer:table.put#1"], "ECHO",
  "flair#2645 re-apply of a close that did not land: read-modify-write of the committed row's own stamp.");

// ── NON_EMBED: writes no stamp, or a partial update/patch/delete ──
// The feed refuses a body embedding or embeddingModel (flair#2354), so its
// ingest is NON_EMBED and its skill successor ECHO.
add("usage-recording", ["writer:writeBackCommittedRow#1"], "NON_EMBED",
  "Usage-count bump and commit marker (flair#2653).");
add("migrations/synthetic-test-migration", ["writer:writeBackCommittedRow#1"], "NON_EMBED",
  "Test-only migration: writes only source (flair#2470).");
add("MemoryFeed", ["writer:(databases as any).flair.Memory.update#1"], "NON_EMBED",
  "Dedup repair: writes only expiresAt (flair#2358/#2470).");
add("AgentSeed", ["writer:(databases as any).flair.Memory.put#1"], "NON_EMBED",
  "Admin-only starter memories — the record carries no embedding/embeddingModel.");
add("MemoryFeed", ["writer:writeBackCommittedRow#1", "writer:table.put#1"], "NON_EMBED",
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
add("auth-middleware", ["writer:writeBackCommittedRow#1"], "LOCAL",
  "Embedding backfill: an incremental update of embedding, embeddingModel and embeddedContentHash for a locally computed vector and getModelId() (flair#2470, flair#2573); noteWriteStamp after the commit.");

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

/** True when the function-like node named `name` in `source` has a
 *  `noteWriteStamp(...)` call inside its OWN body. Unlike the file-level check
 *  above, a call in another function of the same file does not count. */
function namedBodyTrips(source: string, name: string): boolean {
  const ast = ts.createSourceFile("f.ts", source, ts.ScriptTarget.Latest, true);
  let trips = false;
  const visit = (node: ts.Node): void => {
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name && ts.isIdentifier(node.name) && node.name.text === name) {
      const walk = (n: ts.Node): void => {
        if (ts.isFunctionLike(n) || ts.isClassDeclaration(n) || ts.isClassExpression(n)) return;
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "noteWriteStamp") trips = true;
        if (!trips) ts.forEachChild(n, walk);
      };
      if (node.body) walk(node.body);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return trips;
}

function putBranchTrips(source: string, branch: "reindex" | "ordinary"): boolean {
  const ast = ts.createSourceFile("f.ts", source, ts.ScriptTarget.Latest, true);
  let trips = false;
  const visit = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name) && node.name.text === "putLocked" && node.body) {
      const statements = node.body.statements;
      const index = statements.findIndex(statement => {
        if (!ts.isIfStatement(statement)) return false;
        const condition = statement.expression;
        return ts.isBinaryExpression(condition) && condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
          ts.isPropertyAccessExpression(condition.left) && ts.isIdentifier(condition.left.expression) &&
          condition.left.expression.text === "content" && condition.left.name.text === "_reindex" &&
          condition.right.kind === ts.SyntaxKind.TrueKeyword && ts.isBlock(statement.thenStatement);
      });
      if (index < 0) return;
      const reindex = statements[index] as ts.IfStatement;
      const walk = (n: ts.Node): void => {
        if (ts.isFunctionLike(n) || ts.isClassDeclaration(n) || ts.isClassExpression(n)) return;
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "noteWriteStamp") trips = true;
        if (!trips) ts.forEachChild(n, walk);
      };
      if (branch === "reindex") walk(reindex.thenStatement);
      else for (const statement of statements.slice(index + 1)) walk(statement);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return trips;
}

for (const branch of ["reindex", "ordinary"] as const) {
  test(`Memory.put ${branch} branch calls noteWriteStamp (flair#2488)`, () => {
    expect(putBranchTrips(readFileSync("resources/Memory.ts", "utf8"), branch),
      `resources/Memory.ts#put ${branch} branch has no noteWriteStamp() call`,
    ).toBe(true);
  });
}

test("the embedding backfill notifies the guard from its own body (flair#2573)", () => {
  expect(namedBodyTrips(readFileSync("resources/auth-middleware.ts", "utf8"), "backfillEmbedding"),
    "resources/auth-middleware.ts#backfillEmbedding has no noteWriteStamp() call",
  ).toBe(true);
});

test("a parameter-default call does not trip the named body's latch", () => {
  for (const source of [
    "function patch(model = noteWriteStamp('foreign')) {}",
    "class Memory { patch(model = noteWriteStamp('foreign')) {} }",
  ]) expect(namedBodyTrips(source, "patch")).toBe(false);
});

test("an uncalled nested function does not trip the named body's latch", () => {
  for (const nested of [
    "function unused() { noteWriteStamp('foreign'); }",
    "function patch() { noteWriteStamp('foreign'); }",
    "const unused = () => noteWriteStamp('foreign');",
    "const unused = function () { noteWriteStamp('foreign'); };",
    "const unused = { run() { noteWriteStamp('foreign'); } };",
    "class Unused { stamp = noteWriteStamp('foreign'); }",
  ]) expect(namedBodyTrips(`function patch() { ${nested} }`, "patch")).toBe(false);
});

// flair#2488: the file-level check above passes while ONE writer's own
// `noteWriteStamp` call is removed, as long as any other call in the same file
// remains — its check is file-scoped. Pin the write bodies the GATED/LATCH
// entries actually rely on: Memory.ts's three GATED write methods (post, put,
// patch) and the federation merge helper the Federation LATCH entry trips
// through. Each named body must trip the latch itself.
const TRIPPING_WRITE_BODIES: ReadonlyArray<readonly [file: string, fn: string]> = [
  ["resources/Memory.ts", "post"],
  ["resources/Memory.ts", "putLocked"],
  ["resources/Memory.ts", "patchLocked"],
  ["resources/Federation.ts", "noteFederationMergedMemory"],
];

test("each GATED/LATCH write body trips the latch in its own body — fails-on-unfixed (flair#2488)", () => {
  const missing = TRIPPING_WRITE_BODIES
    .filter(([file, fn]) => !namedBodyTrips(readFileSync(file, "utf8"), fn))
    .map(([file, fn]) => `${file}#${fn}`);
  expect(missing,
    `These GATED/LATCH write bodies have no noteWriteStamp() call of their own: ${JSON.stringify(missing)}. ` +
    `A raw write that can land a foreign embeddingModel must trip the vector-space guard's latch from its own ` +
    `write body, or the next recall cosines a foreign vector = mixed-space garbage (embedding-space-guard slice 1).`,
  ).toEqual([]);
});
