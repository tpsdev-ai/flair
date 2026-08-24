/**
 * quality-recall-spotcheck-967.test.ts — the powered check for flair#967.
 *
 * #967 is a diagnosed defect, so these tests were written to FAIL on
 * unmodified main first (red-on-main log in the PR body) and are the reason
 * the fix is believed. Three properties, plus positive controls:
 *
 *  1. ALERTING AUTHORITY — replaying a duplicate-cue window (the shape the
 *     nightly sweep actually sampled on 2026-08-23) through the sweep's
 *     decision chain must emit NO `quality.regression` for the recall
 *     spot-check. On main it emits two.
 *  2. CUE DERIVATION — `deriveRecallCue` must not hand an opaque slug
 *     (`pr-1359`, `kern-2026-08-23`, `quality-snapshot/<host>`) to semantic
 *     search as if it were a query. On main it does, because the only bar is
 *     `subject.length >= 3`.
 *  3. SAMPLE HEALTH — a window that cannot be scored fairly is recorded as
 *     UNHEALTHY and reports that fact instead of a number (fail closed,
 *     visibly).
 *
 * Positive controls (these pass on main AND on the branch, deliberately —
 * they exist so a green run here cannot be a vacuous one):
 *  - the diff machinery still emits for a metric that genuinely crossed a line;
 *  - a genuine recall CRATER is still measured, reported and snapshotted;
 *  - `QUALITY_EVENT_RECALL_DROP_THRESHOLD` is still literally 0.2 — the fix is
 *    not "raise the threshold until it stops talking".
 *
 * Every number in the fixtures below is a MEASUREMENT, not an invention: they
 * come from the 32-run history and the same-instant A/B recorded on flair#967
 * (comment 5389889052), both taken against rockit production.
 */

import { describe, test, expect } from "bun:test";
import {
  computeQualityReport,
  computeRecallSpotCheck,
  deriveRecallCue,
  isDiscriminativeSubject,
  planRecallSpotCheck,
  buildQualitySnapshot,
  diffQualitySnapshots,
  QUALITY_EVENT_RECALL_DROP_THRESHOLD,
  QUALITY_RECALL_K,
  QUALITY_RECALL_SAMPLE_SIZE,
  type QualitySnapshotCore,
} from "../../src/cli.ts";

const NOW = new Date("2026-08-23T09:00:00.000Z").getTime();
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

/** Minimal /HealthDetail-shaped payload — same field names as
 *  resources/health.ts's get() output (see quality-report.test.ts). Only the
 *  recall spot-check matters here; the rest just has to be well-formed so no
 *  OTHER metric accidentally produces the finding we're asserting about. */
function healthFixture(overrides: Record<string, any> = {}) {
  return {
    ok: true,
    caller: { agentId: "flint", isAdmin: true },
    memories: {
      total: 2998,
      withEmbeddings: 2998,
      hashFallback: 0,
      modelCounts: { "nomic-embed-text-v1.5-Q4_K_M+searchprefix": 2998 },
      expired: 100,
    },
    agents: {
      count: 1,
      names: ["flint"],
      perAgent: [{ id: "flint", memoryCount: 2998, hashFallback: 0, writes24h: 40, lastWriteAt: daysAgo(0), usageCount: 100 }],
    },
    migrations: { migrations: [{ id: "embedding-backfill", state: "completed" }] },
    ...overrides,
  };
}

/** A prior snapshot carrying whatever recall pair a test needs to diff against.
 *  Every other section is held IDENTICAL to what healthFixture() produces, so
 *  the only thing that can generate a finding is the recall spot-check. */
function previousSnapshot(recallAtK: number, mrr: number): QualitySnapshotCore {
  return {
    schemaVersion: 1,
    computedAt: daysAgo(1),
    agentFilter: "flint",
    embeddingCoverage: { coveragePct: 100 },
    staleness: { stalePct: 3 },
    recallSpotCheck: { recallAtK, mrr },
    quietAgents: { perAgent: [{ id: "flint", quiet: false, daysSinceLastWrite: 0 }] },
    dedupClusters: null,
  };
}

