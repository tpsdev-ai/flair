import { describe, test, expect, afterEach, beforeEach, spyOn } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FlairError } from "@tpsdev-ai/flair-client";
import * as hook from "../src/session-start-hook.ts";

const { runHook, classifyBootstrapFailure } = hook;

/**
 * flair#1943 — the session-start hook REPORTS a failed bootstrap on stderr.
 *
 * The same code path serves Claude Code and Codex. The hook keeps its
 * no-op-on-failure stdout contract and stays silent on success; a real failure
 * now writes exactly one line to STDERR naming the failure KIND and the remedy,
 * and never a credential.
 *
 * The kind is decided ONLY by what the error carries (a numeric HTTP status, or
 * the hook's own timer); message text is never consulted (round 2, item 1).
 */

const NOOP = "{}";
const ORIGINAL_AGENT_ID = process.env.FLAIR_AGENT_ID;
const ORIGINAL_SESSION_DIR = process.env.FLAIR_SESSION_DIR;
const ORIGINAL_HOOK_TIMEOUT = process.env.FLAIR_HOOK_TIMEOUT_MS;

// Sentinels that must never reach a stream. Nothing here is a real secret.
const BODY_SENTINEL = "SENTINEL-body-7f3a9c1d";
const URL_PASSWORD = "SENTINEL-pw-1e5b2f8a";

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
  if (ORIGINAL_HOOK_TIMEOUT === undefined) delete process.env.FLAIR_HOOK_TIMEOUT_MS;
  else process.env.FLAIR_HOOK_TIMEOUT_MS = ORIGINAL_HOOK_TIMEOUT;
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
        throw new FlairError("POST", "/Bootstrap", 401, "upstream timed out");
      },
    }));
    expect(out).toBe(NOOP); // assertion: stdout unchanged (no-op payload)
    expect(stderr.match(/\n/g)?.length ?? 0).toBe(1); // assertion: exactly ONE stderr line
    expect(stderr).toContain("bootstrap failed (auth)"); // assertion: names the kind
    expect(stderr).toContain("flair doctor"); // assertion: names the remedy
  });

  test("(h2) the hook's OWN timer firing is reported as timeout", async () => {
    process.env.FLAIR_HOOK_TIMEOUT_MS = "500";
    const { stderr } = await runCapturingStderr(() => ({
      // Never resolves: the only way this ends is withTimeout's own timer.
      bootstrap: () => new Promise<never>(() => {}),
    }));
    expect(stderr).toContain("bootstrap failed (timeout)"); // assertion: the hook's timer → timeout
    expect(stderr).toContain("flair doctor"); // assertion
  }, 10_000);

  test("(h3) a successful bootstrap writes NOTHING to stderr", async () => {
    const { out, stderr } = await runCapturingStderr(() => ({
      bootstrap: async () => ({ context: "## Identity\nrole: test" }),
    }));
    expect(stderr).toBe(""); // assertion: silent on success
    expect(out).not.toBe(NOOP); // assertion: the context is emitted on stdout
  });

  test("(h4) secrets carried by the THROWN error never reach stderr or stdout", async () => {
    // Case A: a FlairError whose BODY carries a sentinel token.
    const withBody = await runCapturingStderr(() => ({
      bootstrap: async () => {
        throw new FlairError("POST", "/Bootstrap", 500, `bad gateway token=${BODY_SENTINEL}`);
      },
    }));
    expect(withBody.stderr).toContain("bootstrap failed (http-500)"); // assertion: reported
    expect(withBody.stderr).not.toContain(BODY_SENTINEL); // assertion: no body token on stderr
    expect(withBody.out).not.toContain(BODY_SENTINEL); // assertion: no body token on stdout

    // Case B: an error whose MESSAGE is a URL with a sentinel password in userinfo.
    const withUrl = await runCapturingStderr(() => ({
      bootstrap: async () => {
        throw new TypeError(`fetch failed for http://oauth-user:${URL_PASSWORD}@127.0.0.1:1/Bootstrap`);
      },
    }));
    expect(withUrl.stderr).toContain("bootstrap failed (unreachable)"); // assertion: reported
    expect(withUrl.stderr).not.toContain(URL_PASSWORD); // assertion: no URL password on stderr
    expect(withUrl.out).not.toContain(URL_PASSWORD); // assertion: no URL password on stdout
  });

  test("classifyBootstrapFailure reads a numeric status FIRST and never decides a kind from message text", () => {
    // A numeric status wins even when the message says otherwise.
    expect(classifyBootstrapFailure(new FlairError("POST", "/x", 401, "upstream timed out"))).toBe("auth"); // assertion: status 401 + misleading body
    expect(classifyBootstrapFailure(new FlairError("POST", "/x", 403, ""))).toBe("auth"); // assertion: status 403
    expect(classifyBootstrapFailure(new FlairError("POST", "/x", 500, "unauthorized"))).toBe("http-500"); // assertion: non-auth status
    // No status → message text is NEVER a kind.
    expect(classifyBootstrapFailure(new Error("upstream timed out"))).toBe("unreachable"); // assertion: "timeout" in text is not timeout
    expect(classifyBootstrapFailure(new Error("401 Unauthorized"))).toBe("unreachable"); // assertion: "401" in text is not auth
    expect(classifyBootstrapFailure(new TypeError("Failed to fetch http://oauth-user:pw@127.0.0.1:1/"))).toBe("unreachable"); // assertion: userinfo URL → unreachable
    // The hook's own timer is the ONLY in-band timeout.
    expect(classifyBootstrapFailure(new hook.BootstrapTimeoutError())).toBe("timeout"); // assertion: hook timer
    const named: any = new Error("x");
    named.name = "TimeoutError";
    expect(classifyBootstrapFailure(named)).toBe("timeout"); // assertion: name TimeoutError
    expect(classifyBootstrapFailure(new Error("fetch failed"))).toBe("unreachable"); // assertion
  });
});

