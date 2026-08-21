// flair#1298 — eventsHint must distinguish BUDGET-TRUNCATED from GENUINELY
// EMPTY on the real REST path.
//
// The #1298 investigation started as a REST-vs-/mcp delivery divergence and a
// CLOSED-transaction-chain theory; the mandatory fails-on-main gate DISPROVED
// that mechanism (the REST path delivers events fine — see the issue's respec
// comment). What survives instrumentation is a genuine #1182 hint-contract
// violation: when seeded, relevant org events clear the lookback window and
// every relevance filter but NONE fit the remaining token budget (the #1199
// admission gate `cost > tokenBudget`), the events container ships empty and
// eventsHint claims "present-but-empty BY DESIGN, not dropped" — exactly the
// false reassurance the #1182 empty-container hints exist to prevent. The
// events were dropped; the payload says they weren't. teammateFindingsHint
// already has an explicit budget-truncated branch; eventsHint did not.
//
// What this suite pins, over the REAL Ed25519-signed REST path (the
// bootstrap-trust-budget-conformance driver — NOT the inproc /mcp wrapper,
// because the original false reassurance was observed over REST):
//
//   1. Genuinely-no-events control (runs FIRST, before any event is seeded —
//      bun executes tests in declaration order): the by-design branch is
//      unchanged behavior.
//   2. THE positive control (fails on unmodified main): seeded relevant
//      events + a tight maxTokens that zero-admits them → events:[] must
//      carry the TRUNCATED hint (with the admitted-then-skipped count), and
//      the "by design" wording must be ABSENT. On main this test goes red
//      because the by-design wording fires on the truncated case.
//   3. Generous-budget control: the same seed delivers all events and no
//      eventsHint ships beside the populated container (#1290
//      populated-or-hint, absent direction).
//
// The truncated count is of ADMITTED-THEN-SKIPPED events ONLY (events that
// entered the admission loop for THIS caller and failed only the budget gate)
// — never a gap derived from a larger tally, which could imply the existence
// of rows the caller was not allowed to see (Sherlock ruling on the respec).
//
// TIGHT_MAX_TOKENS derivation (recorded per the respec): the #1298 walk-back
// demonstrated maxTokens=1500 zero-admits with ITS trust-heavy seed; against
// THIS fixture (20 permanents + includeTrust:true + three ~370-char event
// summaries, each ~122 tokens serialized) the value was RE-DERIVED by an
// empirical sweep (one Harper, eleven budgets — probe log quoted in the PR):
//   800→2 events, 900→0, 1000→1, 1100→0, 1200→0, 1300→1, 1400→0, 1500→1,
//   1600→1, 2000→0, 16000→3
// — the same non-monotonic shape the walk-back reported (more budget admits
// more MEMORIES first, which changes the residual left for events). 1100 is
// chosen because it has the widest margin of the zero-admit values: at 1100
// the admitted-memory set matches 1200's (memoriesIncluded=4) and 1200 still
// zero-admits, so the 1100 residual is < 22 tokens against a ~122-token
// cheapest event — over 100 tokens of drift needed to flip it (1200's own
// margin is < 22). The `events.length === 0` precondition assertion below is
// the guard: if drift in upstream admission ever lets an event slip in at
// this budget, the test fails THERE with a re-derive message rather than
// silently testing the wrong branch.
//
// Pattern: test/integration/bootstrap-trust-budget-conformance.test.ts
// (Ed25519 signing, signed PUT seed, REST bootstrap driver) +
// bootstrap-token-ledger-1270.test.ts (ops-API OrgEvent seed shape from the
// issue: kind "status", scope "org", no targetIds, non-caller author,
// distinct summaries inside the 24h lookback).
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

