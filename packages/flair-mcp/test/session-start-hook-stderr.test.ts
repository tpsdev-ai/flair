import { describe, test, expect, afterEach, beforeEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook, classifyBootstrapFailure } from "../src/session-start-hook.ts";

/**
 * flair#1943 — the session-start hook REPORTS a failed bootstrap on stderr.
 *
 * The same code path serves Claude Code and Codex. The hook keeps its
 * no-op-on-failure stdout contract and stays silent on success; a real failure
 * now writes exactly one line to STDERR naming the actor, the state and the
 * remedy, and never a credential.
 */

const NOOP = "{}";
const ORIGINAL_AGENT_ID = process.env.FLAIR_AGENT_ID;
const ORIGINAL_SESSION_DIR = process.env.FLAIR_SESSION_DIR;

let sessionDir: string;

beforeEach(() => {
  sessionDir = mkdtempSync(join(tmpdir(), "flair-hook-stderr-"));
  process.env.FLAIR_SESSION_DIR = sessionDir;
  process.env.FLAIR_AGENT_ID = "test-agent";
});

afterEach(() => {
  if (ORIGINAL_AGENT_ID === undefined) delete process.env.FLAIR_AGENT_ID;
  else process.env.FLAIR_AGENT_ID = ORIGINAL_AGENT_ID;
  if (ORIGINAL_SESSION_DIR === undefined) delete process.env.FLAIR_SESSION_DIR;
  else process.env.FLAIR_SESSION_DIR = ORIGINAL_SESSION_DIR;
  rmSync(sessionDir, { recursive: true, force: true });
});

/** Run runHook while capturing everything written to stderr. */
async function runCapturingStderr(makeClient: any): Promise<{ out: string; stderr: string }> {
  const spy = spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    const out = await runHook(JSON.stringify({ cwd: "/tmp/proj" }), makeClient);
    const stderr = spy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    return { out, stderr };
  } finally {
    spy.mockRestore();
  }
}

describe("flair#1943 — the session-start hook reports a failed bootstrap on stderr", () => {
  test("(h1) an auth failure (401) writes one stderr line naming auth + flair doctor; stdout is the no-op payload", async () => {
    const { out, stderr } = await runCapturingStderr(() => ({
      bootstrap: async () => {
        const e: any = new Error("401 Unauthorized");
        e.status_code = 401;
        throw e;
      },
    }));
    expect(out).toBe(NOOP); // assertion: stdout unchanged (no-op payload)
    expect(stderr.match(/\n/g)?.length ?? 0).toBe(1); // assertion: exactly ONE stderr line
    expect(stderr).toContain("bootstrap failed (auth)"); // assertion: names the kind
    expect(stderr).toContain("flair doctor"); // assertion: names the remedy
  });

  test("(h2) a timeout writes a stderr line naming the timeout", async () => {
    const { stderr } = await runCapturingStderr(() => ({
      bootstrap: async () => {
        throw new Error("bootstrap_timeout");
      },
    }));
    expect(stderr).toContain("bootstrap failed (timeout)"); // assertion: timeout kind named
    expect(stderr).toContain("flair doctor"); // assertion
  });

  test("(h3) a successful bootstrap writes NOTHING to stderr", async () => {
    const { out, stderr } = await runCapturingStderr(() => ({
      bootstrap: async () => ({ context: "## Identity\nrole: test" }),
    }));
    expect(stderr).toBe(""); // assertion: silent on success
    expect(out).not.toBe(NOOP); // assertion: the context is emitted on stdout
  });

  test("(h4) with the admin password and a key present in the environment, the stderr line contains neither", async () => {
    process.env.FLAIR_ADMIN_PASSWORD = "super-secret-pw";
    process.env.FLAIR_API_KEY = "sk-secret-key-value";
    try {
      const { stderr } = await runCapturingStderr(() => ({
        bootstrap: async () => {
          throw new Error("fetch failed"); // unreachable
        },
      }));
      expect(stderr).toContain("bootstrap failed (unreachable)"); // assertion: reported
      expect(stderr).not.toContain("super-secret-pw"); // assertion: no admin password
      expect(stderr).not.toContain("sk-secret-key-value"); // assertion: no key
    } finally {
      delete process.env.FLAIR_ADMIN_PASSWORD;
      delete process.env.FLAIR_API_KEY;
    }
  });

  test("classifyBootstrapFailure: auth / timeout / unreachable from what the error carries", () => {
    const authStatus: any = new Error("x");
    authStatus.status_code = 403;
    expect(classifyBootstrapFailure(authStatus)).toBe("auth"); // assertion: status 403
    expect(classifyBootstrapFailure(new Error("401 invalid_signature"))).toBe("auth"); // assertion: 401 in message
    expect(classifyBootstrapFailure(new Error("bootstrap_timeout"))).toBe("timeout"); // assertion
    expect(classifyBootstrapFailure(new TypeError("fetch failed"))).toBe("unreachable"); // assertion
  });
});