describe("flair#1943 — a failed stderr write is best-effort (spawned hook)", () => {
  // The hook ENTRY POINT, spawned as its own process — deliberately the SOURCE,
  // not dist/, matching session-start-hook-probe.test.ts: the `bun test` lane
  // does not guarantee this package's dist/ exists.
  const ENTRY = join(import.meta.dir, "..", "src", "session-start-hook.ts");

  /** Spawn the hook with stdin closed after one write. `closeStderr` destroys
   *  the parent's read end of the child's stderr pipe BEFORE the failure line
   *  is written, so the child's stderr.write hits a closed pipe (EPIPE). */
  function runChild(input: string, env: NodeJS.ProcessEnv, closeStderr: boolean): Promise<{ code: number | null; signal: string | null; out: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [ENTRY], { env, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d) => (out += d.toString()));
      if (closeStderr) child.stderr.destroy();
      else child.stderr.resume();
      child.on("error", () => resolve({ code: -1, signal: null, out }));
      child.on("close", (code, signal) => resolve({ code, signal, out }));
      child.stdin.end(input);
    });
  }

  test("(s1) a stderr pipe closed before the failure line: exit 0 and stdout byte-equal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flair-hook-epipe-"));
    // A valid raw 32-byte seed so the client CONSTRUCTS, and a refused port so
    // bootstrap() fails INSIDE the try (→ the stderr line is written).
    writeFileSync(join(dir, "ident.key"), Buffer.alloc(32, 7));
    const env = {
      ...process.env,
      FLAIR_AGENT_ID: "stderr-epipe-agent",
      FLAIR_URL: "http://127.0.0.1:1",
      FLAIR_KEY_PATH: join(dir, "ident.key"),
      FLAIR_SESSION_DIR: dir,
      FLAIR_HOOK_PROBE: "",
    };
    try {
      const closed = await runChild('{"cwd":"/tmp/proj"}', env, true);
      const open = await runChild('{"cwd":"/tmp/proj"}', env, false);
      expect(closed.signal).toBeNull(); // assertion: not killed by a signal
      expect(closed.code).toBe(0); // assertion: a closed stderr does not change the exit code
      expect(closed.out).toBe(open.out); // assertion: stdout byte-equal with stderr open
      expect(closed.out).toBe(NOOP); // assertion: still the inert payload
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
