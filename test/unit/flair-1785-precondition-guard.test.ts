// flair#1785 slice 1 — unit tests for the helpers that stay in the PR:
//   B  the seed-only precondition guard (test/helpers/migration-precondition.ts)
//   C  the bounded boot-log dump (test/helpers/harper-lifecycle.ts)
//   the addendum rescan helper (throwIfComponentInstallFailed)
//
// The guard is the piece that turns a contaminated fixture precondition into a
// fast, NAMED failure instead of a silent 60 s state.json poll. Its four inputs
// (absent / present-no-entry / present-with-entry / malformed) are each pinned
// to a distinct outcome below.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertSeedOnlyPrecondition,
  seedOnlyPreconditionMessage,
  SEED_ONLY_ENTRY,
} from "../helpers/migration-precondition.js";
import {
  bootLogTail,
  formatBootLogDump,
  throwIfComponentInstallFailed,
  type HarperInstance,
} from "../helpers/harper-lifecycle.js";

const INSTALL_FAILURE_LINE =
  "Failed to install dependencies for flair using npm default. Exit code: 217 (500)";

function withStateFile(json: string | null): { dir: string; statePath: string } {
  const dir = mkdtempSync(join(tmpdir(), "flair-1785-guard-"));
  const statePath = join(dir, ".migrations", "state.json");
  // A nested path needs its parent only if we write the file; the "absent"
  // case deliberately leaves the whole tree absent.
  if (json !== null) {
    mkdirSync(join(dir, ".migrations"), { recursive: true });
    writeFileSync(statePath, json);
  }
  return { dir, statePath };
}

describe("flair#1785 B — seed-only precondition guard", () => {
  test("file absent → satisfied (the expected boot-1 state: nothing pending, no entry written)", () => {
    const { dir, statePath } = withStateFile(null);
    try {
      expect(() => assertSeedOnlyPrecondition({ statePath })).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("present and parseable with NO visibility-backfill entry → satisfied", () => {
    const { dir, statePath } = withStateFile(JSON.stringify({ "graph-heal": { lastOutcome: "success" } }));
    try {
      expect(() => assertSeedOnlyPrecondition({ statePath })).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("present WITH a visibility-backfill entry → fails immediately, by name, with the timing fact", () => {
    const state = { "visibility-backfill": { lastOutcome: "success", rowsProcessed: 4 } };
    const { dir, statePath } = withStateFile(JSON.stringify(state));
    try {
      let err: Error | null = null;
      try {
        assertSeedOnlyPrecondition({ statePath, seedToStopMs: 1234 });
      } catch (e) {
        err = e as Error;
      }
      expect(err).not.toBeNull();
      expect(err!.message).toBe(seedOnlyPreconditionMessage(statePath, SEED_ONLY_ENTRY, 1234));
      // The exact adjudicated wording (flair#1785 part 3).
      expect(err!.message).toContain(
        `Provisioned-datadir fixture: boot 1 left a visibility-backfill entry at ${statePath} ` +
          `before shutdown completed; the seed-only precondition is not established. Prevent migration ` +
          `execution during boot 1 and rerun; see flair#1785.`,
      );
      expect(err!.message).toContain("Seed-to-stop window: 1234 ms.");
      // NOT the inspection failure text.
      expect(err!.message).not.toContain("could not read boot 1's migration state");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("present but malformed → a SEPARATE inspection failure, never counted as absence", () => {
    const { dir, statePath } = withStateFile("{ this is not json");
    try {
      let err: Error | null = null;
      try {
        assertSeedOnlyPrecondition({ statePath });
      } catch (e) {
        err = e as Error;
      }
      expect(err).not.toBeNull();
      expect(err!.message).toContain(`could not read boot 1's migration state at ${statePath}:`);
      // It must NOT be reported as the precondition failure, and must NOT be
      // silently read as "absent" (which is what "no throw" would mean).
      expect(err!.message).not.toContain("the seed-only precondition is not established");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("present but a JSON non-object (null) → inspection failure, not absence", () => {
    const { dir, statePath } = withStateFile("null");
    try {
      expect(() => assertSeedOnlyPrecondition({ statePath })).toThrow(
        /could not read boot 1's migration state .* not a JSON object/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("flair#1785 addendum — the final install-failure rescan before a wait loop's generic path", () => {
  test("a late install-failure line is surfaced by the rescan, not swallowed", () => {
    // The one assertion the addendum asks for: the helper throws the NAMED
    // deploy failure when the log carries it, and is a no-op otherwise.
    expect(() => throwIfComponentInstallFailed("")).not.toThrow();
    expect(() => throwIfComponentInstallFailed("all good")).not.toThrow();
    expect(() => throwIfComponentInstallFailed(INSTALL_FAILURE_LINE)).toThrow(
      /Failed to install dependencies for flair using npm default/,
    );
  });
});

describe("flair#1785 C — bounded, labelled boot-log dump", () => {
  const fake = (log: string, installDir: string, httpURL: string): HarperInstance =>
    ({ getLog: () => log, installDir, httpURL } as unknown as HarperInstance);

  test("bootLogTail keeps the last N lines and the whole log when shorter", () => {
    const log = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    expect(bootLogTail(log, 3)).toBe("line 7\nline 8\nline 9");
    expect(bootLogTail("a\nb", 5)).toBe("a\nb");
  });

  test("formatBootLogDump is bounded per boot and prefixed with label/ROOTPATH/port", () => {
    const big = Array.from({ length: 500 }, (_, i) => `L${i}`).join("\n");
    const dump = formatBootLogDump(
      [
        { label: "boot 1 (seed phase)", inst: fake(big, "/tmp/install-1", "http://127.0.0.1:1111") },
        { label: "boot 2 (provisioned)", inst: fake("second", "/tmp/install-2", "http://127.0.0.1:2222") },
      ],
      { maxLines: 300 },
    );
    expect(dump).toContain("boot 1 (seed phase) — ROOTPATH=/tmp/install-1 http=http://127.0.0.1:1111 — last 300 lines");
    expect(dump).toContain("L499"); // the tail is kept
    expect(dump).not.toContain("\nL199\n"); // the head is dropped
    expect(dump).toContain("boot 2 (provisioned) — ROOTPATH=/tmp/install-2");
  });

  test("an instance with no captured log contributes nothing (no global afterEach prints on success)", () => {
    expect(formatBootLogDump([{ label: "boot 1", inst: fake("", "/tmp/x", "http://127.0.0.1:1") }])).toBe("");
    expect(formatBootLogDump([{ label: "boot 1", inst: undefined }])).toBe("");
  });
});
