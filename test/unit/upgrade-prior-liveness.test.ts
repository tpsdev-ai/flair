// upgrade-prior-liveness.test.ts — flair#1740.
//
// Connection refused is the only "stopped" signal. A 2xx /Health is running.
// A non-2xx answer or a timeout is indeterminate — an unresponsive process is
// not "nothing was listening".
import { describe, test, expect, afterAll } from "bun:test";
import { createServer, type Server } from "node:http";
import {
  classifyUpgradePriorLiveness,
  isConnectionRefused,
} from "../../src/lib/upgrade-prior-liveness.ts";

const servers: Server[] = [];

function listen(srv: Server): Promise<number> {
  servers.push(srv);
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => {
    resolve((srv.address() as { port: number }).port);
  }));
}

afterAll(() => {
  for (const s of servers) s.close();
});

describe("classifyUpgradePriorLiveness", () => {
  test("a closed port is confirmed stopped", async () => {
    const srv = createServer();
    const port = await listen(srv);
    await new Promise<void>((resolve) => srv.close(() => resolve()));
    const result = await classifyUpgradePriorLiveness(`http://127.0.0.1:${port}`, { timeoutMs: 1000 });
    expect(result).toEqual({ kind: "stopped" });
  });

  test("HTTP 200 /Health is running", async () => {
    const srv = createServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    const port = await listen(srv);
    const result = await classifyUpgradePriorLiveness(`http://127.0.0.1:${port}`, { timeoutMs: 1000 });
    expect(result).toEqual({ kind: "running" });
  });

  test("HTTP 500 is indeterminate, not stopped", async () => {
    const srv = createServer((_req, res) => {
      res.writeHead(500);
      res.end("nope");
    });
    const port = await listen(srv);
    const result = await classifyUpgradePriorLiveness(`http://127.0.0.1:${port}`, { timeoutMs: 1000 });
    expect(result.kind).toBe("indeterminate");
    if (result.kind === "indeterminate") expect(result.reason).toBe("HTTP 500");
  });

  test("a hung /Health is indeterminate, not stopped", async () => {
    const srv = createServer(() => { /* accept and never answer */ });
    const port = await listen(srv);
    const result = await classifyUpgradePriorLiveness(`http://127.0.0.1:${port}`, { timeoutMs: 200 });
    expect(result.kind).toBe("indeterminate");
    expect(result.kind).not.toBe("stopped");
  });

  test("ECONNREFUSED on a nested cause is stopped; a timeout or a generic connect failure is not", () => {
    const nested = new Error("connect failed");
    (nested as { cause?: unknown }).cause = Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
    expect(isConnectionRefused(nested)).toBe(true);
    const bun = Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), { code: "ConnectionRefused" });
    expect(isConnectionRefused(bun)).toBe(true);
    expect(isConnectionRefused(new Error("The operation was aborted due to timeout"))).toBe(false);
    expect(isConnectionRefused(new Error("Unable to connect. Is the computer able to access the url?"))).toBe(false);
  });
});
