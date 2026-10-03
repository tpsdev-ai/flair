/**
 * capture-hook-entry.test.ts — flair#2068: the `flair-capture` ENTRY POINT,
 * spawned as its own process.
 *
 * The spawned cases check exit 0 and ZERO bytes on stdout and stderr for a
 * Stop payload (a PostToolUse/Stop hook's stdout is harness-interpreted
 * surface), that an error-then-fix sequence stages exactly one candidate, and
 * that a malformed payload stages nothing. No network call is made: the flush
 * is a separate process and needs FLAIR_CAPTURE_FLUSH_SPEC, which these tests
 * omit.
 *
 * Spawns the SOURCE entry, not dist/, for the reason recorded in
 * session-start-hook-probe.test.ts: this lane builds flair-client but never
 * this package, so dist/ is not guaranteed to exist. Hermetic: each test gets
 * its own temp HOME and FLAIR_CAPTURE_DIR inside it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pendingPath, spoolPath } from "../src/capture-spool.ts";

const ENTRY = join(import.meta.dir, "..", "src", "capture-hook.ts");
const CHILD_DEADLINE_MS = 10_000;

let home: string;
let dir: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "flair-2068-entry-home-")));
  dir = join(home, ".flair", "capture");
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function childEnv(): NodeJS.ProcessEnv {
  return { HOME: home, PATH: process.env.PATH, FLAIR_CAPTURE_DIR: dir, FLAIR_AGENT_ID: "agent-a" };
}

function run(payload: unknown): Promise<{ status: number | null; signal: string | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [ENTRY], { env: childEnv(), stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const timer = setTimeout(() => child.kill("SIGKILL"), CHILD_DEADLINE_MS);
  const result = new Promise<{ status: number | null; signal: string | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
  child.stdin.end(JSON.stringify(payload));
  return result.finally(() => {
    clearTimeout(timer);
    child.stdin.destroy();
    child.kill();
  });
}

/** A failed Bash call, in the PostToolUseFailure shape Claude Code 2.1.287 builds. */
function failure(command: string): Record<string, unknown> {
  return {
    session_id: "s1",
    cwd: home,
    hook_event_name: "PostToolUseFailure",
    tool_name: "Bash",
    tool_input: { command },
    tool_use_id: "toolu_01",
    error: "Exit code 1\nError: boom",
    is_interrupt: false,
    duration_ms: 12,
  };
}

function records(): unknown[] {
  try {
    return (JSON.parse(readFileSync(spoolPath(dir, "agent-a"), "utf-8")) as { records?: unknown[] }).records ?? [];
  } catch {
    return [];
  }
}

describe("capture entry point (spawned)", () => {
  test("a decision turn exits 0 with no output and stages one candidate", async () => {
    const res = await run({ hook_event_name: "Stop", session_id: "s1", last_assistant_message: "Decision: prefer host-a for embeddings." });
    expect(res.status).toBe(0);
    expect(res.stderr).toBe("");
    expect(res.stdout).toBe("");
    expect(records().length).toBe(1);
  });

  test("an error-then-fix sequence stages exactly one candidate and no output", async () => {
    const failed = await run(failure("bun test foo"));
    expect(failed.status).toBe(0);
    expect(failed.stdout).toBe("");
    expect(JSON.parse(readFileSync(pendingPath(dir, "agent-a"), "utf-8")).pending.length).toBe(1);

    const fixed = await run({
      session_id: "s1",
      cwd: home,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "bun test foo" },
      tool_use_id: "toolu_02",
      tool_response: { stdout: "1 pass", stderr: "", interrupted: false, isImage: false },
    });
    expect(fixed.status).toBe(0);
    expect(fixed.stdout).toBe("");
    expect(records().length).toBe(1);
  });

  test("concurrent failure hooks each keep their pending error", async () => {
    const commands = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"].map((name) => `${name} run`);
    const results = await Promise.all(commands.map((command) => run(failure(command))));
    for (const res of results) expect(res.status).toBe(0);
    const pending = JSON.parse(readFileSync(pendingPath(dir, "agent-a"), "utf-8")).pending as Array<{ command: string }>;
    expect(pending.map((p) => p.command).sort()).toEqual([...commands].sort());
  });

  test("a malformed payload exits 0 and writes nothing", async () => {
    const child = spawn(process.execPath, [ENTRY], { env: childEnv(), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const result = new Promise<{ status: number | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (status) => resolve({ status }));
    });
    child.stdin.end("{not json");
    const res = await result;
    expect(res.status).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
    expect(records().length).toBe(0);
  });
});
