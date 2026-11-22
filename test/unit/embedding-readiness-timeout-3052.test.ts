/**
 * embedding-readiness-timeout-3052.test.ts — the client bound is a real
 * `fetch` + `AbortSignal.timeout` against a delayed local server (flair#3052).
 *
 * The other timeout test throws a constructed `TimeoutError`. These cases use
 * a real socket: a local server accepts the warm-up write and never answers in
 * time, so the client abort must surface as the named never-ready failure. The
 * in-process case runs under Bun (the smoke path); the CLI case runs the entry
 * script under Node (the CLI E2E path).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { awaitEmbeddingReady } from "../../scripts/ci/embedding-readiness.mjs";

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
  }, 15_000);
});
