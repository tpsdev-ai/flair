/**
 * api-connect-phase-2869.test.ts — the CLI's alternate-configured-port
 * fallback (src/cli.ts `api()`) engages only for a connect-phase failure
 * (flair#2869).
 *
 * The CLI cases drive the built CLI against real node:http servers on ephemeral
 * ports, so the CLI's transport is Node's undici; the classifier's Bun case is a
 * real refused connection made by this test process, which runs under Bun. The
 * scratch HOME names the primary port in harper-config.yaml and the alternate
 * in config.yaml, with no explicit base URL, which is the shape `api()` falls
 * back from.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ApiRequestOutcomeUnknown, authedRequest, isConnectPhaseFailure, REFUSED_CODES } from "../../src/lib/auth-resolve.ts";
import { ensureCliBuild } from "../helpers/build-cli-once.js";
import { childOverranDeadline, cliLeg } from "../helpers/child-deadline.js";
import { nodeBin } from "../helpers/node-runtime.js";

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

const answerOk = (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
};

/** Read the whole request, then drop the connection without answering. */
const readThenDrop = (req: IncomingMessage, _res: ServerResponse) => {
  req.on("data", () => { /* drain */ });
  req.on("end", () => req.socket.destroy());
};

/** Read the whole request, then answer 307 to `location`. */
function readThenRedirect(location: string) {
  return (req: IncomingMessage, res: ServerResponse) => {
    req.on("data", () => { /* drain */ });
    req.on("end", () => {
      res.writeHead(307, { location });
      res.end();
    });
  };
}

/** Read the whole request, answer 200 with a body, then cut the body short. */
const readThenTruncateBody = (req: IncomingMessage, res: ServerResponse) => {
  req.on("data", () => { /* drain */ });
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json", "content-length": "100" });
    res.write("{\"ok\":");
    setTimeout(() => res.socket?.destroy(), 10);
  });
};

/** A port nothing listens on: a connection there is refused. */
async function refusedPort(): Promise<number> {
  const server = createServer((_req, _res) => { /* never reached */ });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * A scratch HOME shaped as the CLI resolves a default install: Harper's record
 * in ~/.flair/data names the primary port, ~/.flair/config.yaml the alternate.
 * No FLAIR_URL is set for the run.
 */
function scratchHome(primaryPort: number, alternatePort: number): string {
  const home = mkdtempSync(join(tmpdir(), "flair-2869-altport-"));
  const flairDir = join(home, ".flair");
  mkdirSync(join(flairDir, "data"), { recursive: true });
  writeFileSync(join(flairDir, "data", "harper-config.yaml"), `http:\n  port: ${primaryPort}\n`);
  writeFileSync(join(flairDir, "config.yaml"), `port: ${alternatePort}\n`);
  return home;
}

const CLI_PATH = join(import.meta.dirname ?? __dirname, "..", "..", "dist", "cli.js");
const CHILD_DEADLINE_MS = 20_000;

function runCli(args: string[], env: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const childEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !key.startsWith("FLAIR_") && !key.startsWith("HDB_")) childEnv[key] = value;
    }
    Object.assign(childEnv, env);
    const child = spawn(nodeBin({ env: childEnv, cwd: env.HOME }), [CLI_PATH, ...args], {
      cwd: env.HOME,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      // Literal so the spawn-budget gate sees a deadline (flair#1807).
      timeout: 20_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code, signal) => {
      if (signal !== null) {
        reject(new Error(childOverranDeadline("flair CLI", cliLeg(args), CHILD_DEADLINE_MS, { status: code, signal, elapsedMs: Date.now() - startedAt, stdout, stderr })));
        return;
      }
      resolve({ stdout, stderr, code });
    });
  });
}

/** A POST through api(): `rem promote --to memory` issues one POST /PromoteMemoryCandidate. */
const writeCommand = [
  "rem", "promote", "candidate-1",
  "--rationale", "the candidate is durable",
  "--to", "memory",
  "--reviewer", "operator-a",
];
/** A GET through api(): `memory list` issues one GET /Memory?agentId=… */
const readCommand = ["memory", "list"];
const identityEnv = { FLAIR_AGENT_ID: "agent-a", FLAIR_ADMIN_PASS: "stub-pass", NO_COLOR: "1" };

