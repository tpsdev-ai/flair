// ─── flair#1199 / #1200 / #1201 — bootstrap payload quality, proven live ──────
//
// These are the three defects a real /mcp connector (claude.ai) surfaced once
// the #1182 fix made the full bootstrap payload visible:
//
//   #1199  DOUBLE SERIALIZATION — the prose `context` embedded every soul/memory
//          body IN FULL, and the SAME bodies also shipped in the structured
//          soul/memories/predicted containers, so everything crossed the wire
//          twice (~2× over maxTokens). tokenEstimate counted only `context`, so
//          it under-reported; and memoriesIncluded/memoriesAvailable used
//          different denominators (one client saw included 9 > available 3).
//   #1200  ORG-EVENT DUPLICATE PAIRS — byte-identical events rendered twice,
//          wasting ~half the scarce org-event slots.
//   #1201  FRESHNESS off createdAt (a record edited today read as 12 days stale)
//          and a matchQuality inconsistency (own lifecycle → null vs teammate →
//          band, reading as a scoring failure on the caller's own records).
//
// Driven through the SHIPPED /mcp `bootstrap` wrapper (TOOLS.bootstrap.impl, via
// the fixture's generic `mcpTool` op) against a HOME-isolated ephemeral Harper —
// the exact vantage the connector had. The wrapper defaults includeContext:false
// (the connector consumes the structured containers), which is the surface the
// "no bytes twice" proof needs.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, cp, symlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, HarperInstance } from "../helpers/harper-lifecycle";

const REPO_ROOT = process.cwd();
const FIXTURE = join(REPO_ROOT, "test", "fixtures", "inproc-app");

let harper: HarperInstance;
let appDir: string;

const sfx = Date.now().toString(36);
const AGENT = `boot1199-${sfx}`;
const TEAMMATE = `boot1199-mate-${sfx}`;
// A dedicated agent for test (b)'s permanent-memory FLOOD, so it never pollutes
// AGENT's store for the later events/trust tests (see (b) for the full rationale).
const BULK_AGENT = `boot1199-bulk-${sfx}`;
const SOUL_ROLE = `Payload-quality test subject ${sfx}`;

// Distinctive markers so an assertion can locate a specific body unambiguously.
const RECENT_MARKER = `RECENT-BODY-${sfx}-${randomUUID()}`;
const UPDATED_MARKER = `UPDATED-TODAY-BODY-${sfx}-${randomUUID()}`;
const TEAMMATE_MARKER = `TEAMMATE-BODY-${sfx}-${randomUUID()}`;
const EVENT_SUMMARY = `dup-event-summary-${sfx}-${randomUUID()}`;

const est = (s: string) => Math.ceil(s.length / 4);
const nowIso = () => new Date().toISOString();
const daysAgoIso = (d: number) => new Date(Date.now() - d * 24 * 3600_000).toISOString();

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

/** Call the shipped /mcp bootstrap wrapper (as AGENT by default). */
async function bootstrap(args: Record<string, unknown> = {}, agentId: string = AGENT): Promise<any> {
  const res = await fleet("mcpTool", { agentId, tool: "bootstrap", args, isAdmin: false });
  expect(res.ok, `bootstrap failed: ${JSON.stringify(res).slice(0, 500)}`).toBe(true);
  return res.value;
}

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

