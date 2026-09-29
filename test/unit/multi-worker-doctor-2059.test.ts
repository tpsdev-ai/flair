/**
 * multi-worker-doctor-2059.test.ts — flair#2059, slice S0 of #2052.
 *
 * The `worker-threads` doctor check turns the public /Health `multiWorker` field
 * into a verdict: it fails on the refused state (naming `THREADS_COUNT=1` as the
 * remedy) and under the explicit opt-in, passes on a serving (one-worker)
 * instance, and skips — never passes — when the instance was not observed.
 */
import { describe, expect, it } from "bun:test";
import {
  DOCTOR_CHECK_IDS,
  readWorkerThreadsObservation,
  runDoctorChecks,
  type DoctorRunContext,
  type WorkerThreadsObservation,
} from "../../src/lib/doctor-run.js";

const baseCtx: DoctorRunContext = {
  homeDir: "/fixture/home",
  cwd: "/fixture/cwd",
  detectedClientIds: [],
};

function checkWorkerThreads(workerThreads?: WorkerThreadsObservation) {
  const run = runDoctorChecks(
    { ...baseCtx, workerThreads },
    { catalogIds: ["worker-threads"] as const },
  );
  return run.results[0];
}

describe("readWorkerThreadsObservation", () => {
  it("names the refusal from the /Health field", () => {
    expect(readWorkerThreadsObservation({ state: "refused", workerCount: 2 })).toEqual({
      kind: "refused",
      state: "refused",
      workerCount: 2,
    });
    expect(readWorkerThreadsObservation({ state: "unsafe-opt-in", workerCount: 4 })).toEqual({
      kind: "refused",
      state: "unsafe-opt-in",
      workerCount: 4,
    });
  });

  it("treats an absent or unrecognized field as a serving instance", () => {
    expect(readWorkerThreadsObservation(undefined)).toEqual({ kind: "serving" });
    expect(readWorkerThreadsObservation(null)).toEqual({ kind: "serving" });
    expect(readWorkerThreadsObservation({})).toEqual({ kind: "serving" });
    expect(readWorkerThreadsObservation({ state: "something-else", workerCount: 2 })).toEqual({
      kind: "serving",
    });
    // A named state without a usable count is not promoted to a refusal.
    expect(readWorkerThreadsObservation({ state: "refused" })).toEqual({ kind: "serving" });
  });
});

describe("worker-threads doctor check", () => {
  it("is a member of the doctor catalog", () => {
    expect(DOCTOR_CHECK_IDS).toContain("worker-threads");
  });

  it("fails on the refused state and names THREADS_COUNT=1", () => {
    const r = checkWorkerThreads({ kind: "refused", state: "refused", workerCount: 2 });
    expect(r.status).toBe("fail");
    expect(r.remedy).toContain("THREADS_COUNT=1");
    expect(r.detail).toContain("2 Harper worker threads");
  });

  it("fails under the explicit opt-in and still names the remedy", () => {
    const r = checkWorkerThreads({ kind: "refused", state: "unsafe-opt-in", workerCount: 4 });
    expect(r.status).toBe("fail");
    expect(r.remedy).toContain("THREADS_COUNT=1");
    expect(r.detail).toContain("FLAIR_MULTI_WORKER_UNSAFE=1");
  });

  it("passes on a serving (one-worker) instance", () => {
    const r = checkWorkerThreads({ kind: "serving" });
    expect(r.status).toBe("pass");
  });

  it("skips — never passes — when the instance was not observed", () => {
    const r = checkWorkerThreads(undefined);
    expect(r.status).toBe("skip");
  });
});
