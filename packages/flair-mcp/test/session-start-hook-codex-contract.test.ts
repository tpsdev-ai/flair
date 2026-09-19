import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "../src/session-start-hook.ts";

/**
 * flair#1734 HALF 1 — Codex SessionStart stdout/event contract.
 *
 * Primary sources (do not guess a different schema):
 *   - https://developers.openai.com/codex/hooks  (SessionStart JSON stdout)
 *   - openai/codex `codex-rs/hooks/src/schema.rs`
 *     `SessionStartHookSpecificOutputWire` { hook_event_name, additional_context }
 *   - openai/codex `codex-rs/hooks/src/events/session_start.rs`
 *     parse JSON → additional_context; invalid JSON-looking stdout is a hook
 *     failure; plain text is also accepted as developer context
 *
 * Issue #1734 comment 3 confirmed this payload delivers ambient soul once
 * Codex trusts the hook. A different invented schema would break delivery.
 *
 * These tests pin that documented contract AND require the hook to know it
 * is running under Codex (channel / harness env). The harness-identity half
 * is what fails on main today: `runHook` always bootstraps as `claude-code`.
 */

const ORIGINAL_AGENT_ID = process.env.FLAIR_AGENT_ID;
const ORIGINAL_SESSION_DIR = process.env.FLAIR_SESSION_DIR;
const ORIGINAL_HOOK_HARNESS = process.env.FLAIR_HOOK_HARNESS;

let sessionDir: string;

beforeEach(() => {
  sessionDir = mkdtempSync(join(tmpdir(), "flair-codex-contract-"));
  process.env.FLAIR_SESSION_DIR = sessionDir;
  process.env.FLAIR_AGENT_ID = "gauge";
});

afterEach(() => {
  if (ORIGINAL_AGENT_ID === undefined) delete process.env.FLAIR_AGENT_ID;
  else process.env.FLAIR_AGENT_ID = ORIGINAL_AGENT_ID;
  if (ORIGINAL_SESSION_DIR === undefined) delete process.env.FLAIR_SESSION_DIR;
  else process.env.FLAIR_SESSION_DIR = ORIGINAL_SESSION_DIR;
  if (ORIGINAL_HOOK_HARNESS === undefined) delete process.env.FLAIR_HOOK_HARNESS;
  else process.env.FLAIR_HOOK_HARNESS = ORIGINAL_HOOK_HARNESS;
  rmSync(sessionDir, { recursive: true, force: true });
});

/** Codex SessionStart stdin — official common + SessionStart fields. */
const CODEX_SESSION_START_STDIN = JSON.stringify({
  session_id: "thr_1734",
  transcript_path: null,
  cwd: "/tmp/flair-1734",
  hook_event_name: "SessionStart",
  model: "gpt-5",
  permission_mode: "default",
  source: "startup",
});

const SOUL = "## Identity\n**identity:** Gauge. A named team member.";

describe("Codex SessionStart contract (openai/codex + developers.openai.com/codex/hooks)", () => {
  test("documented JSON stdout is hookSpecificOutput.additionalContext, not a different Codex-only shape", async () => {
    process.env.FLAIR_HOOK_HARNESS = "codex";
    const out = await runHook(CODEX_SESSION_START_STDIN, () => ({
      bootstrap: async () => ({ context: SOUL }),
    }));
    const parsed = JSON.parse(out) as {
      hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
    };
    expect(parsed.hookSpecificOutput).toEqual({
      hookEventName: "SessionStart",
      additionalContext: SOUL,
    });
    expect(out).not.toContain("session_start");
  });

  test("Codex stdin (session_id, source, model, permission_mode) still injects additionalContext", async () => {
    process.env.FLAIR_HOOK_HARNESS = "codex";
    const out = await runHook(CODEX_SESSION_START_STDIN, () => ({
      bootstrap: async () => ({ context: SOUL }),
    }));
    expect(JSON.parse(out).hookSpecificOutput.additionalContext).toBe(SOUL);
  });

  test("when FLAIR_HOOK_HARNESS=codex, bootstrap channel is 'codex' — not hardcoded claude-code", async () => {
    // Fails on main: session-start-hook.ts always passes channel: "claude-code".
    process.env.FLAIR_HOOK_HARNESS = "codex";
    let seenChannel: string | undefined;
    await runHook(CODEX_SESSION_START_STDIN, () => ({
      bootstrap: async (opts) => {
        seenChannel = opts.channel;
        return { context: SOUL };
      },
    }));
    expect(seenChannel).toBe("codex");
  });

  test("default / Claude path is unchanged when harness env is unset", async () => {
    delete process.env.FLAIR_HOOK_HARNESS;
    let seenChannel: string | undefined;
    await runHook(CODEX_SESSION_START_STDIN, () => ({
      bootstrap: async (opts) => {
        seenChannel = opts.channel;
        return { context: SOUL };
      },
    }));
    expect(seenChannel).toBe("claude-code");
  });
});
