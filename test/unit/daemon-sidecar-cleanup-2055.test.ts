/**
 * daemon-sidecar-cleanup-2055.test.ts — flair#2055, the stop-time cleanup.
 *
 * The cleanup opens the sidecar with O_NOFOLLOW, re-reads it, and unlinks it
 * only while it still names the pid it first observed as CONFIRMED gone. These
 * tests drive the REAL cleanup exported from `src/cli.ts` against a real
 * filesystem: a symlinked sidecar is neither followed nor removed, a
 * confirmed-dead pid's sidecar is removed, a live pid's is kept.
 *
 * Everything is HOME-isolated (a scratch data dir under the OS temp dir). The
 * lock that briefly serialised this with the writers was removed: the only
 * loser of the read/unlink window is a start that rewrote the sidecar in it,
 * and a live daemon left with no sidecar can be re-adopted by a later
 * port-based stop or restart once the live process supplies the required
 * pidfile and health evidence (see the recovery test in
 * stale-sidecar-2055.test.ts). `flair status` does not re-adopt.
 */
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

/**
 * flair#2391 — the stop-time cleanup must not read the confirmed-gone pid's
 * liveness a second time. `kill(pid, 0)` succeeds on a process that is being
 * reaped, and if the `/proc/<pid>/stat` read that follows then fails with ESRCH
 * the probe reports `alive`; the stop then returns with the sidecar still
 * naming the pid it just confirmed gone. These drive the cleanup with the
 * caller's confirmation and an injected probe standing in for that race.
 */
describe("flair#2391 — a confirmed-gone pid is not read again", () => {
  test("the sidecar is dropped even when a fresh liveness read would report the pid alive", () => {
    const dataDir = fixture();
    // A pid a liveness read reports ALIVE — the shape the re-read takes after a
    // reaped child. The caller already confirmed this pid exited.
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
