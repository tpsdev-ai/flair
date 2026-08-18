// flair#1257 — ephemeral memories are private-only, behavioural positive control.
//
// `ephemeral` is the continuity-journal tier (auto-captured working state,
// self-pruning). Its durability-keyed DEFAULT visibility is "private", but a
// default is not a constraint: before this guard, an explicit
// visibility:"shared" on an ephemeral write was accepted via the real REST
// surface, which would have made journal entries org-readable AND
// federation-pushed. Kern's #1257 ruling: the server must REFUSE the
// combination (400) so the boundary holds for every caller — not just the
// continuity hooks that promise to send "private".
//
// The unit lane (test/unit/visibility-write-validation.test.ts) pins the pure
// rule and trips if the guard is unwired. This file is the "prove it fires"
// control: the refusals below were mutation-checked by removing the two
// Memory.ts guard blocks — the POST and both PUT refusal tests then went red
// (writes succeeded), and went green again with the guard restored.
//
// Pattern: test/integration/durability-write-validation-e2e.test.ts (Ed25519
// signing helpers, admin-op seeding).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array; }

function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}

function ed25519Header(agent: TestAgent, method: string, path: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${agent.id}:${ts}:${nonce}:${method}:${path}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), agent.secretKey);
  return `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

async function authFetch(harper: HarperInstance, agent: TestAgent, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { Authorization: ed25519Header(agent, method, path) };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(`${harper.httpURL}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}

async function adminOp(harper: HarperInstance, op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
    body: JSON.stringify(op),
  });
}

async function seedAgent(harper: HarperInstance, agent: TestAgent): Promise<void> {
  const res = await adminOp(harper, {
    operation: "insert", database: "flair", table: "Agent",
    records: [{ id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() }],
  });
  expect(res.status).toBe(200);
}

/** Read a row's durability+visibility back through the admin surface, so the
 *  assertions below are about what was STORED, not what the response claimed. */
async function readStored(harper: HarperInstance, id: string): Promise<{ durability?: string; visibility?: string } | null> {
  const read = await adminOp(harper, {
    operation: "search_by_value", database: "flair", table: "Memory",
    search_attribute: "id", search_value: id, get_attributes: ["id", "durability", "visibility"],
  });
  expect(read.status).toBe(200);
  const rows = await read.json();
  const record = Array.isArray(rows) ? rows[0] : rows;
  return record ?? null;
}

let harper: HarperInstance;
const agent = mkAgent("eph-owner");

beforeAll(async () => {
  harper = await startHarper();
  await seedAgent(harper, agent);
}, 180_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
});

