// ─── flair#1199 (0.44.11) — the TEAMMATE-heavy budget-cap fixture the 0.44.10 ──
//     conformance suite MISSED (the invariant that now catches this class) ──────
//
// 0.44.10 added the budgetCap conformance invariant (tokenEstimate <= maxTokens +
// tolerance) but its fixture is EVENTS-heavy (AGENT_BUDGET in
// mcp-connector-conformance-suite.test.ts). That caught the #1199 events blowout
// but is LEAN on teammate findings — so the REAL 0.44.10 blowout slipped past:
// on the /mcp connector path a teammate finding was charged its cheap PROSE line
// against the budget, but the heavier STRUCTURED container object is what SHIPS
// and what `tokenEstimate` measures. A maxTokens=4000 bootstrap reported
// soulTokens 377 + memoryTokens 3574 = 3951 (prose, just under cap) yet
// serialized at 5337 (+33%), with events at ZERO, as teammateFindingsIncluded
// crept 4→5 — the findings rode OUTSIDE the enforced budget.
//
// This fixture makes the budgetCap invariant BITE on the teammate class: MANY
// cross-agent, NON-PRIVATE, real-embedded findings clustered on ONE distinct
// task, bootstrapped by an agent that owns NOTHING, over the SHIPPED /mcp
// `bootstrap` wrapper (TOOLS.bootstrap.impl via the inproc fixture's mcpTool op —
// the includeContext=false connector surface where the structured object is the
// only content that ships). It runs in its OWN HOME-isolated Harper: the
// non-private findings are org-readable, so seeding them in the shared
// conformance store would leak into every OTHER agent's task-relevant retrieval
// (verified: they cleared the 0.3 relevance floor even against an unrelated
// "budget sweep" task and starved that fixture's events). Isolation keeps the
// class-under-test contained — the same reason bootstrap-teammate-findings-e2e
// and bootstrap-budget-regression-1207 each run their own Harper.
//
// MUTATION CHECK (the load-bearing deliverable): with Fix 1 (charge the
// structured shipped cost on the /mcp path) tokenEstimate stays within
// maxTokens*(1+tolerance) → the budgetCap assertion PASSES. Revert Fix 1 (charge
// the prose line) → extra findings ride in on the cheap charge while the heavy
// structured objects ship anyway → tokenEstimate blows the ceiling → the
// budgetCap assertion FAILS. Proven both directions in this session.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, cp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";
// The SHIPPED contract — the budgetCap tolerance is read straight off it, so this
// fixture asserts the SAME invariant the conformance suite declares (and can
// never drift from it).
import { TOOLS } from "../../resources/mcp-tools";

const REPO_ROOT = process.cwd();
const FIXTURE = join(REPO_ROOT, "test", "fixtures", "inproc-app");

let harper: HarperInstance;
let appDir: string;

const sfx = Date.now().toString(36);
// The bootstrapping agent OWNS NOTHING — so the whole payload is teammate
// findings, isolating the class under test.
const AGENT_TM = `tmbudget-${sfx}`;
// The author of the cross-agent, non-private findings.
const AGENT_TM_SRC = `tmbudget-src-${sfx}`;

const TM_TASK =
  "Coral reef bioacoustics monitoring: hydrophone drift correction and buoy " +
  "calibration for the reef soundscape reconciliation.";

// 40 distinct ~400-char findings, all in the reef-bioacoustics domain (heavy
// shared vocabulary so each clears bootstrap's raw cosine floor of 0.3 against
// TM_TASK), each with a per-index distinct clause so Memory.ts's write-time
// dedup co-gate (cosine >= 0.95 AND lexical Jaccard >= 0.5) never collapses two.
// 40 so the budget BINDS at BOTH maxTokens 2000 and 4000 (more findings than
// either budget can hold), which is what makes the cap load-bearing and the
// empirical maxTokens=4000 → 5337 blowout reproducible.
const TM_MARKER = `REEF-FINDING-${sfx}`;
const TM_FINDINGS = Array.from({ length: 40 }, (_, i) =>
  `${TM_MARKER}-${i}: Coral reef bioacoustics monitoring buoy ${i} logged a hydrophone ` +
  `drift of ${100 + i * 7} basis points during calibration window ${i}; the reef soundscape ` +
  `reconciliation flagged hydrophone gain batch ${i} for a manual buoy calibration review ` +
  `against the drift-correction baseline. Distinct note ${i}: the ${["dawn", "dusk", "midday", "night"][i % 4]} ` +
  `chorus channel ${i} showed a ${["snapping-shrimp", "parrotfish", "grouper", "damselfish"][i % 4]} ` +
  `signature offset of ${i * 3} milliseconds, reconciled batch ${i} against the buoy ${i} clock.`,
);

// Read the tolerance straight off the shipped contract so this fixture asserts
// the SAME budgetCap the conformance suite declares (tolerance can't drift).
const BUDGET_CAP = TOOLS.bootstrap.contract.invariants?.budgetCap;
const TOLERANCE = BUDGET_CAP?.tolerance ?? 0.25;
const ceilingFor = (maxTokens: number) => Math.ceil(maxTokens * (1 + TOLERANCE));

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

