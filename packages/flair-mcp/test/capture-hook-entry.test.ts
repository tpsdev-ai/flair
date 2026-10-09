import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installCapturePackage } from "../../../test/helpers/capture-package.ts";
import { CAPTURE_LOCK_WAIT_MS, lockPath, pendingPath, spoolPath } from "../src/capture-spool.ts";

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

/** The pending error commands, or [] when the file is absent, so the assertion is
 *  what fails rather than the read. */
function pendingCommands(): string[] {
  try {
    return (JSON.parse(readFileSync(pendingPath(dir, "agent-a"), "utf-8")) as { pending: Array<{ command: string }> }).pending.map((p) => p.command);
  } catch {
    return [];
  }
}

describe("capture entry point (spawned)", () => {
  test("a cue-matching turn exits 0 with no output and stages one candidate", async () => {
    const res = await run({ hook_event_name: "Stop", session_id: "s1", last_assistant_message: "Decision: prefer host-a for embeddings." });
    expect(res.status).toBe(0);
    expect(res.stderr).toBe("");
    expect(res.stdout).toBe("");
    expect(records().length).toBe(1);
  });

  test("a failed call and matching success stage exactly one candidate and no output", async () => {
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

  test("a failure hook keeps its pending error when the append lock is held past the spool wait", async () => {
    // Hold the per-agent append lock as a live owner, then release it while the
    // hook is still waiting: the hook must keep the error rather than refuse
    // after CAPTURE_LOCK_WAIT_MS (flair#2395).
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const lock = lockPath(dir, "agent-a");
    writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce: "held-for-2395" }), { flag: "wx", mode: 0o600 });
    const pending = run(failure("bun test foo"));
    try {
      await new Promise((resolve) => setTimeout(resolve, CAPTURE_LOCK_WAIT_MS + 400));
      unlinkSync(lock);
      const res = await pending;
      expect(res.status).toBe(0);
      // The error is kept, not refused.
      expect(pendingCommands()).toEqual(["bun test foo"]);
      // No refusal, so nothing is reported on stderr.
      expect(res.stderr).toBe("");
    } finally {
      // The hook acquires and releases the same lock path once it proceeds.
      try { unlinkSync(lock); } catch { /* already released */ }
    }
  }, 20_000);

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
  test("the packed flair-capture bin handles --flush without reading a Stop payload", () => {
    const fixture = installCapturePackage(home);
    execFileSync("npx", ["--offline", "-y", "-p", fixture.spec, "flair-capture", "--flush"], {
      cwd: fixture.cwd,
      env: { ...fixture.env, FLAIR_AGENT_ID: "agent-a", FLAIR_CAPTURE_DIR: dir },
      input: JSON.stringify({ hook_event_name: "Stop", last_assistant_message: "Decision: prefer host-a for embeddings." }),
      timeout: 10_000, stdio: ["pipe", "pipe", "pipe"],
    });
    expect(existsSync(spoolPath(dir, "agent-a"))).toBe(false);
  }, 120_000);

});