async function registerAgent(harper: HarperInstance, agent: TestAgent): Promise<void> {
  const res = await adminOp(harper, {
    operation: "insert", database: "flair", table: "Agent",
    records: [{ id: agent.id, name: agent.id, role: "agent", publicKey: agent.publicKey, createdAt: new Date().toISOString() }],
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
    throw new Error(`seed PUT ${id} → ${res.status}: ${await res.text()}`);
  }
}

/** The REAL REST path: Ed25519-signed POST /BootstrapMemories. */
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

let harper: HarperInstance;
const sfx = Date.now().toString(36);
const agent = mkAgent(`t1298-${sfx}-${randomUUID().slice(0, 8)}`);

// Trust-heavy own seed (the walk-back's reproduction shape): permanents always
// render, so at a tight budget they deterministically consume it before the
// events section (events are admitted LAST) — no currentTask / embedding
// ranking involved. Distinct content so the Memory dedup co-gate never
// conflates them.
const SEED_COUNT = 20;
const SEED_CONTENT = Array.from({ length: SEED_COUNT }, (_, i) =>
  `flair-1298 marker: standing rule number ${i + 1} — before finalizing any vendor agreement, always verify the ${["indemnification cap", "termination notice window", "data-residency clause", "price-escalation cap", "SLA credit floor"][i % 5]} against the current legal playbook revision.`);

// The issue's OrgEvent shape: kind "status", scope "org", no targetIds,
// authorId ≠ caller, createdAt inside the 24h lookback, distinct summaries
// (no dedup collapse), kind not "migration" (the #1200 no-op filter cannot
// fire). Summaries are deliberately long (~122 tokens serialized per event,
// measured by the sweep) so no residual sliver of budget can admit one —
// widens the zero-admit margin the tight case depends on.
const EVENT_COUNT = 3;
const eventSummary = (i: number) =>
  `flair-1298 truncation fixture event ${i} (${sfx}) — renegotiation preparation milestone ${i} reached; ` +
  "the vendor working group circulated the revised indemnification and data-residency riders for counsel review, " +
  "flagged two open escalation-cap questions for the next sync, and confirmed the SLA credit floor language is " +
  "settled pending final signature from the procurement lead.";

// Derived by the empirical sweep documented above (probe log in the PR).
const TIGHT_MAX_TOKENS = 1100;
const GENEROUS_MAX_TOKENS = 16000;

describe("flair#1298 — eventsHint: budget-truncated vs genuinely-empty on the REST path", () => {
  beforeAll(async () => {
    harper = await startHarper();
    await registerAgent(harper, agent);
    for (let i = 0; i < SEED_COUNT; i++) {
      await putMemory(harper, agent, `${agent.id}-perm-${i}`, {
        agentId: agent.id, content: SEED_CONTENT[i], durability: "permanent",
        createdAt: new Date(Date.now() - 40 * 24 * 3600_000).toISOString(),
      });
    }
  }, 300_000);

  afterAll(async () => { if (harper) await stopHarper(harper); });

  // ── 1. Genuinely no events (runs BEFORE the event seed below — bun runs
  //       tests in declaration order) → the by-design branch, unchanged. ──
  test("no org events in the window → the by-design branch fires (unchanged behavior)", async () => {
    const body = await bootstrap(harper, agent, {
      agentId: agent.id, maxTokens: GENEROUS_MAX_TOKENS, includeTrust: true, includeContext: false,
    });
    expect(body.events.length, "no events seeded yet — container genuinely empty (boot migrations are 0-row no-ops, filtered by #1200)").toBe(0);
    expect(typeof body.eventsHint, "empty events → eventsHint ships (#1182)").toBe("string");
    expect(body.eventsHint, "genuinely-empty case keeps the by-design wording").toContain("present-but-empty by design, not dropped");
    expect(body.eventsHint, "genuinely-empty case must NOT claim truncation").not.toContain("budget-truncated");
  }, 60_000);

  // ── 2. THE positive control (RED on unmodified main): relevant events
  //       zero-admitted by a tight budget must be reported as TRUNCATED,
  //       never as empty-by-design. ──
  test("seeded events zero-admitted by a tight budget → TRUNCATED hint with the admitted-then-skipped count; the by-design wording is ABSENT", async () => {
    for (let i = 0; i < EVENT_COUNT; i++) {
      const res = await adminOp(harper, {
        operation: "insert", database: "flair", table: "OrgEvent",
        records: [{
          id: `t1298-ev-${i}-${sfx}`, authorId: `t1298-author-${sfx}`, kind: "status",
          summary: eventSummary(i), scope: "org",
          createdAt: new Date(Date.now() - i * 1000).toISOString(),
        }],
      });
      expect(res.status, `OrgEvent seed ${i} → ${res.status}`).toBe(200);
    }

    const body = await bootstrap(harper, agent, {
      agentId: agent.id, maxTokens: TIGHT_MAX_TOKENS, includeTrust: true, includeContext: false,
    });

    // Precondition guard on the empirically-derived tight value: the truncated
    // branch is only under test if the budget really zero-admitted the events.
    // If this fires, upstream admission changed — re-derive TIGHT_MAX_TOKENS
    // (probe descending values until events:[]), don't weaken the assertions.
    expect(body.events.length,
      `TIGHT_MAX_TOKENS=${TIGHT_MAX_TOKENS} no longer zero-admits (events.length=${body.events.length}) — re-derive the tight value`,
    ).toBe(0);

    // The #1298 contract: truncated, said plainly, with the count.
    expect(typeof body.eventsHint, "empty events → eventsHint ships (#1182)").toBe("string");
    expect(body.eventsHint, "the hint must name the truncation").toContain("budget-truncated");
    expect(body.eventsHint, "the count is the admitted-then-skipped tally — all three seeded events").toContain(`${EVENT_COUNT} relevant event(s)`);
    expect(body.eventsHint, "the remedy is actionable (#1182: hints teach the knob)").toContain("Raise maxTokens");
    // The false reassurance this issue exists to remove: on unmodified main
    // this assertion is the one that goes red.
    expect(body.eventsHint, "budget-truncated events must NEVER be described as empty by design").not.toContain("by design");
  }, 60_000);

  // ── 3. Generous budget: same seed delivers the events; no hint beside a
  //       populated container (#1290 populated-or-hint, absent direction). ──
  test("generous budget → all seeded events delivered over REST, and NO eventsHint ships", async () => {
    const body = await bootstrap(harper, agent, {
      agentId: agent.id, maxTokens: GENEROUS_MAX_TOKENS, includeTrust: true, includeContext: false,
    });
    expect(body.events.length, "all seeded events delivered on the REST path").toBeGreaterThanOrEqual(EVENT_COUNT);
    for (let i = 0; i < EVENT_COUNT; i++) {
      const found = body.events.some((e: any) => e.summary === eventSummary(i));
      expect(found, `seeded event ${i} must be among the delivered events`).toBe(true);
    }
    expect("eventsHint" in body, "populated events → NO eventsHint (#1290 absent direction)").toBe(false);
  }, 60_000);
});
