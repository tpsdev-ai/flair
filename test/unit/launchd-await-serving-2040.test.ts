/**
 * launchd-await-serving-2040.test.ts — flair#2040, round 6.
 *
 * `doctor --fix` judged the job it had just loaded from ONE observation, taken
 * when `kickstart` returned — before launchd's process had bound its port or
 * written hdb.pid (the flair#1827 timing). Round 4 made that observation
 * "unverified" instead of "managed", so every real hand-off failed the strict
 * verifier, was unloaded again, and left nothing serving (the macOS runner's
 * real-launchd lane).
 *
 * `awaitLaunchdJobServing` polls while the job is STILL STARTING — launchd runs
 * it, nothing identifies the serving process, nothing answers its port — and
 * returns the final observation. It decides nothing: the caller applies
 * `verifyLaunchdManagement` UNCHANGED, so these cases judge with it too.
 *
 * Namespace import (as in launchd-adopt-poll-1827.test.ts): on the base the
 * helpers do not exist, so each case fails on its own ("not a function").
 * Time is injected: `now`/`sleep` drive the deadline with no real timers.
 */

import { describe, test, expect } from "bun:test";
import * as mod from "../../src/lib/launchd-repair.ts";
import { verifyLaunchdManagement, type LaunchdManagement } from "../../src/lib/launchd-management.ts";
import type { HealthResult } from "../../src/lib/daemon-liveness.ts";

/** A deterministic clock: `now()` reads `t`; `sleep(ms)` advances it. */
function clocked() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}

/** A scripted observer: yields each value in turn, then repeats the last. */
function scripted<T>(values: T[]): () => T {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)]!;
}

const LABEL = "ai.tpsdev.flair.r6test";
const REFUSED: HealthResult = { kind: "refused" };
const OK: HealthResult = { kind: "ok" };
const UNREACHABLE: HealthResult = { kind: "unreachable" };

function unverified(pid = 200): LaunchdManagement {
  return {
    state: "unverified",
    label: LABEL,
    detail: `launchd job ${LABEL} is running as process ${pid}, but the process serving this instance could not be identified`,
    remedy: ["flair restart"],
    launchdPid: pid,
    servingPid: null,
  };
}

function managed(pid = 200): LaunchdManagement {
  return { state: "managed", label: LABEL, detail: `launchd job ${LABEL} is running as process ${pid}`, launchdPid: pid, servingPid: pid };
}

function detachedNoPid(): LaunchdManagement {
  return { state: "detached", label: LABEL, detail: `the launchd job ${LABEL} is loaded but not running`, remedy: ["flair restart"] };
}

describe("flair#2040 r6 — launchdJobStillStarting", () => {
  test("still starting only while launchd runs the job, nothing identifies the server, and nothing answers HTTP", () => {
    expect(mod.launchdJobStillStarting({ health: REFUSED, management: unverified() })).toBe(true);
    // A probe that cannot tell (timeout / other) is not an answer: still starting.
    expect(mod.launchdJobStillStarting({ health: UNREACHABLE, management: unverified() })).toBe(true);
    // The port answers but its process cannot be identified: final, not starting.
    expect(mod.launchdJobStillStarting({ health: OK, management: unverified() })).toBe(false);
    expect(mod.launchdJobStillStarting({ health: { kind: "foreign" }, management: unverified() })).toBe(false);
    // Verified, or detached: final.
    expect(mod.launchdJobStillStarting({ health: OK, management: managed() })).toBe(false);
    expect(mod.launchdJobStillStarting({ health: REFUSED, management: managed() })).toBe(false);
    expect(mod.launchdJobStillStarting({ health: REFUSED, management: detachedNoPid() })).toBe(false);
  });
});

describe("flair#2040 r6 — awaitLaunchdJobServing", () => {
  test("R1 (red on base): a job that binds after three observations is waited for, then VERIFIED", async () => {
    const c = clocked();
    const observe = scripted([
      { health: REFUSED, management: unverified() },
      { health: REFUSED, management: unverified() },
      { health: UNREACHABLE, management: unverified() },
      { health: OK, management: managed() },
    ]);
    const r = await mod.awaitLaunchdJobServing({ observe, deadlineMs: 60_000, intervalMs: 250, now: c.now, sleep: c.sleep });
    expect(r.timedOut).toBe(false);
    expect(r.observations).toBe(4);
    expect(r.waitedMs).toBe(750);
    const verdict = verifyLaunchdManagement(r.observation.management);
    expect(verdict.verified).toBe(true);
  });

  test("R2: the port answers while the serving process is still unidentified -> judged at once, and NOT verified", async () => {
    const c = clocked();
    const observe = scripted([{ health: OK, management: unverified() }]);
    const r = await mod.awaitLaunchdJobServing({ observe, deadlineMs: 60_000, intervalMs: 250, now: c.now, sleep: c.sleep });
    expect(r.timedOut).toBe(false);
    expect(r.observations).toBe(1);
    expect(verifyLaunchdManagement(r.observation.management).verified).toBe(false);
    expect(r.detail).toContain("could not be identified");
  });

  test("R3: launchd reports no pid (detached) -> judged at once, NOT verified; no wait", async () => {
    const c = clocked();
    const observe = scripted([{ health: REFUSED, management: detachedNoPid() }]);
    const r = await mod.awaitLaunchdJobServing({ observe, deadlineMs: 60_000, intervalMs: 250, now: c.now, sleep: c.sleep });
    expect(r.observations).toBe(1);
    expect(r.waitedMs).toBe(0);
    expect(verifyLaunchdManagement(r.observation.management).verified).toBe(false);
    expect(r.detail).toContain("loaded but not running");
  });

  test("R4: a job that never serves -> bounded: times out at the deadline, NOT verified, and the detail names the wait", async () => {
    const c = clocked();
    const observe = () => ({ health: REFUSED, management: unverified() });
    const r = await mod.awaitLaunchdJobServing({ observe, deadlineMs: 5_000, intervalMs: 250, now: c.now, sleep: c.sleep });
    expect(r.timedOut).toBe(true);
    expect(r.waitedMs).toBe(5_000);
    expect(verifyLaunchdManagement(r.observation.management).verified).toBe(false);
    expect(r.detail).toContain("could not be identified");
    expect(r.detail).toContain("waited 5000ms for the launchd job to start serving");
    expect(r.detail).toContain("refused");
  });
});
