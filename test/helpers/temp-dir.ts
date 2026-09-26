/**
 * tempDir(prefix) — the ONE way a unit test gets a scratch directory, and the
 * ONE way it gets removed (flair#1889).
 *
 * A test cannot obtain a directory without its removal being registered: the
 * create and the registration happen in the same call, so there is no ordering
 * an author can forget. Removal is recursive, forced, and never throws on a
 * directory that is already gone.
 *
 * Cleanup is registered two ways, because a helper is called from two places:
 *
 *   - an `afterEach` hook calls `sweep()` after every test, removing the
 *     directories created since the previous sweep — a run's temp usage stays
 *     bounded instead of "everything at the very end";
 *   - an `afterAll` hook calls `sweep()` once when the file ends, covering a
 *     directory created outside a test body — in a `beforeAll`, say.
 *
 * Both sweeps are best-effort, not a guarantee: `sweep()` removes each
 * outstanding directory once, swallows a removal that fails (teardown must
 * never fail a test) and forgets it, so a directory whose removal failed is not
 * retried. What turns a survivor into a failure is the unit-lane guard, which
 * snapshots the OS temp directory before and after the lane.
 *
 * A `process.on("exit")` hook is registered too, for a caller outside a test
 * context — a plain `bun -e` script, say. NOTE: bun's TEST RUNNER does not run
 * Node's `exit`/`beforeExit` listeners after `bun test` (measured on bun
 * 1.3.10), so the exit hook is NOT what makes this safe under the lane; the
 * `afterEach`/`afterAll` hooks are, and they are registered at module load so
 * the test preload makes them process-global. Call `tempDir` from inside a test
 * (or a `beforeEach`); a module-level scratch directory meant to live for the
 * whole file is not what this helper is for.
 */

import { afterAll, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Directories created through `tempDir` this process and not yet swept. */
const live = new Set<string>();
let installed = false;

/** Remove every outstanding directory. Never throws: teardown must not fail a test. */
function sweep(): void {
  for (const dir of live) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort — a leaked temp dir must never become a test failure */
    }
  }
  live.clear();
}

function install(): void {
  if (installed) return;
  installed = true;
  try {
    afterEach(() => {
      sweep();
    });
    afterAll(() => {
      sweep();
    });
  } catch {
    /* Not inside a test context — the process-exit hook below still sweeps. */
  }
  process.on("exit", sweep);
}

// Register the hooks at MODULE LOAD, not on the first `tempDir` call. bun scopes
// a hook to the file whose context registered it, so a hook added while a test
// body runs does NOT cover later tests — and because bun evaluates every matched
// test file in ONE process and caches modules, a shared helper that registered
// lazily would cover only the first importing file. Loading this module from the
// test preload (see bunfig.toml) makes the hooks global to the process, which is
// what lets ONE helper clean up for every file.
install();

/**
 * Create a fresh scratch directory under the OS temp dir and register its
 * removal in the same call. `prefix` is what the OS appends a unique suffix to,
 * so use a `flair-<purpose>-` prefix and the lane's leak guard can name the
 * file that leaked when one slips through.
 */
export function tempDir(prefix: string): string {
  install();
  const dir = mkdtempSync(join(tmpdir(), prefix));
  live.add(dir);
  return dir;
}
