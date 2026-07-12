// bootstrap-collision-e2e.test.ts — real-Harper, real-embedding end-to-end
// coverage for MemoryBootstrap's "Others in the room" collision-surfacing
// block (flair#681, the attention-plane flagship — spec:
// flair#695 "Phase 2 — collision surfacing in
// bootstrap"). Builds on #676 (entity vocab + entities[] fields), #678
// (AttentionQuery's internal WorkspaceState read + Presence-via-resource
// pattern, reused here), and #550 (Memory semantic scoring during bootstrap,
// reused here for the semantic surface).
//
// Pattern: test/integration/bootstrap-teammate-findings-e2e.test.ts (Ed25519
// signing, real embeddings via the signed PUT /Memory write path) +
// test/integration/attention-query-e2e.test.ts (WorkspaceState/OrgEvent
// seeding via PUT, real Presence heartbeats, the cross-agent-boundary
// probes) + test/integration/presence-api.test.ts (simulating a STALE
// presence row via a direct ops-API insert — the only way to produce one
// without waiting out the real offline threshold).
//
// Coverage (the properties the issue's acceptance criteria name):
//   1. Entity overlap surfaces a fresh teammate's collision line.
//   2. A non-overlapping teammate's WorkspaceState never surfaces — no
//      leak of its summary/entities into the caller's bootstrap.
//   3. Freshness gate: an overlapping teammate with a STALE (offline)
//      presence record never surfaces, even though the entity match is
//      otherwise identical to the one that does.
//   4. Semantic surfacing (#550 reuse): a teammate with NO entity overlap
//      but a task-relevant Memory surfaces via the semantic path; a
//      teammate with an off-domain (weak) Memory never surfaces.
//   5. No collision at all → no "## Others in the room" header (same
//      "empty section renders nothing" convention as every other section).
//   6. The cross-agent boundary: the collision block's WorkspaceState read
//      never leaks beyond the intended surfaced view (no `metadata` blob,
//      no unrelated-entity summary) — verified against a REAL spawned
//      Harper — and a direct `GET /WorkspaceState/<id>` from the caller for
//      a teammate's row still 404s (the internal path is not a general
//      broadening of WorkspaceState's per-agent read model, mirroring
//      attention-query-e2e.test.ts's own dedicated proof of the same
//      boundary for #678).
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

async function adminOp(harper: HarperInstance, op: Record<string, any>): Promise<Response> {
  return fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
    body: JSON.stringify(op),
  });
}

async function registerAgent(harper: HarperInstance, agent: TestAgent, displayName?: string): Promise<void> {
  const res = await adminOp(harper, {
    operation: "insert", database: "flair", table: "Agent",
    records: [{
      id: agent.id, name: displayName ?? agent.id, displayName: displayName ?? agent.id,
      role: "agent", publicKey: agent.publicKey, status: "active", kind: "agent",
      createdAt: new Date().toISOString(),
    }],
  });
  expect(res.status, `Agent insert for ${agent.id} returned ${res.status}`).toBe(200);
}

async function putMemory(harper: HarperInstance, agent: TestAgent, id: string, body: Record<string, any>): Promise<void> {
  const path = `/Memory/${id}`;
  const res = await fetch(`${harper.httpURL}${path}`, {
    method: "PUT",
    headers: { Authorization: ed25519Header(agent, "PUT", path), "Content-Type": "application/json" },
    body: JSON.stringify({ id, ...body }),
  });
  if (![200, 204].includes(res.status)) {
    throw new Error(`seed PUT ${path} → ${res.status}: ${await res.text()}`);
  }
}

async function putWorkspaceState(harper: HarperInstance, agent: TestAgent, id: string, body: Record<string, any>): Promise<void> {
  const path = `/WorkspaceState/${id}`;
  const res = await fetch(`${harper.httpURL}${path}`, {
    method: "PUT",
    headers: { Authorization: ed25519Header(agent, "PUT", path), "Content-Type": "application/json" },
    body: JSON.stringify({
      id, agentId: agent.id, ref: id, provider: "test",
      timestamp: new Date().toISOString(), createdAt: new Date().toISOString(),
      ...body,
    }),
  });
  if (![200, 204].includes(res.status)) {
    throw new Error(`seed WorkspaceState PUT ${path} → ${res.status}: ${await res.text()}`);
  }
}

