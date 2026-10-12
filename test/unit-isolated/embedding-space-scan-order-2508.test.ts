/**
 * embedding-space-scan-order-2508.test.ts — flair#2508.
 *
 * Two embedding-space scans can overlap: `recomputeLatch()` runs `scan()`
 * directly, bypassing the `_scanning` latch that serialises consult scans. An
 * older scan that started before a newer one but finishes after it must not
 * overwrite the newer scan's verdict (the scan-epoch guard of #2481 covers only
 * foreign-stamp write notes, and scans do not advance that epoch).
 *
 * This drives the REAL guard and the REAL pause-point machinery (flair#2307):
 * the older scan reads a uniform corpus and parks at the verdict pause; the
 * store then becomes mixed and a newer scan starts and publishes `false`; the
 * older scan is released and must refuse its `true` verdict by name.
 *
 * Runs in test/unit-isolated (its own bun process) so the `mock.module("harper")`
 * below never collides with another file's harper import/mock.
 */
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_FAULT_INJECTION_ENV, TEST_PAUSE_DIR_ENV } from "../../resources/txn-pause-point.ts";

// The guard dynamic-imports "harper" only inside its scan (deferred). Mock it
// so the module-scope boot pre-warm's scan resolves to a stub and never loads
// real Harper; every latch test injects its own fake table via the test seams.
mock.module("harper", () => ({ databases: {} }));

const {
  isEmbeddingSpaceUniform,
  recomputeLatch,
  _setGuardTableGetterForTests,
  _setGuardModelIdForTests,
  _resetGuardForTests,
} = await import("../../resources/embedding-space-guard.ts");

const CURRENT = "gguf:nomic-embed-text-v1.5-Q4_K_M+searchprefix";
const FOREIGN = "gemma-embed:768"; // a genuinely different vector space
const POINT = "scan-verdict";

/** A fake Memory table over a MUTABLE stamp list; a scan snapshots the list it
 *  reads so a later mutation is seen only by a later scan. */
function fakeTableOver(stamps: () => (string | null | undefined)[]) {
  return async () => ({
    search(_q: unknown) {
      async function* gen() {
        for (const s of stamps()) yield { embeddingModel: s };
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

let dir: string;
let savedFault: string | undefined;
let savedPauseDir: string | undefined;

beforeEach(async () => {
  _resetGuardForTests();
  _setGuardModelIdForTests(() => CURRENT);
  // Drain the module-scope pre-warm's scan while the default (mocked, throwing)
  // table getter is in place, so it can never consume an arm we create below.
  await new Promise((r) => setTimeout(r, 25));
  _resetGuardForTests();
  _setGuardModelIdForTests(() => CURRENT);

  dir = mkdtempSync(join(tmpdir(), "flair-2508-"));
  savedFault = process.env[TEST_FAULT_INJECTION_ENV];
  savedPauseDir = process.env[TEST_PAUSE_DIR_ENV];
  process.env[TEST_FAULT_INJECTION_ENV] = "1";
  process.env[TEST_PAUSE_DIR_ENV] = dir;
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
    const stamps: (string | null)[] = []; // uniform (empty) corpus
    _setGuardTableGetterForTests(fakeTableOver(() => stamps));

    // The OLDER scan reads the uniform corpus, then parks at the verdict pause.
    writeFileSync(join(dir, `arm.${POINT}`), "");
    const older = recomputeLatch();
    await waitFor(join(dir, `paused.${POINT}`), 10_000);

    // The store becomes mixed; a NEWER scan starts and publishes verdict=false.
    stamps.push(FOREIGN);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const newer = recomputeLatch();
      expect(await newer).toBe(false);

      // Release the OLDER scan: it must not overwrite the newer verdict.
      writeFileSync(join(dir, `go.${POINT}`), "");
      expect(await older).toBe(false);
      expect(await isEmbeddingSpaceUniform()).toBe(false);
      expect(
        warn.mock.calls.map((call) => call.join(" ")).some((line) => line.includes("stale scan verdict refused")),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  }, 30_000);

  it("the normal sequential case is unchanged", async () => {
    const stamps: (string | null)[] = [];
    _setGuardTableGetterForTests(fakeTableOver(() => stamps));

    expect(await recomputeLatch()).toBe(true); // uniform
    expect(await isEmbeddingSpaceUniform()).toBe(true);

    stamps.push(FOREIGN);
    expect(await recomputeLatch()).toBe(false); // mixed
    expect(await isEmbeddingSpaceUniform()).toBe(false);
  }, 30_000);
});
