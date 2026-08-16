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
// The wrapper's OWN token estimator (harper-free single source) — the
// tokenEstimate invariant reconstructs the estimate with the SAME function the
// handler used, so it catches the #1199 double-serialization class without
// being brittle to a future estimator change (Kern #1 / Sherlock #2).
import { estimateTokens } from "../../resources/token-estimate";

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
    await seedInsert("OrgEvent", {
      id: `conf-dup-${i}-${EV}`, authorId: author, kind: "status",
      summary: DUP_SUMMARY, detail: "same content twice", scope: "org",
      createdAt: new Date(Date.now() - i * 1000).toISOString(),
    });
  }
  await seedInsert("OrgEvent", {
    id: `conf-org-${EV}`, authorId: author, kind: "status", summary: ORG_SUMMARY,
    scope: "org", createdAt: new Date().toISOString(),
  });
  await seedInsert("OrgEvent", {
    id: `conf-mine-${EV}`, authorId: author, kind: "handoff", summary: MINE_SUMMARY,
    scope: "direct", targetIds: [AGENT], detail: "please pick this up",
    createdAt: new Date().toISOString(),
  });
  await seedInsert("OrgEvent", {
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
    await seedInsert("OrgEvent", {
      id: `conf-heavy-${i}-${EV}`, authorId: author, kind: "status",
      summary: `conf-1199 heavy event ${i} ${EV} — recall verified healthy (549 embedded vectors)`,
      detail: HEAVY_DETAIL, scope: "direct", targetIds: [AGENT_BUDGET],
      createdAt: new Date(Date.now() - i * 1000).toISOString(),
    });
  }
  // Zero-row no-op auto-heal PAIR (#1200) targeted at AGENT_BUDGET — must be
  // suppressed at render (the ledger still records them; this is a display filter).
  await seedInsert("OrgEvent", {
    id: `conf-heal-ledger-${EV}`, authorId: "flair-migrations", kind: "migration", scope: "full",
    summary: `conf-1200 migration graph-heal success (0 rows processed) ${EV}`,
    detail: JSON.stringify({ migrationId: "graph-heal", outcome: "success", rowsProcessed: 0, rowsRemaining: 0 }),
    targetIds: [AGENT_BUDGET], createdAt: new Date().toISOString(),
  });
  await seedInsert("OrgEvent", {
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
}, 300_000);

afterAll(async () => {
  const dataDir = harper?.installDir;
  if (harper) await stopHarper(harper);
  if (dataDir) await rm(dataDir, { recursive: true, force: true, maxRetries: 4 });
  if (appDir) await rm(appDir, { recursive: true, force: true });
});

// ── contract-driven assertion engine ────────────────────────────────────────

type FieldType = "string" | "number" | "boolean" | "object" | "array";
function jsTypeOf(v: any): string {
  if (Array.isArray(v)) return "array";
  if (v === null) return "null";
  return typeof v;
}
function getPath(obj: any, path: string): any {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function has(obj: any, key: string): boolean {
  return obj != null && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * UNIVERSAL structural check (runs on every tool result): the payload is fully
 * resolved and structured — never a double-serialized JSON string, never a
 * pending Promise, never a stringified object (flair#1199/#1182).
 */
function assertFullyResolved(toolName: string, result: any): void {
  if (typeof result === "string") {
    let parsed: any;
    try { parsed = JSON.parse(result); } catch { parsed = undefined; }
    expect(
      parsed !== null && typeof parsed === "object",
      `${toolName}: result is a JSON string that parses to an object — double-serialized payload`,
    ).toBe(false);
  }
  const seen = new WeakSet<object>();
  (function walk(v: any, path: string): void {
    if (v == null) return;
    if (typeof v === "object") {
      expect(typeof (v as any).then, `${toolName}: ${path} is a thenable/pending Promise in the payload`).not.toBe("function");
      if (seen.has(v)) return;
      seen.add(v);
      for (const k of Object.keys(v)) walk(v[k], `${path}.${k}`);
      return;
    }
    if (typeof v === "string") {
      expect(v.includes("[object Object]"), `${toolName}: ${path} contains "[object Object]" (a stringified object)`).toBe(false);
      expect(v.includes("[object Promise]"), `${toolName}: ${path} contains "[object Promise]" (a stringified Promise)`).toBe(false);
    }
  })(result, "result");
}

/** Apply a tool's full declarative contract to a driven result. */
function conform(toolName: string, result: any, contract: ToolContract): void {
  assertFullyResolved(toolName, result);

  for (const f of contract.requiredFields ?? []) {
    expect(result?.[f], `${toolName}: required field '${f}' missing (got ${JSON.stringify(result).slice(0, 220)})`).not.toBeUndefined();
  }
  for (const [f, t] of Object.entries(contract.fieldTypes ?? {})) {
    if (result?.[f] === undefined) continue; // presence is requiredFields' job
    expect(jsTypeOf(result[f]), `${toolName}: field '${f}' should be ${t}`).toBe(t as FieldType);
  }
  for (const f of contract.forbiddenFields ?? []) {
    expect(has(result, f), `${toolName}: forbidden internal field '${f}' leaked over the /mcp surface`).toBe(false);
  }

  const inv = contract.invariants ?? {};

  for (const { count, containers } of inv.countEqualsDelivered ?? []) {
    let total = 0;
    for (const c of containers) {
      const arr = getPath(result, c);
      expect(Array.isArray(arr), `${toolName}: container '${c}' must be an array for count==delivered`).toBe(true);
      total += arr.length;
    }
    const reported = getPath(result, count);
    expect(reported, `${toolName}: ${count} (=${reported}) must equal Σ[${containers.join(", ")}] lengths (=${total})`).toBe(total);
  }

  for (const { path, type } of inv.selfDescribingEmpty ?? []) {
    const v = getPath(result, path);
    expect(v, `${toolName}: ${path} must be present (self-describing empty, never missing/undefined)`).not.toBeUndefined();
    expect(v, `${toolName}: ${path} must not be null`).not.toBeNull();
    expect(jsTypeOf(v), `${toolName}: ${path} must be ${type}`).toBe(type);
  }

  if (inv.dedupSignature) {
    const { container, signatureFields } = inv.dedupSignature;
    const arr = getPath(result, container) ?? [];
    const seen = new Set<string>();
    for (const item of arr) {
      const sig = JSON.stringify(signatureFields.map((f) => {
        const v = item?.[f];
        return Array.isArray(v) ? [...v].sort() : (v ?? null);
      }));
      expect(seen.has(sig), `${toolName}: duplicate '${container}' entry by content-signature ${sig}`).toBe(false);
      seen.add(sig);
    }
  }

  if (inv.tokenEstimate) {
    const { field, excludeKeys } = inv.tokenEstimate;
    const reported = result?.[field];
    expect(typeof reported, `${toolName}: ${field} must be a number`).toBe("number");
    const rest: any = { ...result };
    for (const k of excludeKeys) delete rest[k];
    const expected = estimateTokens(JSON.stringify(rest));
    expect(
      reported,
      `${toolName}: ${field} (=${reported}) must equal the wrapper's OWN estimator over the delivered payload (=${expected}) — same-estimator invariant (#1199)`,
    ).toBe(expected);
  }

  if (inv.budgetCap) {
    const { estimate, budget, tolerance } = inv.budgetCap;
    const est = result?.[estimate];
    const bud = result?.[budget];
    expect(typeof est, `${toolName}: ${estimate} must be a number for budgetCap`).toBe("number");
    expect(typeof bud, `${toolName}: ${budget} must be a number for budgetCap`).toBe("number");
    // Ceiling = requested budget + tolerance for fixed JSON scaffolding and the
    // #1207 prose-vs-structured charge gap. Uncounted CONTENT (the #1199 events
    // regression) overshoots this; a healthy connector payload does not.
    const ceiling = Math.ceil(bud * (1 + tolerance));
    expect(
      est <= ceiling,
      `${toolName}: ${estimate} (=${est}) must be <= ${budget} (=${bud}) + ${Math.round(tolerance * 100)}% scaffolding tolerance (=${ceiling}) — payload must respect the requested budget (#1199 events blowout)`,
    ).toBe(true);
  }

  for (const { included, truncated, available } of inv.countCoherence ?? []) {
    const inc = result?.[included];
    const tru = result?.[truncated];
    const avail = result?.[available];
    expect(typeof inc, `${toolName}: ${included} must be a number`).toBe("number");
    expect(typeof tru, `${toolName}: ${truncated} must be a number`).toBe("number");
    expect(typeof avail, `${toolName}: ${available} must be a number`).toBe("number");
    expect(
      inc + tru <= avail,
      `${toolName}: ${included}(=${inc}) + ${truncated}(=${tru}) must be <= ${available}(=${avail}) — included and truncated are disjoint subsets of the pool (#1207 over-count)`,
    ).toBe(true);
  }

  if (inv.proseContextIsPointerAtDefault) {
    const ctx = result?.[inv.proseContextIsPointerAtDefault.field] ?? "";
    expect(typeof ctx, `${toolName}: prose context must be a string`).toBe("string");
    for (const ev of result?.events ?? []) {
      if (ev?.summary) {
        expect(ctx.includes(ev.summary), `${toolName}: prose context must not re-carry an event body at the /mcp default (#1199)`).toBe(false);
      }
    }
    for (const m of result?.memories ?? []) {
      if (m?.content) {
        expect(ctx.includes(m.content), `${toolName}: prose context must not re-carry a memory body at the /mcp default (#1199)`).toBe(false);
      }
    }
  }

  for (const rule of inv.containerRules ?? []) {
    const arr = getPath(result, rule.container);
    if (!Array.isArray(arr)) continue;
    for (const el of arr) {
      for (const f of rule.requiredFields ?? []) {
        expect(el?.[f], `${toolName}: ${rule.container}[].${f} required`).not.toBeUndefined();
      }
      for (const f of rule.forbiddenFields ?? []) {
        expect(has(el, f), `${toolName}: ${rule.container}[] leaked internal field '${f}'`).toBe(false);
      }
    }
  }
}

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
    const body = await tool("bootstrap", { currentTask: "conformance sweep", maxTokens: 8000 });
    conform("bootstrap", body, C("bootstrap"));

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
    const body = await tool("bootstrap", { currentTask: "budget sweep", maxTokens: 2000 }, { agentId: AGENT_BUDGET });
    conform("bootstrap", body, C("bootstrap"));
    expect(body.maxTokens, "maxTokens echoed").toBe(2000);
    // Load-bearing #1199 proof: the serialized payload stays within the budget
    // (plus the scaffolding tolerance) even with a dozen heavy events available.
    expect(body.tokenEstimate, `tokenEstimate ${body.tokenEstimate} must respect maxTokens 2000`).toBeLessThanOrEqual(Math.ceil(2000 * 1.25));
    // The events section is populated (the heavy events are relevant to us)…
    expect(body.events.length, "heavy events delivered").toBeGreaterThan(0);
    // …lean by default (no verbose detail on the connector path)…
    expect(body.events.some((e: any) => e.detail != null), "events are lean by default (no detail)").toBe(false);
    // …and #1200 zero-row auto-heal events are suppressed at render.
    const evText = body.events.map((e: any) => e.summary).join(" | ");
    expect(evText.includes("graph-heal"), "graph-heal verify event suppressed (#1200)").toBe(false);
    expect(evText.includes("0 rows processed"), "zero-row ledger heal event suppressed (#1200)").toBe(false);
    // includeEventDetail:true opts the verbose detail back in (still budget-capped).
    const withDetail = await tool("bootstrap", { currentTask: "budget sweep", maxTokens: 6000, includeEventDetail: true }, { agentId: AGENT_BUDGET });
    expect(withDetail.events.some((e: any) => e.detail != null), "includeEventDetail:true returns detail").toBe(true);
    expect(withDetail.tokenEstimate, "detail path still respects the (larger) budget").toBeLessThanOrEqual(Math.ceil(6000 * 1.25));
  }, 120_000);

  test("bootstrap: count arithmetic stays coherent — a memory truncated in one section and admitted in another is counted once (#1207 — countCoherence bites on revert)", async () => {
    // Tight budget: the long memory overflows the recent 40% sub-budget (→ the
    // recent loop truncates it) but fits the full remaining budget in the
    // task-relevant loop (→ it's admitted there). Reverting the count fix counts
    // it in BOTH denominators (included:1 + truncated:1 = 2 > available:1).
    const body = await tool(
      "bootstrap",
      { currentTask: COUNT_MEMORY, maxTokens: 3000 },
      { agentId: AGENT_COUNT },
    );
    conform("bootstrap", body, C("bootstrap")); // countCoherence runs here
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
