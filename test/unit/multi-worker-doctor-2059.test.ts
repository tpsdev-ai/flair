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
  it("reads refusal states", () => {
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
    expect(readWorkerThreadsObservation({ state: "refused" })).toEqual({
      kind: "refused",
      state: "refused",
      workerCount: null,
    });
  });

  it("treats undefined as absent", () => {
    expect(readWorkerThreadsObservation(undefined)).toEqual({ kind: "serving" });
  });

  it("classifies present malformed fields", () => {
    expect(readWorkerThreadsObservation(null)).toEqual({ kind: "unknown" });
    expect(readWorkerThreadsObservation({})).toEqual({ kind: "unknown" });
    expect(readWorkerThreadsObservation({ state: "something-else", workerCount: 2 })).toEqual({
      kind: "unknown",
    });
    expect(readWorkerThreadsObservation("refused")).toEqual({ kind: "unknown" });
    expect(readWorkerThreadsObservation(2)).toEqual({ kind: "unknown" });
    expect(readWorkerThreadsObservation(false)).toEqual({ kind: "unknown" });
    expect(readWorkerThreadsObservation([])).toEqual({ kind: "unknown" });
  });
});

describe("interpretFlairHealth", () => {
  it("reads 2xx without field", () => {
    expect(interpretFlairHealth(200, { ok: true })).toEqual({ reaching: true, observation: { kind: "serving" } });
  });

  it("reads refusal 503", () => {
    expect(interpretFlairHealth(503, { ok: false, multiWorker: { state: "refused", workerCount: 2 } })).toEqual({
      reaching: true,
      observation: { kind: "refused", state: "refused", workerCount: 2 },
    });
  });

  it("rejects unrelated 503", () => {
    expect(interpretFlairHealth(503, { ok: false })).toEqual({ reaching: false, observation: null });
  });

  it("classifies malformed 2xx fields", () => {
    expect(interpretFlairHealth(200, { multiWorker: null })).toEqual({
      reaching: true,
      observation: { kind: "unknown" },
    });
    expect(interpretFlairHealth(200, { multiWorker: { state: "??" } })).toEqual({
      reaching: true,
      observation: { kind: "unknown" },
    });
  });
});

describe("worker-threads check", () => {
  it("registers catalog check", () => {
    expect(DOCTOR_CHECK_IDS).toContain("worker-threads");
  });

  it("fails refusal", () => {
    const r = checkWorkerThreads({ kind: "refused", state: "refused", workerCount: 2 });
    expect(r.status).toBe("fail");
    expect(r.remedy).toContain("THREADS_COUNT=1");
    expect(r.detail).toContain("2 Harper worker threads");
  });

  it("fails unreadable count", () => {
    const r = checkWorkerThreads({ kind: "refused", state: "refused", workerCount: null });
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("unreadable worker count");
  });

  it("fails unsafe opt-in", () => {
    const r = checkWorkerThreads({ kind: "refused", state: "unsafe-opt-in", workerCount: 4 });
    expect(r.status).toBe("fail");
    expect(r.remedy).toContain("THREADS_COUNT=1");
    expect(r.detail).toContain("unsafe opt-in");
  });

  it("passes serving observation", () => {
    const r = checkWorkerThreads({ kind: "serving" });
    expect(r.status).toBe("pass");
  });

  it("skips absent observation", () => {
    expect(checkWorkerThreads(undefined).status).toBe("skip");
  });

  it("blocks unknown observation", () => {
    const run = runDoctorChecks(
      { ...baseCtx, workerThreads: { kind: "unknown" } },
      { catalogIds: ["worker-threads"] as const },
    );
    expect(run.healthy).toBe(false);
    expect(run.results[0].status).toBe("fail");
    const [line] = renderCatalogDoctorLines(run);
    expect(line.icon).toBe("error");
    expect(line.line).toContain("worker threads: fail");
    expect(line.line).toContain("worker-thread state this doctor does not recognize");
  });
});

describe("Health probe", () => {
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

  it("recognizes refusal 503", async () => {
    const url = await serve(
      503,
      JSON.stringify({ ok: false, multiWorker: { state: "refused", workerCount: 2, remedy: "THREADS_COUNT=1" } }),
    );
    const probe = await probeFlairHealth(url);
    expect(probe.reaching).toBe(true);
    expect(probe.observation).toEqual({ kind: "refused", state: "refused", workerCount: 2 });
  });

  it("rejects unrelated 503", async () => {
    const url = await serve(503, JSON.stringify({ ok: false }), "text/plain");
    const probe = await probeFlairHealth(url);
    expect(probe.reaching).toBe(false);
    expect(probe.observation).toBeNull();
  });

  it("handles closed port", async () => {
    const probe = await probeFlairHealth("http://127.0.0.1:1/Health", fetch, 500);
    expect(probe.reaching).toBe(false);
  });
});
