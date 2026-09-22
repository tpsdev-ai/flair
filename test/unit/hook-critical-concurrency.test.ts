/**
 * hook-critical-concurrency.test.ts — flair#1778 slice 2c-i-b fixture 8.
 *
 * Two REAL child processes race the production hook writers on ONE settings
 * file with two DISJOINT edits: one wires the SessionStart hook, the other the
 * continuity capture pair. Without a lock they read the same baseline and the
 * second write silently discards the first — the lost update this slice closes.
 *
 * Each child runs a small harness that syncs at the PRODUCTION read/write
 * boundary (a test-only, env-gated rendezvous that exists only in the harness,
 * so the same child works on a baseline WITHOUT the primitive): it reads the
 * config, arms, waits for `go`, then invokes the production writer. On the
 * branch the primitive ALSO sees the barrier and serializes; on a baseline the
 * two writers proceed together and one edit is lost. The baseline config
 * carries a large unrelated key so the production read window is wide enough
 * for the two writers to overlap deterministically.
 *
 * Every child has its own deadline; the case budget sits above the schedule.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..");
const hookModule = join(repoRoot, "src", "hook-install.ts");
const CHILD_DEADLINE_MS = 20_000;
const CASE_BUDGET_MS = 40_000;

let home: string;
let barrierDir: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "flair-2cib-conc-home-"));
  barrierDir = mkdtempSync(join(tmpdir(), "flair-2cib-barrier-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(barrierDir, { recursive: true, force: true });
});

const settingsPath = () => join(home, ".claude", "settings.json");

/** Written per test; imports the PRODUCTION writers from the tree under test. */
function harnessSource(): string {
  return [
    'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
    `import { installHook, installContinuityHooks } from ${JSON.stringify(hookModule)};`,
    "const dir = process.env.FLAIR_TEST_CRITICAL_BARRIER;",
    "const mode = process.argv[2];",
    "const homeDir = process.env.HOME;",
    "const cfgPath = homeDir + '/.claude/settings.json';",
    "if (dir) {",
    "  try { readFileSync(cfgPath, 'utf-8'); } catch {}",
    "  writeFileSync(dir + '/' + process.pid + '.preObserve', '1');",
    "  const go = dir + '/go';",
    "  const deadline = Date.now() + 15000;",
    "  while (!existsSync(go) && Date.now() < deadline) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); }",
    "}",
    "const opts = { homeDir, harness: 'claude-code', agentId: 'hookbot', flairUrl: 'http://127.0.0.1:19926' };",
    "const res = mode === 'session' ? installHook(opts) : installContinuityHooks(opts);",
    "process.exit(res.ok ? 0 : 1);",
  ].join("\n");
}

function runHarness(harnessPath: string, mode: string) {
  const child = spawn("bun", [harnessPath, mode], {
    cwd: repoRoot,
    env: { ...process.env, HOME: home, FLAIR_TEST_CRITICAL_BARRIER: barrierDir },
    timeout: CHILD_DEADLINE_MS,
  });
  let out = "";
  let err = "";
  child.stdout?.on("data", (d) => (out += d.toString()));
  child.stderr?.on("data", (d) => (err += d.toString()));
  const done = new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    child.on("close", (code) => resolve({ code, out, err }));
  });
  return { child, done };
}

async function waitForArms(n: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (readdirSync(barrierDir).filter((f) => f.endsWith(".preObserve")).length >= n) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

describe("fixture 8 — two writers racing on one config", () => {
  it("both disjoint production edits survive; no lost update (fails on main: the second write discards the first)", async () => {
    // Baseline config EXISTS (a regular file) with a large unrelated key so the
    // production read window is wide enough to overlap deterministically.
    mkdirSync(join(home, ".claude"), { recursive: true });
    const big = "x".repeat(2 * 1024 * 1024);
    writeFileSync(settingsPath(), JSON.stringify({ model: "opus", pad: big }) + "\n");

    const harnessPath = join(home, "harness.mjs");
    writeFileSync(harnessPath, harnessSource(), "utf-8");

    const a = runHarness(harnessPath, "session");
    const b = runHarness(harnessPath, "continuity");

    // Rendezvous: both children reach their pre-write boundary, then proceed.
    const armed = await waitForArms(2, 8000);
    writeFileSync(join(barrierDir, "go"), "1");

    const ra = await a.done;
    const rb = await b.done;
    const diag = `armed=${armed} A=${JSON.stringify(ra)} B=${JSON.stringify(rb)}`;
    expect(ra.code, `SessionStart child failed: ${diag}`).toBe(0);
    expect(rb.code, `continuity child failed: ${diag}`).toBe(0);

    const cfg = JSON.parse(readFileSync(settingsPath(), "utf-8"));
    // Both DISJOINT production edits are present — nothing was lost.
    const sessionStart = cfg?.hooks?.SessionStart;
    const postToolUse = cfg?.hooks?.PostToolUse;
    const stop = cfg?.hooks?.Stop;
    expect(Array.isArray(sessionStart) && sessionStart.length >= 1, `SessionStart hook LOST (the second write discarded the first) — ${diag}`).toBe(true);
    expect(Array.isArray(postToolUse) && postToolUse.length >= 1, `continuity PostToolUse LOST — ${diag}`).toBe(true);
    expect(Array.isArray(stop) && stop.length >= 1, `continuity Stop LOST — ${diag}`).toBe(true);
    expect(cfg.model).toBe("opus"); // the unrelated key is preserved
  }, CASE_BUDGET_MS);
});
