/**
 * bigint-intake-3005.test.ts — flair#3005, against a REAL Harper.
 *
 * Harper hands the process a BigInt for a JSON integer beyond
 * Number.MAX_SAFE_INTEGER. Three intakes that previously reached
 * `JSON.stringify` with that value and surfaced as the server's generic error
 * (A2A's outer catch answered -32000) now answer a caller error before any
 * write:
 *
 *   - POST /Agent/ with a body `id` — 400 invalid_agent_id with the string
 *     remedy key registration answers since #3003;
 *   - POST /AgentSeed with a body `agentId` — the same 400;
 *   - POST /a2a message/send with a BigInt anywhere in `message` — JSON-RPC
 *     -32602 naming `message`.
 *
 * Assertions per case: the Agent case checks the Agent row and the
 * key-registration audit row; the AgentSeed case checks the Agent, Soul and
 * Memory rows; both check OrgEvent. The A2A case checks the OrgEvent count.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { HARPER_STOP_BUDGET_MS, startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const UNSAFE_WIRE = "9007199254740993"; // Number.MAX_SAFE_INTEGER + 2
const UNSAFE_STRING = BigInt(UNSAFE_WIRE).toString();
const STRING_REMEDY = "send the agent id as a string";

const sfx = Date.now().toString(36);
const AGENT_MARKER = `bigint-intake-agent-${sfx}`;
const SEED_MARKER = `bigint-intake-seed-${sfx}`;
const A2A_ID = `bigint-intake-a2a-${sfx}`;

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array }
function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}
const A2A = mkAgent(A2A_ID);

let harper: HarperInstance;

function assertOwnInstance(h: HarperInstance): void {
  for (const u of [new URL(h.httpURL), new URL(h.opsURL)]) {
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (new URL(h.httpURL).port === new URL(h.opsURL).port || !h.process?.pid || !h.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${h.httpURL} / ${h.opsURL} is not an instance this test started`);
  }
}

const basic = () => "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);

async function ops(op: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basic() },
    body: JSON.stringify({ database: "flair", ...op }),
  });
  const text = await res.text();
  expect(res.status, `${op.operation}: ${text.slice(0, 300)}`).toBe(200);
  return text ? JSON.parse(text) : null;
}

async function rowsByValue(table: string, attribute: string, value: string): Promise<any[]> {
  const rows = await ops({
    operation: "search_by_value", table, search_attribute: attribute, search_value: value, get_attributes: ["*"],
  });
  return Array.isArray(rows) ? rows : [];
}

async function rowIn(table: string, id: string): Promise<any | null> {
  const rows = await ops({ operation: "search_by_id", table, ids: [id], get_attributes: ["*"] });
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

function ed25519(who: TestAgent, method: string, path: string): string {
  const ts = String(Date.now());
  const nonce = randomUUID();
  const sig = nacl.sign.detached(new TextEncoder().encode(`${who.id}:${ts}:${nonce}:${method}:${path}`), who.secretKey);
  return `TPS-Ed25519 ${who.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

function a2aRaw(messageJson: string): Promise<{ status: number; raw: string }> {
  return fetch(`${harper.httpURL}/a2a`, {
    method: "POST",
    headers: { Authorization: ed25519(A2A, "POST", "/a2a"), "Content-Type": "application/json" },
    body: `{"jsonrpc":"2.0","id":7,"method":"message/send","params":{"agentId":${JSON.stringify(A2A.id)},"message":${messageJson}}}`,
  }).then(async (res) => ({ status: res.status, raw: await res.text() }));
}

function a2a(message: unknown): Promise<{ status: number; raw: string }> {
  return a2aRaw(JSON.stringify(message));
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  harper = await startHarper();
  assertOwnInstance(harper);
  await ops({
    operation: "upsert", table: "Agent",
    records: [{ id: A2A.id, name: A2A.id, role: "agent", publicKey: A2A.publicKey, createdAt: new Date().toISOString() }],
  });
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
}, HARPER_STOP_BUDGET_MS);

describe("flair#3005 — a BigInt id answers a caller error", () => {
  test("POST /Agent/ with a BigInt body id answers 400 with the string remedy and stores nothing", async () => {
    const before = await rowIn("Agent", UNSAFE_STRING);
    expect(before, "the unsafe id must start absent").toBeNull();

    const res = await fetch(`${harper.httpURL}/Agent/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basic() },
      body: `{"id":${UNSAFE_WIRE},"name":${JSON.stringify(AGENT_MARKER)},"role":"agent","publicKey":"body-public-key","createdAt":${JSON.stringify(new Date().toISOString())}}`,
    });
    const raw = await res.text();
    expect(res.status, raw.slice(0, 300)).toBe(400);
    expect(JSON.parse(raw)).toEqual({ error: "invalid_agent_id", message: STRING_REMEDY });

    expect(await rowIn("Agent", UNSAFE_STRING)).toBeNull();
    expect(await rowsByValue("Agent", "name", AGENT_MARKER), "no Agent row may survive").toEqual([]);
    expect(await rowsByValue("AgentKeyRegistration", "agentId", UNSAFE_STRING), "no audit row may survive").toEqual([]);
    expect(await rowsByValue("OrgEvent", "refId", UNSAFE_STRING), "no event may survive").toEqual([]);
  }, 120_000);

  test("POST /AgentSeed with a BigInt agentId answers 400 with the string remedy and writes nothing", async () => {
    const res = await fetch(`${harper.httpURL}/AgentSeed`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basic() },
      body: `{"agentId":${UNSAFE_WIRE},"displayName":${JSON.stringify(SEED_MARKER)}}`,
    });
    const raw = await res.text();
    expect(res.status, raw.slice(0, 300)).toBe(400);
    expect(JSON.parse(raw)).toEqual({ error: "invalid_agent_id", message: STRING_REMEDY });

    expect(await rowIn("Agent", UNSAFE_STRING), "no Agent row may survive").toBeNull();
    expect(await rowsByValue("Soul", "agentId", UNSAFE_STRING), "no Soul row may survive").toEqual([]);
    expect(await rowsByValue("Memory", "agentId", UNSAFE_STRING), "no Memory row may survive").toEqual([]);
    expect(await rowsByValue("OrgEvent", "refId", UNSAFE_STRING), "no event may survive").toEqual([]);
  }, 120_000);

  test("POST /a2a message/send with a nested BigInt in message answers -32602 naming the field and writes no event", async () => {
    // Positive control: a plain message lands its event, so the absence below
    // is measured against a live A2A write path.
    const control = await a2a({ parts: [{ text: "control message" }] });
    expect(control.status, control.raw.slice(0, 300)).toBe(200);
    const eventsBefore = await rowsByValue("OrgEvent", "scope", A2A.id);
    expect(eventsBefore.length, "the control event must land").toBeGreaterThan(0);

    // The nested integer arrives as a BigInt: Harper parses it exactly.
    const res = await a2aRaw(`{"parts":[{"text":"big integer"}],"metadata":{"sequence":${UNSAFE_WIRE}}}`);
    const raw = res.raw;
    expect(res.status, raw.slice(0, 300)).toBe(200);
    const body = JSON.parse(raw);
    expect(body.error?.code, JSON.stringify(body)).toBe(-32602);
    expect(body.error?.message, JSON.stringify(body)).toContain("message");
    expect(body.error?.data).toEqual({ field: "message" });

    const eventsAfter = await rowsByValue("OrgEvent", "scope", A2A.id);
    expect(eventsAfter, "no A2A event may be written for the refused message").toHaveLength(eventsBefore.length);
  }, 120_000);
});
