/**
 * launchd-adopt-poll-1827.test.ts — flair#1827 PR-C.
 *
 * The doctor `--fix` adopt arm judged adoption from ONE observation taken
 * before the launchd-started Harper had written `hdb.pid` or bound the port, so
 * a healthy slow start was reported as a false failure. The stop side had the
 * same single-shot pattern ("port not confirmed free").
 *
 * PR-C adds an injectable, pure poll helper (`pollUntil`) plus wrappers that
 * poll-then-verify on both sides:
 *   - serving: `verifyAdoptServingWithWait` — poll {managedPid, servingPid,
 *     directPidAlive} until servingPid !== null && !directPidAlive, then call
 *     `verifyAdoptServing` UNCHANGED on the final observation.
 *   - stop: `decideAdoptStopWithWait` — poll the post-stop health until
 *     `refused`, then apply `decideAdoptStop` UNCHANGED.
 *
 * NOTE ON IMPORT STYLE: the module is imported as a NAMESPACE and the new
 * helpers are called through it. On the pristine base (pre-fix) the helpers do
 * not exist yet, so C1–C4 fail per-test with "not a function" — the recorded
 * red — while C5 (the unchanged `verifyAdoptServing` cases) is green on base and
 * after. A static named import would instead fail the whole file at link time.
 *
 * Time is fully injected: `now`/`sleep` drive the deadline with no real timers.
 */

import { describe, test, expect } from "bun:test";
import * as mod from "../../src/lib/launchd-repair.ts";
import type { AdoptServingEvidence, DaemonState } from "../../src/lib/launchd-repair.ts";
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

const SERVING = (over: Partial<AdoptServingEvidence> = {}): AdoptServingEvidence => ({
  directPid: 100, managedPid: 200, servingPid: 200, directPidAlive: false, ...over,
});

// ── C1 — serving side: a late servingPid is waited for, then proven ─────────

describe("C1 — serving side waits for a late servingPid", () => {
  test("C1 (red): servingPid null for the first observations, then valid -> adoption proven", async () => {
    const c = clocked();
    const observe = scripted<AdoptServingEvidence>([
      SERVING({ managedPid: null, servingPid: null, directPidAlive: true }),
      SERVING({ servingPid: null, directPidAlive: false }),
      SERVING({ servingPid: 200, directPidAlive: false }),
    ]);
    const r = await mod.verifyAdoptServingWithWait({
      observe, deadlineMs: 60_000, intervalMs: 250, now: c.now, sleep: c.sleep,
    });
    expect(r.timedOut).toBe(false);
    expect(r.proof).toBeNull(); // proven
    expect(r.evidence.servingPid).toBe(200);
  });
});

// ── C2 — serving side: never appears -> fail at the deadline ───────────────

describe("C2 — serving side fails at the deadline and names the wait", () => {
  test("C2: servingPid never appears -> fails at the deadline; detail names the wait and last observation", async () => {
    const c = clocked();
    const observe = () => SERVING({ servingPid: null, directPidAlive: false });
    const r = await mod.verifyAdoptServingWithWait({
      observe, deadlineMs: 5_000, intervalMs: 250, now: c.now, sleep: c.sleep,
    });
    expect(r.timedOut).toBe(true);
    expect(r.proof).not.toBeNull();
    expect(r.proof!.detail).toContain("5000");
    expect(r.proof!.detail).toContain("servingPid=null");
  });
});

// ── C3 — stop side: unreachable then refused -> proceed ────────────────────

describe("C3 — stop side waits for the port to free", () => {
  test("C3 (red): health 'unreachable' for N observations, then 'refused' -> proceed", async () => {
    const c = clocked();
    const observe = scripted<HealthResult>([{ kind: "unreachable" }, { kind: "unreachable" }, { kind: "refused" }]);
    const r = await mod.decideAdoptStopWithWait({ state: "RUNNING", pid: 42 }, {
      observe, deadlineMs: 60_000, intervalMs: 250, now: c.now, sleep: c.sleep,
    });
    expect(r.timedOut).toBe(false);
    expect(r.decision).toBe("proceed");
  });
});

// ── C4 — stop side: never frees -> fail at the deadline ────────────────────

