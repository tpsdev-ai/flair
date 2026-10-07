import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FlairClient } from "../../flair-client/src/client.ts";
import { CAPTURE_VERSION } from "../src/capture.ts";
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
  'fs.writeFileSync(process.env.LOCK_FILE, JSON.stringify({ pid: process.pid, nonce: require("node:crypto").randomUUID() }), { flag: "wx", mode: 0o600 });',
  'process.stdout.write("held\\n");',
  "setInterval(() => {}, 1000);",
].join("\n");

describe("capture flush bounds (flair#2321)", () => {
  test("a live holder keeps an aged lock during flush and capture", async () => {
    const agent = agentId();
    const env = { FLAIR_AGENT_ID: agent, FLAIR_CAPTURE_DIR: dir };
    runCapture(stop("Decision: prefer host-a."), { env, dir });
    let finish!: () => void;
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const first = runCaptureFlush({ env, dir, makeClient: () => ({ request: async () => {
      entered();
      await new Promise<void>((resolve) => { finish = resolve; });
      return {};
    } }) });
    await inside;
    try {
      const old = new Date(Date.now() - CAPTURE_LOCK_STALE_MS - 1000);
      utimesSync(lockPath(dir, agent), old, old);
      const rows: unknown[] = [];
      expect((await runCaptureFlush({ env, dir, makeClient: () => recordingClient(rows) })).reason).toBe("busy");
      expect(rows).toEqual([]);
      expect(runCapture(stop("Decision: prefer host-b."), { env, dir }).reason).toBe("refused");
    } finally {
      finish();
      await first;
    }
  });

  test("a holder's release keeps a replacement lock", async () => {
    const agent = agentId();
    const env = { FLAIR_AGENT_ID: agent, FLAIR_CAPTURE_DIR: dir };
    runCapture(stop("Decision: prefer host-a."), { env, dir });
    const replacement = JSON.stringify({ pid: process.pid, nonce: "replacement" });
    await runCaptureFlush({ env, dir, makeClient: () => ({ request: async () => {
      unlinkSync(lockPath(dir, agent));
      writeFileSync(lockPath(dir, agent), replacement, { flag: "wx", mode: 0o600 });
      return {};
    } }) });
    expect(readFileSync(lockPath(dir, agent), "utf8")).toBe(replacement);
    expect(readSpool(dir, agent)).toHaveLength(1);
  });

  test("a heartbeat failure aborts the write and leaves the spool", async () => {
    const agent = agentId();
    const env = { FLAIR_AGENT_ID: agent, FLAIR_CAPTURE_DIR: dir };
    runCapture(stop("Decision: prefer host-a."), { env, dir });
    let signal: AbortSignal | undefined;
    const started = Date.now();
    const outcome = await runCaptureFlush({ env, dir, deadlineMs: 3000, makeClient: () => ({
      request: async (_method, _path, _row, opts) => {
        signal = opts?.signal;
        unlinkSync(lockPath(dir, agent));
        return await new Promise<never>(() => {});
      },
    }) });
    expect(outcome.reason).toBe("write-failed");
    expect(signal?.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(readSpool(dir, agent)).toHaveLength(1);
    expect(existsSync(lockPath(dir, agent))).toBe(false);
  }, 10_000);

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
      // The margin includes lock release.
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

  test("a mixed spool keeps a foreign record with the same dedup key", async () => {
    const agent = agentId();
    const env = { FLAIR_AGENT_ID: agent, FLAIR_CAPTURE_DIR: dir };
    expect(runCapture(stop("Decision: prefer host-a for embeddings."), { env, dir }).reason).toBe("appended");
    const local = readSpool(dir, agent)[0]!;
    expect(runCapture(stop("Decision: prefer host-a for embeddings."), {
      env: { ...env, FLAIR_AGENT_ID: "agent-b" }, dir,
    }).reason).toBe("appended");
    const foreign = readSpool(dir, "agent-b")[0]!;
    expect(foreign.dedupKey).toBe(local.dedupKey);
    const invalid = { ...local, kind: "unknown" };
    writeFileSync(spoolPath(dir, agent), JSON.stringify({ v: CAPTURE_VERSION, agentId: agent, records: [local, foreign, invalid] }));

    const rows: unknown[] = [];
    const outcome = await runCaptureFlush({ env, dir, makeClient: () => recordingClient(rows) });
    expect(outcome.flushed).toBe(1);
    expect(rows).toHaveLength(1);

    const after = (JSON.parse(readFileSync(spoolPath(dir, agent), "utf-8")) as { records: unknown[] }).records;
    expect(after).toEqual([foreign, invalid]);
  }, 20_000);

  test("a killed lock-holder helper leaves a lock that the next flush reclaims", async () => {
    const agent = agentId();
    const env = { FLAIR_AGENT_ID: agent, FLAIR_CAPTURE_DIR: dir };
    expect(runCapture(stop("Decision: prefer host-a for embeddings."), { env, dir }).reason).toBe("appended");

    // Kill a lock-holder helper.
    const lock = lockPath(dir, agent);
    const child = spawn(process.execPath, ["-e", HOLD_LOCK_SCRIPT], { env: { ...process.env, LOCK_FILE: lock }, timeout: 10_000 });
    await new Promise<void>((resolve, reject) => {
      child.stdout.once("data", () => resolve());
      child.once("error", reject);
    });
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    expect(existsSync(lock)).toBe(true);

    const rows: unknown[] = [];
    const outcome = await runCaptureFlush({ env, dir, makeClient: () => recordingClient(rows), deadlineMs: 1000 });
    expect(outcome.flushed).toBe(1);
    expect(rows).toHaveLength(1);
    expect(readSpool(dir, agent)).toHaveLength(0);
    expect(existsSync(lock)).toBe(false);
  }, 20_000);
});
