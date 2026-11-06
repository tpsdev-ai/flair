// ─── flair#3002 — the other server-built OrgEvent rows answer 5xx ──────────
//
// The A2A message/send event and the agent-key-register event are built on the
// server: every caller-derived field is a string by the time it is assigned
// (cleanText, a template, or String()). Each is validated with the OrgEvent
// table's own validator before staging, so a forced invalid row answers the
// endpoint's server-error shape and commits nothing.
//
// Real, HOME-isolated Harper; the invalid rows come from the test-only writer
// hook (test/fixtures/org-event-write-fault-3002/probe.js).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { componentWithReplayProbe, type ProbeComponent, type ProbeFiles } from "../helpers/component-with-replay-probe";

const FAULT_PROBE: ProbeFiles = {
  source: join("test", "fixtures", "org-event-write-fault-3002", "probe.js"),
  target: join("dist", "resources", "zz-org-event-write-fault-3002.js"),
  out: "org-event-write-fault-3002", // unused: the probe writes no files
};

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array }
const mkAgent = (id: string): TestAgent => {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
};

const sfx = Date.now().toString(36);
const A2A = mkAgent(`fault-mutate-a2a-${sfx}`);
const KEY = mkAgent(`fault-mutate-agent-key-register-${sfx}`);
const PENDING_PUBLIC_KEY = "pending";

let harper: HarperInstance;
let installDir = "";
let composed: ProbeComponent | undefined;

function assertOwnInstance(h: HarperInstance): void {
  for (const url of [h.httpURL, h.opsURL]) {
    const u = new URL(url);
    expect(["127.0.0.1", "localhost"], url).toContain(u.hostname);
    expect(["9925", "9926"], `${url} must be this test's own Harper`).not.toContain(u.port);
  }
}
const basicAuth = () => "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);

function ed25519(who: TestAgent, method: string, path: string): string {
  const ts = String(Date.now());
  const nonce = randomUUID();
  const sig = nacl.sign.detached(new TextEncoder().encode(`${who.id}:${ts}:${nonce}:${method}:${path}`), who.secretKey);
  return `TPS-Ed25519 ${who.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

async function ops(operation: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basicAuth() },
    body: JSON.stringify(operation),
  });
  const text = await res.text();
  expect(res.status, `${operation.operation}: ${text.slice(0, 300)}`).toBe(200);
  return JSON.parse(text);
}

async function eventsByScope(agentId: string): Promise<any[]> {
  return ops({
    operation: "search_by_value", database: "flair", table: "OrgEvent",
    search_attribute: "scope", search_value: agentId, get_attributes: ["id", "kind"],
  });
}

async function eventsByRef(agentId: string): Promise<any[]> {
  return ops({
    operation: "search_by_value", database: "flair", table: "OrgEvent",
    search_attribute: "refId", search_value: agentId, get_attributes: ["id", "kind"],
  });
}

async function agentRow(id: string): Promise<any | null> {
  const rows = await ops({ operation: "search_by_id", database: "flair", table: "Agent", ids: [id], get_attributes: ["*"] });
  return rows[0] ?? null;
}

async function registrationsOf(agentId: string): Promise<any[]> {
  return ops({
    operation: "search_by_value", database: "flair", table: "AgentKeyRegistration",
    search_attribute: "agentId", search_value: agentId, get_attributes: ["id"],
  });
}

beforeAll(async () => {
  if (process.env.HARPER_HTTP_URL) throw new Error("requires an isolated Harper; unset HARPER_HTTP_URL");
  composed = componentWithReplayProbe({ probe: FAULT_PROBE });
  harper = await startHarper({ cwd: composed.dir, harperBinDir: composed.sourceRoot });
  installDir = harper.installDir;
  assertOwnInstance(harper);
  const now = new Date().toISOString();
  await ops({
    operation: "upsert", database: "flair", table: "Agent",
    records: [
      { id: A2A.id, name: A2A.id, role: "agent", publicKey: A2A.publicKey, createdAt: now },
      { id: KEY.id, name: KEY.id, role: "agent", publicKey: PENDING_PUBLIC_KEY, createdAt: now },
    ],
  });
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (installDir) await rm(installDir, { recursive: true, force: true, maxRetries: 4 });
  composed?.cleanup();
}, HARPER_STOP_BUDGET_MS);

describe("flair#3002 — an invalid server-built OrgEvent row answers 5xx and commits nothing", () => {
  test("an invalid A2A message event answers 500 and writes no event", async () => {
    const path = "/a2a";
    const res = await fetch(harper.httpURL + path, {
      method: "POST",
      headers: { Authorization: ed25519(A2A, "POST", path), "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "message/send",
        params: { agentId: A2A.id, message: { parts: [{ text: "hello" }] } },
      }),
    });
    const text = await res.text();
    expect(res.status, text.slice(0, 300)).toBe(500);
    expect(JSON.parse(text).error).toBe("org_event_row_invalid");
    expect(await eventsByScope(A2A.id), "no event may survive").toHaveLength(0);
  }, 120_000);

  test("an invalid key-registration event answers 503 and commits nothing", async () => {
    const kp = nacl.sign.keyPair();
    const publicKey = Buffer.from(kp.publicKey).toString("base64url");
    const before = await agentRow(KEY.id);
    const res = await fetch(`${harper.httpURL}/AgentKeyRegister`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basicAuth() },
      body: JSON.stringify({ agentId: KEY.id, publicKey }),
    });
    const text = await res.text();
    expect(res.status, text.slice(0, 300)).toBe(503);
    expect(JSON.parse(text).error).toBe("registration_unavailable");

    expect(await agentRow(KEY.id)).toEqual(before);
    expect(await registrationsOf(KEY.id), "no audit row may survive").toHaveLength(0);
    expect(await eventsByRef(KEY.id), "no event may survive").toHaveLength(0);
  }, 120_000);
});
