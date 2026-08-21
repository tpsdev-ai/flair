// flair#1270 — the bootstrap payload token LEDGER: every token-charged content
// class carries a counter, and the identity
//
//   tokenEstimate ≈ scaffoldTokens + soulTokens + memoryTokens + trustTokens
//                   + eventsTokens
//
// reconciles structurally in every payload (Kern's #1270 ruling: the identity
// lives in the RESPONSE SCHEMA, not tests-only). Admission already charges
// trust at all five sites (#1240) — this is the REPORTING half: the nairmy
// field rounds on 0.44.11/0.44.13 decomposed a ~1178-token gap between the
// content-only counters (soulTokens + memoryTokens) and tokenEstimate that
// tracked trust-block count exactly; with trustTokens (and eventsTokens /
// scaffoldTokens) in the payload, that gap decomposes from the payload alone
// and an uncounted-content regression breaks the identity VISIBLY.
//
// What this suite pins, on real bootstrap payloads (the REAL /mcp wrapper —
// `TOOLS.bootstrap.impl` — driven through the inproc-app fixture, same driver
// as mcp-connector-conformance-suite.test.ts) over a TEAMMATE-HEAVY fixture
// (three teammates x four shared task-relevant memories with real embeddings,
// plus a dozen own permanents — enough trust blocks that the numbers are
// non-trivial):
//
//   1. EXACT counter reconstruction — trustTokens / eventsTokens /
//      scaffoldTokens each equal the same-estimator recomputation over the
//      DELIVERED payload (the #1213 same-estimator discipline; no tolerance).
//      A counter that drifts from what ships is the reporting hole reborn.
//   2. The reconciliation identity within a documented tolerance (the ≈ gap is
//      the #1207 measurement/budgeting decoupling: soulTokens/memoryTokens
//      count prose lines while the containers ship heavier structured
//      objects). Mutation-checked: zero trustTokens out of the response tail
//      and the identity assertion goes red by the whole trust spend.
//   3. The existing budgetCap invariant (tokenEstimate <= maxTokens * 1.25,
//      the connector-conformance tolerance) still holds on the same payload —
//      the ledger reports the budget contract, it must not relax it.
//   4. Trust-off control: trustTokens is 0 (present, never absent), the trust
//      key stays absent (byte-compat with pre-#744), and the identity holds
//      without trust in the sum.
//
// Pattern: test/integration/mcp-connector-conformance-suite.test.ts (inproc-app
// fixture, mcpTool driver, ops seeding) + bootstrap-teammate-findings-e2e
// .test.ts (teammate shape: shared-visibility records, tightly-aligned
// currentTask so the real nomic model ranks them deterministically, distinct
// informational content so the dedup co-gate never conflates them).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, cp, symlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
// The same estimator the handler budgets and reports with (single source,
// harper-free) — reconstruction must be same-estimator or it proves nothing.
import { estimateTokens } from "../../resources/token-estimate";
// flair#1290 step 4 — the reconciliation identity is now a conform()-enforced
// contract invariant, and ITS declaration (the bootstrap contract's
// `invariants.tokenDecomposition`, resources/mcp-tools.ts) is the single home
// of the identity's terms and tolerance constants. This suite reads them from
// there: one identity, one tolerance definition — a re-declared copy here
// would be exactly the two-definitions drift the invariant exists to prevent.
import { TOOLS } from "../../resources/mcp-tools";

const LEDGER = TOOLS.bootstrap.contract.invariants!.tokenDecomposition!;

const REPO_ROOT = process.cwd();
const FIXTURE = join(REPO_ROOT, "test", "fixtures", "inproc-app");

let harper: HarperInstance;
let appDir: string;

const sfx = Date.now().toString(36);
const CALLER = `ledger1270-${sfx}`;
const TEAMMATES = [0, 1, 2].map((i) => `ledger1270-tm${i}-${sfx}`);
const SOUL_ROLE = `token-ledger conformance subject ${sfx} — keeps the payload honest`;

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

