// ─── /mcp connector-CONFORMANCE suite — the consumer contract, not just "does it run" ───
//
// flair#1213. The #1197 wrapper-layer suite (mcp-wrapper-layer-suite.test.ts)
// proved every tool's REAL `TOOLS.<tool>.impl` returns SOMETHING sane. This
// suite is the next altitude up: per tool, it asserts the SHAPE and SEMANTICS a
// /mcp connector is entitled to rely on — the declarative `contract` co-located
// with each tool in resources/mcp-tools.ts — driven against a seeded ephemeral
// store, same driver (the inproc-app fixture's generic `mcpTool` op) and same
// HOME-isolated Harper lifecycle as #1197.
//
// Every historical connector bug maps to an invariant here, and the PR's
// mutation-validation log proves each one BITES: revert the fix, a test below
// goes red.
//
//   #1181  by-id reads via an unloaded instance 404'd the caller's own record
//          → requiredFields (memory_get id/agentId/content) + the write→read
//            round-trips go red.
//   #1188  memory_get inlined the raw embedding vector
//          → forbiddenFields (embedding) go red.
//   #1213  …and embeddingModel still leaked on the read path (Sherlock #1)
//          → forbiddenFields (embeddingModel) go red.
//   #1182  bootstrap spread a PENDING PROMISE → {flairVersion} only
//          → requiredFields + count==delivered + self-describing-empty go red.
//   #1199  tokenEstimate under-reported (measured prose, not the real payload);
//          prose context doubled the payload at the /mcp default
//          → the same-estimator tokenEstimate invariant + prose-is-a-pointer go red.
//   #1200  byte-identical duplicate org events wasted the scarce event slots
//          → the dedup-by-content-signature invariant goes red.
//   #1206  org events were counted+charged but not delivered structurally
//          → count==delivered (sections.events) + requiredFields(events) go red.
//   #1199b org events were assembled but NEVER charged against the budget, and
//          each shipped a verbose `detail` — maxTokens=4000 serialized at 6286
//          → the budgetCap invariant (tokenEstimate <= maxTokens + tolerance)
//            goes red once the events-budget fix is reverted (heavy-event fixture).
//   #1207  memoriesIncluded + memoriesTruncated exceeded memoriesAvailable
//          (a memory counted in two sections; a predicted memory re-admitted)
//          → the countCoherence invariant goes red once the count fix is reverted.
//
// The completeness check (checkContractCompleteness) is CI-gated in THIS lane:
// a new /mcp tool shipped without a contract fails the build, fail-closed.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, cp, symlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
import {
  TOOLS,
  INTERNAL_MEMORY_FIELDS,
  checkContractCompleteness,
  type ToolContract,
} from "../../resources/mcp-tools";
// The contract-driven assertion engine — extracted to a shared helper
// (flair#1290) so the large-store workout (bootstrap-large-store-conformance
// .test.ts) runs the SAME full contract instead of a drift-prone subset.
import { conform, has } from "../helpers/mcp-conformance";
// flair#1290 — the wrapper's OWN zero-row no-op classifier: the
// noOpEventsSuppressed invariant asserts against ITS classification of the
// seeded/delivered rows, not against hardcoded fixture strings (which tracked
// the fixture, not the semantic class the #1200 filter suppresses). Imported
// here for the POSITIVE CONTROL (the fixture must seed rows it actually
// flags); the invariant itself runs inside conform().
import { isZeroRowNoOpEvent } from "../../resources/memory-bootstrap-lib";

const REPO_ROOT = process.cwd();
const FIXTURE = join(REPO_ROOT, "test", "fixtures", "inproc-app");

let harper: HarperInstance;
let appDir: string;

const sfx = Date.now().toString(36);
const AGENT = `mcpconf-${sfx}`;
const AGENT2 = `mcpconf-other-${sfx}`;
// flair#1199 budget-cap subject: heavy detail-bearing events targeted at this
// agent alone (targetIds), so a tight-budget bootstrap as AGENT_BUDGET makes the
// events-budget fix load-bearing without disturbing AGENT's event assertions.
const AGENT_BUDGET = `mcpconf-budget-${sfx}`;
// flair#1207 count-coherence subject: exactly ONE own memory, EMBEDDED (stored
// through the real memory_store tool so it enters the HNSW candidate pool) and
// LONG, bootstrapped at a tight budget where it overflows the recent 40%
// sub-budget (→ truncated) but still fits the full remaining budget in the
// task-relevant loop (→ included). That is the canonical 0.44.9 over-count: the
// SAME memory truncated in one section and included in another. With the fix the
// counters are unique-id sets (included:1, truncated:0); reverting it double-
// counts (included:1 + truncated:1 = 2 > available:1).
const AGENT_COUNT = `mcpconf-count-${sfx}`;
// flair#1290 hintWhenEmpty subject: a fresh agent with NO memories at all, so
// `predicted` (with subjects requested) and `teammateFindings` are GENUINELY
// empty and their hints must ship; org-scoped events still reach it, so the
// absent direction of eventsHint is exercised on the same payload (and a
// maxEvents:0 call genuinely empties `events` for the present direction).
const AGENT_HINT = `mcpconf-hint-${sfx}`;
const COUNT_MEMORY =
  `saga ledger federation trust boundary decision ${sfx} — ` +
  ("the recall budget accounting must charge and count every admitted record exactly once across sections, " +
   "never double-counting a memory that was budget-skipped in one section and then admitted in another. ").repeat(30);
