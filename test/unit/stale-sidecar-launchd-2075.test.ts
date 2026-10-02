/**
 * stale-sidecar-launchd-2075.test.ts — flair#2075 item 3.
 *
 * On a launchd install, `flair stop` returned from the launchd branch after
 * `launchctl unload`, before the port-based block that drops a stale identity
 * sidecar. So the #2055 leftover could still occur there. The launchd leg now
 * waits for the instance's recorded pid to exit, then runs the same
 * confirmed-dead cleanup the direct leg runs.
 *
 * Darwin-gated (the branch is `process.platform === "darwin"`). `launchctl` is
 * a shim on PATH that answers `unload` with exit 0 — no real launchd domain is
 * touched; HOME is a throwaway dir. The scratch tree is under a short root
 * (flair#2075 item 1) and the socket path is asserted to fit.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchdLabel, launchdPlistPath } from "../../src/cli.ts";
import { socketPathLimit } from "../../src/lib/socket-path-limit.ts";

const isDarwin = process.platform === "darwin";
const SHORT_ROOT = "/tmp";
const cliPath = join(import.meta.dirname, "..", "..", "src", "cli.ts");
const repoRoot = join(import.meta.dirname, "..", "..");

describe.skipIf(!isDarwin)("flair#2075 item 3 — the launchd stop leg drops a leftover sidecar", () => {
  let tmpHome: string;
  let dataDir: string;
  let shimBin: string;
  let label: string;
  let plistPath: string;
  let sidecar: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(SHORT_ROOT, "f2075l-"));
    dataDir = join(tmpHome, ".flair", "data");
    mkdirSync(dataDir, { recursive: true });
    const agentsDir = join(tmpHome, "Library", "LaunchAgents");
    mkdirSync(agentsDir, { recursive: true });
    label = launchdLabel(dataDir);
    plistPath = launchdPlistPath(label, agentsDir);
    writeFileSync(plistPath, "<plist/>");
    sidecar = join(dataDir, "flair-daemon.json");
    shimBin = mkdtempSync(join(SHORT_ROOT, "f2075s-"));
    writeFileSync(join(shimBin, "launchctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    expect(Buffer.byteLength(join(dataDir, "operations-server"), "utf8")).toBeLessThanOrEqual(socketPathLimit(process.platform));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(shimBin, { recursive: true, force: true });
  });

  async function confirmedDeadPid(): Promise<number> {
    const p = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
    const pid = (p as unknown as { pid: number }).pid;
    await p.exited;
    for (let i = 0; i < 100; i++) {
      try { process.kill(pid, 0); } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === "ESRCH") return pid;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`pid ${pid} never reported ESRCH`);
  }

  test("the launchd unload leg drops a sidecar naming a confirmed-dead pid", async () => {
    const dead = await confirmedDeadPid();
    writeFileSync(join(dataDir, "hdb.pid"), `${dead}\n`);
    writeFileSync(sidecar, JSON.stringify({ pid: dead, startTimeMs: Date.now() - 3_600_000, port: 9, flairVersion: "0.57.0" }));

    const proc = Bun.spawn(["bun", cliPath, "stop"], {
      cwd: repoRoot,
      timeout: 20_000,
      env: { ...(process.env as Record<string, string>), HOME: tmpHome, PATH: `${shimBin}:${process.env.PATH ?? ""}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
    await proc.exited;

    expect(out).toMatch(/launchd service unloaded/i);
    // THE ASSERTION: the launchd leg dropped the leftover.
    expect(existsSync(sidecar)).toBe(false);
  }, 30_000);
});
