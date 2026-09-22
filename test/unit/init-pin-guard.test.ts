import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mcpServerSpec, FLAIR_MCP_PACKAGE } from "../../src/lib/mcp-spec.ts";
import { childOverranDeadline } from "../helpers/child-deadline.ts";

/**
 * flair#1778 slice 2c-i-a2 — the init.ts `~/.claude.json` writer never LOWERS
 * a pin.
 *
 * `claude.json` is only written by the inline writer inside `flair init`,
 * which (unlike clients.ts's writers) is not reachable as a function — the
 * wiring block runs after agent registration and needs an ops API. So the
 * fixture drives the real CLI against a stand-in ops/HTTP server, and each case
 * SETS the field in a pre-written ~/.claude.json before the run — a
 * hand-written config is presence, not validity.
 */

const RUNNING_SPEC = mcpServerSpec();
const AHEAD_SPEC = `${FLAIR_MCP_PACKAGE}@9.9.9`;
const BEHIND_SPEC = `${FLAIR_MCP_PACKAGE}@0.0.1`;

const AGENT = "pinbot";

// flair#1807: the child's OWN deadline and a case budget ABOVE it.
const CHILD_DEADLINE_MS = 60_000;
const CASE_BUDGET_MS = 75_000;

let opsPort = 0;
let httpPort = 0;
let servers: Server[] = [];

beforeAll(async () => {
  const handler = (_req: any, res: any) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, status: "ok", id: AGENT }));
  };
  for (const which of ["ops", "http"] as const) {
    const srv = createServer(handler);
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as any).port;
    if (which === "ops") opsPort = port;
    else httpPort = port;
    servers.push(srv);
  }
});

afterAll(() => {
  for (const s of servers) s.close();
  servers = [];
});

let isoHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  isoHome = mkdtempSync(join(tmpdir(), "flair-init-pin-guard-"));
  prevHome = process.env.HOME;
  process.env.HOME = isoHome;
});

afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome;
  else delete process.env.HOME;
  rmSync(isoHome, { recursive: true, force: true });
});

/** Pre-write ~/.claude.json with a specific pin in the flair entry's args. */
function writeClaudeJson(spec: string): string {
  const path = join(isoHome, ".claude.json");
  writeFileSync(path, JSON.stringify({
    numStartups: 3,
    mcpServers: {
      flair: {
        command: "npx",
        args: ["-y", spec],
        env: { FLAIR_URL: `http://127.0.0.1:${httpPort}`, FLAIR_AGENT_ID: AGENT },
      },
    },
  }, null, 2));
  return path;
}

function readClaudeArgs(path: string): string[] {
  return JSON.parse(readFileSync(path, "utf-8")).mcpServers.flair.args;
}

/** Run `flair init` to completion, with its own deadline (never bun's bare timeout). */
function runInit(leg: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [
      "src/cli.ts", "init",
      "--agent", AGENT,
      "--skip-start", "--skip-soul", "--skip-smoke", "--skip-hook", "--skip-claude-md",
      "--client", "claude-code",
      "--port", String(httpPort), "--ops-port", String(opsPort),
      "--admin-pass", "test-admin-pin-guard",
    ], { cwd: ".", env: { ...process.env, HOME: isoHome }, timeout: CHILD_DEADLINE_MS });
    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (err += d.toString()));
    child.on("close", (code, signal) => {
      if (signal !== null) {
        reject(new Error(childOverranDeadline("flair CLI", leg, CHILD_DEADLINE_MS, { status: code, signal, stdout: out, stderr: err })));
        return;
      }
      if (code !== 0) {
        reject(new Error(`flair init (${leg}) exited ${code}; stderr: ${err}`));
        return;
      }
      resolve({ code, stdout: out, stderr: err });
    });
  });
}

describe("init.ts ~/.claude.json writer — the pin is never lowered", () => {
  it("AHEAD of the running CLI → bytes UNCHANGED + a held line", async () => {
    const path = writeClaudeJson(AHEAD_SPEC);
    expect(readClaudeArgs(path)).toContain(AHEAD_SPEC); // (10) genuine fixture
    const before = readFileSync(path, "utf-8");

    const { stdout } = await runInit("claude.json ahead");

    expect(stdout).toContain("holding");
    expect(stdout).toContain("9.9.9");
    expect(readFileSync(path, "utf-8")).toBe(before);
  }, CASE_BUDGET_MS);

  it("range / malformed spec → held, bytes preserved", async () => {
    for (const spec of [`${FLAIR_MCP_PACKAGE}@^0.55.0`, `${FLAIR_MCP_PACKAGE}@v0.55.0`]) {
      const path = writeClaudeJson(spec);
      const before = readFileSync(path, "utf-8");
      const { stdout } = await runInit("claude.json held spec");
      expect(stdout).toContain("holding");
      expect(readFileSync(path, "utf-8")).toBe(before);
    }
  }, CASE_BUDGET_MS);

  it("unpinned → pinned UP to the running CLI", async () => {
    const path = writeClaudeJson(FLAIR_MCP_PACKAGE);
    await runInit("claude.json unpinned");
    expect(readClaudeArgs(path)).toContain(RUNNING_SPEC);
  }, CASE_BUDGET_MS);

  it("BEHIND + newer running CLI → repin UP (positive control)", async () => {
    const path = writeClaudeJson(BEHIND_SPEC);
    expect(readClaudeArgs(path)).toContain(BEHIND_SPEC);
    await runInit("claude.json behind");
    expect(readClaudeArgs(path)).toContain(RUNNING_SPEC);
  }, CASE_BUDGET_MS);
});
