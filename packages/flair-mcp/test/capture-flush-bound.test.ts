import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FlairClient } from "../../flair-client/src/client.ts";
import { flushLockPath, readSpool, runCapture, runCaptureFlush, type CaptureClient } from "../src/capture-spool.ts";

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
 *  reaches it hangs until the client's own deadline fires. */
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

describe("capture flush bounds (flair#2321)", () => {
  test("the flush ends by its deadline and keeps the spool when the server never answers", async () => {
    const stub = await startNeverAnswering();
    try {
      const agent = agentId();
      const env = { FLAIR_AGENT_ID: agent, FLAIR_CAPTURE_DIR: dir };
      expect(runCapture(stop("Decision: prefer host-a for embeddings."), { env, dir }).reason).toBe("appended");
      expect(readSpool(dir, agent)).toHaveLength(1);

      const started = Date.now();
      const outcome = await runCaptureFlush({
        env,
        dir,
        makeClient: () => new FlairClient({ agentId: agent, url: stub.url, keyPath: join(home, "absent.key") }),
        deadlineMs: 500,
      });
      const elapsed = Date.now() - started;

      // The server really was reached (the write hung, it did not fail fast)...
      await stub.sawConnection;
      expect(outcome.flushed).toBe(0);
      // ...and the flush returned by its deadline with the record still staged.
      expect(readSpool(dir, agent)).toHaveLength(1);
      expect(elapsed).toBeLessThan(500 + 3000);
    } finally {
      await stub.close();
    }
  }, 20_000);

  test("a second flush does not run while one is in flight", async () => {
    const stub = await startNeverAnswering();
    try {
      const agent = agentId();
      const env = { FLAIR_AGENT_ID: agent, FLAIR_CAPTURE_DIR: dir };
      expect(runCapture(stop("Decision: prefer host-a for embeddings."), { env, dir }).reason).toBe("appended");

      const first = runCaptureFlush({
        env,
        dir,
        makeClient: () => new FlairClient({ agentId: agent, url: stub.url, keyPath: join(home, "absent.key") }),
        deadlineMs: 500,
      });
      await stub.sawConnection; // the first flush holds the marker and is inside its write

      const rows: unknown[] = [];
      const second = await runCaptureFlush({ env, dir, makeClient: () => recordingClient(rows), deadlineMs: 500 });
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

  test("a live flush marker blocks the flush; a marker whose owner exited does not", async () => {
    const agent = agentId();
    const env = { FLAIR_AGENT_ID: agent, FLAIR_CAPTURE_DIR: dir };
    expect(runCapture(stop("Decision: prefer host-a for embeddings."), { env, dir }).reason).toBe("appended");

    // A live owner (this process) holds the marker: the flush does not start.
    writeFileSync(flushLockPath(dir, agent), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    const busyRows: unknown[] = [];
    const busy = await runCaptureFlush({ env, dir, makeClient: () => recordingClient(busyRows), deadlineMs: 1000 });
    expect(busy.reason).toBe("busy");
    expect(busyRows).toEqual([]);

    // An owner that has exited: the marker is taken over and the flush runs.
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { timeout: 10_000 });
    const deadPid = child.pid!;
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    writeFileSync(flushLockPath(dir, agent), JSON.stringify({ pid: deadPid, startedAt: Date.now() }));

    const rows: unknown[] = [];
    const outcome = await runCaptureFlush({ env, dir, makeClient: () => recordingClient(rows), deadlineMs: 1000 });
    expect(outcome.flushed).toBe(1);
    expect(rows).toHaveLength(1);
    expect(readSpool(dir, agent)).toHaveLength(0);
    // The marker is released with the flush.
    expect(existsSync(flushLockPath(dir, agent))).toBe(false);
  }, 20_000);
});
