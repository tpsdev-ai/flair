/**
 * pi-settings-orphaned-lock.test.ts — flair#1778 slice 2c-i-d3, fixture P5.
 *
 * A crash between the fsync and the rename (the primitive's crash window) leaves
 * the target byte-identical and orphans the staging temp + the lock. The lock is
 * NOT ignored: a second production writer REFUSES on it by name.
 * (Crash-only provable reclaim is tracked as flair#1831.)
 *
 * MUTATION (reported): make acquireLock accept a held lock on EEXIST → the
 * second writer no longer refuses → the assertion fails.
 *
 * ISOLATION: HOME and PI_CODING_AGENT_DIR both point into the temp dir.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { PI_FLAIR_PACKAGE, piSettingsPath, wirePi } from "../../src/install/clients.ts";

const repoRoot = join(import.meta.dirname, "..", "..");
const clientsModule = join(repoRoot, "src", "install", "clients.ts");
const CHILD_DEADLINE_MS = 20_000;
const CASE_BUDGET_MS = 40_000;

let home: string;
let pcd: string;
let prevHome: string | undefined;
let prevPcd: string | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "flair-2cid3-p5-home-"));
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

function harnessSource(): string {
  return [
    `import { wirePi } from ${JSON.stringify(clientsModule)};`,
    "const res = wirePi({ FLAIR_AGENT_ID: 'pibot', FLAIR_URL: 'http://127.0.0.1:19926', FLAIR_CLIENT: 'pi' });",
    "process.stdout.write(JSON.stringify(res));",
    "process.exit(res.ok ? 0 : 1);",
  ].join("\n");
}

const ENV = { FLAIR_AGENT_ID: "pibot", FLAIR_URL: "http://127.0.0.1:19926", FLAIR_CLIENT: "pi" };

describe("P5 — SIGKILL after fsync leaves a lock a later writer REFUSES on", () => {
  it("target byte-identical; the second writer refuses by name (pid + host + lock path)", async () => {
    expect(piSettingsPath()).toBe(cfgPath());
    expect(piSettingsPath().startsWith(pcd + "/")).toBe(true);
    const before = JSON.stringify({ packages: [`npm:${PI_FLAIR_PACKAGE}@0.0.1`] }, null, 2) + "\n";
    writeFileSync(cfgPath(), before, "utf-8");
    const beforeHash = createHash("sha256").update(readFileSync(cfgPath())).digest("hex");

    const barrierDir = mkdtempSync(join(tmpdir(), "flair-2cid3-p5-barrier-"));
    try {
      const hpath = join(home, "k.mjs");
      writeFileSync(hpath, harnessSource(), "utf-8");
      const child = spawn("bun", [hpath], {
        cwd: repoRoot,
        env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: pcd, FLAIR_TEST_CRITICAL_BARRIER: barrierDir },
        timeout: CHILD_DEADLINE_MS,
      });
      let err = "";
      child.stderr?.on("data", (d) => (err += d.toString()));
      const closed = new Promise((r) => child.on("close", () => r(null)));
      // Release the EARLIER stages only, so the writer pauses at the fsync stage.
      writeFileSync(join(barrierDir, "go.preObserve"), "1");
      writeFileSync(join(barrierDir, "go.read"), "1");

      const deadline = Date.now() + 10_000;
      let armed = false;
      while (Date.now() < deadline) {
        if (readdirSync(barrierDir).some((f) => f.endsWith(".fsync"))) { armed = true; break; }
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(armed, `writer never reached the fsync barrier; markers=${readdirSync(barrierDir).join(",")} err=${err.slice(0, 200)}`).toBe(true);

      child.kill("SIGKILL");
      await closed;

      expect(createHash("sha256").update(readFileSync(cfgPath())).digest("hex")).toBe(beforeHash);

      const temps = readdirSync(pcd).filter((f) => f.includes(".tmp-"));
      const lockPath = `${cfgPath()}.lock`;
      console.log(`P5 orphaned: temp=${JSON.stringify(temps)} lock=${existsSync(lockPath)}`);
      expect(temps.length, "expected an orphaned staging temp after SIGKILL").toBeGreaterThan(0);
      expect(existsSync(lockPath), "expected an orphaned lock after SIGKILL").toBe(true);

      const refused = wirePi(ENV);
      expect(refused.ok).toBe(false);
      expect(refused.message).toContain(lockPath);
      expect(refused.message).toContain(`recorded holder pid ${child.pid}`);
      expect(refused.message).toContain(hostname());
      expect(refused.message).toContain("Quiesce Flair writers");
      expect(createHash("sha256").update(readFileSync(cfgPath())).digest("hex")).toBe(beforeHash);
    } finally {
      rmSync(barrierDir, { recursive: true, force: true });
    }
  }, CASE_BUDGET_MS);
});
