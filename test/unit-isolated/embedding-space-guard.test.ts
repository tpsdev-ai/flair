/**
 * embedding-space-guard.test.ts — the query-time vector-space uniformity gate
 * (resources/embedding-space-guard.ts, embedding-provider-seam design §3,
 * slice 1). Covers the PURE core (bare-name → `gguf:` equivalence) and the
 * boot-computed + write-maintained LATCH via the module's test seams.
 *
 * Runs in test/unit-isolated (its own bun process) so the `mock.module("harper")`
 * below never collides with another file's harper import/mock in a shared
 * `bun test test/unit` process.
 */
import { describe, it, expect, beforeEach, mock } from "bun:test";

// The guard dynamic-imports "harper" only inside its scan (deferred). Mock it
// so the module-scope boot pre-warm's scan resolves to a stub and never loads
// real Harper; every latch test injects its own fake table via the test seams.
mock.module("harper", () => ({ databases: {} }));

const {
  normalizeStamp,
  stripEnginePrefix,
  currentSpaceRawForms,
  isCurrentSpaceStamp,
  isUniformStampSet,
  isEmbeddingSpaceUniform,
  embeddingSpaceVerdict,
  spaceGuardState,
  noteWriteStamp,
  recomputeLatch,
  spaceGuardDiagnostics,
  SCAN_ERROR_TABLE_UNAVAILABLE,
  _setGuardTableGetterForTests,
  _setGuardModelIdForTests,
  _resetGuardForTests,
} = await import("../../resources/embedding-space-guard.ts");

const CURRENT = "gguf:nomic-embed-text-v1.5-Q4_K_M+searchprefix";
const BARE = "nomic-embed-text-v1.5-Q4_K_M+searchprefix";
const FOREIGN = "gemma-embed:768"; // a genuinely different vector space

/** A fake Memory table over a MUTABLE stamp list (mutate then recomputeLatch()
 *  to simulate a re-embed converging the corpus). */
function fakeTableOver(stamps: (string | null | undefined)[]) {
  return async () => ({
    search(_q: unknown) {
      async function* gen() {
        for (const s of stamps) yield { embeddingModel: s };
      }
      return gen();
    },
  });
}

describe("embedding-space-guard — pure core (bare-name → gguf: equivalence)", () => {
  it("normalizeStamp: a bare legacy name canonicalizes to the gguf-qualified space", () => {
    expect(normalizeStamp(BARE)).toBe(CURRENT);
    expect(normalizeStamp(CURRENT)).toBe(CURRENT); // qualified is idempotent
    expect(normalizeStamp("nomic-embed-text-v1.5-Q4_K_M")).toBe("gguf:nomic-embed-text-v1.5-Q4_K_M");
  });

  it("normalizeStamp: no-vector stamps are null (never a space)", () => {
    expect(normalizeStamp(null)).toBeNull();
    expect(normalizeStamp(undefined)).toBeNull();
    expect(normalizeStamp("")).toBeNull();
    expect(normalizeStamp("   ")).toBeNull();
    expect(normalizeStamp("hash-512d")).toBeNull();
  });

  it("normalizeStamp: a different engine stays distinct from gguf", () => {
    expect(normalizeStamp("milton:nomic-embed-text-v1.5-Q4_K_M+searchprefix")).toBe(
      "milton:nomic-embed-text-v1.5-Q4_K_M+searchprefix",
    );
    expect(normalizeStamp("milton:nomic-embed-text-v1.5-Q4_K_M+searchprefix")).not.toBe(CURRENT);
  });

  it("stripEnginePrefix / currentSpaceRawForms", () => {
    expect(stripEnginePrefix(CURRENT)).toBe(BARE);
    expect(stripEnginePrefix(BARE)).toBe(BARE); // no engine prefix → unchanged
    expect(new Set(currentSpaceRawForms(CURRENT))).toEqual(new Set([CURRENT, BARE]));
    expect(currentSpaceRawForms(BARE)).toEqual([BARE]); // a bare current dedups to one form (unit-test injection)
  });

  it("isCurrentSpaceStamp: bare AND qualified both count as current", () => {
    expect(isCurrentSpaceStamp(BARE, CURRENT)).toBe(true);
    expect(isCurrentSpaceStamp(CURRENT, CURRENT)).toBe(true);
    expect(isCurrentSpaceStamp("some-old-model", CURRENT)).toBe(false);
    expect(isCurrentSpaceStamp(null, CURRENT)).toBe(false);
  });

  it("isUniformStampSet: bare+qualified of one space is uniform; a foreign space is not", () => {
    expect(isUniformStampSet([BARE, CURRENT, null, "hash-512d"], CURRENT)).toBe(true);
    expect(isUniformStampSet([], CURRENT)).toBe(true); // fresh store
    expect(isUniformStampSet([BARE, FOREIGN], CURRENT)).toBe(false);
  });
});

