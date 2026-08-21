// Continuity REM promotion — end-to-end acceptance test (flair#1257 slice 3).
//
// Against a real HOME-isolated ephemeral Harper running the real Memory +
// ReflectMemories + AutoPromoteCandidates resources, WITH a real (stub)
// generative backend registered through Harper's own models bootstrap
// (test/fixtures/stub-generative-backend.mjs via harper-lifecycle's
// appendRootConfigYaml) — so execute-mode distillation runs the REAL resource
// wiring end-to-end (gather → generate → validate → stale-intent filter →
// visibility stamp → stage → auto-promote), deterministically. This closes
// the seam the #1205b suites documented ("execute-mode needs a models
// backend"): the slice-3 guards LIVE in that execute path, so leaving it
// untested would leave every one of them a check that cannot fire.
//
// What this file proves, per the slice-3 spec + K&S mail rulings:
//
//   META ROUND-TRIP (Kern's slice-2 ruling, settled here): a journal row
//     written via the REAL capture-path shape (buildJournalRow → PUT
//     /Memory/<id>, exactly what flair-continuity-capture sends) persists its
//     undeclared `meta` {seq, processUUID, sessionId, hook} through Harper,
//     read back BY ID and VIA SEARCH (the resume path's
//     /Memory/search_by_conditions shape). Also: the PUT path stamps the
//     ephemeral TTL (the put()-path expiresAt fix this slice ships — without
//     it hook-written rows never expired at all).
//   GATHER BOUNDARY: a continuity tagged run gathers exactly its own
//     session's LIVE rows — other sessions excluded, TTL-expired rows
//     excluded even before the reap, and journal rows NEVER ride a
//     scope:"recent" gather (the containment that keeps the settle window
//     able to fire).
//   STALE-INTENT GUARD (Kern, two-layer — the testable layer): a stale
//     session's in-flight-intent candidate is dropped by the post-filter in
//     the REAL execute path; its DECISION-class candidate still stages (the
//     positive control). A fresh session's in-flight candidate stages.
//   DEFAULT-PRIVATE-UNLESS (Sherlock): a promoted row's visibility defaults
//     private; "shared" happens ONLY for a candidate carrying the distiller's
//     affirmative ruling + recorded team-relevance justification. Mutation:
//     flip decidePromotedVisibility's default to "shared" → the private
//     assertions here go red.
//   PROMOTION CONTRACT (scenario 5): promotion writes a NEW persistent row
//     (fresh id), derivedFrom = the journal source ids, scopeTag preserved as
//     the first tag — and NEVER mutates the ephemeral originals (durability/
//     visibility/content/expiresAt all unchanged). Mutation: make the
//     promotion write over a source id → red.
//   derivedFrom-404 (#1264 posture, Sherlock's proviso): a teammate's by-id
//     GET on a derivedFrom id returns 404, indistinguishable from a missing
//     id; the owner still reads 200. The dangling ids are audit trail, not a
//     read path.

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
import {
  buildJournalRow,
  continuityTag,
  discoverResume,
  type SessionState,
  type SessionPointer,
  type CapturePlan,
  type ContinuityClient,
} from "../../packages/flair-mcp/src/continuity.ts";
import { MACHINE_REVIEWER_ADK_AUTO_PROMOTE } from "../../resources/auto-promote-lib.ts";

interface TestAgent { id: string; publicKey: string; secretKey: Uint8Array; }

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
    operation: "insert", database: "flair", table: "Agent",
    records: [{ id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() }],
  });
  expect(res.status).toBe(200);
}

