/**
 * presence-set.test.ts — Unit tests for `flair presence set` CLI subcommand
 *
 * Uses mock HTTP servers. No real Harper instance required.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { spawn, execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import nacl from "tweetnacl";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = join(tmpdir(), `flair-presence-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function writeAgentKey(keysDir: string, agentId: string): { pubKeyB64url: string } {
  const kp = nacl.sign.keyPair();
  const seed = kp.secretKey.slice(0, 32);
  writeFileSync(join(keysDir, `${agentId}.key`), Buffer.from(seed));
  chmodSync(join(keysDir, `${agentId}.key`), 0o600);
  const pubKeyPath = join(keysDir, `${agentId}.pub`);
  writeFileSync(pubKeyPath, Buffer.from(kp.publicKey));
  return { pubKeyB64url: b64url(kp.publicKey) };
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("flair presence set", () => {
  let tmpDir: string;
  let keysDir: string;

  beforeAll(() => {
    // Ensure dist/cli.js is built. Owns its dependency so this works in any CI job.
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

  it("rejects missing --activity", async () => {
    const agentId = "test-agent-presence";
    writeAgentKey(keysDir, agentId);

    const { stderr, code } = await runCli(
      ["presence", "set", "--task", "hello"],
      { FLAIR_AGENT_ID: agentId, FLAIR_KEY_DIR: keysDir, FLAIR_URL: "http://127.0.0.1:99999" },
    );

    expect(code).toBe(1);
    expect(stderr).toContain("--activity is required");
  });

  it("rejects invalid activity value", async () => {
    const agentId = "test-agent-presence";
    writeAgentKey(keysDir, agentId);

    const { stderr, code } = await runCli(
      ["presence", "set", "--activity", "sleeping", "--task", "napping"],
      { FLAIR_AGENT_ID: agentId, FLAIR_KEY_DIR: keysDir, FLAIR_URL: "http://127.0.0.1:99999" },
    );

    expect(code).toBe(1);
    expect(stderr).toContain("invalid activity");
  });

  it("rejects task exceeding 120 chars", async () => {
    const agentId = "test-agent-presence";
    writeAgentKey(keysDir, agentId);
    const longTask = "a".repeat(121);

    const { stderr, code } = await runCli(
      ["presence", "set", "--activity", "coding", "--task", longTask],
      { FLAIR_AGENT_ID: agentId, FLAIR_KEY_DIR: keysDir, FLAIR_URL: "http://127.0.0.1:99999" },
    );

    expect(code).toBe(1);
    expect(stderr).toContain("120 character limit");
  });

  it("rejects task exactly 121 chars", async () => {
    const agentId = "test-agent-presence";
    writeAgentKey(keysDir, agentId);
    const longTask = "x".repeat(121);

    const { stderr, code } = await runCli(
      ["presence", "set", "--activity", "coding", "--task", longTask],
      { FLAIR_AGENT_ID: agentId, FLAIR_KEY_DIR: keysDir, FLAIR_URL: "http://127.0.0.1:99999" },
    );

    expect(code).toBe(1);
    expect(stderr).toContain("120 character limit");
  });

  it("accepts task exactly 120 chars", async () => {
    const agentId = "test-agent-presence";
    writeAgentKey(keysDir, agentId);
    const exactTask = "x".repeat(120);

    const { server, url } = await startMockServer((req, body, res) => {
      const parsed = JSON.parse(body);
      expect(parsed.activity).toBe("coding");
      expect(parsed.currentTask).toBe(exactTask);
      jsonRes(res, 200, { ok: true, agentId, presenceStatus: "active" });
    });

    try {
      const { stdout, code } = await runCli(
        ["presence", "set", "--activity", "coding", "--task", exactTask],
        { FLAIR_AGENT_ID: agentId, FLAIR_KEY_DIR: keysDir, FLAIR_URL: url },
      );

      expect(code).toBe(0);
      expect(stdout).toContain("Presence updated");
    } finally {
      await stopServer(server);
    }
  });

  it("posts to /Presence with correct activity and task", async () => {
    const agentId = "test-agent-presence";
    writeAgentKey(keysDir, agentId);

    const { server, url } = await startMockServer((req, body, res) => {
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/Presence");

      const parsed = JSON.parse(body);
      expect(parsed.activity).toBe("reviewing");
      expect(parsed.currentTask).toBe("code review on PR #123");
      expect(parsed.agentId).toBeUndefined(); // we don't send agentId in body

      jsonRes(res, 200, { ok: true, agentId, presenceStatus: "active" });
    });

    try {
      const { stdout, code } = await runCli(
        ["presence", "set", "--activity", "reviewing", "--task", "code review on PR #123"],
        { FLAIR_AGENT_ID: agentId, FLAIR_KEY_DIR: keysDir, FLAIR_URL: url },
      );

      expect(code).toBe(0);
      expect(stdout).toContain("Presence updated");
    } finally {
      await stopServer(server);
    }
  });

  it("posts activity-only (no task)", async () => {
    const agentId = "test-agent-presence";
    writeAgentKey(keysDir, agentId);

    const { server, url } = await startMockServer((req, body, res) => {
      const parsed = JSON.parse(body);
      expect(parsed.activity).toBe("idle");
      expect(parsed.currentTask).toBeUndefined();

      jsonRes(res, 200, { ok: true, agentId, presenceStatus: "active" });
    });

    try {
      const { stdout, code } = await runCli(
        ["presence", "set", "--activity", "idle"],
        { FLAIR_AGENT_ID: agentId, FLAIR_KEY_DIR: keysDir, FLAIR_URL: url },
      );

      expect(code).toBe(0);
      expect(stdout).toContain("Presence updated");
    } finally {
      await stopServer(server);
    }
  });

  it("sends Ed25519 Authorization header", async () => {
    const agentId = "test-agent-presence";
    writeAgentKey(keysDir, agentId);

    const { server, url } = await startMockServer((req, _body, res) => {
      const authHeader = req.headers["authorization"];
      expect(authHeader).toBeDefined();
      expect(typeof authHeader).toBe("string");
      expect(authHeader).toMatch(/^TPS-Ed25519\s+/);

      // The auth header should contain the agentId
      const parts = (authHeader as string).split(" ")[1].split(":");
      expect(parts[0]).toBe(agentId);

      jsonRes(res, 200, { ok: true, agentId, presenceStatus: "active" });
    });

    try {
      const { code } = await runCli(
        ["presence", "set", "--activity", "planning", "--task", "architecture review"],
        { FLAIR_AGENT_ID: agentId, FLAIR_KEY_DIR: keysDir, FLAIR_URL: url },
      );

      expect(code).toBe(0);
    } finally {
      await stopServer(server);
    }
  });

  it("exits with error on server 5xx", async () => {
    const agentId = "test-agent-presence";
    writeAgentKey(keysDir, agentId);

    const { server, url } = await startMockServer((_req, _body, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "internal_error" }));
    });

    try {
      const { stderr, code } = await runCli(
        ["presence", "set", "--activity", "coding", "--task", "test"],
        { FLAIR_AGENT_ID: agentId, FLAIR_KEY_DIR: keysDir, FLAIR_URL: url },
      );

      expect(code).toBe(1);
      expect(stderr).toContain("POST /Presence failed");
    } finally {
      await stopServer(server);
    }
  });

  it("rejects missing agent ID", async () => {
    const { stderr, code } = await runCli(
      ["presence", "set", "--activity", "coding"],
      { FLAIR_KEY_DIR: keysDir, FLAIR_URL: "http://127.0.0.1:99999" },
    );

    expect(code).toBe(1);
    expect(stderr).toContain("agent ID required");
  });

  it("rejects missing private key", async () => {
    const agentId = "no-key-agent";

    const { stderr, code } = await runCli(
      ["presence", "set", "--activity", "coding"],
      { FLAIR_AGENT_ID: agentId, FLAIR_KEY_DIR: keysDir, FLAIR_URL: "http://127.0.0.1:99999" },
    );

    expect(code).toBe(1);
    expect(stderr).toContain("private key not found");
  });

  it("supports all valid activity values", async () => {
    const agentId = "test-agent-presence";
    writeAgentKey(keysDir, agentId);

    const { server, url } = await startMockServer((req, body, res) => {
      const parsed = JSON.parse(body);
      jsonRes(res, 200, { ok: true, agentId, activity: parsed.activity, presenceStatus: "active" });
    });

    try {
      for (const activity of ["coding", "reviewing", "planning", "idle"]) {
        const { code, stdout } = await runCli(
          ["presence", "set", "--activity", activity],
          { FLAIR_AGENT_ID: agentId, FLAIR_KEY_DIR: keysDir, FLAIR_URL: url },
        );
        expect(code).toBe(0);
        expect(stdout).toContain(`activity=${activity}`);
      }
    } finally {
      await stopServer(server);
    }
  });
});
