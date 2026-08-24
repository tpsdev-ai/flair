/**
 * Unit tests for the paired reader-payload A/B: the slice selection rule, the
 * gold-evidence id mapping, the McNemar read, and the artifact partition it
 * shares with the four-arm artifact.
 *
 * Every check here carries a POSITIVE CONTROL — a mutation that must make it
 * fail — because the failure mode these guard against is a check that cannot
 * fire (the exact reason the 30-question smoke slice could not measure the
 * dated payload: it was at its ceiling).
 */
import { describe, expect, test } from "bun:test";
import { formatRetrievedAs, PAYLOAD_FORMATS } from "../bench/longmemeval/arms";
import { selectAbilitySlice, goldEvidenceFor, abilityOf, type LmeEntry } from "../bench/longmemeval/dataset";
import { mcnemarExact, pairedTable, binomialUpperTail } from "../bench/longmemeval/paired-stats";
import { stampArtifactHash, verifyStampedHash, hashedContent, PROVENANCE_KEYS } from "../bench/longmemeval/artifact";

// ── fixtures ─────────────────────────────────────────────────────────────────

function mkEntry(id: string, type = "temporal-reasoning"): LmeEntry {
  return {
    question_id: id,
    question_type: type as LmeEntry["question_type"],
    question: "q?",
    answer: "a",
    question_date: "2023/05/20 (Sat) 02:21",
    haystack_dates: ["2023/05/01 (Mon) 10:00", "2023/05/02 (Tue) 10:00"],
    haystack_session_ids: ["sess_noise", "answer_sess"],
    haystack_sessions: [
      [{ role: "user", content: "noise" }, { role: "assistant", content: "noise2" }],
      [{ role: "user", content: "gold q", has_answer: true }, { role: "assistant", content: "gold a", has_answer: true }],
    ],
    answer_session_ids: ["answer_sess"],
  };
}

// ── payload formats ──────────────────────────────────────────────────────────

describe("formatRetrievedAs", () => {
  const items = [
    { id: "a", score: 1, content: "first", createdAt: "2023-05-01T10:00:00.000Z" },
    { id: "b", score: 0.5, content: "second" }, // no createdAt
  ];

  test("v1-undated emits bare lines even when a createdAt is present", () => {
    expect(formatRetrievedAs(items, "v1-undated")).toBe("- first\n- second");
  });

  test("v2-dated prefixes the date, and falls back to the bare line without one", () => {
    expect(formatRetrievedAs(items, "v2-dated")).toBe("- [2023-05-01] first\n- second");
  });

  test("the two formats actually differ on dated input (positive control)", () => {
    // If this ever passes trivially, the A/B is measuring nothing.
    expect(formatRetrievedAs(items, "v1-undated")).not.toBe(formatRetrievedAs(items, "v2-dated"));
  });

  test("both sides of the A/B are declared formats", () => {
    expect(PAYLOAD_FORMATS).toContain("v1-undated");
    expect(PAYLOAD_FORMATS).toContain("v2-dated");
  });

  test("empty retrieval is the same sentinel either way", () => {
    expect(formatRetrievedAs([], "v1-undated")).toBe("(no relevant memory found)");
    expect(formatRetrievedAs([], "v2-dated")).toBe("(no relevant memory found)");
  });
});

// ── slice selection ──────────────────────────────────────────────────────────

