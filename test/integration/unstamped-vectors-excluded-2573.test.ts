/**
 * unstamped-vectors-excluded-2573.test.ts — flair#2573 slice 1 (real Harper).
 *
 * A Memory write that supplies its own `embedding` and no `embeddingModel`
 * stamp stores a vector of unknown space. The query-time embedding-space guard's
 * scan reads `embeddingModel` and skips a row with no space-bearing stamp, so
 * its "uniform" verdict covers the stamped rows only — and before this slice a
 * vector query could cosine against an untrusted stored vector.
 *
 * This test drives a REAL Harper agent write (the ed25519 REST path) that
 * supplies its own embedding with no stamp, then:
 *   - a vector-only query (a query embedding, no `q`) does NOT return that row,
 *     while a stamped row IS returned (unaffected);
 *   - the guard's /Health line counts the excluded row;
 *   - the same row IS found by the lexical leg.
 *
 * Determinism: the guard's boot pre-warm scan is held at the test-only
 * `scan-verdict` pause point (armed before Harper starts), i.e. after its own
 * read of the empty store. The rows are written while it is parked, and a
 * recall consult starts the scan that reads them — the same start order
 * embedding-space-scan-order-2508 pins. The always-on embedding-stamp migration
 * would otherwise re-embed a no-stamp row (which removes the very state under
 * test), so its regen is held at `embedding-stamp-regen-pre` for the same span.
 * Both are released in afterAll; the fault-injection gate is the environment the
 * spawned Harper inherits.
 *
 * Mutation check (fails on an assertion): in
 * resources/semantic-retrieval-core.ts, drop `trustedVectorCondition()` from the
 * HNSW query's conditions (both vector legs), leaving everything else — the
 * vector-only query then returns the unstamped row and the exclusion assertion
 * goes red.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { getModelId } from "../../resources/embeddings-provider.ts";
import { TEST_FAULT_INJECTION_ENV, TEST_PAUSE_DIR_ENV } from "../../resources/txn-pause-point.ts";

const SCAN_POINT = "scan-verdict";
const REGEN_POINT = "embedding-stamp-regen-pre";
const AGENT = "agent-a"; // neutral fixture name (no fleet host/agent)

/** The stamp the spawned instance writes when it embeds. Same env, same value. */
const CURRENT_STAMP = getModelId();

/** A vector the untrusted row stores and a query can target. */
const UNTRUSTED_VEC = [1, 0, 0, 0];
const STAMPED_VEC = [1, 1, 0, 0]; // cosine 0.7071 against UNTRUSTED_VEC

const KEYWORD = "zqxuntrustedkeyword"; // lexical-only token, absent from the stamped row

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

