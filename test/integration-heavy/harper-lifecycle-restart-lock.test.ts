// flair#1440 — the Harper restart lock race (integration).
//
// The harness restarts Harper once per question. It worked 489 times and failed
// on the 490th with "Resource temporarily unavailable" on
// <installDir>/database/flair/LOCK: the previous Harper had not released the
// RocksDB lock when the next `install` ran, because the code waited for the
// process to EXIT — and exit is observable but insufficient (Harper's detached
// child services hold the LOCK and outlive the parent by a beat).
//
// The fix makes `stopHarper` wait for the LOCK to be free (bounded) before the
// next start. This test exercises the real restart seam — stop(keepInstallDir)
// then start(same installDir) — in a loop, because a fix that passes once has
// proved nothing about a 1-in-500 race.
//
// POSITIVE CONTROL: a genuinely held lock (a second live Harper on the same
// directory) must STILL fail, naming the lock — the wait must not widen into
// "ignore install failures".
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

const REPO_ROOT = process.cwd();
// CI keeps this small; the 1-in-500 race is proven by running a larger loop
// locally (RESTART_LOOP=100 bun test ...).
const LOOPS = Number(process.env.RESTART_LOOP ?? 3);

let harper: HarperInstance;
let installDir: string;

beforeAll(async () => {
  harper = await startHarper({ cwd: REPO_ROOT, harperBinDir: REPO_ROOT });
  installDir = harper.installDir;
}, 300_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (installDir) await rm(installDir, { recursive: true, force: true, maxRetries: 4 });
});

describe("flair#1440 — restart waits for the lock, not just the exit", () => {
  test(`stop(keepInstallDir) → start(same dir) succeeds ${LOOPS}× in a row`, async () => {
    for (let i = 0; i < LOOPS; i++) {
      await stopHarper(harper, { keepInstallDir: true });
      // Immediately restart against the SAME directory — the exact seam that
      // lost the 1-in-500 race. No delay: the point is to contend for the lock
      // the instant the previous Harper's parent has exited.
      harper = await startHarper({ cwd: REPO_ROOT, harperBinDir: REPO_ROOT, installDir });
      expect(harper.installDir).toBe(installDir);
    }
  }, Math.max(300_000, LOOPS * 20_000));

  test("positive control: a second live Harper on the same directory still fails, naming the lock", async () => {
    // A genuinely held lock (harper is still live on installDir) must NOT be
    // waited out into success. startHarper against the occupied directory must
    // throw, and the error must name the LOCK.
    await expect(
      startHarper({ cwd: REPO_ROOT, harperBinDir: REPO_ROOT, installDir }),
    ).rejects.toThrow(/LOCK|Resource temporarily unavailable|failed to load/i);
  }, 300_000);
});