describe("selectAbilitySlice", () => {
  const pool: LmeEntry[] = [];
  for (let i = 0; i < 40; i++) pool.push(mkEntry(`q${String(i).padStart(3, "0")}`));
  for (let i = 0; i < 10; i++) pool.push(mkEntry(`m${i}`, "multi-session"));
  // abstention variants of the target ability — must be excluded by construction
  for (let i = 0; i < 5; i++) pool.push(mkEntry(`q_abs_${i}`));

  test("selects only the requested ability and excludes abstention variants", () => {
    const slice = selectAbilitySlice(pool, "temporal-reasoning", 20, 0);
    expect(slice).toHaveLength(20);
    for (const e of slice) {
      expect(abilityOf(e)).toBe("temporal-reasoning");
      expect(e.question_id).not.toContain("_abs");
    }
  });

  test("is deterministic for a given (n, seed) and stably ordered", () => {
    const a = selectAbilitySlice(pool, "temporal-reasoning", 20, 0).map((e) => e.question_id);
    const b = selectAbilitySlice(pool, "temporal-reasoning", 20, 0).map((e) => e.question_id);
    expect(a).toEqual(b);
    expect(a).toEqual([...a].sort());
    // Input order must not matter — the config hash commits to the id set.
    const shuffled = [...pool].reverse();
    expect(selectAbilitySlice(shuffled, "temporal-reasoning", 20, 0).map((e) => e.question_id)).toEqual(a);
  });

  test("a different seed draws a different sample (positive control)", () => {
    const a = selectAbilitySlice(pool, "temporal-reasoning", 20, 0).map((e) => e.question_id);
    const b = selectAbilitySlice(pool, "temporal-reasoning", 20, 1).map((e) => e.question_id);
    expect(a).not.toEqual(b);
  });

  test("the draw is NOT a lexicographic prefix", () => {
    // The whole point of hashing the id: a prefix draw confounds question
    // provenance (gpt4_*) with the treatment.
    const slice = selectAbilitySlice(pool, "temporal-reasoning", 20, 0).map((e) => e.question_id);
    const lexFirst20 = pool
      .filter((e) => abilityOf(e) === "temporal-reasoning")
      .map((e) => e.question_id).sort().slice(0, 20);
    expect(slice).not.toEqual(lexFirst20);
  });

  test("refuses a short slice rather than silently returning fewer", () => {
    expect(() => selectAbilitySlice(pool, "multi-session", 25, 0)).toThrow(/only 10 exist/);
  });
});

// ── gold-evidence mapping ────────────────────────────────────────────────────

describe("goldEvidenceFor", () => {
  test("maps answer sessions and has_answer turns into ingest event ids", () => {
    const g = goldEvidenceFor(mkEntry("qX"));
    expect(g.sessionIds).toEqual(["answer_sess"]);
    expect(g.sessionEventIds).toEqual(["qX__s1__t0", "qX__s1__t1"]);
    expect(g.answerEventIds).toEqual(["qX__s1__t0", "qX__s1__t1"]);
    expect(g.unresolvedSessionIds).toEqual([]);
  });

  test("ignores turns outside the labelled answer sessions", () => {
    const e = mkEntry("qY");
    e.haystack_sessions[0]![0]!.has_answer = true; // a has_answer turn in a NOISE session
    const g = goldEvidenceFor(e);
    expect(g.answerEventIds).not.toContain("qY__s0__t0");
  });

  test("reports an unmappable label instead of silently scoring zero (positive control)", () => {
    const e = mkEntry("qZ");
    e.answer_session_ids = ["a_session_that_is_not_in_the_haystack"];
    const g = goldEvidenceFor(e);
    expect(g.sessionEventIds).toHaveLength(0);
    expect(g.unresolvedSessionIds).toEqual(["a_session_that_is_not_in_the_haystack"]);
  });

  test("the ids it emits match the ids the ingest actually writes", () => {
    // Guards the one drift that would make the attribution read decorative:
    // dataset.entryToSessions builds `<qid>__s<si>__t<ti>` — if that template
    // ever changes, this fails instead of the coverage silently going to 0.
    const e = mkEntry("qW");
    const g = goldEvidenceFor(e);
    const { entryToSessions } = require("../bench/longmemeval/dataset");
    const ingestIds: string[] = entryToSessions(e).flatMap((s: any) => s.events.map((ev: any) => ev.id));
    for (const id of g.sessionEventIds) expect(ingestIds).toContain(id);
  });
});

// ── the paired statistic ─────────────────────────────────────────────────────

describe("pairedTable", () => {
  test("partitions into the four cells and derives accuracies from them", () => {
    const t = pairedTable([
      { v1: true, v2: true },   // both right
      { v1: true, v2: true },
      { v1: false, v2: false }, // both wrong
      { v1: false, v2: true },  // win
      { v1: false, v2: true },
      { v1: true, v2: false },  // loss
    ]);
    expect(t).toMatchObject({ bothRight: 2, bothWrong: 1, wins: 2, losses: 1, n: 6 });
    expect(t.v1Accuracy).toBeCloseTo(3 / 6);
    expect(t.v2Accuracy).toBeCloseTo(4 / 6);
    // The identity that makes the paired read legible: delta == (wins-losses)/n.
    expect(t.delta).toBeCloseTo((t.wins - t.losses) / t.n);
  });
});

