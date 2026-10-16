// flair#2568 — test-Harper lifecycle timeouts.
//
// Three CI runs failed on lifecycle timing rather than logic: a `beforeAll`/
// `afterAll` that starts or stops a spawned Harper ran under Bun's 5 s hook
// default, the harness's readiness budget had no single documented source, and
// a slow stop surfaced as Bun's `(unnamed)` hook timeout with no pid and no
// phase. This file holds the checks that need no Harper: the budget pin and
// the readiness-override guard, the parser for log text shaped like Harper's
// startup diagnostic, the named slow-stop error (stub
// child), a REAL Bun hook showing that concurrent stops name a later slow stop
// before the hook expires (stub children, real hook timeout), and the hook
// scanners. The readiness-failure diagnostic against a real Harper lives in
// test/integration/harper-startup-failure-diagnostic-2568.test.ts.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import {
  HARPER_STARTUP_BUDGET_MS,
  HarperStopTimeoutError,
  harperStartupPhase,
  startHarper,
  stopHarper,
  stopHarpers,
} from "../helpers/harper-lifecycle.js";
import { stubHarperInstance as stubInstance } from "../helpers/harper-stop-stub.js";
import { STARTUP_TIMEOUT_MS } from "../../src/cli.js";

const TEST_DIR = resolve(import.meta.dir, "..");
const PROJECT_ROOT = resolve(TEST_DIR, "..");
const HELPER = join(TEST_DIR, "helpers", "harper-lifecycle.ts");
const STUB = join(TEST_DIR, "helpers", "harper-stop-stub.ts");

// ─── 1. One documented startup budget ────────────────────────────────────────

