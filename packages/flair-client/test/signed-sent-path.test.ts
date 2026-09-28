/**
 * signed-sent-path.test.ts — flair#1987 (the flair-client site).
 *
 * `FlairClient.request` must build the FINAL request URL once, by joining the
 * route onto the base URL's OWN path, sign exactly that URL's path (+ query),
 * and send that same URL. Before this, a base URL with a path (for example
 * `FLAIR_URL=https://host/flair`) sent `/flair/Memory/<id>` while the signature
 * covered only `/Memory/<id>`, so the server refused the request.
 *
 * A real Ed25519 keypair and a real signature check prove the signed path is
 * the sent path; the request capture is a global fetch stub (nothing leaves the
 * process).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { generateKeyPairSync, verify as edVerify, type KeyObject } from "node:crypto";

const originalFetch = globalThis.fetch;
interface Captured {
  url: string;
  method: string;
  authorization: string | null;
}
let captured: Captured[] = [];

const { FlairClient } = await import("../src/client.js");

function makeClient(url: string) {
  const kp = generateKeyPairSync("ed25519");
  const client = new FlairClient({ agentId: "path-agent", url, privateKey: kp.privateKey });
  return { client, publicKey: kp.publicKey };
}

/** Verify the Ed25519 TPS signature over `sentPath` with the agent's public key. */
function signatureCovers(call: Captured, publicKey: KeyObject, sentPath: string, method = "GET"): boolean {
  const m = /^TPS-Ed25519 ([^:]+):(\d+):([^:]+):(.+)$/.exec(call.authorization ?? "");
  if (!m) return false;
  const [, agent, ts, nonce, sigB64] = m;
  const payload = Buffer.from(`${agent}:${ts}:${nonce}:${method}:${sentPath}`, "utf-8");
  return edVerify(null, payload, publicKey, Buffer.from(sigB64, "base64"));
}

beforeEach(() => {
  captured = [];
  globalThis.fetch = (async (url: string, init: any = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    captured.push({
      url: String(url),
      method: init.method ?? "GET",
      authorization: headers["Authorization"] ?? null,
    });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("flair#1987 — FlairClient signs the path it sends when the base URL has a path", () => {
  test("the base URL's own path is preserved for every base shape, signed as sent", async () => {
    const cases: Array<[string, string]> = [
      ["http://h", "/Memory/abc"], // no base path, no slash
      ["http://h/", "/Memory/abc"], // no base path, trailing slash
      ["http://h/flair", "/flair/Memory/abc"], // base path, no slash
      ["http://h/flair/", "/flair/Memory/abc"], // base path, trailing slash
    ];
    for (const [base, expected] of cases) {
      captured = [];
      const { client, publicKey } = makeClient(base);
      await client.request("GET", "/Memory/abc");

      expect(captured).toHaveLength(1);
      const call = captured[0];
      // Derive the received path from the URL itself — not by slicing the base,
      // so a trailing-slash base cannot hide a doubled slash.
      const receivedPath = new URL(call.url).pathname;
      expect(receivedPath).toBe(expected); // assertion: base path preserved, exactly one slash
      expect(signatureCovers(call, publicKey, receivedPath)).toBe(true); // assertion: signed path == sent path
    }
  });

  test("a base URL with a query string or fragment is refused before any request", async () => {
    for (const base of [
      "http://h/?tenant=1",
      "http://h/#frag",
      "http://h/?",
      "http://h/#",
      "http://h/flair?",
      "http://h/flair#",
    ]) {
      captured = [];
      const { client } = makeClient(base);
      const err = await client.request("GET", "/Memory/abc").catch((e) => e);
      expect(String(err)).toMatch(/query string or fragment/); // assertion: the rule is named
      expect(String(err)).toContain(base); // assertion: the base URL is named
      expect(captured).toHaveLength(0); // assertion: no request was sent
    }
  });

  test("a route with its own query string sends and signs pathname+search", async () => {
    const cases: Array<[string, string]> = [
      ["http://h", "/SemanticSearch?x=1"],
      ["http://h/flair", "/flair/SemanticSearch?x=1"],
    ];
    for (const [base, signedPath] of cases) {
      captured = [];
      const { client, publicKey } = makeClient(base);
      await client.request("POST", "/SemanticSearch?x=1", { q: "hello" });

      expect(captured).toHaveLength(1);
      const call = captured[0];
      const u = new URL(call.url);
      expect(u.pathname).toBe(signedPath.split("?")[0]); // assertion: pathname only
      expect(u.search).toBe("?x=1"); // assertion: the route's own query survives
      expect(signatureCovers(call, publicKey, signedPath, "POST")).toBe(true); // assertion: signed pathname+search
    }
  });
});
