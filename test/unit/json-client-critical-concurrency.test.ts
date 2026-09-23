/**
 * json-client-critical-concurrency.test.ts — flair#1778 slice 2c-i-d1, fixture
 * E2 (the concurrency proof).
 *
 * The four JSON client-MCP config files gained ONE critical section in this
 * slice. This fixture races two REAL production writers on ONE settings file
 * with two DISJOINT edits and asserts BOTH survive.
 *
 * ONE-KEY NOTE: ~/.claude.json carries exactly ONE Flair-managed key
 * (`mcpServers.flair`), so two JSON-client writers of that file cannot make
 * disjoint edits — they would both write `mcpServers.flair` and the second
 * would necessarily overwrite the first (with OR without a lock). To give the
 * race genuinely DISJOINT keys, the fixture CO-LOCATES the JSON client writer
 * (`wireClaudeCode` → `mcpServers.flair`) with an ALREADY-MIGRATED writer
 * (`installHook` → `hooks.SessionStart`) on one file via a symlink. Before this
 * slice the JSON writer was RAW read-modify-write, so it clobbered the migrated
 * writer's edit (the exact "a raw writer beside migrated ones" hazard); on the
 * branch both writers lock the resolved target, so both edits survive.
 *
 * A harness-level rendezvous sits BEFORE the production writer (the
 * hook-critical-concurrency.test.ts shape) so the SAME child runs against a
 * baseline whose writers do not call the primitive's seams: it reads the
 * config, arms, waits for `go`, then invokes the production writer. The
 * baseline config carries a large unrelated key so the production read window
 * is wide enough for the two writers to overlap.
 *
 * Every child has its own deadline; the case budget sits above the schedule.
 * FAILS-ON-MAIN (05012c2): the overlap ENCOURAGES the race, it does not force
 * it — the fixture is run five times on each side and the counts are reported.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mcpServerSpec } from "../../src/lib/mcp-spec.ts";

const repoRoot = join(import.meta.dirname, "..", "..");
const clientsModule = join(repoRoot, "src", "install", "clients.ts");
const hookModule = join(repoRoot, "src", "hook-install.ts");
const CHILD_DEADLINE_MS = 20_000;
const CASE_BUDGET_MS = 60_000;
const RUNS = 5;

let home: string;
let barrierDir: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "flair-2cid-conc-home-"));
  barrierDir = mkdtempSync(join(tmpdir(), "flair-2cid-conc-barrier-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(barrierDir, { recursive: true, force: true });
});

const claudeJsonPath = () => join(home, ".claude.json");

/** Written per test; imports the PRODUCTION writers from the tree under test. */
function harnessSource(): string {
  return [
    'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
    `import { wireClaudeCode } from ${JSON.stringify(clientsModule)};`,
    `import { installHook } from ${JSON.stringify(hookModule)};`,
    "const dir = process.env.FLAIR_TEST_CRITICAL_BARRIER;",
    "const mode = process.argv[2];",
    "const homeDir = process.env.HOME;",
    "const cfgPath = homeDir + '/.claude.json';",
    "if (dir) {",
    "  try { readFileSync(cfgPath, 'utf-8'); } catch {}",
    "  writeFileSync(dir + '/' + process.pid + '.arm', '1');",
    "  const go = dir + '/go';",
    "  const deadline = Date.now() + 15000;",
    "  while (!existsSync(go) && Date.now() < deadline) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); }",
    "}",
    "let ok;",
    "if (mode === 'wire') {",
    "  ok = wireClaudeCode({ FLAIR_AGENT_ID: 'racebot', FLAIR_URL: 'http://127.0.0.1:19926', FLAIR_CLIENT: 'claude-code' }).ok;",
    "} else {",
    "  ok = installHook({ homeDir, harness: 'claude-code', agentId: 'hookbot', flairUrl: 'http://127.0.0.1:19926' }).ok;",
    "}",
    "process.exit(ok ? 0 : 1);",
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
    if (readdirSync(barrierDir).filter((f) => f.endsWith(".arm")).length >= n) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

/** One race; returns whether BOTH disjoint edits survived. */
async function raceOnce(): Promise<{ survived: boolean; detail: string }> {
  // Baseline: a large unrelated key so the read window is wide; empty
  // mcpServers so the JSON writer's edit (add mcpServers.flair) is real.
  const big = "x".repeat(2 * 1024 * 1024);
  writeFileSync(claudeJsonPath(), JSON.stringify({ mcpServers: {}, pad: big }) + "\n");
  // Co-locate the hook writer's settings.json with the claude.json file.
  mkdirSync(join(home, ".claude"), { recursive: true });
  symlinkSync(claudeJsonPath(), join(home, ".claude", "settings.json"));

  const harnessPath = join(home, "harness.mjs");
  writeFileSync(harnessPath, harnessSource(), "utf-8");

  const a = runHarness(harnessPath, "wire");
  const b = runHarness(harnessPath, "hook");
  const armed = await waitForArms(2, 8000);
  writeFileSync(join(barrierDir, "go"), "1");
  const ra = await a.done;
  const rb = await b.done;

  let survived = true;
  let detail = `armed=${armed} A=${JSON.stringify(ra)} B=${JSON.stringify(rb)}`;
  try {
    const cfg = JSON.parse(readFileSync(claudeJsonPath(), "utf-8"));
    const flair = cfg?.mcpServers?.flair;
    const hooks = cfg?.hooks?.SessionStart;
    if (!(flair && Array.isArray(flair.args) && flair.args.includes(flairSpec()))) {
      survived = false;
      detail += " — mcpServers.flair LOST (clobbered)";
    }
    if (!(Array.isArray(hooks) && hooks.length >= 1)) {
      survived = false;
      detail += " — hooks.SessionStart LOST (clobbered)";
    }
  } catch (e) {
    survived = false;
    detail += ` — invalid JSON: ${(e as Error).message.slice(0, 60)}`;
  }
  // Clean the symlink + file between runs.
  rmSync(join(home, ".claude"), { recursive: true, force: true });
  rmSync(claudeJsonPath(), { force: true });
  return { survived, detail };
}

function flairSpec(): string {
  // mcpServerSpec() pins to the running CLI's own version.
  return mcpServerSpec();
}

describe("E2 — two Flair writers racing on one JSON settings file", () => {
  it("both disjoint production edits survive every run (fails on main: the raw JSON writer clobbers the migrated one)", async () => {
    const failures: string[] = [];
    for (let i = 0; i < RUNS; i++) {
      const { survived, detail } = await raceOnce();
      if (!survived) failures.push(`run ${i}: ${detail}`);
    }
    expect(failures, `${failures.length}/${RUNS} runs lost an edit`).toEqual([]);
  }, CASE_BUDGET_MS);
});
