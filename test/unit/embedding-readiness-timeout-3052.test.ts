/**
 * embedding-readiness-timeout-3052.test.ts — the client bound is a real
 * `fetch` + `AbortSignal.timeout` against a delayed local server (flair#3052).
 *
 * The other timeout test throws a constructed `TimeoutError`. These cases use
 * a real socket: a local server accepts the warm-up write and never answers in
 * time, so the client abort must surface as the named never-ready failure. The
 * in-process case runs under Bun (the smoke path) and again in a Node child
 * with the same short request timeout and a long deadline; the CLI case runs
 * the entry script under Node (the CLI E2E path).
 *
 * The ops 401 fallback is tested here too, on a second local server: a 401 to
 * the credentialed request is retried once without `Authorization`, and both
 * legs share one `AbortSignal.timeout`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import { awaitEmbeddingReady, createWarmAgent, opsPost } from "../../scripts/ci/embedding-readiness.mjs";

const ROOT = new URL("../..", import.meta.url).pathname;
const RESPONSE_DELAY_MS = 2_000;

let server: Server;
let baseUrl = "";

function listen(serverToStart: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    serverToStart.once("error", reject);
    serverToStart.listen(0, "127.0.0.1", () => {
      const address = serverToStart.address();
      if (address === null || typeof address === "string") {
        reject(new Error("no loopback port"));
        return;
      }
      resolve(address.port);
    });
  });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      let body: any = {};
      try {
        body = JSON.parse(data || "{}");
      } catch {
        body = {};
      }
      if (req.method === "POST") {
        if (body.operation === "insert") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"inserted":1}');
          return;
        }
        if (body.operation === "delete") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
          return;
        }
        if (body.operation === "search_by_id") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("[]");
          return;
        }
      }
      // The warm-up write: hold the response past every client bound.
      const timer = setTimeout(() => {
        if (!res.writableEnded) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
        }
      }, RESPONSE_DELAY_MS);
      timer.unref?.();
    });
  });
  const port = await listen(server);
  baseUrl = `http://127.0.0.1:${port}`;
}, 10_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * An ops endpoint that answers a credentialed POST with 401 after
 * `LEG_MS` and a credential-less POST with 200 after `LEG_MS`, logging each
 * request's arrival and whether it carried `Authorization`.
 */
const LEG_MS = 600;
const SHARED_BOUND_MS = 1_000;
let opsServer: Server;
let opsUrl = "";
let opsRequests: Array<{ at: number; authorized: boolean; operation: string }> = [];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => resolve(data));
  });
}

beforeAll(async () => {
  opsServer = createServer(async (req, res) => {
    const data = await readBody(req);
    let operation = "";
    try {
      operation = String(JSON.parse(data || "{}").operation ?? "");
    } catch {
      operation = "";
    }
    const authorized = typeof req.headers.authorization === "string";
    opsRequests.push({ at: performance.now(), authorized, operation });
    const timer = setTimeout(() => {
      if (res.writableEnded || res.destroyed) return;
      if (authorized) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end('{"error":"Login failed"}');
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"message":"inserted 1 of 1 records","inserted_hashes":["x"]}');
    }, LEG_MS);
    timer.unref?.();
  });
  const port = await listen(opsServer);
  opsUrl = `http://127.0.0.1:${port}`;
}, 10_000);

afterAll(async () => {
  opsServer.closeAllConnections?.();
  await new Promise<void>((resolve) => opsServer.close(() => resolve()));
});

function runNode(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", args, { cwd: ROOT, env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr: `${stderr}${String(err)}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
  });
}

