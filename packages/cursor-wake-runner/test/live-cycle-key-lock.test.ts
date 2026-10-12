/**
 * live-cycle-key-lock.test.ts — flair#1944 round 10 (slice 2 of flair#1940).
 *
 * Round 10 fixes that at the START of a live cycle: `runWakeCycle` calls
 * `client.loadSigningKey()`, which LOADS AND VALIDATES the agent's Ed25519 key
 * into the client's memory, CACHES it, and puts the client in a mode where every
 * FlairClient request MUST be signed with that loaded key — no admin Basic
 * fallback or unsigned request on catchup, receipt operations or ack. A key file
 * removed after the check can no longer cause a Basic fallback, and an
 * unparsable/non-Ed25519 key file is refused at the start, by name.
 *
 * Every HTTP target here is a loopback stub this file started (http on 127.0.0.1,
 * so admin Basic over it is allowed). The stub captures each request's
 * Authorization header, so a case can assert that NO Flair request ever carried a
 * Basic header.
 *
 * MUTATION (flair#1944 round 10): replace the start-of-cycle load with round 9's
 * existence-only check (`client.hasSigningKey()` instead of
 * `client.loadSigningKey()`). Then the client is neither locked nor primed, so
 * (a) the key file the cycle removes before its first request is gone by that
 * request and the catchup read falls back to admin Basic — the "no Basic request"
 * assertion fails (test 3), and (b) the invalid-key file is not refused at the
 * start, by name (test 4). Run and restored.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { FlairClient } from "@tpsdev-ai/flair-client";
import {
  launchReceiptId,
  runWakeCycle,
  type CursorLaunchConfig,
  type ReceiptStore,
  type WakeDeps,
} from "../src/index.ts";

const CURSOR_CONFIG: CursorLaunchConfig = { apiBase: "https://api.cursor.com", apiKey: "k" };

let server: Server;
let base: string;
let keyDir: string;
let recorded: Array<{ method: string; url: string; authorization: string }> = [];

function mkAgent(id: string): { id: string; secretKey: Uint8Array } {
  const kp = nacl.sign.keyPair();
  return { id, secretKey: kp.secretKey };
}

function dispatchEvent(crewId: string): Record<string, unknown> {
  return {
    id: "evt-1",
    kind: "coord.dispatch",
    summary: "a light brief",
    detail: "https://github.com/example-org/example-repo/issues/7",
    targetIds: [crewId],
    authorId: "agent-b",
    position: "p1",
  };
}

/** Only the Flair requests (not the Cursor launch POST) this stub saw. */
function flairRequests(): Array<{ method: string; url: string; authorization: string }> {
  return recorded.filter((r) => r.url.startsWith("/OrgEventCatchup/") || r.url.startsWith("/Memory/"));
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "";
    const authorization = Array.isArray(req.headers.authorization)
      ? (req.headers.authorization[0] ?? "")
      : (req.headers.authorization ?? "");
    recorded.push({ method: req.method ?? "", url, authorization });
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      const respond = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.method === "GET" && url.startsWith("/OrgEventCatchup/")) {
        const agentId = decodeURIComponent(url.split("/")[2] ?? "");
        respond(200, { events: [dispatchEvent(agentId)], hasMore: false });
        return;
      }
      if (req.method === "POST" && url === "/v1/agents") {
        let requested = "";
        try {
          const parsed = JSON.parse(body || "{}") as { agentId?: string };
          requested = typeof parsed.agentId === "string" ? parsed.agentId : "";
        } catch {
          requested = "";
        }
        respond(201, { agent: { id: requested, url: `https://cursor.example/agents/${requested}` } });
        return;
      }
      if (req.method === "GET" && url.startsWith("/Memory/")) {
        respond(404, { error: "not_found" });
        return;
      }
      // PUT /Memory/<id> (the receipt write) and POST /OrgEventCatchup/<id> (ack).
      respond(200, {});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  expect(new URL(base).hostname, "the stub is loopback so Basic over http is allowed").toBe("127.0.0.1");
  keyDir = await mkdtemp(join(tmpdir(), "flair-1944-keylock-"));
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (keyDir) await rm(keyDir, { recursive: true, force: true, maxRetries: 4 });
});

