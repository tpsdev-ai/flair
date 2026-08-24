/**
 * bm25-index-scan-order-1357.test.ts — pins the two REAL-HARPER PREMISES that
 * the flair#1357 persistent BM25 index is built on, plus its incremental
 * maintenance end to end.
 *
 * Both premises were established by measurement against a live instance, not
 * from documentation. They live here so that a Harper change breaks a test
 * instead of silently changing recall ranking:
 *
 *  1. CORPUS SCAN ORDER IS A QUERY-PLANNER ARTIFACT, NOT PRIMARY-KEY ORDER.
 *     `buildBM25().rank()` sorts by score with `Array.prototype.sort`, which is
 *     stable, so EQUAL-SCORING documents come back in corpus-iteration order —
 *     making that order part of the ranking contract the index must not change.
 *     MEASURED HERE: under the multi-agent read-scope OR-group
 *     ((agentId == reader) OR (visibility != private)) Harper yields the
 *     READER'S OWN rows first, in primary-key order, and everything else after;
 *     under a tags/subject filter the same store comes back in plain
 *     primary-key order. Two different orders for the same rows, decided by the
 *     plan.
 *
 *     THIS MEASUREMENT IS THE EVIDENCE BEHIND flair#1363. Hybrid recall was
 *     nondeterministic for tied documents — the ranking it produced depended on
 *     which plan Harper picked, which depends on data distribution. Kern's
 *     ruling (2026-08-24): "byte-identical to a nondeterministic source is a
 *     contradiction." Both the legacy scan and the index now break ties on
 *     ascending `id` (resources/bm25.ts and resources/bm25-index.ts), so the
 *     order below no longer reaches ranking at all. Keep this test: it is the
 *     reason the tie-break exists, and it is what would tell us if the premise
 *     ever changed.
 *
 *     This test originally seeded ONE agent, and passed — because with a single
 *     agentId, "grouped by the agentId index" and "ascending primary key" are
 *     the same sequence. The fixture could not express the difference it
 *     existed to detect. It seeds two agents now.
 *
 *  2. `select` PROJECTS TO THE SUBSET OF `select` THE ROW ACTUALLY CARRIES, IN
 *     `select` DECLARATION ORDER. On the indexed path a BM25-only rescue is no
 *     longer read from a corpus scan; it is point-looked-up and projected in
 *     process (resources/semantic-retrieval-core.ts). That projection has to
 *     reproduce Harper's own shape exactly, or a rescued record's response
 *     bytes would differ from a scanned one's.
 *
 * VEHICLE for premise 1: a `SemanticSearch` with neither `q` nor an embedding
 * returns `allowedById.values()` — a Map built in corpus-scan order — and then
 * stable-sorts on an all-equal `_rank`. So the response order IS the scan
 * order.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
// NOTE: nothing from resources/ is imported here on purpose — those modules
// import `harper`, and importing it into the TEST process (rather than the
// spawned instance) fails with "Unable to determine database storage path".
// The projection property below is therefore asserted structurally.

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array; }
function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}
function ed25519Header(agent: TestAgent, method: string, path: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${agent.id}:${ts}:${nonce}:${method}:${path}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), agent.secretKey);
  return `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}
async function adminOp(harper: HarperInstance, op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
    body: JSON.stringify(op),
  });
}

let harper: HarperInstance;
const agent = mkAgent("bm25-index-premises");
const peer = mkAgent("bm25-index-premises-peer");

// Ids in an order that is NOT their insertion order — otherwise "scan order"
// and "ascending id" would agree for the wrong reason.
const INSERT_ORDER = ["m-zulu", "m-alpha", "m-mike", "m-bravo", "m-yankee", "m-charlie"];
const LEX_ORDER = [...INSERT_ORDER].sort();

async function put(id: string, body: Record<string, any>, who: TestAgent = agent): Promise<Response> {
  const path = `/Memory/${id}`;
  return fetch(`${harper.httpURL}${path}`, {
    method: "PUT",
    headers: { Authorization: ed25519Header(who, "PUT", path), "Content-Type": "application/json" },
    body: JSON.stringify({ id, agentId: who.id, durability: "standard", createdAt: new Date().toISOString(), ...body }),
  });
}

async function search(body: Record<string, any>): Promise<any> {
  const path = "/SemanticSearch";
  const res = await fetch(`${harper.httpURL}${path}`, {
    method: "POST",
    headers: { Authorization: ed25519Header(agent, "POST", path), "Content-Type": "application/json" },
    body: JSON.stringify({ agentId: agent.id, limit: 100, ...body }),
  });
  const text = await res.text();
  expect(res.status, `SemanticSearch → ${res.status}: ${text.slice(0, 300)}`).toBe(200);
  return JSON.parse(text);
}

const ids = (r: any) => (r.results ?? []).map((x: any) => x.id);

// File-scope lifecycle: both describes below share ONE instance. A
// describe-scoped afterAll would stop Harper before the second block ran.
beforeAll(async () => {
  harper = await startHarper();
  const res = await adminOp(harper, {
    operation: "insert", database: "flair", table: "Agent",
    records: [agent, peer].map((a) => ({ id: a.id, name: a.id, role: "agent", publicKey: a.publicKey, createdAt: new Date().toISOString() })),
  });
  expect(res.status).toBe(200);
  // Alternating owners: a single-agent fixture cannot tell "ascending primary
  // key" apart from "grouped by the agentId index", and the read-scope
  // OR-group's first leg IS an agentId equals.
  for (let i = 0; i < INSERT_ORDER.length; i++) {
    const id = INSERT_ORDER[i];
    const who = i % 2 === 0 ? agent : peer;
    const r = await put(id, {
      content: `premise record ${id} shared body text`,
      archived: false, visibility: "shared", tags: ["shared-tag"], subject: "shared-subject",
    }, who);
    if (![200, 204].includes(r.status)) throw new Error(`seed PUT ${id} → ${r.status}: ${await r.text()}`);
  }
}, 240_000);

afterAll(async () => { if (harper) await stopHarper(harper); });

describe("flair#1357 — real-Harper premises of the persistent BM25 index", () => {
  test("PREMISE 1: the multi-agent scope scan is NOT primary-key order — own rows lead", async () => {
    const observed = ids(await search({}));
    const own = INSERT_ORDER.filter((_, i) => i % 2 === 0).sort();
    const other = INSERT_ORDER.filter((_, i) => i % 2 === 1).sort();
    // Own rows first (primary-key order within the group), then the rest.
    expect(observed).toEqual([...own, ...other]);
    // ...which is emphatically NOT the global primary-key order. If this ever
    // starts matching, the planner changed and the tie-decline guard in
    // resources/bm25-index.ts should be revisited — do not simply relax it.
    expect(observed).not.toEqual(LEX_ORDER);
  }, 60_000);

  test("PREMISE 1: a tags/subject-filtered scan of the SAME rows comes back in a DIFFERENT order", async () => {
    // Same store, same rows, different plan, different iteration order — the
    // reason a fixed tie-break cannot be correct for every query.
    expect(ids(await search({ tag: "shared-tag" }))).toEqual(LEX_ORDER);
    expect(ids(await search({ subject: "shared-subject" }))).toEqual(LEX_ORDER);
  }, 60_000);



  test("PREMISE 2: `select` drops absent keys and keeps a FIXED declaration order", async () => {
    // Asserted structurally, without naming DEFAULT_SELECT: a SPARSE row's key
    // sequence must be a SUBSEQUENCE of a RICH row's. That holds if and only
    // if the projection emits `select` in a fixed order and omits (rather than
    // undefined-fills) the attributes a row does not carry — which is exactly
    // what the in-process projection on the indexed path reproduces when it
    // resolves a BM25-only rescue by point lookup.
    let r = await put("m-sparse", { content: "sparse row", archived: false });
    expect([200, 204]).toContain(r.status);
    r = await put("m-rich", {
      content: "rich row", archived: false, tags: ["t1"], subject: "flint",
      source: "test", summary: "a summary", sessionId: "sess-1",
      expiresAt: new Date(Date.now() + 86400_000).toISOString(),
    });
    expect([200, 204]).toContain(r.status);

    const body = await search({});
    const rows: Record<string, string[]> = {};
    for (const row of body.results) rows[row.id] = Object.keys(row);
    const sparse = rows["m-sparse"], rich = rows["m-rich"];
    expect(sparse).toBeDefined();
    expect(rich).toBeDefined();
    // The rich row really is richer — otherwise the subsequence check is vacuous.
    expect(rich.length).toBeGreaterThan(sparse.length);
    for (const k of ["tags", "subject", "summary", "expiresAt"]) expect(rich).toContain(k);
    for (const k of ["tags", "subject", "summary"]) expect(sparse).not.toContain(k);

    let i = 0;
    for (const k of rich) if (i < sparse.length && sparse[i] === k) i++;
    expect(i, `sparse keys ${JSON.stringify(sparse)} are not a subsequence of rich keys ${JSON.stringify(rich)}`)
      .toBe(sparse.length);
  }, 60_000);
});

describe("flair#1357 — incremental maintenance against a live instance", () => {
  const NEEDLE = "quokkastuff";

  test("a stored memory is IMMEDIATELY findable through the lexical leg", async () => {
    const r = await put("m-readyourwrite", { content: `${NEEDLE} appears exactly once in this store`, archived: false });
    expect([200, 204]).toContain(r.status);
    const found = await search({ q: NEEDLE, limit: 10 });
    expect(ids(found)).toContain("m-readyourwrite");
  }, 60_000);

  test("an archive flip removes it from results, and un-archiving restores it", async () => {
    let r = await put("m-archflip", { content: `${NEEDLE} archival candidate`, archived: false });
    expect([200, 204]).toContain(r.status);
    expect(ids(await search({ q: NEEDLE, limit: 10 }))).toContain("m-archflip");

    r = await put("m-archflip", { content: `${NEEDLE} archival candidate`, archived: true });
    expect([200, 204]).toContain(r.status);
    expect(ids(await search({ q: NEEDLE, limit: 10 }))).not.toContain("m-archflip");

    r = await put("m-archflip", { content: `${NEEDLE} archival candidate`, archived: false });
    expect([200, 204]).toContain(r.status);
    expect(ids(await search({ q: NEEDLE, limit: 10 }))).toContain("m-archflip");
  }, 60_000);

  test("a deleted memory disappears from the lexical leg", async () => {
    const r = await put("m-doomed", { content: `${NEEDLE} doomed record`, archived: false });
    expect([200, 204]).toContain(r.status);
    expect(ids(await search({ q: NEEDLE, limit: 10 }))).toContain("m-doomed");

    const path = "/Memory/m-doomed";
    const d = await fetch(`${harper.httpURL}${path}`, {
      method: "DELETE", headers: { Authorization: ed25519Header(agent, "DELETE", path) },
    });
    expect([200, 204]).toContain(d.status);
    expect(ids(await search({ q: NEEDLE, limit: 10 }))).not.toContain("m-doomed");
  }, 60_000);

  test("a write that BYPASSES every flair resource still reaches the index (the change feed)", async () => {
    // An operations-API insert is the shape a federation/replication apply or a
    // direct admin write has: no flair JS write path runs, so no hook fires.
    // Only the table's own change feed can carry it — which is exactly why the
    // feed, not the hook list, is the correctness argument.
    const FEED_NEEDLE = "wombatstuff";
    const res = await adminOp(harper, {
      operation: "insert", database: "flair", table: "Memory",
      records: [{
        id: "m-viafeed", agentId: agent.id, content: `${FEED_NEEDLE} inserted behind flair's back`,
        durability: "standard", archived: false, createdAt: new Date().toISOString(),
      }],
    });
    expect(res.status).toBe(200);

    // The feed is asynchronous — poll briefly rather than assert on one tick.
    let found: string[] = [];
    for (let i = 0; i < 40; i++) {
      found = ids(await search({ q: FEED_NEEDLE, limit: 10 }));
      if (found.includes("m-viafeed")) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(found).toContain("m-viafeed");

    const del = await adminOp(harper, { operation: "delete", database: "flair", table: "Memory", ids: ["m-viafeed"] });
    expect(del.status).toBe(200);
    for (let i = 0; i < 40; i++) {
      found = ids(await search({ q: FEED_NEEDLE, limit: 10 }));
      if (!found.includes("m-viafeed")) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(found).not.toContain("m-viafeed");
  }, 120_000);
});
