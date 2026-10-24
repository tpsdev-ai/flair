/**
 * rem-restore-duplicate-unknown-2789.test.ts — a snapshot with two rows of the
 * same Memory (or Soul) id (flair#2789).
 *
 * The first PUT of that id ends at the whole-request deadline without a
 * complete response. That write may have landed, so the second row with the
 * same table and record id must not be sent: exactly one PUT for the id, status
 * `unresolved`, exit 3. The built CLI runs against a local HTTP listener with
 * `FLAIR_REQUEST_TIMEOUT_MS` short enough to expire during the first PUT.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCliBuild } from "../helpers/build-cli-once.js";
import { childOverranDeadline, cliLeg } from "../helpers/child-deadline.js";
import { nodeBin } from "../helpers/node-runtime.js";
import { encodeRecordId } from "../../src/lib/record-id-path.js";
import { createSnapshot } from "../../src/rem/snapshot.js";

const CHILD_DEADLINE_MS = 30_000;
const CLI_PATH = join(import.meta.dirname ?? __dirname, "..", "..", "dist", "cli.js");
const AGENT_ID = "agent-a";
const DUP_ID = "dup-row";
const ENCODED = encodeRecordId(DUP_ID);
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
      timeout: CHILD_DEADLINE_MS,
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
  let putsForId = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on("end", () => {
      const path = req.url ?? "/";
      const line = `${req.method} ${path}`;
      seen.push(line);
      if (req.method === "GET" && (path.startsWith("/Memory?") || path.startsWith("/Soul?"))) return sendJson(res, []);
      if (req.method === "GET" && path.startsWith("/AdminMemoryCandidates/")) {
        return sendJson(res, { candidates: [], hasMore: false });
      }
      if (req.method === "PUT" && (path === `/Memory/${ENCODED}` || path === `/Soul/${ENCODED}`)) {
        putsForId++;
        // The first PUT is held forever: the client's deadline decides. Any
        // second PUT would be a retry of an unknown write; answer it so the
        // request log can count it instead of hanging.
        if (putsForId === 1) return;
        return sendJson(res, { ok: true });
      }
      if (req.method === "PUT" || req.method === "DELETE") return sendJson(res, { ok: true });
      return sendJson(res, []);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    server,
    seen,
    port,
    putsForId: () => putsForId,
    reset: () => { seen.length = 0; putsForId = 0; },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

let listener: Awaited<ReturnType<typeof startListener>>;
let home: string;
let passDir: string;

beforeAll(async () => {
  ensureCliBuild();
  home = mkdtempSync(join(tmpdir(), "flair-2789-dup-"));
  mkdirSync(join(home, ".flair"), { recursive: true });
  passDir = mkdtempSync(join(tmpdir(), "flair-2789-dup-pass-"));
  writeFileSync(join(passDir, "admin-pass"), "stub-pass", { mode: 0o600 });
  listener = await startListener();
}, 120_000);

afterAll(async () => {
  if (listener) await listener.close();
  if (home) rmSync(home, { recursive: true, force: true });
  if (passDir) rmSync(passDir, { recursive: true, force: true });
});

async function runCase(snapshotDate: string) {
  listener.reset();
  return runCli(
    ["rem", "restore", snapshotDate, "--agent", AGENT_ID, "--apply", "--admin-pass-file", join(passDir, "admin-pass")],
    { HOME: home, FLAIR_URL: `http://127.0.0.1:${listener.port}`, FLAIR_REQUEST_TIMEOUT_MS: String(DEADLINE_MS), NO_COLOR: "1" },
  );
}

describe("flair#2789 — a duplicate snapshot row after an unknown PUT", () => {
  test("two Memory rows with the same id send exactly one PUT and exit 3", async () => {
    const row = { id: DUP_ID, agentId: AGENT_ID, content: "restored", durability: "persistent" };
    const snapshot = await createSnapshot({
      agentId: AGENT_ID,
      flairVersion: "0.0.0-test",
      memories: [row, row],
      soul: null,
      pendingCandidateCount: 0,
      rootOverride: join(home, ".flair", "snapshots"),
      nowOverride: new Date("2026-01-01T00:00:00.000Z"),
    });
    const result = await runCase(basename(snapshot.path).replace(/\.tar\.gz$/, ""));
    const detail = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
    expect(result.code, detail).toBe(3);
    expect(result.stdout, detail).toContain("Status:       unresolved");
    expect(result.stdout, detail).toContain("Unknown:      1 ids");
    expect(listener.seen.filter((l) => l === `PUT /Memory/${ENCODED}`), detail).toHaveLength(1);
    expect(listener.putsForId(), detail).toBe(1);
  }, 40_000);

  test("two Soul rows with the same id send exactly one PUT and exit 3", async () => {
    const soul = { id: DUP_ID, agentId: AGENT_ID, key: "style", value: "restored" };
    const snapshot = await createSnapshot({
      agentId: AGENT_ID,
      flairVersion: "0.0.0-test",
      memories: [],
      soul: [soul, soul] as unknown as Record<string, unknown>,
      pendingCandidateCount: 0,
      rootOverride: join(home, ".flair", "snapshots"),
      nowOverride: new Date("2026-01-01T01:00:00.000Z"),
    });
    const result = await runCase(basename(snapshot.path).replace(/\.tar\.gz$/, ""));
    const detail = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
    expect(result.code, detail).toBe(3);
    expect(result.stdout, detail).toContain("Status:       unresolved");
    expect(result.stdout, detail).toContain("Unknown:      1 ids");
    expect(listener.seen.filter((l) => l === `PUT /Soul/${ENCODED}`), detail).toHaveLength(1);
    expect(listener.putsForId(), detail).toBe(1);
  }, 40_000);
});