async function heartbeat(harper: HarperInstance, agent: TestAgent, body: Record<string, any> = {}): Promise<void> {
  const path = "/Presence";
  const res = await fetch(`${harper.httpURL}${path}`, {
    method: "POST",
    headers: { Authorization: ed25519Header(agent, "POST", path), "Content-Type": "application/json" },
    body: JSON.stringify({ activity: "coding", ...body }),
  });
  expect(res.status, `heartbeat for ${agent.id} → ${res.status}: ${await res.text()}`).toBe(200);
}

/** Insert a STALE presence row directly via the ops API — bypasses POST
 *  /Presence (which always stamps `now`), the only way to produce an
 *  offline-status row without waiting out the real threshold (same
 *  technique test/integration/presence-api.test.ts uses). */
async function insertStalePresence(harper: HarperInstance, agentId: string, staleMs: number): Promise<void> {
  const staleAt = Date.now() - staleMs;
  const res = await adminOp(harper, {
    operation: "insert", database: "flair", table: "Presence",
    records: [{ agentId, lastHeartbeatAt: staleAt, activityUpdatedAt: staleAt, activity: "idle" }],
  });
  expect(res.status).toBe(200);
}

async function bootstrap(harper: HarperInstance, agent: TestAgent, body: Record<string, any>): Promise<any> {
  const path = "/BootstrapMemories";
  const res = await fetch(`${harper.httpURL}${path}`, {
    method: "POST",
    headers: { Authorization: ed25519Header(agent, "POST", path), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  expect(res.status, `BootstrapMemories → ${res.status}: ${text.slice(0, 500)}`).toBe(200);
  return JSON.parse(text);
}

function extractSection(context: string, header: string): string {
  const marker = `## ${header}`;
  const idx = context.indexOf(marker);
  if (idx === -1) return "";
  const rest = context.slice(idx + marker.length);
  const nextIdx = rest.indexOf("\n## ");
  return nextIdx === -1 ? rest : rest.slice(0, nextIdx);
}

let harper: HarperInstance;

const RUN = randomUUID().slice(0, 8);
const caller = mkAgent(`col-e2e-caller-${RUN}`);
const teammateFresh = mkAgent(`col-e2e-fresh-${RUN}`);
const teammateNonOverlap = mkAgent(`col-e2e-nonoverlap-${RUN}`);
const teammateStale = mkAgent(`col-e2e-stale-${RUN}`);
const teammateSemantic = mkAgent(`col-e2e-semantic-${RUN}`);
const teammateSemanticWeak = mkAgent(`col-e2e-weak-${RUN}`);

// Vocabulary grammar (resources/entity-vocab.ts): the issue number must be a
// plain positive integer (no suffix) — uniqueness comes from a random
// numeric issue number instead of appending the run id to "681".
const ENTITY_NUM = 900_000_000 + Math.floor(Math.random() * 99_999_999);
const ENTITY = `issue:tpsdev-ai/flair#${ENTITY_NUM}`;
const OTHER_ENTITY = `subsystem:unrelated-${RUN}`;
const SECRET_METADATA = `super-secret-path-${RUN}-/Users/someone/.ssh/id_ed25519`;
const NONOVERLAP_SUMMARY = `totally unrelated workspace summary marker ${RUN}`;
const FRESH_SUMMARY = `implementing collision surfacing for the attention plane ${RUN}`;

const CURRENT_TASK = "Prepare talking points for the Acme Corp vendor contract renegotiation meeting this week.";
const SEMANTIC_CONTENT = `flair-681 marker: for the Acme Corp vendor contract renegotiation, legal flagged the indemnification clause as the first blocker to resolve (semantic fixture ${RUN}).`;
// NOTE (measured, not assumed): an e2e "weak match below the relevance
// floor" fixture was deliberately NOT built with real content. Empirically
// probed against this repo's actual embedding pipeline (nomic-embed-text
// Q4_K_M via getEmbedding — see resources/embeddings-provider.ts): dot-product
// scores against CURRENT_TASK for OFF-DOMAIN real-English text (weather,
// astronomy, cat facts, a code snippet, even the single word "banana") all
// landed between 0.35 and 0.51 — ALL above #550's score > 0.3 floor. This is
// the SAME known-loose-discrimination systemic issue already tracked
// separately (Flint's memory: project_flair_recall_quality_embeddings.md,
// "Q4-nomic systemic" / OPS-510) — not something to paper over with a
// deceptively-passing test, and not in scope to fix here (this PR reuses
// #550's floor exactly as shipped, per the spec's "no new embedding code"
// instruction). The reliable, honest e2e proof of "an irrelevant teammate
// never surfaces via the semantic path" instead uses a teammate with NO
// Memory record at all (teammateSemanticWeak, below) — no candidate is ever
// produced for it to begin with, independent of the floor's real-world
// discrimination quality.

describe("flair#681 — MemoryBootstrap 'Others in the room' collision surfacing (real Harper, real embeddings)", () => {
  beforeAll(async () => {
    harper = await startHarper();
    await registerAgent(harper, caller, "Caller");
    await registerAgent(harper, teammateFresh, "Fresh");
    await registerAgent(harper, teammateNonOverlap, "NonOverlap");
    await registerAgent(harper, teammateStale, "Stale");
    await registerAgent(harper, teammateSemantic, "Semantic");
    await registerAgent(harper, teammateSemanticWeak, "Weak");

    // Entity-overlap fixture: a teammate whose WorkspaceState carries the
    // SAME entity the caller will declare, plus a metadata blob that must
    // NEVER surface (the leak-boundary probe).
    await putWorkspaceState(harper, teammateFresh, `${teammateFresh.id}-ws`, {
      entities: [ENTITY], summary: FRESH_SUMMARY, taskId: "681",
      metadata: JSON.stringify({ secret: SECRET_METADATA }),
    });
    await heartbeat(harper, teammateFresh, { currentTask: `working on ${ENTITY}` });

    // Non-overlap fixture: different entity entirely — must never surface,
    // and its summary must never leak into the caller's bootstrap.
    await putWorkspaceState(harper, teammateNonOverlap, `${teammateNonOverlap.id}-ws`, {
      entities: [OTHER_ENTITY], summary: NONOVERLAP_SUMMARY, taskId: "999",
    });
    await heartbeat(harper, teammateNonOverlap, { currentTask: "working on something else entirely" });

    // Freshness-gate fixture: SAME overlapping entity as teammateFresh, but
    // its presence is stale (inserted directly, well past the offline
    // threshold) — must NOT surface despite the identical entity match.
    await putWorkspaceState(harper, teammateStale, `${teammateStale.id}-ws`, {
      entities: [ENTITY], summary: "stale collision candidate — must not surface", taskId: "681",
    });
    await insertStalePresence(harper, teammateStale.id, 20 * 3600_000); // 20h — well past the 10min default offline threshold

    // Semantic-only fixture: NO entity overlap at all, but a Memory whose
    // content is genuinely relevant to CURRENT_TASK (the #550 scored path,
    // reused as-is) — must surface via the semantic surface.
    await putMemory(harper, teammateSemantic, `${teammateSemantic.id}-mem`, {
      agentId: teammateSemantic.id, content: SEMANTIC_CONTENT, durability: "standard", visibility: "shared",
    });
    await heartbeat(harper, teammateSemantic, { currentTask: "reviewing vendor contracts" });

    // "Nothing relevant" fixture: fresh presence, NO entity overlap, and
    // deliberately NO Memory record at all — see the NOTE above CURRENT_TASK
    // for why this (rather than an off-domain-content fixture) is the
    // reliable e2e proof that an irrelevant teammate never surfaces via the
    // semantic path: no candidate is ever produced for it, full stop.
    await heartbeat(harper, teammateSemanticWeak, { currentTask: "baking bread" });
  }, 180_000);

  afterAll(async () => { if (harper) await stopHarper(harper); });

  test("entity overlap surfaces the fresh teammate; non-overlap and stale teammates do NOT; no metadata leak", async () => {
    // No currentTask on this call — isolates the entity-overlap surface from
    // #550's semantic surface entirely (no `scored` list is ever built
    // without one), so every assertion below is purely about the
    // entity/freshness join.
    const body = await bootstrap(harper, caller, {
      agentId: caller.id, maxTokens: 8000,
      entities: [ENTITY],
    });
    const context: string = body.context ?? "";
    const collisionSection = extractSection(context, "Others in the room");

    expect(collisionSection, `"Others in the room" section missing — full context:\n${context}`).not.toBe("");
    expect(body.sections?.collision, `sections — full response: ${JSON.stringify(body.sections)}`).toBeGreaterThanOrEqual(1);

    // The fresh, overlapping teammate surfaces, named by displayName, with
    // the entity and its summary.
    expect(collisionSection).toContain("Fresh");
    expect(collisionSection).toContain(ENTITY);
    expect(collisionSection).toContain(FRESH_SUMMARY);
    expect(collisionSection).toContain("last active");

    // The leak-boundary probe: the metadata JSON blob must NEVER appear
    // anywhere in the bootstrap response, in any section.
    expect(context, "WorkspaceState metadata blob leaked into bootstrap output").not.toContain(SECRET_METADATA);

    // The non-overlapping teammate's summary must never appear at all —
    // proving the entity-overlap join doesn't degrade into a general
    // cross-agent WorkspaceState browse.
    expect(context, "non-overlapping teammate's WorkspaceState summary leaked").not.toContain(NONOVERLAP_SUMMARY);
    expect(collisionSection).not.toContain("NonOverlap");

    // The freshness gate: the stale teammate has the IDENTICAL overlapping
    // entity but must not surface.
    expect(collisionSection, `stale teammate leaked despite the freshness gate:\n${collisionSection}`).not.toContain("Stale");
    expect(collisionSection).not.toContain("stale collision candidate");
  });

  test("semantic surfacing (#550 reuse): task-relevant teammate memory surfaces with no entity overlap; a teammate with no relevant memory does not", async () => {
    const body = await bootstrap(harper, caller, {
      agentId: caller.id, maxTokens: 8000, currentTask: CURRENT_TASK,
      // No `entities` declared — this call exercises the semantic-only path.
    });
    const context: string = body.context ?? "";
    const collisionSection = extractSection(context, "Others in the room");

    expect(collisionSection, `semantic collision missing — full context:\n${context}`).toContain("Semantic");
    expect(collisionSection).toContain("last active");

    // teammateSemanticWeak has fresh presence but NO Memory record at all —
    // no semantic candidate is ever produced for it, so it must never
    // surface (see the NOTE above CURRENT_TASK for why this, not an
    // off-domain-content fixture, is the reliable e2e proof here).
    expect(collisionSection, `an agent with no relevant memory surfaced anyway:\n${collisionSection}`).not.toContain("Weak");
  });

  test("no declared entities, no currentTask → no collisions, no 'Others in the room' header at all", async () => {
    const freshCaller = mkAgent(`col-e2e-plaincaller-${RUN}`);
    await registerAgent(harper, freshCaller, "PlainCaller");
    await heartbeat(harper, freshCaller);

    const body = await bootstrap(harper, freshCaller, { agentId: freshCaller.id, maxTokens: 4000 });
    const context: string = body.context ?? "";
    expect(context).not.toContain("Others in the room");
    expect(body.sections?.collision).toBe(0);
  });

  test("the internal WorkspaceState path is NOT a general broadening: a direct GET /WorkspaceState/<id> from the caller for a teammate's row still 404s", async () => {
    const wsId = `${teammateFresh.id}-ws`;
    const path = `/WorkspaceState/${encodeURIComponent(wsId)}`;
    const res = await fetch(`${harper.httpURL}${path}`, {
      method: "GET",
      headers: { Authorization: ed25519Header(caller, "GET", path) },
    });
    expect(res.status).toBe(404);
  });
});
