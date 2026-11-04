/**
 * embedding-space-latch-scan-race-2481.test.ts — flair#2481.
 *
 * A scan must not reopen the latch if a foreign-stamp write is noted during it.
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
  isEmbeddingSpaceUniform,
  noteWriteStamp,
  recomputeLatch,
  _setGuardTableGetterForTests,
  _setGuardModelIdForTests,
  _resetGuardForTests,
} = await import("../../resources/embedding-space-guard.ts");

const CURRENT = "gguf:nomic-embed-text-v1.5-Q4_K_M+searchprefix";
const FOREIGN = "gemma-embed:768"; // a genuinely different vector space

/** A fake Memory table over a MUTABLE stamp list. */
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

/** A fake table whose read PARKS until `release()` is called, so a write can be
 *  noted while a scan is provably mid-read. `parked` resolves once the scan has
 *  entered the table read. */
function gatedTableOver(stamps: (string | null | undefined)[]) {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let markParked!: () => void;
  const parked = new Promise<void>((r) => { markParked = r; });
  return {
    release,
    parked,
    getter: async () => ({
      search(_q: unknown) {
        async function* gen() {
          markParked();
          await gate;
          for (const s of stamps) yield { embeddingModel: s };
        }
        return gen();
      },
    }),
  };
}

describe("embedding-space-guard — concurrent scan/write (flair#2481)", () => {
  beforeEach(() => {
    _resetGuardForTests();
    _setGuardModelIdForTests(() => CURRENT);
  });

  it("a scan does not reopen the latch when a foreign write is noted during it", async () => {
    const g = gatedTableOver([]); // the scan will find no foreign stamp
    _setGuardTableGetterForTests(g.getter);

    noteWriteStamp(FOREIGN); // a foreign write is noted (the latch trips)
    const scan = recomputeLatch(); // a scan starts and parks mid-read
    await g.parked;

    noteWriteStamp(FOREIGN); // a SECOND foreign write is noted while the scan reads
    g.release();

    expect(await scan).toBe(false); // assertion: the raced scan did not reopen the latch
  });

  it("a scan with no concurrent write notes reopens the latch when it finds no foreign stamp", async () => {
    _setGuardTableGetterForTests(fakeTableOver([])); // the corpus converged (no foreign stamp)
    noteWriteStamp(FOREIGN); // the latch is tripped

    expect(await recomputeLatch()).toBe(true); // assertion: a fresh scan reopens it
    expect(await isEmbeddingSpaceUniform()).toBe(true); // assertion: the gate is open
  });
});
