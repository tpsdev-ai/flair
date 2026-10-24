/**
 * unknown-write-outcome-exit-2789.test.ts — every write that crosses its
 * whole-request deadline reports an unknown outcome and exits 3 (flair#2789).
 *
 * Two paths are driven through the built CLI against a local HTTP listener
 * that accepts the request and never answers:
 *
 *   federation prune --apply  catches the DELETE itself: it counts the peer
 *                             apart from a definite failure and exits 3.
 *   memory add                lets the error propagate: the top-level handler
 *                             reports it as `rem` does and exits 3.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCliBuild } from "../helpers/build-cli-once.js";
import { childOverranDeadline, cliLeg } from "../helpers/child-deadline.js";
import { nodeBin } from "../helpers/node-runtime.js";

const CHILD_DEADLINE_MS = 20_000;
const CLI_PATH = join(import.meta.dirname ?? __dirname, "..", "..", "dist", "cli.js");
const DEADLINE_MS = 100;

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

function sendJson(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function startListener() {
  const seen: string[] = [];
  const oldSync = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on("end", () => {
      const line = `${req.method} ${req.url ?? "/"}`;
      seen.push(line);
      if (req.method === "GET" && req.url === "/FederationPeers") {
        return sendJson(res, { peers: [{ id: "peer-a", role: "spoke", lastSyncAt: oldSync }] });
      }
      // Accept every write and never answer: the client's deadline decides.
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    server,
    seen,
    port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

let listener: Awaited<ReturnType<typeof startListener>>;
let home: string;

beforeAll(async () => {
  ensureCliBuild();
  home = mkdtempSync(join(tmpdir(), "flair-2789-unknown-exit-"));
  listener = await startListener();
}, 120_000);

afterAll(async () => {
  if (listener) await listener.close();
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("flair#2789 — a write with an unknown outcome exits 3", () => {
  test("federation prune --apply counts the peer as unknown, not an error, and exits 3", async () => {
    listener.seen.length = 0;
    const result = await runCli(
      ["federation", "prune", "--apply", "--older-than", "1m", "--target", `http://127.0.0.1:${listener.port}`],
      { HOME: home, FLAIR_REQUEST_TIMEOUT_MS: String(DEADLINE_MS), NO_COLOR: "1" },
    );
    const detail = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
    expect(result.code, detail).toBe(3);
    expect(result.stdout, detail).toContain("Unknown outcome for peer-a:");
    expect(result.stdout, detail).toContain("may or may not have taken effect");
    expect(result.stdout, detail).toContain("0 error(s)");
    expect(result.stdout, detail).toContain("1 unknown outcome(s)");
    expect(listener.seen.filter((l) => l.startsWith("DELETE /FederationPeers/")), detail).toHaveLength(1);
  }, 30_000);

  test("a non-rem write whose error propagates exits 3 through the top-level handler", async () => {
    listener.seen.length = 0;
    const result = await runCli(
      ["memory", "add", "--agent", "agent-a", "--admin-pass", "test-pass", "--content", "deadline probe"],
      { HOME: home, FLAIR_URL: `http://127.0.0.1:${listener.port}`, FLAIR_REQUEST_TIMEOUT_MS: String(DEADLINE_MS), NO_COLOR: "1" },
    );
    const detail = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
    expect(result.code, detail).toBe(3);
    expect(result.stderr, detail).toContain("Unknown outcome:");
    expect(result.stderr, detail).toContain("may or may not have taken effect");
    expect(listener.seen.filter((l) => l.startsWith("PUT /Memory/")), detail).toHaveLength(1);
  }, 30_000);
});
