/**
 * multi-worker-doctor-2059.test.ts — flair#2059, slice S0 of #2052.
 *
 * The `worker-threads` doctor check turns the public /Health `multiWorker` field
 * into a verdict: it fails on the refused state (naming `THREADS_COUNT=1` as the
 * remedy) and under the explicit opt-in, passes on a serving (one-worker)
 * instance, SKIPS for an unobserved instance, and FAILS — blocking the run —
 * for an unrecognized observation. The discovery probe (`probeFlairHealth`, the
 * path `flair doctor` uses) must recognise a `/Health` 503 carrying the
 * `multiWorker` refusal field so a refused instance is observed rather than
 * skipped.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { createServer, type Server } from "node:http";
import {
  DOCTOR_CHECK_IDS,
  interpretFlairHealth,
  probeFlairHealth,
  readWorkerThreadsObservation,
  renderCatalogDoctorLines,
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
    // A recognized state with no usable count is still the refusal.
    expect(readWorkerThreadsObservation({ state: "refused" })).toEqual({
      kind: "refused",
      state: "refused",
      workerCount: null,
    });
  });

  it("treats an ABSENT field as a serving instance", () => {
    expect(readWorkerThreadsObservation(undefined)).toEqual({ kind: "serving" });
    expect(readWorkerThreadsObservation(null)).toEqual({ kind: "serving" });
  });

  it("treats a malformed or unrecognized field as unknown, never serving", () => {
    expect(readWorkerThreadsObservation({})).toEqual({ kind: "unknown" });
    expect(readWorkerThreadsObservation({ state: "something-else", workerCount: 2 })).toEqual({
      kind: "unknown",
    });
    expect(readWorkerThreadsObservation("refused")).toEqual({ kind: "unknown" });
    expect(readWorkerThreadsObservation(2)).toEqual({ kind: "unknown" });
  });
});

describe("interpretFlairHealth", () => {
  it("reads a 2xx /Health as Flair, serving when the field is absent", () => {
    expect(interpretFlairHealth(200, { ok: true })).toEqual({ reaching: true, observation: { kind: "serving" } });
  });

  it("reads a 503 with a refusal field as Flair, refused", () => {
    expect(interpretFlairHealth(503, { ok: false, multiWorker: { state: "refused", workerCount: 2 } })).toEqual({
      reaching: true,
      observation: { kind: "refused", state: "refused", workerCount: 2 },
    });
  });

  it("does not treat a 503 without a refusal field as Flair", () => {
    expect(interpretFlairHealth(503, { ok: false })).toEqual({ reaching: false, observation: null });
  });

  it("keeps a malformed 2xx field unknown, never serving", () => {
    expect(interpretFlairHealth(200, { multiWorker: { state: "??" } })).toEqual({
      reaching: true,
      observation: { kind: "unknown" },
    });
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

  it("fails on an unreadable refused count", () => {
    const r = checkWorkerThreads({ kind: "refused", state: "refused", workerCount: null });
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("unreadable worker count");
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
    expect(checkWorkerThreads(undefined).status).toBe("skip");
  });

  it("fails — blocking — on an unrecognized observation, and renders an error line", () => {
    const run = runDoctorChecks(
      { ...baseCtx, workerThreads: { kind: "unknown" } },
      { catalogIds: ["worker-threads"] as const },
    );
    // The whole verdict: a reachable but unrecognized observation is not healthy.
    expect(run.healthy).toBe(false);
    expect(run.results[0].status).toBe("fail");
    // The rendered line: the OK icon must not appear for an unrecognized state.
    const [line] = renderCatalogDoctorLines(run);
    expect(line.icon).toBe("error");
    expect(line.line).toContain("worker threads: fail");
    expect(line.line).toContain("worker-thread state this doctor does not recognize");
  });
});

describe("probeFlairHealth (the doctor discovery path) against a refused instance", () => {
  const servers: Server[] = [];
  afterAll(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  });

  async function serve(status: number, body: string, contentType = "application/json"): Promise<string> {
    const srv = createServer((_req, res) => {
      res.writeHead(status, { "content-type": contentType });
      res.end(body);
    });
    servers.push(srv);
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const addr = srv.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    return `http://127.0.0.1:${addr.port}/Health`;
  }

  it("recognises a refused instance (503 + refusal body) as reaching, and observes the refusal", async () => {
    const url = await serve(
      503,
      JSON.stringify({ ok: false, multiWorker: { state: "refused", workerCount: 2, remedy: "THREADS_COUNT=1" } }),
    );
    const probe = await probeFlairHealth(url);
    expect(probe.reaching).toBe(true);
    expect(probe.observation).toEqual({ kind: "refused", state: "refused", workerCount: 2 });
  });

  it("does not treat an unrelated 503 as the instance", async () => {
    const url = await serve(503, JSON.stringify({ ok: false }), "text/plain");
    const probe = await probeFlairHealth(url);
    expect(probe.reaching).toBe(false);
    expect(probe.observation).toBeNull();
  });

  it("reports a closed port as not reaching", async () => {
    const probe = await probeFlairHealth("http://127.0.0.1:1/Health", fetch, 500);
    expect(probe.reaching).toBe(false);
  });
});
