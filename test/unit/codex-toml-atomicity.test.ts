/**
 * codex-toml-atomicity.test.ts — flair#1778 slice 2c-i-d2, fixture T1.
 *
 * The value of moving config.toml onto the primitive is ATOMIC, non-torn
 * writes: a raw `writeFileSync` truncates then writes in place, so a reader
 * (Codex itself) can see a half-written config and a crash mid-write leaves it
 * partial. The primitive stages a temp, fsyncs, then renames — a reader sees
 * the old bytes or the new ones, never a mix.
 *
 *   T1a  TORN READ (honest RED on the pre-fix baseline): a reader polls the
 *        file while the production writer rewrites it. Fails on main (the raw
 *        write truncates in place); 0 on the branch. Proves the reader sampled
 *        across the write window (timestamps), or the check could not fire.
 *   T1b  EXCEPTION MID-WRITE: the staged write throws after the temp exists →
 *        the target is byte-identical and no staging temp remains.
 *   T1c  SIGKILL AFTER FSYNC, BEFORE RENAME: the child is killed in the crash
 *        window → the target is byte-identical; the orphaned temp + lock are
 *        REPORTED (a SIGKILL bypasses cleanup and lock release, so they are
 *        NOT asserted absent).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { hostname } from "node:os";
import { join } from "node:path";

import { withConfigCriticalSection } from "../../src/lib/config-critical-section.ts";
import { wireCodex } from "../../src/install/clients.ts";
import { createHash } from "node:crypto";

const repoRoot = join(import.meta.dirname, "..", "..");
const clientsModule = join(repoRoot, "src", "install", "clients.ts");
const CHILD_DEADLINE_MS = 20_000;
const CASE_BUDGET_MS = 90_000;
const RUNS = 3;
const PAD = "x".repeat(2 * 1024 * 1024);

let home: string;
let prevHome: string | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "flair-2cid2-t1-home-"));
  // T1a spawns children with HOME=home; T1c additionally drives the PRODUCTION
  // writer IN-PROCESS, which resolves ~ via resolveHome() — so the test process
  // HOME must be isolated too (never the real ~/.codex/config.toml).
  prevHome = process.env.HOME;
  process.env.HOME = home;
});
afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome;
  else delete process.env.HOME;
  rmSync(home, { recursive: true, force: true });
});

const cfgPath = () => join(home, ".codex", "config.toml");
const dir = () => join(home, ".codex");

function staleSection(spec: string): string {
  return [
    `[mcp_servers.flair]`,
    `command = "npx"`,
    `args = ["-y", "${spec}"]`,
    ``,
    `[mcp_servers.flair.env]`,
    `FLAIR_AGENT_ID = "codexbot"`,
    `FLAIR_URL = "http://127.0.0.1:19926"`,
    ``,
  ].join("\n");
}

function writerHarness(): string {
  return [
    `import { wireCodex } from ${JSON.stringify(clientsModule)};`,
    "const start = Date.now();",
    "const res = wireCodex({ FLAIR_AGENT_ID: 'codexbot', FLAIR_URL: 'http://127.0.0.1:19926', FLAIR_CLIENT: 'codex' });",
    "process.stdout.write(JSON.stringify({ start, end: Date.now(), ok: res.ok }));",
    "process.exit(res.ok ? 0 : 1);",
  ].join("\n");
}

describe("T1a — torn read", () => {
  it("a reader polling during the writer's rewrite sees ONLY the complete old or new bytes", async () => {
    const failures: string[] = [];
    let totalInWindow = 0;
    for (let run = 0; run < RUNS; run++) {
      mkdirSync(dir(), { recursive: true });
      const oldText = staleSection("@tpsdev-ai/flair-mcp@0.0.1") + `# ${PAD}\n`;
      writeFileSync(cfgPath(), oldText, "utf-8");
      const oldLen = Buffer.byteLength(oldText);

      const hpath = join(home, `w-${run}.mjs`);
      writeFileSync(hpath, writerHarness(), "utf-8");
      const child = spawn("bun", [hpath], { cwd: repoRoot, env: { ...process.env, HOME: home }, timeout: CHILD_DEADLINE_MS });
      let out = "";
      let err = "";
      child.stdout?.on("data", (d) => (out += d.toString()));
      child.stderr?.on("data", (d) => (err += d.toString()));
      const ended = new Promise((r) => child.on("close", () => r(null)));

      const lens: number[] = [];
      const ts: number[] = [];
      const pollStart = Date.now();
      const pollUntil = pollStart + 8000;
      let i = 0;
      // Yield to the event loop periodically so the child's 'close' sets
      // child.exitCode; a pure sync loop would block it.
      while (Date.now() < pollUntil && child.exitCode === null) {
        try { lens.push(readFileSync(cfgPath()).length); ts.push(Date.now()); } catch { /* transient */ }
        if ((++i % 300) === 0) await new Promise((r) => setImmediate(r));
      }
      await ended;

      const newLen = readFileSync(cfgPath()).length;
      let info: { start: number; end: number; ok: boolean } | null = null;
      try { info = JSON.parse(out); } catch { /* child failed */ }
      const complete = new Set([oldLen, newLen]);
      const torn = lens.filter((l) => !complete.has(l));
      const inWindow = info ? ts.filter((t) => t >= info.start && t <= info.end).length : 0;
      totalInWindow += inWindow;
      const lastTs = ts.length ? ts[ts.length - 1]! : 0;
      const covered = !!info && pollStart <= info.start && lastTs >= info.end;

      if (!info || !info.ok) failures.push(`run ${run}: writer failed (out=${out.slice(0, 80)} err=${err.slice(0, 80)})`);
      else if (torn.length > 0) failures.push(`run ${run}: ${torn.length} torn read(s), e.g. len=${torn[0]} not in [${oldLen}, ${newLen}]`);
      else if (!covered) failures.push(`run ${run}: reader did NOT span the write window (pollStart=${pollStart} start=${info.start} last=${lastTs} end=${info.end})`);
      rmSync(dir(), { recursive: true, force: true });
    }
    // The reader must have sampled INSIDE the write window at least once across
    // all runs, or the check could not fire.
    expect(totalInWindow).toBeGreaterThan(0);
    expect(failures, failures.join(" | ")).toEqual([]);
  }, CASE_BUDGET_MS);
});