/** Call a /mcp tool wrapper (`TOOLS[tool].impl`) as an agent and unwrap the run() envelope. */
async function tool(name: string, args: Record<string, unknown>, agentId: string): Promise<any> {
  const res = await fleet("mcpTool", { agentId, tool: name, args, isAdmin: false });
  expect(res.ok, `mcpTool ${name} failed: ${JSON.stringify(res).slice(0, 500)}`).toBe(true);
  return res.value;
}

beforeAll(async () => {
  appDir = await mkdtemp(join(tmpdir(), "flair-inproc-tmbudget-"));
  await cp(FIXTURE, appDir, { recursive: true });
  await mkdir(join(appDir, "node_modules", "@tpsdev-ai"), { recursive: true });
  await symlink(REPO_ROOT, join(appDir, "node_modules", "@tpsdev-ai", "flair"), "dir");
  harper = await startHarper({ cwd: appDir, harperBinDir: REPO_ROOT });

  await fleet("register", { id: AGENT_TM });
  await fleet("register", { id: AGENT_TM_SRC });

  // AGENT_TM_SRC authors the findings NON-PRIVATE (visibility:"shared") through
  // the real memory_store tool, so each carries a genuine embedding and is
  // org-readable cross-agent (own + org-non-private read scope). AGENT_TM owns
  // nothing, so its teammate section fills from these findings alone.
  for (const content of TM_FINDINGS) {
    await tool("memory_store", { content, durability: "standard", visibility: "shared" }, AGENT_TM_SRC);
  }
}, 300_000);

afterAll(async () => {
  const dataDir = harper?.installDir;
  if (harper) await stopHarper(harper);
  if (dataDir) await rm(dataDir, { recursive: true, force: true, maxRetries: 4 });
  if (appDir) await rm(appDir, { recursive: true, force: true });
});

describe("flair#1199 (0.44.11) — teammate-heavy bootstrap respects maxTokens on the /mcp path", () => {
  // Run the SAME budgetCap check at both a tight budget (2000 — where the
  // mutation fires most sharply) and the empirical budget (4000 — where the OLD
  // prose charge produced the reported 5337 blowout). The budget BINDS at both
  // (40 findings > either capacity), so the cap is load-bearing, not vacuous.
  for (const maxTokens of [2000, 4000]) {
    test(`the budgetCap invariant bites the TEAMMATE class at maxTokens=${maxTokens}: tokenEstimate stays within budget+tolerance even with many heavy structured findings`, async () => {
      // Default call (includeContext NOT passed) → the /mcp connector path, where
      // only the structured containers ship and the structured object is what
      // tokenEstimate measures.
      const body = await tool("bootstrap", { currentTask: TM_TASK, maxTokens }, AGENT_TM);
      const ceiling = ceilingFor(maxTokens);

      // The budgetCap invariant's own fields must be present and numeric.
      expect(typeof body.tokenEstimate, "tokenEstimate is a number").toBe("number");
      expect(body.maxTokens, "maxTokens echoed").toBe(maxTokens);

      // It really is teammate-heavy: the section filled from cross-agent findings…
      expect(body.teammateFindings.length, "the teammate section is populated from cross-agent findings").toBeGreaterThan(3);
      // …every delivered finding is attributed to the source teammate (cross-agent)…
      expect(
        body.teammateFindings.every((f: any) => f.source === AGENT_TM_SRC && f.section === "teammate"),
        "every teammate finding is attributed to the source agent",
      ).toBe(true);
      // …AGENT_TM contributes no own memories, isolating the teammate class…
      expect(body.memories.length + body.predicted.length, "AGENT_TM owns nothing").toBe(0);
      // …the matched pool is coherent: included + truncated == matched…
      expect(
        body.teammateFindingsIncluded + body.teammateFindingsTruncated,
        "teammate included + truncated == matched",
      ).toBe(body.teammateFindingsMatched);
      // …the budget BINDS here (some relevant findings were size-skipped), so the
      // cap is doing real work, not passing vacuously…
      expect(body.teammateFindingsTruncated, "the budget binds — relevant findings were size-skipped").toBeGreaterThan(0);

      // THE LOAD-BEARING ASSERTION — the SAME budgetCap the conformance suite
      // declares (ceiling = maxTokens * (1 + contract tolerance)). With Fix 1 the
      // structured findings are charged what they ship, so this holds; revert
      // Fix 1 and the uncounted structured weight blows the ceiling (mutation-
      // validated: at maxTokens=2000, revert → tokenEstimate 2889 > 2500).
      expect(
        body.tokenEstimate,
        `tokenEstimate (=${body.tokenEstimate}) must be <= maxTokens ${maxTokens} + ${Math.round(TOLERANCE * 100)}% scaffolding tolerance (=${ceiling}) — teammate findings must be charged what they SHIP (#1199 0.44.11)`,
      ).toBeLessThanOrEqual(ceiling);
    }, 120_000);
  }
});
