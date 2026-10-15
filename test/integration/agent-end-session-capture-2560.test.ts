/**
 * agent-end-session-capture-2560.test.ts — flair#2560, real-Harper readback of a
 * session-keyed `agent_end` capture.
 *
 * The plugin's session-keyed `agent_end` scan (packages/openclaw-flair/index.ts)
 * is exercised against a REAL Harper component (test/helpers/harper-lifecycle.ts,
 * not the fixed production ports) instead of a stubbed fetch: the scan writes a
 * Memory row, and the row is read back through the production client. The
 * session id the scan carried is asserted on the stored row, and a later run of
 * the same session that re-delivers the whole snapshot does not store the
 * message again while the session retains the message's identity and the
 * encoded fields are unchanged.
 *
 * The third test pins the stated cold-start limit (flair#2560): the session's
 * identity set is the only record that a message was seen and lives in process
 * memory, so after a gateway restart a re-delivered message is captured again.
 * The real Flair component stores that repeat as a second row and, in this
 * fixture, flags its write response `deduplicated` with a near-matching row;
 * the plugin counts it.
 *
 * The host is a minimal stand-in for the OpenClaw plugin API: it exposes the
 * hooks and tools the plugin registers and nothing else, and reports a host
 * version in the plugin's tested set.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { HarperInstance, startHarper, stopHarper } from "../helpers/harper-lifecycle";
import { FlairClient } from "../../packages/flair-client/src/client";
import plugin from "../../packages/openclaw-flair/index.ts";

/** A randomized name for the test agent (never a real fleet host or agent). */
const AGENT = `agent-a-${randomUUID().slice(0, 8)}`;
const HOST_VERSION = "2026.9.6"; // in the plugin's tested host set