describe("T1b — exception mid-write", () => {
  it("a failure AFTER the temp exists leaves the target byte-identical and no staging temp behind", () => {
    mkdirSync(dir(), { recursive: true });
    const before = staleSection("@tpsdev-ai/flair-mcp@0.0.1") + `# ${PAD}\n`;
    writeFileSync(cfgPath(), before, "utf-8");
    const beforeHash = createHash("sha256").update(readFileSync(cfgPath())).digest("hex");

    const result = withConfigCriticalSection(
      cfgPath(),
      () => ({ write: new TextEncoder().encode("NEW CONTENT\n") }),
      {
        backup: () => undefined,
        testHooks: {
          // Fires right after the staging temp is created and before any bytes.
          afterTempCreate: () => { throw new Error("simulated staged-write failure"); },
        },
      },
    );

    expect(result.status).toBe("refused");
    expect(result.message).toContain("staging");
    expect(createHash("sha256").update(readFileSync(cfgPath())).digest("hex")).toBe(beforeHash);
    const temps = readdirSync(dir()).filter((f) => f.includes(".tmp-"));
    expect(temps, `staging temp leaked: ${temps.join(", ")}`).toEqual([]);
  });
});

describe("T1c — SIGKILL after fsync, before rename", () => {
  it("leaves the target byte-identical; the orphaned temp + lock are reported", async () => {
    mkdirSync(dir(), { recursive: true });
    const before = staleSection("@tpsdev-ai/flair-mcp@0.0.1") + `# ${PAD}\n`;
    writeFileSync(cfgPath(), before, "utf-8");
    const beforeHash = createHash("sha256").update(readFileSync(cfgPath())).digest("hex");

    const barrierDir = mkdtempSync(join(tmpdir(), "flair-2cid2-t1c-barrier-"));
    try {
      const hpath = join(home, "k.mjs");
      writeFileSync(hpath, writerHarness(), "utf-8");
      const child = spawn("bun", [hpath], {
        cwd: repoRoot,
        env: { ...process.env, HOME: home, FLAIR_TEST_CRITICAL_BARRIER: barrierDir },
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

      const afterHash = createHash("sha256").update(readFileSync(cfgPath())).digest("hex");
      expect(afterHash).toBe(beforeHash);

      const temps = readdirSync(dir()).filter((f) => f.includes(".tmp-"));
      const lockPath = `${cfgPath()}.lock`;
      const lockExists = existsSync(lockPath);
      // REPORT (do not assert absent): a SIGKILL bypasses the temp cleanup and
      // the lock release. The orphaned lock is NOT ignored: a later writer
      // REFUSES on it by name until an operator removes it on the recorded host
      // (crash-only provable reclaim is tracked as flair#1831).
      console.log(`T1c orphaned: temp=${JSON.stringify(temps)} lock=${lockExists}`);
      expect(temps.length, "expected an orphaned staging temp after SIGKILL").toBeGreaterThan(0);
      expect(lockExists, "expected an orphaned lock after SIGKILL").toBe(true);

      // A SECOND production writer against the SAME file must REFUSE by name —
      // on the orphaned lock, naming the recorded holder (pid + host) and the
      // lock path — and must NOT touch the target.
      const refused = wireCodex({ FLAIR_AGENT_ID: "codexbot", FLAIR_URL: "http://127.0.0.1:19926", FLAIR_CLIENT: "codex" });
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
