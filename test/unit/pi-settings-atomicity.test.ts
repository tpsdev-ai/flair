/**
 * pi-settings-atomicity.test.ts — flair#1778 slice 2c-i-d3, fixture P1 (the
 * headline). A child reader polls settings.json while the production writer
 * rewrites a large file (a 4 MiB whitespace pad that the writer's re-stringify
 * drops); on the pre-fix baseline the raw `writeFileSync` truncates in place, so
 * the reader observes a partial/torn length. On the branch the write is a
 * temp+fsync+rename, so the reader sees only the complete old or new bytes.
 *
 * COVERAGE is checked PER WRITER ([start, end] from the writer itself): a writer
 * whose window contains no reader sample is a NAMED coverage failure, never a
 * pass. Coverage misses are reported SEPARATELY from observed tears.
 *
 * HONEST LIMIT (applies to d2's T2 too): the window spans the WHOLE production
 * call — parse and stringify included — so an in-window sample does NOT prove a
 * sample fell inside the destructive truncate-then-write gap. Main's RED is
 * EMPIRICAL, not guaranteed; it is reported as measured, not called
 * deterministic. (Deterministic detection would need synchronization at the
 * destructive write, which a raw writeFileSync does not offer.)
 *
 * ISOLATION: HOME and PI_CODING_AGENT_DIR both point into the temp dir, and the
 * resolved settings path is asserted inside it.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PI_FLAIR_PACKAGE, piSettingsPath } from "../../src/install/clients.ts";

const repoRoot = join(import.meta.dirname, "..", "..");
const clientsModule = join(repoRoot, "src", "install", "clients.ts");
const CHILD_DEADLINE_MS = 20_000;
const CASE_BUDGET_MS = 300_000;
const RUNS = 10;
const PAD = " ".repeat(2 * 1024 * 1024);

let home: string;
let pcd: string;
let prevHome: string | undefined;
let prevPcd: string | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "flair-2cid3-p1-home-"));
  pcd = join(home, "pcd");
  mkdirSync(pcd, { recursive: true });
  prevHome = process.env.HOME;
  prevPcd = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = pcd;
});
afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome; else delete process.env.HOME;
  if (prevPcd !== undefined) process.env.PI_CODING_AGENT_DIR = prevPcd; else delete process.env.PI_CODING_AGENT_DIR;
  rmSync(home, { recursive: true, force: true });
});

const cfgPath = () => join(pcd, "settings.json");

function baseline(): string {
  return JSON.stringify({ packages: [`npm:${PI_FLAIR_PACKAGE}@0.0.1`] }, null, 2) + "\n" + PAD;
}
function harnessSource(): string {
  return [
    `import { wirePi } from ${JSON.stringify(clientsModule)};`,
    "const start = Date.now();",
    "const res = wirePi({ FLAIR_AGENT_ID: 'pibot', FLAIR_URL: 'http://127.0.0.1:19926', FLAIR_CLIENT: 'pi' });",
    "process.stdout.write(JSON.stringify({ start, end: Date.now(), ok: res.ok }));",
    "process.exit(res.ok ? 0 : 1);",
  ].join("\n");
}

interface Outcome { tears: number; coverageMiss: boolean; detail: string; }

async function raceOnce(): Promise<Outcome> {
  expect(piSettingsPath()).toBe(cfgPath());
  expect(piSettingsPath().startsWith(pcd + "/")).toBe(true);
  writeFileSync(cfgPath(), baseline(), "utf-8");
  const oldLen = Buffer.byteLength(baseline());
  const hpath = join(home, "w.mjs");
  writeFileSync(hpath, harnessSource(), "utf-8");
  const child = spawn("bun", [hpath], {
    cwd: repoRoot,
    env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: pcd },
    timeout: CHILD_DEADLINE_MS,
  });
  let out = "";
  child.stdout?.on("data", (d) => (out += d.toString()));
  let done = false;
  child.on("close", () => { done = true; });

  const lens: number[] = [];
  const ts: number[] = [];
  let i = 0;
  while (!done) {
    try { lens.push(readFileSync(cfgPath()).length); ts.push(Date.now()); } catch { /* transient */ }
    if ((++i % 200) === 0) await new Promise((r) => setImmediate(r));
  }
  if (child.exitCode === null) await new Promise((r) => child.on("close", r));

  const newLen = readFileSync(cfgPath()).length;
  const info = JSON.parse(out.match(/\{[^}]*\}/)![0]);
  const complete = new Set([oldLen, newLen]);
  const tears = lens.filter((l) => !complete.has(l)).length;
  const inWindow = ts.filter((t) => t >= info.start && t <= info.end).length;
  const detail = `old=${oldLen} new=${newLen} samples=${lens.length} inWindow=${inWindow} tears=${tears}`;
  rmSync(cfgPath(), { force: true });
  return { tears, coverageMiss: inWindow === 0, detail };
}

describe("P1 — torn read", () => {
  it(
    "a reader polling during the writer's rewrite sees ONLY the complete old or new bytes",
    async () => {
      const coverageMisses: string[] = [];
      const tears: string[] = [];
      for (let run = 0; run < RUNS; run++) {
        const o = await raceOnce();
        if (o.coverageMiss) coverageMisses.push(`run ${run}: ${o.detail}`);
        else if (o.tears > 0) tears.push(`run ${run}: ${o.detail}`);
      }
      // Coverage misses are a NAMED failure (the check could not fire), never a pass.
      expect(coverageMisses, `coverage misses (${coverageMisses.length}/${RUNS}): ${coverageMisses.join(" | ")}`).toEqual([]);
      expect(tears, `torn reads (${tears.length}/${RUNS}): ${tears.join(" | ")}`).toEqual([]);
    },
    CASE_BUDGET_MS,
  );
});
