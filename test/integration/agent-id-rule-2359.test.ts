/**
 * agent-id-rule-2359.test.ts — flair#2359, against a REAL Harper.
 *
 * The Agent resource's REST write paths and the federation merge apply the ONE
 * shared agent-ID rule before anything is written. This file proves the resource
 * REST paths (POST/PUT/PATCH on /Agent and POST /AgentSeed), that a collection
 * POST with no id stores a Harper-generated id the rule accepts, an explicit
 * `id: null` on the collection POST, the doctor roster read (readAgentRoster)
 * with a row outside any created-at filter, and the federation merge
 * (FederationSync) skipping a malformed inbound Agent row.
 *
 * The CLI write paths (`flair agent add`, `flair principal add`, `flair mcp
 * enable`) are exercised elsewhere: test/unit-isolated/agent-add-invalid-id-2359.test.ts,
 * test/unit-isolated/principal-add-invalid-id-2359.test.ts and
 * test/unit/mcp-enable-idp-principal-2359.test.ts.
 *
 * Note on ids: Harper parses a path segment as `<id>.<property>`, so a dot in a
 * URL segment is not part of the id (`/Agent/bad.id` resolves to id `bad`). The
 * PUT/PATCH cases therefore use an over-long id, which the path parser keeps
 * whole. The collection POST cases carry the id in the body.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { tmpdir } from "node:os";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
import { signBodyFresh } from "../../resources/federation-crypto.js";
import { describeAgentIdRuleFinding } from "../../src/doctor-client.js";
import { readAgentRoster } from "../../src/lib/agent-roster.js";

const OUT_OF_RULE_BODY = "bad.id"; // a dot is not in [A-Za-z0-9_-]
const OUT_OF_RULE_PATH = "a".repeat(65); // one over the 64-character limit

let harper: HarperInstance;
const basic = () => "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);

/** Refuse to talk to anything but this test's own ephemeral instance. */
function assertOwnInstance(h: HarperInstance): void {
  const http = new URL(h.httpURL);
  const ops = new URL(h.opsURL);
  for (const u of [http, ops]) {
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || port === 9925 || port === 9926) {
      throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (http.port === ops.port || !h.process?.pid || !h.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${h.httpURL} / ${h.opsURL} is not an instance this test started`);
  }
}

async function send(method: string, path: string, body: unknown): Promise<{ status: number; raw: string }> {
  const res = await fetch(`${harper.httpURL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: basic() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, raw: (await res.text()).slice(0, 600) };
}

async function ops(op: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: basic() },
    body: JSON.stringify({ database: "flair", ...op }),
  });
  const text = await res.text();
  expect(res.status, `${op.operation} returned ${res.status}: ${text.slice(0, 300)}`).toBeLessThan(300);
  return text.length ? JSON.parse(text) : null;
}

async function rowIn(table: string, id: string): Promise<any | null> {
  const rows = await ops({ operation: "search_by_id", table, ids: [id], get_attributes: ["*"] });
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

/** The doctor's own roster read, run against this instance. */
async function roster(): Promise<Array<{ id?: unknown }>> {
  const rows = await readAgentRoster({ opsUrl: harper.opsURL, authHeader: basic() });
  expect(rows, "the doctor roster read failed against the live instance").not.toBeNull();
  return rows!;
}

beforeAll(async () => {
  harper = await startHarper();
  assertOwnInstance(harper);
}, 180_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
}, 30_000);

