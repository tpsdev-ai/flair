// ADK per-tag distillation — cross-user-bleed acceptance test (#1205b-1).
//
// adk-flair collapses (app_name, user_id) → ONE Flair agentId, separating users
// ONLY by a per-user tag `adk:<app>:<user>`. The pre-#1205b nightly runner
// distilled per-agentId (scope:"recent"), so every user's sessions under that
// agentId distilled TOGETHER → cross-user bleed. This slice distills per TAG
// (scope:"tagged").
//
// WHAT THIS TEST PROVES END-TO-END, against a real HOME-isolated ephemeral
// Harper with the real Memory + ReflectMemories resources:
//
//   1. enumerateActiveAdkTags — the BOUNDED distinct-tag query actually works
//      against Harper (search_by_conditions on the indexed agentId + createdAt,
//      get_attributes:["tags"]) and returns the distinct active adk: tags. If
//      Harper rejected this shape, the runner would fail-soft to [] and the
//      whole fix would silently go inert (bleed persists) — so this is the
//      load-bearing de-risk of the enumeration seam.
//   2. The recency cutoff genuinely gates enumeration (idle tags skipped).
//   3. Owner scoping: enumeration returns only THIS agentId's tags, never
//      another agent's (no cross-agent user-enumeration oracle — Sherlock).
//   4. CROSS-USER-BLEED ACCEPTANCE: under scope:"tagged", the GATHERED memory
//      set for user A contains ONLY user-A memories (no B, no C). Because
//      execute-mode enforces every candidate's sourceMemoryIds ⊆ the gathered
//      set (generateCandidates → parseAndValidateCandidates "source_id_out_of_
//      set"), the gathered set is the CEILING on any candidate's sources — a
//      per-user gathered set makes a cross-user candidate physically
//      impossible. Proving isolation at the gather boundary IS proving no
//      candidate bleed, and does so deterministically without a live LLM
//      (execute-mode needs a models backend; the SELECTION that prevents bleed
//      runs before, and independently of, the model).
//   5. MUTATION CHECK: scope:"recent" (the agentId-only path the runner
//      REPLACES for ADK agents) gathers BOTH users together — the exact bleed.
//
// The scopeTag STAMP and its promotion consumption are unit-tested
// (test/unit/memory-reflect.test.ts buildStagedCandidateRow;
// test/unit/cli-rem-promote-reject.test.ts derivePromotedTags override) — the
// stamp is written only in execute-mode, which needs a models backend.

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
import { deriveActiveAdkTags, type ApiCall } from "../../src/rem/runner.ts";

interface TestAgent {
  id: string;
  publicKey: string;
  secretKey: Uint8Array;
}

function mkAgent(id: string): TestAgent {
  const kp = nacl.sign.keyPair();
  return { id, publicKey: Buffer.from(kp.publicKey).toString("base64"), secretKey: kp.secretKey };
}

function buildEd25519Auth(agent: TestAgent, method: string, path: string): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${agent.id}:${ts}:${nonce}:${method}:${path}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(payload), agent.secretKey);
  return `TPS-Ed25519 ${agent.id}:${ts}:${nonce}:${Buffer.from(sig).toString("base64")}`;
}

async function adminOp(harper: HarperInstance, op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
    },
    body: JSON.stringify(op),
  });
}

async function seedAgent(harper: HarperInstance, agent: TestAgent): Promise<void> {
  const res = await adminOp(harper, {
    operation: "insert",
    database: "flair",
    table: "Agent",
    records: [{ id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() }],
  });
  expect(res.status).toBe(200);
}

