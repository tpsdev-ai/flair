/**
 * pi-settings-atomicity.test.ts — flair#1778 slice 2c-i-d3, fixture P1 (the
 * headline). A reader polls settings.json while the production writer rewrites a
 * large file (a 2 MiB whitespace pad that the writer's re-stringify drops); on
 * the pre-fix baseline the raw `writeFileSync` truncates in place, so a content
 * read can observe a partial/torn length. On the branch the write is a
 * temp+fsync+rename, so the reader sees only the complete old or new bytes.
 *
 * COVERAGE comes from a DEDICATED sampler process (test/helpers/
 * torn-read-sampler.ts), so the reader's own content reads cannot starve it; an
 * uncovered race is RETRIED (bounded) and is a named failure only if coverage
 * cannot be achieved. A tear on a COVERED race fails immediately. Coverage is
 * checked PER WRITER ([start, end] from the writer itself).
 *
 * HONEST LIMIT (shared with d2's T1a/T2): the window spans the WHOLE production
 * call — parse and stringify included — so an in-window sample does NOT prove a
 * sample fell inside the destructive truncate-then-write gap. On a pre-fix (raw
 * writer) baseline the tear RED is EMPIRICAL and HOST-DEPENDENT, not
 * deterministic; it is reported as measured.
 *
 * ISOLATION: HOME and PI_CODING_AGENT_DIR both point into the temp dir, and the
 * resolved settings path is asserted inside it.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PI_FLAIR_PACKAGE, piSettingsPath } from "../../src/install/clients.ts";
import {
  CoverageSampler,
  countInWindows,
  countTears,
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

async function raceOnce(): Promise<RaceOutcome> {
  expect(piSettingsPath()).toBe(cfgPath());
  expect(piSettingsPath().startsWith(pcd + "/")).toBe(true);
  const oldText = baseline();
  writeFileSync(cfgPath(), oldText, "utf-8");
  const oldLen = Buffer.byteLength(oldText);

  const hpath = join(home, "w.mjs");
  writeFileSync(hpath, harnessSource(), "utf-8");

  const sampler = CoverageSampler.start(cfgPath());
  const child = spawn("bun", [hpath], {
    cwd: repoRoot,
    env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: pcd },
    timeout: CHILD_DEADLINE_MS,
  });
  let out = "";
  child.stdout?.on("data", (d) => (out += d.toString()));
  let done = false;
  child.on("close", () => { done = true; });

  // Content reads for TEAR detection (coverage is the sampler's job).
  const contentLens: number[] = [];
  let i = 0;
  while (!done) {
    try { contentLens.push(readFileSync(cfgPath()).length); } catch { /* transient */ }
    if ((++i % 200) === 0) await new Promise((r) => setImmediate(r));
  }
  if (child.exitCode === null) await new Promise((r) => child.on("close", r));

  const coverTs = await sampler.stop();
  sampler.dispose();

  const newLen = Buffer.byteLength(readFileSync(cfgPath(), "utf-8"));
  const win = parseWindow(out);
  const windows: Window[] = win ? [win] : [];
  const covered = windows.length > 0 && countInWindows(coverTs, windows) > 0;
  const tears = countTears(contentLens, [oldLen, newLen]);
  const detail = `old=${oldLen} new=${newLen} cover=${coverTs.length} content=${contentLens.length} inWindow=${windows.length ? countInWindows(coverTs, windows) : 0} tears=${tears} ok=${/\"ok\":true/.test(out)}`;
  rmSync(cfgPath(), { force: true });
  return { covered, tears, detail };
}

describe("P1 — torn read", () => {
  it(
    "a reader polling during the writer's rewrite sees ONLY the complete old or new bytes",
    async () => {
      const coverageFailures: string[] = [];
      const tears: string[] = [];
      for (let run = 0; run < RUNS; run++) {
        const o = await runRaceWithCoverage(raceOnce, ATTEMPTS);
        if (o.coverageFailure) coverageFailures.push(`run ${run} (${o.attempts} attempts): ${o.details.join(" ; ")}`);
        else if (o.tears > 0) tears.push(`run ${run}: ${o.details[o.details.length - 1]}`);
      }
      expect(coverageFailures, `coverage failures (${coverageFailures.length}/${RUNS}): ${coverageFailures.join(" | ")}`).toEqual([]);
      expect(tears, `torn reads (${tears.length}/${RUNS}): ${tears.join(" | ")}`).toEqual([]);
    },
    CASE_BUDGET_MS,
  );
});
