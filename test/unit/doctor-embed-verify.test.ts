import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";

import { verifySemanticSearch } from "../../src/cli.ts";

/**
 * FIX 1 (onboarding dogfood round 1, ops-9czl):
 * `flair doctor` / `flair init` must run a REAL embed→paraphrase-search
 * round-trip and FAIL LOUDLY when embeddings are not loaded — never report
 * all-clear while recall-by-meaning is dead.
 *
 * verifySemanticSearch() drives that gate. We mock global.fetch to simulate the
 * SemanticSearch server in each state:
 *   - embeddings present:  paraphrase recovers the probe with a real score → "ok"
 *   - embeddings absent:   server sets _warning (keyword-only fallback)     → "degraded"
 *   - keyword-only miss:   paraphrase shares no keywords → empty results    → "degraded"
 *   - bad score:           recalled only via keyword bonus (<=0.05)         → "degraded"
 *   - no agent/key:        cannot run the check                              → "skipped"
 *
 * A real Ed25519 key is written to disk so the function's signing path runs
 * exactly as in production; only the network is mocked.
 */

const AGENT_ID = "doctor-test-agent";
const BASE_URL = "http://127.0.0.1:19926";
let keysDir: string;
const realFetch = globalThis.fetch;

beforeAll(() => {
  keysDir = mkdtempSync(join(tmpdir(), "flair-doctor-keys-"));
  // Write a real 32-byte Ed25519 seed so buildEd25519Auth() can sign requests.
  const kp = nacl.sign.keyPair();
  writeFileSync(join(keysDir, `${AGENT_ID}.key`), Buffer.from(kp.secretKey.slice(0, 32)));
});

afterAll(() => {
  rmSync(keysDir, { recursive: true, force: true });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Build a Response-like object the function can read via .ok/.status/.json/.text. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Install a fetch mock that routes by method+path. `searchBody` is what the
 * POST /SemanticSearch call returns. PUT (write) and DELETE always succeed.
 */
function mockServer(searchBody: unknown, searchStatus = 200) {
  const calls: { method: string; url: string }[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, url });
    if (method === "PUT") return jsonResponse(200, { id: "probe" });        // write
    if (method === "DELETE") return jsonResponse(200, { ok: true });        // cleanup
    if (method === "POST" && url.includes("/SemanticSearch")) {
      return jsonResponse(searchStatus, searchBody);                        // search
    }
    return jsonResponse(404, { error: "unexpected" });
  }) as typeof fetch;
  return calls;
}

describe("verifySemanticSearch (FIX 1: doctor embed round-trip)", () => {
  it("returns 'ok' when the paraphrase recalls the probe with a real semantic score", async () => {
    // Simulate embeddings loaded: the probe memory comes back with a genuine
    // similarity score (well above the 0.05 keyword floor) and no _warning.
    const calls = mockServer({
      results: [{ id: "PLACEHOLDER", content: "...", _rawScore: 0.72, _score: 0.5 }],
    });

    // The probe id is generated inside the function; to match it we instead
    // return ANY result whose id equals the one PUT. Capture it from the PUT url.
    // Simplest: make the search echo the id from the most recent PUT call.
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, url });
      if (method === "PUT") {
        // url: <base>/Memory/<id>
        const id = url.split("/Memory/")[1];
        (globalThis as any).__probeId = id;
        return jsonResponse(200, { id });
      }
      if (method === "DELETE") return jsonResponse(200, { ok: true });
      if (method === "POST" && url.includes("/SemanticSearch")) {
        const id = (globalThis as any).__probeId;
        return jsonResponse(200, { results: [{ id, content: "match", _rawScore: 0.72, _score: 0.5 }] });
      }
      return jsonResponse(404, { error: "unexpected" });
    }) as typeof fetch;

    const result = await verifySemanticSearch(BASE_URL, AGENT_ID, keysDir);
    expect(result.state).toBe("ok");
    if (result.state === "ok") expect(result.score).toBeGreaterThan(0.05);
    // Verify it actually did write → search → delete.
    expect(calls.some((c) => c.method === "PUT")).toBe(true);
    expect(calls.some((c) => c.method === "POST" && c.url.includes("/SemanticSearch"))).toBe(true);
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  it("returns 'degraded' when the server flags keyword-only fallback (_warning)", async () => {
    // This is the exact embeddings-not-loaded signal: getMode()==="none" → _warning.
    mockServer({ results: [], _warning: "semantic search unavailable — results are keyword-only" });
    const result = await verifySemanticSearch(BASE_URL, AGENT_ID, keysDir);
    expect(result.state).toBe("degraded");
  });

  it("returns 'degraded' when the paraphrase recalls nothing (keyword-only miss)", async () => {
    // No _warning, but the probe isn't in the results — keyword scan can't match
    // a paraphrase with zero shared words. Recall-by-meaning is dead.
    mockServer({ results: [{ id: "some-other-memory", _rawScore: 0.1 }] });
    const result = await verifySemanticSearch(BASE_URL, AGENT_ID, keysDir);
    expect(result.state).toBe("degraded");
  });

  it("returns 'degraded' when the probe is recalled only via keyword bonus (score <= 0.05)", async () => {
    // Echo the probe id back but with a non-semantic score (only the +0.05
    // keyword bonus). That means it was a keyword hit, not a meaning match.
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "PUT") {
        const id = url.split("/Memory/")[1];
        (globalThis as any).__probeId2 = id;
        return jsonResponse(200, { id });
      }
      if (method === "DELETE") return jsonResponse(200, { ok: true });
      if (method === "POST" && url.includes("/SemanticSearch")) {
        const id = (globalThis as any).__probeId2;
        return jsonResponse(200, { results: [{ id, _rawScore: 0.05, _score: 0.05 }] });
      }
      return jsonResponse(404, {});
    }) as typeof fetch;

    const result = await verifySemanticSearch(BASE_URL, AGENT_ID, keysDir);
    expect(result.state).toBe("degraded");
  });

  it("returns 'skipped' when no agent id or key is available", async () => {
    const emptyKeysDir = mkdtempSync(join(tmpdir(), "flair-doctor-empty-"));
    // No --agent, no FLAIR_AGENT_ID, no key files in the dir.
    const prev = process.env.FLAIR_AGENT_ID;
    delete process.env.FLAIR_AGENT_ID;
    try {
      const result = await verifySemanticSearch(BASE_URL, undefined, emptyKeysDir);
      expect(result.state).toBe("skipped");
    } finally {
      if (prev !== undefined) process.env.FLAIR_AGENT_ID = prev;
      rmSync(emptyKeysDir, { recursive: true, force: true });
    }
  });

  it("returns 'skipped' when SemanticSearch errors (e.g. 401 auth)", async () => {
    mockServer({ error: "authentication required" }, 401);
    const result = await verifySemanticSearch(BASE_URL, AGENT_ID, keysDir);
    expect(result.state).toBe("skipped");
  });
});
