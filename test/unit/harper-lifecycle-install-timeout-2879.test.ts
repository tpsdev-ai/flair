// flair#2879 — a timed-out install must be reported only after its child has
// exited, so the caller's cleanup cannot remove the install tree while the
// installer is still writing to it.
//
// These tests drive `waitForChildExit` (the extracted wait) with real node
// children and short timeouts: no Harper install runs here.
import { afterAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForChildExit } from "../helpers/harper-lifecycle.js";

const SCRATCH = mkdtempSync(join(tmpdir(), "flair-2879-"));
const CHILDREN = new Set<ChildProcess>();

afterAll(() => {
  for (const child of CHILDREN) {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }
  }
  rmSync(SCRATCH, { recursive: true, force: true });
});

function spawnedChild(script: string, file: string): ChildProcess {
  const child = spawn("node", ["-e", script], {
    env: { ...process.env, WRITE_FILE: file },
    stdio: "ignore",
  });
  CHILDREN.add(child);
  return child;
}

/** Wait (bounded) until the child's first append has landed. */
async function waitForWrite(file: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (statSync(file).size > 0) return;
    } catch { /* not created yet */ }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`child did not start writing within ${timeoutMs}ms`);
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

describe("waitForChildExit (flair#2879)", () => {
  test("rejects only after a SIGTERM-ignoring child exited and stopped writing", async () => {
    const file = join(SCRATCH, "ignores-sigterm.txt");
    const child = spawnedChild(
      `const { appendFileSync } = require("node:fs");
       process.on("SIGTERM", () => {});
       setInterval(() => { try { appendFileSync(process.env.WRITE_FILE, "x"); } catch {} }, 5);`,
      file,
    );
    await waitForWrite(file, 5_000);

    const started = Date.now();
    const err = await waitForChildExit(child, 150, 1_000).then(() => null, (e: Error) => e);
    const elapsed = Date.now() - started;

    expect(err?.message).toMatch(/did not exit within 150ms/);
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(hasExited(child)).toBe(true);
    expect(child.signalCode).toBe("SIGKILL");

    const sizeAtRejection = statSync(file).size;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(statSync(file).size).toBe(sizeAtRejection);
  }, 15_000);

  test("waits for a child that exits on SIGTERM before rejecting with the timeout error", async () => {
    const file = join(SCRATCH, "exits-on-sigterm.txt");
    const child = spawnedChild(
      `require("node:fs").appendFileSync(process.env.WRITE_FILE, "ready");
       process.on("SIGTERM", () => { process.exit(0); });
       setInterval(() => {}, 1_000);`,
      file,
    );
    await waitForWrite(file, 5_000);

    const err = await waitForChildExit(child, 150, 1_000).then(() => null, (e: Error) => e);

    expect(err?.message).toMatch(/did not exit within 150ms \(exited after SIGTERM\)/);
    expect(hasExited(child)).toBe(true);
    expect(child.exitCode).toBe(0);
  }, 15_000);
});