// ─── The measured duplicate-cue window ───────────────────────────────────────
//
// The per-query outcomes below are the DERIVED-CUE arm of the same-instant A/B
// recorded on #967 — 10 sampled memories, one `POST /SemanticSearch` each,
// limit=5, read-only against rockit production 0.48.0 (buildCommit a6cc5ad):
//
//   rank=5  cue='pr-1359'          rank=4  cue='kern-2026-08-23'
//   rank=4  cue='pr-1359'          rank=5  cue='pr-1357'
//   rank=0  cue='pr-1359'          rank=0  cue='kern-2026-08-23'
//   rank=4  cue='kern-2026-08-24'  rank=0  cue='pr-1357'
//   rank=2  cue='kern-2026-08-23'  rank=0  cue='pr-1357'
//
// which scores recall@5 = 6/10 = 0.60 and MRR = 1.65/10 = 0.165 — the numbers
// the A/B reported for that arm. The CONTENT arm of the same A/B, same ten
// memories, same minute, scored recall@5 = 1.00 / MRR = 0.78: every target was
// retrievable from its own content, so `contentRank: 1` below is that arm
// (modelled at rank 1; the measured MRR of 0.78 means "mostly rank 1-2").
//
// This is a REPLAY of a measurement, not a simulation of embedding search: no
// scorer is being re-implemented here, the recorded rank of each query is
// simply played back so the sweep's DECISION chain can be exercised over it.
interface ReplayRow {
  id: string;
  subject: string;
  content: string;
  createdAt: string;
  /** Rank the target came back at when queried by its SUBJECT. 0 = not in top-5. */
  subjectCueRank: number;
}

const MEASURED_WINDOW: ReplayRow[] = [
  { id: "m01", subject: "pr-1359", content: "Kern architecture review of the presence-beat refactor: the poller and the writer now share one clock source.", subjectCueRank: 5 },
  { id: "m02", subject: "pr-1359", content: "Sherlock security review of the presence-beat refactor: no new credential surface, the token never reaches argv.", subjectCueRank: 4 },
  { id: "m03", subject: "pr-1359", content: "Flint merge note for the presence-beat refactor: CI green across all lanes, both reviewers approved on the current head.", subjectCueRank: 0 },
  { id: "m04", subject: "kern-2026-08-24", content: "Daily architecture digest: the federation connector rows have no external re-heal source, back up before any cluster operation.", subjectCueRank: 4 },
  { id: "m05", subject: "kern-2026-08-23", content: "Daily architecture digest: base-copy resync applies state with no transaction-log entries by design, receiver-only rows are discarded.", subjectCueRank: 2 },
  { id: "m06", subject: "kern-2026-08-23", content: "Follow-up on the resync note: seventy-two hour log retention is the boundary past which a receiver silently loses rows.", subjectCueRank: 4 },
  { id: "m07", subject: "pr-1357", content: "Kern architecture review of the doctor native-extension probe: detection belongs in the wiring check, not the version banner.", subjectCueRank: 5 },
  { id: "m08", subject: "kern-2026-08-23", content: "Third digest entry: hub-only rows written by the OAuth connector are the ones with no federation coverage today.", subjectCueRank: 0 },
  { id: "m09", subject: "pr-1357", content: "Sherlock security review of the doctor native-extension probe: the probe reads a path, it never executes what it finds.", subjectCueRank: 0 },
  { id: "m10", subject: "pr-1357", content: "Flint merge note for the doctor native-extension probe: changelog fragment present, refs not closes, no review requests.", subjectCueRank: 0 },
].map((r, i) => ({ ...r, createdAt: new Date(NOW - i * 60_000).toISOString() }));

const DISTRACTORS = ["old-a", "old-b", "old-c", "old-d", "old-e"];

/** Play back the recorded rank for one query. `cue === row.subject` means the
 *  subject-cue arm (the measured ranks above); anything else is the
 *  content-derived arm, which the A/B measured at recall@5 1.00. */
function replaySearch(row: ReplayRow, cue: string, k: number): string[] {
  const rank = cue === row.subject ? row.subjectCueRank : 1;
  const out = DISTRACTORS.slice(0, k);
  if (rank >= 1 && rank <= k) out[rank - 1] = row.id;
  return out;
}

/** The sweep's decision chain over a window, minus the HTTP hop: derive a cue
 *  per sampled memory (production `deriveRecallCue`), play back that query's
 *  recorded result list, score it (production `computeRecallSpotCheck` via
 *  `computeQualityReport`), snapshot it (production `buildQualitySnapshot`)
 *  and diff it against the previous snapshot (production
 *  `diffQualitySnapshots`) — exactly what `flair quality --emit` does. */
