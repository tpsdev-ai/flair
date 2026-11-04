/**
 * The internal core reaches the production receipt store's write-time guard.
 * With Basic-only credentials or an unresolved key, the receipt read reaches
 * the loopback stub; the write is refused before sending and the event is unacked.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { FlairClient, inspectKeyLookup } from "@tpsdev-ai/flair-client";
import {
  createMemoryReceiptStore,
  launchReceiptId,
  type CatchupPage,
  type CatchupPort,
  type CursorAgentClient,
  type CursorLaunchConfig,
  type LaunchResult,
} from "../src/index.ts";
// flair#1944 round 8 — the internal core that takes the test seams is NOT on the
// package's public entry (`src/index.ts`); tests reach it from its own module.
import { runWakeCycleCore } from "../src/run.ts";

const CURSOR_CONFIG: CursorLaunchConfig = { apiBase: "https://api.cursor.com", apiKey: "k" };

function mkAgent(id: string): { id: string; publicKey: string; secretKey: Uint8Array } {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
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

function catchupWith(pages: CatchupPage[]): { port: CatchupPort; acks: string[] } {
  const acks: string[] = [];
  let i = 0;
  return {
    acks,
    port: {
      drain: async () => pages[Math.min(i++, pages.length - 1)] ?? { events: [], hasMore: false },
      ack: async (position) => {
        acks.push(position);
      },
    },
  };
}

function cursorReturning(result: LaunchResult): CursorAgentClient {
  return { create: async () => result };
}

let server: Server;
let base: string;
let requests: string[] = [];
let keyDir: string;

beforeAll(async () => {
  // A loopback stub: the idempotency READ gets a 404 (the receipt id is absent
  // to this reader), and any WRITE would get a 200. If the write is ever sent,
  // it "succeeds" — exactly the fallback the guard must prevent.
  server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url ?? ""}`);
    req.on("data", () => {});
    req.on("end", () => {
      if (req.method === "GET") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  expect(new URL(base).hostname, "the stub is loopback so Basic over http is allowed").toBe("127.0.0.1");
  keyDir = await mkdtemp(join(tmpdir(), "flair-1944-signing-keys-"));
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (keyDir) await rm(keyDir, { recursive: true, force: true, maxRetries: 4 });
});

describe("the core refuses writes with Basic-only credentials or an unresolved key", () => {
  test("runWakeCycleCore with a Basic-backed client: the write is refused by name, nothing acked", async () => {
    requests = [];
    const agentId = `agent-basic-${randomUUID()}`;
    // The core bypasses startup validation to exercise the store's write guard.
    const client = new FlairClient({
      agentId,
      url: base,
      keyPath: join(keyDir, `absent-${randomUUID()}.key`),
      adminUser: "admin",
      adminPassword: "secret",
    });
    const { port, acks } = catchupWith([{ events: [dispatchEvent(agentId)], hasMore: false }]);

    const result = await runWakeCycleCore(
      { client, cursor: CURSOR_CONFIG },
      { catchup: port, cursor: cursorReturning({ outcome: "created", cursorAgentId: `bc-${randomUUID()}` }) },
    );

    expect(result.items[0].receipt, "an unsigned live write must not be recorded").toBe("failed");
    expect(result.receiptFailed, "the refusal names the signing key").toContain("live receipts need the agent's signing key");
    expect(result.receiptRefused).toEqual([]);
    expect(result.acked, "this signing-key refusal leaves the event unacked").toBeNull();
    expect(acks).toEqual([]);
    expect(requests, "only the idempotency read reached the stub — no Basic write was sent").toEqual([
      `GET /Memory/${launchReceiptId("evt-1")}`,
    ]);
  });

  test("the core with a key removed after an existence probe: the client fails closed, nothing acked", async () => {
    requests = [];
    const agent = mkAgent(`agent-gone-${randomUUID()}`);
    const keyPath = join(keyDir, `${agent.id}.key`);
    // loadPrivateKey() treats an exactly-32-byte file as a raw Ed25519 seed.
    await writeFile(keyPath, Buffer.from(agent.secretKey.slice(0, 32)));
    // An existence probe finds the key...
    expect(inspectKeyLookup(agent.id, keyPath).resolvedPath, "the key is present at the check").toBe(keyPath);
    // ...then the file disappears before this client loads it.
    await rm(keyPath, { force: true });
    const client = new FlairClient({ agentId: agent.id, url: base, keyPath });
    const { port, acks } = catchupWith([{ events: [dispatchEvent(agent.id)], hasMore: false }]);

    const result = await runWakeCycleCore(
      { client, cursor: CURSOR_CONFIG },
      { catchup: port, cursor: cursorReturning({ outcome: "created", cursorAgentId: `bc-${randomUUID()}` }) },
    );

    expect(result.items[0].receipt, "a vanished key must fail closed, not fall back").toBe("failed");
    expect(result.receiptFailed, "the refusal names the signing key").toContain("live receipts need the agent's signing key");
    expect(result.acked).toBeNull();
    expect(acks).toEqual([]);
    expect(requests, "the write was refused before it was sent").toEqual([
      `GET /Memory/${launchReceiptId("evt-1")}`,
    ]);
  });
});

describe("receipt store construction from the core's Flair client", () => {
  test("the store's agentId is the client's — there is no second label to supply", () => {
    const signer = `agent-signer-${randomUUID()}`;
    const client = new FlairClient({ agentId: signer, url: base, keyPath: join(keyDir, `absent-${randomUUID()}.key`) });
    // The store takes the client alone and copies its agentId.
    expect(createMemoryReceiptStore(client).agentId).toBe(signer);
  });

  test("the core reads through its Flair client and refuses an unsigned receipt write", async () => {
    requests = [];
    const agentId = `agent-one-${randomUUID()}`;
    const client = new FlairClient({
      agentId,
      url: base,
      keyPath: join(keyDir, `absent-${randomUUID()}.key`),
      adminUser: "admin",
      adminPassword: "secret",
    });
    const { port } = catchupWith([{ events: [dispatchEvent(agentId)], hasMore: false }]);
    const result = await runWakeCycleCore(
      { client, cursor: CURSOR_CONFIG },
      { catchup: port, cursor: cursorReturning({ outcome: "created", cursorAgentId: `bc-${randomUUID()}` }) },
    );
    // The store is the client's: the idempotency READ went to THAT client's
    // memory (the stub), and there is no separate store argument to point at
    // another agent.
    expect(result.receiptFailed, "no key for this id, so the write fails closed").toContain("signing key");
    expect(requests, "the read went to the runner's own client").toEqual([`GET /Memory/${launchReceiptId("evt-1")}`]);
  });
});