const SOUL_ROLE = `MCP conformance test subject ${sfx}`;

// A directly-seeded memory carrying KNOWN embedding + embeddingModel — the
// engine-independent #1188 / #1213 differential: the record demonstrably HAS
// both internal fields, so a read path that stops stripping either leaks a value
// the forbiddenFields invariant can see.
const GET_ID = `${AGENT}-${randomUUID()}`;
const GET_CONTENT = `mcp conformance seeded record for memory_get ${sfx}`;
const EMBEDDING = Array.from({ length: 768 }, (_, i) => Math.sin(i) / 10);

const SEARCH_TOKEN = `zqxwconform${sfx}`;

// A private memory owned by ANOTHER agent — the read-scope boundary: AGENT must
// not be able to memory_get it.
const OTHER_PRIV_ID = `${AGENT2}-${randomUUID()}`;
const OTHER_PRIV_CONTENT = `agent2 private memory ${sfx} — AGENT must never read this`;

/** Drive one in-process operation inside the fixture app. */
async function fleet(op: string, body: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(`${harper.httpURL}/AgentFleet/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
    },
    body: JSON.stringify({ op, ...body }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`AgentFleet ${op} → HTTP ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

/** Call a /mcp tool wrapper (`TOOLS[tool].impl`) as AGENT (or admin) and unwrap the run() envelope. */
async function tool(name: string, args: Record<string, unknown> = {}, opts: { agentId?: string; isAdmin?: boolean } = {}): Promise<any> {
  const res = await fleet("mcpTool", { agentId: opts.agentId ?? AGENT, tool: name, args, isAdmin: opts.isAdmin ?? false });
  expect(res.ok, `mcpTool ${name} failed: ${JSON.stringify(res).slice(0, 500)}`).toBe(true);
  return res.value;
}

/** POST an ops-API operation with admin creds; returns the parsed JSON body. */
async function ops(operation: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`),
    },
    body: JSON.stringify(operation),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function seedInsert(table: string, record: Record<string, unknown>): Promise<void> {
  const { status } = await ops({ operation: "insert", database: "flair", table, records: [record] });
  expect(status, `${table} insert → ${status}`).toBe(200);
}

// flair#1290 — every OrgEvent row this suite seeds, kept as the raw objects so
// the noOpEventsSuppressed invariant can classify them with isZeroRowNoOpEvent
// ITSELF (delivered events are lean at the /mcp default — no `detail`, which
// the classifier needs — so conform()'s seeded-row leg is what bites there).
const SEEDED_ORG_EVENTS: Array<Record<string, unknown>> = [];
async function seedOrgEvent(record: Record<string, unknown>): Promise<void> {
  SEEDED_ORG_EVENTS.push(record);
  await seedInsert("OrgEvent", record);
}

async function opsSearchEquals(table: string, attribute: string, value: string): Promise<any[]> {
  const { status, body } = await ops({
    operation: "search_by_conditions",
    database: "flair",
    table,
    operator: "and",
    get_attributes: ["*"],
    conditions: [{ search_attribute: attribute, search_type: "equals", search_value: value }],
  });
  expect(status, `${table} search_by_conditions → ${status}`).toBe(200);
  return Array.isArray(body) ? body : [];
}

// ── unique event summaries so counts/dedup are unambiguous ──────────────────
const EV = randomUUID();
const DUP_SUMMARY = `conf-1200 duplicate-pair ${EV}`;   // seeded TWICE (byte-identical content, distinct id/createdAt)
const ORG_SUMMARY = `conf-1206 org-scoped ${EV}`;
const MINE_SUMMARY = `conf-1206 targeted-to-me ${EV}`;
const OTHER_SUMMARY = `conf-1206 targeted-elsewhere ${EV}`;

beforeAll(async () => {
  appDir = await mkdtemp(join(tmpdir(), "flair-inproc-mcpconf-"));
  await cp(FIXTURE, appDir, { recursive: true });
  await mkdir(join(appDir, "node_modules", "@tpsdev-ai"), { recursive: true });
  await symlink(REPO_ROOT, join(appDir, "node_modules", "@tpsdev-ai", "flair"), "dir");
  harper = await startHarper({ cwd: appDir, harperBinDir: REPO_ROOT });

  await fleet("register", { id: AGENT });
  await fleet("register", { id: AGENT2 });

  // Soul entry (soul_get).
  await seedInsert("Soul", {
    id: `${AGENT}:role`, agentId: AGENT, key: "role", value: SOUL_ROLE,
    createdAt: new Date().toISOString(),
  });

  // A memory carrying both internal fields (memory_get leak differential).
  await seedInsert("Memory", {
    id: GET_ID, agentId: AGENT, content: GET_CONTENT,
    durability: "standard", visibility: "private",
    embedding: EMBEDDING, embeddingModel: "seed-fixture",
    createdAt: new Date().toISOString(), validFrom: new Date().toISOString(),
  });

  // Own memories so bootstrap.memories is non-empty (count==delivered, container
  // rules bite) and search has hits.
  for (let i = 0; i < 3; i++) {
    await seedInsert("Memory", {
      id: `${AGENT}-${randomUUID()}`, agentId: AGENT,
      content: `${SEARCH_TOKEN} conformance own-memory ${i} ${sfx}`,
      durability: "standard", visibility: "private",
      createdAt: new Date(Date.now() - i * 1000).toISOString(), validFrom: new Date().toISOString(),
    });
  }

  // A relationship on an entity (attention has cross-source data).
  await seedInsert("Relationship", {
    id: `${AGENT}-${randomUUID()}`, agentId: AGENT,
    subject: `agent:${AGENT}`, predicate: "works_with", object: "repo:tpsdev-ai/flair",
    confidence: 1.0, validFrom: new Date().toISOString(), createdAt: new Date().toISOString(),
  });

  // Another agent's PRIVATE memory (read-scope boundary).
  await seedInsert("Memory", {
    id: OTHER_PRIV_ID, agentId: AGENT2, content: OTHER_PRIV_CONTENT,
    durability: "standard", visibility: "private",
    createdAt: new Date().toISOString(), validFrom: new Date().toISOString(),
  });

  // Org events:
  //  • a DUPLICATE PAIR — byte-identical content (kind+summary+detail+targetIds),
  //    distinct id + createdAt (mimicking a double-fire) → #1200 collapses to 1.
  //  • an org-scoped event, and one targeted at AGENT → both relevant.
  //  • one targeted at someone else → the relevance filter excludes it.
  const author = `conf-author-${EV}`;
  for (let i = 0; i < 2; i++) {
    await seedOrgEvent({
      id: `conf-dup-${i}-${EV}`, authorId: author, kind: "status",
      summary: DUP_SUMMARY, detail: "same content twice", scope: "org",
      createdAt: new Date(Date.now() - i * 1000).toISOString(),
    });
  }
  await seedOrgEvent({
    id: `conf-org-${EV}`, authorId: author, kind: "status", summary: ORG_SUMMARY,
    scope: "org", createdAt: new Date().toISOString(),
  });
  await seedOrgEvent({
    id: `conf-mine-${EV}`, authorId: author, kind: "handoff", summary: MINE_SUMMARY,
    scope: "direct", targetIds: [AGENT], detail: "please pick this up",
    createdAt: new Date().toISOString(),
  });
  await seedOrgEvent({
    id: `conf-other-${EV}`, authorId: author, kind: "handoff", summary: OTHER_SUMMARY,
    scope: "direct", targetIds: [`someone-else-${EV}`], createdAt: new Date().toISOString(),
  });

  // ── flair#1199 budget-cap fixture ──────────────────────────────────────────
  // AGENT_BUDGET: a few small own memories + MANY events that each carry a
  // verbose `detail` blob (the #1199 shape — detail restates the summary +
  // internals), targeted at AGENT_BUDGET so they don't pollute AGENT's assertions.
  // With the fix a tight-budget bootstrap ships LEAN events well within budget;
  // revert the events-budget fix and the uncounted detail-bearing events blow it.
  await fleet("register", { id: AGENT_BUDGET });
  for (let i = 0; i < 4; i++) {
    await seedInsert("Memory", {
      id: `${AGENT_BUDGET}-${randomUUID()}`, agentId: AGENT_BUDGET,
      content: `${SEARCH_TOKEN} budget own-memory ${i} ${sfx}`,
      durability: "standard", visibility: "private",
      createdAt: new Date(Date.now() - i * 1000).toISOString(), validFrom: new Date().toISOString(),
    });
  }
  const HEAVY_DETAIL = JSON.stringify({
    migrationId: "noop", verified: true, embeddedVectorCount: 549,
    runningVersion: "0.44.10", verifiedAt: new Date().toISOString(), notes: "x".repeat(600),
  });
  for (let i = 0; i < 12; i++) {
    await seedOrgEvent({
      id: `conf-heavy-${i}-${EV}`, authorId: author, kind: "status",
      summary: `conf-1199 heavy event ${i} ${EV} — recall verified healthy (549 embedded vectors)`,
      detail: HEAVY_DETAIL, scope: "direct", targetIds: [AGENT_BUDGET],
      createdAt: new Date(Date.now() - i * 1000).toISOString(),
    });
  }
  // Zero-row no-op auto-heal PAIR (#1200) targeted at AGENT_BUDGET — must be
  // suppressed at render (the ledger still records them; this is a display filter).
  await seedOrgEvent({
    id: `conf-heal-ledger-${EV}`, authorId: "flair-migrations", kind: "migration", scope: "full",
    summary: `conf-1200 migration graph-heal success (0 rows processed) ${EV}`,
    detail: JSON.stringify({ migrationId: "graph-heal", outcome: "success", rowsProcessed: 0, rowsRemaining: 0 }),
    targetIds: [AGENT_BUDGET], createdAt: new Date().toISOString(),
  });
  await seedOrgEvent({
    id: `conf-heal-verify-${EV}`, authorId: "flair-migrations", kind: "migration", scope: "full",
    summary: `conf-1200 HNSW graph-heal recall verified healthy ${EV}`,
    detail: JSON.stringify({ migrationId: "graph-heal", verified: true, canaryRank1: true, embeddedVectorCount: 549 }),
    targetIds: [AGENT_BUDGET], createdAt: new Date().toISOString(),
  });

  // ── flair#1207 count-coherence fixture ─────────────────────────────────────
  // AGENT_COUNT owns EXACTLY ONE memory, stored through the real memory_store
  // tool so it carries a genuine embedding (the ops-inserted rows above do NOT,
  // and the bootstrap candidate pool is HNSW-only — an un-embedded memory never
  // reaches the task-relevant loop, so the over-count path can't fire). The test
  // bootstraps at a tight budget where this long memory overflows the recent 40%
  // sub-budget (truncated) yet fits the full remaining budget in the task-relevant
  // loop (included) — the same memory in two sections.
  await fleet("register", { id: AGENT_COUNT });
  await tool("memory_store", { content: COUNT_MEMORY, durability: "standard" }, { agentId: AGENT_COUNT });

  // ── flair#1290 hintWhenEmpty fixture ───────────────────────────────────────
  // AGENT_HINT owns nothing at all — registration only.
  await fleet("register", { id: AGENT_HINT });
}, 300_000);

afterAll(async () => {
  const dataDir = harper?.installDir;
  if (harper) await stopHarper(harper);
  if (dataDir) await rm(dataDir, { recursive: true, force: true, maxRetries: 4 });
  if (appDir) await rm(appDir, { recursive: true, force: true });
});

// ── contract-driven assertion engine ────────────────────────────────────────
// `conform()` (and its helpers) live in test/helpers/mcp-conformance.ts —
// extracted there by flair#1290 so bootstrap-large-store-conformance.test.ts
// applies the identical full contract. Behavior unchanged; only the module
// boundary moved.

/** Assert a refused tool call returns a parseable error shape with no stack/path leak. */
function assertErrorShape(toolName: string, resp: any, contract: ToolContract): void {
  const es = contract.errorShape;
  expect(es, `${toolName}: contract declares no errorShape`).toBeDefined();
  for (const f of es!.fields) {
    expect(resp?.[f], `${toolName}: error response must carry '${f}' (got ${JSON.stringify(resp).slice(0, 220)})`).not.toBeUndefined();
  }
  for (const f of es!.mustNotLeak ?? []) {
    expect(has(resp, f), `${toolName}: error response leaked '${f}'`).toBe(false);
  }
  for (const v of Object.values(resp ?? {})) {
    if (typeof v === "string") {
      expect(/\n\s+at\s/.test(v), `${toolName}: error leaks a stack trace`).toBe(false);
      expect(/\/(Users|home|private|var)\//.test(v), `${toolName}: error leaks a filesystem path`).toBe(false);
    }
  }
}

const C = (name: string): ToolContract => TOOLS[name].contract;

// ── completeness (fail-closed) — CI-gated in this lane ───────────────────────
describe("conformance completeness gate (fail-closed)", () => {
  test("every shipped /mcp tool carries a contract, and the gate examined all of them", () => {
    const res = checkContractCompleteness(TOOLS);
    expect(res.missing, `tools shipped without a conformance contract: ${res.missing.join(", ")}`).toEqual([]);
    expect(res.ok).toBe(true);
    expect(res.examined, "the gate must have enumerated the whole registry (not a vacuous pass)").toBe(Object.keys(TOOLS).length);
    expect(res.examined).toBeGreaterThan(0);
  });
});

// ── per-tool conformance ─────────────────────────────────────────────────────
describe("/mcp connector conformance — each tool honors its declared contract", () => {
  test("bootstrap: full structured payload; counts, dedup, tokenEstimate, prose-pointer all hold at the /mcp default", async () => {
    // Default call: includeContext NOT passed → the connector path.
    const bootArgs = { currentTask: "conformance sweep", maxTokens: 8000 };
    const body = await tool("bootstrap", bootArgs);
    conform("bootstrap", body, C("bootstrap"), { args: bootArgs, seededEvents: SEEDED_ORG_EVENTS });

    // Relevance + delivery spot-checks (the #1206 structured-events move).
    const summaries = (body.events ?? []).map((e: any) => e.summary);
    expect(summaries, "duplicate-pair event delivered (collapsed to one)").toContain(DUP_SUMMARY);
    expect(summaries, "org-scoped event delivered").toContain(ORG_SUMMARY);
    expect(summaries, "event targeted at the caller delivered").toContain(MINE_SUMMARY);
    expect(summaries, "event targeted at someone else must be filtered out").not.toContain(OTHER_SUMMARY);
    // The dedup PAIR really collapsed: exactly one delivered event carries DUP_SUMMARY.
    expect(summaries.filter((s: string) => s === DUP_SUMMARY).length, "the byte-identical duplicate pair must collapse to ONE (#1200)").toBe(1);
    // memoriesIncluded spans memories+predicted, and there IS own content.
    expect(body.memories.length, "own memories delivered").toBeGreaterThan(0);
  }, 120_000);

  test("bootstrap: events respect maxTokens and zero-row heals are suppressed (#1199/#1200 — budgetCap bites on revert)", async () => {
    // Tight budget + many detail-bearing events targeted at this agent. The
    // contract's budgetCap invariant runs inside conform(); it PASSES here (lean
    // events, budget-charged) and FAILS if the events-budget fix is reverted
    // (uncounted, detail-bearing events overshoot maxTokens*(1+tolerance)).
    const budgetArgs = { currentTask: "budget sweep", maxTokens: 2000 };
    const body = await tool("bootstrap", budgetArgs, { agentId: AGENT_BUDGET });
    conform("bootstrap", body, C("bootstrap"), { args: budgetArgs, seededEvents: SEEDED_ORG_EVENTS });
    expect(body.maxTokens, "maxTokens echoed").toBe(2000);
    // Load-bearing #1199 proof: the serialized payload stays within the budget
    // (plus the scaffolding tolerance) even with a dozen heavy events available.
    expect(body.tokenEstimate, `tokenEstimate ${body.tokenEstimate} must respect maxTokens 2000`).toBeLessThanOrEqual(Math.ceil(2000 * 1.25));
    // The events section is populated (the heavy events are relevant to us)…
    expect(body.events.length, "heavy events delivered").toBeGreaterThan(0);
    // …lean by default (no verbose detail on the connector path)…
    expect(body.events.some((e: any) => e.detail != null), "events are lean by default (no detail)").toBe(false);
    // …and #1200 zero-row auto-heal events are suppressed at render. flair#1290:
    // asserted INSIDE conform() by the noOpEventsSuppressed invariant against
    // isZeroRowNoOpEvent's own classification of the seeded rows — not against
    // hardcoded fixture strings. POSITIVE CONTROL here: the classifier must
    // actually flag the seeded heal pair, or the invariant has nothing it
    // could ever catch and its green is vacuous.
    const classifiedNoOps = SEEDED_ORG_EVENTS.filter((e) => isZeroRowNoOpEvent(e as any));
    expect(
      classifiedNoOps.length,
      "positive control: the fixture must seed rows isZeroRowNoOpEvent actually flags (the ledger + verify heal pair)",
    ).toBe(2);
    // includeEventDetail:true opts the verbose detail back in (still budget-capped).
    // conform() runs here too: with `detail` present on every delivered event,
    // the noOpEventsSuppressed per-element leg is live on this payload.
    const detailArgs = { currentTask: "budget sweep", maxTokens: 6000, includeEventDetail: true };
    const withDetail = await tool("bootstrap", detailArgs, { agentId: AGENT_BUDGET });
    conform("bootstrap", withDetail, C("bootstrap"), { args: detailArgs, seededEvents: SEEDED_ORG_EVENTS });
    expect(withDetail.events.some((e: any) => e.detail != null), "includeEventDetail:true returns detail").toBe(true);
    expect(withDetail.tokenEstimate, "detail path still respects the (larger) budget").toBeLessThanOrEqual(Math.ceil(6000 * 1.25));
  }, 120_000);

  test("bootstrap: count arithmetic stays coherent — a memory truncated in one section and admitted in another is counted once (#1207 — countCoherence bites on revert)", async () => {
    // Tight budget: the long memory overflows the recent 40% sub-budget (→ the
    // recent loop truncates it) but fits the full remaining budget in the
    // task-relevant loop (→ it's admitted there). Reverting the count fix counts
    // it in BOTH denominators (included:1 + truncated:1 = 2 > available:1).
    const countArgs = { currentTask: COUNT_MEMORY, maxTokens: 3000 };
    const body = await tool("bootstrap", countArgs, { agentId: AGENT_COUNT });
    conform("bootstrap", body, C("bootstrap"), { args: countArgs, seededEvents: SEEDED_ORG_EVENTS }); // countCoherence runs here
    // The single own memory exists and is available.
    expect(body.memoriesAvailable, "exactly one own memory available").toBe(1);
    // It is delivered (admitted via the task-relevant loop after the recent skip).
    expect(body.memoriesIncluded, "the one memory is included exactly once").toBe(1);
    expect(body.memories.length + body.predicted.length, "delivered own containers hold exactly one copy").toBe(1);
    // The load-bearing #1207 invariant: included and truncated are disjoint.
    expect(
      body.memoriesIncluded + body.memoriesTruncated,
      `included(${body.memoriesIncluded}) + truncated(${body.memoriesTruncated}) must not exceed available(${body.memoriesAvailable}) (#1207)`,
    ).toBeLessThanOrEqual(body.memoriesAvailable);

    // ── flair#1290 — the SAME fixture under includeTrust:true ────────────────
    // countCoherence had NEVER run on the trust path: this suite never passed
    // includeTrust, and the trust-budget test never ran conform() — the
    // intersection was empty across every bootstrap integration test, so a
    // trust-admission counter desync could not have failed CI. The full
    // contract (countCoherence, countEqualsDelivered, tokenEstimate,
    // budgetCap, hints) now runs against a trust-path payload of the exact
    // over-count fixture. Mutation-validated: a trust-conditional counter
    // desync in MemoryBootstrap goes red HERE and only here (see the PR's
    // powered-check log).
    const trustArgs = { currentTask: COUNT_MEMORY, maxTokens: 3000, includeTrust: true };
    const trustBody = await tool("bootstrap", trustArgs, { agentId: AGENT_COUNT });
    conform("bootstrap", trustBody, C("bootstrap"), { args: trustArgs, seededEvents: SEEDED_ORG_EVENTS });
    // The trust block actually shipped (this really is the trust path), one
    // self-contained entry per included memory, correlated by id.
    expect(Array.isArray(trustBody.trust), "includeTrust:true ships the trust array").toBe(true);
    expect(trustBody.trust.length, "one trust entry per included memory").toBe(trustBody.memoriesIncluded + trustBody.teammateFindingsIncluded);
    const deliveredIds = new Set([...trustBody.memories, ...trustBody.predicted, ...trustBody.teammateFindings].map((m: any) => m.id));
    for (const t of trustBody.trust) {
      expect(deliveredIds.has(t.id), `trust entry ${t.id} must correlate to a delivered memory`).toBe(true);
    }
    // Same count arithmetic holds under trust admission.
    expect(
      trustBody.memoriesIncluded + trustBody.memoriesTruncated,
      `trust path: included(${trustBody.memoriesIncluded}) + truncated(${trustBody.memoriesTruncated}) must not exceed available(${trustBody.memoriesAvailable}) (#1207 under includeTrust)`,
    ).toBeLessThanOrEqual(trustBody.memoriesAvailable);
  }, 120_000);

  test("bootstrap: empty containers carry their hints, populated ones carry none (#1182 populated-or-hint — hintWhenEmpty bites on a dropped hint)", async () => {
    // AGENT_HINT owns NOTHING: with subjects requested and no currentTask,
    // `predicted` and `teammateFindings` are genuinely empty (their hints must
    // ship, as must currentTaskHint), while org-scoped events still reach the
    // agent (events populated → eventsHint must be ABSENT). All four
    // presence/absence rules run inside conform(); the spot-pins below prove
    // this fixture really put each container in the state the invariant
    // claims to be checking (a hint test on a never-empty container would be
    // the same cannot-fire defect this PR exists to remove).
    const emptyArgs = { subjects: [`no-such-subject-${sfx}`], maxTokens: 4000 };
    const body = await tool("bootstrap", emptyArgs, { agentId: AGENT_HINT });
    conform("bootstrap", body, C("bootstrap"), { args: emptyArgs, seededEvents: SEEDED_ORG_EVENTS });
    expect(body.predicted.length, "predicted is genuinely empty for the memory-less agent").toBe(0);
    expect(body.teammateFindings.length, "teammateFindings is genuinely empty without a currentTask").toBe(0);
    expect(body.events.length, "org-scoped events still reach the fresh agent (populated direction)").toBeGreaterThan(0);
    expect(typeof body.predictedHint, "subjects requested + empty predicted → predictedHint").toBe("string");
    expect(typeof body.teammateFindingsHint, "empty teammateFindings → teammateFindingsHint").toBe("string");
    expect(typeof body.currentTaskHint, "no currentTask → currentTaskHint").toBe("string");
    expect(has(body, "eventsHint"), "populated events → NO eventsHint").toBe(false);

    // maxEvents:0 genuinely EMPTIES the events container (the cap is honored
    // at 0, not treated as falsy-default) → eventsHint must ship; a provided
    // currentTask means currentTaskHint must NOT.
    const noEventsArgs = { currentTask: "hint-fixture sweep", maxEvents: 0, maxTokens: 4000 };
    const body2 = await tool("bootstrap", noEventsArgs, { agentId: AGENT_HINT });
    conform("bootstrap", body2, C("bootstrap"), { args: noEventsArgs, seededEvents: SEEDED_ORG_EVENTS });
    expect(body2.events.length, "maxEvents:0 empties the events container").toBe(0);
    expect(typeof body2.eventsHint, "empty events → eventsHint").toBe("string");
    expect(has(body2, "currentTaskHint"), "currentTask provided → NO currentTaskHint").toBe(false);
    expect(has(body2, "predictedHint"), "no subjects requested → NO predictedHint even though predicted is empty").toBe(false);
  }, 120_000);

  test("memory_search: { results } with content-bearing hits and no embedding fields on any hit", async () => {
    const res = await tool("memory_search", { query: SEARCH_TOKEN, limit: 10 });
    conform("memory_search", res, C("memory_search"));
    const hit = res.results.find((r: any) => typeof r?.content === "string" && r.content.includes(SEARCH_TOKEN));
    expect(hit, "the seeded token memory must be among the results").toBeDefined();
  }, 120_000);

  test("memory_store: write echo { id, written, deduplicated }, no internal fields; round-trips via memory_get", async () => {
    const content = `mcp conformance store ${sfx} ${randomUUID()}`;
    const res = await tool("memory_store", { content, type: "decision", durability: "standard" });
    conform("memory_store", res, C("memory_store"));
    // round-trip (Kern #3): the write actually landed and reads back.
    const back = await tool("memory_get", { id: res.id });
    expect(back?.content, "memory_store → memory_get round-trip").toBe(content);
  }, 120_000);

  test("memory_get: full record with embedding AND embeddingModel stripped by default; the vector returns under includeEmbedding", async () => {
    const def = await tool("memory_get", { id: GET_ID });
    conform("memory_get", def, C("memory_get"));
    expect(def.id, "record id round-trips").toBe(GET_ID);
    expect(def.content, "record content round-trips").toBe(GET_CONTENT);
    // The record demonstrably carries both internal fields — prove the strip is
    // real, not vacuous — by opting the vector back in.
    const withEmb = await tool("memory_get", { id: GET_ID, includeEmbedding: true });
    expect(Array.isArray(withEmb?.embedding), "includeEmbedding:true returns the raw vector").toBe(true);
    expect(withEmb.embedding.length, "the seeded 768-float vector round-trips").toBe(768);
  }, 120_000);

  test("memory_update: write echo, no internal fields; the change round-trips via memory_get", async () => {
    const orig = `mcp conformance update-target ${sfx} ${randomUUID()}`;
    const stored = await tool("memory_store", { content: orig, durability: "standard" });
    const updated = `${orig} :: UPDATED ${randomUUID()}`;
    const res = await tool("memory_update", { id: stored.id, content: updated });
    conform("memory_update", res, C("memory_update"));
    expect(res.id, "update echoes the same id").toBe(stored.id);
    const after = await tool("memory_get", { id: stored.id });
    expect(after?.content, "memory_update → memory_get round-trip").toBe(updated);
  }, 120_000);

  test("soul_get: the seeded soul entry with the contracted fields", async () => {
    const res = await tool("soul_get", { key: "role" });
    conform("soul_get", res, C("soul_get"));
    expect(res.value, "soul value round-trips").toBe(SOUL_ROLE);
  }, 120_000);

  test("soul_set: writes an entry that round-trips via soul_get (the #1181 connector-path write)", async () => {
    const key = `project-${sfx}`;
    const value = `mcp conformance soul_set ${randomUUID()}`;
    const res = await tool("soul_set", { key, value });
    conform("soul_set", res, C("soul_set"));
    const back = await tool("soul_get", { key });
    expect(back?.value, "soul_set → soul_get round-trip").toBe(value);
  }, 120_000);

  test("flair_workspace_set: drives without error; persists a record attributed to the caller", async () => {
    const ref = `cp-mcpconf-${sfx}`;
    const res = await tool("flair_workspace_set", { ref, label: "conformance", phase: "review", summary: "conf suite" });
    conform("flair_workspace_set", res, C("flair_workspace_set"));
    const rows = await opsSearchEquals("WorkspaceState", "id", `${AGENT}:${ref}`);
    expect(rows.length, "workspace_set persists exactly one record").toBe(1);
    expect(rows[0].agentId, "attributed to the caller").toBe(AGENT);
  }, 120_000);

  test("flair_orgevent: drives without error; persists an event attributed to the caller", async () => {
    const summary = `mcp conformance orgevent ${sfx} ${randomUUID()}`;
    const res = await tool("flair_orgevent", { kind: "status", summary, scope: "org" });
    conform("flair_orgevent", res, C("flair_orgevent"));
    const rows = await opsSearchEquals("OrgEvent", "summary", summary);
    expect(rows.length, "orgevent persists exactly one event").toBe(1);
    expect(rows[0].authorId, "attributed to the caller").toBe(AGENT);
  }, 120_000);

  test("attention: grouped-by-source view with all five groups and a numeric total", async () => {
    const res = await tool("attention", { entity: "repo:tpsdev-ai/flair", days: 30 });
    conform("attention", res, C("attention"));
    expect(Object.keys(res.groups ?? {}).sort(), "attention groups every source").toEqual(
      ["memory", "orgEvent", "presence", "relationship", "workspaceState"].sort(),
    );
    expect(typeof res.counts?.total, "numeric total").toBe("number");
    expect(res.counts.relationship, "the seeded relationship is counted").toBeGreaterThanOrEqual(1);
  }, 120_000);

  test("record_usage: the invariant { recorded:true } acknowledgement", async () => {
    const res = await tool("record_usage", { memoryId: GET_ID, attribution: "conformance suite" });
    conform("record_usage", res, C("record_usage"));
    expect(res.recorded, "acknowledges recorded:true").toBe(true);
  }, 120_000);
});

