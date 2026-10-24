/**
 * request-deadline-2789.test.ts — the whole-request deadline in
 * `sendJsonRequest` (src/lib/auth-resolve.ts), its unknown-outcome error for
 * writes, and `rem restore`'s handling of that outcome (flair#2789).
 *
 * Every test that uses a server talks to a real HTTP server (node:http); fetch
 * is never mocked. The never-answer and headers-then-stall servers are bounded
 * by the deadline under test, not by the test's own timer. The default-constant
 * test starts no server.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import nacl from "tweetnacl";
import {
  ApiRequestOutcomeUnknown,
  ApiRequestTimeout,
  DEFAULT_REQUEST_DEADLINE_MS,
  REQUEST_DEADLINE_ENV,
  sendJsonRequest,
  tryAgentKeyFloor,
} from "../../src/lib/auth-resolve.ts";
import { applySnapshot, formatUnknownState, type ApiCall } from "../../src/rem/restore.ts";
import { runNightlyCycle, type RunnerOpts } from "../../src/rem/runner.ts";
import { summarizeNightlyOutcome, longRemRequestDeadline, LONG_REM_REQUEST_DEADLINE_MS } from "../../src/commands/rem.ts";
import { createSnapshot } from "../../src/rem/snapshot.ts";

const ADMIN_AUTH = `Basic ${Buffer.from("admin:stub-pass").toString("base64")}`;

interface StubServer {
  baseUrl: string;
  requests: Array<{ method: string; path: string }>;
  close: () => void;
}

function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<StubServer> {
  const requests: Array<{ method: string; path: string }> = [];
  const server: Server = createServer((req, res) => {
    requests.push({ method: req.method ?? "", path: new URL(req.url ?? "/", "http://127.0.0.1").pathname });
    handler(req, res);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        requests,
        close: () => {
          server.closeAllConnections();
          server.close();
        },
      });
    });
  });
}

const servers: StubServer[] = [];
async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<StubServer> {
  const server = await startServer(handler);
  servers.push(server);
  return server;
}

afterEach(() => {
  while (servers.length > 0) servers.pop()!.close();
});

const neverAnswer = (_req: IncomingMessage, _res: ServerResponse) => { /* accept, never answer */ };
const headersThenStall = (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(200, { "content-type": "application/json", "content-length": "100" });
  res.write("{");
  // never end the body
};
const answerSoon = (body: unknown, ms = 50) => (_req: IncomingMessage, res: ServerResponse) => {
  setTimeout(() => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }, ms);
};

