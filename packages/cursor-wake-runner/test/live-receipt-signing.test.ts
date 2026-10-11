/**
 * live-receipt-signing.test.ts — flair#1944 round 5 (slice 2 of flair#1940).
 *
 * A live receipt WRITE must be signed as the runner's own agent. Round 4 put the
 * check in `main()` at startup; round 5 enforces it WHERE THE WRITE HAPPENS, so
 * a caller that drives `runWakeCycle` directly — or a key file that disappears
 * after the CLI's existence check — cannot fall back to admin Basic credentials.
 * The production receipt store asks the client to REQUIRE the signing key, and
 * the client fails CLOSED at send time (before the request leaves the process).
 *
 * Every HTTP target here is a loopback stub this file started. The guarded cases
 * must reach it only for the idempotency READ; the receipt WRITE is refused before
 * it is sent. The event is never acked on either case.
 *
 * MUTATION (flair#1944 round 5): drop `requireSigningKey: true` from
 * receipt-store.ts's write. The Basic case then sends Basic and the unsigned case
 * sends an unsigned write; both land as "written" and ack, so the first test
 * fails. Run and restored.
 *
 * flair#1944 round 7 replaces round 6's runtime guards with construction: the
 * cycle takes ONE `FlairClient` and builds the receipt store (and the catchup
 * reader) from THAT client, so the store's signing identity IS the runner
 * identity and a store that signs as another agent is unrepresentable — there is
 * no second agent label and no store to supply. MUTATION (round 7): give
 * `runWakeCycle` back a caller-supplied `receipts` store (or an `agentId` label)
 * and this file's single-client case no longer compiles/behaves: the runner would
 * read, write and ack through a store it was handed rather than the client's.
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

describe("flair#1944 round 5 — a live receipt write is refused unless it signs as the agent", () => {
  test("runWakeCycle with a Basic-backed client: the write is refused by name, nothing acked", async () => {
    requests = [];
    const agentId = `agent-basic-${randomUUID()}`;
    // Admin Basic credentials and NO signing key for this id — the state round 4
    // refused at CLI startup. Driven through runWakeCycle directly, the STORE
    // built from this client must still refuse the write.
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
    expect(result.acked, "nothing is acked without a recorded receipt").toBeNull();
    expect(acks).toEqual([]);
    expect(requests, "only the idempotency read reached the stub — no Basic write was sent").toEqual([
      `GET /Memory/${launchReceiptId("evt-1")}`,
    ]);
  });

  test("the key file removed between the CLI's existence check and the write: the client fails closed, nothing acked", async () => {
    requests = [];
    const agent = mkAgent(`agent-gone-${randomUUID()}`);
    const keyPath = join(keyDir, `${agent.id}.key`);
    // loadPrivateKey() treats an exactly-32-byte file as a raw Ed25519 seed.
    await writeFile(keyPath, Buffer.from(agent.secretKey.slice(0, 32)));
    // The CLI's startup existence check passes...
    expect(inspectKeyLookup(agent.id, keyPath).resolvedPath, "the key is present at the check").toBe(keyPath);
    // ...then the key file disappears before the receipt write.
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

describe("flair#1944 round 7 — one client, one identity: a mismatched signer is unrepresentable", () => {
  test("the store signs as EXACTLY the client's own agent — there is no second label to supply", () => {
    const signer = `agent-signer-${randomUUID()}`;
    const client = new FlairClient({ agentId: signer, url: base, keyPath: join(keyDir, `absent-${randomUUID()}.key`) });
    // The store takes the client alone: its signing identity is the client's.
    expect(createMemoryReceiptStore(client).agentId).toBe(signer);
  });

  test("the cycle writes its receipt through the client it runs: the client's memory is the only store", async () => {
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
