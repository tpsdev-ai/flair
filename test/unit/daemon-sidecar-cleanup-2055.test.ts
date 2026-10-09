import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSidecar, removeStaleSidecarIfConfirmedDead } from "../../src/cli.ts";

const dirs: string[] = [];
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "flair2055-cleanup-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sidecarPath(dataDir: string): string {
  return join(dataDir, "flair-daemon.json");
}
function writeSidecarJson(dataDir: string, pid: number): void {
  writeFileSync(sidecarPath(dataDir), JSON.stringify({ pid, startTimeMs: Date.now(), port: 19926, flairVersion: "0.57.0" }) + "\n");
}
/** A pid that is CONFIRMED gone: ESRCH only. */
async function confirmedDeadPid(): Promise<number> {
  const p = Bun.spawn(["bun", "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" });
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

describe("flair#2055 — the cleanup removes only a confirmed-dead sidecar", () => {
  test("a sidecar naming a confirmed-dead pid is removed", async () => {
    const dataDir = fixture();
    writeSidecarJson(dataDir, await confirmedDeadPid());
    removeStaleSidecarIfConfirmedDead(dataDir);
    expect(existsSync(sidecarPath(dataDir))).toBe(false);
  });

  test("a sidecar naming a LIVE pid is kept", () => {
    const dataDir = fixture();
    writeSidecarJson(dataDir, process.pid);
    removeStaleSidecarIfConfirmedDead(dataDir);
    expect(existsSync(sidecarPath(dataDir))).toBe(true);
  });

  test("no sidecar is a no-op", () => {
    const dataDir = fixture();
    removeStaleSidecarIfConfirmedDead(dataDir);
    expect(existsSync(sidecarPath(dataDir))).toBe(false);
  });
});

describe("flair#2391 — a confirmed-gone pid is not read again", () => {
  test("the sidecar is dropped even when a fresh liveness read would report the pid alive", () => {
    const dataDir = fixture();
    writeSidecarJson(dataDir, process.pid);
    removeStaleSidecarIfConfirmedDead(dataDir, process.pid, () => ({ kind: "alive" as const }));
    expect(existsSync(sidecarPath(dataDir))).toBe(false);
  });

  test("the confirmation is keyed to the pid: a sidecar naming another pid is kept", () => {
    const dataDir = fixture();
    writeSidecarJson(dataDir, process.pid);
    removeStaleSidecarIfConfirmedDead(dataDir, process.pid + 1, () => ({ kind: "alive" as const }));
    expect(existsSync(sidecarPath(dataDir))).toBe(true);
  });
});

describe("flair#2055 — a real symlinked sidecar is neither followed nor removed", () => {
  test("readSidecar reads a symlink as unreadable and cleanup leaves it and its target alone", async () => {
    const dataDir = fixture();
    const target = join(dataDir, "elsewhere.json");
    writeSidecarJson(dataDir, await confirmedDeadPid());
    const realContent = readFileSync(sidecarPath(dataDir), "utf-8");
    writeFileSync(target, realContent);
    rmSync(sidecarPath(dataDir));
    symlinkSync(target, sidecarPath(dataDir));

    const read = readSidecar(dataDir);
    expect(read.kind).toBe("unreadable");
    if (read.kind === "unreadable") expect(read.reason).toContain("symbolic link");

    removeStaleSidecarIfConfirmedDead(dataDir);

    // The symlink was not followed and not removed, and the target is intact.
    expect(lstatSync(sidecarPath(dataDir)).isSymbolicLink()).toBe(true);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe(realContent);
  });
});