describe("ephemeral memories are private-only (flair#1257)", () => {
  test("POSITIVE CONTROL (a): POST ephemeral+shared is refused with 400, and nothing is stored", async () => {
    const id = `eph-shared-post-${randomUUID()}`;
    const res = await authFetch(harper, agent, "POST", "/Memory", {
      id,
      agentId: agent.id,
      content: "a continuity journal entry that must never go org-readable",
      durability: "ephemeral",
      visibility: "shared",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_visibility_for_durability");
    // Actor + state + remedy: the tier, the refused value, and both exits.
    expect(body.message).toContain("private-only");
    expect(body.message).toContain("shared");
    expect(body.message).toContain("Omit visibility");
    expect(body.message).toContain("1257");
    // The refusal must be a refusal — no row lands.
    expect(await readStored(harper, id)).toBeNull();
  }, 30_000);

  test("POSITIVE CONTROL (b): PUT flipping a stored ephemeral row to shared is refused — merged payload shape", async () => {
    // Create the row the way the continuity hook would: ephemeral, visibility
    // omitted, lands private via the durability-keyed default.
    const id = `eph-flip-merged-${randomUUID()}`;
    const post = await authFetch(harper, agent, "POST", "/Memory", {
      id, agentId: agent.id,
      content: "journal entry to be flipped, long enough for the safety scan",
      durability: "ephemeral",
    });
    expect(post.status).toBe(201);

    // memory_update-style flip: the merged {...existing, ...patch} payload
    // carries durability:"ephemeral" alongside the new visibility.
    const put = await authFetch(harper, agent, "PUT", `/Memory/${id}`, {
      id, agentId: agent.id,
      content: "journal entry to be flipped, long enough for the safety scan",
      durability: "ephemeral",
      visibility: "shared",
    });
    expect(put.status).toBe(400);
    const body = await put.json();
    expect(body.error).toBe("invalid_visibility_for_durability");

    // The stored row is untouched: still ephemeral, still private.
    const stored = await readStored(harper, id);
    expect(stored?.durability).toBe("ephemeral");
    expect(stored?.visibility).toBe("private");
  }, 30_000);

  test("POSITIVE CONTROL (b'): PUT flip with durability OMITTED still refuses — effective durability comes from the stored row", async () => {
    // The sharper case: `PUT /Memory/<id> {"visibility":"shared"}` names no
    // durability of its own. put() stamps no durability default, so the only
    // thing that can make this refuse is the guard consulting the pre-existing
    // row. A guard reading content.durability alone sails past this.
    const id = `eph-flip-partial-${randomUUID()}`;
    const post = await authFetch(harper, agent, "POST", "/Memory", {
      id, agentId: agent.id,
      content: "journal entry for the partial-put flip, long enough for the scan",
      durability: "ephemeral",
    });
    expect(post.status).toBe(201);

    const put = await authFetch(harper, agent, "PUT", `/Memory/${id}`, {
      id, agentId: agent.id,
      content: "journal entry for the partial-put flip, long enough for the scan",
      visibility: "shared",
    });
    expect(put.status).toBe(400);
    const body = await put.json();
    expect(body.error).toBe("invalid_visibility_for_durability");

    const stored = await readStored(harper, id);
    expect(stored?.durability).toBe("ephemeral");
    expect(stored?.visibility).toBe("private");
  }, 30_000);

  test("(c) ephemeral with visibility omitted lands 201 and STORED private — the durability-keyed default, unchanged", async () => {
    const id = `eph-default-${randomUUID()}`;
    const res = await authFetch(harper, agent, "POST", "/Memory", {
      id, agentId: agent.id,
      content: "hook-captured working state, visibility left to the default",
      durability: "ephemeral",
    });
    expect(res.status).toBe(201);
    const stored = await readStored(harper, id);
    expect(stored?.durability).toBe("ephemeral");
    expect(stored?.visibility).toBe("private");
  }, 30_000);

  test("(d) ephemeral with EXPLICIT private is accepted — the hook's belt-and-suspenders write shape", async () => {
    const id = `eph-explicit-private-${randomUUID()}`;
    const res = await authFetch(harper, agent, "POST", "/Memory", {
      id, agentId: agent.id,
      content: "hook-captured working state with explicit private visibility",
      durability: "ephemeral",
      visibility: "private",
    });
    expect(res.status).toBe(201);
    const stored = await readStored(harper, id);
    expect(stored?.visibility).toBe("private");
  }, 30_000);

  test("(e) no over-fire: standard+shared and persistent+shared still write", async () => {
    for (const durability of ["standard", "persistent"]) {
      const res = await authFetch(harper, agent, "POST", "/Memory", {
        id: `eph-nooverfire-${durability}-${randomUUID()}`,
        agentId: agent.id,
        content: `a ${durability} shared decision, long enough for the safety scan`,
        durability,
        visibility: "shared",
      });
      expect(res.status, `durability=${durability}+shared → ${res.status}`).toBe(201);
    }
  }, 30_000);

  test("(e') no over-fire on PUT: flipping a stored STANDARD row to shared still works", async () => {
    const id = `std-flip-${randomUUID()}`;
    const post = await authFetch(harper, agent, "POST", "/Memory", {
      id, agentId: agent.id,
      content: "a standard note that its owner later decides to share",
      durability: "standard",
    });
    expect(post.status).toBe(201);

    const put = await authFetch(harper, agent, "PUT", `/Memory/${id}`, {
      id, agentId: agent.id,
      content: "a standard note that its owner later decides to share",
      durability: "standard",
      visibility: "shared",
    });
    expect(put.status).toBe(200);
    const stored = await readStored(harper, id);
    expect(stored?.visibility).toBe("shared");
  }, 30_000);

  test("promotion OUT of ephemeral may share in the same write — the #1205 distillation shape", async () => {
    // Explicit durability on the write wins over the stored row's: lifting a
    // journal entry to persistent while sharing it is a promotion, not an
    // ephemeral share. This is the write shape REM distillation produces.
    const id = `eph-promote-${randomUUID()}`;
    const post = await authFetch(harper, agent, "POST", "/Memory", {
      id, agentId: agent.id,
      content: "a journal entry distillation deems worth keeping and sharing",
      durability: "ephemeral",
    });
    expect(post.status).toBe(201);

    const put = await authFetch(harper, agent, "PUT", `/Memory/${id}`, {
      id, agentId: agent.id,
      content: "a journal entry distillation deems worth keeping and sharing",
      durability: "persistent",
      visibility: "shared",
    });
    expect(put.status).toBe(200);
    const stored = await readStored(harper, id);
    expect(stored?.durability).toBe("persistent");
    expect(stored?.visibility).toBe("shared");
  }, 30_000);
});
