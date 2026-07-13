/**
 * workspace-set.test.ts — Unit tests for `flair workspace set` CLI subcommand
 * (coordination write surface / Kris #510).
 *
 * Uses a mock HTTP server. No real Harper instance required. Mirrors
 * presence-set.test.ts. The security-critical assertion: the request carries
 * an Ed25519 Authorization header, and DOES include agentId in the body — but
 * that's a self-declaration the server (WorkspaceState.put()) verifies 1:1
 * against the signature and 403s on mismatch, not a trusted claim (no
 * forging).
 *
 * flair#679: `workspace set` writes via PUT /WorkspaceState/{id} (id in the
 * URL), NOT a bare POST — a real spawned Harper 405s a collection POST to a
 * table-backed resource (see resources/Memory.ts's documented restriction,
 * and test/integration/attention-query-e2e.test.ts, which measured this
 * exact 405 against real Harper). This mock-server suite only proves the
 * CLI's OWN request shape; it cannot catch a 405 (the mock accepts anything)
 * — that's why this bug shipped past unit tests. The real-Harper coverage is
 * test/integration/workspace-orgevent-cli-e2e.test.ts.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { spawn, execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import nacl from "tweetnacl";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `flair-workspace-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;

function startMockServer(handler: Handler): Promise<{ server: Server; url: string; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => handler(req, body, res));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}`, port });
    });
  });
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
}

function jsonRes(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function writeAgentKey(keysDir: string, agentId: string): void {
  const kp = nacl.sign.keyPair();
  const seed = kp.secretKey.slice(0, 32);
  writeFileSync(join(keysDir, `${agentId}.key`), Buffer.from(seed));
  chmodSync(join(keysDir, `${agentId}.key`), 0o600);
}

function runCli(args: string[], env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const cliPath = join(import.meta.dirname ?? __dirname, "..", "..", "dist", "cli.js");
  return new Promise((resolve) => {
    const child = spawn("bun", [cliPath, ...args], {
      env: { ...process.env, ...env },
      stdio: ["inherit", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

describe("flair workspace set", () => {
  let tmpDir: string;
  let keysDir: string;

  beforeAll(() => {
    execSync("bun run build:cli", { stdio: "ignore" });
  });

  beforeEach(() => {
    tmpDir = makeTmpDir();
    keysDir = join(tmpDir, "keys");
    mkdirSync(keysDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rejects missing --ref", async () => {
    const agentId = "test-agent-ws";
    writeAgentKey(keysDir, agentId);
    const { stderr, code } = await runCli(
      ["workspace", "set", "--phase", "design"],
      { FLAIR_AGENT_ID: agentId, FLAIR_KEY_DIR: keysDir, FLAIR_URL: "http://127.0.0.1:99999" },
    );
    expect(code).not.toBe(0);
    expect(stderr).toContain("--ref");
  });

  it("rejects missing agent ID", async () => {
    const { stderr, code } = await runCli(
      ["workspace", "set", "--ref", "main"],
      { FLAIR_KEY_DIR: keysDir, FLAIR_URL: "http://127.0.0.1:99999" },
    );
    expect(code).toBe(1);
    expect(stderr).toContain("agent ID required");
  });

  it("rejects missing private key", async () => {
    const { stderr, code } = await runCli(
      ["workspace", "set", "--ref", "main"],
      { FLAIR_AGENT_ID: "no-key-agent", FLAIR_KEY_DIR: keysDir, FLAIR_URL: "http://127.0.0.1:99999" },
    );
    expect(code).toBe(1);
    expect(stderr).toContain("private key not found");
  });

  it("PUTs to /WorkspaceState/{agentId:ref} with ref/phase/task/agentId/createdAt (#679)", async () => {
    const agentId = "test-agent-ws";
    writeAgentKey(keysDir, agentId);

    const { server, url } = await startMockServer((req, body, res) => {
      expect(req.method).toBe("PUT");
      expect(req.url).toBe(`/WorkspaceState/${agentId}:cp7-coord`);
      const parsed = JSON.parse(body);
      expect(parsed.id).toBe(`${agentId}:cp7-coord`);
      expect(parsed.ref).toBe("cp7-coord");
      expect(parsed.phase).toBe("implement");
      expect(parsed.taskId).toBe("cp7-implement-task");
      // agentId + createdAt are now required in the body: WorkspaceState.put()
      // (unlike post()) does not auto-attribute or default these — it 403s a
      // mismatched agentId rather than overwriting it. Self-declaration, not
      // forging: the server rejects (never accepts) a value that doesn't
      // match the Ed25519 signature's agentId.
      expect(parsed.agentId).toBe(agentId);
      expect(typeof parsed.createdAt).toBe("string");
      jsonRes(res, 200, { id: `${agentId}:cp7-coord`, agentId });
    });

    try {
      const { stdout, code } = await runCli(
        ["workspace", "set", "--ref", "cp7-coord", "--phase", "implement", "--task", "cp7-implement-task"],
        { FLAIR_AGENT_ID: agentId, FLAIR_KEY_DIR: keysDir, FLAIR_URL: url },
      );
      expect(code).toBe(0);
      expect(stdout).toContain("Workspace state updated");
    } finally {
      await stopServer(server);
    }
  });

  it("sends an Ed25519 Authorization header signed by the agent", async () => {
    const agentId = "test-agent-ws";
    writeAgentKey(keysDir, agentId);

    const { server, url } = await startMockServer((req, _body, res) => {
      const authHeader = req.headers["authorization"];
      expect(typeof authHeader).toBe("string");
      expect(authHeader).toMatch(/^TPS-Ed25519\s+/);
      const parts = (authHeader as string).split(" ")[1].split(":");
      // The signing agent id is in the header — this is the attribution source.
      expect(parts[0]).toBe(agentId);
      jsonRes(res, 200, { id: `${agentId}:main`, agentId });
    });

    try {
      const { code } = await runCli(
        ["workspace", "set", "--ref", "main", "--summary", "working"],
        { FLAIR_AGENT_ID: agentId, FLAIR_KEY_DIR: keysDir, FLAIR_URL: url },
      );
      expect(code).toBe(0);
    } finally {
      await stopServer(server);
    }
  });

  it("exits with error on server 5xx", async () => {
    const agentId = "test-agent-ws";
    writeAgentKey(keysDir, agentId);
    const { server, url } = await startMockServer((_req, _body, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "internal_error" }));
    });
    try {
      const { stderr, code } = await runCli(
        ["workspace", "set", "--ref", "main"],
        { FLAIR_AGENT_ID: agentId, FLAIR_KEY_DIR: keysDir, FLAIR_URL: url },
      );
      expect(code).toBe(1);
      expect(stderr).toContain(`PUT /WorkspaceState/${agentId}:main failed`);
    } finally {
      await stopServer(server);
    }
  });
});
