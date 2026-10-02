/**
 * principal-disable-remote-2114.test.ts — flair#2114.
 *
 * `flair principal disable` gains a remote target (`--target`/`--ops-target`,
 * the shape `flair init` / `flair agent add` use). The remote path sends the
 * same ops `update` to the derived ops API; a remote target requires an
 * explicit `--admin-pass` (the local env/file credentials are never sent to
 * another instance); a request that fails, or a target that rejects it,
 * refuses with a named remedy and a non-zero exit. The local path still
 * targets `127.0.0.1` at `--ops-port`.
 *
 * Spawns the built CLI (HOME-isolated) against a mock operations API on an
 * OS-assigned port.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureCliBuild } from "../helpers/build-cli-once.js";
import { childOverranDeadline, cliLeg } from "../helpers/child-deadline.js";

const CHILD_DEADLINE_MS = 20_000;
const CLI_PATH = join(import.meta.dirname ?? __dirname, "..", "..", "dist", "cli.js");

interface Observed { method: string; url: string; authorization: string; body: string }

function runCli(args: string[], env: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn("bun", [CLI_PATH, ...args], {
      cwd: env.HOME,
      env: { ...process.env, FLAIR_AGENT_ID: "", FLAIR_URL: "", FLAIR_OPS_PORT: "", FLAIR_TARGET: "", FLAIR_OPS_TARGET: "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000, // literal so the spawn-budget gate sees a deadline (flair#1807)
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

function startStub(): Promise<{ server: Server; url: string; port: number; seen: Observed[]; status: () => number; setStatus: (n: number) => void }> {
  let status = 200;
  const seen: Observed[] = [];
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ method: req.method ?? "", url: req.url ?? "", authorization: String(req.headers.authorization ?? ""), body });
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(status === 200 ? "[]" : JSON.stringify({ error: "denied" }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}`, port, seen, status: () => status, setStatus: (n) => { status = n; } });
    });
  });
}

async function closedPort(): Promise<number> {
  const s = await startStub();
  const p = s.port;
  await new Promise<void>((r) => s.server.close(() => r()));
  return p;
}

describe("flair principal disable: remote target (#2114)", () => {
  let scratch: string;
  let stub: Awaited<ReturnType<typeof startStub>>;

  beforeAll(async () => {
    ensureCliBuild();
    scratch = mkdtempSync(join(tmpdir(), "flair-2114-home-"));
    stub = await startStub();
  });

  afterAll(async () => {
    await new Promise<void>((r) => stub.server.close(() => r()));
    rmSync(scratch, { recursive: true, force: true });
  });

  test("remote: sends the ops update to the target's ops API and reports success", async () => {
    stub.seen.length = 0;
    stub.setStatus(200);
    const { stdout, stderr, code } = await runCli(
      ["principal", "disable", "alice", "--ops-target", stub.url, "--admin-pass", "target-pass-2114"],
      { HOME: scratch },
    );
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout).toContain("Principal 'alice' deactivated");
    expect(stub.seen).toHaveLength(1);
    expect(stub.seen[0].method).toBe("POST");
    expect(stub.seen[0].url).toBe("/");
    expect(stub.seen[0].authorization.startsWith("Basic ")).toBe(true);
    const body = JSON.parse(stub.seen[0].body);
    expect(body).toMatchObject({ operation: "update", database: "flair", table: "Agent" });
    expect(body.records[0]).toMatchObject({ id: "alice", status: "deactivated" });
  }, 25_000);

  test("local: still targets 127.0.0.1 at --ops-port, unchanged", async () => {
    stub.seen.length = 0;
    stub.setStatus(200);
    const { stdout, code } = await runCli(
      ["principal", "disable", "bob", "--ops-port", String(stub.port), "--admin-pass", "local-pass-2114"],
      { HOME: scratch },
    );
    expect(code).toBe(0);
    expect(stdout).toContain("Principal 'bob' deactivated");
    expect(stub.seen).toHaveLength(1);
    expect(stub.seen[0].url).toBe("/");
    expect(JSON.parse(stub.seen[0].body).records[0].id).toBe("bob");
  }, 25_000);

  test("remote: an auth failure refuses with a named remedy and exits non-zero", async () => {
    stub.seen.length = 0;
    stub.setStatus(401);
    const { stdout, stderr, code } = await runCli(
      ["principal", "disable", "alice", "--ops-target", stub.url, "--admin-pass", "wrong-pass"],
      { HOME: scratch },
    );
    expect(code).not.toBe(0);
    expect(stdout + stderr).not.toContain("deactivated");
    expect(stderr).toContain("refused the update (HTTP 401)");
    expect(stderr).toContain("--admin-pass");
    stub.setStatus(200);
  }, 25_000);

  test("remote: a local env credential is never sent — no --admin-pass refuses", async () => {
    stub.seen.length = 0;
    const { stdout, stderr, code } = await runCli(
      ["principal", "disable", "alice", "--ops-target", stub.url],
      { HOME: scratch, FLAIR_ADMIN_PASS: "this-machines-secret" },
    );
    expect(code).not.toBe(0);
    expect(stderr).toContain("required for a remote target");
    expect(stdout + stderr).not.toContain("deactivated");
    // No request reached the target at all.
    expect(stub.seen).toHaveLength(0);
  }, 25_000);

  test("remote: an unreachable target refuses with a named remedy and exits non-zero", async () => {
    const port = await closedPort();
    const { stdout, stderr, code } = await runCli(
      ["principal", "disable", "alice", "--ops-target", `http://127.0.0.1:${port}`, "--admin-pass", "target-pass-2114"],
      { HOME: scratch },
    );
    expect(code).not.toBe(0);
    expect(stdout + stderr).not.toContain("deactivated");
    expect(stderr).toContain("could not reach the operations API");
  }, 25_000);
});
