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
 * DETERMINISTIC RED ON MAIN (round 2, cli#1830 review): the reader must have
 * SAMPLED INSIDE a writer's [start, end] window (each writer reports its own
 * window), or the torn check could not fire — a race with no in-window sample
 * is a NAMED FAILURE, never a pass. The poll runs across the writers' full
 * lifetimes plus a grace tail (bounded by a deadline that is itself a failure),
 * so the window is always covered. A large pad widens each writer's window so
 * the raw writer's in-place truncate is reliably observed.
 *
 * The reader's "torn" check compares each sample against EVERY complete state
 * (derived by running the production writers serially), so a legitimate
 * intermediate cannot be misread as torn. FAILS-ON-MAIN (05012c2).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { wireCodex, unwireCodex } from "../../src/install/clients.ts";

const repoRoot = join(import.meta.dirname, "..", "..");
const clientsModule = join(repoRoot, "src", "install", "clients.ts");
const CHILD_DEADLINE_MS = 20_000;
const CASE_BUDGET_MS = 240_000;
const RUNS = 10;
const PAD = "x".repeat(8 * 1024 * 1024);

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
  const seq = (steps: Array<"wire" | "unwire">): void => {
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
    "const start = Date.now();",
    "const res = mode === 'wire' ? wireCodex({ FLAIR_AGENT_ID: 'codexbot', FLAIR_URL: 'http://127.0.0.1:19926', FLAIR_CLIENT: 'codex' }) : unwireCodex();",
    "const end = Date.now();",
    "process.stdout.write(JSON.stringify({ start, end, ok: res.ok, mode }));",
    "process.exit(res.ok ? 0 : 1);",
  ].join("\n");
}

interface Window { start: number; end: number; }

async function raceOnce(states: Set<string>): Promise<{ torn: number; inWindow: number; detail: string }> {
  mkdirSync(dir(), { recursive: true });
  writeFileSync(cfgPath(), staleBaseline(), "utf-8");

  const hpath = join(home, "race.mjs");
  writeFileSync(hpath, harnessSource(), "utf-8");
  const mk = (mode: string) =>
    spawn("bun", [hpath, mode], { cwd: repoRoot, env: { ...process.env, HOME: home, FLAIR_TEST_CRITICAL_BARRIER: barrierDir }, timeout: CHILD_DEADLINE_MS });
  const a = mk("wire");
  const b = mk("unwire");
  const outs = new Map<number, string>();
  let done = 0;
  a.stdout?.on("data", (d) => outs.set(a.pid ?? -1, (outs.get(a.pid ?? -1) ?? "") + d.toString()));
  b.stdout?.on("data", (d) => outs.set(b.pid ?? -1, (outs.get(b.pid ?? -1) ?? "") + d.toString()));
  const fin = () => { done++; };
  a.on("close", fin);
  b.on("close", fin);

  // Rendezvous (harness-level, so it works against the raw writer on main too).
  const armDeadline = Date.now() + 9000;
  while (Date.now() < armDeadline) {
    if (readdirSync(barrierDir).filter((f) => f.endsWith(".arm")).length >= 2) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  writeFileSync(join(barrierDir, "go"), "1");

  // Poll ACROSS the writers' full lifetimes, plus a grace tail so the window is
  // always covered. The hard deadline expiring without coverage is a failure.
  const samples: { t: number; text: string }[] = [];
  const pollDeadline = Date.now() + 20_000;
  const GRACE_MS = 250;
  let exitedAt = 0;
  let i = 0;
  while (Date.now() < pollDeadline) {
    try { samples.push({ t: Date.now(), text: readFileSync(cfgPath(), "utf-8") }); } catch { /* transient */ }
    if (done === 2 && exitedAt === 0) exitedAt = Date.now();
    if (exitedAt !== 0 && Date.now() - exitedAt > GRACE_MS) break;
    if ((++i % 200) === 0) await new Promise((r) => setImmediate(r));
  }

  // Parse each writer's own [start, end] window.
  const windows: Window[] = [];
  for (const out of outs.values()) {
    const parsed = out.match(/\{[^}]*\}/g);
    if (parsed) for (const p of parsed) { try { const o = JSON.parse(p); if (typeof o.start === "number" && typeof o.end === "number") windows.push({ start: o.start, end: o.end }); } catch { /* */ } }
  }

  const inWindow = samples.filter((s) => windows.some((w) => s.t >= w.start && s.t <= w.end)).length;
  const tornSamples = samples.filter((s) => !states.has(s.text));
  const distinct = [...new Set(tornSamples.map((s) => s.text.length))].slice(0, 8);
  const detail = `samples=${samples.length} inWindow=${inWindow} windows=${JSON.stringify(windows)} torn=${tornSamples.length} distinctTornLen=[${distinct}] states=${states.size}`;
  rmSync(dir(), { recursive: true, force: true });
  return { torn: tornSamples.length, inWindow, detail };
}

describe("T2 — two Codex writers share one critical section (mechanism)", () => {
  it(
    "a concurrent reader never sees a half-written config.toml (deterministically fails on main)",
    async () => {
      const states = completeStates(staleBaseline());
      const failures: string[] = [];
      let tornRuns = 0;
      for (let run = 0; run < RUNS; run++) {
        const { torn, inWindow, detail } = await raceOnce(states);
        // The reader MUST have sampled inside a writer's window, or the check
        // could not fire — that is a named failure, never a pass.
        if (inWindow === 0) failures.push(`run ${run}: reader never sampled inside a writer window — ${detail}`);
        else if (torn > 0) { failures.push(`run ${run}: ${detail}`); tornRuns++; }
      }
      expect(failures, `${tornRuns}/${RUNS} runs torn; ${failures.join(" | ")}`).toEqual([]);
    },
    CASE_BUDGET_MS,
  );
});
