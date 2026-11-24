// cli-memory-add-collision-id-3107.test.ts — flair#3107.
//
// `flair memory add` used to build its Memory id as `${agentId}-${Date.now()}`,
// so two adds by one agent in the same millisecond PUT the same /Memory/<id>
// and the server's upsert keeps a single row.
//
// (1) with a frozen clock, two adds of different content PUT different ids;
// (2) with a frozen clock, two task summaries call the API with different
//     Memory paths;
// (3) a provider-timeout retry replays the SAME id on both attempts.
//
// Cases (1) and (3) spawn the real CLI against a mock HTTP server (pattern of
// cli-memory-add-provider-timeout-retry.test.ts) and record every PUT path.
// Case (2) runs `memory write-task-summary` in-process through Commander with a
// fake `api` and records the paths it is called with.

import { describe, it, expect, beforeAll } from "bun:test";
import { Command } from "commander";
import { bindCli, register } from "../../src/commands/memory.ts";
import { spawn } from "node:child_process";
import { createServer, Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childOverranDeadline } from "../helpers/child-deadline.js";

const CHILD_DEADLINE_MS = 20_000;

type Reply = { status: number; body: string };
type Capture = { method?: string; path?: string; body?: any };

function startMockServer(replies: Reply[]): Promise<{ server: Server; url: string; captures: Capture[] }> {
  const captures: Capture[] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let parsed: any = undefined;
        try { parsed = body ? JSON.parse(body) : undefined; } catch { parsed = body; }
        captures.push({ method: req.method, path: req.url, body: parsed });
        const reply = replies[Math.min(captures.length - 1, replies.length - 1)];
        res.writeHead(reply.status, { "Content-Type": "application/json" });
        res.end(reply.body);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port;
      resolve({ server, url: `http://127.0.0.1:${port}`, captures });
    });
  });
}

let PRELOAD = "";

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "cli-3107-"));
  PRELOAD = join(dir, "freeze-clock.ts");
  writeFileSync(PRELOAD, "const f = Number(process.env.FLAIR_TEST_FROZEN_NOW);\nif (Number.isFinite(f) && f > 0) Date.now = () => f;\n");
});

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  frozen: boolean,
  leg: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const argv = frozen ? ["--preload", PRELOAD, "src/cli.ts", ...args] : ["src/cli.ts", ...args];
    const child = spawn("bun", argv, { cwd: ".", env, timeout: 20_000 });
    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (err += d.toString()));
    child.on("close", (code, signal) => {
      if (signal !== null) {
        reject(
          new Error(
            childOverranDeadline("flair CLI", leg, CHILD_DEADLINE_MS, { status: code, signal, stdout: out, stderr: err, elapsedMs: Date.now() - startedAt, timeoutSignal: "SIGTERM" }),
          ),
        );
        return;
      }
      resolve({ code, stdout: out, stderr: err });
    });
  });
}

function baseEnv(url: string, frozenNow?: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, FLAIR_URL: url, FLAIR_AGENT_ID: "" };
  delete env.TPS_VAULT_KEY;
  delete env.TPS_AGENT_ID;
  if (frozenNow !== undefined) env.FLAIR_TEST_FROZEN_NOW = String(frozenNow);
  return env;
}

function addArgs(content: string): string[] {
  return ["memory", "add", content, "--agent", "agent-a", "--admin-pass", "test-admin"];
}

describe("flair#3107: memory add ids", () => {
  it("two adds of different content in the same frozen millisecond PUT different ids", async () => {
    const { server, url, captures } = await startMockServer([{ status: 200, body: JSON.stringify({ ok: true }) }]);
    try {
      const frozen = Date.now();
      const a = await runCli(addArgs("first distinct memory"), baseEnv(url, frozen), true, "same-ms add 1");
      const b = await runCli(addArgs("second distinct memory"), baseEnv(url, frozen), true, "same-ms add 2");
      expect(a.code).toBe(0);
      expect(b.code).toBe(0);
      expect(captures.length).toBe(2);
      expect(captures[0].body.content).not.toBe(captures[1].body.content);
      expect(captures[1].path).not.toBe(captures[0].path);
      expect(captures[1].body.id).not.toBe(captures[0].body.id);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 30_000);

  it("two task summaries in the same frozen millisecond call the API with different Memory paths (in-process, fake api)", async () => {
    const puts: unknown[][] = [];
    const unused = (): never => { throw new Error("unexpected helper"); };
    bindCli({
      api: async (...args: unknown[]) => { puts.push(args); return {}; },
      resolveSigningAgentId: () => ({ agentId: "agent-a", source: "flag" }),
      addSharedCredentialOptions: (c) => c,
      addSharedIdentityOption: (c) => c,
      resolveBaseUrl: unused,
      resolveOpsPort: unused,
      resolveHttpPort: unused,
      parseEntitiesOptionOrExit: unused,
      ENTITIES_OPTION_DESCRIPTION: "fixture",
      resolveEffectiveOpsUrl: unused,
      resolveFabricCredentials: unused,
    });
    const realNow = Date.now;
    Date.now = () => 1_800_000_000_000;
    try {
      for (const summary of ["first summary", "second summary"]) {
        const program = new Command().exitOverride();
        register(program);
        await program.parseAsync(["memory", "write-task-summary", "--agent", "agent-a", "--outcome", "merged", "--summary", summary], { from: "user" });
      }
    } finally {
      Date.now = realNow;
    }
    expect(puts.length).toBe(2);
    expect(puts[1][1]).not.toBe(puts[0][1]);
  }, 30_000);

  it("a provider-timeout retry replays the same id on both attempts", async () => {
    const { server, url, captures } = await startMockServer([
      { status: 503, body: JSON.stringify({ error: "memory_provider_timeout", message: "nothing was written, retry" }) },
      { status: 200, body: JSON.stringify({ ok: true }) },
    ]);
    try {
      const { code } = await runCli(addArgs("a memory whose first attempt was refused"), baseEnv(url, Date.now()), true, "timeout retry");
      expect(code).toBe(0);
      expect(captures.length).toBe(2);
      expect(captures[1].path).toBe(captures[0].path);
      expect(captures[1].body.id).toBe(captures[0].body.id);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 30_000);
});
