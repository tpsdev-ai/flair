/**
 * host-source-cursor-launch-receipt-1940.test.ts — flair#1944, slice 2 of
 * flair#1940.
 *
 * Real-Harper coverage that the Cursor wake runner RECORDS A SOURCED LAUNCH
 * RECEIPT through the production memory path on a successful handoff. The
 * cycles run through `runWakeCycle` with a fake Cursor client (no network) and
 * a fake catchup feed, but the receipt store is the REAL production client
 * writing to a REAL Harper: the receipt reads back with its stable id,
 * deterministic content and the `hostSource` the server validated and stored;
 * a replay leaves the url-bearing receipt unchanged and writes no second one;
 * a url the server's grammar would refuse (http, empty userinfo) is omitted
 * with one log line and the receipt still lands; a receipt the server
 * PERMANENTLY refuses (a real 400) is acked and reported as `receiptRefused`
 * without holding later dispatches; a refusal from an identity the server does
 * not know (a real 401) is `receiptFailed` and does NOT advance the watermark;
 * a dry-run records nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarperInstance, startHarper, stopHarper } from "../helpers/harper-lifecycle";
import { FlairClient, FlairError } from "../../packages/flair-client/src/client";
import {
  createMemoryReceiptStore,
  launchReceiptId,
  runWakeCycle,
  type CatchupPage,
  type CatchupPort,
  type CursorAgentClient,
  type LaunchResult,
  type ReceiptStore,
} from "../../packages/cursor-wake-runner/src/index.ts";

interface TestAgent {
  id: string;
  publicKey: string;
  secretKey: Uint8Array;
}

function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}

async function registerAgent(harper: HarperInstance, agent: TestAgent): Promise<void> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
    },
    body: JSON.stringify({
      operation: "insert",
      database: "flair",
      table: "Agent",
      records: [{ id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() }],
    }),
  });
  expect(res.status, `Agent insert for ${agent.id} returned ${res.status}`).toBe(200);
}

let harper: HarperInstance;
let keyDir: string;

function keyPathFor(agent: TestAgent): string {
  return join(keyDir, `${agent.id}.key`);
}

async function clientFor(agent: TestAgent, register = true): Promise<FlairClient> {
  if (register) await registerAgent(harper, agent);
  const keyPath = keyPathFor(agent);
  // loadPrivateKey() treats an exactly-32-byte file as a raw Ed25519 seed.
  await writeFile(keyPath, Buffer.from(agent.secretKey.slice(0, 32)));
  return new FlairClient({ agentId: agent.id, url: harper.httpURL, keyPath });
}

function dispatchEvent(crewId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `evt-${randomUUID()}`,
    kind: "coord.dispatch",
    summary: "a light brief",
    detail: "https://github.com/example-org/example-repo/issues/7",
    targetIds: [crewId],
    authorId: "agent-b",
    position: "p1",
    ...overrides,
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

describe("flair#1944 — the Cursor wake runner records a sourced launch receipt (real Harper)", () => {
  beforeAll(async () => {
    harper = await startHarper();
    keyDir = await mkdtemp(join(tmpdir(), "flair-1944-cursor-keys-"));
    // Every HTTP target this test talks to is the instance startHarper just
    // spawned on OS-assigned loopback ports — never a fixed/production one.
    expect(new URL(harper.httpURL).hostname, "http target must be the ephemeral instance").toBe("127.0.0.1");
    expect(new URL(harper.opsURL).hostname, "ops target must be the ephemeral instance").toBe("127.0.0.1");
    expect(new URL(harper.httpURL).port).not.toBe(new URL(harper.opsURL).port);
  }, 240_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
    if (keyDir) await rm(keyDir, { recursive: true, force: true, maxRetries: 4 });
  });

  test("a created launch writes a receipt that reads back with its stable id, content and hostSource", async () => {
    const agent = mkAgent(`agent-a-${randomUUID()}`);
    const client = await clientFor(agent);
    const event = dispatchEvent(agent.id);
    const cursorAgentId = "bc-0f1e2d3c-4b5a-8978-8675-4433221100aa";
    const url = "https://cursor.example/agents/bc-0f1e2d3c-4b5a-8978-8675-4433221100aa";
    const { port, acks } = catchupWith([{ events: [event], hasMore: false }]);

    const result = await runWakeCycle({
      agentId: agent.id,
      catchup: port,
      cursor: cursorReturning({ outcome: "created", cursorAgentId, url }),
      receipts: createMemoryReceiptStore(client),
    });

    expect(result.receiptFailed, "a created launch that stored its receipt must not report a receipt failure").toBeNull();
    expect(result.acked).toBe("p1");
    expect(acks).toEqual(["p1"]);

    const id = launchReceiptId(String(event.id));
    const got = await client.memory.get(id);
    expect(got, `the receipt ${id} must be readable`).toBeTruthy();
    expect(got?.content).toContain(String(event.id));
    expect(got?.content).toContain(cursorAgentId);
    expect(got?.content).not.toContain("a light brief");
    expect(got?.hostSource).toEqual({ v: 1, host: "cursor", kind: "launch", id: cursorAgentId, url });
  }, 120_000);

  test("a replay that reuses the agent writes no second receipt and leaves the url-bearing one unchanged", async () => {
    const agent = mkAgent(`agent-b-${randomUUID()}`);
    const client = await clientFor(agent);
    const event = dispatchEvent(agent.id);
    const cursorAgentId = "bc-11112222-3333-8444-9555-666677778888";
    const url = "https://cursor.example/agents/bc-11112222-3333-8444-9555-666677778888";
    const store = createMemoryReceiptStore(client);

    const first = catchupWith([{ events: [event], hasMore: false }]);
    const created = await runWakeCycle({
      agentId: agent.id,
      catchup: first.port,
      cursor: cursorReturning({ outcome: "created", cursorAgentId, url }),
      receipts: store,
    });
    expect(created.receiptFailed).toBeNull();

    const second = catchupWith([{ events: [event], hasMore: false }]);
    const replay = await runWakeCycle({
      agentId: agent.id,
      catchup: second.port,
      cursor: cursorReturning({ outcome: "already", cursorAgentId }),
      receipts: store,
    });
    expect(replay.items[0]?.receipt).toBe("unchanged");
    expect(second.acks).toEqual(["p1"]);

    const id = launchReceiptId(String(event.id));
    const got = await client.memory.get(id);
    expect(got?.hostSource).toEqual({ v: 1, host: "cursor", kind: "launch", id: cursorAgentId, url });
    const listed = await client.memory.list();
    expect(listed.length, "the replay must not add a second receipt").toBe(1);
  }, 120_000);

  test("a write from an identity the server does not know (HTTP 401) is receiptFailed, retried, and does not ack", async () => {
    const agent = mkAgent(`agent-c-${randomUUID()}`);
    // Registered client for the idempotency READ; an UNREGISTERED identity whose
    // write the server refuses simulates the store failing at the write. That
    // refusal is about the credential, not the receipt — a configuration fault
    // the next cycle retries — so the watermark must stay put.
    const reader = await clientFor(agent);
    const refused = await clientFor(mkAgent(`agent-z-${randomUUID()}`), false);
    let seen: unknown;
    const store: ReceiptStore = {
      has: createMemoryReceiptStore(reader).has,
      write: async (receipt) => {
        try {
          await createMemoryReceiptStore(refused).write(receipt);
        } catch (err) {
          seen = err;
          throw err;
        }
      },
    };
    const event = dispatchEvent(agent.id);
    const { port, acks } = catchupWith([{ events: [event], hasMore: false }]);

    const result = await runWakeCycle({
      agentId: agent.id,
      catchup: port,
      cursor: cursorReturning({ outcome: "created", cursorAgentId: "bc-99998888-7777-8666-9555-444433332222" }),
      receipts: store,
    });

    expect(seen, "the server's refusal reaches the runner as a FlairError").toBeInstanceOf(FlairError);
    expect((seen as FlairError).status, "an unknown signing identity is refused as unauthenticated").toBe(401);
    expect(result.receiptFailed, "a refused receipt write must be a named outcome").toContain(String(event.id));
    expect(result.receiptRefused, "401 is not a permanent refusal of the receipt").toEqual([]);
    expect(result.items[0]?.receipt).toBe("failed");
    expect(result.acked).toBeNull();
    expect(acks, "the watermark must not advance past an unrecorded receipt").toEqual([]);
    const got = await reader.memory.get(launchReceiptId(String(event.id)));
    expect(got, "nothing was written, so there is no receipt").toBeNull();
  }, 120_000);

  for (const [name, url] of [
    ["an http url", "http://cursor.example/x"],
    ["an https url with EMPTY userinfo", "https://@cursor.example/x"],
  ] as const) {
    test(`a created launch whose url is ${name} records the receipt without the url, and logs one line`, async () => {
      const agent = mkAgent(`agent-e-${randomUUID()}`);
      const client = await clientFor(agent);
      const event = dispatchEvent(agent.id);
      const cursorAgentId = `bc-${randomUUID()}`;
      const { port, acks } = catchupWith([{ events: [event], hasMore: false }]);
      const lines: string[] = [];

      const result = await runWakeCycle({
        agentId: agent.id,
        catchup: port,
        cursor: cursorReturning({ outcome: "created", cursorAgentId, url }),
        receipts: createMemoryReceiptStore(client),
        log: (line) => lines.push(line),
      });

      expect(result.receiptFailed, "omitting the url must not cost the receipt").toBeNull();
      expect(result.receiptRefused).toEqual([]);
      expect(result.items[0]?.receipt).toBe("written");
      expect(result.acked).toBe("p1");
      expect(acks).toEqual(["p1"]);
      const got = await client.memory.get(launchReceiptId(String(event.id)));
      expect(got?.hostSource, "the server stored the source with no url").toEqual({ v: 1, host: "cursor", kind: "launch", id: cursorAgentId });
      expect(lines, "exactly one log line names the omitted url").toHaveLength(1);
      expect(lines[0]).toContain(String(event.id));
      expect(lines[0]).toContain("url");
    }, 120_000);
  }

  test("a receipt the server permanently refuses (HTTP 400) is acked as receiptRefused, and later dispatches still launch and record", async () => {
    const agent = mkAgent(`agent-f-${randomUUID()}`);
    const client = await clientFor(agent);
    const production = createMemoryReceiptStore(client);
    const refusedEvent = dispatchEvent(agent.id, { position: "p1" });
    const nextEvent = dispatchEvent(agent.id, { position: "p2" });
    const refusedId = launchReceiptId(String(refusedEvent.id));
    // The first receipt goes to the REAL server through the production client
    // with a host/kind pair outside the server's closed set — standing in for a
    // server whose grammar is stricter than the runner's mirror, the case where
    // every replay would be refused the same way. The 400 is the server's own.
    let seen: unknown;
    const store: ReceiptStore = {
      has: production.has,
      write: async (receipt) => {
        if (receipt.id !== refusedId) return production.write(receipt);
        try {
          await client.memory.write(receipt.content, {
            id: receipt.id,
            hostSource: { ...receipt.hostSource!, kind: "run" } as never,
          });
        } catch (err) {
          seen = err;
          throw err;
        }
      },
    };
    const launched: string[] = [];
    const cursorAgentId = `bc-${randomUUID()}`;
    const lines: string[] = [];
    const { port, acks } = catchupWith([{ events: [refusedEvent, nextEvent], hasMore: false }]);

    const result = await runWakeCycle({
      agentId: agent.id,
      catchup: port,
      cursor: {
        create: async (input) => {
          launched.push(input.dispatch.id);
          return { outcome: "created", cursorAgentId };
        },
      },
      receipts: store,
      log: (line) => lines.push(line),
    });

    expect((seen as FlairError).status, "the server refused the receipt as a bad request").toBe(400);
    expect(result.receiptFailed).toBeNull();
    expect(result.receiptRefused).toEqual([{ eventId: String(refusedEvent.id), status: 400, code: "invalid_host_source" }]);
    expect(result.items.map((item) => item.receipt)).toEqual(["refused", "written"]);
    expect(launched, "the later dispatch still launched").toEqual([String(refusedEvent.id), String(nextEvent.id)]);
    expect(result.acked, "the refusal does not hold the watermark").toBe("p2");
    expect(acks).toEqual(["p2"]);
    expect(lines, "one log line for the refusal").toHaveLength(1);
    expect(lines[0]).toContain("400 invalid_host_source");
    expect(await client.memory.get(refusedId), "the refused receipt was not stored").toBeNull();
    const next = await client.memory.get(launchReceiptId(String(nextEvent.id)));
    expect(next?.hostSource).toEqual({ v: 1, host: "cursor", kind: "launch", id: cursorAgentId });
  }, 120_000);

  test("a dry-run records no receipt and acks nothing", async () => {
    const agent = mkAgent(`agent-d-${randomUUID()}`);
    const client = await clientFor(agent);
    const event = dispatchEvent(agent.id);
    const { port, acks } = catchupWith([{ events: [event], hasMore: false }]);

    const result = await runWakeCycle({
      agentId: agent.id,
      catchup: port,
      cursor: cursorReturning({ outcome: "dry-run", cursorAgentId: "bc-00000000-0000-8000-8000-000000000000" }),
      receipts: createMemoryReceiptStore(client),
      dryRun: true,
    });

    expect(result.items[0]?.action).toBe("dry-run");
    expect(result.items[0]?.receipt).toBeUndefined();
    expect(result.acked).toBeNull();
    expect(acks).toEqual([]);
    const got = await client.memory.get(launchReceiptId(String(event.id)));
    expect(got, "a dry-run must not write a receipt").toBeNull();
  }, 120_000);
});
