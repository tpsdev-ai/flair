/**
 * ops-socket-first-start.test.ts — flair#1701.
 *
 * A fresh macOS launchd instance (`flair init --admin-pass-file` →
 * `doctor --fix` adopt) leaves `dataDir/operations-server` at Harper's
 * umask-default mode until a *second* start. `flair init` / `flair start` /
 * `flair restart` already call `readyOpsSocketPosture` after health; the
 * adopt bounce does not. Doctor then flags `✗ Ops socket permissions` and
 * the canary stays red (this finding is not allow-listed — #1702).
 *
 * Harper sets no socket mode, so the file lands at `0777 & ~umask` (0755
 * here). Init's directory gate (0700) is already in place; the socket itself
 * is the breach. The first-start path must chmod the fresh data dir 0700 and
 * the new socket 0600 so doctor is green on first boot.
 *
 * Two assertions, both fails-first:
 *   1. A real temp data dir in Harper's first-create shape (dir 0700 +
 *      socket 0755) is flagged, and applying the posture helper clears it.
 *   2. The adopt/regenerate executor (`repairLaunchdManagement`) calls that
 *      helper AFTER the launchd bounce — the missing wire that made first
 *      start differ from restart.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyOpsSocketPosture, classifyOpsSocketPosture } from "../../src/cli.ts";

const CLI_SRC = readFileSync(join(import.meta.dir, "..", "..", "src", "cli.ts"), "utf8");

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function functionBody(source: string, name: string): string {
  const decl = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  if (!decl) throw new Error(`could not find function ${name} in cli.ts`);
  const open = source.indexOf("{", decl.index);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error(`unbalanced braces reading ${name}`);
}

const src = stripComments(CLI_SRC);

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

/** Fresh data dir in the first-launchd-start shape: dir gate already 0700,
 *  socket just created at Harper's umask default (0755). */
function freshFirstStartDataDir(): { dataDir: string; socketPath: string } {
  const dataDir = mkdtempSync(join(tmpdir(), "flair-1701-ops-socket-"));
  temps.push(dataDir);
  chmodSync(dataDir, 0o700);
  const socketPath = join(dataDir, "operations-server");
  writeFileSync(socketPath, "");
  chmodSync(socketPath, 0o755);
  return { dataDir, socketPath };
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("first-start ops-socket posture on a fresh data dir (flair#1701)", () => {
  test("FAILS-FIRST: Harper's first-create socket on a 0700 dir is a doctor ✗", () => {
    const { dataDir, socketPath } = freshFirstStartDataDir();
    expect(modeOf(dataDir)).toBe(0o700);
    expect(modeOf(socketPath)).toBe(0o755);
    const verdict = classifyOpsSocketPosture(statSync(dataDir).mode, statSync(socketPath).mode, false);
    expect(verdict.flagged).toBe(true);
    expect(verdict.row).toBe("socket-open");
  });

  test("FAILS-FIRST: applying the posture helper on that fresh dir yields 0700 / 0600 and a clean doctor row", () => {
    const { dataDir, socketPath } = freshFirstStartDataDir();
    const applied = applyOpsSocketPosture({ socketPath });
    expect(applied.dirApplied).toBe(true);
    expect(applied.socketApplied).toBe(true);
    expect(modeOf(dataDir)).toBe(0o700);
    expect(modeOf(socketPath)).toBe(0o600);
    const verdict = classifyOpsSocketPosture(statSync(dataDir).mode, statSync(socketPath).mode, false);
    expect(verdict.flagged).toBe(false);
    expect(verdict.row).toBe("default-clean");
  });

  test("FAILS-FIRST: a 0755 data dir (no dir gate yet) is tightened to 0700 with the socket", () => {
    const { dataDir, socketPath } = freshFirstStartDataDir();
    chmodSync(dataDir, 0o755);
    expect(classifyOpsSocketPosture(statSync(dataDir).mode, statSync(socketPath).mode, false).row).toBe("both-open");
    applyOpsSocketPosture({ socketPath });
    expect(modeOf(dataDir)).toBe(0o700);
    expect(modeOf(socketPath)).toBe(0o600);
    expect(classifyOpsSocketPosture(statSync(dataDir).mode, statSync(socketPath).mode, false).flagged).toBe(false);
  });
});

describe("the adopt / first-start wire (flair#1701)", () => {
  test("FAILS-FIRST: repairLaunchdManagement applies readyOpsSocketPosture AFTER the launchd bounce", () => {
    // Init / start / restart already call this after waitForHealth. The canary
    // path is init (posture applied on the direct socket) → doctor --fix adopt
    // (clean-stop → launchd exec → Harper creates a NEW socket at 0755).
    // Without this call after ensureLaunchdServiceLoaded, first start stays
    // red and a second `flair start` is what finally chmods — the 0.54.2
    // canary defect.
    const body = functionBody(src, "repairLaunchdManagement");
    const loadAt = body.indexOf("ensureLaunchdServiceLoaded(");
    expect(loadAt).toBeGreaterThan(-1);
    const postureAt = body.indexOf("readyOpsSocketPosture(");
    expect(postureAt).toBeGreaterThan(-1);
    expect(postureAt).toBeGreaterThan(loadAt);
  });

  test("the canary must not allow-list the ops-socket finding", () => {
    const advisory = readFileSync(join(import.meta.dir, "..", "..", "scripts", "ci", "doctor-advisory.sh"), "utf8");
    expect(advisory).toContain("never suppresses the ops-socket");
    expect(advisory).not.toMatch(/ADVISORY_ALLOWLIST=\([\s\S]*Ops socket permissions/);
  });
});
