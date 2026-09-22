// flair#1790 — the ops-API seed names its failure and retries once on the
// client timeout.
//
// `seedAgentViaOpsApi` / `seedFederationInstanceViaOpsApi` used to POST through
// a single bare `fetch` under `AbortSignal.timeout(10_000)` with no catch: on a
// timeout the caller saw only an undici `DOMException [TimeoutError]` stack, and
// nothing retried. A post-restart `flair init` in the install-from-tarball smoke
// hit exactly that. See the module comment above the helpers in src/cli.ts.
//
// These tests inject `fetch` so the timing is explicit: each one records HOW
// MANY times the injected fetch was called and asserts the named outcome for
// that count. The timeout is simulated with an Error named `TimeoutError` —
// the name our own `AbortSignal.timeout` abort carries.
import { describe, test, expect } from "bun:test";
import {
  seedAgentViaOpsApi,
  seedFederationInstanceViaOpsApi,
} from "../../src/cli.js";

/** The shape `AbortSignal.timeout` raises: a DOMException named TimeoutError. */
function timeoutError(): Error {
  const e = new Error("The operation was aborted due to timeout");
  e.name = "TimeoutError";
  return e;
}

interface FetchCall {
  url: string;
  signal?: AbortSignal;
}

/** Install a scriptable global fetch; records every call (url + signal). */
function installFetch(
  handler: (call: FetchCall, index: number) => Promise<Response> | Response,
): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: any, opts: any) => {
    const call: FetchCall = { url: String(url), signal: opts?.signal };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as any;
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

/** Capture console.warn / console.log for the duration of a test. */
function captureConsole(): { warn: string[]; log: string[]; restore: () => void } {
  const warn: string[] = [];
  const log: string[] = [];
  const ow = console.warn;
  const ol = console.log;
  console.warn = (...a: unknown[]) => { warn.push(a.map(String).join(" ")); };
  console.log = (...a: unknown[]) => { log.push(a.map(String).join(" ")); };
  return { warn, log, restore: () => { console.warn = ow; console.log = ol; } };
}

async function messageOf(fn: () => Promise<void>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected the seed to throw, but it resolved");
}

describe("flair#1790 — seed retry on the OWNED timeout", () => {
  test("attempt 1 times out, attempt 2 returns duplicate → resolves; both lines are emitted; 2 calls", async () => {
    const f = installFetch((_call, i) => {
      if (i === 0) throw timeoutError();
      return new Response('{"error":"duplicate"}', { status: 409 });
    });
    const c = captureConsole();
    try {
      await seedAgentViaOpsApi(19925, "smoke", "pubkey", "admin", "pw");
      expect(f.calls.length).toBe(2);
      expect(c.warn.length).toBe(1);
      expect(c.warn[0]).toBe(
        "Agent seed attempt 1 timed out after 10000 ms; retrying once. Target: http://127.0.0.1:19925/ (agent 'smoke').",
      );
      expect(c.log.length).toBe(1);
      expect(c.log[0]).toMatch(/^Agent seed attempt 2 completed in \d+ ms \(already exists\); total \d+ ms\.$/);
      // A FRESH deadline per attempt: two distinct, un-aborted signals.
      expect(f.calls[0].signal).toBeDefined();
      expect(f.calls[0].signal).not.toBe(f.calls[1].signal);
      expect(f.calls[0].signal!.aborted).toBe(false);
      expect(f.calls[1].signal!.aborted).toBe(false);
    } finally {
      c.restore();
      f.restore();
    }
  });

  test("attempt 1 succeeds → resolves on the FIRST call, logs nothing new; 1 call", async () => {
    const f = installFetch(() => new Response("", { status: 200 }));
    const c = captureConsole();
    try {
      await seedAgentViaOpsApi(19925, "smoke", "pubkey", "admin", "pw");
      expect(f.calls.length).toBe(1);
      expect(c.warn.length).toBe(0);
      expect(c.log.length).toBe(0);
    } finally {
      c.restore();
      f.restore();
    }
  });

  test("a timeout during the RESPONSE-BODY read is retried (the per-attempt deadline covers the body); 2 calls", async () => {
    const f = installFetch((_call, i) => {
      if (i === 0) {
        // Headers arrived; the body read stalls and aborts.
        return { ok: true, status: 200, text: async () => { throw timeoutError(); } } as unknown as Response;
      }
      return new Response("", { status: 200 });
    });
    const c = captureConsole();
    try {
      await seedAgentViaOpsApi(19925, "smoke", "pubkey", "admin", "pw");
      expect(f.calls.length).toBe(2);
      expect(c.warn.length).toBe(1);
    } finally {
      c.restore();
      f.restore();
    }
  });

  test("both attempts time out → the concise error, naming operation/table/url/budget; 2 calls; no undici stack", async () => {
    const f = installFetch(() => { throw timeoutError(); });
    try {
      const msg = await messageOf(() =>
        seedAgentViaOpsApi(
          "http://alice:hunter2@ops.example.com:9925/seed?token=zzz",
          "smoke",
          "pubkey",
          "admin",
          "pw",
        ),
      );
      expect(f.calls.length).toBe(2);
      expect(msg).toContain(
        "Flair could not seed agent 'smoke': Operations API insert into flair.Agent at " +
          "http://ops.example.com:9925/seed timed out on both attempts (10000 ms per attempt).",
      );
      expect(msg).toContain("Inspect the target daemon's logs, then rerun the same init command.");
      expect(msg).toContain("A timed-out insert may still complete; retrying the same agent ID is supported.");
      // Sanitized target: no userinfo, no query values.
      expect(msg).not.toContain("hunter2");
      expect(msg).not.toContain("alice:");
      expect(msg).not.toContain("token=zzz");
      // Never the undici stack.
      expect(msg).not.toContain("undici");
    } finally {
      f.restore();
    }
  });

  test("the both-attempts error is flairFriendly and keeps its cause attached; 2 calls", async () => {
    const f = installFetch(() => { throw timeoutError(); });
    try {
      let err: any;
      try {
        await seedAgentViaOpsApi(19925, "smoke", "pubkey", "admin", "pw");
      } catch (e) {
        err = e;
      }
      expect(f.calls.length).toBe(2);
      expect(err.flairFriendly).toBe(true);
      expect(err.cause).toBeInstanceOf(Error);
      expect((err.cause as Error).name).toBe("TimeoutError");
    } finally {
      f.restore();
    }
  });

  test("a 401 is NOT retried and keeps the existing auth hint; 1 call", async () => {
    const f = installFetch(() => new Response('{"error":"Login failed"}', { status: 401 }));
    try {
      const msg = await messageOf(() => seedAgentViaOpsApi(19925, "smoke", "pubkey", "operator", "bad-pass"));
      expect(f.calls.length).toBe(1);
      expect(msg).toContain("Operations API insert failed (401)");
      expect(msg).toContain("--admin-user");
      expect(msg).toContain("--admin-pass");
    } finally {
      f.restore();
    }
  });

  test("a non-timeout HTTP failure is NOT retried and keeps the existing message; 1 call", async () => {
    const f = installFetch(() => new Response("boom", { status: 500 }));
    try {
      const msg = await messageOf(() => seedAgentViaOpsApi(19925, "smoke", "pubkey", "admin", "pw"));
      expect(f.calls.length).toBe(1);
      expect(msg).toContain("Operations API insert failed (500)");
      expect(msg).not.toContain("--admin-user");
    } finally {
      f.restore();
    }
  });

  test("a non-timeout network error is NOT retried; 1 call", async () => {
    const f = installFetch(() => {
      const e: any = new Error("fetch failed");
      e.name = "TypeError";
      throw e;
    });
    try {
      const msg = await messageOf(() => seedAgentViaOpsApi(19925, "smoke", "pubkey", "admin", "pw"));
      expect(f.calls.length).toBe(1);
      expect(msg).toBe("fetch failed");
    } finally {
      f.restore();
    }
  });
});

describe("flair#1790 — the same wrap on the federation-instance seed", () => {
  test("retries once on the owned timeout, with Federation Instance wording; 2 calls", async () => {
    const f = installFetch((_call, i) => {
      if (i === 0) throw timeoutError();
      return new Response("", { status: 200 });
    });
    const c = captureConsole();
    try {
      await seedFederationInstanceViaOpsApi(19925, "inst-1", "pk", "hub", "admin", "pw");
      expect(f.calls.length).toBe(2);
      expect(c.warn[0]).toContain("Federation Instance seed attempt 1 timed out after 10000 ms; retrying once.");
      expect(c.log[0]).toMatch(/^Federation Instance seed attempt 2 completed in \d+ ms \(inserted\); total \d+ ms\.$/);
    } finally {
      c.restore();
      f.restore();
    }
  });

  test("both attempts time out → names flair.Instance and the federation instance; 2 calls", async () => {
    const f = installFetch(() => { throw timeoutError(); });
    try {
      const msg = await messageOf(() =>
        seedFederationInstanceViaOpsApi(19925, "inst-1", "pk", "hub", "admin", "pw"),
      );
      expect(f.calls.length).toBe(2);
      expect(msg).toContain(
        "Flair could not seed federation instance 'inst-1': Operations API insert into flair.Instance at",
      );
      expect(msg).toContain("timed out on both attempts (10000 ms per attempt)");
    } finally {
      f.restore();
    }
  });
});