describe("api() — alternate-port fallback is connect-phase only (flair#2869)", () => {
  test("a write to a port with nothing listening falls back and the alternate records one request", async () => {
    ensureCliBuild();
    const alternate = await serve(answerOk);
    const home = scratchHome(await refusedPort(), Number(new URL(alternate.baseUrl).port));
    try {
      const result = await runCli(writeCommand, { HOME: home, ...identityEnv });
      const detail = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
      expect(result.code, detail).toBe(0);
      expect(alternate.requests, detail).toEqual([{ method: "POST", path: "/PromoteMemoryCandidate" }]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  test("a write whose connection drops after the body was read is an unknown outcome and the alternate receives no request", async () => {
    ensureCliBuild();
    const primary = await serve(readThenDrop);
    const alternate = await serve(answerOk);
    const home = scratchHome(Number(new URL(primary.baseUrl).port), Number(new URL(alternate.baseUrl).port));
    try {
      const result = await runCli(writeCommand, { HOME: home, ...identityEnv });
      const detail = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
      expect(primary.requests, detail).toEqual([{ method: "POST", path: "/PromoteMemoryCandidate" }]);
      expect(alternate.requests, detail).toEqual([]);
      expect(result.code, detail).toBe(3);
      expect(result.stderr, detail).toContain("Unknown outcome:");
      expect(result.stderr, detail).toContain(`to ${primary.baseUrl}: no final response`);
      expect(result.stderr, detail).toContain("Check the server (or the origin it redirected to) before retrying");
      expect(result.stderr, detail).not.toContain("stub-pass");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  test("a GET whose connection drops after the request is sent surfaces the transport error and the alternate receives no request", async () => {
    ensureCliBuild();
    const primary = await serve(readThenDrop);
    const alternate = await serve(answerOk);
    const home = scratchHome(Number(new URL(primary.baseUrl).port), Number(new URL(alternate.baseUrl).port));
    try {
      const result = await runCli(readCommand, { HOME: home, ...identityEnv });
      const detail = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
      expect(primary.requests, detail).toEqual([{ method: "GET", path: "/Memory" }]);
      expect(alternate.requests, detail).toEqual([]);
      expect(result.code, detail).not.toBe(0);
      expect(result.code, detail).not.toBe(3);
      expect(result.stderr, detail).not.toContain("Unknown outcome:");
      expect(result.stderr, detail).not.toContain("Cannot reach the Flair instance");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  test("a write the primary redirects is refused by name and the alternate receives no request", async () => {
    ensureCliBuild();
    const refused = await refusedPort();
    const primary = await serve(readThenRedirect(`http://127.0.0.1:${refused}/PromoteMemoryCandidate`));
    const alternate = await serve(answerOk);
    const home = scratchHome(Number(new URL(primary.baseUrl).port), Number(new URL(alternate.baseUrl).port));
    try {
      const result = await runCli(writeCommand, { HOME: home, ...identityEnv });
      const detail = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
      expect(primary.requests, detail).toEqual([{ method: "POST", path: "/PromoteMemoryCandidate" }]);
      expect(alternate.requests, detail).toEqual([]);
      expect(result.code, detail).toBe(1);
      expect(result.stderr, detail).toContain("HTTP 307");
      expect(result.stderr, detail).toContain("redirect");
      expect(result.stderr, detail).not.toContain("Unknown outcome:");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  test("a write whose 200 response body is cut off is an unknown outcome naming the status and the alternate receives no request", async () => {
    ensureCliBuild();
    const primary = await serve(readThenTruncateBody);
    const alternate = await serve(answerOk);
    const home = scratchHome(Number(new URL(primary.baseUrl).port), Number(new URL(alternate.baseUrl).port));
    try {
      const result = await runCli(writeCommand, { HOME: home, ...identityEnv });
      const detail = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
      expect(primary.requests, detail).toEqual([{ method: "POST", path: "/PromoteMemoryCandidate" }]);
      expect(alternate.requests, detail).toEqual([]);
      expect(result.code, detail).toBe(3);
      expect(result.stderr, detail).toContain("Unknown outcome:");
      expect(result.stderr, detail).toContain("the successful response body could not be read (HTTP 200)");
      expect(result.stderr, detail).toContain("may have been applied");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  test("a body that cannot be serialized sends no request and is not an unknown outcome", async () => {
    const server = await serve(answerOk);
    const body: Record<string, unknown> = { agentId: "agent-a" };
    body.self = body;
    let caught: unknown;
    try {
      await authedRequest("POST", "/PromoteMemoryCandidate", body, {
        baseUrl: server.baseUrl,
        agentId: "agent-a",
        explicitAdminPass: "stub-pass",
      });
    } catch (err) {
      caught = err;
    }
    expect(server.requests).toEqual([]);
    expect(caught).toBeInstanceOf(Error);
    expect(caught instanceof ApiRequestOutcomeUnknown).toBe(false);
    expect((caught as Error).message).toContain("could not be serialized to JSON");
    expect((caught as Error).message).toContain("was not sent");
  });

  test("a falsy body that cannot be serialized (0n) is refused without sending a request", async () => {
    const server = await serve(answerOk);
    let caught: unknown;
    try {
      await authedRequest("POST", "/PromoteMemoryCandidate", 0n, {
        baseUrl: server.baseUrl,
        agentId: "agent-a",
        explicitAdminPass: "stub-pass",
      });
    } catch (err) {
      caught = err;
    }
    expect(server.requests).toEqual([]);
    expect(caught).toBeInstanceOf(Error);
    expect(caught instanceof ApiRequestOutcomeUnknown).toBe(false);
    expect((caught as Error).message).toContain("could not be serialized to JSON");
    expect((caught as Error).message).toContain("was not sent");
  });

  test("a function body is refused as a serialization error without sending a request", async () => {
    const server = await serve(answerOk);
    let caught: unknown;
    try {
      await authedRequest("POST", "/PromoteMemoryCandidate", () => {}, {
        baseUrl: server.baseUrl,
        agentId: "agent-a",
        explicitAdminPass: "stub-pass",
      });
    } catch (err) {
      caught = err;
    }
    expect(server.requests).toEqual([]);
    expect(caught).toBeInstanceOf(Error);
    expect(caught instanceof ApiRequestOutcomeUnknown).toBe(false);
    expect((caught as Error).message).toContain("could not be serialized to JSON");
    expect((caught as Error).message).toContain("was not sent");
  });

  test("a real refused connection under Bun carries a code the classifier accepts", async () => {
    const port = await refusedPort();
    let caught: unknown;
    try {
      await fetch(`http://127.0.0.1:${port}/Health`);
    } catch (err) {
      caught = err;
    }
    let current: unknown = caught;
    let refusedCode: string | undefined;
    for (let depth = 0; current !== null && current !== undefined && depth < 8; depth++) {
      if (typeof current === "object" && "code" in current) {
        const code = (current as { code?: unknown }).code;
        if (typeof code === "string" && REFUSED_CODES.includes(code)) {
          refusedCode = code;
          break;
        }
      }
      current = (current as { cause?: unknown }).cause;
    }
    expect(refusedCode).toBeDefined();
    expect(isConnectPhaseFailure(caught)).toBe(true);
  });

  test("a bare fetch failed with no recognised code is not a connect-phase failure", () => {
    // What the classification must treat as unknown: no code at all, or a
    // code that can also occur after send.
    // The predicate is also exercised directly with representative error shapes.
    expect(isConnectPhaseFailure(new TypeError("fetch failed"))).toBe(false);
    const socketClosed = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
    expect(isConnectPhaseFailure(new TypeError("fetch failed", { cause: socketClosed }))).toBe(false);
    expect(isConnectPhaseFailure(Object.assign(new TypeError("fetch failed"), { code: "ECONNRESET" }))).toBe(false);
    expect(isConnectPhaseFailure(Object.assign(new TypeError("fetch failed"), { code: "EPIPE" }))).toBe(false);
    expect(isConnectPhaseFailure(Object.assign(new TypeError("fetch failed"), { code: "UND_ERR_CLOSED" }))).toBe(false);

    // The connect-phase whitelist, reached through the cause chain (undici) and
    // on the error itself (Bun).
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" });
    expect(isConnectPhaseFailure(new TypeError("fetch failed", { cause: refused }))).toBe(true);
    expect(isConnectPhaseFailure(Object.assign(new TypeError("fetch failed"), { code: "ECONNREFUSED" }))).toBe(true);
    // The other refusal spelling Bun uses, already recognized by
    // src/lib/upgrade-prior-liveness.ts's REFUSED_TOKENS.
    expect(isConnectPhaseFailure(Object.assign(new TypeError("fetch failed"), { code: "ConnectionRefused" }))).toBe(true);
    for (const code of ["ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL", "UND_ERR_CONNECT_TIMEOUT"]) {
      expect(isConnectPhaseFailure(new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) })), code).toBe(true);
    }
  });
});
