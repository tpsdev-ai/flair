// cli-memory-add-provider-timeout-retry.test.ts
//
// `flair memory add` must retry a write the instance refused with exactly
// `503 memory_provider_timeout` — the refusal states the embedding provider
// did not answer within its bound and nothing was written, so a replay sends
// the same PUT to the same memory id. Before this fix it was not retried.
//
// We spawn the real CLI against a mock HTTP server (FLAIR_URL) that answers
// each attempt with a scripted status/body, and record every request. Mirrors
// cli-memory-add-derived-from.test.ts.

import { describe, it, expect } from "bun:test";
import { spawn } from "node:child_process";
import { createServer, Server } from "node:http";
import { childOverranDeadline } from "../helpers/child-deadline.js";

const CHILD_DEADLINE_MS = 20_000;

type Reply = { status: number; body: string };
type Capture = { method?: string; path?: string; body?: any };

function startMockServer(replies: Reply[]): Promise<{ server: Server; url: string; captures: Capture[] }> {
  const captures: Capture[] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let parsed: any = undefined;
        try { parsed = body ? JSON.parse(body) : undefined; } catch { parsed = body; }
        captures.push({ method: req.method, path: req.url, body: parsed });
        const reply = replies[Math.min(captures.length - 1, replies.length - 1)];
        res.writeHead(reply.status, { "Content-Type": "application/json" });
        res.end(reply.body);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port;
      resolve({ server, url: `http://127.0.0.1:${port}`, captures });
    });
  });
}

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  leg: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn("bun", ["src/cli.ts", ...args], { cwd: ".", env, timeout: 20_000 });
    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (err += d.toString()));
    child.on("close", (code, signal) => {
      if (signal !== null) {
        reject(
          new Error(
            childOverranDeadline("flair CLI", leg, CHILD_DEADLINE_MS, { status: code, signal, stdout: out, stderr: err, elapsedMs: Date.now() - startedAt, timeoutSignal: "SIGTERM" }),
          ),
        );
        return;
      }
      resolve({ code, stdout: out, stderr: err });
    });
  });
}

const PROVIDER_TIMEOUT: Reply = {
  status: 503,
  body: JSON.stringify({ error: "memory_provider_timeout", message: "the embedding provider did not answer within its bound; nothing was written, retry" }),
};

function addArgs(extra: string[] = []): string[] {
  return ["memory", "add", "a memory whose embedding timed out", "--agent", "agent-a", "--admin-pass", "test-admin", ...extra];
}

describe("flair memory add retries a provider timeout", () => {
  it("one timeout then an accepted response: exit 0, two PUT attempts, one accepted response, same id on both", async () => {
    const { server, url, captures } = await startMockServer([PROVIDER_TIMEOUT, { status: 200, body: JSON.stringify({ ok: true }) }]);
    try {
      const { code } = await runCli(addArgs(), { ...process.env, FLAIR_URL: url, FLAIR_AGENT_ID: "" }, "timeout then success");
      expect(code).toBe(0);
      expect(captures.length).toBe(2);
      expect(captures[0].method).toBe("PUT");
      expect(captures[1].method).toBe("PUT");
      expect(captures[1].path).toBe(captures[0].path);
      // The first attempt was refused; the accepted 200 response is the retry's.
      expect(captures[1].body.id).toBe(captures[0].body.id);
      expect(captures[0].body.id).toBeString();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 25_000);

  it("timeouts on every attempt: exit 1 after 3 attempts, one memory add: error line, no stack frames", async () => {
    const { server, url, captures } = await startMockServer([PROVIDER_TIMEOUT]);
    try {
      const { code, stderr } = await runCli(addArgs(), { ...process.env, FLAIR_URL: url, FLAIR_AGENT_ID: "" }, "all timeouts");
      expect(code).toBe(1);
      expect(captures.length).toBe(3);
      const lines = stderr.split("\n").filter((l) => l.includes("memory add:"));
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain("3 attempts");
      expect(lines[0]).toContain("503 memory_provider_timeout");
      expect(stderr).not.toContain("ApiHttpError");
      expect(stderr).not.toContain("\n    at ");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 25_000);

  it("a 500 is not a provider timeout: one attempt, today's behaviour", async () => {
    const { server, url, captures } = await startMockServer([{ status: 500, body: JSON.stringify({ error: "internal_error" }) }]);
    try {
      const { code } = await runCli(addArgs(), { ...process.env, FLAIR_URL: url, FLAIR_AGENT_ID: "" }, "500");
      expect(code).not.toBe(0);
      expect(captures.length).toBe(1);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 25_000);

  it("a 503 with another code is not a provider timeout: one attempt, today's behaviour", async () => {
    const { server, url, captures } = await startMockServer([{ status: 503, body: JSON.stringify({ error: "memory_locked" }) }]);
    try {
      const { code } = await runCli(addArgs(), { ...process.env, FLAIR_URL: url, FLAIR_AGENT_ID: "" }, "503 other code");
      expect(code).not.toBe(0);
      expect(captures.length).toBe(1);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 25_000);
});