async function authFetch(harper: HarperInstance, agent: TestAgent, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { Authorization: buildEd25519Auth(agent, method, path) };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(`${harper.httpURL}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}

// A #1205b-1 runner ApiCall bound to an authenticated agent — the exact shape
// the nightly runner uses (agent-authed REST), so this exercises the real
// snapshot-fetch path the tag enumeration reuses.
function apiCallAs(harper: HarperInstance, agent: TestAgent): ApiCall {
  return async (method, path, body) => {
    const res = await authFetch(harper, agent, method, path, body);
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
    return text ? JSON.parse(text) : null;
  };
}

// Fetch the agent's own memories via the SAME GET the runner's snapshot step
// uses (`GET /Memory?agentId=<id>`) — the set deriveActiveAdkTags reduces over.
async function fetchOwnMemories(harper: HarperInstance, agent: TestAgent): Promise<any[]> {
  const raw = await apiCallAs(harper, agent)("GET", `/Memory?agentId=${encodeURIComponent(agent.id)}`);
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.results)) return raw.results;
  if (raw && Array.isArray(raw.items)) return raw.items;
  return [];
}

async function writeMemory(
  harper: HarperInstance,
  agent: TestAgent,
  id: string,
  tag: string,
  createdAt: string,
): Promise<void> {
  // Seed via the ops-API `insert` (admin), NOT the Memory resource PUT: a
  // direct table write skips the write-time embedding computation (no ~80MB
  // model download in this test) and honors an explicit past `createdAt` for
  // the recency-cutoff case. The reads under test still go through the real
  // Memory + ReflectMemories resources — only the fixture write is direct.
  // durability:"standard" + type:"session" mirrors adk-flair's session capture.
  const res = await adminOp(harper, {
    operation: "insert",
    database: "flair",
    table: "Memory",
    records: [{
      id,
      agentId: agent.id,
      content: `session episode ${id}`,
      tags: [tag],
      durability: "standard",
      visibility: "shared",
      type: "session",
      archived: false,
      createdAt,
      updatedAt: createdAt,
    }],
  });
  if (res.status !== 200) {
    throw new Error(`insert Memory ${id} failed ${res.status}: ${await res.text()}`);
  }
}

const APP = "myapp";
const TAG_ALICE = `adk:${APP}:alice`;
const TAG_BOB = `adk:${APP}:bob`;
const TAG_CAROL = `adk:${APP}:carol`;   // idle (old) — must be skipped by the recency gate
const TAG_EVE = `adk:${APP}:eve`;       // belongs to a DIFFERENT agent — owner-scope check

const appAgent = mkAgent("adk-app-agent-1205b");
const otherAgent = mkAgent("adk-other-agent-1205b");

const NOW = Date.now();
const RECENT_ISO = new Date(NOW - 5 * 60_000).toISOString();       // 5 min ago (active)
const OLD_ISO = new Date(NOW - 72 * 3600_000).toISOString();       // 72h ago (idle)
const CUTOFF_ISO = new Date(NOW - 48 * 3600_000).toISOString();    // enumeration window: last 48h

let harper: HarperInstance;

describe("ADK per-tag distillation — cross-user bleed (#1205b-1)", () => {
  beforeAll(async () => {
    harper = await startHarper();
    await seedAgent(harper, appAgent);
    await seedAgent(harper, otherAgent);

    // Two ACTIVE users under ONE agentId, separated only by tag.
    await writeMemory(harper, appAgent, "m-alice-1", TAG_ALICE, RECENT_ISO);
    await writeMemory(harper, appAgent, "m-alice-2", TAG_ALICE, RECENT_ISO);
    await writeMemory(harper, appAgent, "m-bob-1", TAG_BOB, RECENT_ISO);
    await writeMemory(harper, appAgent, "m-bob-2", TAG_BOB, RECENT_ISO);
    // An IDLE user (records older than the cutoff) — must be skipped.
    await writeMemory(harper, appAgent, "m-carol-1", TAG_CAROL, OLD_ISO);
    // A different agent's ACTIVE user — must NOT appear in appAgent's enumeration.
    await writeMemory(harper, otherAgent, "m-eve-1", TAG_EVE, RECENT_ISO);
  }, 180_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
  });

  test("enumeration: deriveActiveAdkTags over the real snapshot fetch returns the DISTINCT active adk tags", async () => {
    // GET /Memory?agentId=<id> is the runner's snapshot fetch; deriveActiveAdkTags
    // reduces over it. This proves the real fetch returns the tags+createdAt the
    // reduction needs (the seam that made a search_by_conditions query 405).
    const mems = await fetchOwnMemories(harper, appAgent);
    const tags = deriveActiveAdkTags(mems, new Date(Date.parse(CUTOFF_ISO)), appAgent.id);
    // alice + bob are active; carol is idle (before cutoff). The two-per-user
    // seed also proves distinctness (no dupes).
    expect(tags).toEqual([TAG_ALICE, TAG_BOB]);
  }, 30_000);

  test("recency cutoff gates enumeration: an idle tag is skipped, a wide window includes it", async () => {
    const mems = await fetchOwnMemories(harper, appAgent);
    const wide = new Date(NOW - 96 * 3600_000); // 96h — includes carol
    expect(deriveActiveAdkTags(mems, wide, appAgent.id)).toEqual([TAG_ALICE, TAG_BOB, TAG_CAROL]);
    // …the narrow (48h) window excludes carol.
    expect(deriveActiveAdkTags(mems, new Date(Date.parse(CUTOFF_ISO)), appAgent.id)).not.toContain(TAG_CAROL);
  }, 30_000);

  test("owner scoping: enumeration excludes another agent's tags even though the fetch is org-wide (no oracle)", async () => {
    // The snapshot fetch (GET /Memory?agentId=X) resolves through Memory's
    // open-within-org read scope and DOES return other agents' rows (eve's,
    // owned by otherAgent). deriveActiveAdkTags' per-record agentId filter is
    // what confines enumeration to appAgent's own users — this asserts eve's
    // tag never enters appAgent's enumeration.
    const mems = await fetchOwnMemories(harper, appAgent);
    // Prove the fetch really is org-wide (otherwise this test can't fail):
    expect(mems.some((m: any) => m.agentId === otherAgent.id)).toBe(true);
    const tags = deriveActiveAdkTags(mems, new Date(NOW - 96 * 3600_000), appAgent.id);
    expect(tags).not.toContain(TAG_EVE);
    expect(tags).toEqual([TAG_ALICE, TAG_BOB, TAG_CAROL]);
  }, 30_000);

  test("ACCEPTANCE — scope:tagged isolates each user: gathered set is per-user, NO cross-user bleed", async () => {
    // User A's tagged reflection gathers ONLY user-A memories.
    const aRes = await authFetch(harper, appAgent, "POST", "/ReflectMemories", {
      agentId: appAgent.id, scope: "tagged", tag: TAG_ALICE,
    });
    expect(aRes.status).toBe(200);
    const aBody: any = await aRes.json();
    const aIds = (aBody.memories ?? []).map((m: any) => m.id).sort();
    expect(aIds).toEqual(["m-alice-1", "m-alice-2"]);
    // every gathered memory carries alice's tag; NONE carries bob's/carol's.
    for (const m of aBody.memories) {
      expect(m.tags).toContain(TAG_ALICE);
      expect(m.tags).not.toContain(TAG_BOB);
      expect(m.tags).not.toContain(TAG_CAROL);
    }

    // User B's tagged reflection gathers ONLY user-B memories (symmetric).
    const bRes = await authFetch(harper, appAgent, "POST", "/ReflectMemories", {
      agentId: appAgent.id, scope: "tagged", tag: TAG_BOB,
    });
    expect(bRes.status).toBe(200);
    const bBody: any = await bRes.json();
    const bIds = (bBody.memories ?? []).map((m: any) => m.id).sort();
    expect(bIds).toEqual(["m-bob-1", "m-bob-2"]);
    for (const m of bBody.memories) {
      expect(m.tags).toContain(TAG_BOB);
      expect(m.tags).not.toContain(TAG_ALICE);
    }

    // The two gathered sets are DISJOINT — a candidate distilled from either is
    // physically confined to one user (sourceMemoryIds ⊆ its gathered set).
    expect(aIds.some((id: string) => bIds.includes(id))).toBe(false);
  }, 30_000);

  test("MUTATION — scope:recent (the agentId-only path) gathers BOTH users → the bleed the tagged path prevents", async () => {
    const res = await authFetch(harper, appAgent, "POST", "/ReflectMemories", {
      agentId: appAgent.id, scope: "recent", since: new Date(NOW - 24 * 3600_000).toISOString(),
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    const allTags = new Set<string>();
    for (const m of body.memories ?? []) for (const t of m.tags ?? []) allTags.add(t);
    // Both users are present in ONE gathered set — this is exactly what an
    // agentId-only distill feeds the LLM, so a candidate can cite across users.
    // (This is the pre-#1205b behavior the tag-aware runner replaces for ADK
    // agents; the acceptance test above proves the tagged path does NOT do
    // this.)
    expect(allTags.has(TAG_ALICE)).toBe(true);
    expect(allTags.has(TAG_BOB)).toBe(true);
    const ids = (body.memories ?? []).map((m: any) => m.id).sort();
    expect(ids).toEqual(["m-alice-1", "m-alice-2", "m-bob-1", "m-bob-2"]);
  }, 30_000);
});