describe("mcnemarExact", () => {
  test("no discordant pairs means no evidence either way", () => {
    const r = mcnemarExact(0, 0);
    expect(r).toMatchObject({ discordant: 0, p: 1, direction: "tie" });
  });

  test("an even split is maximally uninformative", () => {
    expect(mcnemarExact(5, 5).p).toBe(1);
    expect(mcnemarExact(5, 5).direction).toBe("tie");
  });

  test("matches the closed form on a known split", () => {
    // 9 wins / 1 loss out of 10 discordant: 2 * P(X>=9), X~Bin(10,0.5)
    //   = 2 * (10 + 1)/1024 = 22/1024 = 0.021484375
    expect(mcnemarExact(9, 1).p).toBeCloseTo(0.021484375, 9);
    expect(mcnemarExact(9, 1).direction).toBe("v2");
    // symmetric in the arguments, opposite lean
    expect(mcnemarExact(1, 9).p).toBeCloseTo(0.021484375, 9);
    expect(mcnemarExact(1, 9).direction).toBe("v1");
  });

  test("a small lopsided split is NOT significant — the underpowered case", () => {
    // 4-0 => 2 * 1/16 = 0.125. A harness that called this significant would be
    // the check-that-cannot-fire failure in its most expensive form.
    expect(mcnemarExact(4, 0).p).toBeCloseTo(0.125, 9);
    expect(mcnemarExact(4, 0).p).toBeGreaterThan(0.05);
    // ...and it reports that NO split at d=4 could have reached p<0.05.
    expect(mcnemarExact(4, 0).minSplitForP05).toBeNull();
    // at d=6, a clean sweep would have: 2*(1/64) = 0.03125
    expect(mcnemarExact(3, 3).minSplitForP05).toBe(6);
  });

  test("binomialUpperTail is a proper tail", () => {
    expect(binomialUpperTail(10, 0)).toBe(1);
    expect(binomialUpperTail(10, 11)).toBe(0);
    expect(binomialUpperTail(10, 5) + binomialUpperTail(10, 6)).toBeGreaterThan(1); // overlapping tails
    expect(binomialUpperTail(4, 4)).toBeCloseTo(1 / 16, 12);
  });
});

// ── artifact partition (shared with the four-arm artifact) ───────────────────

describe("artifact content/provenance partition", () => {
  const base = () => ({
    schema: "longmemeval-s.payload-ab.artifact/1",
    configHash: "cfg",
    results: { wins: 3, losses: 1 },
    notice: "NOT FOR PUBLICATION",
    generatedAt: "2026-08-23T00:00:00.000Z",
    host: { ollama: "https://ollama.com", benchHost: "tps-bench" },
  });

  test("provenance never enters the hash — same content, different host/clock, same hash", () => {
    const a = stampArtifactHash(base());
    const b = stampArtifactHash({ ...base(), generatedAt: "2027-01-01T00:00:00.000Z", host: { ollama: "x", benchHost: "y" } });
    expect(a.artifactHash).toBe(b.artifactHash);
    expect(verifyStampedHash(a)).toBe(true);
  });

  test("content DOES enter the hash (positive control)", () => {
    const a = stampArtifactHash(base());
    const b = stampArtifactHash({ ...base(), results: { wins: 4, losses: 1 } });
    expect(a.artifactHash).not.toBe(b.artifactHash);
  });

  test("a tampered artifact fails verification", () => {
    const a = stampArtifactHash(base()) as any;
    a.results.wins = 99;
    expect(verifyStampedHash(a)).toBe(false);
  });

  test("the partition list is the single source of truth", () => {
    const content = hashedContent(stampArtifactHash(base()));
    for (const k of PROVENANCE_KEYS) expect(content).not.toHaveProperty(k);
    expect(content).toHaveProperty("results");
  });
});