describe("flair#3052 — a real client timeout is a named never-ready failure", () => {
  test("Bun: a fetch aborted before the deadline reports never ready", async () => {
    const call = awaitEmbeddingReady({
      label: "local-server readiness",
      deadlineMs: 5_000,
      now: () => performance.now(),
      log: () => {},
      attempt: () => fetch(`${baseUrl}/Memory/warmup`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "warmup", agentId: "agent-a", content: "warm-up" }),
        signal: AbortSignal.timeout(100),
      }),
    });

    const error = await call.then(() => null, (err: Error) => err);
    expect(error?.message).toContain("never became ready");
    expect(error?.message).not.toContain("embedding provider call failed");
    expect(error?.message).toContain("1 attempt(s)");
  }, 10_000);

  test("Node: a fetch aborted before a long deadline reports never ready, in-process", async () => {
    // The same seam as the Bun case, under Node: a 100 ms client timeout on a
    // 5 s deadline. Only the TimeoutError branch can classify this abort as
    // never-ready; the clock alone would call it a provider failure.
    const helperUrl = pathToFileURL(`${ROOT}scripts/ci/embedding-readiness.mjs`).href;
    const script = `
      import { awaitEmbeddingReady } from ${JSON.stringify(helperUrl)};
      console.log("runtime=" + (process.versions.bun ? "bun" : "node") + " " + process.version);
      try {
        await awaitEmbeddingReady({
          label: "node in-process readiness",
          deadlineMs: 5000,
          log: () => {},
          attempt: () => fetch(process.env.READINESS_BASE_URL + "/Memory/warmup", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: "warmup", agentId: "agent-a", content: "warm-up" }),
            signal: AbortSignal.timeout(100),
          }),
        });
        console.log("unexpectedly ready");
        process.exit(0);
      } catch (err) {
        console.error(err.message);
        process.exit(1);
      }
    `;
    const result = await runNode(["--input-type=module", "-e", script], {
      ...process.env,
      READINESS_BASE_URL: baseUrl,
    });

    expect(result.stdout, result.stderr).toContain("runtime=node ");
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(result.stderr).toContain("node in-process readiness");
    expect(result.stderr).toContain("never became ready");
    expect(result.stderr).not.toContain("embedding provider call failed");
    expect(result.stderr).toContain("1 attempt(s)");
  }, 15_000);

  test("Node: the CLI entry path reports never ready and exits non-zero", async () => {
    const result = await runNode([
      "scripts/ci/embedding-readiness.mjs",
      "--base-url", baseUrl,
      "--ops-url", baseUrl,
      "--deadline-ms", "400",
      "--label", "node timeout",
    ], {
      ...process.env,
      FLAIR_ADMIN_USER: "admin",
      FLAIR_ADMIN_PASS: "admin123",
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(result.stderr).toContain("node timeout");
    expect(result.stderr).toContain("never became ready");
    expect(result.stdout).not.toContain("embedding ready");
    // The helper's own client signal ended the write: without it the server's
    // late 200 (at RESPONSE_DELAY_MS) would be the last answer instead.
    expect(result.stderr).not.toContain("HTTP 200");
    expect(result.stderr).toMatch(/last: .*(timed out|timeout)/i);
  }, 15_000);
});

describe("flair#3052 — the ops 401 fallback shares one client bound", () => {
  test("a 401 retries once without Authorization and succeeds", async () => {
    opsRequests = [];
    const agentId = await createWarmAgent(opsUrl, "Basic d3Jvbmc6Y3JlZGVudGlhbHM=");

    expect(agentId).toStartWith("embedding-warmup-");
    expect(opsRequests.map((r) => ({ authorized: r.authorized, operation: r.operation }))).toEqual([
      { authorized: true, operation: "insert" },
      { authorized: false, operation: "insert" },
    ]);
  }, 10_000);

  test("two legs that together exceed one bound abort at that single bound", async () => {
    // Each leg (600 ms) is below the bound (1000 ms); together (1200 ms) they
    // exceed it. With one shared signal the retry is aborted at ~1000 ms; a
    // fresh timeout for the retry would let it answer 200 at ~1200 ms.
    opsRequests = [];
    const t0 = performance.now();
    const error = await opsPost(
      opsUrl,
      "Basic d3Jvbmc6Y3JlZGVudGlhbHM=",
      { operation: "insert", database: "flair", table: "Agent", records: [] },
      fetch,
      SHARED_BOUND_MS,
    ).then(() => null, (err: Error) => err);
    const elapsed = performance.now() - t0;

    expect(error?.name, String(error)).toBe("TimeoutError");
    expect(opsRequests.map((r) => r.authorized)).toEqual([true, false]);
    expect(elapsed).toBeGreaterThanOrEqual(SHARED_BOUND_MS - 50);
    expect(elapsed).toBeLessThan(LEG_MS * 2);
  }, 10_000);

  test("control: the same two legs inside the bound succeed", async () => {
    opsRequests = [];
    const text = await opsPost(
      opsUrl,
      "Basic d3Jvbmc6Y3JlZGVudGlhbHM=",
      { operation: "insert", database: "flair", table: "Agent", records: [] },
      fetch,
      LEG_MS * 2 + 400,
    );

    expect(text).toContain("inserted");
    expect(opsRequests.map((r) => r.authorized)).toEqual([true, false]);
  }, 10_000);
});
