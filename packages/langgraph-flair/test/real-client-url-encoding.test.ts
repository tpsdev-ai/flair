/**
 * real-client-url-encoding.test.ts — flair#1939 item 1 (round 3): FlairStore is
 * driven through the REAL FlairClient, mocking only global fetch, so a namespace
 * label or key containing URL-significant characters must still reach the
 * server as ONE /Memory/<id> path segment. Before flair#1969 the client
 * interpolated the id raw into the path, so `#`, `?`, `/`, `%` and a space split
 * the segment and the item never round-tripped. This test FAILS on the
 * pre-#1969 client (the merge base of the round-3 head).
 */
import { describe, it, expect, afterEach } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { FlairStore } from "../src/index";

// A throwaway signing key so the client never probes a key file on disk.
const { privateKey } = generateKeyPairSync("ed25519");
const PRIVATE_KEY_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

// Both the namespace label and the key carry every URL-significant character.
const LABEL = "a#b?c%d/e f:g";
const KEY = "k#l?m%n/o p:q";
const AGENT = "lg-enc-agent";
// encodeLabel: `/` → .2F, `:` → .3A; the rest is unchanged.
const EXPECTED_ID = `lg:${AGENT}:a#b?c%d.2Fe f.3Ag:${KEY}`;

interface Req {
  method: string;
  url: string;
  pathname: string;
  idSegment: string | null;
  hash: string;
}

function fakeRes(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return body === undefined ? "" : JSON.stringify(body);
    },
  } as any;
}

function installFetch() {
  const stored = new Map<string, any>();
  const seen: Req[] = [];
  (globalThis as any).fetch = async (input: any, init: any = {}) => {
    const raw = String(input);
    const u = new URL(raw);
    const pathname = u.pathname;
    const idSegment = pathname.startsWith("/Memory/") ? pathname.slice("/Memory/".length) : null;
    seen.push({ method: init.method, url: raw, pathname, idSegment, hash: u.hash });
    if (idSegment !== null) {
      const id = decodeURIComponent(idSegment);
      if (init.method === "PUT") {
        const body = JSON.parse(init.body);
        stored.set(id, { ...body, id });
        return fakeRes({ ...body, id });
      }
      if (init.method === "GET") {
        const row = stored.get(id);
        return row ? fakeRes(row) : fakeRes({ error: "not found" }, 404);
      }
      if (init.method === "DELETE") {
        stored.delete(id);
        return fakeRes({ ok: true });
      }
    }
    if (pathname === "/Memory" && init.method === "GET") return fakeRes([...stored.values()]);
    return fakeRes({ error: "unexpected" }, 404);
  };
  return { stored, seen };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  (globalThis as any).fetch = realFetch;
});

describe("flair#1939 item 1 — FlairStore through the REAL client keeps the id in ONE path segment", () => {
  it("put, get, search and delete round-trip a label and key full of URL-significant characters", async () => {
    const { seen } = installFetch();
    const store = new FlairStore({ agentId: AGENT, url: "http://flair.test:19926", privateKey: PRIVATE_KEY_PEM });

    await store.put([LABEL], KEY, { v: 1 });

    const got = await store.get([LABEL], KEY);
    expect(got?.namespace).toEqual([LABEL]); // assertion: get restores the original label
    expect(got?.key).toBe(KEY); // assertion: get restores the original key
    expect(got?.value).toEqual({ v: 1 }); // assertion: get returns the stored value

    const found = await store.search([LABEL]);
    expect(found.map((i) => i.namespace)).toEqual([[LABEL]]); // assertion: search restores the original label
    expect(found.map((i) => i.key)).toEqual([KEY]); // assertion: search restores the original key

    await store.delete([LABEL], KEY);
    expect(await store.get([LABEL], KEY)).toBeNull(); // assertion: delete removed the item by the same id

    const idRequests = seen.filter((r) => r.idSegment !== null);
    expect(idRequests.length).toBeGreaterThanOrEqual(3); // put + get + delete all carry the id
    for (const r of idRequests) {
      expect(r.idSegment!.includes("/")).toBe(false); // assertion: exactly ONE id segment after /Memory/
      expect(r.hash).toBe(""); // assertion: no fragment swallowed part of the id
      expect(decodeURIComponent(r.idSegment!)).toBe(EXPECTED_ID); // assertion: the segment decodes to the adapter's stored id
    }
    // search reads the collection (/Memory) and filters client-side.
    expect(seen.some((r) => r.pathname === "/Memory" && r.method === "GET")).toBe(true); // assertion: search listed /Memory
  });
});
