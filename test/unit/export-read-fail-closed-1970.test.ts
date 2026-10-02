/**
 * export-read-fail-closed-1970.test.ts — flair#1970 acceptance.
 *
 * `flair export <agent-id>` reads `/Agent/<id>` before anything else. A read
 * that FAILS (transport, 5xx, an unreadable body) is not "not found", and it is
 * not a success: it must refuse with a named remedy, exit non-zero and write
 * nothing. Only a definite 404 is "not found". The id also goes into the path
 * as one encoded segment.
 *
 * Spawns the built CLI (HOME-isolated) against a mock server, so it proves the
 * CLI's own behaviour, not a helper's.
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
// Per-case budget is written as a numeric literal at each case (the spawn-budget gate reads literals).
const CLI_PATH = join(import.meta.dirname ?? __dirname, "..", "..", "dist", "cli.js");
// An id with a reserved character, so the request path proves the encoding.
const AGENT = "agent one/2";

function runCli(args: string[], env: Record<string, string>, cwd: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn("bun", [CLI_PATH, ...args], {
      cwd,
      env: { ...process.env, HOME: env.HOME, FLAIR_AGENT_ID: "", ...env },
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

describe("flair export: a failed Agent read refuses; only 404 is 'not found' (#1970)", () => {
  let scratch: string;
  let server: Server;
  let url: string;
  let status = 500;
  const paths: string[] = [];

  beforeAll(async () => {
    ensureCliBuild();
    scratch = mkdtempSync(join(tmpdir(), "flair-export-1970-home-"));
    await new Promise<void>((resolve) => {
      server = createServer((req: IncomingMessage, res: ServerResponse) => {
        paths.push(req.url ?? "");
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(status === 404 ? { error: "not found" } : { error: "boom" }));
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(scratch, { recursive: true, force: true });
  });

  test("a 5xx Agent read refuses with the failure named — never 'not found'", async () => {
    status = 500;
    paths.length = 0;
    const { stdout, stderr, code } = await runCli(
      ["export", AGENT, "--url", url, "--admin-pass", "test-pass-1970"],
      { HOME: scratch },
      scratch,
    );
    expect(code).not.toBe(0);
    expect(stdout + stderr).not.toContain("not found");
    expect(stderr).toContain("could not read agent");
    // The path carried the id as ONE encoded segment.
    expect(paths).toHaveLength(1);
    expect(paths[0]).toBe(`/Agent/${encodeURIComponent(AGENT)}`);
  }, 25_000);

  test("a 404 Agent read is 'not found' (a definite answer, still non-zero)", async () => {
    status = 404;
    paths.length = 0;
    const { stdout, stderr, code } = await runCli(
      ["export", AGENT, "--url", url, "--admin-pass", "test-pass-1970"],
      { HOME: scratch },
      scratch,
    );
    expect(code).not.toBe(0);
    expect(stderr).toContain("not found");
    expect(paths).toHaveLength(1);
    expect(paths[0]).toBe(`/Agent/${encodeURIComponent(AGENT)}`);
  }, 25_000);
});