// ── error contract (Kern #5) — one refused case per tool that declares one ────
describe("/mcp connector conformance — error responses are parseable and leak nothing", () => {
  test("memory_get: a non-existent id returns { error, status }, no stack/path", async () => {
    const resp = await tool("memory_get", { id: `${AGENT}-does-not-exist-${randomUUID()}` });
    assertErrorShape("memory_get", resp, C("memory_get"));
  }, 120_000);

  test("memory_store: an unrecognized visibility returns { error, status }, no internal fields", async () => {
    const resp = await tool("memory_store", { content: `bad-vis ${randomUUID()}`, visibility: "prvate" });
    assertErrorShape("memory_store", resp, C("memory_store"));
    expect(resp.status, "unrecognized visibility is a 400").toBe(400);
  }, 120_000);

  test("memory_update: a non-existent id returns { error, status }", async () => {
    const resp = await tool("memory_update", { id: `${AGENT}-missing-${randomUUID()}`, content: "x" });
    assertErrorShape("memory_update", resp, C("memory_update"));
    expect(resp.status).toBe(404);
  }, 120_000);

  test("memory_delete: a non-admin deleting a permanent memory returns { error, status:403 }", async () => {
    const permId = `${AGENT}-${randomUUID()}`;
    await seedInsert("Memory", {
      id: permId, agentId: AGENT, content: `conformance permanent ${sfx}`,
      durability: "permanent", visibility: "private",
      createdAt: new Date().toISOString(), validFrom: new Date().toISOString(),
    });
    const resp = await tool("memory_delete", { id: permId });
    assertErrorShape("memory_delete", resp, C("memory_delete"));
    expect(resp.status, "permanent delete by non-admin is 403").toBe(403);
    const still = await tool("memory_get", { id: permId });
    expect(still?.id, "the permanent memory survives the refused delete").toBe(permId);
  }, 120_000);
});

// ── auth boundary (Kern #4) — the read scope a connector inherits ─────────────
describe("/mcp connector conformance — read-scope boundary", () => {
  test("memory_get: a caller cannot read another agent's PRIVATE memory", async () => {
    const resp = await tool("memory_get", { id: OTHER_PRIV_ID });
    // Must NOT return agent2's content — a 404/empty is correct (own + org-non-private scope).
    const leaked = resp && typeof resp === "object" && resp.content === OTHER_PRIV_CONTENT;
    expect(leaked, `memory_get must not leak another agent's private memory, got: ${JSON.stringify(resp).slice(0, 200)}`).toBe(false);
  }, 120_000);
});