function replaySweep(rows: ReplayRow[], previous: QualitySnapshotCore | null) {
  const k = QUALITY_RECALL_K;
  const sampledIds = rows.map((r) => r.id);
  const perQueryResultIds = rows.map((r) => replaySearch(r, deriveRecallCue(r), k));
  const report = computeQualityReport(true, healthFixture(), {
    now: NOW,
    agentId: "flint",
    recallSpotCheckData: { ok: true, agentId: "flint", sampledIds, perQueryResultIds, k },
  });
  const current = buildQualitySnapshot(report, new Date(NOW).toISOString());
  return { report, current, findings: diffQualitySnapshots(current, previous), cues: rows.map((r) => deriveRecallCue(r)) };
}

const recallFindings = (findings: Array<{ detail: { metric: string } }>) =>
  findings.filter((f) => f.detail.metric.startsWith("recallSpotCheck."));

describe("flair#967 — recall spot-check precision", () => {
  describe("1. alerting authority (RED on main)", () => {
    test("the 2026-08-23 firing pair (0.6 → 0.2) emits NO recall regression — the metric has zero measured lifetime precision, so it no longer carries alerting authority", () => {
      // The literal numbers the nightly sweep mailed on 2026-08-23. Population
      // σ over 32 runs of this metric is 0.291 and the mean absolute
      // run-to-run delta is 0.223 — both LARGER than the 0.2 that declares a
      // regression, so this delta is inside the metric's own noise floor.
      const current: QualitySnapshotCore = { ...previousSnapshot(0.2, 0.12), computedAt: new Date(NOW).toISOString() };
      const findings = diffQualitySnapshots(current, previousSnapshot(0.6, 0.33));
      expect(recallFindings(findings)).toEqual([]);
    });

    test("a full-range swing (1.0 → 0.3, the 2026-07-29 firing) also emits nothing — this is not a threshold that got wider, the emission is gone", () => {
      const current: QualitySnapshotCore = { ...previousSnapshot(0.3, 0.23), computedAt: new Date(NOW).toISOString() };
      const findings = diffQualitySnapshots(current, previousSnapshot(1.0, 0.87));
      expect(recallFindings(findings)).toEqual([]);
    });

    test("replaying the measured duplicate-cue window through the whole sweep emits no recall regression", () => {
      // Previous = 1.0, the maximum this metric actually recorded in its
      // 32-run history (2026-07-29). On main the replayed window scores 0.60,
      // a 0.40 drop, and the sweep mails a recall@k regression AND an MRR
      // regression — the exact 6-for-6 false-alarm behaviour #967 documents.
      const { findings } = replaySweep(MEASURED_WINDOW, previousSnapshot(1.0, 0.87));
      expect(recallFindings(findings)).toEqual([]);
    });

    test("the same replay still MEASURES and RECORDS a number — report-only, not silenced", () => {
      const { report, current } = replaySweep(MEASURED_WINDOW, previousSnapshot(1.0, 0.87));
      expect(report.recallSpotCheck).not.toBeNull();
      expect(report.recallSpotCheck!.sampleSize).toBe(10);
      expect(current.recallSpotCheck).not.toBeNull();
      // And with the cue fixed the replayed window scores the CONTENT arm of
      // the A/B (1.00), not the subject arm (0.60) — the observability number
      // is now worth reading, which is the point of keeping it.
      expect(report.recallSpotCheck!.recallAtK).toBe(1);
    });
  });

  describe("2. cue derivation (RED on main)", () => {
    test("a slug-shaped subject is not a query — content wins over `pr-1359`", () => {
      const row = MEASURED_WINDOW[0];
      const cue = deriveRecallCue(row);
      expect(cue).not.toBe("pr-1359");
      expect(row.content.startsWith(cue.replace(/[.!?]$/, ""))).toBe(true);
    });

    test("date-slug subject (`kern-2026-08-23`) falls back to content too", () => {
      expect(deriveRecallCue({ subject: "kern-2026-08-23", content: "Daily architecture digest about base-copy resync and transaction-log retention." })).not.toBe("kern-2026-08-23");
    });

    test("the tool's own bookkeeping subject (`quality-snapshot/<host>`) is a hostname-shaped slug, not a cue", () => {
      expect(
        deriveRecallCue({ subject: "quality-snapshot/127.0.0.1:9926", content: '{"schemaVersion":1,"computedAt":"2026-08-23T09:00:00.000Z"}' }),
      ).not.toBe("quality-snapshot/127.0.0.1:9926");
    });

    test("CONTROL — a real prose subject is still preferred over content (the fix narrows the subject path, it does not delete it)", () => {
      expect(
        deriveRecallCue({ subject: "Harper RBAC two-gate model", content: "Some long content that would otherwise be the fallback cue." }),
      ).toBe("Harper RBAC two-gate model");
    });

    test("CONTROL — a hyphenated ordinary word is not a slug", () => {
      expect(deriveRecallCue({ subject: "two-gate", content: "irrelevant content" })).toBe("two-gate");
    });

    test("every cue derived from the measured window is unique once the subject preference is narrowed", () => {
      const cues = MEASURED_WINDOW.map((r) => deriveRecallCue(r));
      expect(new Set(cues).size).toBe(cues.length);
    });
  });

  describe("3. positive controls (green on main AND on the branch, by design)", () => {
    test("the diff machinery can still see an emission — a genuine coverage crossing fires", () => {
      const prev = previousSnapshot(0.6, 0.33);
      const current: QualitySnapshotCore = { ...prev, computedAt: new Date(NOW).toISOString(), embeddingCoverage: { coveragePct: 71 } };
      const findings = diffQualitySnapshots(current, prev);
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.some((f) => f.detail.metric === "embeddingCoverage.coveragePct")).toBe(true);
    });

    test("a genuine recall CRATER on a healthy sample is still measured, reported and snapshotted", () => {
      // Ten distinct cues, every single query missing — the "embeddings down /
      // index busted" case this probe exists for. It must still produce a real
      // 0.0, not a gap and not a silence.
      const sampledIds = Array.from({ length: 10 }, (_, i) => `x${i}`);
      const scored = computeRecallSpotCheck(sampledIds, sampledIds.map(() => DISTRACTORS.slice()), QUALITY_RECALL_K);
      expect(scored.recallAtK).toBe(0);
      const report = computeQualityReport(true, healthFixture(), {
        now: NOW,
        agentId: "flint",
        recallSpotCheckData: { ok: true, agentId: "flint", sampledIds, perQueryResultIds: sampledIds.map(() => DISTRACTORS.slice()), k: QUALITY_RECALL_K },
      });
      expect(report.recallSpotCheck).toEqual({ agentId: "flint", recallAtK: 0, mrr: 0, sampleSize: 10, k: QUALITY_RECALL_K });
      expect(report.gaps.some((g) => g.metric === "recallSpotCheck")).toBe(false);
      expect(buildQualitySnapshot(report).recallSpotCheck).toEqual({ recallAtK: 0, mrr: 0 });
    });

    test("the drop threshold literal is UNCHANGED at 0.2 — the fix removed the emission, it did not widen the gate", () => {
      expect(QUALITY_EVENT_RECALL_DROP_THRESHOLD).toBe(0.2);
    });
  });

  describe("4. sample-health guard — fail closed, visibly", () => {
    /** n rows, newest first, with the given (subject, content) pairs. */
    const rows = (specs: Array<{ subject?: string; content?: string; type?: string; id?: string }>) =>
      specs.map((s, i) => ({
        id: s.id ?? `m${String(i).padStart(2, "0")}`,
        subject: s.subject ?? "",
        content: s.content ?? `Distinct content number ${i} about an entirely separate topic from the others in this window.`,
        createdAt: new Date(NOW - i * 60_000).toISOString(),
        ...(s.type ? { type: s.type } : {}),
      }));

    test("the measured window is HEALTHY once cues come from content — ten distinct cues, ten queries", () => {
      const plan = planRecallSpotCheck(MEASURED_WINDOW);
      expect(plan.health.healthy).toBe(true);
      expect(plan.sampled).toHaveLength(10);
      expect(new Set(plan.sampled.map((s) => s.cue)).size).toBe(10);
    });

    test("duplicate cues → UNHEALTHY, and the reason NAMES the colliding cue", () => {
      // Two memories whose content ALSO collides — the residual case the
      // cue fix cannot rescue (genuine near-duplicate writes).
      const dupe = "Kern review of the release burst: all four PRs share one changelog fragment.";
      const plan = planRecallSpotCheck(rows([{ content: dupe }, { content: dupe }, ...Array.from({ length: 8 }, () => ({}))]));
      expect(plan.health.healthy).toBe(false);
      expect(plan.health.duplicateCues).toHaveLength(1);
      expect(plan.health.reason).toContain("sample unhealthy");
      expect(plan.health.reason).toContain("displace each other");
      expect(plan.health.reason).toContain(dupe.slice(0, 40));
    });

    test("a memory with neither subject nor content → UNHEALTHY (no derivable cue), counted not hidden", () => {
      const plan = planRecallSpotCheck(rows([{ subject: "", content: "" }, ...Array.from({ length: 9 }, () => ({}))]));
      expect(plan.health.healthy).toBe(false);
      expect(plan.health.emptyCueCount).toBe(1);
      expect(plan.health.reason).toContain("no derivable cue");
    });

    test("the spot-check never grades its own bookkeeping — quality-snapshot rows are excluded before sampling", () => {
      const withSnapshots = rows([
        { id: "snap-1", subject: "quality-snapshot/127.0.0.1:9926", content: '{"schemaVersion":1,"computedAt":"a"}', type: "quality-snapshot" },
        { id: "snap-2", subject: "quality-snapshot/127.0.0.1:9926", content: '{"schemaVersion":1,"computedAt":"b"}' },
        ...Array.from({ length: 10 }, () => ({})),
      ]);
      const plan = planRecallSpotCheck(withSnapshots);
      expect(plan.excludedSnapshotRows).toBe(2);
      expect(plan.sampled.map((s) => s.id)).not.toContain("snap-1");
      expect(plan.sampled.map((s) => s.id)).not.toContain("snap-2");
      expect(plan.sampled).toHaveLength(QUALITY_RECALL_SAMPLE_SIZE);
      expect(plan.health.healthy).toBe(true);
    });

    test("an unhealthy sample reaches the report as a null metric + a self-describing gap, never as a number", () => {
      const dupe = "Identical content in two sampled memories.";
      const plan = planRecallSpotCheck(rows([{ content: dupe }, { content: dupe }, ...Array.from({ length: 8 }, () => ({}))]));
      const report = computeQualityReport(true, healthFixture(), {
        now: NOW,
        agentId: "flint",
        recallSpotCheckData: { ok: false, agentId: "flint", skipReason: plan.health.reason, sampleHealth: plan.health },
      });
      expect(report.recallSpotCheck).toBeNull();
      const gap = report.gaps.find((g) => g.metric === "recallSpotCheck");
      expect(gap?.reason).toContain("sample unhealthy");

      // ...and an unscorable run cannot become a phantom regression next
      // night either: a null section on either side of the diff is a gap, not
      // a drop (pre-existing missing-data rule, re-asserted here because the
      // fail-closed guard is what now produces those nulls).
      const current = buildQualitySnapshot(report, new Date(NOW).toISOString());
      expect(current.recallSpotCheck).toBeNull();
      expect(diffQualitySnapshots(current, previousSnapshot(1.0, 0.87))).toEqual([]);
    });

    test("sorting is still newest-first over the SCORABLE rows only", () => {
      const plan = planRecallSpotCheck(rows(Array.from({ length: 14 }, () => ({}))));
      expect(plan.sampled.map((s) => s.id)).toEqual(["m00", "m01", "m02", "m03", "m04", "m05", "m06", "m07", "m08", "m09"]);
    });

    test("too few scorable rows after excluding bookkeeping → a short plan the caller must skip on", () => {
      const plan = planRecallSpotCheck(
        rows([...Array.from({ length: 4 }, (_, i) => ({ id: `snap-${i}`, subject: "quality-snapshot/127.0.0.1:9926", type: "quality-snapshot" })), ...Array.from({ length: 8 }, () => ({}))]),
      );
      expect(plan.excludedSnapshotRows).toBe(4);
      expect(plan.sampled.length).toBeLessThan(QUALITY_RECALL_SAMPLE_SIZE);
    });

    test("empty input is not a crash and not a healthy empty sample", () => {
      const plan = planRecallSpotCheck([]);
      expect(plan.sampled).toEqual([]);
      expect(plan.health.healthy).toBe(true); // vacuously — the caller's sampleSize check is what rejects it
      expect(plan.excludedSnapshotRows).toBe(0);
    });
  });

  describe("5. isDiscriminativeSubject — the rule, stated", () => {
    test.each([
      ["Harper RBAC two-gate model", true],
      ["two-gate", true],
      ["Rotate the admin password", true],
      ["Harper 5.2 upgrade", true], // whitespace ⇒ prose, digits are fine inside a phrase
      ["ops", true],
      ["pr-1359", false],
      ["kern-2026-08-23", false],
      ["quality-snapshot/127.0.0.1:9926", false],
      ["v0.48.0", false],
      ["session_notes", false],
      ["README.md", false],
      ["x", false],
      ["", false],
      ["---", false],
      ["42", false],
    ])("%s → discriminative: %s", (subject, expected) => {
      expect(isDiscriminativeSubject(subject as string)).toBe(expected);
    });

    test("null/undefined are not discriminative (no crash)", () => {
      expect(isDiscriminativeSubject(null)).toBe(false);
      expect(isDiscriminativeSubject(undefined)).toBe(false);
    });
  });
});
