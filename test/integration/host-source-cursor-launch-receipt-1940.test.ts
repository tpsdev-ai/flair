/**
 * host-source-cursor-launch-receipt-1940.test.ts — flair#1944, slice 2 of
 * flair#1940.
 *
 * Real-Harper coverage that the Cursor wake runner ATTEMPTS A SOURCED LAUNCH
 * RECEIPT through the production memory path on a successful handoff (a
 * classified refusal is acked without one). Each cycle runs through the
 * internal `runWakeCycleCore` (flair#1944 round 8 — the EXPORTED `runWakeCycle`
 * takes no test seam; the core it delegates to does) on ONE real Flair client —
 * the runner builds the receipt store from that client (flair#1944 round 7) —
 * with a fake Cursor endpoint and a canned catchup feed (no network). The receipt
 * reads back with its stable id, deterministic content and
 * the `hostSource` the server validated and stored; a replay leaves the url-bearing
 * receipt unchanged and writes no second one; a url the server's grammar would
 * refuse (http, empty userinfo) is omitted with one log line and the receipt
 * still lands; a client the server does not know (a real 401) is `receiptFailed`
 * and does NOT advance the watermark; a row already at the receipt id that is NOT
 * this runner's own receipt (another agent's memory, or the runner's own row with
 * different content) is a named `receiptMismatched`, left untouched, and NOT
 * acked; a foreign PRIVATE row at the id reads as absent, so the runner attempts
 * the write and the SERVER refuses it — a named `receiptFailed`, row untouched,
 * not acked; a source id the server stores NFC-normalised is still verified on
 * replay; a dry-run records nothing.
 *
 * A receipt write the runner treats as a non-retryable refusal (a real 400) is
 * covered by the unit cases in `packages/cursor-wake-runner/test/launch-receipt.test.ts`:
 * the production path only ever submits a receipt whose host-source mirrors the
 * server's grammar, so a real server 400 is not reachable through it.
 *
 * MUTATION (flair#1944 round 3): make the existing-receipt path existence-only
 * (`read` returns a bare boolean, or ignores the row's identity). The two
 * "not this runner's receipt" cases below then return `"unchanged"` and ACK —
 * this file fails.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarperInstance, startHarper, stopHarper } from "../helpers/harper-lifecycle";
import { FlairClient } from "../../packages/flair-client/src/client";
import {
  launchReceiptId,
  wakeAgentId,
  type CatchupPage,
  type CatchupPort,
  type CursorAgentClient,
  type CursorLaunchConfig,
  type LaunchResult,
} from "../../packages/cursor-wake-runner/src/index.ts";
// flair#1944 round 8 — the internal core that takes the test seams is NOT on the
// package's public entry (`src/index.ts`); tests reach it from its own module.
import { runWakeCycleCore } from "../../packages/cursor-wake-runner/src/run.ts";

const CURSOR_CONFIG: CursorLaunchConfig = { apiBase: "https://api.cursor.com", apiKey: "k" };

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

    const result = await runWakeCycleCore(
      { client, cursor: CURSOR_CONFIG },
      { catchup: port, cursor: cursorReturning({ outcome: "created", cursorAgentId, url }) },
    );

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

    const first = catchupWith([{ events: [event], hasMore: false }]);
    const created = await runWakeCycleCore(
      { client, cursor: CURSOR_CONFIG },
      { catchup: first.port, cursor: cursorReturning({ outcome: "created", cursorAgentId, url }) },
    );
    expect(created.receiptFailed).toBeNull();

    const second = catchupWith([{ events: [event], hasMore: false }]);
    const replay = await runWakeCycleCore(
      { client, cursor: CURSOR_CONFIG },
      { catchup: second.port, cursor: cursorReturning({ outcome: "already", cursorAgentId }) },
    );
    expect(replay.items[0]?.receipt).toBe("unchanged");
    expect(second.acks).toEqual(["p1"]);

    const id = launchReceiptId(String(event.id));
    const got = await client.memory.get(id);
    expect(got?.hostSource).toEqual({ v: 1, host: "cursor", kind: "launch", id: cursorAgentId, url });
    const listed = await client.memory.list();
    expect(listed.length, "the replay must not add a second receipt").toBe(1);
  }, 120_000);

  test("a client the server does not know (HTTP 401): the idempotency read fails, receiptFailed, nothing acked", async () => {
    const unknown = mkAgent(`agent-z-${randomUUID()}`);
    // A client whose agent the server does not know — its idempotency READ (the
    // first thing the store does) is refused as unauthenticated. Under round 7
    // there is one client for the whole cycle, so the read and the write share
    // that identity; the old "registered reader, UNREGISTERED writer" split is
    // unrepresentable. The refusal is a configuration fault the next cycle
    // retries, so the watermark must stay put and nothing is written.
    const client = await clientFor(unknown, false);
    const event = dispatchEvent(unknown.id);
    const { port, acks } = catchupWith([{ events: [event], hasMore: false }]);

    const result = await runWakeCycleCore(
      { client, cursor: CURSOR_CONFIG },
      { catchup: port, cursor: cursorReturning({ outcome: "created", cursorAgentId: `bc-${randomUUID()}` }) },
    );

    expect(result.receiptFailed, "a refused receipt read must be a named outcome").toContain(String(event.id));
    expect(result.receiptRefused, "an unknown identity is not a permanent refusal of the receipt").toEqual([]);
    expect(result.items[0]?.receipt).toBe("failed");
    expect(result.acked).toBeNull();
    expect(acks, "the watermark must not advance past an unrecorded receipt").toEqual([]);
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

      const result = await runWakeCycleCore(
        { client, cursor: CURSOR_CONFIG, log: (line) => lines.push(line) },
        { catchup: port, cursor: cursorReturning({ outcome: "created", cursorAgentId, url }) },
      );

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

  test("a row at the receipt id that is ANOTHER agent's memory is not this runner's receipt: named mismatch, no ack, row untouched", async () => {
    const runner = mkAgent(`agent-m-${randomUUID()}`);
    const other = mkAgent(`agent-n-${randomUUID()}`);
    const runnerClient = await clientFor(runner);
    const otherClient = await clientFor(other);
    const event = dispatchEvent(runner.id);
    const id = launchReceiptId(String(event.id));
    // Another agent's SHARED memory already occupies the receipt id (a shared
    // row is readable by the runner, so a bare existence check would see it).
    await otherClient.memory.write("an unrelated memory written by another agent", { id, visibility: "shared" });
    const { port, acks } = catchupWith([{ events: [event], hasMore: false }]);

    const result = await runWakeCycleCore(
      { client: runnerClient, cursor: CURSOR_CONFIG },
      { catchup: port, cursor: cursorReturning({ outcome: "created", cursorAgentId: "bc-abcdef01-2345-8678-89ab-cdef01234567" }) },
    );

    expect(result.items[0]?.receipt, "a foreign row is not this runner's receipt").toBe("mismatched");
    expect(result.receiptMismatched, "the failure names the id").toContain(id);
    expect(result.receiptFailed).toBeNull();
    expect(result.acked, "a foreign row must not ack the event").toBeNull();
    expect(acks).toEqual([]);
    const got = await otherClient.memory.get(id);
    expect(got?.content, "the foreign row is left untouched").toBe("an unrelated memory written by another agent");
    expect(got?.agentId).toBe(other.id);
    expect(await runnerClient.memory.list(), "the runner wrote no receipt of its own").toHaveLength(0);
  }, 120_000);

  test("the runner's OWN row at the receipt id with different content: named mismatch, no ack, row untouched", async () => {
    const agent = mkAgent(`agent-o-${randomUUID()}`);
    const client = await clientFor(agent);
    const event = dispatchEvent(agent.id);
    const id = launchReceiptId(String(event.id));
    // The runner's own agent already stored SOMETHING at the id, but it is not
    // the deterministic receipt for this event.
    await client.memory.write("a stale receipt naming a different launch", { id });
    const { port, acks } = catchupWith([{ events: [event], hasMore: false }]);

    const result = await runWakeCycleCore(
      { client, cursor: CURSOR_CONFIG },
      { catchup: port, cursor: cursorReturning({ outcome: "already", cursorAgentId: wakeAgentId(String(event.id)) }) },
    );

    expect(result.items[0]?.receipt).toBe("mismatched");
    expect(result.receiptMismatched).toContain(id);
    expect(result.acked, "a different-content row must not ack the event").toBeNull();
    expect(acks).toEqual([]);
    const got = await client.memory.get(id);
    expect(got?.content, "the row is left untouched").toBe("a stale receipt naming a different launch");
  }, 120_000);

  test("a foreign PRIVATE row at the receipt id reads as absent: the runner's write is refused, the row untouched, the event not acked (flair#1944 round 5)", async () => {
    const runner = mkAgent(`agent-q-${randomUUID()}`);
    const other = mkAgent(`agent-r-${randomUUID()}`);
    const runnerClient = await clientFor(runner);
    const otherClient = await clientFor(other);
    const event = dispatchEvent(runner.id);
    const id = launchReceiptId(String(event.id));
    // Another agent's PRIVATE row occupies the receipt id. A PRIVATE row is not
    // readable by the runner, so its `memory.get` gets a 404 and reads as absent —
    // the runner does not SEE a row to verify, and attempts the write. The server
    // refuses that write (only the row's owner may modify it), so the runner
    // reports a retryable `receiptFailed` and does NOT ack.
    const written = await otherClient.memory.write("another agent's private note", { id });
    expect((written as { visibility?: string }).visibility, "the row a plain write stamps is private").toBe("private");
    const { port, acks } = catchupWith([{ events: [event], hasMore: false }]);

    const result = await runWakeCycleCore(
      { client: runnerClient, cursor: CURSOR_CONFIG },
      { catchup: port, cursor: cursorReturning({ outcome: "created", cursorAgentId: "bc-22223333-4444-8555-9666-777788889999" }) },
    );

    expect(result.items[0]?.receipt, "the server refused the write; the receipt is not recorded").toBe("failed");
    expect(result.receiptFailed, "the failure names the receipt id").toContain(id);
    expect(result.receiptMismatched, "the runner never saw the row, so this is not a mismatch").toBeNull();
    expect(result.receiptRefused, "a refusal of the write is not a non-retryable receipt refusal").toEqual([]);
    expect(result.acked, "the event must not be acked").toBeNull();
    expect(acks).toEqual([]);
    const got = await otherClient.memory.get(id);
    expect(got?.content, "the foreign private row is left untouched").toBe("another agent's private note");
    expect(got?.agentId).toBe(other.id);
  }, 120_000);

  test("a source id the server stores NFC-normalised verifies on replay and acks (flair#1944 round 5)", async () => {
    const agent = mkAgent(`agent-p-${randomUUID()}`);
    const client = await clientFor(agent);
    const event = dispatchEvent(agent.id);
    // The Cursor id carries a KELVIN-SIGN `K` (U+212A); the server stores its NFC
    // form (ASCII `K`). The replay reuses the raw id, so the source comparison
    // must normalise both sides or it would call this legitimate replay a mismatch.
    const rawId = "bc-\u212A0f1e2d3c-4b5a-8978-8675-4433221100aa";
    const normalizedId = rawId.normalize("NFC");
    expect(normalizedId, "the id actually changes under NFC").not.toBe(rawId);

    const first = catchupWith([{ events: [event], hasMore: false }]);
    const created = await runWakeCycleCore(
      { client, cursor: CURSOR_CONFIG },
      { catchup: first.port, cursor: cursorReturning({ outcome: "created", cursorAgentId: rawId }) },
    );
    expect(created.receiptFailed).toBeNull();
    expect(created.acked).toBe("p1");
    const id = launchReceiptId(String(event.id));
    const got = await client.memory.get(id);
    expect(got?.hostSource, "the server stored the normalised id").toEqual({ v: 1, host: "cursor", kind: "launch", id: normalizedId });

    const second = catchupWith([{ events: [event], hasMore: false }]);
    const replay = await runWakeCycleCore(
      { client, cursor: CURSOR_CONFIG },
      { catchup: second.port, cursor: cursorReturning({ outcome: "already", cursorAgentId: rawId }) },
    );
    expect(replay.items[0]?.receipt, "the raw id verifies against the normalised stored id").toBe("unchanged");
    expect(replay.receiptMismatched).toBeNull();
    expect(second.acks).toEqual(["p1"]);
    expect((await client.memory.list()).length, "the replay wrote no second receipt").toBe(1);
  }, 120_000);

  test("a dry-run records no receipt and acks nothing", async () => {
    const agent = mkAgent(`agent-d-${randomUUID()}`);
    const client = await clientFor(agent);
    const event = dispatchEvent(agent.id);
    const { port, acks } = catchupWith([{ events: [event], hasMore: false }]);

    const result = await runWakeCycleCore(
      { client, cursor: CURSOR_CONFIG, dryRun: true },
      { catchup: port, cursor: cursorReturning({ outcome: "dry-run", cursorAgentId: "bc-00000000-0000-8000-8000-000000000000" }) },
    );

    expect(result.items[0]?.action).toBe("dry-run");
    expect(result.items[0]?.receipt).toBeUndefined();
    expect(result.acked).toBeNull();
    expect(acks).toEqual([]);
    const got = await client.memory.get(launchReceiptId(String(event.id)));
    expect(got, "a dry-run must not write a receipt").toBeNull();
  }, 120_000);
});
