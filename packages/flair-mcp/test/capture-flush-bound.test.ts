import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FlairClient } from "../../flair-client/src/client.ts";
import { CAPTURE_VERSION, captureHash } from "../src/capture.ts";
import { CAPTURE_LOCK_STALE_MS, lockPath, readSpool, runCapture, runCaptureFlush, spoolPath, type CaptureClient } from "../src/capture-spool.ts";

let home: string;
let dir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "flair-2321-flush-home-"));
  dir = join(home, ".flair", "capture");
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** A neutral, non-default agent id unique to each case, so no on-disk key can resolve. */
function agentId(): string {
  return `agent-${Math.random().toString(36).slice(2, 10)}`;
}

function stop(text: string): string {
  return JSON.stringify({ hook_event_name: "Stop", session_id: "s1", last_assistant_message: text });
}

function recordingClient(rows: unknown[]): CaptureClient {
  return { request: async (_method, _path, body) => { rows.push(body); return {}; } };
}

interface Stub {
  url: string;
  /** Resolves when the server has accepted its first connection. */
  sawConnection: Promise<void>;
  close: () => Promise<void>;
}

/** A TCP server that accepts connections and never answers: a request that
 *  reaches it hangs until the flush's own deadline aborts it. */
async function startNeverAnswering(): Promise<Stub> {
  const sockets = new Set<Socket>();
  let seen!: () => void;
  const sawConnection = new Promise<void>((resolve) => { seen = resolve; });
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    seen();
  });
  server.on("error", () => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    sawConnection,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Holds the per-agent lock at LOCK_FILE, then idles; the parent kills it so the
 *  lock is left behind the way a crashed flush leaves it. */
const HOLD_LOCK_SCRIPT = [
  'const fs = require("node:fs");',
  'fs.closeSync(fs.openSync(process.env.LOCK_FILE, "wx", 0o600));',
  'process.stdout.write("held\\n");',
  "setInterval(() => {}, 1000);",
].join("\n");

describe("capture flush bounds (flair#2321)", () => {
  test("a flush whose deadline expires returns by the deadline plus a small margin and keeps the record", async () => {
    const stub = await startNeverAnswering();
    try {
      const agent = agentId();
      const env = { FLAIR_AGENT_ID: agent, FLAIR_CAPTURE_DIR: dir };
      expect(runCapture(stop("Decision: prefer host-a for embeddings."), { env, dir }).reason).toBe("appended");

      const deadlineMs = 500;
      const started = Date.now();
      const outcome = await runCaptureFlush({
        env,
        dir,
        makeClient: () => new FlairClient({ agentId: agent, url: stub.url, keyPath: join(home, "absent.key") }),
        deadlineMs,
      });
      const elapsed = Date.now() - started;

      // The server really was reached (the write hung, it did not fail fast)...
      await stub.sawConnection;
      expect(outcome.flushed).toBe(0);
      // ...and the flush returned by its deadline (plus a small margin for the
      // local rewrite) with the record still staged.
      expect(readSpool(dir, agent)).toHaveLength(1);
      expect(elapsed).toBeLessThan(deadlineMs + 500);
    } finally {
      await stub.close();
    }
  }, 20_000);

  test("exactly one of two concurrent flushes runs; the other returns busy", async () => {
    const stub = await startNeverAnswering();
    try {
      const agent = agentId();
      const env = { FLAIR_AGENT_ID: agent, FLAIR_CAPTURE_DIR: dir };
      expect(runCapture(stop("Decision: prefer host-a for embeddings."), { env, dir }).reason).toBe("appended");

      const first = runCaptureFlush({
        env,
        dir,
        makeClient: () => new FlairClient({ agentId: agent, url: stub.url, keyPath: join(home, "absent.key") }),
        deadlineMs: 800,
      });
      // The first flush is inside its write and holds the per-agent lock.
      await stub.sawConnection;
      expect(existsSync(lockPath(dir, agent))).toBe(true);

      const rows: unknown[] = [];
      const second = await runCaptureFlush({ env, dir, makeClient: () => recordingClient(rows), deadlineMs: 800 });
      expect(second.reason).toBe("busy");
      expect(rows).toEqual([]);
      expect(readSpool(dir, agent)).toHaveLength(1);

      const outcome = await first;
      expect(outcome.flushed).toBe(0);
      expect(readSpool(dir, agent)).toHaveLength(1);
    } finally {
      await stub.close();
    }
  }, 20_000);

  test("a mixed spool keeps the foreign record after the rewrite", async () => {
    const agent = agentId();
    const env = { FLAIR_AGENT_ID: agent, FLAIR_CAPTURE_DIR: dir };
    expect(runCapture(stop("Decision: prefer host-a for embeddings."), { env, dir }).reason).toBe("appended");
    const local = readSpool(dir, agent)[0]!;
    const foreign = {
      ...local,
      agentId: "agent-b",
      content: "Decision: prefer host-b for search.",
      dedupKey: captureHash("foreign"),
    };
    writeFileSync(spoolPath(dir, agent), JSON.stringify({ v: CAPTURE_VERSION, agentId: agent, records: [local, foreign] }));

    const rows: unknown[] = [];
    const outcome = await runCaptureFlush({ env, dir, makeClient: () => recordingClient(rows) });
    expect(outcome.flushed).toBe(1);
    expect(rows).toHaveLength(1);

    // The flushed local record is gone; the foreign record is kept, exactly once.
    const after = (JSON.parse(readFileSync(spoolPath(dir, agent), "utf-8")) as { records: unknown[] }).records;
    expect(after).toEqual([foreign]);
  }, 20_000);

  test("a crashed flush does not block the next one beyond the lock's stale rule", async () => {
    const agent = agentId();
    const env = { FLAIR_AGENT_ID: agent, FLAIR_CAPTURE_DIR: dir };
    expect(runCapture(stop("Decision: prefer host-a for embeddings."), { env, dir }).reason).toBe("appended");

    // A flush process takes the per-agent lock and is killed while holding it,
    // leaving the lock behind.
    const lock = lockPath(dir, agent);
    const child = spawn(process.execPath, ["-e", HOLD_LOCK_SCRIPT], { env: { ...process.env, LOCK_FILE: lock }, timeout: 10_000 });
    await new Promise<void>((resolve, reject) => {
      child.stdout.once("data", () => resolve());
      child.once("error", reject);
    });
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    expect(existsSync(lock)).toBe(true);

    // A fresh leftover lock blocks the next flush...
    const blocked: unknown[] = [];
    const busy = await runCaptureFlush({ env, dir, makeClient: () => recordingClient(blocked), deadlineMs: 1000 });
    expect(busy.reason).toBe("busy");
    expect(blocked).toEqual([]);

    // ...and once it is stale the same rule the hot path uses reclaims it.
    const old = new Date(Date.now() - (CAPTURE_LOCK_STALE_MS + 1000));
    utimesSync(lock, old, old);
    const rows: unknown[] = [];
    const outcome = await runCaptureFlush({ env, dir, makeClient: () => recordingClient(rows), deadlineMs: 1000 });
    expect(outcome.flushed).toBe(1);
    expect(rows).toHaveLength(1);
    expect(readSpool(dir, agent)).toHaveLength(0);
    expect(existsSync(lock)).toBe(false);
  }, 20_000);
});
