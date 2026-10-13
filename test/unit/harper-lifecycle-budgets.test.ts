// flair#2568 — test-Harper lifecycle timeouts.
//
// Three CI runs failed on lifecycle timing rather than logic: a `beforeAll`/
// `afterAll` that starts or stops a spawned Harper ran under Bun's 5 s hook
// default, the harness's readiness budget had no single documented source, and
// a slow stop surfaced as Bun's `(unnamed)` hook timeout with no pid and no
// phase. These are the structural checks for the fix; the behavioural ones
// (a real Harper boots within the budget, a real slow stop names itself) need a
// live Harper and live in the integration lane.
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import {
  HARPER_STARTUP_BUDGET_MS,
  HarperStopTimeoutError,
  harperStartupPhase,
  stopHarper,
  type HarperInstance,
} from "../helpers/harper-lifecycle.js";
import { STARTUP_TIMEOUT_MS } from "../../src/cli.js";

const TEST_DIR = resolve(import.meta.dir, "..");
const PROJECT_ROOT = resolve(TEST_DIR, "..");

// ─── 1. One documented startup budget ────────────────────────────────────────

describe("flair#2568: one readiness budget", () => {
  test("the harness readiness poll and flair init's TCP readiness check share one budget", () => {
    // `waitForHealth` defaults to HARPER_STARTUP_BUDGET_MS; `flair init`'s
    // `attributeBeforeCredential` polls under cli.STARTUP_TIMEOUT_MS. They must
    // be the same number — a boot that one would call ready must not be one the
    // other calls failed. Pinned so a change to either side fails here first.
    expect(HARPER_STARTUP_BUDGET_MS).toBe(STARTUP_TIMEOUT_MS);
  });
});

// ─── 2. The phase is reported, not just "timed out" ──────────────────────────

describe("flair#2568: the failure names the phase it stopped in", () => {
  test("harperStartupPhase reads the phase Harper writes into its own log", () => {
    const log =
      "HTTP worker slot 0 has not become ready after 60000ms " +
      "(thread 1, attempt 1, phase loading components)";
    expect(harperStartupPhase(log)).toBe("loading components");
    // The last marker wins when a log carries several.
    expect(harperStartupPhase("phase loading components\nphase binding listeners")).toBe(
      "binding listeners",
    );
    // No marker → null, so callers fall back to their own phase label.
    expect(harperStartupPhase("nothing to see here")).toBeNull();
  });
});

// ─── 3. A slow stop names itself ─────────────────────────────────────────────

describe("flair#2568: a stop past its budget throws the named error", () => {
  test("a process that does not exit within the stop budget raises HarperStopTimeoutError with pid and phase", async () => {
    // A stub child that does not emit `exit`: `killProcess` waits for it and the
    // stop budget wins the race.
    const proc = new EventEmitter() as unknown as HarperInstance["process"];
    Object.assign(proc!, { pid: 424242, exitCode: null, signalCode: null, kill: () => {} });
    const inst: HarperInstance = {
      httpURL: "",
      opsURL: "",
      installDir: "",
      process: proc,
      admin: { username: "admin", password: "x" },
      external: false,
      ownsInstallDir: false,
    };
    let err: unknown;
    try {
      await stopHarper(inst, { timeoutMs: 50 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HarperStopTimeoutError);
    expect((err as Error).name).toBe("HarperStopTimeoutError");
    // The pid and the phase it stalled in are in the message, not "(unnamed)".
    expect((err as Error).message).toContain("pid 424242");
    expect((err as Error).message).toContain("phase: terminate");
    expect((err as Error).message).toContain("50ms");
  });
});

// ─── 4. No Harper hook falls back to Bun's 5 s default ──────────────────────

const HOOK_NAMES = new Set(["beforeAll", "beforeEach", "afterAll", "afterEach"]);

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFilesUnder(p));
    else if (entry.isFile() && p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/**
 * Hooks that start or stop a spawned Harper but pass no explicit timeout.
 *
 * Scanned over the AST, not the text: the comments in this tree name
 * `startHarper`/`stopHarper` constantly, and a raw scan would either miss real
 * hooks or drown in prose.
 */
function harperHooksMissingTimeout(): string[] {
  const offenders: string[] = [];
  for (const file of tsFilesUnder(TEST_DIR)) {
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        HOOK_NAMES.has(node.expression.text) &&
        node.arguments.length < 2
      ) {
        const cb = node.arguments[0];
        let touchesHarper = false;
        if (cb) {
          const walk = (n: ts.Node): void => {
            if (ts.isIdentifier(n) && (n.text === "startHarper" || n.text === "stopHarper")) {
              touchesHarper = true;
            }
            ts.forEachChild(n, walk);
          };
          walk(cb);
        }
        if (touchesHarper) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          offenders.push(`${relative(PROJECT_ROOT, file)}:${line + 1} ${node.expression.text}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return offenders;
}

describe("flair#2568: no Harper lifecycle hook relies on Bun's 5 s default", () => {
  test("no beforeAll/afterAll/beforeEach/afterEach that starts or stops a Harper relies on Bun's 5 s default", () => {
    expect(harperHooksMissingTimeout()).toEqual([]);
  });
});