describe("sendJsonRequest — whole-request deadline (flair#2789)", () => {
  test("a server that never answers ends a PUT at the deadline with an unknown outcome", async () => {
    const server = await serve(neverAnswer);
    const started = Date.now();
    const saved = process.env[REQUEST_DEADLINE_ENV];
    let error: unknown;
    try {
      process.env[REQUEST_DEADLINE_ENV] = "150";
      await sendJsonRequest(new URL(`${server.baseUrl}/Memory/m1`), "PUT", { content: "x" }, ADMIN_AUTH, true);
    } catch (err) {
      error = err;
    } finally {
      if (saved === undefined) delete process.env[REQUEST_DEADLINE_ENV];
      else process.env[REQUEST_DEADLINE_ENV] = saved;
    }
    expect(error).toBeInstanceOf(ApiRequestOutcomeUnknown);
    const unknown = error as ApiRequestOutcomeUnknown;
    expect(unknown.method).toBe("PUT");
    expect(unknown.path).toBe("/Memory/m1");
    expect(unknown.deadlineMs).toBe(150);
    expect(unknown.status).toBeUndefined();
    expect(unknown.message).toContain("may or may not have taken effect");
    expect(unknown.message).toContain(REQUEST_DEADLINE_ENV);
    expect(Date.now() - started).toBeLessThan(1500);
  }, 5_000);

  test("the same server ends a GET with an ordinary timeout, not an unknown outcome", async () => {
    const server = await serve(neverAnswer);
    let error: unknown;
    try {
      await sendJsonRequest(new URL(`${server.baseUrl}/Memory?agentId=a`), "GET", undefined, ADMIN_AUTH, true, { deadlineMs: 150 });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ApiRequestTimeout);
    expect(error).not.toBeInstanceOf(ApiRequestOutcomeUnknown);
    expect((error as ApiRequestTimeout).message).toContain("did not complete within 150 ms");
  }, 5_000);

  test("headers then a stalled body is bounded too: PUT unknown, GET ordinary", async () => {
    const putServer = await serve(headersThenStall);
    let putError: unknown;
    try {
      await sendJsonRequest(new URL(`${putServer.baseUrl}/Soul/s1`), "PUT", {}, ADMIN_AUTH, true, { deadlineMs: 200 });
    } catch (err) {
      putError = err;
    }
    expect(putError).toBeInstanceOf(ApiRequestOutcomeUnknown);
    expect((putError as ApiRequestOutcomeUnknown).status).toBe(200);

    const getServer = await serve(headersThenStall);
    let getError: unknown;
    try {
      await sendJsonRequest(new URL(`${getServer.baseUrl}/Soul?agentId=a`), "GET", undefined, ADMIN_AUTH, true, { deadlineMs: 200 });
    } catch (err) {
      getError = err;
    }
    expect(getError).toBeInstanceOf(ApiRequestTimeout);
    expect(getError).not.toBeInstanceOf(ApiRequestOutcomeUnknown);
    expect((getError as ApiRequestTimeout).status).toBe(200);
  }, 8_000);

  test("a slow answer inside the deadline is unchanged", async () => {
    const server = await serve(answerSoon({ ok: true }, 50));
    const result = await sendJsonRequest(new URL(`${server.baseUrl}/Memory/m1`), "POST", { content: "x" }, ADMIN_AUTH, true, { deadlineMs: 1_000 });
    expect(result).toEqual({ ok: true });
  }, 5_000);

  test("an invalid env value is refused before any request is sent", async () => {
    const server = await serve(answerSoon({ ok: true }, 0));
    const saved = process.env[REQUEST_DEADLINE_ENV];
    try {
      for (const value of ["abc", "0", "-1", "1.5", "3600001"]) {
        process.env[REQUEST_DEADLINE_ENV] = value;
        await expect(
          sendJsonRequest(new URL(`${server.baseUrl}/Memory/m1`), "PUT", {}, ADMIN_AUTH, true),
        ).rejects.toThrow(`${REQUEST_DEADLINE_ENV} must be an integer from 1 to 3600000`);
      }
      expect(server.requests).toHaveLength(0);
    } finally {
      if (saved === undefined) delete process.env[REQUEST_DEADLINE_ENV];
      else process.env[REQUEST_DEADLINE_ENV] = saved;
    }
  }, 5_000);

  test("the default deadline is five minutes", () => {
    const saved = process.env[REQUEST_DEADLINE_ENV];
    try {
      delete process.env[REQUEST_DEADLINE_ENV];
      expect(DEFAULT_REQUEST_DEADLINE_MS).toBe(300_000);
    } finally {
      if (saved !== undefined) process.env[REQUEST_DEADLINE_ENV] = saved;
    }
  });
});

function writeAgentKey(keysDir: string, agentId: string): void {
  mkdirSync(keysDir, { recursive: true });
  const kp = nacl.sign.keyPair();
  writeFileSync(join(keysDir, `${agentId}.key`), Buffer.from(kp.secretKey.slice(0, 32)));
  chmodSync(join(keysDir, `${agentId}.key`), 0o600);
}

describe("tryAgentKeyFloor — an unknown outcome stops the floor (flair#2789)", () => {
  test("the second key's request never arrives", async () => {
    const keysDir = mkdtempSync(join(tmpdir(), "flair-2789-keys-"));
    try {
      writeAgentKey(keysDir, "agent-a");
      writeAgentKey(keysDir, "agent-b");
      const server = await serve(neverAnswer);
      let error: unknown;
      try {
        await tryAgentKeyFloor(new URL(`${server.baseUrl}/Memory/m1`), "PUT", { content: "x" }, keysDir, { deadlineMs: 150 });
      } catch (err) {
        error = err;
      }
      // The floor must have stopped at the first key: a second request is the
      // blind replay this change forbids. Give it time to arrive if it would.
      await new Promise((r) => setTimeout(r, 300));
      expect(server.requests).toHaveLength(1);
      expect(error).toBeInstanceOf(ApiRequestOutcomeUnknown);
    } finally {
      rmSync(keysDir, { recursive: true, force: true });
    }
  }, 5_000);
});