describe("flair#2359 — the Agent REST write paths refuse an out-of-rule id on a real Harper", () => {
  test("POST /Agent/ with an out-of-rule id is refused 400 (invalid_agent_id) and stores no row", async () => {
    const now = new Date().toISOString();
    const r = await send("POST", "/Agent/", {
      id: OUT_OF_RULE_BODY,
      name: OUT_OF_RULE_BODY,
      role: "agent",
      publicKey: "body-public-key",
      createdAt: now,
    });
    expect(r.status, r.raw).toBe(400);
    expect(JSON.parse(r.raw).error).toBe("invalid_agent_id");
    expect(await rowIn("Agent", OUT_OF_RULE_BODY)).toBeNull();
  });

  test("POST /Agent/ with an explicit null id is refused 400 (invalid_agent_id) and stores no row", async () => {
    const before = await roster();
    const r = await send("POST", "/Agent/", {
      id: null,
      name: "NullId",
      role: "agent",
      publicKey: "body-public-key",
      createdAt: new Date().toISOString(),
    });
    expect(r.status, r.raw).toBe(400);
    expect(JSON.parse(r.raw).error).toBe("invalid_agent_id");
    expect((await roster()).length, "a supplied null id stored a row").toBe(before.length);
    expect(await rowIn("Agent", "null")).toBeNull();
  });

  test("PUT /Agent/<out-of-rule> is refused 400 (invalid_agent_id) and stores no row", async () => {
    const now = new Date().toISOString();
    const r = await send("PUT", `/Agent/${OUT_OF_RULE_PATH}`, { name: "Bad", publicKey: "body-public-key", createdAt: now });
    expect(r.status, r.raw).toBe(400);
    expect(JSON.parse(r.raw).error).toBe("invalid_agent_id");
    expect(await rowIn("Agent", OUT_OF_RULE_PATH)).toBeNull();
  });

  test("PATCH /Agent/<out-of-rule> is refused 400 (invalid_agent_id) and stores no row", async () => {
    const r = await send("PATCH", `/Agent/${OUT_OF_RULE_PATH}`, { displayName: "Bad" });
    expect(r.status, r.raw).toBe(400);
    expect(JSON.parse(r.raw).error).toBe("invalid_agent_id");
    expect(await rowIn("Agent", OUT_OF_RULE_PATH)).toBeNull();
  });

  test("POST /AgentSeed with an out-of-rule agentId is refused 400 and writes no Agent/Soul row", async () => {
    const r = await send("POST", "/AgentSeed", { agentId: OUT_OF_RULE_BODY, displayName: "Bad" });
    expect(r.status, r.raw).toBe(400);
    expect(JSON.parse(r.raw).error).toBe("invalid_agent_id");
    expect(await rowIn("Agent", OUT_OF_RULE_BODY)).toBeNull();
    const souls = await ops({ operation: "search_by_value", table: "Soul", search_attribute: "agentId", search_value: OUT_OF_RULE_BODY, get_attributes: ["*"] });
    expect(souls).toEqual([]);

    // An absent id is refused by the SAME rule, with the SAME named error.
    const nul = await send("POST", "/AgentSeed", { agentId: null, displayName: "Bad" });
    expect(nul.status, nul.raw).toBe(400);
    expect(JSON.parse(nul.raw).error).toBe("invalid_agent_id");
  });

  test("POST /Agent/ with no id stores a Harper-generated id that matches the rule", async () => {
    const res = await fetch(`${harper.httpURL}/Agent/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basic() },
      body: JSON.stringify({ name: "generated-id-2359", role: "agent", publicKey: "body-public-key" }),
    });
    const raw = await res.text();
    expect(res.status, `POST /Agent/ returned ${res.status}: ${raw.slice(0, 300)}`).toBeLessThan(300);
    // Harper's collection POST answers with the generated id.
    const generated = JSON.parse(raw);
    expect(typeof generated, raw).toBe("string");
    expect(generated, `generated id '${generated}' is outside the rule`).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect((await rowIn("Agent", String(generated)))?.id).toBe(String(generated));
  });
});

describe("flair#2359 — the doctor roster read reports a stored id outside the rule", () => {
  test("a stored Agent row whose createdAt is below the old filter is still reported", async () => {
    const seeded = "outside.filter.bad"; // a dot is not in the rule
    // createdAt "1969-12-31T00:00:00.000Z" sorts BELOW "1970-01-01", so the old
    // `createdAt > "1970-01-01"` search would have excluded this row entirely.
    await ops({
      operation: "insert",
      table: "Agent",
      records: [{ id: seeded, name: seeded, role: "agent", status: "active", publicKey: "seeded-public-key", createdAt: "1969-12-31T00:00:00.000Z" }],
    });
    expect((await rowIn("Agent", seeded))?.id).toBe(seeded);

    // The doctor's own complete roster read.
    const rows = await roster();
    expect(rows.map((r) => r.id)).toContain(seeded);
    const finding = describeAgentIdRuleFinding(rows);
    expect(finding).not.toBeNull();
    expect(finding!.invalidIds).toContain(seeded);
  });
});

describe("flair#2359 — the federation merge skips a malformed inbound Agent row", () => {
  const sfx = Date.now().toString(36);
  const HUB = `fed-hub-${sfx}`;
  const VALID = `fed-valid-${sfx}`;
  const INVALID = `fed.bad.${sfx}`; // a dot is not in the rule
  const hub = nacl.sign.keyPair();
  const now = () => new Date().toISOString();

  test("a signed mixed batch lands the valid row, skips the invalid one, and names the skip", async () => {
    await ops({
      operation: "insert",
      table: "Peer",
      records: [{ id: HUB, publicKey: Buffer.from(hub.publicKey).toString("base64url"), role: "hub", status: "active", createdAt: now() }],
    });

    const ts = now();
    const records = [
      { table: "Agent", id: VALID, updatedAt: ts, originatorInstanceId: HUB, data: { id: VALID, name: VALID, role: "agent", status: "active", publicKey: "hub-public-key", createdAt: ts } },
      { table: "Agent", id: INVALID, updatedAt: ts, originatorInstanceId: HUB, data: { id: INVALID, name: INVALID, role: "agent", status: "active", publicKey: "hub-public-key", createdAt: ts } },
    ];
    const body = signBodyFresh({ instanceId: HUB, records, lamportClock: Date.now() }, hub.secretKey);

    const res = await fetch(`${harper.httpURL}/FederationSync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    expect(res.status, `FederationSync returned ${res.status}: ${raw.slice(0, 300)}`).toBe(200);
    const out = JSON.parse(raw);
    expect(out.merged, JSON.stringify(out)).toBe(1);
    expect(out.skippedReasons?.invalid_agent_id, JSON.stringify(out)).toBe(1);
    expect((await rowIn("Agent", VALID))?.id, "the valid row did not land").toBe(VALID);
    expect(await rowIn("Agent", INVALID), "the malformed row landed").toBeNull();
  }, 30_000);
});
