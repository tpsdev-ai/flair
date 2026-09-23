/**
 * codex-toml-concurrency.test.ts — flair#1778 slice 2c-i-d2, fixture T2.
 *
 * MECHANISM NOTE: ~/.codex/config.toml carries exactly ONE Flair-managed block
 * (`[mcp_servers.flair]`), so two Codex writers CANNOT make disjoint edits
 * there and a Flair-vs-Flair lost update is not the hazard (the module's own
 * header says so). This fixture proves the MECHANISM instead: the two Codex
 * writers (`wireCodex` / `unwireCodex`) share ONE critical section, so a
 * concurrent reader never sees a half-written config.toml — the raw writer
 * truncated in place; the primitive stages a temp and renames.
 *
 * The reader's "torn" check compares each sample against EVERY complete state
 * (derived by running the production writers serially), so it cannot be fooled
 * by a legitimate intermediate. A harness rendezvous sits BEFORE the production
 * writers (the hook-critical-concurrency.test.ts shape). FAILS-ON-MAIN
 * (05012c2): the raw writers truncate in place, so partial files are observed.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { wireCodex, unwireCodex } from "../../src/install/clients.ts";

const repoRoot = join(import.meta.dirname, "..", "..");
const clientsModule = join(repoRoot, "src", "install", "clients.ts");
const CHILD_DEADLINE_MS = 20_000;
const CASE_BUDGET_MS = 90_000;
const RUNS = 5;
const PAD = "x".repeat(2 * 1024 * 1024);

let home: string;
let barrierDir: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "flair-2cid2-t2-home-"));
  barrierDir = mkdtempSync(join(tmpdir(), "flair-2cid2-t2-barrier-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(barrierDir, { recursive: true, force: true });
});

const cfgPath = () => join(home, ".codex", "config.toml");
const dir = () => join(home, ".codex");

function staleBaseline(): string {
  return [
    `[other]`,
    `k = "v"`,
    ``,
    `[mcp_servers.flair]`,
    `command = "npx"`,
    `args = ["-y", "@tpsdev-ai/flair-mcp@0.0.1"]`,
    ``,
    `[mcp_servers.flair.env]`,
    `FLAIR_AGENT_ID = "codexbot"`,
    `FLAIR_URL = "http://127.0.0.1:19926"`,
    ``,
    `# ${PAD}`,
    ``,
  ].join("\n");
}

/** Run the production writers serially on a copy to enumerate complete states. */
function completeStates(baseline: string): Set<string> {
  const states = new Set<string>([baseline]);
  const seq = (steps: Array<"wire" | "unwire">): string => {
    const h = mkdtempSync(join(tmpdir(), "flair-2cid2-t2-seq-"));
    const prev = process.env.HOME;
    process.env.HOME = h;
    try {
      mkdirSync(join(h, ".codex"), { recursive: true });
      writeFileSync(join(h, ".codex", "config.toml"), baseline, "utf-8");
      for (const s of steps) {
        if (s === "wire") wireCodex({ FLAIR_AGENT_ID: "codexbot", FLAIR_URL: "http://127.0.0.1:19926", FLAIR_CLIENT: "codex" });
        else unwireCodex();
        states.add(readFileSync(join(h, ".codex", "config.toml"), "utf-8"));
      }
      return readFileSync(join(h, ".codex", "config.toml"), "utf-8");
    } finally {
      if (prev !== undefined) process.env.HOME = prev; else delete process.env.HOME;
      rmSync(h, { recursive: true, force: true });
    }
  };
  seq(["wire"]);
  seq(["unwire"]);
  seq(["wire", "unwire"]);
  seq(["unwire", "wire"]);
  return states;
}

function harnessSource(): string {
  return [
    'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
    `import { wireCodex, unwireCodex } from ${JSON.stringify(clientsModule)};`,
    "const dir = process.env.FLAIR_TEST_CRITICAL_BARRIER;",
    "const mode = process.argv[2];",
    "const homeDir = process.env.HOME;",
    "const cfg = homeDir + '/.codex/config.toml';",
    "if (dir) {",
    "  try { readFileSync(cfg, 'utf-8'); } catch {}",
    "  writeFileSync(dir + '/' + process.pid + '.arm', '1');",
    "  const go = dir + '/go';",
    "  const deadline = Date.now() + 15000;",
    "  while (!existsSync(go) && Date.now() < deadline) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); }",
    "}",
    "const res = mode === 'wire' ? wireCodex({ FLAIR_AGENT_ID: 'codexbot', FLAIR_URL: 'http://127.0.0.1:19926', FLAIR_CLIENT: 'codex' }) : unwireCodex();",
    "process.exit(res.ok ? 0 : 1);",
  ].join("\n");
}

async function raceOnce(states: Set<string>): Promise<{ torn: number; detail: string }> {
  mkdirSync(dir(), { recursive: true });
  writeFileSync(cfgPath(), staleBaseline(), "utf-8");

  const hpath = join(home, "race.mjs");
  writeFileSync(hpath, harnessSource(), "utf-8");
  const mk = (mode: string) => spawn("bun", [hpath, mode], { cwd: repoRoot, env: { ...process.env, HOME: home, FLAIR_TEST_CRITICAL_BARRIER: barrierDir }, timeout: CHILD_DEADLINE_MS });
  const a = mk("wire");
  const b = mk("unwire");
  let done = 0;
  const all = new Promise((r) => { const fin = () => { if (++done === 2) r(null); }; a.on("close", fin); b.on("close", fin); });

  const armDeadline = Date.now() + 9000;
  while (Date.now() < armDeadline) {
    if (readdirSync(barrierDir).filter((f) => f.endsWith(".arm")).length >= 2) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  writeFileSync(join(barrierDir, "go"), "1");

  const samples: string[] = [];
  const pollUntil = Date.now() + 6000;
  let i = 0;
  while (Date.now() < pollUntil) {
    try { samples.push(readFileSync(cfgPath(), "utf-8")); } catch { /* transient */ }
    if ((++i % 200) === 0) await new Promise((r) => setImmediate(r));
    if (done === 2 && samples.length > 0) break;
  }
  await all;

  const tornSamples = samples.filter((s) => !states.has(s));
  const distinct = [...new Set(tornSamples.map((s) => s.length))].slice(0, 8);
  const detail = `samples=${samples.length} torn=${tornSamples.length} distinctTornLen=[${distinct}] states=${states.size}`;
  rmSync(dir(), { recursive: true, force: true });
  return { torn: tornSamples.length, detail };
}

describe("T2 — two Codex writers share one critical section (mechanism)", () => {
  it("a concurrent reader never sees a half-written config.toml (fails on main: the raw writer truncates in place)", async () => {
    const states = completeStates(staleBaseline());
    const failures: string[] = [];
    for (let run = 0; run < RUNS; run++) {
      const { torn, detail } = await raceOnce(states);
      if (torn > 0) failures.push(`run ${run}: ${detail}`);
    }
    expect(failures, failures.join(" | ")).toEqual([]);
  }, CASE_BUDGET_MS);
});
