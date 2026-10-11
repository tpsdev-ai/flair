/**
 * cursor-wake-cli-launch-receipt-1940.test.ts — flair#1944 round 2, slice 2 of
 * flair#1940.
 *
 * The PRODUCTION CLI path, end to end and hermetic: `main()` from
 * packages/cursor-wake-runner/src/cli.ts — the shipped `cursor-flair-wake`
 * command — run against a real Harper and a LOCAL Cursor fixture. Nothing is
 * faked at the seam the runner ships: the REAL FlairClient (signed catchup read,
 * real memory write through `createMemoryReceiptStore`) and the real
 * `createCursorAgentClient` HTTP client. Every HTTP target is a loopback server
 * this file started; no external network.
 *
 * It seeds one directed OrgEvent, points CURSOR_API_BASE at a loopback fixture
 * that answers 201 with an agent id/url, runs `main(["--once"])`, and asserts the
 * launch receipt LANDED in Harper with its stable id and `hostSource`. A second
 * run drains nothing (the watermark advanced) and launches nothing.
 *
 * MUTATION (flair#1944 round 7): stop wiring the receipt path in `main` — e.g.
 * pass a bare `client` the runner cannot use (or, historically, drop the
 * `receipts:` argument). The live cycle then refuses (and would write no
 * receipt) — this file fails: no receipt is there.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { HarperInstance, startHarper, stopHarper } from "../helpers/harper-lifecycle";
import { FlairClient } from "../../packages/flair-client/src/client";
import { launchReceiptId, wakeAgentId } from "../../packages/cursor-wake-runner/src/index.ts";
import { main } from "../../packages/cursor-wake-runner/src/cli.ts";

interface TestAgent {
  id: string;
  publicKey: string;
  secretKey: Uint8Array;
}

function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}

let harper: HarperInstance;
let keyDir: string;
let cursor: Server;
let cursorBase: string;
const cursorCalls: Array<{ agentId?: string; authorization?: string }> = [];

function keyPathFor(agent: TestAgent): string {
  return join(keyDir, `${agent.id}.key`);
}

async function registerAgent(agent: TestAgent): Promise<void> {
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

async function clientFor(agent: TestAgent): Promise<FlairClient> {
  await registerAgent(agent);
  const keyPath = keyPathFor(agent);
  // loadPrivateKey() treats an exactly-32-byte file as a raw Ed25519 seed.
  await writeFile(keyPath, Buffer.from(agent.secretKey.slice(0, 32)));
  return new FlairClient({ agentId: agent.id, url: harper.httpURL, keyPath });
}

/** Seed one OrgEvent the runner's catchup feed will deliver (admin ops insert). */
async function seedEvent(record: Record<string, unknown>): Promise<void> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
    },
    body: JSON.stringify({ operation: "insert", database: "flair", table: "OrgEvent", records: [record] }),
  });
  expect(res.status, await res.text()).toBe(200);
}

/** Point the CLI env at this Harper and the loopback Cursor fixture; return a restore fn. */
function setCliEnv(agent: TestAgent): () => void {
  const saved = { ...process.env };
  process.env.FLAIR_AGENT_ID = agent.id;
  process.env.FLAIR_URL = harper.httpURL;
  process.env.FLAIR_KEY_PATH = keyPathFor(agent);
  process.env.CURSOR_API_KEY = "test-key";
  process.env.CURSOR_API_BASE = cursorBase;
  for (const key of [
    "CURSOR_ENV_NAME",
    "CURSOR_ENV_TYPE",
    "CURSOR_REPO_URL",
    "CURSOR_STARTING_REF",
    "CURSOR_AUTO_CREATE_PR",
    "FLAIR_CATCHUP_BACKFILL_MS",
  ]) {
    delete process.env[key];
  }
  return () => {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  };
}

describe("flair#1944 — the shipped CLI records a launch receipt (real Harper + local Cursor fixture)", () => {
  beforeAll(async () => {
    harper = await startHarper();
    keyDir = await mkdtemp(join(tmpdir(), "flair-1944-cli-keys-"));
    // Every HTTP target this test talks to is a loopback server we started.
    expect(new URL(harper.httpURL).hostname, "http target must be the ephemeral instance").toBe("127.0.0.1");
    expect(new URL(harper.opsURL).hostname, "ops target must be the ephemeral instance").toBe("127.0.0.1");
    cursor = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk.toString();
      });
      req.on("end", () => {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          // leave body empty; the fixture still answers 201
        }
        const agentId = typeof body.agentId === "string" ? body.agentId : undefined;
        cursorCalls.push({ agentId, authorization: req.headers.authorization });
        res.writeHead(201, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            agent: { id: agentId, url: `https://cursor.example/agents/${agentId}` },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => cursor.listen(0, "127.0.0.1", resolve));
    cursorBase = `http://127.0.0.1:${(cursor.address() as AddressInfo).port}`;
  }, 240_000);

  afterAll(async () => {
    if (cursor) await new Promise<void>((resolve) => cursor.close(() => resolve()));
    if (harper) await stopHarper(harper);
    if (keyDir) await rm(keyDir, { recursive: true, force: true, maxRetries: 4 });
  });

  test("`main([\"--once\"])` writes the receipt with its stable id and hostSource, then acks", async () => {
    const agent = mkAgent(`agent-cli-${randomUUID()}`);
    const client = await clientFor(agent);
    const eventId = `evt-${randomUUID()}`;
    await seedEvent({
      id: eventId,
      kind: "coord.dispatch",
      summary: "cli brief",
      detail: "https://github.com/example-org/example-repo/issues/7",
      targetIds: [agent.id],
      authorId: "agent-b",
      createdAt: new Date().toISOString(),
    });

    cursorCalls.length = 0;
    const restore = setCliEnv(agent);
    let code: number;
    try {
      code = await main(["--once"]);
    } finally {
      restore();
    }

    expect(code, "a created launch that stored its receipt exits 0").toBe(0);
    const requested = wakeAgentId(eventId);
    expect(cursorCalls.map((call) => call.agentId), "exactly one create, with the derived agentId").toEqual([requested]);
    expect(cursorCalls[0]?.authorization, "the Cursor client authenticates with the API key").toMatch(/^Basic /);

    const id = launchReceiptId(eventId);
    const got = await client.memory.get(id);
    expect(got, `the shipped CLI must have written the receipt ${id}`).toBeTruthy();
    expect(got?.content).toContain(eventId);
    expect(got?.content).toContain(requested);
    expect(got?.hostSource).toEqual({
      v: 1,
      host: "cursor",
      kind: "launch",
      id: requested,
      url: `https://cursor.example/agents/${requested}`,
    });

    // The watermark advanced past the event: a second run drains and launches nothing.
    cursorCalls.length = 0;
    const restore2 = setCliEnv(agent);
    let code2: number;
    try {
      code2 = await main(["--once"]);
    } finally {
      restore2();
    }
    expect(code2).toBe(0);
    expect(cursorCalls, "the acked event is not re-delivered").toEqual([]);
  }, 120_000);
});
