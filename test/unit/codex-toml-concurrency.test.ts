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
 * COVERAGE is checked PER WRITER ([start, end] from each writer), and comes from
 * a DEDICATED sampler process (test/helpers/torn-read-sampler.ts) so the reader's
 * own content reads cannot starve it; an uncovered race is RETRIED (bounded) and
 * is a named failure only if coverage cannot be achieved. A tear on a COVERED
 * race fails immediately.
 *
 * HONEST LIMIT: the window spans the WHOLE production call (parse + stringify
 * included), so an in-window sample does NOT prove a sample fell inside the
 * destructive truncate-then-write gap. On a pre-fix (raw writer) baseline the
 * tear RED is EMPIRICAL and HOST-DEPENDENT — measured 12/12 RED on one host and
 * 1/7 on another — NOT deterministic; it is reported as measured.
 *
 * The reader's "torn" check compares each sample against EVERY complete state
 * (derived by running the production writers serially), so a legitimate
 * intermediate cannot be misread as torn.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { wireCodex, unwireCodex } from "../../src/install/clients.ts";
import {
  CoverageSampler,
  countInWindows,
  parseWindow,
  runRaceWithCoverage,
  type RaceOutcome,
  type Window,
} from "../helpers/torn-read-sampler.ts";

const repoRoot = join(import.meta.dirname, "..", "..");
const clientsModule = join(repoRoot, "src", "install", "clients.ts");
const CHILD_DEADLINE_MS = 20_000;
const CASE_BUDGET_MS = 400_000;
const RUNS = 10;
const ATTEMPTS = 5;
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

async function raceOnce(states: Set<string>): Promise<RaceOutcome> {
  mkdirSync(dir(), { recursive: true });
  writeFileSync(cfgPath(), staleBaseline(), "utf-8");

  const hpath = join(home, "race.mjs");
  writeFileSync(hpath, harnessSource(), "utf-8");
  const mk = (mode: string) =>
    spawn("bun", [hpath, mode], { cwd: repoRoot, env: { ...process.env, HOME: home, FLAIR_TEST_CRITICAL_BARRIER: barrierDir }, timeout: CHILD_DEADLINE_MS });
  const sampler = CoverageSampler.start(cfgPath());
  const a = mk("wire");
  const b = mk("unwire");
  const outs = new Map<number, string>();
  const cap = (c: ReturnType<typeof spawn>) => { c.stdout?.on("data", (d) => outs.set(c.pid ?? -1, (outs.get(c.pid ?? -1) ?? "") + d.toString())); };
  cap(a); cap(b);
  let done = 0;
  a.on("close", () => { done++; });
  b.on("close", () => { done++; });

  // Harness-level rendezvous (works against the raw writer on main too).
  const armDeadline = Date.now() + 9000;
  while (Date.now() < armDeadline) {
    if (readdirSync(barrierDir).filter((f) => f.endsWith(".arm")).length >= 2) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  writeFileSync(join(barrierDir, "go"), "1");

  // Content reads for TEAR detection (coverage is the sampler's job).
  const contentSamples: string[] = [];
  let i = 0;
  while (done < 2) {
    try { contentSamples.push(readFileSync(cfgPath(), "utf-8")); } catch { /* transient */ }
    if ((++i % 200) === 0) await new Promise((r) => setImmediate(r));
  }

  const coverTs = await sampler.stop();
  sampler.dispose();

  const windows: Window[] = [];
  for (const out of outs.values()) {
    const w = parseWindow(out);
    if (w) windows.push(w);
  }
  const inWindow = countInWindows(coverTs, windows);
  const tornSamples = contentSamples.filter((s) => !states.has(s));
  const distinct = [...new Set(tornSamples.map((s) => s.length))].slice(0, 8);
  const detail = `cover=${coverTs.length} content=${contentSamples.length} windows=${windows.length} inWindow=${inWindow} torn=${tornSamples.length} distinctTornLen=[${distinct}] states=${states.size}`;
  rmSync(dir(), { recursive: true, force: true });
  return { covered: windows.length > 0 && inWindow > 0, tears: tornSamples.length, detail };
}

describe("T2 — two Codex writers share one critical section (mechanism)", () => {
  it(
    "a concurrent reader never sees a half-written config.toml (EMPIRICAL, host-dependent RED on main)",
    async () => {
      const states = completeStates(staleBaseline());
      const coverageFailures: string[] = [];
      const tears: string[] = [];
      for (let run = 0; run < RUNS; run++) {
        const o = await runRaceWithCoverage(() => raceOnce(states), ATTEMPTS);
        if (o.coverageFailure) coverageFailures.push(`run ${run} (${o.attempts} attempts): ${o.details.join(" ; ")}`);
        else if (o.tears > 0) tears.push(`run ${run}: ${o.details[o.details.length - 1]}`);
      }
      expect(coverageFailures, `coverage failures (${coverageFailures.length}/${RUNS}): ${coverageFailures.join(" | ")}`).toEqual([]);
      expect(tears, `torn reads (${tears.length}/${RUNS}): ${tears.join(" | ")}`).toEqual([]);
    },
    CASE_BUDGET_MS,
  );
});