describe("flair#1944 round 10 — the client LOADS and VALIDATES the key, and locks to signed-only", () => {
  test("loadSigningKey locks the client: removing its key file still permits signed FlairClient requests", async () => {
    recorded = [];
    const agent = mkAgent(`agent-lock-${randomUUID()}`);
    const keyPath = join(keyDir, `${agent.id}.key`);
    // loadPrivateKey() treats an exactly-32-byte file as a raw Ed25519 seed.
    await writeFile(keyPath, Buffer.from(agent.secretKey.slice(0, 32)));
    // Admin Basic credentials AND a key: only the LOCK decides which is used.
    const client = new FlairClient({
      agentId: agent.id,
      url: base,
      keyPath,
      adminUser: "admin",
      adminPassword: "secret",
    });

    expect(client.signingRequired, "a fresh client is not locked").toBe(false);
    await client.loadSigningKey();
    expect(client.signingRequired, "the load puts the client in signed-only mode").toBe(true);

    // The key file disappears AFTER the load — a round-9 existence check would now
    // fall back to admin Basic on the next request.
    await rm(keyPath, { force: true });
    await client.request("GET", `/OrgEventCatchup/${agent.id}`);

    const auth = flairRequests()[0]?.authorization ?? "";
    expect(auth.startsWith("TPS-Ed25519 "), "the loaded key still signs after the file is gone").toBe(true);
    expect(auth.startsWith("Basic "), "a locked client NEVER sends admin Basic").toBe(false);
  });

  test("loadSigningKey refuses a key file that EXISTS but is not a usable Ed25519 key", async () => {
    const agent = mkAgent(`agent-invalid-${randomUUID()}`);
    const keyPath = join(keyDir, `${agent.id}.key`);
    await writeFile(keyPath, Buffer.from("this-is-not-a-valid-ed25519-key-file"));
    const client = new FlairClient({ agentId: agent.id, url: base, keyPath, adminUser: "admin", adminPassword: "secret" });

    let refused: unknown;
    try {
      await client.loadSigningKey();
    } catch (err) {
      refused = err;
    }
    expect(refused, "an unparsable key file must be refused at load").toBeInstanceOf(Error);
    expect((refused as Error).message).toContain("requires the agent's Ed25519 signing key");
    expect(client.signingRequired, "a refused load never locks the client to signed-only").toBe(false);
  });
});

