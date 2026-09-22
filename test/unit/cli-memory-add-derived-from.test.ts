// cli-memory-add-derived-from.test.ts — Flair #503
//
// `flair memory add` must expose `--derived-from <csv>` so the `rem rapid`
// reflection loop can set provenance lineage (source episodic IDs → distilled
// lesson) via the documented path. Before the fix the option didn't exist, so
// derivedFrom could never be set through `memory add`.
//
// We spawn the real CLI against a mock HTTP server (FLAIR_URL), capture the PUT
// /Memory/<id> body, and assert derivedFrom is populated. Mirrors cli-v2.test.ts.

import { describe, it, expect } from "bun:test";
import { spawn } from "node:child_process";
import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import { childOverranDeadline } from "../helpers/child-deadline.js";

// flair#1807: the child's OWN deadline (a mock-server CLI run — not a --help
// spawn, not a `flair init` spawn) and a per-test budget ABOVE it (deadline +
// 5 s for the mock server setup and assertions), so a hung child is reported by
// the child's deadline, by name, with its output — never as bun's bare
// per-test "timed out".
const CHILD_DEADLINE_MS = 20_000;
const CASE_BUDGET_MS = 25_000;

type Capture = { method?: string; path?: string; body?: any };

function startMockServer(onRequest: (cap: Capture) => void): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let parsed: any = undefined;
        try { parsed = body ? JSON.parse(body) : undefined; } catch { parsed = body; }
        onRequest({ method: req.method, path: req.url, body: parsed });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  leg: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["src/cli.ts", ...args], { cwd: ".", env, timeout: CHILD_DEADLINE_MS });
    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (err += d.toString()));
    child.on("close", (code, signal) => {
      if (signal !== null) {
        reject(
          new Error(
            childOverranDeadline("flair CLI", leg, CHILD_DEADLINE_MS, { status: code, signal, stdout: out, stderr: err }),
          ),
        );
        return;
      }
      resolve({ code, stdout: out, stderr: err });
    });
  });
}

describe("flair memory add --derived-from (Flair #503)", () => {
  it("sets derivedFrom from a comma-separated list on the written memory", async () => {
    const captures: Capture[] = [];
    const { server, url } = await startMockServer((c) => captures.push(c));
    try {
      const { code } = await runCli(
        ["memory", "add", "an insight distilled from episodics", "--agent", "krais", "--admin-pass", "test-admin", "--durability", "persistent", "--derived-from", "krais-111, krais-222 ,krais-333"],
        { ...process.env, FLAIR_URL: url, FLAIR_AGENT_ID: "" },
        "derived-from set",
      );
      expect(code).toBe(0);

      const put = captures.find((c) => c.method === "PUT" && c.path?.startsWith("/Memory/"));
      expect(put).toBeTruthy();
      expect(Array.isArray(put!.body.derivedFrom)).toBe(true);
      // CSV split + trim + drop empties
      expect(put!.body.derivedFrom).toEqual(["krais-111", "krais-222", "krais-333"]);
      expect(put!.body.agentId).toBe("krais");
      expect(put!.body.durability).toBe("persistent");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, CASE_BUDGET_MS);

  it("omits derivedFrom when --derived-from is not passed (no regression)", async () => {
    const captures: Capture[] = [];
    const { server, url } = await startMockServer((c) => captures.push(c));
    try {
      const { code } = await runCli(
        ["memory", "add", "a plain memory", "--agent", "krais", "--admin-pass", "test-admin"],
        { ...process.env, FLAIR_URL: url, FLAIR_AGENT_ID: "" },
        "derived-from omitted",
      );
      expect(code).toBe(0);
      const put = captures.find((c) => c.method === "PUT" && c.path?.startsWith("/Memory/"));
      expect(put).toBeTruthy();
      expect(put!.body.derivedFrom).toBeUndefined();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, CASE_BUDGET_MS);
});
