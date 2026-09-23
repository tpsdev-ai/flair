/**
 * pi-settings-pin-guard-in-lock.test.ts — flair#1778 slice 2c-i-d3, fixture P3.
 *
 * The never-lower guard must run on the IN-LOCK bytes. A competing writer lands
 * an AHEAD pi-flair pin (in the `packages` entry) after the Codex-style
 * pre-lock observation; the in-lock decision must SEE it and HOLD — never lower
 * it. Uses the primitive's env-gated barrier (honored only by the migrated
 * writer): the production writer pauses after its pre-lock observation, the
 * competing writer commits an AHEAD pin, then the writer proceeds and holds.
 *
 * MUTATION (reported): decide on the PRE-LOCK parse instead of the in-lock
 * bytes — the competing AHEAD pin is invisible and is LOWERED.
 *
 * ISOLATION: HOME and PI_CODING_AGENT_DIR both point into the temp dir.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PI_FLAIR_PACKAGE, piSettingsPath } from "../../src/install/clients.ts";

const repoRoot = join(import.meta.dirname, "..", "..");
const clientsModule = join(repoRoot, "src", "install", "clients.ts");
const CHILD_DEADLINE_MS = 20_000;
const CASE_BUDGET_MS = 40_000;

let home: string;
let pcd: string;
let barrierDir: string;
let prevHome: string | undefined;
let prevPcd: string | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "flair-2cid3-p3-home-"));
  pcd = join(home, "pcd");
  mkdirSync(pcd, { recursive: true });
  barrierDir = mkdtempSync(join(tmpdir(), "flair-2cid3-p3-barrier-"));
  prevHome = process.env.HOME;
  prevPcd = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = pcd;
});
afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome; else delete process.env.HOME;
  if (prevPcd !== undefined) process.env.PI_CODING_AGENT_DIR = prevPcd; else delete process.env.PI_CODING_AGENT_DIR;
  rmSync(home, { recursive: true, force: true });
  rmSync(barrierDir, { recursive: true, force: true });
});

const cfgPath = () => join(pcd, "settings.json");
const spec = (v: string) => `npm:${PI_FLAIR_PACKAGE}@${v}`;

function harnessSource(): string {
  return [
    `import { wirePi } from ${JSON.stringify(clientsModule)};`,
    "const res = wirePi({ FLAIR_AGENT_ID: process.env.FLAIR_AGENT_ID, FLAIR_URL: 'http://127.0.0.1:19926', FLAIR_CLIENT: 'pi' });",
    "process.stdout.write(JSON.stringify(res));",
    "process.exit(res.ok ? 0 : 1);",
  ].join("\n");
}

describe("P3 — the pi pin guard decides on the IN-LOCK bytes", () => {
  it("a competing AHEAD pi-flair pin committed in the window is HELD, never lowered", async () => {
    expect(piSettingsPath()).toBe(cfgPath());
    expect(piSettingsPath().startsWith(pcd + "/")).toBe(true);
    writeFileSync(cfgPath(), JSON.stringify({ packages: [spec("0.0.1")] }, null, 2) + "\n", "utf-8");

    const hpath = join(home, "h.mjs");
    writeFileSync(hpath, harnessSource(), "utf-8");
    const child = spawn("bun", [hpath], {
      cwd: repoRoot,
      env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: pcd, FLAIR_AGENT_ID: "pibot", FLAIR_TEST_CRITICAL_BARRIER: barrierDir },
      timeout: CHILD_DEADLINE_MS,
    });
    let out = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    const done = new Promise((r) => child.on("close", () => r(null)));

    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      if (readdirSync(barrierDir).some((f) => f.endsWith(".preObserve"))) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    // The competing writer commits an AHEAD pin, then releases the writer.
    writeFileSync(cfgPath(), JSON.stringify({ packages: [spec("9.9.9")] }, null, 2) + "\n", "utf-8");
    writeFileSync(join(barrierDir, "go"), "1");

    await done;
    const cfg = JSON.parse(readFileSync(cfgPath(), "utf-8"));
    expect(cfg.packages).toContain(spec("9.9.9"));
    expect(out).toContain("holding");
  }, CASE_BUDGET_MS);
});
