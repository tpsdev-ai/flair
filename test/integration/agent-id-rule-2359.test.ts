/**
 * agent-id-rule-2359.test.ts — flair#2359, against a REAL Harper.
 *
 * Every path that creates or renames an Agent applies the ONE shared agent-ID
 * rule and refuses a non-matching id with the named error before anything is
 * written. This file proves the resource REST paths (POST, PUT, PATCH on /Agent
 * and POST /AgentSeed) through the real component, and drives the real Agent
 * roster read through the doctor decision (describeAgentIdRuleFinding) after
 * seeding a stored non-conforming id.
 *
 * The CLI paths are covered by
 * test/unit-isolated/agent-add-invalid-id-2359.test.ts.
 *
 * Note on ids: Harper parses a path segment as `<id>.<property>`, so a dot in a
 * URL segment is not part of the id (`/Agent/bad.id` resolves to id `bad`). The
 * PUT/PATCH cases therefore use an over-long id, which the path parser keeps
 * whole. The collection POST case carries the id in the body.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
import { describeAgentIdRuleFinding } from "../../src/doctor-client.js";

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
  });
});

describe("flair#2359 — the doctor decision reports a seeded stored non-conforming id", () => {
  test("a stored Agent row outside the rule is reported by describeAgentIdRuleFinding", async () => {
    const now = new Date().toISOString();
    const seeded = "seed.bad.id";
    await ops({
      operation: "insert",
      table: "Agent",
      records: [{ id: seeded, name: seeded, role: "agent", status: "active", publicKey: "seeded-public-key", createdAt: now }],
    });
    expect((await rowIn("Agent", seeded))?.id).toBe(seeded);

    // The same "select all" roster read `flair doctor` uses.
    const roster = (await ops({
      operation: "search_by_conditions",
      schema: "flair",
      table: "Agent",
      operator: "and",
      conditions: [{ search_attribute: "createdAt", search_type: "greater_than", search_value: "1970-01-01" }],
      get_attributes: ["id"],
    })) as Array<{ id?: unknown }>;
    const finding = describeAgentIdRuleFinding(roster);
    expect(finding).not.toBeNull();
    expect(finding!.invalidIds).toContain(seeded);
  });
});
