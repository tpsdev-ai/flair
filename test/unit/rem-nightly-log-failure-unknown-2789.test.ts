/**
 * rem-nightly-log-failure-unknown-2789.test.ts — a failed nightly log append
 * after an unknown write still exits 3 (flair#2789).
 *
 * The built CLI runs a cycle against a local HTTP listener. POST
 * /AutoPromoteCandidates is a write and is held past FLAIR_REQUEST_TIMEOUT_MS,
 * so its outcome is unknown. The audit log path is a directory, so appending
 * the row fails. The report must carry the unknown outcome (exit 3) and print
 * the log failure too, instead of escaping to the command's exit-1 catch.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import nacl from "tweetnacl";
import { ensureCliBuild } from "../helpers/build-cli-once.js";
import { childOverranDeadline, cliLeg } from "../helpers/child-deadline.js";
import { nodeBin } from "../helpers/node-runtime.js";

const CHILD_DEADLINE_MS = 25_000;
const CLI_PATH = join(import.meta.dirname ?? __dirname, "..", "..", "dist", "cli.js");
const AGENT_ID = "agent-a";
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
      // Literal so the spawn-budget gate sees a deadline (flair#1807); same value as CHILD_DEADLINE_MS, which the
      // overrun message names. The request deadline is 100 ms, so 25 s is start-up headroom inside the 35 s case budget.
      timeout: 25_000,
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
  const memory = {
    id: "m1",
    agentId: AGENT_ID,
    content: "an adk-tagged memory",
    durability: "persistent",
    createdAt: new Date().toISOString(),
    tags: ["adk:app-a:user-a"],
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on("end", () => {
      const line = `${req.method} ${req.url ?? "/"}`;
      seen.push(line);
      if (req.method === "GET" && req.url === "/Health") return sendJson(res, []);
      if (req.method === "GET" && (req.url ?? "").startsWith("/Memory?")) return sendJson(res, [memory]);
      if (req.method === "GET" && (req.url ?? "").startsWith("/Soul?")) return sendJson(res, []);
      if (req.method === "POST" && req.url === "/MemoryMaintenance") {
        return sendJson(res, { expired: 0, archived: 0, total: 1, errors: 0 });
      }
      if (req.method === "POST" && req.url === "/ReflectMemories") {
        return sendJson(res, { candidates: [], count: 0, model: "default", gathered: 0, unreflected: 0 });
      }
      if (req.method === "POST" && req.url === "/AutoPromoteCandidates") {
        return; // accept, never answer: the client's deadline decides
      }
      if (req.method === "POST" && req.url === "/MemoryDedupStats") {
        return sendJson(res, { clusterCount: 0, largestClusterSize: 0, totalMemoriesInClusters: 0, computedAt: new Date().toISOString() });
      }
      return sendJson(res, {});
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
  home = mkdtempSync(join(tmpdir(), "flair-2789-log-fail-"));
  const keysDir = join(home, ".flair", "keys");
  mkdirSync(keysDir, { recursive: true });
  const keyPair = nacl.sign.keyPair();
  writeFileSync(join(keysDir, `${AGENT_ID}.key`), Buffer.from(keyPair.secretKey.slice(0, 32)), { mode: 0o600 });
  // A directory where the log file belongs makes every append fail.
  mkdirSync(join(home, ".flair", "logs", "rem-nightly.jsonl"), { recursive: true });
  listener = await startListener();
}, 120_000);

afterAll(async () => {
  if (listener) await listener.close();
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("flair#2789 — a nightly log append that fails after an unknown write", () => {
  test("the report keeps the unknown outcome (exit 3) and prints the log failure", async () => {
    const result = await runCli(
      ["rem", "nightly", "run-once", "--agent", AGENT_ID],
      { HOME: home, FLAIR_URL: `http://127.0.0.1:${listener.port}`, FLAIR_REQUEST_TIMEOUT_MS: String(DEADLINE_MS), NO_COLOR: "1" },
    );
    const detail = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
    expect(result.code, detail).toBe(3);
    expect(result.stdout, detail).toContain("Status:     unresolved");
    expect(result.stdout, detail).toContain("Unknown outcome:");
    expect(result.stdout, detail).toContain("auto-promote:");
    expect(result.stdout, detail).toContain("may or may not have taken effect");
    expect(result.stderr, detail).toContain("Log write failed:");
    expect(listener.seen.filter((l) => l === "POST /AutoPromoteCandidates"), detail).toHaveLength(1);
  }, 35_000);
});
