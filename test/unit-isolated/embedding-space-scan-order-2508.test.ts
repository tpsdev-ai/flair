/**
 * embedding-space-scan-order-2508.test.ts — flair#2508.
 *
 * Two embedding-space scans can overlap: `recomputeLatch()` (which the boot
 * pre-warm calls) runs `scan()` directly, bypassing the `_scanning` latch that
 * serialises consult scans. An older scan that started before a newer one but
 * finishes after it must not overwrite the newer scan's verdict (the
 * scan-epoch guard of #2481 covers only foreign-stamp write notes, and scans do
 * not advance that epoch).
 *
 * The two race cases drive the REAL guard and the REAL pause-point machinery
 * (flair#2307): the older scan reads a corpus holding one current-space stamp
 * and parks at the verdict pause; a foreign-space stamp is then added, so the
 * corpus is mixed; a newer scan reads it and publishes `false`; the older scan
 * is released and must refuse its `true` verdict by name. Their pairings: two
 * explicit `recomputeLatch()` calls, and the in-tree one, the boot pre-warm
 * against a consult (test/integration/embedding-space-scan-order-2508.test.ts
 * runs that pairing inside a real Harper worker). A third case pins the
 * sequential behaviour.
 *
 * Runs in test/unit-isolated (its own bun process) so the `mock.module("harper")`
 * below never collides with another file's harper import/mock.
 */
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_FAULT_INJECTION_ENV, TEST_PAUSE_DIR_ENV } from "../../resources/txn-pause-point.ts";

// The guard dynamic-imports "harper" only inside its scan (deferred). Mock it
// so the module-scope boot pre-warm's scan imports a stub with no Memory table
// (its read fails and is caught) and never loads real Harper; every case
// injects its own fake table through the test seams.
mock.module("harper", () => ({ databases: {} }));

const {
  isEmbeddingSpaceUniform,
  recomputeLatch,
  scheduleSpaceGuardPrewarm,
  spaceGuardDiagnostics,
  _prewarmSettledForTests,
  _setGuardTableGetterForTests,
  _setGuardModelIdForTests,
  _resetGuardForTests,
} = await import("../../resources/embedding-space-guard.ts");

const CURRENT = "gguf:nomic-embed-text-v1.5-Q4_K_M+searchprefix";
const FOREIGN = "gemma-embed:768"; // a genuinely different vector space
const POINT = "scan-verdict";

/** A fake Memory table over a MUTABLE stamp list. Each scan copies the list
 *  when it starts reading, so a stamp added after that is seen only by a
 *  later scan. */
function fakeTableOver(stamps: () => (string | null | undefined)[]) {
  return async () => ({
    search(_q: unknown) {
      async function* gen() {
        const snapshot = [...stamps()];
        for (const s of snapshot) yield { embeddingModel: s };
      }
      return gen();
    },
  });
}

async function waitFor(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${path}`);
}

function refusalLogged(warn: { mock: { calls: unknown[][] } }): boolean {
  return warn.mock.calls.map((call) => call.join(" ")).some((line) => line.includes("stale scan verdict refused"));
}

let dir: string;
let savedFault: string | undefined;
let savedPauseDir: string | undefined;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "flair-2508-"));
  savedFault = process.env[TEST_FAULT_INJECTION_ENV];
  savedPauseDir = process.env[TEST_PAUSE_DIR_ENV];
  process.env[TEST_FAULT_INJECTION_ENV] = "1";
  process.env[TEST_PAUSE_DIR_ENV] = dir;

  // Barrier: the most recently scheduled pre-warm has finished (at first, the
  // module-scope boot pre-warm, whose read of the mocked harper fails), so it
  // can neither read a table getter injected below nor claim an arm a case
  // creates.
  const prewarm = _prewarmSettledForTests();
  expect(prewarm, "no boot pre-warm was scheduled when the guard loaded").toBeDefined();
  await prewarm;
  _resetGuardForTests();
  _setGuardModelIdForTests(() => CURRENT);
});

afterEach(() => {
  for (const [key, saved] of [[TEST_FAULT_INJECTION_ENV, savedFault], [TEST_PAUSE_DIR_ENV, savedPauseDir]] as const) {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("embedding-space-guard — scan-start verdict ordering (flair#2508)", () => {
  it("an older scan that finishes after a newer one refuses its verdict by name", async () => {
    const stamps: (string | null)[] = [CURRENT]; // uniform in the current space
    _setGuardTableGetterForTests(fakeTableOver(() => stamps));

    // The OLDER scan reads the uniform corpus, then parks at the verdict pause.
    writeFileSync(join(dir, `arm.${POINT}`), "");
    const older = recomputeLatch();
    await waitFor(join(dir, `paused.${POINT}`), 10_000);

    // The corpus becomes mixed; a NEWER scan starts and publishes verdict=false.
    stamps.push(FOREIGN);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const newer = recomputeLatch();
      expect(await newer).toBe(false);

      // Release the OLDER scan: it must not overwrite the newer verdict.
      writeFileSync(join(dir, `go.${POINT}`), "");
      expect(await older).toBe(false);
      expect(readFileSync(join(dir, `released.${POINT}`), "utf8")).toBe("go");
      expect(await isEmbeddingSpaceUniform()).toBe(false);
      expect(refusalLogged(warn)).toBe(true);
    } finally {
      warn.mockRestore();
    }
  }, 30_000);

  it("a boot pre-warm that finishes after a consult scan refuses its verdict by name", async () => {
    const stamps: (string | null)[] = [CURRENT];
    _setGuardTableGetterForTests(fakeTableOver(() => stamps));

    // The pre-warm (the OLDER scan) reads the uniform corpus and parks.
    writeFileSync(join(dir, `arm.${POINT}`), "");
    scheduleSpaceGuardPrewarm();
    const prewarm = _prewarmSettledForTests();
    expect(prewarm).toBeDefined();
    await waitFor(join(dir, `paused.${POINT}`), 10_000);

    // The corpus becomes mixed; a consult finds no verdict yet, so it starts
    // the NEWER scan, which publishes false.
    stamps.push(FOREIGN);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await isEmbeddingSpaceUniform()).toBe(false);

      // Release the pre-warm: it must not overwrite the consult's verdict.
      writeFileSync(join(dir, `go.${POINT}`), "");
      await prewarm;
      expect(readFileSync(join(dir, `released.${POINT}`), "utf8")).toBe("go");
      expect(await isEmbeddingSpaceUniform()).toBe(false);
      expect(spaceGuardDiagnostics().found.sort()).toEqual([CURRENT, FOREIGN].sort());
      expect(refusalLogged(warn)).toBe(true);
    } finally {
      warn.mockRestore();
    }
  }, 30_000);

  it("the normal sequential case is unchanged", async () => {
    const stamps: (string | null)[] = [CURRENT];
    _setGuardTableGetterForTests(fakeTableOver(() => stamps));

    expect(await recomputeLatch()).toBe(true); // uniform
    expect(await isEmbeddingSpaceUniform()).toBe(true);

    stamps.push(FOREIGN);
    expect(await recomputeLatch()).toBe(false); // mixed
    expect(await isEmbeddingSpaceUniform()).toBe(false);
  }, 30_000);
});