describe("rem restore — an unknown write is recorded, never reported failed (flair#2789)", () => {
  test("a write that commits only after the deadline is unknown, and the post-restore read runs before it", async () => {
    const rows = new Map<string, Record<string, unknown>>();
    let putReceived = 0;
    const server = await serve((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/Memory") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([...rows.values()]));
        return;
      }
      if (req.method === "GET" && url.pathname === "/Soul") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("[]");
        return;
      }
      if (req.method === "GET" && url.pathname.startsWith("/AdminMemoryCandidates/")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ candidates: [], hasMore: false }));
        return;
      }
      if (req.method === "PUT" && url.pathname.startsWith("/Memory/")) {
        putReceived++;
        const id = decodeURIComponent(url.pathname.split("/")[2]!);
        const body = { id, agentId: "agent-a", content: "restored", durability: "persistent" };
        // Commit AFTER the client's 100 ms deadline has fired (at 300 ms), so
        // the row lands after the client gave up on the response.
        setTimeout(() => {
          rows.set(id, body);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        }, 300);
        return;
      }
      if (req.method === "PUT" || req.method === "DELETE") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });

    const root = mkdtempSync(join(tmpdir(), "flair-2789-restore-"));
    try {
      const snapshot = await createSnapshot({
        agentId: "agent-a",
        flairVersion: "0.0.0-test",
        memories: [{ id: "m1", agentId: "agent-a", content: "restored", durability: "persistent" }],
        soul: null,
        pendingCandidateCount: 0,
        rootOverride: join(root, "snapshots"),
      });
      const apiCall: ApiCall = (method, path, body) =>
        sendJsonRequest(new URL(path, server.baseUrl), method, body, ADMIN_AUTH, true, { deadlineMs: 100 });

      const result = await applySnapshot({
        agentId: "agent-a",
        snapshotPath: snapshot.path,
        flairVersion: "0.0.0-test",
        apiCall,
        preRestoreSnapshotRoot: join(root, "pre"),
        tmpRootOverride: root,
      });

      expect(putReceived).toBe(1);
      expect(result.unknown.memories).toEqual(["m1"]);
      expect(result.errors).toEqual([]);
      expect(result.status).toBe("unresolved");
      expect(result.restored.memories).toBe(0);
      const state = result.verified?.unknownStates.find((s) => s.id === "m1");
      expect(state).toEqual({ entity: "memory", id: "m1", present: false });
      const line = formatUnknownState(state!);
      expect(line).toContain("absent from the target after restore");
      expect(line).toContain("unresolved and its state is unverified");
      expect(line).not.toContain("present on the target");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("an unknown DELETE stops that id's write: no PUT for it, and the result is unresolved", async () => {
    const rows = new Map<string, Record<string, unknown>>([
      ["m1", { id: "m1", agentId: "agent-a", content: "current", durability: "persistent" }],
    ]);
    const server = await serve((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/Memory") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([...rows.values()]));
        return;
      }
      if (req.method === "GET" && url.pathname === "/Soul") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("[]");
        return;
      }
      if (req.method === "GET" && url.pathname.startsWith("/AdminMemoryCandidates/")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ candidates: [], hasMore: false }));
        return;
      }
      if (req.method === "DELETE" && url.pathname === "/Memory/m1") {
        return; // accept, never answer: the client's deadline decides
      }
      if (req.method === "PUT" || req.method === "DELETE") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });

    const root = mkdtempSync(join(tmpdir(), "flair-2789-restore-del-"));
    try {
      const snapshot = await createSnapshot({
        agentId: "agent-a",
        flairVersion: "0.0.0-test",
        memories: [{ id: "m1", agentId: "agent-a", content: "restored", durability: "persistent" }],
        soul: null,
        pendingCandidateCount: 0,
        rootOverride: join(root, "snapshots"),
      });
      const apiCall: ApiCall = (method, path, body) =>
        sendJsonRequest(new URL(path, server.baseUrl), method, body, ADMIN_AUTH, true, { deadlineMs: 150 });

      const result = await applySnapshot({
        agentId: "agent-a",
        snapshotPath: snapshot.path,
        flairVersion: "0.0.0-test",
        apiCall,
        preRestoreSnapshotRoot: join(root, "pre"),
        tmpRootOverride: root,
      });

      expect(server.requests.filter((r) => r.method === "PUT")).toEqual([]);
      expect(result.unknown.memories).toEqual(["m1"]);
      expect(result.skippedAfterUnknownDelete.memories).toEqual(["m1"]);
      expect(result.restored.memories).toBe(0);
      expect(result.errors).toEqual([]);
      expect(result.status).toBe("unresolved");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("rem nightly runner — a deadline expiry on a long route is unresolved, not failed (flair#2789)", () => {
  let root: string;
  let calls: Array<{ method: string; path: string }>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "flair-2789-runner-"));
    calls = [];
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function baseApi(): ApiCall {
    return async (method, path) => {
      calls.push({ method, path });
      if (method === "GET" && path.startsWith("/Memory")) return [];
      if (method === "GET" && path.startsWith("/Soul")) return [];
      if (method === "POST" && path === "/MemoryMaintenance") return { expired: 0, archived: 0, total: 0, errors: 0 };
      if (method === "POST" && path === "/ReflectMemories") {
        return { candidates: [], count: 0, model: "default", gathered: 0, unreflected: 0 };
      }
      if (method === "POST" && path === "/MemoryDedupStats") {
        return { clusterCount: 0, largestClusterSize: 0, totalMemoriesInClusters: 0, computedAt: "2026-10-24T00:00:00.000Z" };
      }
      throw new Error(`unexpected api call: ${method} ${path}`);
    };
  }

  function runnerOpts(overrides: Partial<RunnerOpts> = {}): RunnerOpts {
    return {
      agentId: "agent-a",
      flairVersion: "0.0.0-test",
      apiCall: baseApi(),
      snapshotRoot: join(root, "snapshots"),
      logPath: join(root, "logs", "rem-nightly.jsonl"),
      pauseFlagPath: join(root, "rem.paused"),
      envPaused: false,
      healthProbe: async () => ({ ok: true, elapsedMs: 1 }),
      ...overrides,
    };
  }

  function throwingOn(route: string): ApiCall {
    const base = baseApi();
    return async (method, path, body) => {
      if (method === "POST" && path === route) {
        calls.push({ method, path });
        throw new ApiRequestOutcomeUnknown(method, path, 900_000, undefined, "explicit");
      }
      return base(method, path, body);
    };
  }

  test("maintenance's expiry ends the cycle unresolved, with no failed status and no distillation", async () => {
    const result = await runNightlyCycle(runnerOpts({ apiCall: throwingOn("/MemoryMaintenance") }));

    expect(result.status).toBe("unresolved");
    expect(result.logRow.status).toBe("unresolved");
    expect(result.logRow.errors).toEqual([]);
    expect(result.logRow.outcomeUnknown).toHaveLength(1);
    expect(result.logRow.outcomeUnknown![0]).toContain("may or may not have taken effect");
    expect(calls.some((c) => c.path === "/ReflectMemories")).toBe(false);
  }, 15_000);

  test("reflection's expiry is carried as unresolved through the runner and its log, not failed", async () => {
    const result = await runNightlyCycle(runnerOpts({ apiCall: throwingOn("/ReflectMemories") }));

    expect(result.status).toBe("unresolved");
    expect(result.logRow.status).toBe("unresolved");
    expect(result.logRow.errors).toEqual([]);
    expect(result.logRow.outcomeUnknown).toHaveLength(1);
    expect(result.logRow.outcomeUnknown![0]).toContain("distillation");
    expect(result.logRow.outcomeUnknown![0]).toContain("may or may not have taken effect");
    expect(calls.some((c) => c.path === "/MemoryMaintenance")).toBe(true);
  }, 15_000);

  test("the nightly report exits 3 for an unknown outcome, 1 for an ordinary failure, 0 otherwise", () => {
    expect(summarizeNightlyOutcome({ errors: [], skips: [], outcomeUnknown: ["maintenance: x"] }).exitCode).toBe(3);
    expect(summarizeNightlyOutcome({ errors: ["dedup: forbidden"], skips: [], outcomeUnknown: ["maintenance: x"] }).exitCode).toBe(3);
    expect(summarizeNightlyOutcome({ errors: ["dedup: forbidden"], skips: [] }).exitCode).toBe(1);
    expect(summarizeNightlyOutcome({ errors: [], skips: [] }).exitCode).toBe(0);
  });
});

describe("rem long-route deadline (flair#2789)", () => {
  test("only the two long REM routes get the 900 s deadline", () => {
    expect(LONG_REM_REQUEST_DEADLINE_MS).toBe(900_000);
    expect(longRemRequestDeadline("POST", "/MemoryMaintenance")).toEqual({ deadlineMs: 900_000 });
    expect(longRemRequestDeadline("POST", "/ReflectMemories")).toEqual({ deadlineMs: 900_000 });
    expect(longRemRequestDeadline("GET", "/MemoryMaintenance")).toEqual({});
    expect(longRemRequestDeadline("POST", "/ConsolidateMemories")).toEqual({});
  });
});
