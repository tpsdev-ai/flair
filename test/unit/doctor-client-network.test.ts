import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";

import { probeFlairReachable, checkAgentRegistered } from "../../src/cli.ts";

/**
 * flair#588 — the two NETWORK-dependent doctor client-integration checks.
 * Mirrors test/unit/doctor-embed-verify.test.ts: mock globalThis.fetch, and
 * write a real Ed25519 key via tweetnacl to a temp keys dir so
 * checkAgentRegistered's authFetch/buildEd25519Auth signing path runs for
 * real — only the network response is mocked.
 */

const AGENT_ID = "doctor-client-test-agent";
const BASE_URL = "http://127.0.0.1:19926";
let keysDir: string;
const realFetch = globalThis.fetch;

beforeAll(() => {
  keysDir = mkdtempSync(join(tmpdir(), "flair-doctor-client-keys-"));
  const kp = nacl.sign.keyPair();
  writeFileSync(join(keysDir, `${AGENT_ID}.key`), Buffer.from(kp.secretKey.slice(0, 32)));
});

afterAll(() => {
  rmSync(keysDir, { recursive: true, force: true });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("probeFlairReachable", () => {
  it("returns true when /Health responds", async () => {
    globalThis.fetch = (async (input: any) => {
      const url = typeof input === "string" ? input : input.url;
      expect(url).toBe(`${BASE_URL}/Health`);
      return jsonResponse(200, { ok: true });
    }) as typeof fetch;
    const reachable = await probeFlairReachable(BASE_URL);
    expect(reachable).toBe(true);
  });

  it("returns true even on a non-2xx status — reachability just means something answered", async () => {
    globalThis.fetch = (async () => jsonResponse(401, { error: "unauthorized" })) as typeof fetch;
    const reachable = await probeFlairReachable(BASE_URL);
    expect(reachable).toBe(true);
  });

  it("returns false when fetch throws (connection refused)", async () => {
    globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
    const reachable = await probeFlairReachable(BASE_URL);
    expect(reachable).toBe(false);
  });

  it("returns false on timeout and never hangs past the configured timeout", async () => {
    globalThis.fetch = (async (_input: any, init?: any) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }) as typeof fetch;
    const start = Date.now();
    const reachable = await probeFlairReachable(BASE_URL, 200);
    const elapsed = Date.now() - start;
    expect(reachable).toBe(false);
    expect(elapsed).toBeLessThan(2000);
  });

  it("strips a trailing slash before appending /Health", async () => {
    globalThis.fetch = (async (input: any) => {
      const url = typeof input === "string" ? input : input.url;
      expect(url).toBe(`${BASE_URL}/Health`);
      return jsonResponse(200, {});
    }) as typeof fetch;
    const reachable = await probeFlairReachable(`${BASE_URL}/`);
    expect(reachable).toBe(true);
  });
});

describe("checkAgentRegistered", () => {
  it("returns 'registered' on HTTP 200", async () => {
    globalThis.fetch = (async (input: any) => {
      const url = typeof input === "string" ? input : input.url;
      expect(url).toBe(`${BASE_URL}/Agent/${AGENT_ID}`);
      return jsonResponse(200, { id: AGENT_ID });
    }) as typeof fetch;
    const res = await checkAgentRegistered(BASE_URL, AGENT_ID, keysDir);
    expect(res.state).toBe("registered");
  });

  it("returns 'not-registered' on HTTP 404", async () => {
    globalThis.fetch = (async () => jsonResponse(404, { error: "not found" })) as typeof fetch;
    const res = await checkAgentRegistered(BASE_URL, AGENT_ID, keysDir);
    expect(res.state).toBe("not-registered");
  });

  it("returns 'unreachable' on a network error", async () => {
    globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
    const res = await checkAgentRegistered(BASE_URL, AGENT_ID, keysDir);
    expect(res.state).toBe("unreachable");
    expect(res.detail).toBeDefined();
  });

  it("returns 'unreachable' (not 'not-registered') on an ambiguous non-404 error status like 401", async () => {
    globalThis.fetch = (async () => jsonResponse(401, { error: "bad signature" })) as typeof fetch;
    const res = await checkAgentRegistered(BASE_URL, AGENT_ID, keysDir);
    expect(res.state).toBe("unreachable");
  });

  it("returns 'no-key' when no local key exists for the agent id", async () => {
    const emptyKeysDir = mkdtempSync(join(tmpdir(), "flair-doctor-client-empty-"));
    try {
      // fetch should never even be called — no key to sign with.
      let called = false;
      globalThis.fetch = (async () => { called = true; return jsonResponse(200, {}); }) as typeof fetch;
      const res = await checkAgentRegistered(BASE_URL, "no-such-agent", emptyKeysDir);
      expect(res.state).toBe("no-key");
      expect(called).toBe(false);
    } finally {
      rmSync(emptyKeysDir, { recursive: true, force: true });
    }
  });
});
