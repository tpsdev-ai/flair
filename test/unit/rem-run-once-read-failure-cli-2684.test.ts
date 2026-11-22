/**
 * flair#2684 — the built `flair rem nightly run-once` against a local HTTP
 * listener: when the Memory or the Soul read fails, that count prints as
 * `unknown (<reason>)`, the other read prints its exact count, the failed read
 * is named under `Errors:`, and the process exits 1.
 *
 * FLAIR_URL names this file's listener on 127.0.0.1, the child HOME is a
 * scratch dir, and the child env carries no FLAIR_* or HDB_* variable this
 * file does not set.
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

const CHILD_DEADLINE_MS = 20_000;
const CLI_PATH = join(import.meta.dirname ?? __dirname, "..", "..", "dist", "cli.js");
const AGENT_ID = "agent-a";

type Read = { status: number; body: string };
const ok = (rows: unknown[]): Read => ({ status: 200, body: JSON.stringify(rows) });
const fail = (text: string): Read => ({ status: 503, body: text });

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

async function startListener() {
  const seen: string[] = [];
  let reads: { memory: Read; soul: Read } = { memory: ok([]), soul: ok([]) };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on("end", () => {
      const line = `${req.method} ${req.url}`;
      seen.push(line);
      const send = (r: Read) => {
        res.writeHead(r.status, { "Content-Type": r.status === 200 ? "application/json" : "text/plain" });
        res.end(r.body);
      };
      if (line === "GET /Health") return send(ok([]));
      if (line === `GET /Memory?agentId=${AGENT_ID}`) return send(reads.memory);
      if (line === `GET /Soul?agentId=${AGENT_ID}`) return send(reads.soul);
      send({ status: 404, body: `no route for ${line}` });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, seen, port, setReads: (r: typeof reads) => { reads = r; } };
}

let listener: Awaited<ReturnType<typeof startListener>>;
let home: string;

describe("flair#2684 — built CLI run-once with one failed read", () => {
  beforeAll(async () => {
    ensureCliBuild();
    home = mkdtempSync(join(tmpdir(), "flair-2684-cli-"));
    const keysDir = join(home, ".flair", "keys");
    mkdirSync(keysDir, { recursive: true });
    const kp = nacl.sign.keyPair();
    writeFileSync(join(keysDir, `${AGENT_ID}.key`), Buffer.from(kp.secretKey.slice(0, 32)), { mode: 0o600 });
    listener = await startListener();
  }, 120_000);

  afterAll(async () => {
    if (listener) {
      listener.server.closeAllConnections();
      await new Promise<void>((resolve) => listener.server.close(() => resolve()));
    }
    if (home) rmSync(home, { recursive: true, force: true });
  });

  const cases = [
    {
      name: "a failed Memory read prints unknown, the Soul read prints its count",
      reads: { memory: fail("memory store unavailable"), soul: ok([{ id: `${AGENT_ID}:style`, key: "style" }]) },
      memoriesLine: "Memories:   unknown (HTTP 503: memory store unavailable)",
      soulsLine: "Souls:      1",
      error: "  - memory-count: HTTP 503: memory store unavailable",
    },
    {
      name: "a failed Soul read prints unknown, the Memory read prints its count",
      reads: { memory: ok([{ id: "m1" }, { id: "m2" }]), soul: fail("soul store unavailable") },
      memoriesLine: "Memories:   2",
      soulsLine: "Souls:      unknown (HTTP 503: soul store unavailable)",
      error: "  - soul-count: HTTP 503: soul store unavailable",
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      listener.seen.length = 0;
      listener.setReads(c.reads);
      const result = await runCli(
        ["rem", "nightly", "run-once", "--agent", AGENT_ID, "--dry-run"],
        { HOME: home, FLAIR_URL: `http://127.0.0.1:${listener.port}` },
      );
      const lines = result.stdout.split("\n");
      const detail = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
      expect(listener.seen, detail).toEqual([
        "GET /Health",
        `GET /Memory?agentId=${AGENT_ID}`,
        `GET /Soul?agentId=${AGENT_ID}`,
      ]);
      expect(lines, detail).toContain("Status:     failed");
      expect(lines, detail).toContain(c.memoriesLine);
      expect(lines, detail).toContain(c.soulsLine);
      const errorsAt = lines.indexOf("Errors:");
      expect(errorsAt, detail).toBeGreaterThan(-1);
      const errorLines: string[] = [];
      for (const l of lines.slice(errorsAt + 1)) {
        if (!l.startsWith("  - ")) break;
        errorLines.push(l);
      }
      expect(errorLines, detail).toEqual([c.error]);
      expect(result.code, detail).toBe(1);
    }, 30_000);
  }
});
