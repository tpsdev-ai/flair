/**
 * action-recall-hook-entry.test.ts — flair#2067 slice 2: the `flair-action-recall`
 * ENTRY POINT, spawned as its own process, reading a prepared on-disk cache.
 *
 * What only a spawned process can show: the exit code (always 0), that stdout
 * is EXACTLY the `hookSpecificOutput` envelope (never a permission decision or
 * anything else) and that an unrelated command, a missing cache or a held-open
 * stdin produce ZERO bytes — no stdout, no stderr.
 *
 * Spawns the SOURCE entry, not dist/, for the reason recorded in
 * session-start-hook-probe.test.ts: this lane builds flair-client but never
 * this package, so dist/ is not guaranteed to exist.
 *
 * Hermetic: every child gets its own temp HOME and an explicit
 * FLAIR_ACTION_RECALL_DIR inside it; the hook holds no credential and makes no
 * network call.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CACHE_VERSION, encodeBinding, encodeEnvelope, sha256Hex, type CachePayload } from "../src/action-recall.ts";
import { sessionDir } from "../src/action-recall-cache.ts";

const ENTRY = join(import.meta.dir, "..", "src", "action-recall-hook.ts");
const URL = "http://localhost:19926";
const AGENT = "entry-agent";
const SESSION = "entry-session";
const INSTANCE = "entry-instance";
/** Far above any healthy run, so only a hung child hits it. */
const CHILD_DEADLINE_MS = 10_000;

let home: string;
let root: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "flair-2067-entry-home-"));
  root = join(home, ".flair", "action-recall");
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function writeCache(): void {
  const dir = sessionDir(root, URL, AGENT, SESSION);
  const instDir = join(dir, sha256Hex(INSTANCE));
  mkdirSync(instDir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  chmodSync(instDir, 0o700);
  const now = Date.now();
  const payload: CachePayload = {
    v: CACHE_VERSION,
    url: URL,
    principal: AGENT,
    session: SESSION,
    instance: INSTANCE,
    generation: "gen-1",
    refreshStart: now,
    expiry: now + 5 * 60 * 1000,
    entries: [
      {
        id: "mem-entry-1",
        owner: AGENT,
        createdAt: "2026-10-01T00:00:00.000Z",
        triggers: [{ verb: "git", subcommands: ["push"], flags: ["--force"], paths: [] }],
        excerpt: "force push the release branch after the lane passes",
        safetyFlags: [],
      },
    ],
  };
  writeFileSync(join(instDir, "gen-1.json"), encodeEnvelope(payload), { mode: 0o600 });
  writeFileSync(
    join(dir, "current.json"),
    encodeBinding({ v: CACHE_VERSION, url: URL, principal: AGENT, session: SESSION, instance: INSTANCE, generation: "gen-1" }),
    { mode: 0o600 },
  );
}

function childEnv(): NodeJS.ProcessEnv {
  return {
    HOME: home,
    PATH: process.env.PATH,
    FLAIR_ACTION_RECALL_DIR: root,
    FLAIR_AGENT_ID: AGENT,
    FLAIR_URL: URL,
  };
}

function run(command: string, opts: { holdOpen?: boolean } = {}) {
  const input = JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: "/repo", session_id: SESSION });
  return spawnSync(process.execPath, [ENTRY], {
    input: opts.holdOpen ? "" : input,
    env: childEnv(),
    encoding: "utf8",
    timeout: CHILD_DEADLINE_MS,
  });
}

describe("action-recall entry point (spawned)", () => {
  test("a matching Bash command emits exactly the context-only envelope with the lesson id", () => {
    writeCache();
    const res = run("git push --force origin main");
    expect(res.status).toBe(0);
    expect(res.stderr).toBe("");
    const parsed = JSON.parse(res.stdout);
    expect(Object.keys(parsed)).toEqual(["hookSpecificOutput"]);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("mem-entry-1");
    // Context only: no permission decision, no input rewrite, no question.
    expect(parsed.hookSpecificOutput).not.toHaveProperty("permissionDecision");
    expect(parsed.hookSpecificOutput).not.toHaveProperty("updatedInput");
  });

  test("an unrelated command is silent (zero bytes, exit 0)", () => {
    writeCache();
    const res = run("git status");
    expect(res.status).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toBe("");
  });

  test("a missing cache and a non-Bash tool are silent (zero bytes, exit 0)", () => {
    const missing = run("git push --force origin main");
    expect(missing.status).toBe(0);
    expect(missing.stdout).toBe("");
    const nonBash = spawnSync(process.execPath, [ENTRY], {
      input: JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/x" }, session_id: SESSION }),
      env: childEnv(),
      encoding: "utf8",
      timeout: CHILD_DEADLINE_MS,
    });
    expect(nonBash.status).toBe(0);
    expect(nonBash.stdout).toBe("");
    expect(nonBash.stderr).toBe("");
  });
});
