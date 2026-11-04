/**
 * rem-promote-reject-unknown-2789.test.ts — `flair rem promote` and
 * `flair rem reject` print a write's unknown outcome and exit 3 (flair#2789).
 *
 * Each case runs the built CLI against a local HTTP listener that accepts the
 * named write and never answers, so FLAIR_REQUEST_TIMEOUT_MS expires on it.
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
const AGENT_ID = "agent-a";
const CANDIDATE_ID = "candidate-a";
const SOUL_KEY = "lessons";
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
      // overrun message names. The request deadline is 100 ms, so 20 s is start-up headroom inside the 30 s case budget.
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

/** The request line ("METHOD /path") the listener accepts and never answers. */
let unanswered = "";

async function startListener() {
  const seen: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const line = `${req.method} ${req.url ?? "/"}`;
    seen.push(line);
    req.resume();
    req.on("end", () => {
      if (line === unanswered) return; // accept, never answer: the client's deadline decides
      if (req.method === "GET" && req.url === `/MemoryCandidate/${CANDIDATE_ID}`) {
        return sendJson(res, { id: CANDIDATE_ID, agentId: AGENT_ID, claim: "claim-a", status: "pending" });
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
  home = mkdtempSync(join(tmpdir(), "flair-2789-rem-promote-"));
  listener = await startListener();
}, 120_000);

afterAll(async () => {
  if (listener) await listener.close();
  if (home) rmSync(home, { recursive: true, force: true });
});

async function runAgainstListener(args: string[], hang: string) {
  listener.seen.length = 0;
  unanswered = hang;
  const result = await runCli(args, {
    HOME: home,
    FLAIR_URL: `http://127.0.0.1:${listener.port}`,
    FLAIR_REQUEST_TIMEOUT_MS: String(DEADLINE_MS),
    NO_COLOR: "1",
  });
  return { ...result, detail: `stdout:\n${result.stdout}\nstderr:\n${result.stderr}\nrequests:\n${listener.seen.join("\n")}` };
}

const SOUL_PUT = `PUT /Soul/${AGENT_ID}-${SOUL_KEY}`;
const CANDIDATE_PUT = `PUT /MemoryCandidate/${CANDIDATE_ID}`;
const PROMOTE_POST = "POST /PromoteMemoryCandidate";
const PROMOTE_TO_SOUL = ["rem", "promote", CANDIDATE_ID, "--rationale", "rationale-a", "--to", "soul", "--key", SOUL_KEY];

describe("flair#2789 — rem promote and rem reject exit 3 for an unknown write outcome", () => {
  test("rem promote --to soul: an unknown Soul PUT sends no candidate PUT and exits 3", async () => {
    const r = await runAgainstListener(PROMOTE_TO_SOUL, SOUL_PUT);
    expect(r.code, r.detail).toBe(3);
    expect(r.stderr, r.detail).toContain(`Unknown outcome: ${SOUL_PUT} may or may not have taken effect`);
    expect(listener.seen.filter((l) => l === SOUL_PUT), r.detail).toHaveLength(1);
    expect(listener.seen.filter((l) => l.startsWith("PUT /MemoryCandidate/")), r.detail).toHaveLength(0);
  }, 30_000);

  test("rem promote --to soul: an unknown candidate PUT exits 3", async () => {
    const r = await runAgainstListener(PROMOTE_TO_SOUL, CANDIDATE_PUT);
    expect(r.code, r.detail).toBe(3);
    expect(r.stderr, r.detail).toContain(`Unknown outcome: ${CANDIDATE_PUT} may or may not have taken effect`);
    expect(listener.seen.filter((l) => l === SOUL_PUT), r.detail).toHaveLength(1);
    expect(listener.seen.filter((l) => l === CANDIDATE_PUT), r.detail).toHaveLength(1);
  }, 30_000);

  test("rem promote --to memory: an unknown promotion POST exits 3", async () => {
    const r = await runAgainstListener(
      ["rem", "promote", CANDIDATE_ID, "--rationale", "rationale-a", "--to", "memory"],
      PROMOTE_POST,
    );
    expect(r.code, r.detail).toBe(3);
    expect(r.stderr, r.detail).toContain(`Unknown outcome: ${PROMOTE_POST} may or may not have taken effect`);
    expect(listener.seen.filter((l) => l === PROMOTE_POST), r.detail).toHaveLength(1);
  }, 30_000);

  test("rem reject: an unknown candidate PUT exits 3", async () => {
    const r = await runAgainstListener(["rem", "reject", CANDIDATE_ID, "--reason", "reason-a"], CANDIDATE_PUT);
    expect(r.code, r.detail).toBe(3);
    expect(r.stderr, r.detail).toContain(`Unknown outcome: ${CANDIDATE_PUT} may or may not have taken effect`);
    expect(listener.seen.filter((l) => l === CANDIDATE_PUT), r.detail).toHaveLength(1);
  }, 30_000);
});