async function authFetch(harper: HarperInstance, agent: TestAgent, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { Authorization: buildEd25519Auth(agent, method, path) };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(`${harper.httpURL}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}

async function authJSON(harper: HarperInstance, agent: TestAgent, method: string, path: string, body?: unknown): Promise<any> {
  const res = await authFetch(harper, agent, method, path, body);
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

function asRows(raw: any): any[] {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.results)) return raw.results;
  if (raw && Array.isArray(raw.items)) return raw.items;
  return [];
}

async function ownMemories(harper: HarperInstance, agent: TestAgent): Promise<any[]> {
  return asRows(await authJSON(harper, agent, "GET", `/Memory?agentId=${encodeURIComponent(agent.id)}`));
}

// ── stub generative backend plumbing ─────────────────────────────────────────
// The stub returns the CURRENT contents of responseFile on every generate()
// call; each distill test writes the candidate JSON it wants "the model" to
// produce just before calling /ReflectMemories.
const stubDir = mkdtempSync(join(tmpdir(), "flair-1257-stub-"));
const responseFile = join(stubDir, "generate-response.json");
const stubBackendPath = resolve(process.cwd(), "test/fixtures/stub-generative-backend.mjs");

function setModelResponse(candidates: unknown[]): void {
  writeFileSync(responseFile, JSON.stringify({ candidates }));
}

// ── fixture sessions ─────────────────────────────────────────────────────────
const owner = mkAgent("flint-1257-slice3");
const teammate = mkAgent("teammate-1257-slice3");

const SESS_META = "metasess-1";
const SESS_FRESH = "fresh-1";
const SESS_STALE = "stale-1";
const TAG_META = continuityTag(SESS_META);
const TAG_FRESH = continuityTag(SESS_FRESH);
const TAG_STALE = continuityTag(SESS_STALE);

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);

function journalState(sessionId: string, seq: number): SessionState {
  return {
    sessionId,
    processUUID: `proc-${sessionId}`,
    seq,
    agentId: owner.id,
    harnessSessionId: "harness-test",
    updatedAt: new Date().toISOString(),
  };
}

/** Write one journal row via the REAL capture-path shape: buildJournalRow
 *  (the exact row flair-continuity-capture builds) → PUT /Memory/<id> (the
 *  exact verb it sends). Returns the row as sent. */
async function writeJournalRow(
  harper: HarperInstance,
  sessionId: string,
  seq: number,
  content: string,
  at: Date,
  overrides: Record<string, unknown> = {},
): Promise<any> {
  const plan: CapturePlan = { hook: "Stop", content };
  const row: any = { ...buildJournalRow(owner.id, journalState(sessionId, seq), plan, at), ...overrides };
  const res = await authFetch(harper, owner, "PUT", `/Memory/${encodeURIComponent(row.id)}`, row);
  if (!res.ok) throw new Error(`journal PUT ${row.id} → ${res.status}: ${await res.text()}`);
  return row;
}

let harper: HarperInstance;
let metaRow: any;            // SESS_META's single row (meta round-trip subject)
let freshRows: any[] = [];   // SESS_FRESH's live rows
let expiredFreshRow: any;    // SESS_FRESH row with a PAST expiresAt (must never be gathered)
let staleRows: any[] = [];   // SESS_STALE's rows (createdAt 4 days ago)
let freshReflect: any;       // execute-mode response for the fresh session
let staleReflect: any;       // execute-mode response for the stale session
let sweep: any;              // /AutoPromoteCandidates response

const CLAIM_PRIV = "Decided: continuity distills ride scope:tagged so the #1205 engine is reused unchanged.";
const CLAIM_SHARED = "Decided: the fleet gate now requires both K and S approvals on the current head before merge.";
const CLAIM_INFLIGHT_FRESH = "About to merge flair#1290 once CI settles; waiting on the coverage lane.";
const CLAIM_STALE_DECISION = "Decided: the settle window is measured on the newest journal entry, not the oldest.";
const CLAIM_STALE_INFLIGHT = "About to redeploy the hub; waiting on the backup to finish.";
const SHARED_JUSTIFICATION = "The whole team gates merges on this decision; teammates need it to act.";

describe("continuity REM promotion (flair#1257 slice 3)", () => {
  beforeAll(async () => {
    setModelResponse([]); // exists before Harper boots; rewritten per distill
    harper = await startHarper({
      appendRootConfigYaml: [
        "models:",
        "  generative:",
        "    default:",
        `      backend: ${stubBackendPath}`,
        `      responseFile: ${responseFile}`,
      ].join("\n"),
    });
    await seedAgent(harper, owner);
    await seedAgent(harper, teammate);

    // ── seed the three sessions via the REAL capture path ────────────────────
    metaRow = await writeJournalRow(harper, SESS_META, 1, "stop: verifying meta round-trip", new Date());

    freshRows = [
      await writeJournalRow(harper, SESS_FRESH, 1, "stop: reviewing the slice-3 spec", hoursAgo(3.2)),
      await writeJournalRow(harper, SESS_FRESH, 2, "stop: decided to reuse the #1205 engine", hoursAgo(3.1)),
      await writeJournalRow(harper, SESS_FRESH, 3, "stop: about to merge flair#1290, waiting on CI", hoursAgo(3)),
    ];
    // A TTL-expired row in the SAME session — must never reach a gather
    // (explicit past expiresAt wins over the server stamp).
    expiredFreshRow = await writeJournalRow(harper, SESS_FRESH, 4, "stop: this entry has expired", hoursAgo(3), {
      expiresAt: hoursAgo(1).toISOString(),
    });

    staleRows = [
      await writeJournalRow(harper, SESS_STALE, 1, "stop: decided the settle window shape", hoursAgo(96.2)),
      await writeJournalRow(harper, SESS_STALE, 2, "stop: about to redeploy the hub", hoursAgo(96)),
    ];

    // ── distill the FRESH session (execute mode, real backend path) ──────────
    setModelResponse([
      { claim: CLAIM_PRIV, sourceMemoryIds: [freshRows[1].id] },
      { claim: CLAIM_SHARED, sourceMemoryIds: [freshRows[1].id], visibility: "shared", teamRelevance: SHARED_JUSTIFICATION },
      { claim: CLAIM_INFLIGHT_FRESH, sourceMemoryIds: [freshRows[2].id] },
    ]);
    freshReflect = await authJSON(harper, owner, "POST", "/ReflectMemories", {
      agentId: owner.id, execute: true, scope: "tagged", tag: TAG_FRESH, focus: "continuity",
    });

    // ── distill the STALE session ────────────────────────────────────────────
    setModelResponse([
      { claim: CLAIM_STALE_DECISION, sourceMemoryIds: [staleRows[0].id] },
      { claim: CLAIM_STALE_INFLIGHT, sourceMemoryIds: [staleRows[1].id] },
    ]);
    staleReflect = await authJSON(harper, owner, "POST", "/ReflectMemories", {
      agentId: owner.id, execute: true, scope: "tagged", tag: TAG_STALE, focus: "continuity",
    });

    // ── the unattended promotion sweep ───────────────────────────────────────
    sweep = await authJSON(harper, owner, "POST", "/AutoPromoteCandidates", { agentId: owner.id });
  }, 300_000);

  afterAll(async () => {
    if (harper) await stopHarper(harper);
    rmSync(stubDir, { recursive: true, force: true });
  });

  // ── META ROUND-TRIP ────────────────────────────────────────────────────────

  test("META ROUND-TRIP by id: the real capture-path write persists meta {seq, processUUID, sessionId, hook}", async () => {
    const stored = await authJSON(harper, owner, "GET", `/Memory/${encodeURIComponent(metaRow.id)}`);
    expect(stored.meta).toBeTruthy();
    expect(stored.meta.seq).toBe(1);
    expect(stored.meta.processUUID).toBe(`proc-${SESS_META}`);
    expect(stored.meta.sessionId).toBe(SESS_META);
    expect(stored.meta.hook).toBe("Stop");
    expect(stored.durability).toBe("ephemeral");
    expect(stored.visibility).toBe("private");
    expect(stored.tags).toEqual([TAG_META]);
  }, 30_000);

  test("META ROUND-TRIP via search: the REAL resume read (discoverResume) returns meta-derived entries against real Harper", async () => {
    // This runs the ACTUAL slice-2 resume function over a real client bound
    // to this Harper — the path the SessionStart hook takes. It doubles as
    // the fix-proof for the dead resume read this slice found: the original
    // POST /Memory/search_by_conditions 405s here (no REST handler for the
    // ops-API operation; verified: `The Memory does not have a post method
    // implemented`), and discoverResume's fail-open turned that into a
    // permanently-empty journal. The seq/processUUID/sessionId assertions
    // below only pass if the row's undeclared `meta` survived storage —
    // toEntry() reads them from meta.
    const client: ContinuityClient = {
      request: (method, path, body) => authJSON(harper, owner, method, path, body),
    };
    const pointer: SessionPointer = {
      sessionId: SESS_META,
      processUUID: `proc-${SESS_META}`,
      updatedAt: new Date().toISOString(),
    };
    const result = await discoverResume(client, owner.id, pointer);
    expect(result.sessionId).toBe(SESS_META);
    expect(result.entries.length).toBe(1);
    expect(result.entries[0].id).toBe(metaRow.id);
    expect(result.entries[0].seq).toBe(1);
    expect(result.entries[0].processUUID).toBe(`proc-${SESS_META}`);
    expect(result.entries[0].sessionId).toBe(SESS_META);
  }, 30_000);

  test("PUT-path TTL: the capture verb stamps expiresAt on ephemeral rows (the slice-3 put() fix)", async () => {
    // buildJournalRow sends no expiresAt (the real hook doesn't either); the
    // server must stamp the ephemeral TTL on PUT exactly as it does on POST —
    // without this, hook-written journal rows never expire and the tier's
    // 24h containment bound never engages.
    const stored = await authJSON(harper, owner, "GET", `/Memory/${encodeURIComponent(metaRow.id)}`);
    expect(typeof stored.expiresAt).toBe("string");
    const ttlMs = new Date(stored.expiresAt).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(0);
    expect(ttlMs).toBeLessThanOrEqual(25 * 3600_000); // default 24h, small slack
  }, 30_000);

  // ── GATHER BOUNDARY ────────────────────────────────────────────────────────

  test("GATHER BOUNDARY: a continuity tagged run gathers exactly its own session's LIVE rows", async () => {
    const gather = await authJSON(harper, owner, "POST", "/ReflectMemories", {
      agentId: owner.id, scope: "tagged", tag: TAG_FRESH, execute: false,
    });
    const gatheredIds = (gather.memories ?? []).map((m: any) => m.id).sort();
    // Exactly the three live fresh-session rows: the expired same-session row
    // is excluded even though the reap hasn't run; other sessions' rows and
    // the meta row are excluded by the tag.
    expect(gatheredIds).toEqual(freshRows.map((r) => r.id).sort());
    expect(gatheredIds).not.toContain(expiredFreshRow.id);
    for (const r of staleRows) expect(gatheredIds).not.toContain(r.id);
  }, 30_000);

  test("CONTAINMENT: journal rows never ride a scope:'recent' gather (the settle window can fire)", async () => {
    const gather = await authJSON(harper, owner, "POST", "/ReflectMemories", {
      agentId: owner.id, scope: "recent", execute: false,
    });
    const gatheredIds = (gather.memories ?? []).map((m: any) => m.id);
    for (const id of [metaRow.id, ...freshRows.map((r: any) => r.id), ...staleRows.map((r: any) => r.id)]) {
      expect(gatheredIds).not.toContain(id);
    }
  }, 30_000);

  // ── DISTILLATION: staging + guards in the REAL execute path ───────────────

  test("FRESH session: all three candidates stage (in-flight intent IS promote-eligible while fresh); scopeTag stamped", async () => {
    expect(freshReflect.count).toBe(3);
    expect(freshReflect.droppedStaleIntent).toBe(0);
    for (const c of freshReflect.candidates) {
      expect(c.scopeTag).toBe(TAG_FRESH);
    }
  }, 30_000);

  test("STALE session: the in-flight candidate is DROPPED by the post-filter; the decision candidate stages (positive control)", async () => {
    // Mutation check (run red during development): remove the
    // isContinuityRun filter call in resources/MemoryReflect.ts → count
    // becomes 2 and droppedStaleIntent 0 → red.
    expect(staleReflect.count).toBe(1);
    expect(staleReflect.droppedStaleIntent).toBe(1);
    expect(staleReflect.candidates[0].claim).toBe(CLAIM_STALE_DECISION);
    expect(staleReflect.candidates[0].scopeTag).toBe(TAG_STALE);
  }, 30_000);

  test("the affirmative shared ruling (and ONLY it) is recorded on the PERSISTED candidate row", async () => {
    // By-id reads of the exact rows the reflect run staged (the response
    // echoes the staged rows minus rationalePrompt; the GET proves the
    // ruling fields PERSISTED, not merely echoed).
    const stagedShared = freshReflect.candidates.find((c: any) => c.claim === CLAIM_SHARED);
    const stagedPriv = freshReflect.candidates.find((c: any) => c.claim === CLAIM_PRIV);
    expect(stagedShared).toBeTruthy();
    expect(stagedPriv).toBeTruthy();

    const shared = await authJSON(harper, owner, "GET", `/MemoryCandidate/${encodeURIComponent(stagedShared.id)}`);
    expect(shared.visibilityRuling).toBe("shared");
    expect(shared.visibilityRationale).toBe(SHARED_JUSTIFICATION);
    expect(shared.scopeTag).toBe(TAG_FRESH);

    const priv = await authJSON(harper, owner, "GET", `/MemoryCandidate/${encodeURIComponent(stagedPriv.id)}`);
    expect(priv.visibilityRuling ?? null).toBeNull();
    expect(priv.visibilityRationale ?? null).toBeNull();
  }, 30_000);

  // ── PROMOTION ─────────────────────────────────────────────────────────────

  test("the sweep promoted all four staged candidates (continuity scopeTags are sweep-eligible)", () => {
    expect(sweep.count).toBe(4);
    expect(sweep.promoted.length).toBe(4);
  }, 30_000);

  test("DEFAULT-PRIVATE-UNLESS: promoted rows are private by default; ONLY the affirmatively-ruled one is shared", async () => {
    // Mutation check (run red during development): flip
    // decidePromotedVisibility's fallback returns to "shared" → the private
    // assertions here go red.
    const all = await ownMemories(harper, owner);
    const promoted = all.filter((m) => Array.isArray(m.tags) && m.tags.includes("auto-promoted"));
    expect(promoted.length).toBe(4);

    const byClaim = (claim: string) => promoted.find((m) => m.content === claim);
    expect(byClaim(CLAIM_PRIV).visibility).toBe("private");
    expect(byClaim(CLAIM_INFLIGHT_FRESH).visibility).toBe("private");
    expect(byClaim(CLAIM_STALE_DECISION).visibility).toBe("private");
    expect(byClaim(CLAIM_SHARED).visibility).toBe("shared");
  }, 30_000);

  test("the shared promoted row is genuinely team-readable; the private ones are NOT (teammate's view)", async () => {
    const visible = asRows(await authJSON(harper, teammate, "GET", `/Memory?agentId=${encodeURIComponent(owner.id)}`));
    const contents = visible.map((m: any) => m.content);
    expect(contents).toContain(CLAIM_SHARED);          // the affirmative ruling took effect
    expect(contents).not.toContain(CLAIM_PRIV);        // default-private held
    expect(contents).not.toContain(CLAIM_INFLIGHT_FRESH);
    expect(contents).not.toContain(CLAIM_STALE_DECISION);
    // and NO journal content ever reaches a teammate through any read
    for (const r of [metaRow, ...freshRows, expiredFreshRow, ...staleRows]) {
      expect(contents).not.toContain(r.content);
    }
  }, 30_000);

  test("PROMOTION CONTRACT: NEW persistent row, derivedFrom = journal source ids, scopeTag preserved first", async () => {
    const all = await ownMemories(harper, owner);
    const promoted = all.find((m) => m.content === CLAIM_PRIV);
    expect(promoted).toBeTruthy();
    // NEW id — never a journal row's id (mutation: write over a source id → red).
    const journalIds = new Set([metaRow.id, ...freshRows.map((r: any) => r.id), ...staleRows.map((r: any) => r.id)]);
    expect(journalIds.has(promoted.id)).toBe(false);
    expect(promoted.durability).toBe("persistent");
    expect(promoted.derivedFrom).toEqual([freshRows[1].id]);
    expect(promoted.tags[0]).toBe(TAG_FRESH); // scopeTag preserved, first
    expect(promoted.promotedBy).toBe(MACHINE_REVIEWER_ADK_AUTO_PROMOTE);
  }, 30_000);

  test("NEVER MUTATES: the ephemeral originals are byte-identical after promotion (durability, visibility, content, expiresAt)", async () => {
    for (const sent of freshRows) {
      const stored = await authJSON(harper, owner, "GET", `/Memory/${encodeURIComponent(sent.id)}`);
      expect(stored.durability).toBe("ephemeral");
      expect(stored.visibility).toBe("private");
      expect(stored.content).toBe(sent.content);
      expect(stored.createdAt).toBe(sent.createdAt);
      expect(stored.tags).toEqual(sent.tags);
    }
  }, 30_000);

  test("candidate rows record the machine reviewer and promoted status", async () => {
    const stagedIds: string[] = [
      ...freshReflect.candidates.map((c: any) => c.id),
      ...staleReflect.candidates.map((c: any) => c.id),
    ];
    expect(stagedIds.length).toBe(4);
    for (const id of stagedIds) {
      const c = await authJSON(harper, owner, "GET", `/MemoryCandidate/${encodeURIComponent(id)}`);
      expect(c.status).toBe("promoted");
      expect(c.reviewerId).toBe(MACHINE_REVIEWER_ADK_AUTO_PROMOTE);
      expect(c.target).toBe("memory");
    }
  }, 30_000);

  // ── derivedFrom-404 (#1264 posture) ───────────────────────────────────────

  test("derivedFrom-404: a teammate's by-id GET on a derivedFrom id is 404, indistinguishable from a missing id", async () => {
    // The shared promoted row exposes derivedFrom ids to teammates. Those ids
    // must be dead ends: live-but-private and genuinely-missing read the SAME.
    const derivedFromId = freshRows[1].id; // cited by the SHARED promoted row
    const asTeammateLive = await authFetch(harper, teammate, "GET", `/Memory/${encodeURIComponent(derivedFromId)}`);
    expect(asTeammateLive.status).toBe(404);
    const asTeammateMissing = await authFetch(harper, teammate, "GET", `/Memory/${encodeURIComponent(`${owner.id}-${randomUUID()}`)}`);
    expect(asTeammateMissing.status).toBe(404);
    // Positive control: the OWNER still reads the same id fine — the 404
    // above is scope denial, not absence.
    const asOwner = await authFetch(harper, owner, "GET", `/Memory/${encodeURIComponent(derivedFromId)}`);
    expect(asOwner.status).toBe(200);
  }, 30_000);
});
