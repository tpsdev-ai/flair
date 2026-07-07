import { describe, test, expect, afterEach } from "bun:test";
import { runHook } from "../src/session-start-hook.ts";

/**
 * SessionStart hook tests — validate the no-op-on-any-failure guarantee and
 * the happy-path output shape, with a stubbed bootstrap client so the tests
 * never depend on a live Flair daemon.
 *
 * `runHook(rawInput, makeClient)` is the pure core: it reads FLAIR_AGENT_ID
 * from env, parses the stdin payload, calls the injected client's bootstrap(),
 * and returns the exact string the binary prints to stdout. It NEVER throws.
 */

const MAX_CHARS = 10_000;
const NOOP = "{}";

const ORIGINAL_AGENT_ID = process.env.FLAIR_AGENT_ID;

afterEach(() => {
  if (ORIGINAL_AGENT_ID === undefined) delete process.env.FLAIR_AGENT_ID;
  else process.env.FLAIR_AGENT_ID = ORIGINAL_AGENT_ID;
});

const SAMPLE_INPUT = JSON.stringify({
  cwd: "/Users/dev/project-x",
  source: "startup",
  session_id: "abc123",
});

/** A client factory that should never be called (asserts the no-op short-circuits). */
function failIfCalled(): never {
  throw new Error("client factory should not be called");
}