async function waitFor(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

describe("flair#2573 slice 1 — a stored vector with no trusted stamp is excluded from the vector leg (real Harper)", () => {
  let harper: HarperInstance | undefined;
  let pauseDir = "";
  const agent = mkAgent(AGENT);

  const basicAuth = () => "Basic " + btoa(`${harper!.admin.username}:${harper!.admin.password}`);
  async function adminOp(op: Record<string, unknown>): Promise<Response> {
    return fetch(harper!.opsURL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basicAuth() },
      body: JSON.stringify(op),
    });
  }
  async function agentFetch(method: string, path: string, body: unknown): Promise<Response> {
    return fetch(`${harper!.httpURL}${path}`, {
      method,
      headers: { Authorization: ed25519Header(agent, method, path), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  async function semanticSearch(body: Record<string, unknown>): Promise<any> {
    const res = await agentFetch("POST", "/SemanticSearch", body);
    const text = await res.text();
    expect(res.status, `SemanticSearch returned ${res.status}: ${text.slice(0, 300)}`).toBe(200);
    return JSON.parse(text);
  }
  async function health(): Promise<any> {
    const res = await fetch(`${harper!.httpURL}/Health`);
    const text = await res.text();
    expect(res.status, `/Health returned ${res.status}: ${text.slice(0, 300)}`).toBe(200);
    return JSON.parse(text);
  }

  beforeAll(async () => {
    pauseDir = mkdtempSync(join(tmpdir(), "flair-2573-pause-"));
    // Hold the guard's boot scan AFTER its (empty-store) read, and hold the
    // stamp migration's regen so the no-stamp state persists. The rows written
    // below are read by the consult scan the first query starts.
    writeFileSync(join(pauseDir, `arm.${SCAN_POINT}`), "");
    writeFileSync(join(pauseDir, `arm.${REGEN_POINT}`), "");
    const saved: Record<string, string | undefined> = {
      [TEST_FAULT_INJECTION_ENV]: process.env[TEST_FAULT_INJECTION_ENV],
      [TEST_PAUSE_DIR_ENV]: process.env[TEST_PAUSE_DIR_ENV],
    };
    process.env[TEST_FAULT_INJECTION_ENV] = "1";
    process.env[TEST_PAUSE_DIR_ENV] = pauseDir;
    try {
      harper = await startHarper();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    expect(harper.external).toBe(false);
    expect(harper.ownsInstallDir).toBe(true);

    // The guard's boot scan must be parked after its read before rows exist.
    expect(
      await waitFor(join(pauseDir, `paused.${SCAN_POINT}`), 30_000),
      "no guard scan reached the boot pause (the boot pre-warm should have)",
    ).toBe(true);

    // Register the agent (publicKey) so the ed25519 write/search paths accept it.
    const insert = await adminOp({
      operation: "insert", database: "flair", table: "Agent",
      records: [{ id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() }],
    });
    expect(insert.status).toBe(200);

    // THE agent write under test: a caller-supplied embedding with no stamp.
    const untrusted = await agentFetch("POST", "/Memory", {
      agentId: AGENT,
      content: `a caller-supplied vector of unknown space ${KEYWORD}`,
      embedding: UNTRUSTED_VEC,
      visibility: "shared",
    });
    expect(untrusted.status, `untrusted write returned ${untrusted.status}: ${(await untrusted.text()).slice(0, 300)}`).toBeLessThan(300);

    // A stamped row on the current space — unaffected by the exclusion.
    const stamped = await agentFetch("POST", "/Memory", {
      agentId: AGENT,
      content: "a row the server-stamped vector space covers",
      embedding: STAMPED_VEC,
      embeddingModel: CURRENT_STAMP,
      visibility: "shared",
    });
    expect(stamped.status, `stamped write returned ${stamped.status}: ${(await stamped.text()).slice(0, 300)}`).toBeLessThan(300);

    // A recall consult starts the scan that reads both rows; the parked boot
    // scan never sees them and is refused as stale when released in afterAll.
    // A supplied query embedding guarantees the consult (no model needed).
    await semanticSearch({ agentId: AGENT, queryEmbedding: UNTRUSTED_VEC, limit: 1 });
  }, 180_000);

  afterAll(async () => {
    // Never leave the guard scan or the migration regen parked.
    if (pauseDir) {
      writeFileSync(join(pauseDir, `go.${SCAN_POINT}`), "");
      writeFileSync(join(pauseDir, `go.${REGEN_POINT}`), "");
    }
    if (harper) await stopHarper(harper);
    if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
  }, 60_000);

  test("the unstamped row is excluded from the vector leg and counted; the stamped row and the lexical leg are unaffected", async () => {
    // Wait for the released scan's verdict to publish, then read /Health: the
    // store is uniform over stamped rows and one row is excluded.
    let space: any;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      space = (await health()).embeddingSpace;
      if (space?.state === "uniform" && space?.excluded === 1) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(space?.state, "guard state should be uniform over the stamped rows").toBe("uniform");
    expect(space?.excluded, "the unstamped row must be counted").toBe(1);

    // Vector-only query: only the query embedding, no `q`. The unstamped row's
    // vector is a perfect cosine match, yet it must not be returned; the stamped
    // row is.
    const vectorOnly = await semanticSearch({ agentId: AGENT, queryEmbedding: UNTRUSTED_VEC, limit: 20 });
    const vecIds = vectorOnly.results.map((r: any) => r.content as string);
    expect(vecIds.some((c: string) => c.includes("unknown space")), "the unstamped vector row must not be returned by a vector-only query").toBe(false);
    expect(vecIds.some((c: string) => c.includes("server-stamped vector space")), "the stamped row must still be returned").toBe(true);

    // The same row still matches lexically.
    const lexical = await semanticSearch({ agentId: AGENT, q: KEYWORD, limit: 20 });
    const lexIds = lexical.results.map((r: any) => r.content as string);
    expect(lexIds.some((c: string) => c.includes("unknown space")), "the excluded row must still match on the lexical leg").toBe(true);
  }, 120_000);

  test("the unstamped row is not returned even when it is the only vector match", async () => {
    // A query embedding that only the unstamped row's vector matches closely.
    const res = await semanticSearch({ agentId: AGENT, queryEmbedding: UNTRUSTED_VEC, minScore: 0.9, limit: 20 });
    expect(res.results.map((r: any) => r.content as string).some((c: string) => c.includes("unknown space"))).toBe(false);
  }, 60_000);

  test("the migration regen pause was not needed to change the outcome (sanity: the untrusted row persists)", async () => {
    // Read the stored row straight off the ops API: it still carries a vector and
    // no stamp, i.e. the exclusion above was not a missing-vector artifact.
    const res = await adminOp({
      operation: "search_by_value", database: "flair", table: "Memory",
      search_attribute: "agentId", search_type: "equals", search_value: AGENT, get_attributes: ["id", "embedding", "embeddingModel"],
    });
    expect(res.status).toBe(200);
    const rows: any[] = await res.json();
    const untrusted = rows.find((r) => Array.isArray(r.embedding) && r.embedding.length === 4 && !r.embeddingModel);
    expect(untrusted, "the unstamped row must still exist with its vector and no stamp").toBeTruthy();
  }, 60_000);
});