describe("flair#2568: one readiness budget", () => {
  test("the harness readiness budget and flair init's TCP readiness budget are the same duration", () => {
    // `waitForHealth` defaults to HARPER_STARTUP_BUDGET_MS; `flair init`'s
    // `attributeBeforeCredential` polls under cli.STARTUP_TIMEOUT_MS. This
    // keeps the two configured durations aligned, so changing one without the
    // other fails here first. It does not make the two readiness decisions
    // equivalent: the probes (HTTP request vs TCP connect) and the points the
    // timers start from differ.
    expect(HARPER_STARTUP_BUDGET_MS).toBe(STARTUP_TIMEOUT_MS);
  });

  test("readinessTimeoutMs may only lower the readiness budget", async () => {
    // Refused before anything is spawned or written. The component and Harper
    // paths point nowhere, so a missing guard fails at install, never boots.
    const nowhere = join(tmpdir(), "flair-2568-no-harper-here");
    for (const bad of [HARPER_STARTUP_BUDGET_MS + 1, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(startHarper({ readinessTimeoutMs: bad, cwd: nowhere, harperBinDir: nowhere })).rejects.toThrow(
        `startHarper: readinessTimeoutMs ${bad} refused`,
      );
    }
  });
});

// ─── 2. Log text shaped like Harper's startup diagnostic → the phase ────────

describe("flair#2568: the phase is read from log text shaped like Harper's startup diagnostic", () => {
  test("harperStartupPhase reads the phase from harper 5.3.1's diagnostic lines", () => {
    // Verbatim lines harper 5.3.1 printed in this PR's real-Harper runs (the
    // first from a worker that exited while loading components, the second
    // from Harper's 60 s watchdog on a worker blocked while loading).
    const exited = "[main/0] [error]: HTTP worker slot 0 exited before ready (thread 1, attempt 1, phase loading components)";
    const stalled =
      "[main/0] [error]: HTTP worker slot 0 has not become ready after 60000ms before ready " +
      "(thread 1, attempt 1, phase loading components)";
    expect(harperStartupPhase(exited)).toBe("loading components");
    expect(harperStartupPhase(stalled)).toBe("loading components");
    // The LAST diagnostic wins when a log carries several.
    expect(
      harperStartupPhase(`${exited}\nHTTP worker slot 0 exited before ready (thread 2, attempt 2, phase binding listeners)\n`),
    ).toBe("binding listeners");
    // The match is on text, not on its writer: the harness captures one
    // combined stream, so a component line of the same shape reads the same.
    expect(harperStartupPhase("[http/1] [info] [probe]: echo before ready (thread 9, attempt 9, phase fabricated)")).toBe(
      "fabricated",
    );
  });

  test("text without the diagnostic's shape never yields a phase, so callers fall back to their own label", () => {
    expect(harperStartupPhase("nothing to see here")).toBeNull();
    // Text that merely says "phase" is not read as one.
    expect(harperStartupPhase("[http/1] [info]: migration phase two complete (rows, 12)")).toBeNull();
    expect(harperStartupPhase("phase loading components")).toBeNull();
  });
});

// ─── 3. A slow stop names itself ─────────────────────────────────────────────

describe("flair#2568: a stop past its budget throws the named error", () => {
  test("a process that does not exit within the stop budget raises HarperStopTimeoutError with pid and phase", async () => {
    let err: unknown;
    try {
      await stopHarper(stubInstance(424242, null), { timeoutMs: 50 });
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

  test("stopHarpers rethrows one failure as itself and several as one AggregateError naming each", async () => {
    let one: unknown;
    try {
      await stopHarpers([stubInstance(1001, 0), undefined, stubInstance(1002, null)], { timeoutMs: 50 });
    } catch (e) {
      one = e;
    }
    expect(one).toBeInstanceOf(HarperStopTimeoutError);
    expect((one as Error).message).toContain("pid 1002");

    let several: unknown;
    try {
      await stopHarpers([stubInstance(1003, null), stubInstance(1004, null)], { timeoutMs: 50 });
    } catch (e) {
      several = e;
    }
    expect(several).toBeInstanceOf(AggregateError);
    expect((several as AggregateError).errors).toHaveLength(2);
    expect((several as Error).message).toContain("HarperStopTimeoutError");
    expect((several as Error).message).toContain("pid 1003");
    expect((several as Error).message).toContain("pid 1004");
  });
});

// ─── 4. A later slow stop names itself before the hook expires ───────────────
//
// Gauge's finding on a3692a66: a hook that awaits two stops one after another
// starts the second stop's deadline only after the first stop finished, so the
// hook can expire before the second stop's named error exists. Scaled down: a
// first stop that takes 1500 ms, a second that never exits, a 2000 ms stop
// deadline and a 3000 ms hook. One after another: 1500 + 2000 = 3500 ms, past
// the hook. Concurrently (stopHarpers): 2000 ms, inside it. Both shapes run in
// a REAL Bun hook in a child `bun test`, so the timeout under test is Bun's.
// The margins (1 s inside, 0.5 s past) are wide to make a flip from a loaded
// runner's timer latency unlikely; they do not rule it out.

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function runHook(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "flair-2568-hook-"));
  scratch.push(dir);
  writeFileSync(
    join(dir, "hook-2568.test.ts"),
    `import { afterAll, test } from "bun:test";
import { stopHarper, stopHarpers } from ${JSON.stringify(HELPER)};
import { stubHarperInstance as stubInstance } from ${JSON.stringify(STUB)};
const first = stubInstance(2001, 1500);
const second = stubInstance(2002, null);
test("placeholder", () => {});
afterAll(async () => {
${body}
}, 3000);
`,
  );
  const res = spawnSync(process.execPath, ["test", "./hook-2568.test.ts"], {
    cwd: dir,
    encoding: "utf8",
    timeout: 60_000,
  });
  // The child's own status rides along so a spawn failure or timeout reads as
  // that, not as a missing string.
  return `${res.stdout}\n${res.stderr}\n[child status=${res.status} signal=${res.signal} error=${res.error?.message ?? "none"}]`;
}

describe("flair#2568: concurrent stops name a later slow stop before the hook expires", () => {
  test("stopHarpers: the second, slow stop reports HarperStopTimeoutError inside the hook budget", () => {
    const out = runHook("  await stopHarpers([first, second], { timeoutMs: 2000 });");
    expect(out).toContain("HarperStopTimeoutError: Harper stop did not finish within 2000ms (pid 2002, phase: terminate)");
    expect(out).not.toContain("hook timed out");
  }, 90_000);

  test("control: the same two stops awaited one after another hit Bun's unnamed hook timeout first", () => {
    // Proves the scaled reproduction can fire: with these timings and no
    // concurrency, the hook times out before the named error exists.
    const out = runHook("  await stopHarper(first, { timeoutMs: 2000 });\n  await stopHarper(second, { timeoutMs: 2000 });");
    expect(out).toContain("hook timed out");
    expect(out).not.toContain("HarperStopTimeoutError");
  }, 90_000);
});

// ─── 5. Hook scanners ────────────────────────────────────────────────────────

const HOOK_NAMES = new Set(["beforeAll", "beforeEach", "afterAll", "afterEach"]);
const HARPER_LIFECYCLE_CALLS = new Set(["startHarper", "stopHarper", "stopHarpers"]);

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFilesUnder(p));
    else if (entry.isFile() && p.endsWith(".ts")) out.push(p);
  }
  return out;
}