beforeAll(async () => {
  appDir = await mkdtemp(join(tmpdir(), "flair-inproc-boot1199-"));
  await cp(FIXTURE, appDir, { recursive: true });
  await mkdir(join(appDir, "node_modules", "@tpsdev-ai"), { recursive: true });
  await symlink(REPO_ROOT, join(appDir, "node_modules", "@tpsdev-ai", "flair"), "dir");
  harper = await startHarper({ cwd: appDir, harperBinDir: REPO_ROOT });

  await fleet("register", { id: AGENT });
  await fleet("register", { id: TEAMMATE });

  await seedInsert("Soul", {
    id: `${AGENT}:role`, agentId: AGENT, key: "role", value: SOUL_ROLE, createdAt: nowIso(),
  });

  // A recent (fresh) own memory — used for the "no bytes twice" proof.
  await seedInsert("Memory", {
    id: `${AGENT}-${randomUUID()}`, agentId: AGENT, content: RECENT_MARKER,
    durability: "standard", visibility: "private", createdAt: nowIso(), updatedAt: nowIso(),
    validFrom: nowIso(),
  });

  // The #1201 freshness record: created 12 days ago, EDITED today. Permanent so
  // it is always included regardless of the recent adaptive window.
  await seedInsert("Memory", {
    id: `${AGENT}-updated-${randomUUID()}`, agentId: AGENT, content: UPDATED_MARKER,
    durability: "permanent", visibility: "private",
    createdAt: daysAgoIso(12), updatedAt: nowIso(), validFrom: daysAgoIso(12),
  });

  // A teammate's NON-PRIVATE memory (open-within-org read) — gives the
  // teammateFindings container a real candidate.
  await seedInsert("Memory", {
    id: `${TEAMMATE}-${randomUUID()}`, agentId: TEAMMATE, content: TEAMMATE_MARKER,
    durability: "standard", visibility: "shared", createdAt: nowIso(), updatedAt: nowIso(),
    validFrom: nowIso(),
  });

  // #1200 — two BYTE-IDENTICAL org events (same kind+summary+detail+targets),
  // distinct ids/createdAt (as OrgEvent.post would mint them). Org-scoped (no
  // targets) so they surface for AGENT.
  for (let i = 0; i < 2; i++) {
    await seedInsert("OrgEvent", {
      id: `${TEAMMATE}-evt-${i}-${randomUUID()}`, authorId: TEAMMATE,
      kind: "status", summary: EVENT_SUMMARY, scope: "org",
      createdAt: new Date(Date.now() - (i + 1) * 1000).toISOString(),
    });
  }
}, 300_000);

afterAll(async () => {
  const dataDir = harper?.installDir;
  if (harper) await stopHarper(harper);
  if (dataDir) await rm(dataDir, { recursive: true, force: true, maxRetries: 4 });
  if (appDir) await rm(appDir, { recursive: true, force: true });
});