describe("C4 — stop side fails at the deadline with the existing wording", () => {
  test("C4: the port never frees -> fails at the deadline (existing refusal wording + what was observed)", async () => {
    const c = clocked();
    const observe = () => ({ kind: "unreachable" } as HealthResult);
    const r = await mod.decideAdoptStopWithWait({ state: "RUNNING", pid: 42 }, {
      observe, deadlineMs: 3_000, intervalMs: 250, now: c.now, sleep: c.sleep,
    });
    expect(r.timedOut).toBe(true);
    expect(r.decision).not.toBe("proceed");
    const detail = (r.decision as { detail: string }).detail;
    expect(detail).toContain("not confirmed free");
    expect(detail).toContain("3000");
  });
});

// ── C5 — green control: verifyAdoptServing is UNCHANGED ────────────────────

describe("C5 (green control) — verifyAdoptServing is unchanged", () => {
  test("proven: old pid dead, serving pid changed, and it is launchd's pid", () => {
    expect(mod.verifyAdoptServing({ directPid: 100, managedPid: 200, servingPid: 200, directPidAlive: false })).toBeNull();
  });
  test("pre-adopt process still alive -> fails", () => {
    const proof = mod.verifyAdoptServing({ directPid: 100, managedPid: 200, servingPid: 200, directPidAlive: true });
    expect(proof?.detail).toContain("still alive");
  });
  test("serving pid did not change -> fails", () => {
    const proof = mod.verifyAdoptServing({ directPid: 100, managedPid: 100, servingPid: 100, directPidAlive: false });
    expect(proof?.detail).toContain("did not bounce");
  });
  test("serving pid is not launchd's pid -> fails", () => {
    const proof = mod.verifyAdoptServing({ directPid: 100, managedPid: 200, servingPid: 300, directPidAlive: false });
    expect(proof?.detail).toContain("does not own the listener");
  });
  test("no serving pid -> fails", () => {
    expect(mod.verifyAdoptServing({ directPid: 100, managedPid: 200, servingPid: null, directPidAlive: false })).not.toBeNull();
  });

  test("C5 — polling never turns a genuine identity failure into a pass", async () => {
    // These observations SATISFY the wait predicate (servingPid present,
    // directPidAlive false) but still fail the identity proof. A timed-out or
    // satisfied poll must never launder them into success.
    const cases: AdoptServingEvidence[] = [
      { directPid: 100, managedPid: 100, servingPid: 100, directPidAlive: false }, // same pid serving
      { directPid: 100, managedPid: 200, servingPid: 300, directPidAlive: false }, // not launchd's pid
    ];
    for (const evidence of cases) {
      const c = clocked();
      const r = await mod.verifyAdoptServingWithWait({
        observe: () => evidence, deadlineMs: 2_000, intervalMs: 250, now: c.now, sleep: c.sleep,
      });
      expect(r.proof).not.toBeNull();
    }
  });

  test("C5 — a pre-adopt process alive forever still fails (the wait predicate never holds)", async () => {
    const c = clocked();
    const observe = () => SERVING({ directPidAlive: true });
    const r = await mod.verifyAdoptServingWithWait({
      observe, deadlineMs: 2_000, intervalMs: 250, now: c.now, sleep: c.sleep,
    });
    expect(r.timedOut).toBe(true);
    expect(r.proof?.detail).toContain("still alive");
  });
});

// ── stop-side control: decideAdoptStop unchanged ───────────────────────────

describe("C5 (green control) — decideAdoptStop is unchanged", () => {
  const refused: HealthResult = { kind: "refused" };
  const state: DaemonState = { state: "RUNNING", pid: 42 };
  test("port provably free -> proceed", () => { expect(mod.decideAdoptStop(state, refused)).toBe("proceed"); });
  test("port still occupied -> failed", () => {
    const r = mod.decideAdoptStop(state, { kind: "ok" });
    expect(r).not.toBe("proceed");
    if (r !== "proceed") expect(r.detail).toContain("port still occupied");
  });
  test("port unreachable -> failed (not proceed)", () => {
    const r = mod.decideAdoptStop(state, { kind: "unreachable" });
    expect(r).not.toBe("proceed");
    if (r !== "proceed") expect(r.detail).toContain("not confirmed free");
  });
});