/** Call a /mcp tool wrapper (`TOOLS[tool].impl`) and unwrap the run() envelope. */
async function tool(name: string, args: Record<string, unknown> = {}, opts: { agentId?: string } = {}): Promise<any> {
  const res = await fleet("mcpTool", { agentId: opts.agentId ?? CALLER, tool: name, args, isAdmin: false });
  expect(res.ok, `mcpTool ${name} failed: ${JSON.stringify(res).slice(0, 500)}`).toBe(true);
  return res.value;
}

/** POST an ops-API operation with admin creds. */
async function ops(operation: Record<string, unknown>): Promise<{ status: number; body: any }> {
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

// ── ledger reconstruction helpers (same-estimator, from the DELIVERED body) ──

/** Σ estimateTokens(JSON) over a shipped container's entries — the exact
 *  per-entry figure the admission sites charged and the tail reports. */
function sumSerialized(entries: any[]): number {
  return entries.reduce((sum, e) => sum + estimateTokens(JSON.stringify(e)), 0);
}

/** Rebuild the handler's scaffold skeleton from the delivered payload: drop
 *  the fields appended AFTER the scaffold measurement (scaffoldTokens and
 *  tokenEstimate by the resource tail, flairVersion by the /mcp wrapper),
 *  empty the same content containers, re-measure. Spread preserves key order,
 *  so this reproduces the handler's serialization byte-for-byte. */
function reconstructScaffold(body: Record<string, any>): number {
  const skeleton: Record<string, any> = {
    ...body,
    context: "",
    soul: {},
    memories: [],
    predicted: [],
    teammateFindings: [],
    events: [],
    ...(Object.prototype.hasOwnProperty.call(body, "trust") ? { trust: [] } : {}),
  };
  delete skeleton.scaffoldTokens;
  delete skeleton.tokenEstimate;
  delete skeleton.flairVersion;
  return estimateTokens(JSON.stringify(skeleton));
}

/** The reconciliation gap: the contract's total minus its declared term sum
 *  (tokenEstimate minus the five ledger counters — read from the SAME
 *  tokenDecomposition declaration conform() enforces). */
function ledgerGap(body: Record<string, any>): number {
  return body[LEDGER.total] - LEDGER.terms.reduce((sum, t) => sum + body[t], 0);
}

// ~40-day backdate for the ops-seeded own permanents: keeps them out of the
// recent window so they land via the deterministic permanent path only.
const BACKDATED = new Date(Date.now() - 40 * 24 * 3600_000).toISOString();

// Own permanents — always render, so they deterministically produce lifecycle
// trust blocks. Distinct rule number + clause so the dedup co-gate (cosine >=
// 0.95 AND Jaccard >= 0.5) never conflates them.
const OWN_PERM_COUNT = 12;
const OWN_PERM = Array.from({ length: OWN_PERM_COUNT }, (_, i) =>
  `flair-1270 marker: standing rule number ${i + 1} — before finalizing any vendor agreement, always verify the ${["indemnification cap", "termination notice window", "data-residency clause", "price-escalation cap", "SLA credit floor", "audit-rights schedule"][i % 6]} against the current legal playbook revision.`);

// Teammate-heavy: three teammates, four SHARED task-aligned memories each
// (twelve cross-agent candidates), stored through the REAL memory_store tool so
// they carry genuine embeddings and enter the HNSW retrieval pool. Tightly-
// aligned domain (shared distinctive entity + subject phrase across currentTask
// and every record) so they rank deterministically against the real nomic
// model, while each memory's informational content stays genuinely distinct.
const CURRENT_TASK = "Prepare talking points for the Acme Corp vendor contract renegotiation meeting this week.";
const TM_ANGLES = [
  "lead with a volume discount ask and a 12-month price lock",
  "legal flagged the indemnification clause as the first blocker to resolve",
  "procurement requires two competing quotes on file before any renewal",
  "the incumbent competitor already undercut Acme's list price by 8 percent last cycle",
];
function teammateContent(t: number, j: number): string {
  return `flair-1270 marker t${t}: for the Acme Corp vendor contract renegotiation, teammate note ${t}-${j} — ${TM_ANGLES[j % TM_ANGLES.length]} (variant ${t}.${j}).`;
}

// Org events so eventsTokens is non-trivial too (the other counter this ledger
// adds; the same charged-but-uncounted hole-class as trust).
const EV = randomUUID();
const EVENT_COUNT = 3;

// 8000, not a tighter figure: the point of THIS suite is the ledger, not cap
// pressure (bootstrap-trust-budget-conformance covers the engaged cap). At
// 6000 the fixture sat exactly at the events-admission boundary (2-vs-3 events
// across runs as retrieval order shifted the remaining budget by a few
// tokens); 8000 admits the whole seed deterministically.
const MAX_TOKENS = 8000;
// The connector-conformance budgetCap tolerance (mcp-tools.ts bootstrap
// contract) — asserted here on the same payload the ledger is asserted on.
const BUDGET_TOLERANCE = 0.25;

// ── Reconciliation tolerance ────────────────────────────────────────────────
// The identity's ≈ gap on the connector path is the documented #1207
// measurement/budgeting decoupling: soulTokens/memoryTokens count rendered
// PROSE lines, while `memories`/`predicted`/`teammateFindings` ship heavier
// STRUCTURED objects (id + two ISO timestamps + field keys + JSON escaping).
// That overhead is per-shipped-item and bounded, so the tolerance scales with
// the shipped item count rather than pretending to be a constant:
//
//   gap <= STRUCT_ITEM_GAP * shippedItems + FIXED_SLACK
//
// Sizing (measured 2026-08-20, three consecutive runs of this fixture — the
// [1270-ledger] line below prints the live figures: est 6064–6240, memory
// 1222, trust 3336–3457, events 186, scaffold 156 → gap 1144–1199 over a
// stable 24 shipped items ≈ 48–50 tokens/item): perItemGap=60 leaves
// ~10 tokens/item headroom. POWER constraint: the tolerance (1590 on the
// measured payloads) must stay well below the fixture's trust spend
// (trustTokens ≈ 3400) so the mutation check — zero trustTokens out of the
// response tail — overshoots it (measured red: gap 4481 vs tol 1590) and
// fails. If a payload change moves the gap, re-derive both numbers from the
// printed ledger line; don't just widen the slack until the mutation can't
// bite.
//
// flair#1290 step 4: the constants LIVE in the bootstrap contract's
// tokenDecomposition declaration (resources/mcp-tools.ts) — the invariant
// conform() now enforces at every conformance site — and are read from there
// (LEDGER above). perItemGap/fixedSlack bound the gap above; roundingSlack
// bounds it below (Σ-of-ceil per counted line can exceed ceil-of-Σ by at most
// one token per line — anything past it means a counter is over-reporting
// content that never shipped, the opposite defect, equally a red).
const STRUCT_ITEM_GAP = LEDGER.perItemGap;
const ROUNDING_SLACK = LEDGER.roundingSlack;

function ledgerTolerance(body: Record<string, any>): number {
  const shippedItems = LEDGER.perItemContainers.reduce((sum, c) => sum + body[c].length, 0);
  return LEDGER.perItemGap * shippedItems + LEDGER.fixedSlack;
}

describe("flair#1270 — bootstrap payload token ledger (trustTokens/eventsTokens/scaffoldTokens reconcile tokenEstimate)", () => {
  beforeAll(async () => {
    appDir = await mkdtemp(join(tmpdir(), "flair-inproc-ledger1270-"));
    await cp(FIXTURE, appDir, { recursive: true });
    await mkdir(join(appDir, "node_modules", "@tpsdev-ai"), { recursive: true });
    await symlink(REPO_ROOT, join(appDir, "node_modules", "@tpsdev-ai", "flair"), "dir");
    harper = await startHarper({ cwd: appDir, harperBinDir: REPO_ROOT });

    await fleet("register", { id: CALLER });
    for (const tm of TEAMMATES) await fleet("register", { id: tm });

    // Soul entry so the soulTokens term participates in the identity.
    await seedInsert("Soul", {
      id: `${CALLER}:role`, agentId: CALLER, key: "role", value: SOUL_ROLE,
      createdAt: new Date().toISOString(),
    });

    // Own permanents (ops-seeded, backdated; permanents always render — no
    // embedding needed for the lifecycle path).
    for (let i = 0; i < OWN_PERM_COUNT; i++) {
      await seedInsert("Memory", {
        id: `${CALLER}-perm-${i}`, agentId: CALLER, content: OWN_PERM[i],
        durability: "permanent", visibility: "private",
        createdAt: BACKDATED, validFrom: new Date().toISOString(),
      });
    }

    // Teammate shared memories through the REAL memory_store tool (genuine
    // embeddings → the HNSW candidate pool → teammate findings + their trust
    // blocks).
    for (let t = 0; t < TEAMMATES.length; t++) {
      for (let j = 0; j < 4; j++) {
        await tool("memory_store", {
          content: teammateContent(t, j), durability: "standard", visibility: "shared",
        }, { agentId: TEAMMATES[t] });
      }
    }

    // Org-scoped events from a non-caller author, inside the 24h lookback.
    for (let i = 0; i < EVENT_COUNT; i++) {
      await seedInsert("OrgEvent", {
        id: `ledger1270-ev-${i}-${EV}`, authorId: `ledger1270-author-${EV}`, kind: "status",
        summary: `flair-1270 ledger event ${i} ${EV} — renegotiation prep milestone ${i} reached`,
        scope: "org", createdAt: new Date(Date.now() - i * 1000).toISOString(),
      });
    }
  }, 300_000);

  afterAll(async () => {
    const dataDir = harper?.installDir;
    if (harper) await stopHarper(harper);
    if (dataDir) await rm(dataDir, { recursive: true, force: true, maxRetries: 4 });
    if (appDir) await rm(appDir, { recursive: true, force: true });
  });

  test("connector path, trust on: every ledger counter reconstructs exactly, the identity reconciles, and budgetCap still holds", async () => {
    const body = await tool("bootstrap", {
      maxTokens: MAX_TOKENS, currentTask: CURRENT_TASK, includeTrust: true,
    });

    // ── POWER: the fixture is genuinely teammate-heavy, never vacuous ──
    expect(Array.isArray(body.trust), "trust array present under includeTrust:true").toBe(true);
    expect(body.trust.length, "enough trust blocks that the numbers are non-trivial").toBeGreaterThanOrEqual(12);
    const teammateTrust = body.trust.filter((e: any) => e.section === "teammate");
    expect(teammateTrust.length, "trust blocks from the TEAMMATE section (the cross-agent class the field decomposed)").toBeGreaterThanOrEqual(3);
    expect(body.teammateFindings.length, "teammate findings shipped").toBeGreaterThanOrEqual(3);
    expect(body.events.length, "org events shipped").toBeGreaterThanOrEqual(EVENT_COUNT);
    expect(body.memoryTokens, "memory content non-trivial").toBeGreaterThan(0);
    expect(body.soulTokens, "soul content participates").toBeGreaterThan(0);

    // ── 1. EXACT reconstruction (same estimator, no tolerance) ──
    expect(body.trustTokens, "trustTokens = Σ serialized shipped trust entries — the per-entry figure admission charged (#1240)").toBe(sumSerialized(body.trust));
    expect(body.trustTokens, "trust spend is non-trivial").toBeGreaterThan(500);
    expect(body.eventsTokens, "eventsTokens = Σ serialized shipped events — the per-event figure admission charged (#1199)").toBe(sumSerialized(body.events));
    expect(body.eventsTokens, "events spend visible in the ledger").toBeGreaterThan(0);
    expect(body.scaffoldTokens, "scaffoldTokens = the emptied-container skeleton, measured — reconstructible from the payload alone").toBe(reconstructScaffold(body));
    expect(body.scaffoldTokens, "scaffold figure present and non-trivial").toBeGreaterThan(0);

    // ── 2. The reconciliation identity ──
    const gap = ledgerGap(body);
    const tolerance = ledgerTolerance(body);
    console.log(`[1270-ledger] est=${body.tokenEstimate} scaffold=${body.scaffoldTokens} soul=${body.soulTokens} memory=${body.memoryTokens} trust=${body.trustTokens} events=${body.eventsTokens} gap=${gap} tol=${tolerance} items=${body.memories.length}+${body.predicted.length}+${body.teammateFindings.length} trustN=${body.trust.length} eventsN=${body.events.length}`);
    expect(
      gap,
      `identity: tokenEstimate ${body.tokenEstimate} - (scaffold ${body.scaffoldTokens} + soul ${body.soulTokens} + memory ${body.memoryTokens} + trust ${body.trustTokens} + events ${body.eventsTokens}) = ${gap} must be <= ${tolerance} (${STRUCT_ITEM_GAP}/item structured-overhead tolerance) — an uncounted content class reopens exactly the #1270 field gap`,
    ).toBeLessThanOrEqual(tolerance);
    expect(
      gap,
      `identity lower bound: the ledger sum must never exceed tokenEstimate beyond per-line rounding (gap ${gap} >= -${ROUNDING_SLACK}) — a counter reporting content that never shipped is the same defect mirrored`,
    ).toBeGreaterThanOrEqual(-ROUNDING_SLACK);

    // ── 3. The existing budgetCap invariant, on the same payload ──
    expect(
      body.tokenEstimate,
      `budgetCap: tokenEstimate ${body.tokenEstimate} <= maxTokens ${body.maxTokens} * (1 + ${BUDGET_TOLERANCE})`,
    ).toBeLessThanOrEqual(Math.ceil(body.maxTokens * (1 + BUDGET_TOLERANCE)));
  }, 120_000);

  test("trust-off control: trustTokens reports 0 (present, never absent), no trust key ships, and the identity holds without trust", async () => {
    const body = await tool("bootstrap", {
      maxTokens: MAX_TOKENS, currentTask: CURRENT_TASK,
    });

    expect(body.trust, "trust key absent when includeTrust is off (byte-compat with pre-#744)").toBeUndefined();
    expect(body.trustTokens, "trustTokens present and zero — the counter convention reports empty, never omits").toBe(0);
    expect(body.eventsTokens, "eventsTokens still reconstructs").toBe(sumSerialized(body.events));
    expect(body.scaffoldTokens, "scaffoldTokens still reconstructs (no trust key in the skeleton)").toBe(reconstructScaffold(body));

    const gap = ledgerGap(body);
    expect(gap, `trust-off identity gap ${gap} <= ${ledgerTolerance(body)}`).toBeLessThanOrEqual(ledgerTolerance(body));
    expect(gap, `trust-off identity lower bound (gap ${gap})`).toBeGreaterThanOrEqual(-ROUNDING_SLACK);
    expect(body.tokenEstimate, "budgetCap on the trust-off payload").toBeLessThanOrEqual(Math.ceil(body.maxTokens * (1 + BUDGET_TOLERANCE)));
  }, 120_000);

  test("prose path: the ledger counters still ship and reconstruct; the gap only WIDENS (the documented structured-mirror overage), never goes negative", async () => {
    const body = await tool("bootstrap", {
      maxTokens: MAX_TOKENS, currentTask: CURRENT_TASK, includeTrust: true, includeContext: true,
    });

    expect(body.trustTokens, "trustTokens reconstructs on the prose path too").toBe(sumSerialized(body.trust));
    expect(body.eventsTokens, "eventsTokens reconstructs on the prose path too").toBe(sumSerialized(body.events));
    expect(body.scaffoldTokens, "scaffoldTokens reconstructs on the prose path too").toBe(reconstructScaffold(body));
    // On the prose path the payload carries the full prose `context` BESIDE the
    // structured mirror (the module-doc CAP CONTRACT overage), so the identity
    // gap legitimately exceeds the connector tolerance — assert only the
    // direction that must always hold: counters never over-report.
    expect(ledgerGap(body), "prose-path ledger sum never exceeds tokenEstimate beyond rounding").toBeGreaterThanOrEqual(-ROUNDING_SLACK);
  }, 120_000);
});
