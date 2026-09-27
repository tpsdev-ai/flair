/**
 * ingest-id-path-encoding.test.ts — flair#1970 (flair-bench item 2).
 *
 * `ingest.ts` builds its own `PUT /Memory/<id>` path and hands it to
 * `signedFetch`, which signs exactly the path it sends. The id must therefore
 * be ONE percent-encoded path segment, and a `.`/`..` id must be refused BEFORE
 * signedFetch is called (percent-encoding leaves those unchanged and URL
 * normalization would collapse the segment).
 *
 * A real Ed25519 keypair and a real signature check prove the signed path is
 * the sent path; the request capture is a global fetch stub (nothing leaves the
 * process).
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import nacl from "tweetnacl";
import { ingestSessionHistory, encodeRecordId } from "../lib/ingest";
import { mkAgent, signedFetch } from "../lib/signed-fetch";
import type { BenchClient, SessionHistory } from "../lib/types";

interface Captured {
  url: string;
  method: string;
  authorization: string | null;
  body: string | undefined;
}

const originalFetch = globalThis.fetch;
let captured: Captured[] = [];

function client(agentId: string, httpURL = "http://bench.local"): BenchClient {
  return {
    harper: { httpURL, opsURL: "http://bench.local:ops", admin: { username: "a", password: "b" } },
    agent: mkAgent(agentId),
  };
}

function sessions(id: string): SessionHistory[] {
  return [{ sessionId: "s1", events: [{ id, content: "remember this", createdAt: "2026-01-01T00:00:00.000Z" }] }];
}

/** Verify the Ed25519 TPS signature over `sentPath` with the agent's public key (base64). */
function signatureCovers(call: Captured, publicKeyB64: string, sentPath: string, method = "PUT"): boolean {
  const m = /^TPS-Ed25519 ([^:]+):(\d+):([^:]+):(.+)$/.exec(call.authorization ?? "");
  if (!m) return false;
  const [, agent, ts, nonce, sigB64] = m;
  const payload = Buffer.from(`${agent}:${ts}:${nonce}:${method}:${sentPath}`, "utf-8");
  return nacl.sign.detached.verify(payload, Buffer.from(sigB64, "base64"), Buffer.from(publicKeyB64, "base64"));
}

beforeEach(() => {
  captured = [];
  globalThis.fetch = (async (url: string, init: any = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    captured.push({
      url: String(url),
      method: init.method ?? "GET",
      authorization: headers["Authorization"] ?? null,
      body: init.body as string | undefined,
    });
    return new Response(JSON.stringify({ id: "ok" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("flair-bench ingest: the signed Memory path equals the sent path (#1970)", () => {
  test("a reserved-character id is sent as ONE encoded segment, signed as sent", async () => {
    const id = "rec#1?x/y%z w";
    const bench = client("bench-agent");
    await ingestSessionHistory(bench, sessions(id));

    expect(captured).toHaveLength(1);
    const call = captured[0];
    // Derive the received path from the URL itself — not by slicing the base, so
    // a trailing-slash base cannot hide a doubled slash.
    const sentPath = new URL(call.url).pathname;

    // One segment after /Memory/, decoding back to exactly the id — no query,
    // no fragment. On bc400d52 the raw id is interpolated, so decodeURIComponent
    // sees a malformed `%z ` escape and this throws (RED).
    expect(sentPath).toBe(`/Memory/${encodeURIComponent(id)}`);
    const segment = sentPath.slice("/Memory/".length);
    expect(segment).not.toContain("/");
    expect(segment).not.toContain("?");
    expect(segment).not.toContain("#");
    expect(decodeURIComponent(segment)).toBe(id);

    // The signature covers the SENT path (verified with a real public key).
    expect(signatureCovers(call, bench.agent.publicKey, sentPath)).toBe(true);
    expect(JSON.parse(call.body!).id).toBe(id);
  });

  test("a '.'/'..' event id is refused BEFORE any request", async () => {
    for (const bad of [".", ".."]) {
      captured = [];
      await expect(ingestSessionHistory(client("bench-agent"), sessions(bad))).rejects.toThrow(/dot-segment/);
      expect(captured).toHaveLength(0); // assertion: no request was sent
    }
  });

  test("a trailing-slash base URL still sends ONE slash, signed as sent", async () => {
    const id = "rec#1?x/y%z w";
    const bench = client("bench-agent", "http://bench.local/");
    await ingestSessionHistory(bench, sessions(id));

    expect(captured).toHaveLength(1);
    const call = captured[0];
    const receivedPath = new URL(call.url).pathname; // derived from the URL, not slicing
    expect(receivedPath).toBe(`/Memory/${encodeURIComponent(id)}`); // assertion: exactly one slash
    expect(signatureCovers(call, bench.agent.publicKey, receivedPath)).toBe(true); // assertion: signed path == sent path
    expect(JSON.parse(call.body!).id).toBe(id);
  });

  test("the base URL's own path is preserved for every base shape", async () => {
    const id = "rec#1?x/y%z w";
    const encoded = `/Memory/${encodeURIComponent(id)}`;
    const cases: Array<[string, string]> = [
      ["http://h", encoded], // no base path, no slash
      ["http://h/", encoded], // no base path, trailing slash
      ["http://h/flair", `/flair${encoded}`], // base path, no slash
      ["http://h/flair/", `/flair${encoded}`], // base path, trailing slash
    ];
    for (const [base, expected] of cases) {
      captured = [];
      const bench = client("bench-agent", base);
      await ingestSessionHistory(bench, sessions(id));

      expect(captured).toHaveLength(1);
      const call = captured[0];
      const receivedPath = new URL(call.url).pathname; // derived from the URL, not slicing
      expect(receivedPath).toBe(expected); // assertion: base path preserved, exactly one slash
      expect(signatureCovers(call, bench.agent.publicKey, receivedPath)).toBe(true); // assertion: signed path == sent path
      expect(JSON.parse(call.body!).id).toBe(id);
    }
  });

  test("a base URL with a query string or fragment is refused before any request", async () => {
    for (const base of ["http://h/?tenant=1", "http://h/#frag", "http://h/?", "http://h/#", "http://h/flair?", "http://h/flair#"]) {
      captured = [];
      const bench = client("bench-agent", base);
      const err = await signedFetch(
        bench.harper,
        bench.agent,
        "PUT",
        `/Memory/${encodeRecordId("plain")}`,
        { id: "plain", agentId: bench.agent.id, content: "x", durability: "standard" },
      ).catch((e) => e);
      expect(String(err)).toMatch(/query string or fragment/); // assertion: the rule is named
      expect(String(err)).toContain(base); // assertion: the base URL is named
      expect(captured).toHaveLength(0); // assertion: no request was sent
    }
  });

  test("a route with its own query string sends and signs pathname+search", async () => {
    captured = [];
    const bench = client("bench-agent");
    await signedFetch(bench.harper, bench.agent, "POST", "/SemanticSearch?x=1", { q: "hello" });

    expect(captured).toHaveLength(1);
    const call = captured[0];
    const u = new URL(call.url);
    expect(u.pathname).toBe("/SemanticSearch"); // assertion: pathname only
    expect(u.search).toBe("?x=1"); // assertion: the route's own query survives
    expect(signatureCovers(call, bench.agent.publicKey, "/SemanticSearch?x=1", "POST")).toBe(true); // assertion: signed pathname+search
  });
});