interface TestAgent {
  id: string;
  publicKey: string;
  secretKey: Uint8Array;
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

/** The plugin API surface the plugin's register() touches, and nothing more. */
function makeHost(pluginConfig: Record<string, unknown>, config: Record<string, unknown>) {
  const hooks = new Map<string, Array<(event: any, ctx: any) => any>>();
  const tools = new Map<string, (ctx: any) => any>();
  const warns: string[] = [];
  const api = {
    id: "openclaw-flair",
    runtime: { version: HOST_VERSION },
    config,
    pluginConfig,
    logger: {
      info: (m: unknown) => { void m; },
      warn: (m: unknown) => { warns.push(String(m)); },
      error: (m: unknown) => { void m; },
      debug: (m: unknown) => { void m; },
    },
    on(hook: string, handler: (event: any, ctx: any) => any) {
      const list = hooks.get(hook) ?? [];
      list.push(handler);
      hooks.set(hook, list);
    },
    registerTool(factory: (ctx: any) => any, meta: { name: string }) {
      tools.set(meta.name, factory);
    },
    registerService(service: { id: string; start: (ctx: any) => any }) {
      void service;
    },
    registerContextEngine(id: string, factory: Function) {
      void id;
      void factory;
    },
    async _fire(hook: string, event: any, ctx: any): Promise<void> {
      for (const h of hooks.get(hook) ?? []) await h(event, ctx);
    },
    _warnText(): string {
      return warns.join("\n");
    },
  };
  return api;
}

let harper: HarperInstance;
let keyDir: string;
let keyPath: string;

describe("flair#2560 — a session-keyed agent_end capture reads back from real Harper", () => {
  beforeAll(async () => {
    harper = await startHarper();
    keyDir = await mkdtemp(join(tmpdir(), "flair-2560-agent-end-keys-"));
    mkdirSync(keyDir, { recursive: true });
    const kp = nacl.sign.keyPair();
    const agent: TestAgent = { id: AGENT, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
    await registerAgent(harper, agent);
    keyPath = join(keyDir, `${AGENT}.key`);
    // loadPrivateKey() treats an exactly-32-byte file as a raw Ed25519 seed.
    writeFileSync(keyPath, Buffer.from(agent.secretKey.slice(0, 32)));
    chmodSync(keyPath, 0o600);
  }, 240_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
    if (keyDir) await rm(keyDir, { recursive: true, force: true, maxRetries: 4 });
  });

  /** A plugin host wired to the running Harper for the single allowed agent. */
  function hostForCapture(): ReturnType<typeof makeHost> {
    const config = {
      agents: { entries: { [AGENT]: {} } },
      plugins: { slots: { memory: "openclaw-flair" }, entries: { "openclaw-flair": { hooks: { allowConversationAccess: true } } } },
    };
    const api = makeHost({ autoCapture: true, url: harper.httpURL, agentId: AGENT, keyPath }, config);
    plugin.register(api as any);
    return api;
  }

  function reader(): FlairClient {
    return new FlairClient({ agentId: AGENT, url: harper.httpURL, keyPath });
  }

  async function countCaptured(c: FlairClient, marker: string): Promise<number> {
    const rows = await c.memory.list({ limit: 200 });
    return rows.filter((m) => m.content.includes(marker)).length;
  }

  test("a session-keyed agent_end scan stores the run's new message, and the row reads back with the host session id", async () => {
    const api = hostForCapture();
    const c = reader();
    const runId = `run-${randomUUID()}`;
    const sessionId = `sess-${randomUUID()}`;
    const marker = `openclaw-agent-end-${randomUUID()}`;

    await api._fire(
      "agent_end",
      { runId, success: true, messages: [{ role: "user", content: `remember this: the session capture is ${marker}`, timestamp: 1 }] },
      { agentId: AGENT, sessionId },
    );

    const rows = await c.memory.list({ limit: 200 });
    const row = rows.find((m) => m.content.includes(marker));
    expect(row, `capture ${marker} must have landed`).toBeTruthy(); // assertion: the session-keyed scan wrote through to real Harper
    expect(row?.sessionId).toBe(sessionId); // assertion: the row carries the host session id
    // assertion: the capture names the writer's host run
    expect(JSON.stringify(row?.hostSource ?? {})).toContain(runId);
    expect(await countCaptured(c, marker)).toBe(1);
  }, 120_000);

  test("a later run of the same session that re-delivers the snapshot does not store the message again", async () => {
    const api = hostForCapture();
    const c = reader();
    const runId = `run-${randomUUID()}`;
    const sessionId = `sess-${randomUUID()}`;
    const marker = `openclaw-agent-end-once-${randomUUID()}`;
    const msg = { role: "user", content: `remember this: the once-only session capture is ${marker}`, timestamp: 2 };

    await api._fire("agent_end", { runId, success: true, messages: [msg] }, { agentId: AGENT, sessionId });
    await api._fire("agent_end", { runId: `run-${randomUUID()}`, success: true, messages: [msg] }, { agentId: AGENT, sessionId });

    expect(await countCaptured(c, marker)).toBe(1); // assertion: one row for the two runs that re-delivered it
  }, 120_000);

  test("flair#2560 cold start (mutation: the deduplicated flag is ignored): after gateway_stop and a new registration, a re-delivered message is captured again; Flair stores the repeat as a second row, flags it deduplicated, and the plugin counts it", async () => {
    // A spy on the real fetch (every request still reaches the real Harper):
    // it keeps the JSON body of each Memory write response.
    const realFetch = globalThis.fetch;
    const writes: Array<Record<string, any>> = [];
    globalThis.fetch = (async (input: any, init?: any) => {
      const res = await realFetch(input, init);
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if ((init?.method ?? "GET") === "PUT" && /\/Memory\//.test(url)) writes.push(await res.clone().json());
      return res;
    }) as typeof fetch;
    try {
      const c = reader();
      const sessionId = `sess-${randomUUID()}`;
      const marker = `openclaw-agent-end-repeat-${randomUUID()}`;
      // Two unrelated texts. In this fixture the server's near-duplicate check
      // did not match one against the other (the first two writes assert it).
      const M1 = { role: "user", content: `remember this: the deploy window for ${marker} is Tuesday morning`, timestamp: 3 };
      const M2 = { role: "user", content: `remember this: we decided ${marker} keeps seven days of cache history`, timestamp: 4 };

      const before = hostForCapture();
      await before._fire("agent_end", { runId: "run-repeat-1", success: true, messages: [M1, M2] }, { agentId: AGENT, sessionId });
      // The gateway stops (the plugin clears its session state), then a new
      // registration starts with none, as after a gateway restart.
      await before._fire("gateway_stop", {}, {});
      const after = hostForCapture();
      await after._fire("agent_end", { runId: "run-repeat-2", success: true, messages: [M1, M2] }, { agentId: AGENT, sessionId });

      const rows = (await c.memory.list({ limit: 200 })).filter((m) => m.content.includes(marker));
      for (const which of ["the deploy window", "seven days of cache history"]) {
        const mine = rows.filter((m) => m.content.includes(which));
        // assertion: the repeat is a second row, under the later run, in the same session
        expect(mine.map((m: any) => m.hostSource?.id).sort()).toEqual(["run-repeat-1", "run-repeat-2"]);
        expect(mine.every((m) => m.sessionId === sessionId)).toBe(true);
        expect(new Set(mine.map((m) => m.id)).size).toBe(2);
      }
      // assertion: the server's near-duplicate check flags each repeat's write
      // response with a near-matching row (in this fixture, the row it repeats)
      // and does not suppress the write. The scan walks the snapshot from its
      // last position, so each run writes M2, then M1.
      expect(writes).toHaveLength(4);
      expect(writes.slice(0, 2).map((w) => w.deduplicated)).toEqual([false, false]);
      expect(writes.slice(2).map((w) => [w.written, w.deduplicated, w.matchedId])).toEqual([
        [true, true, writes[0].id],
        [true, true, writes[1].id],
      ]);
      // assertion: the restarted plugin counts the flagged repeats (lines at the 1st and 2nd)
      const lines = after._warnText().split("\n").filter((l) => l.includes("stored a near-duplicate of an existing memory"));
      expect(lines.map((l) => l.match(/; (\d+) such capture/)?.[1])).toEqual(["1", "2"]);
    } finally {
      globalThis.fetch = realFetch;
    }
  }, 120_000);
});
