// ─── the guard that outlives our attention on it ────────────────────────────
//
// The corpus profiler (test/bench/corpus-profiler/) measures a REAL memory
// corpus. Its entire safety argument is that it emits numbers and nothing
// else. This file is what keeps that true after everyone has stopped thinking
// about it.
//
// It lives in test/unit/ rather than next to the profiler ON PURPOSE: CI runs
// `bun test test/unit/` and does NOT sweep test/bench/. A privacy guard that
// only runs when someone remembers to run it is the same failure shape as the
// benchmark nobody ran — a control that reports nothing when it should report
// failure. It is hermetic (no network, no Harper, no live instance), so it
// belongs in that job.
//
// Two independent checks, because they fail in different ways:
//
//  1. STRUCTURAL — every emitted leaf is a finite number, apart from a closed
//     `meta` enum. Catches a new field of any string type.
//  2. SUBSTRING — the profiler is run over a fabricated corpus stuffed with
//     distinctive markers, and none of them may appear in the serialised
//     output. Catches the specific bad idea the schema most invites: emitting
//     "the top 20 terms" or "the largest cluster's subject" alongside their
//     counts.
//
// The substring check is the one that would have caught the mistake we are
// most likely to actually make, so it is not redundant with the structural one.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { computeProfile, type ProfileRecord } from "../bench/corpus-profiler/compute.ts";
import { findViolations, assertNumericOnly, META_ALLOWLIST } from "../bench/corpus-profiler/guard.ts";

const DIM = 24;

/**
 * Distinctive markers standing in for the things that actually leak: a
 * codename, an internal host, a path, a person, a URL, a record id. None are
 * secret in FORM — which is exactly why redaction cannot catch them and why
 * the profiler must never carry text at all.
 */
const MARKERS = [
  "zarquon",
  "buildbox7internal",
  "usrlocalsecretpath",
  "personnamehere",
  "examplecorpinternal",
  "recordid8842",
];

function seededVector(i: number, cluster: number): number[] {
  // Cheap deterministic vectors with real cluster structure and a couple of
  // deliberate near-duplicate pairs, so the near-duplicate and clustering code
  // paths are genuinely exercised rather than short-circuited on empty input.
  const v: number[] = [];
  for (let t = 0; t < DIM; t++) {
    const base = Math.sin((cluster + 1) * (t + 1) * 0.7);
    const jitter = Math.sin((i + 1) * (t + 1) * 0.013) * 0.15;
    v.push(base + jitter);
  }
  return v;
}

function fabricateCorpus(n = 60): ProfileRecord[] {
  const out: ProfileRecord[] = [];
  const durabilities = ["permanent", "persistent", "standard", "ephemeral", "weird-unknown-value"];
  for (let i = 0; i < n; i++) {
    const cluster = i % 4;
    const marker = MARKERS[i % MARKERS.length];
    out.push({
      content:
        `${marker} decision note ${i} about ${marker} and the ${MARKERS[(i + 1) % MARKERS.length]} rollout, ` +
        `revisited across weeks with overlapping wording so the tokeniser sees a real vocabulary tail`,
      createdAt: `2026-0${(i % 5) + 1}-${String((i % 27) + 1).padStart(2, "0")}T12:00:00.000Z`,
      agentId: `agent-${i % 3}`,
      embedding: seededVector(i % 2 === 0 ? i : i - 1, cluster), // even/odd pairs are near-duplicates
      embeddingModel: "nomic-embed-text-v1.5-Q4_K_M+searchprefix",
      durability: durabilities[i % durabilities.length],
      tags: i % 3 === 0 ? [`tag-${marker}`, "shared-tag"] : [],
      archived: false,
    });
  }
  return out;
}