describe("embedding-space-guard — latch", () => {
  beforeEach(() => {
    _resetGuardForTests();
    _setGuardModelIdForTests(() => CURRENT);
  });

  it("(d) a uniform bare-name corpus (today's corpus) does NOT trip", async () => {
    _setGuardTableGetterForTests(fakeTableOver([BARE, BARE, null]));
    expect(await recomputeLatch()).toBe(true);
    expect(await isEmbeddingSpaceUniform()).toBe(true);
  });

  it("(a/c) a mixed-space corpus trips; converging + recompute REOPENS the gate", async () => {
    const stamps: (string | null | undefined)[] = [BARE, FOREIGN];
    _setGuardTableGetterForTests(fakeTableOver(stamps));

    expect(await recomputeLatch()).toBe(false);
    expect(await isEmbeddingSpaceUniform()).toBe(false);

    // Re-embed converges the corpus to a single space (bare + qualified = one).
    stamps.length = 0;
    stamps.push(CURRENT, BARE);
    expect(await recomputeLatch()).toBe(true); // "re-embed completion clears it"
    expect(await isEmbeddingSpaceUniform()).toBe(true);
  });

  it("a foreign-stamp write trips an OPEN latch; current/bare writes never do", async () => {
    _setGuardTableGetterForTests(fakeTableOver([BARE]));
    expect(await recomputeLatch()).toBe(true);

    noteWriteStamp(CURRENT); // local write — current space
    expect(await isEmbeddingSpaceUniform()).toBe(true);
    noteWriteStamp(BARE); // bare == current space
    expect(await isEmbeddingSpaceUniform()).toBe(true);
    noteWriteStamp("hash-512d"); // no real vector — never a space
    expect(await isEmbeddingSpaceUniform()).toBe(true);

    noteWriteStamp("milton:foo"); // a foreign space (federation / replication)
    expect(await isEmbeddingSpaceUniform()).toBe(false);
  });

  it("diagnostics name the current space and the foreign stamps observed", async () => {
    _setGuardTableGetterForTests(fakeTableOver([BARE, FOREIGN]));
    await recomputeLatch();
    const d = spaceGuardDiagnostics();
    expect(d.current).toBe(CURRENT);
    expect(d.found).toContain(FOREIGN);
  });

  it("before the first scan completes the verdict is UNKNOWN and fails CLOSED", async () => {
    // A table read that never resolves: no scan reaches a verdict.
    _setGuardTableGetterForTests(() => new Promise<never>(() => {}));
    const v = await embeddingSpaceVerdict();
    expect(v.uniform).toBe(false); // not known uniform ⇒ the caller's mixed path
    expect(v.state).toBe("unverified");
    expect(spaceGuardState()).toEqual({ state: "unverified", reason: null });
  });

  it("a scan that throws leaves an unknown verdict, names it, and logs its class once", async () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(" ")); };
    try {
      _setGuardTableGetterForTests(async () => { throw new Error("no live table (boot race)"); });
      expect(await recomputeLatch()).toBe(false); // scan A fails; fail closed, not a cached true
      const v = await embeddingSpaceVerdict(); // a consult fires scan B, snapshots now
      expect(v.uniform).toBe(false);
      expect(v.state).toBe("scan-failed");
      expect(v.reason).toBe(SCAN_ERROR_TABLE_UNAVAILABLE);
      // scan B fails too; still only ONE log line for the error class.
      await new Promise((r) => setTimeout(r, 25));
      expect(warns.filter((w) => w.includes("corpus scan failed")).length).toBe(1);
    } finally {
      console.warn = orig;
    }
  });

  it("a later successful scan clears the failed state", async () => {
    _setGuardTableGetterForTests(async () => { throw new Error("transient"); });
    expect(await recomputeLatch()).toBe(false);
    _setGuardTableGetterForTests(fakeTableOver([BARE, BARE, null]));
    expect(await recomputeLatch()).toBe(true);
    const v = await embeddingSpaceVerdict();
    expect(v.uniform).toBe(true);
    expect(v.state).toBe("uniform");
    expect(await isEmbeddingSpaceUniform()).toBe(true);
  });
});
