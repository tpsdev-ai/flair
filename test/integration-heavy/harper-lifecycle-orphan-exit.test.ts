// flair#1450 — powered check against a real Harper, not a stand-in.
//
// Kill the harness parent while Harper is running, then assert the Harper
// child is gone within a bounded window. Positive control first: a Harper
// whose parent is still alive and whose stdout is still open must stay up.
// Same process, same boot — the child that stayed must then exit.
//
// Kill by the pid startHarper returned. Never by process name — production
// / spoke Harpers share `harper.js`.
import { describe, expect, test } from "bun:test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = process.cwd();
const PARENT = join(import.meta.dir, "..", "helpers", "harper-orphan-parent.ts");
const GONE_WITHIN_MS = 8_000;
const PARENT_ALIVE_MS = 4_000;

/** Harper engines are `^22.18.0 || >=24`. Cloud images may have a stale `node` on PATH. */
function compatibleNodeBin(): string {
  if (process.env.NODE_BIN) return process.env.NODE_BIN;
  const versionOf = (bin: string): string | null => {
    try {
      return execFileSync(bin, ["-p", "process.versions.node"], { encoding: "utf8", timeout: 3000 }).trim();
    } catch {
      return null;
    }
  };
  const ok = (v: string | null) => {
    if (!v) return false;
    const [maj, min] = v.split(".").map(Number);
    return maj > 22 || (maj === 22 && min >= 18);
  };
  if (ok(versionOf("node"))) return "node";
  const nvmRoot = join(homedir(), ".nvm", "versions", "node");
  if (existsSync(nvmRoot)) {
    for (const v of readdirSync(nvmRoot).sort().reverse()) {
      const bin = join(nvmRoot, v, "bin", "node");
      if (existsSync(bin) && ok(versionOf(bin))) return bin;
    }
  }
  return "node";
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPid(pid: number | undefined | null): void {
  if (!pid) return;
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

async function waitUntil(pred: () => boolean, timeoutMs: number, intervalMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return pred();
}

interface ParentStatus {
  harperPid: number;
  parentPid: number;
  installDir: string;
}

async function bootParent(): Promise<{ proc: ChildProcess; status: ParentStatus; statusFile: string }> {
  const dir = mkdtempSync(join(tmpdir(), "flair-1450-"));
  const statusFile = join(dir, "status.json");
  writeFileSync(statusFile, "");
  let parentLog = "";
  const proc = spawn("bun", [PARENT, statusFile], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_BIN: compatibleNodeBin() },
  });
  proc.stdout?.on("data", (d: Buffer) => { parentLog += d.toString(); });
  proc.stderr?.on("data", (d: Buffer) => { parentLog += d.toString(); });
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      throw new Error(
        `orphan-parent exited before ready (code=${proc.exitCode} signal=${proc.signalCode})\n${parentLog}`,
      );
    }
    try {
      const raw = readFileSync(statusFile, "utf8").trim();
      if (raw.length > 0) {
        const status = JSON.parse(raw) as ParentStatus;
        if (status.harperPid && status.parentPid) return { proc, status, statusFile };
      }
    } catch { /* not written yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  killPid(proc.pid);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  throw new Error(`orphan-parent did not write status within 180s\n${parentLog}`);
}

function cleanup(status: ParentStatus | undefined, proc?: ChildProcess, statusFile?: string): void {
  if (status?.harperPid) killPid(status.harperPid);
  if (proc?.pid) killPid(proc.pid);
  if (status?.installDir) {
    try { rmSync(status.installDir, { recursive: true, force: true, maxRetries: 4 }); } catch { /* best effort */ }
  }
  if (statusFile) {
    try { unlinkSync(statusFile); } catch { /* best effort */ }
    try { rmSync(join(statusFile, ".."), { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

describe("flair#1450 — real Harper orphan must exit", () => {
  test("parent alive → Harper stays; SIGKILL parent → Harper is gone", async () => {
    let status: ParentStatus | undefined;
    let proc: ChildProcess | undefined;
    let statusFile: string | undefined;
    try {
      const boot = await bootParent();
      status = boot.status;
      proc = boot.proc;
      statusFile = boot.statusFile;
      expect(isAlive(status.harperPid)).toBe(true);
      expect(isAlive(status.parentPid)).toBe(true);

      await new Promise((r) => setTimeout(r, PARENT_ALIVE_MS));
      expect(isAlive(status.parentPid)).toBe(true);
      expect(isAlive(status.harperPid)).toBe(true);

      killPid(status.parentPid);
      const gone = await waitUntil(() => !isAlive(status!.harperPid), GONE_WITHIN_MS);
      expect(gone).toBe(true);
      expect(isAlive(status.harperPid)).toBe(false);
    } finally {
      cleanup(status, proc, statusFile);
    }
  }, 300_000);
});