interface HookCall {
  where: string;
  callback: ts.Node | undefined;
  timeout: ts.Expression | undefined;
}

/**
 * Every before/after hook call in `test/`, parsed over the AST, not the text:
 * the comments in this tree name `startHarper`/`stopHarper` constantly, and a
 * raw scan would either miss real hooks or drown in prose.
 */
function hookCalls(): HookCall[] {
  const hooks: HookCall[] = [];
  for (const file of tsFilesUnder(TEST_DIR)) {
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && HOOK_NAMES.has(node.expression.text)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        hooks.push({
          where: `${relative(PROJECT_ROOT, file)}:${line + 1} ${node.expression.text}`,
          callback: node.arguments[0],
          timeout: node.arguments[1],
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return hooks;
}

function isLoop(node: ts.Node): boolean {
  return (
    ts.isForStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node)
  );
}

/** Calls to `names` inside `root`, each flagged when it sits inside a loop statement. */
function callsTo(root: ts.Node | undefined, names: Set<string>): { inLoop: boolean }[] {
  const found: { inLoop: boolean }[] = [];
  const walk = (n: ts.Node, inLoop: boolean): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && names.has(n.expression.text)) found.push({ inLoop });
    ts.forEachChild(n, (c) => walk(c, inLoop || isLoop(n)));
  };
  if (root) walk(root, false);
  return found;
}

/**
 * Hooks that call `startHarper`, `stopHarper` or `stopHarpers` DIRECTLY but
 * pass no timeout argument. A hook that reaches Harper only through a helper
 * (e.g. a pair's `stop()`) is not seen.
 */
function harperHooksMissingTimeout(): string[] {
  return hookCalls()
    .filter((h) => h.timeout === undefined && callsTo(h.callback, HARPER_LIFECYCLE_CALLS).length > 0)
    .map((h) => h.where);
}

/**
 * Hooks budgeted with HARPER_STOP_BUDGET_MS (one stop deadline plus margin)
 * that call `stopHarper`/`stopHarpers` DIRECTLY at more than one site, or at
 * one inside a loop. Those stops can run one after another, so a later slow
 * stop can outlast the hook before it names itself; such a hook makes one
 * `stopHarpers` call instead. Not seen: stops a helper makes on the hook's
 * behalf (e.g. a pair's `stop()`), and hooks with their own literal budget,
 * which size it themselves.
 */
function stopBudgetHooksWithSequentialStops(): string[] {
  return hookCalls()
    .filter((h) => h.timeout !== undefined && ts.isIdentifier(h.timeout) && h.timeout.text === "HARPER_STOP_BUDGET_MS")
    .filter((h) => {
      const stops = callsTo(h.callback, new Set(["stopHarper", "stopHarpers"]));
      return stops.length > 1 || stops.some((s) => s.inLoop);
    })
    .map((h) => h.where);
}

describe("flair#2568: Harper lifecycle hooks", () => {
  test("no hook that calls startHarper, stopHarper or stopHarpers directly omits its timeout (Bun's 5 s default)", () => {
    expect(harperHooksMissingTimeout()).toEqual([]);
  });

  test("no hook budgeted with HARPER_STOP_BUDGET_MS calls stopHarper/stopHarpers at more than one site or in a loop", () => {
    expect(stopBudgetHooksWithSequentialStops()).toEqual([]);
  });
});
