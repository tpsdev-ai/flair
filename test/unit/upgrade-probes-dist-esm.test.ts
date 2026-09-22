/**
 * upgrade-probes-dist-esm.test.ts — dist-level regression guard for flair#1657.
 *
 * `flair upgrade` detects installed libraries and the OpenClaw plugin through
 * `probeLibVersion()` and `probeOpenclawPluginVersion()` in src/cli.ts. Those
 * helpers carried a runtime `require("node:module")` / `require("node:fs")`,
 * which is not defined in the compiled dist/cli.js — an ES module that also has
 * top-level `await`. Node rejects the call, the surrounding `try/catch` swallows
 * it, and the probe returns null: an installed package is reported as missing.
 *
 * The source-level suite runs under bun, which tolerates `require` in ESM, so
 * upgrade-probes.test.ts stayed green on the broken build. This drives the REAL
 * built dist/cli.js through `node` (the runtime users run) from an ESM importer
 * and asserts the probes resolve. It builds dist/cli.js itself, so a stale or
 * absent build fails the test rather than passing it vacuously.
 */
import { describe, test, expect, beforeAll, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { ensureCliBuild } from "../helpers/build-cli-once.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dirname, "..", "..");
const CLI = join(ROOT, "dist", "cli.js");

// A tiny ESM entry point: importing dist/cli.js from an ES module is the shape
// where `require` is genuinely undefined (a CJS `node -e` can mask the bug by
// providing its own require).
const RUNNER = `
const cli = await import(process.argv[2]);
console.log(JSON.stringify({
  lib: cli.probeLibVersion("js-yaml"),
  openclaw: cli.probeOpenclawPluginVersion("openclaw-flair"),
}));
`;

let home: string;
let runnerDir: string;

// Build dist/cli.js AT MOST ONCE per lane (flair#1807) — see
// test/helpers/build-cli-once.ts. The 120 s budget names a build hang.
beforeAll(() => {
  ensureCliBuild();
}, 120_000);

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  if (runnerDir) rmSync(runnerDir, { recursive: true, force: true });
});

function runProbes(): { status: number | null; out: string; result: { lib: string | null; openclaw: string | null } } {
  home = mkdtempSync(join(tmpdir(), "flair-upgrade-probe-esm-"));
  const extDir = join(home, ".openclaw", "extensions", "openclaw-flair");
  mkdirSync(extDir, { recursive: true });
  writeFileSync(join(extDir, "package.json"), JSON.stringify({ name: "@tpsdev-ai/openclaw-flair", version: "0.7.0" }));

  const dir = mkdtempSync(join(tmpdir(), "flair-upgrade-probe-runner-"));
  runnerDir = dir;
  const runner = join(dir, "run-probes.mjs");
  writeFileSync(runner, RUNNER);

  const r = spawnSync("node", [runner, CLI], {
    encoding: "utf8",
    timeout: 30_000,
    // probeOpenclawPluginVersion reads process.env.HOME first; isolate it so
    // the test never touches the real ~/.openclaw.
    env: { ...process.env, HOME: home },
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  let result: { lib: string | null; openclaw: string | null } = { lib: null, openclaw: null };
  try {
    result = JSON.parse(r.stdout ?? "");
  } catch {
    // leave nulls — the assertions below will explain via `out`.
  }
  return { status: r.status, out, result };
}

describe("flair upgrade version probes — shipped ESM build (flair#1657)", () => {
  test("resolves an installed library and the OpenClaw plugin without a require crash", () => {
    const { status, out, result } = runProbes();

    expect(out).not.toMatch(/ERR_AMBIGUOUS_MODULE_SYNTAX/i);
    expect(out).not.toMatch(/require is not defined/i);
    expect(out).not.toMatch(/ReferenceError/i);
    expect(status, `exit=${status}\n${out.slice(0, 500)}`).toBe(0);

    // Positive control: the probe bodies genuinely ran and returned real data,
    // not merely "did not crash".
    expect(result.lib, `js-yaml probe returned ${JSON.stringify(result.lib)}; output: ${out.slice(0, 500)}`).toMatch(
      /^\d+\.\d+\.\d+/,
    );
    expect(result.openclaw).toBe("0.7.0");
  }, 45_000);
});