describe("flair#1199/#1200/#1201 — bootstrap payload quality", () => {
  // (a) #1199 — no field's bytes appear twice by default (/mcp path).
  test("#1199 (a): by default no body ships twice — content is in the structured containers, NOT re-embedded in context", async () => {
    const body = await bootstrap({ currentTask: "payload quality check", maxTokens: 8000 });

    // The structured containers are canonical and carry the bodies.
    expect(Array.isArray(body.memories), "memories is a structured array").toBe(true);
    const ownContents = body.memories.map((m: any) => m.content);
    expect(ownContents, "own recent memory is in the structured container").toContain(RECENT_MARKER);
    expect(body.soul?.role, "soul body is in the structured container").toBe(SOUL_ROLE);
    expect(Array.isArray(body.teammateFindings), "teammateFindings container present").toBe(true);

    // ...and the prose `context` is a compact pointer, NOT the bodies — so the
    // same bytes never cross the wire twice on the connector path.
    expect(typeof body.context, "context is always a string").toBe("string");
    expect(body.context, "context must NOT re-embed the memory body").not.toContain(RECENT_MARKER);
    expect(body.context, "context must NOT re-embed the soul body").not.toContain(SOUL_ROLE);
    expect(body.context, "default context is the structural pointer").toContain("includeContext:true");
  }, 120_000);

  // (a') opt-in restores the full prose mirror.
  test("#1199: includeContext:true returns the full prose mirror (bodies in context)", async () => {
    const body = await bootstrap({ currentTask: "payload quality check", maxTokens: 8000, includeContext: true });
    expect(body.context, "opt-in prose carries the memory body").toContain(RECENT_MARKER);
    expect(body.context, "opt-in prose carries the soul body").toContain(SOUL_ROLE);
  }, 120_000);

  // (b) #1199/#1207 CAP CONTRACT — tokenEstimate HONESTLY reports the real
  // serialized payload; maxTokens is the hard cap on CONTENT SELECTION (NOT on
  // the serialized output size). #1199 originally asserted tokenEstimate ≤
  // maxTokens by shrinking the selection budget (a reserve + per-item overhead) —
  // that silently cut recall below 0.44.6 (#1207). The corrected contract:
  // selection ≤ maxTokens (enforced), tokenEstimate may exceed maxTokens by the
  // structured-container JSON scaffolding (honestly measured, not "fixed" by
  // dropping content).
  test("#1199/#1207 (b): tokenEstimate is an HONEST report; maxTokens bounds CONTENT SELECTION, not the serialized size", async () => {
    // Seed enough permanent content to overflow the cap even at the RESTORED
    // (0.44.6) selection capacity — so the cap demonstrably engages after the
    // #1207 budget restore (60 records × ~90 prose tokens ≫ the 3000 budget).
    // Owned by a DEDICATED agent (BULK_AGENT), not AGENT: the greedy permanent
    // section fills the whole budget with this flood, and since 0.44.11 charges
    // the /mcp path its STRUCTURED shipped cost (heavier than the prose line), a
    // 60-permanent flood in AGENT's store would starve the events/trust sections
    // the LATER (d')/(e) tests read (they bootstrap AGENT). Scoping it here keeps
    // AGENT's store clean for those tests — the same isolation discipline the
    // teammate-budget fixture uses for its non-private findings.
    await fleet("register", { id: BULK_AGENT });
    for (let i = 0; i < 60; i++) {
      await seedInsert("Memory", {
        id: `${BULK_AGENT}-bulk-${i}-${randomUUID()}`, agentId: BULK_AGENT,
        content: `bulk permanent memory ${i} ${sfx} ` + "lorem ipsum dolor sit amet ".repeat(12),
        durability: "permanent", visibility: "private", createdAt: nowIso(), updatedAt: nowIso(),
        validFrom: nowIso(),
      });
    }

    const maxTokens = 3000;
    const body = await bootstrap({ maxTokens }, BULK_AGENT);

    // Honesty: tokenEstimate equals estimateTokens over the exact serialized body
    // the caller received (minus the wrapper-appended flairVersion + the
    // tokenEstimate field itself). This is the #1199 improvement — KEEP.
    const { tokenEstimate, flairVersion, ...rest } = body;
    const measured = est(JSON.stringify(rest));
    expect(Math.abs(tokenEstimate - measured), `tokenEstimate ${tokenEstimate} vs measured ${measured}`).toBeLessThanOrEqual(5);

    // The ENFORCED cap: selected CONTENT (soul + rendered memory lines) never
    // exceeds maxTokens — the shared tokenBudget started at maxTokens and every
    // admitted line was gated against it. This is the real, recall-preserving
    // cap (#1207), replacing the false "serialized payload ≤ maxTokens" claim.
    expect(
      body.soulTokens + body.memoryTokens,
      `selected content (soul ${body.soulTokens} + memory ${body.memoryTokens}) must be ≤ maxTokens ${maxTokens}`,
    ).toBeLessThanOrEqual(maxTokens);
    // The cap actually engaged (proves it's bounding, not just fitting) — and the
    // selection engaged at the RESTORED capacity, not the #1199-shrunk one.
    expect(body.memoriesTruncated, "bulk seed must have forced truncation").toBeGreaterThan(0);
  }, 180_000);

  // (c) #1199 — coherent counters: included ≤ available (same denominator).
  test("#1199 (c): memoriesIncluded ≤ memoriesAvailable, teammate findings counted separately", async () => {
    const body = await bootstrap({ currentTask: "counter coherence", maxTokens: 8000 });
    expect(typeof body.memoriesAvailable, "memoriesAvailable is a number").toBe("number");
    expect(typeof body.memoriesIncluded, "memoriesIncluded is a number").toBe("number");
    expect(
      body.memoriesIncluded,
      `own included (${body.memoriesIncluded}) must never exceed own available (${body.memoriesAvailable})`,
    ).toBeLessThanOrEqual(body.memoriesAvailable);
    // Cross-agent findings are a SEPARATE denominator — labelled, never folded in.
    expect(typeof body.teammateFindingsIncluded, "teammateFindingsIncluded is its own counter").toBe("number");
  }, 120_000);

  // (d') #1206 — org events ship in the STRUCTURED `events` container at the /mcp
  // DEFAULT (includeContext=false), where prose `context` carries no bodies.
  // Before #1206 events lived ONLY in the prose string, so a connector at the
  // default saw sections.events count but had no way to read the events. The
  // #1200 dedup is preserved (the byte-identical pair → ONE entry), and the
  // structured count agrees with the shipped array.
  test("#1206 (d'): the structured `events` array is delivered at the default (prose off), deduped, count-coherent", async () => {
    const body = await bootstrap({ maxTokens: 8000 }); // wrapper default: includeContext=false
    // Always present, self-describing (never absent → distinguishable from unsupported).
    expect(Array.isArray(body.events), "events is a structured array (always present)").toBe(true);
    const mine = body.events.filter((e: any) => e.summary === EVENT_SUMMARY);
    // Deduped to a single entry (the #1200 signature dedup, shared with the array).
    expect(mine.length, `the byte-identical event pair must ship as ONE structured entry, got ${JSON.stringify(body.events).slice(0, 400)}`).toBe(1);
    // Entry shape: the fields a connector needs to read the event.
    expect(mine[0].kind, "structured entry carries kind").toBe("status");
    expect(typeof mine[0].id, "structured entry carries an id").toBe("string");
    expect(typeof mine[0].createdAt, "structured entry carries createdAt").toBe("string");
    // The count reflects the SHIPPED (deduped) array, not the pre-dedup pair.
    expect(body.sections.events, "sections.events reflects the shipped deduped count").toBe(body.events.length);
    // Delivery is independent of prose: at the default, context carries no event body.
    expect(body.context, "default prose context does not carry the event summary").not.toContain(EVENT_SUMMARY);
  }, 120_000);

  // (d) #1200 — org events deduped (scarce slots not wasted on exact dupes).
  test("#1200 (d): byte-identical org events are deduped to a single slot", async () => {
    const body = await bootstrap({ maxTokens: 8000, includeContext: true });
    const eventsSection = body.context.split("## Recent Org Events")[1] ?? "";
    const occurrences = eventsSection.split(EVENT_SUMMARY).length - 1;
    expect(
      occurrences,
      `the duplicate event pair must render ONCE, not twice — events section:\n${eventsSection.slice(0, 400)}`,
    ).toBe(1);
  }, 120_000);

  // (e) #1201 (refined) — carry BOTH signals: ageDays is TRUE AGE (off
  // createdAt), staleDays is FRESHNESS (off updatedAt). A record created 12 days
  // ago but edited today has ageDays ~12 AND staleDays ~0 — the first #1201 pass
  // keyed ageDays off updatedAt and collapsed true age into freshness (ageDays 0).
  test("#1201 (e): a record created 12d ago but updated today shows ageDays ~12 (true age) AND staleDays ~0 (fresh)", async () => {
    const body = await bootstrap({ maxTokens: 8000, includeTrust: true });
    expect(Array.isArray(body.trust), "includeTrust returns a trust array").toBe(true);
    const updatedEntry = body.trust.find((t: any) => {
      const m = body.memories.find((mm: any) => mm.id === t.id);
      return m && m.content === UPDATED_MARKER;
    });
    expect(updatedEntry, "the updated-today record must have a trust block").toBeDefined();
    // TRUE AGE off createdAt (12 days ago) — the mutation-check anchor: reverting
    // ageDays to key off updatedAt makes this ~0 and fails.
    expect(
      updatedEntry.ageDays,
      `true age off createdAt (~12d), got ${updatedEntry.ageDays}`,
    ).toBeGreaterThanOrEqual(11);
    // FRESHNESS off updatedAt (edited today) — the new separate signal.
    expect(
      updatedEntry.staleDays,
      `freshness off updatedAt (~0d), got ${updatedEntry.staleDays}`,
    ).toBeLessThanOrEqual(1);
  }, 120_000);

  // (f) #1201 — matchQuality is consistent: determined by SURFACE (section), not
  // by ownership. Every trust entry is section-tagged, and lifecycle sections
  // (not a retrieval surface) carry null uniformly — so own-recent null no longer
  // reads as a scoring failure next to a teammate band.
  test("#1201 (f): trust entries are section-tagged; matchQuality is null on lifecycle sections for own AND teammate alike", async () => {
    const body = await bootstrap({ currentTask: "match quality consistency", maxTokens: 8000, includeTrust: true });
    expect(body.trust.length, "there is at least one trust entry to check").toBeGreaterThan(0);
    const lifecycle = new Set(["permanent", "recent", "predicted"]);
    for (const t of body.trust) {
      expect(typeof t.section, `every trust entry carries a section, got ${JSON.stringify(t).slice(0, 120)}`).toBe("string");
      if (lifecycle.has(t.section)) {
        expect(
          t.matchQuality,
          `lifecycle section '${t.section}' must carry matchQuality null (not a retrieval surface), got ${t.matchQuality}`,
        ).toBeNull();
      }
    }
  }, 120_000);
});
