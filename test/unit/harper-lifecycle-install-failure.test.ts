// flair#1797 — an install-failure line that arrives LATE must still be the
// reported failure.
//
// `awaitMigrationStateFile` (test/helpers/harper-lifecycle.ts) reads Harper's
// log at the START of each poll iteration:
//
//     while (Date.now() < deadline) { installFailure check; …; sleep(pollMs) }
//     throw new Error(`no parseable … within Ns`)
//
// If Harper writes the install-failure line during the FINAL sleep — after the
// last in-iteration read and before the loop's exit — the loop exits without
// reading it and the generic "no parseable state.json" timeout is reported
// instead of the named deploy failure (#1785). The fix is one final log scan
// immediately before the generic throw.
//
// These tests drive the waiter with a synthetic log so the timing is explicit
// and deterministic; the install-failure TEXT is Harper's real output shape.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  awaitMigrationStateFile,
  componentInstallFailure,
} from "../helpers/harper-lifecycle.js";

/** Harper's real install-failure line (componentInstallFailure parses it). */
const INSTALL_FAILURE_LINE =
  "Failed to install dependencies for flair using npm default. Exit code: 217 (500)";

/** A state path that is never created, so the wait always runs to its deadline. */
function absentStatePath(): string {
  return join(tmpdir(), `flair-1797-absent-${process.pid}-${Date.now()}-${Math.random()}.json`);
}

describe("componentInstallFailure — the warn-level site carries the same text", () => {
  test("a configured-manager line parses identically to the default-manager line", () => {
    // Application.js ~864 (onFail === 'warn'): a CONFIGURED package manager
    // failed and Harper fell through to `npm install --force`. The warn line
    // carries the SAME sentence, so the regex matches it on purpose and cannot
    // distinguish the two sites. See COMPONENT_INSTALL_FAILURE_RE in the helper.
    const warnSite = "Failed to install dependencies for flair using pnpm. Exit code: 1";
    expect(componentInstallFailure(INSTALL_FAILURE_LINE)?.via).toBe("npm default");
    expect(componentInstallFailure(warnSite)?.via).toBe("pnpm");
    expect(componentInstallFailure(warnSite)?.status).toBe(1);
  });
});

describe("awaitMigrationStateFile surfaces a late install failure (flair#1797 item 1)", () => {
  test("a line already in the log is caught in the FIRST iteration, not at the timeout", async () => {
    // Positive control for the in-iteration read: it must fail FAST (seconds),
    // naming the deploy failure — not sit on the full timeout.
    const started = Date.now();
    const err = await awaitMigrationStateFile({
      statePath: absentStatePath(),
      entry: "visibility-backfill",
      getLog: () => INSTALL_FAILURE_LINE,
      timeoutMs: 30_000,
      pollMs: 5_000,
    }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toMatch(/Failed to install dependencies for flair using npm default/);
    expect(err?.message).not.toMatch(/no parseable/);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("a line arriving AFTER the last in-iteration read is still the reported failure", async () => {
    // timeoutMs is DELIBERATELY smaller than pollMs so the loop performs exactly
    // ONE iteration: its single in-iteration read sees an empty log, then it
    // sleeps past the deadline. The install-failure line lands during that final
    // sleep (timed well inside it), so ONLY the pre-throw rescan can see it. If
    // the rescan is missing, this test fails with the generic "no parseable"
    // message — that is the mutation.
    let lateFailure = false;
    setTimeout(() => {
      lateFailure = true;
    }, 50);
    const err = await awaitMigrationStateFile({
      statePath: absentStatePath(),
      entry: "visibility-backfill",
      getLog: () => (lateFailure ? INSTALL_FAILURE_LINE : ""),
      timeoutMs: 150,
      pollMs: 300,
    }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toMatch(/Failed to install dependencies for flair using npm default/);
    expect(err?.message).not.toMatch(/no parseable/);
  });

  test("with no install failure in the log, the generic timeout is still reported", async () => {
    // Positive control for the rescan: it must not manufacture a failure. An
    // empty log with no state file still reports the absence-of-state timeout.
    const err = await awaitMigrationStateFile({
      statePath: absentStatePath(),
      entry: "visibility-backfill",
      getLog: () => "",
      timeoutMs: 100,
      pollMs: 300,
    }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toMatch(/no parseable .* within/);
    expect(err?.message).not.toMatch(/Failed to install dependencies/);
  });
});
