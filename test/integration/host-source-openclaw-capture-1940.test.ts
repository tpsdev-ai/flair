/**
 * host-source-openclaw-capture-1940.test.ts — flair#1940, the OpenClaw adapter
 * slice.
 *
 * Real-Harper coverage that the OpenClaw plugin's CAPTURE path keeps the host
 * run id as a `hostSource`, end to end: the plugin writes a captured memory to a
 * running Flair component, and the memory is read back through the production
 * client as its author.
 *
 *   t1  a captured memory reads back with hostSource {openclaw, run, <run id>}
 *       for its author, and with the host session id;
 *   t2  a run id OUTSIDE the server's id grammar captures WITHOUT a source (the
 *       write still lands) and logs one line;
 *   t3  a NON-capture write (the memory_store tool) carries no source.
 *
 * The host is a minimal stand-in for the OpenClaw plugin API: it exposes the
 * hooks and tools the plugin registers and nothing else. Only the plugin's
 * capture path is exercised; the Flair component on the other side is the real
 * built one.
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

/** A name unique to this run, so re-runs never collide on the Agent row. */
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
    _tool(name: string, ctx: any): any {
      const factory = tools.get(name);
      if (!factory) throw new Error(`no tool ${name}`);
      return factory(ctx);
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

describe("flair#1940 — OpenClaw capture keeps the host run id as a host source (real Harper)", () => {
  beforeAll(async () => {
    harper = await startHarper();
    keyDir = await mkdtemp(join(tmpdir(), "flair-1940-openclaw-keys-"));
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

  async function findCaptured(c: FlairClient, marker: string) {
    const rows = await c.memory.list({ limit: 200 });
    return rows.find((m) => m.content.includes(marker));
  }

  test("t1: a capture reads back with hostSource {openclaw, run, <run id>} for its author, and the session id", async () => {
    const api = hostForCapture();
    const c = reader();
    const runId = `run-${randomUUID()}`;
    const sessionId = `sess-${randomUUID()}`;
    const marker = `openclaw-capture-${randomUUID()}`;

    await api._fire(
      "llm_output",
      { runId, sessionId, assistantTexts: [`remember this: the capture target is ${marker}`] },
      { agentId: AGENT },
    );

    const row = await findCaptured(c, marker);
    expect(row, `capture ${marker} must have landed`).toBeTruthy(); // assertion: the capture landed
    expect(row?.hostSource).toEqual({ v: 1, host: "openclaw", kind: "run", id: runId }); // assertion: the run id is the source
    expect(row?.sessionId).toBe(sessionId); // assertion: the host session id is carried
  }, 120_000);

  test("t2: a run id outside the id grammar captures without a source, and logs one line", async () => {
    const api = hostForCapture();
    const c = reader();
    const runId = "run id with spaces and \u0007control"; // outside ^[A-Za-z0-9._:/@#-]{1,256}$
    const marker = `openclaw-bad-id-${randomUUID()}`;

    await api._fire(
      "llm_output",
      { runId, assistantTexts: [`remember this: the capture target is ${marker}`] },
      { agentId: AGENT },
    );

    const row = await findCaptured(c, marker);
    expect(row, `capture ${marker} must still land`).toBeTruthy(); // assertion: capture never fails on a run id
    expect(row?.hostSource).toBeUndefined(); // assertion: no source was attached
    expect(api._warnText()).toContain("omitted its host source"); // assertion: one line names why
  }, 120_000);

  test("t3: a non-capture write carries no source", async () => {
    const api = hostForCapture();
    const c = reader();
    const marker = `openclaw-manual-${randomUUID()}`;

    const tool = api._tool("memory_store", { agentId: AGENT });
    const res = await tool.execute("1", { text: `remember this: the manual target is ${marker}` });
    expect(res.details.written).toBe(true); // assertion: the manual write landed

    const row = await findCaptured(c, marker);
    expect(row, `manual write ${marker} must have landed`).toBeTruthy(); // assertion: the manual write landed
    expect(row?.hostSource).toBeUndefined(); // assertion: a non-capture write carries no source
  }, 120_000);
});
