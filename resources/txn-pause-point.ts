/**
 * txn-pause-point.ts — a TEST-ONLY pause inside an owned transaction
 * (flair#2307).
 *
 * A real-Harper integration test needs a row to change AFTER a transaction has
 * read it and BEFORE that transaction writes. Harper runs as a spawned child
 * process there, so an environment variable set at spawn time plus marker files
 * are the only levers a test has into it: the same shape as
 * FLAIR_TEST_CRITICAL_BARRIER (src/lib/config-critical-section.ts) and the
 * exact-match FLAIR_ENABLE_TEST_MIGRATIONS opt-in
 * (resources/migrations/synthetic-test-migration.ts).
 *
 * INERT unless every condition below holds; otherwise it returns `undefined`
 * synchronously, so a caller's `if (pause) await pause` adds no await and no
 * file access:
 *   - FLAIR_ENABLE_TEST_FAULT_INJECTION is exactly "1";
 *   - FLAIR_TEST_PAUSE_DIR is an absolute path inside the OS temp directory;
 *   - the arm file `<dir>/arm.<point>` exists, and this call claims it (an
 *     atomic rename, so one arm file pauses one call).
 * Armed, it writes `<dir>/paused.<point>`, then waits on a timer (never
 * blocking the worker thread, which must keep serving the test's competing
 * request) for `<dir>/go.<point>`, at most PAUSE_LIMIT_MS, and writes
 * `<dir>/released.<point>` containing "go" or "timeout". It reads and writes no
 * table, and never throws: a failed file operation ends the pause.
 *
 * TRUSTED-ENV ASSUMPTION: whoever can set a flair process's environment and
 * write its temp directory can already stop that process; the pause changes no
 * data and releases itself.
 *
 * Pinned by test/unit/txn-pause-point.test.ts (inert without each condition;
 * one arm, one pause; release on go and on timeout). Used by
 * test/integration/owned-transaction-contention-2307.test.ts.
 */
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

export const TEST_FAULT_INJECTION_ENV = "FLAIR_ENABLE_TEST_FAULT_INJECTION";
export const TEST_PAUSE_DIR_ENV = "FLAIR_TEST_PAUSE_DIR";
/** Under Harper's 30 s open-transaction limit, so a pause never outlives its transaction. */
export const PAUSE_LIMIT_MS = 20_000;
const POLL_MS = 20;

/** One point per owned transaction that writes from a row it read. */
export type TxnPausePoint = "supersede-close" | "embedding-stamp-content-suffix";

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export function txnPausePoint(
  point: TxnPausePoint,
  env: NodeJS.ProcessEnv = process.env,
  limitMs: number = PAUSE_LIMIT_MS,
): Promise<void> | undefined {
  if (env[TEST_FAULT_INJECTION_ENV] !== "1") return undefined;
  const dir = env[TEST_PAUSE_DIR_ENV];
  if (!dir || !isAbsolute(dir) || !isInside(tmpdir(), dir)) return undefined;
  try {
    renameSync(join(dir, `arm.${point}`), join(dir, `claimed.${point}`));
  } catch {
    return undefined; // not armed, or another call claimed the arm
  }
  return (async () => {
    try {
      writeFileSync(join(dir, `paused.${point}`), String(Date.now()));
      const go = join(dir, `go.${point}`);
      const deadline = Date.now() + limitMs;
      while (!existsSync(go) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
      writeFileSync(join(dir, `released.${point}`), existsSync(go) ? "go" : "timeout");
    } catch {
      /* a failed marker write ends the pause */
    }
  })();
}