describe("flair#1944 round 10 — a live cycle signs every FlairClient request", () => {
  test("a live cycle loads the key at the start; a file removed after loading still permits signed FlairClient requests", async () => {
    recorded = [];
    const agent = mkAgent(`agent-live-lock-${randomUUID()}`);
    const keyPath = join(keyDir, `${agent.id}.key`);
    await writeFile(keyPath, Buffer.from(agent.secretKey.slice(0, 32)));
    const client = new FlairClient({
      agentId: agent.id,
      url: base,
      keyPath,
      adminUser: "admin",
      adminPassword: "secret",
    });
    // Deterministically simulate the key file vanishing AFTER the start check but
    // BEFORE the cycle's first request: the first Flair request DELETES the file,
    // then delegates to the real client. Round 10 has already loaded the key into
    // memory by now, so the request still signs; round 9's existence-only check
    // would leave nothing to sign with and this read would go out as Basic.
    const realRequest = client.request.bind(client);
    let first = true;
    (client as { request: typeof client.request }).request = async (method, path, body, opts) => {
      if (first) {
        first = false;
        await rm(keyPath, { force: true });
      }
      return realRequest(method, path, body, opts);
    };

    const result = await runWakeCycle({ client, cursor: { apiBase: base, apiKey: "k" } });

    expect(existsSync(keyPath), "the key file was gone before the cycle's first request").toBe(false);

    // No FlairClient request in the cycle fell back to admin Basic.
    const flair = flairRequests();
    for (const request of flair) {
      expect(
        request.authorization.startsWith("Basic "),
        `${request.method} ${request.url} must never fall back to admin Basic`,
      ).toBe(false);
      expect(
        request.authorization.startsWith("TPS-Ed25519 "),
        `${request.method} ${request.url} is signed with the agent's own key`,
      ).toBe(true);
    }
    expect(
      flair.map((r) => `${r.method} ${r.url}`),
      "every Flair request in the cycle reached the stub — catchup, receipt read/write, ack",
    ).toEqual([
      `GET /OrgEventCatchup/${agent.id}`,
      `GET /Memory/${launchReceiptId("evt-1")}`,
      `PUT /Memory/${launchReceiptId("evt-1")}`,
      `POST /OrgEventCatchup/${agent.id}`,
    ]);
    expect(client.signingRequired, "the start check LOCKED the client to signed-only").toBe(true);
    expect(result.items[0]?.action, "the dispatch was really launched (created)").toBe("launched");
    expect(result.items[0]?.receipt, "the receipt landed through the client's own memory").toBe("written");
    expect(
      recorded.some((r) => r.method === "POST" && r.url === "/v1/agents"),
      "the live cycle calls Cursor",
    ).toBe(true);
  });

  test("a live cycle refuses an EXISTING but unparsable key file at the start, by name, before any request", async () => {
    recorded = [];
    const agent = mkAgent(`agent-live-invalid-${randomUUID()}`);
    const keyPath = join(keyDir, `${agent.id}.key`);
    await writeFile(keyPath, Buffer.from("this-is-not-a-valid-ed25519-key-file"));
    const client = new FlairClient({ agentId: agent.id, url: base, keyPath, adminUser: "admin", adminPassword: "secret" });

    let refused: unknown;
    try {
      await runWakeCycle({ client, cursor: { apiBase: base, apiKey: "k" } });
    } catch (err) {
      refused = err;
    }

    expect(refused, "a live cycle with an unparsable key must be refused").toBeInstanceOf(Error);
    expect((refused as Error).message, "the refusal names the signing key").toContain(
      "live receipts need the agent's signing key",
    );
    expect(recorded, "the refusal is BEFORE any request — nothing read, nothing launched, nothing written").toEqual([]);
  });
});

describe("flair#1944 round 10 — the EXPORTED runWakeCycle takes no caller-supplied store", () => {
  test("WakeDeps carries no `receipts` store — a caller cannot supply one", () => {
    // @ts-expect-error — WakeDeps has no `receipts`; the store is built from the client's own identity.
    const withStore: WakeDeps = { client: {} as FlairClient, cursor: CURSOR_CONFIG, receipts: {} as ReceiptStore };
    expect("receipts" in withStore, "only a runtime leftover here, never a typed field").toBe(true);
  });

  test("a stray `receipts` store is IGNORED: the cycle writes the receipt through the client's own memory", async () => {
    // A fake FlairClient that serves its own catchup feed and records memory writes,
    // plus a stray store that records any call. The exported `runWakeCycle` must
    // ignore the stray store entirely and use the client's own memory.
    const wrote: string[] = [];
    const client = {
      agentId: "anvil",
      async loadSigningKey() {
        return undefined;
      },
      hasSigningKey() {
        return true;
      },
      async request(method: string, path: string) {
        if (path.startsWith("/OrgEventCatchup/")) {
          if (method === "GET") return { events: [dispatchEvent("anvil")], hasMore: false };
          return {};
        }
        throw new Error(`unexpected ${method} ${path}`);
      },
      memory: {
        async get() {
          return null;
        },
        async write(_content: string, opts: { id?: string } = {}) {
          wrote.push(String(opts.id));
          return { id: opts.id };
        },
      },
    } as unknown as FlairClient;

    const strayWrote: string[] = [];
    const stray = {
      receipts: {
        agentId: "anvil",
        read: async () => null,
        write: async (receipt: { id: string }) => {
          strayWrote.push(receipt.id);
        },
      },
    } as unknown as Partial<WakeDeps>;

    const result = await runWakeCycle({ client, cursor: { apiBase: base, apiKey: "k" }, ...stray });

    expect(result.items[0]?.receipt, "the receipt is written through the client's own memory").toBe("written");
    expect(wrote, "the client's own memory got the receipt write").toEqual([launchReceiptId("evt-1")]);
    expect(strayWrote, "the stray store is IGNORED — the cycle never reads or writes through it").toEqual([]);
  });
});