describe("corpus profile privacy guard", () => {
  const profile = computeProfile(fabricateCorpus(), { profiledMonth: "2026-07" });
  const serialised = JSON.stringify(profile);

  test("a real profile run emits only numbers and allowlisted meta", () => {
    const violations = findViolations(profile);
    expect(violations.map((v) => `${v.path}: ${v.reason}`)).toEqual([]);
    expect(() => assertNumericOnly(profile)).not.toThrow();
  });

  test("no corpus text survives serialisation", () => {
    // Safe to assert this way ONLY because `serialised` comes from the
    // fabricated corpus above — a failure here prints invented markers, never
    // anything real. Never point this assertion at a live profile.
    for (const marker of MARKERS) {
      expect(serialised.toLowerCase()).not.toContain(marker);
    }
    // Agent identity, tag names and unrecognised durability labels are read by
    // the profiler and must be counted, never carried.
    expect(serialised).not.toContain("agent-");
    expect(serialised).not.toContain("shared-tag");
    expect(serialised).not.toContain("weird-unknown-value");
  });

  test("no timestamp finer than a month survives", () => {
    // The fabricated corpus carries full ISO timestamps; nothing day-level or
    // finer may reach the output.
    expect(serialised).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(serialised).not.toContain("T12:00:00");
  });

  test("the profile round-trips through JSON unchanged", () => {
    // NaN/Infinity serialise to null and would silently change the schema.
    expect(JSON.parse(serialised)).toEqual(profile);
    expect(serialised).not.toContain("null");
  });

  describe("the guard actually rejects things", () => {
    // A guard nobody has watched fail is a guard nobody knows works.

    test("rejects a string leaf anywhere in the tree", () => {
      const leaky = JSON.parse(serialised);
      leaky.vocabulary.topTerms = ["zarquon", "buildbox7internal"];
      const v = findViolations(leaky);
      expect(v.length).toBeGreaterThan(0);
      expect(v.some((x) => x.path.startsWith("vocabulary.topTerms"))).toBe(true);
      expect(() => assertNumericOnly(leaky)).toThrow(/privacy guard/);
    });

    test("rejects a string smuggled into a deeply nested field", () => {
      const leaky = JSON.parse(serialised);
      leaky.clusters.sizesSorted[0] = "cluster about the acme migration";
      expect(findViolations(leaky).some((x) => x.path === "clusters.sizesSorted[0]")).toBe(true);
    });

    test("rejects booleans and nulls, not just strings", () => {
      for (const bad of [true, null]) {
        const leaky = JSON.parse(serialised);
        leaky.scale.somethingNew = bad;
        expect(findViolations(leaky).some((x) => x.path === "scale.somethingNew")).toBe(true);
      }
    });

    test("rejects NaN and Infinity", () => {
      for (const bad of [NaN, Infinity, -Infinity]) {
        const leaky = { ...profile, scale: { ...profile.scale, recordCount: bad } };
        expect(findViolations(leaky).some((x) => x.path === "scale.recordCount")).toBe(true);
      }
    });

    test("rejects a meta key that is not on the allowlist", () => {
      const leaky = JSON.parse(serialised);
      leaky.meta.sourceHost = "rockit.internal";
      const v = findViolations(leaky);
      expect(v.some((x) => x.path === "meta.sourceHost")).toBe(true);
    });

    test("rejects an off-enum value for an allowlisted meta key", () => {
      const leaky = JSON.parse(serialised);
      leaky.meta.tokenizer = "/Users/someone/custom-tokenizer.ts";
      expect(findViolations(leaky).some((x) => x.path === "meta.tokenizer")).toBe(true);
    });

    test("rejects a day-granularity month stamp", () => {
      const leaky = JSON.parse(serialised);
      leaky.meta.profiledMonth = "2026-07-28";
      expect(findViolations(leaky).some((x) => x.path === "meta.profiledMonth")).toBe(true);
    });

    test("never reproduces the offending value in its own error", () => {
      // A guard that prints what it caught has published it to the terminal,
      // the CI log, and the PR comment quoting the CI log. Same failure shape
      // as redacting a secret with sed.
      const leaky = JSON.parse(serialised);
      leaky.vocabulary.topTerm = "zarquon-internal-codename";
      leaky.meta.sourceHost = "buildbox7.internal";
      let message = "";
      try {
        assertNumericOnly(leaky);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain("vocabulary.topTerm");
      expect(message).toContain("meta.sourceHost");
      expect(message).not.toContain("zarquon");
      expect(message).not.toContain("buildbox7");
    });
  });

  test("meta allowlist has no free-form escape hatch", () => {
    // Every allowlist entry must be a closed literal set or an anchored
    // pattern. A rule like /.*/ would pass review as "an allowlist" while
    // admitting anything.
    for (const [key, rule] of Object.entries(META_ALLOWLIST)) {
      if (rule instanceof RegExp) {
        expect(rule.source.startsWith("^"), `${key} pattern must be anchored at the start`).toBe(true);
        expect(rule.source.endsWith("$"), `${key} pattern must be anchored at the end`).toBe(true);
        expect(rule.test("anything at all"), `${key} pattern is too permissive`).toBe(false);
      } else {
        expect(Array.isArray(rule)).toBe(true);
        expect(rule.length).toBeGreaterThan(0);
      }
    }
  });

  test("every committed profile passes the guard", () => {
    // A profile artefact is only safe to keep in the repo for as long as it
    // still satisfies the same rule the profiler was held to. This re-checks
    // the FILES, not just the code that produced them — so hand-editing one,
    // or committing an output from a future profiler that added a field,
    // fails here rather than at review-time attention.
    const dir = join(import.meta.dir, "..", "bench", "corpus-profiler", "profiles");
    if (!existsSync(dir)) return;
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const parsed = JSON.parse(readFileSync(join(dir, f), "utf8"));
      expect(
        findViolations(parsed).map((v) => `${f} ${v.path}: ${v.reason}`),
        `committed profile ${f} must be numeric-only`,
      ).toEqual([]);
    }
  });
});
