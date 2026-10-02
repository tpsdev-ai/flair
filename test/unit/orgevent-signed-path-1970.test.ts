/**
 * orgevent-signed-path-1970.test.ts — flair#1970.
 *
 * `publishOrgEvent` signs the final request target, including a base URL path
 * prefix. The signature must cover the SAME pathname and query that are sent,
 * and that path must carry the id as one encoded segment — otherwise an id with
 * reserved URL characters signs one path and requests another.
 *
 * A real Ed25519 key and a real signature check prove it: the test captures the
 * request, recomputes `agentId:ts:nonce:PUT:<path>` from the request's own
 * Authorization header and the path it received, and verifies it with the
 * public key. The agent id carries `#`, `?`, `%` and a space so the encoded and
 * raw spellings differ.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import nacl from "tweetnacl";
import { publishOrgEvent } from "../../src/commands/orgevent.js";
import { authFetch, authedRequest } from "../../src/lib/auth-resolve.js";
import { encodeRecordId } from "../../src/lib/record-id-path.js";

const AGENT = "org agent#1?%x"; // no ":" and no "/": the key file must exist and the header must split
const BASE = "http://example.test";

const realFetch = globalThis.fetch;
let scratch: string;
let publicKey: Uint8Array;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "flair-orgevent-1970-"));
  const kp = nacl.sign.keyPair();
  publicKey = kp.publicKey;
  writeFileSync(join(scratch, `${AGENT}.key`), Buffer.from(kp.secretKey.slice(0, 32)));
  process.env.FLAIR_KEY_DIR = scratch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  delete process.env.FLAIR_KEY_DIR;
});

interface Captured { url: string; authorization: string; body: string }

function captureFetch(into: Captured[]): void {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    into.push({ url: String(url), authorization: String(headers.Authorization ?? headers.authorization ?? ""), body: String(init?.body ?? "") });
    const id = (JSON.parse(String(init?.body ?? "{}")) as { id?: string }).id ?? "x";
    return new Response(JSON.stringify({ id }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("flair#1970: orgevent signs the exact encoded path it sends", () => {
  for (const baseUrl of [BASE, `${BASE}/flair`]) {
    test(`the signed path is the sent path at ${baseUrl}, with the id as one encoded segment`, async () => {
    const captured: Captured[] = [];
    captureFetch(captured);

    let id = "";
    try {
      const res = await publishOrgEvent({ agentId: AGENT, baseUrl, kind: "note", summary: "hello" });
      expect(res.ok).toBe(true);
      id = String(res.id);
    } finally {
      globalThis.fetch = realFetch;
      rmSync(scratch, { recursive: true, force: true });
    }

    expect(captured).toHaveLength(1);
    const url = new URL(captured[0].url);
    const path = `${url.pathname}${url.search}`;

    // One id segment, that decodes to the id (which carries reserved chars).
    const segments = path.split("/");
    const prefix = baseUrl.endsWith("/flair") ? "/flair" : "";
    expect(segments).toHaveLength(prefix ? 4 : 3);
    expect(segments[prefix ? 2 : 1]).toBe("OrgEvent");
    expect(decodeURIComponent(segments[prefix ? 3 : 2])).toBe(id);
    expect(path).toBe(`${prefix}/OrgEvent/${encodeRecordId(id)}`);

    // The signature covers THAT path.
    const parts = captured[0].authorization.replace(/^TPS-Ed25519 /, "").split(":");
    expect(parts).toHaveLength(4);
    const [agent, ts, nonce, sig] = parts;
    expect(agent).toBe(AGENT);
    const payload = `${agent}:${ts}:${nonce}:PUT:${path}`;
    expect(nacl.sign.detached.verify(Buffer.from(payload), Buffer.from(sig, "base64"), publicKey)).toBe(true);
    });
  }

  test("shared CLI auth paths sign the final prefixed pathname and query", async () => {
    const captured: Captured[] = [];
    captureFetch(captured);
    const keyPath = join(scratch, `${AGENT}.key`);
    const route = "/Memory/id%2Fpart?limit=1";
    try {
      await authFetch(`${BASE}/flair`, AGENT, keyPath, "GET", route);
      await authedRequest("GET", route, undefined, {
        baseUrl: `${BASE}/flair`, agentId: AGENT, explicitKeyPath: keyPath,
      });
    } finally {
      globalThis.fetch = realFetch;
      rmSync(scratch, { recursive: true, force: true });
    }
    expect(captured).toHaveLength(2);
    for (const request of captured) {
      const url = new URL(request.url);
      const target = `${url.pathname}${url.search}`;
      expect(target).toBe("/flair/Memory/id%2Fpart?limit=1");
      const [agent, ts, nonce, sig] = request.authorization.replace(/^TPS-Ed25519 /, "").split(":");
      const payload = `${agent}:${ts}:${nonce}:GET:${target}`;
      expect(nacl.sign.detached.verify(Buffer.from(payload), Buffer.from(sig, "base64"), publicKey)).toBe(true);
    }
  });
});