describe("session-start hook", () => {
  describe("no-op guarantees", () => {
    test("no FLAIR_AGENT_ID → outputs {} and never builds a client", async () => {
      delete process.env.FLAIR_AGENT_ID;
      const out = await runHook(SAMPLE_INPUT, failIfCalled);
      expect(out).toBe(NOOP);
    });

    test("unreachable flair (bootstrap rejects) → outputs {}, never throws", async () => {
      process.env.FLAIR_AGENT_ID = "test-agent";
      const out = await runHook(SAMPLE_INPUT, () => ({
        bootstrap: async () => {
          throw new TypeError("fetch failed"); // simulate connection error
        },
      }));
      expect(out).toBe(NOOP);
    });

    test("auth error (bootstrap rejects) → outputs {}", async () => {
      process.env.FLAIR_AGENT_ID = "test-agent";
      const out = await runHook(SAMPLE_INPUT, () => ({
        bootstrap: async () => {
          const e = new Error("401 invalid_signature");
          throw e;
        },
      }));
      expect(out).toBe(NOOP);
    });

    test("empty / whitespace context → outputs {}", async () => {
      process.env.FLAIR_AGENT_ID = "test-agent";
      const out = await runHook(SAMPLE_INPUT, () => ({
        bootstrap: async () => ({ context: "   \n  " }),
      }));
      expect(out).toBe(NOOP);
    });

    test("missing context field → outputs {}", async () => {
      process.env.FLAIR_AGENT_ID = "test-agent";
      const out = await runHook(SAMPLE_INPUT, () => ({
        bootstrap: async () => ({}),
      }));
      expect(out).toBe(NOOP);
    });

    test("malformed stdin JSON → tolerated, still produces context", async () => {
      process.env.FLAIR_AGENT_ID = "test-agent";
      const out = await runHook("not-json{{{", () => ({
        bootstrap: async () => ({ context: "## Identity\nrole: test" }),
      }));
      const parsed = JSON.parse(out);
      expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    });
  });

  describe("happy path output shape", () => {
    test("context present → valid SessionStart hook JSON", async () => {
      process.env.FLAIR_AGENT_ID = "test-agent";
      const context = "## Identity\nrole: test agent\n\n## Recent\n- shipped the hook";
      const out = await runHook(SAMPLE_INPUT, () => ({
        bootstrap: async () => ({ context }),
      }));
      const parsed = JSON.parse(out);
      expect(parsed.hookSpecificOutput).toBeDefined();
      expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
      expect(parsed.hookSpecificOutput.additionalContext).toBe(context);
    });

    test("derives project subject from cwd basename", async () => {
      process.env.FLAIR_AGENT_ID = "test-agent";
      let seenSubjects: string[] | undefined;
      let seenChannel: string | undefined;
      await runHook(SAMPLE_INPUT, () => ({
        bootstrap: async (opts) => {
          seenSubjects = opts.subjects;
          seenChannel = opts.channel;
          return { context: "ctx" };
        },
      }));
      expect(seenSubjects).toEqual(["project-x"]);
      expect(seenChannel).toBe("claude-code");
    });

    test("additionalContext is clamped to ≤ 10000 chars", async () => {
      process.env.FLAIR_AGENT_ID = "test-agent";
      const huge = "x".repeat(MAX_CHARS + 5000);
      const out = await runHook(SAMPLE_INPUT, () => ({
        bootstrap: async () => ({ context: huge }),
      }));
      const parsed = JSON.parse(out);
      expect(parsed.hookSpecificOutput.additionalContext.length).toBeLessThanOrEqual(MAX_CHARS);
      expect(parsed.hookSpecificOutput.additionalContext.length).toBe(MAX_CHARS);
    });

    test("output is always valid JSON", async () => {
      process.env.FLAIR_AGENT_ID = "test-agent";
      const out = await runHook(SAMPLE_INPUT, () => ({
        bootstrap: async () => ({ context: 'has "quotes" and \n newlines \\ backslashes' }),
      }));
      expect(() => JSON.parse(out)).not.toThrow();
      const parsed = JSON.parse(out);
      expect(parsed.hookSpecificOutput.additionalContext).toContain("quotes");
    });
  });

  describe("auto-presence (flair#598)", () => {
    // Session start is the clearest "this agent is alive" signal flair-mcp
    // gets — the hook fires a best-effort POST /Presence alongside bootstrap
    // when the injected client exposes `request()` (the real FlairClient
    // always does). These tests use a client stub with BOTH bootstrap() and
    // request() so the presence side effect is observable.

    test("session start POSTs presence when the client supports request()", async () => {
      process.env.FLAIR_AGENT_ID = "test-agent";
      const presenceCalls: Array<{ method: string; path: string; body: unknown }> = [];
      const out = await runHook(SAMPLE_INPUT, () => ({
        bootstrap: async () => ({ context: "## Identity\nrole: test" }),
        request: async (method: string, path: string, body?: unknown) => {
          presenceCalls.push({ method, path, body });
          return { ok: true };
        },
      }));

      expect(presenceCalls).toHaveLength(1);
      expect(presenceCalls[0].method).toBe("POST");
      expect(presenceCalls[0].path).toBe("/Presence");
      expect(presenceCalls[0].body).toEqual({ activity: "coding" }); // no currentTask in the hook payload
      // The presence side effect never changes the hook's own output contract.
      const parsed = JSON.parse(out);
      expect(parsed.hookSpecificOutput.additionalContext).toBe("## Identity\nrole: test");
    });

    test("client without request() — presence step is silently skipped, no error", async () => {
      process.env.FLAIR_AGENT_ID = "test-agent";
      // No `request` on this stub at all — matches every OTHER test in this
      // file, confirming the new code path doesn't change their behavior.
      const out = await runHook(SAMPLE_INPUT, () => ({
        bootstrap: async () => ({ context: "ctx" }),
      }));
      const parsed = JSON.parse(out);
      expect(parsed.hookSpecificOutput.additionalContext).toBe("ctx");
    });

    test("a failing presence POST does NOT throw and does NOT affect the hook's output", async () => {
      process.env.FLAIR_AGENT_ID = "test-agent";
      const out = await runHook(SAMPLE_INPUT, () => ({
        bootstrap: async () => ({ context: "## Identity\nrole: test" }),
        request: async () => {
          throw new Error("network error: ECONNREFUSED");
        },
      }));
      // Bootstrap succeeded; the presence failure must be invisible here.
      const parsed = JSON.parse(out);
      expect(parsed.hookSpecificOutput.additionalContext).toBe("## Identity\nrole: test");
    });

    test("a failing presence POST does not prevent the NOOP path either (bootstrap also fails)", async () => {
      process.env.FLAIR_AGENT_ID = "test-agent";
      const out = await runHook(SAMPLE_INPUT, () => ({
        bootstrap: async () => {
          throw new Error("bootstrap unreachable");
        },
        request: async () => {
          throw new Error("presence also unreachable");
        },
      }));
      expect(out).toBe(NOOP);
    });

    test("a hanging presence POST does not delay the hook beyond its own timeout budget", async () => {
      process.env.FLAIR_AGENT_ID = "test-agent";
      // Uses presence.ts's own default timeout (3s, resolvePresenceTimeoutMs)
      // — runs CONCURRENTLY with bootstrap, so total wall time stays bounded
      // by that ~3s, well under the 8s bootstrap timeout default.
      const start = Date.now();
      const out = await runHook(SAMPLE_INPUT, () => ({
        bootstrap: async () => ({ context: "ctx" }),
        request: () => new Promise(() => {}), // never resolves
      }));
      const elapsed = Date.now() - start;

      const parsed = JSON.parse(out);
      expect(parsed.hookSpecificOutput.additionalContext).toBe("ctx");
      expect(elapsed).toBeLessThan(5000);
    });
  });
});
