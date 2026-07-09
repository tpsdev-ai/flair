import { describe, test, expect, afterEach } from "bun:test";
import {
  deriveActivity,
  shouldSendHeartbeat,
  buildPresenceBody,
  postPresenceSafe,
  resolveHeartbeatIntervalMs,
  resolvePresenceTimeoutMs,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_PRESENCE_TIMEOUT_MS,
  type PresencePoster,
} from "../src/presence.ts";

/**
 * flair#598 — auto-presence unit tests.
 *
 * Covers the three things the issue explicitly asks for:
 *   - a session-defining event (first heartbeat) POSTs presence
 *   - a rate-limited heartbeat: a second rapid call does NOT POST again
 *   - a failing presence POST never throws / never breaks the caller
 *
 * Plus the supporting pure functions (deriveActivity, buildPresenceBody) and
 * the env-clamped config resolvers, tested the same way the rest of this
 * package validates its clamped-env helpers (FLAIR_MCP_PARENT_POLL_MS /
 * FLAIR_HOOK_TIMEOUT_MS elsewhere).
 */

const ORIGINAL_HEARTBEAT_ENV = process.env.FLAIR_PRESENCE_HEARTBEAT_MS;
const ORIGINAL_TIMEOUT_ENV = process.env.FLAIR_PRESENCE_TIMEOUT_MS;

afterEach(() => {
  if (ORIGINAL_HEARTBEAT_ENV === undefined) delete process.env.FLAIR_PRESENCE_HEARTBEAT_MS;
  else process.env.FLAIR_PRESENCE_HEARTBEAT_MS = ORIGINAL_HEARTBEAT_ENV;
  if (ORIGINAL_TIMEOUT_ENV === undefined) delete process.env.FLAIR_PRESENCE_TIMEOUT_MS;
  else process.env.FLAIR_PRESENCE_TIMEOUT_MS = ORIGINAL_TIMEOUT_ENV;
});

// ─── deriveActivity ───────────────────────────────────────────────────────────

describe("deriveActivity", () => {
  test("defaults to 'coding' with no context", () => {
    expect(deriveActivity()).toBe("coding");
    expect(deriveActivity({})).toBe("coding");
  });

  test("defaults to 'coding' when surface doesn't match a known pattern", () => {
    expect(deriveActivity({ surface: "cli-session" })).toBe("coding");
    expect(deriveActivity({ channel: "claude-code" })).toBe("coding");
  });

  test("surface containing 'review' -> reviewing", () => {
    expect(deriveActivity({ surface: "tps-review" })).toBe("reviewing");
  });

  test("surface containing 'plan'/'spec'/'design' -> planning", () => {
    expect(deriveActivity({ surface: "tps-planning" })).toBe("planning");
    expect(deriveActivity({ surface: "spec-writing" })).toBe("planning");
    expect(deriveActivity({ surface: "design-doc" })).toBe("planning");
  });

  // flair#613 — the flagship collision-detection use case (a live incident
  // investigation) had no matching bucket and fell through to "coding" (or
  // misleadingly "reviewing" if the surface also mentioned review).
  test("surface containing 'debug'/'investigat'/'incident' -> debugging", () => {
    expect(deriveActivity({ surface: "debug-session" })).toBe("debugging");
    expect(deriveActivity({ surface: "investigation" })).toBe("debugging");
    expect(deriveActivity({ surface: "incident-response" })).toBe("debugging");
  });

  test("'review' takes precedence over 'plan'/'spec'/'design' when both match", () => {
    // deriveActivity checks "review" first — see its doc comment (two narrow
    // overrides, "review" wins ties since a review surface is unambiguous).
    expect(deriveActivity({ surface: "spec-review-x" })).toBe("reviewing");
  });

  test("'debug'/'investigat'/'incident' takes precedence over 'review'/'plan' when both match", () => {
    // deriveActivity checks debugging first — see its doc comment (an
    // incident investigation is the most unambiguous, highest-signal surface
    // name available, so it wins ties against the other two overrides).
    expect(deriveActivity({ surface: "incident-review" })).toBe("debugging");
    expect(deriveActivity({ surface: "investigate-the-plan" })).toBe("debugging");
  });

  test("is case-insensitive", () => {
    expect(deriveActivity({ surface: "TPS-REVIEW" })).toBe("reviewing");
    expect(deriveActivity({ surface: "Design-Doc" })).toBe("planning");
    expect(deriveActivity({ surface: "INCIDENT" })).toBe("debugging");
  });
});

// ─── shouldSendHeartbeat (pure rate-limit check) ─────────────────────────────

describe("shouldSendHeartbeat", () => {
  test("no prior send (lastSentAt null) -> always true", () => {
    expect(shouldSendHeartbeat(1_000_000, null, 60_000)).toBe(true);
  });

  test("elapsed >= interval -> true", () => {
    expect(shouldSendHeartbeat(100_000, 40_000, 60_000)).toBe(true); // exactly 60_000 elapsed
    expect(shouldSendHeartbeat(200_000, 40_000, 60_000)).toBe(true); // well past
  });

  test("elapsed < interval -> false", () => {
    expect(shouldSendHeartbeat(50_000, 40_000, 60_000)).toBe(false); // only 10_000 elapsed
  });
});

// ─── buildPresenceBody ────────────────────────────────────────────────────────

describe("buildPresenceBody", () => {
  test("always includes activity", () => {
    expect(buildPresenceBody("idle")).toEqual({ activity: "idle" });
  });

  test("includes currentTask when present and non-empty", () => {
    expect(buildPresenceBody("coding", "flair#598")).toEqual({ activity: "coding", currentTask: "flair#598" });
  });

  test("accepts 'debugging' (flair#613)", () => {
    expect(buildPresenceBody("debugging", "flair#613")).toEqual({ activity: "debugging", currentTask: "flair#613" });
  });

  test("omits currentTask when undefined (does not send null / clear it)", () => {
    const body = buildPresenceBody("coding", undefined);
    expect(body).not.toHaveProperty("currentTask");
  });

  test("omits currentTask when empty string", () => {
    const body = buildPresenceBody("coding", "");
    expect(body).not.toHaveProperty("currentTask");
  });

  test("never includes agentId — identity comes from the signed request, not the body", () => {
    const body = buildPresenceBody("coding", "task");
    expect(body).not.toHaveProperty("agentId");
  });
});

// ─── resolveHeartbeatIntervalMs / resolvePresenceTimeoutMs (clamped env) ─────

describe("resolveHeartbeatIntervalMs", () => {
  test("defaults when unset", () => {
    delete process.env.FLAIR_PRESENCE_HEARTBEAT_MS;
    expect(resolveHeartbeatIntervalMs()).toBe(DEFAULT_HEARTBEAT_INTERVAL_MS);
  });

  test("defaults on empty string (does not coerce to 0 and hammer the endpoint)", () => {
    process.env.FLAIR_PRESENCE_HEARTBEAT_MS = "";
    expect(resolveHeartbeatIntervalMs()).toBe(DEFAULT_HEARTBEAT_INTERVAL_MS);
  });

  test("defaults when out of range (too low or too high)", () => {
    process.env.FLAIR_PRESENCE_HEARTBEAT_MS = "1"; // below floor
    expect(resolveHeartbeatIntervalMs()).toBe(DEFAULT_HEARTBEAT_INTERVAL_MS);
    process.env.FLAIR_PRESENCE_HEARTBEAT_MS = String(24 * 60 * 60 * 1000); // above ceiling
    expect(resolveHeartbeatIntervalMs()).toBe(DEFAULT_HEARTBEAT_INTERVAL_MS);
  });

  test("respects a valid in-range override", () => {
    process.env.FLAIR_PRESENCE_HEARTBEAT_MS = "45000";
    expect(resolveHeartbeatIntervalMs()).toBe(45_000);
  });
});

describe("resolvePresenceTimeoutMs", () => {
  test("defaults when unset", () => {
    delete process.env.FLAIR_PRESENCE_TIMEOUT_MS;
    expect(resolvePresenceTimeoutMs()).toBe(DEFAULT_PRESENCE_TIMEOUT_MS);
  });

  test("defaults on empty string", () => {
    process.env.FLAIR_PRESENCE_TIMEOUT_MS = "";
    expect(resolvePresenceTimeoutMs()).toBe(DEFAULT_PRESENCE_TIMEOUT_MS);
  });

  test("respects a valid in-range override", () => {
    process.env.FLAIR_PRESENCE_TIMEOUT_MS = "1500";
    expect(resolvePresenceTimeoutMs()).toBe(1500);
  });
});

// ─── postPresenceSafe — fail-open contract ───────────────────────────────────

describe("postPresenceSafe", () => {
  test("posts to /Presence with the expected body", async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const poster: PresencePoster = {
      async request(method, path, body) {
        calls.push({ method, path, body });
        return { ok: true };
      },
    };

    await postPresenceSafe(poster, "coding", "flair#598", 1000);

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].path).toBe("/Presence");
    expect(calls[0].body).toEqual({ activity: "coding", currentTask: "flair#598" });
  });

  test("a rejecting request() does NOT throw — resolves normally", async () => {
    const poster: PresencePoster = {
      async request() {
        throw new Error("network error: ECONNREFUSED");
      },
    };

    // The whole point: awaiting this must not reject.
    await expect(postPresenceSafe(poster, "coding", undefined, 1000)).resolves.toBeUndefined();
  });

  test("a hanging request() does not hang the caller — bounded by timeoutMs", async () => {
    const poster: PresencePoster = {
      request() {
        return new Promise(() => {}); // never resolves/rejects
      },
    };

    const start = Date.now();
    await postPresenceSafe(poster, "idle", undefined, 100); // tight timeout
    const elapsed = Date.now() - start;

    // Resolved (didn't throw) and did so close to the timeout, not instantly
    // and not hung indefinitely.
    expect(elapsed).toBeLessThan(2000);
  });

  test("a 401/403-shaped rejection (auth error) does NOT throw", async () => {
    const poster: PresencePoster = {
      async request() {
        const err = new Error("Flair POST /Presence -> 401: invalid_signature");
        throw err;
      },
    };

    await expect(postPresenceSafe(poster, "coding", "task", 1000)).resolves.toBeUndefined();
  });
});

// ─── End-to-end rate-limit contract (mirrors index.ts's heartbeat() closure) ─
//
// index.ts's runMcp() wires shouldSendHeartbeat + postPresenceSafe together
// in a small closure (`heartbeat()`) that owns its own `lastPresenceSentAt`
// clock — that closure isn't exported (runMcp() has module-level side
// effects, same reason mcp.test.ts tests tool logic in isolation rather than
// importing the wired server). This test reproduces the EXACT same wiring
// using the real exported functions, with an injectable clock, so the
// rate-limit contract is verified against real code, not a re-implementation.

describe("heartbeat wiring (rate limit contract)", () => {
  function makeHeartbeat(poster: PresencePoster, intervalMs: number, clock: { now: number }) {
    let lastSentAt: number | null = null;
    return (activity: Parameters<typeof buildPresenceBody>[0] = "coding", currentTask?: string) => {
      if (!shouldSendHeartbeat(clock.now, lastSentAt, intervalMs)) return;
      lastSentAt = clock.now;
      void postPresenceSafe(poster, activity, currentTask, 1000);
    };
  }

  test("first call always sends (session start)", async () => {
    const calls: unknown[] = [];
    const poster: PresencePoster = { async request(_m, _p, body) { calls.push(body); return {}; } };
    const clock = { now: 1_000_000 };
    const heartbeat = makeHeartbeat(poster, 60_000, clock);

    heartbeat("coding", "flair#598");
    await Promise.resolve(); // let the fire-and-forget microtask run
    await new Promise((r) => setTimeout(r, 0));

    expect(calls).toHaveLength(1);
  });

  test("a second rapid call within the interval does NOT POST again", async () => {
    const calls: unknown[] = [];
    const poster: PresencePoster = { async request(_m, _p, body) { calls.push(body); return {}; } };
    const clock = { now: 1_000_000 };
    const heartbeat = makeHeartbeat(poster, 60_000, clock);

    heartbeat("coding");
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toHaveLength(1);

    clock.now += 1_000; // 1s later — well within the 60s interval
    heartbeat("coding");
    await new Promise((r) => setTimeout(r, 0));

    expect(calls).toHaveLength(1); // still just the one send — rate-limited
  });

  test("a call after the interval elapses sends again", async () => {
    const calls: unknown[] = [];
    const poster: PresencePoster = { async request(_m, _p, body) { calls.push(body); return {}; } };
    const clock = { now: 1_000_000 };
    const heartbeat = makeHeartbeat(poster, 60_000, clock);

    heartbeat("coding");
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toHaveLength(1);

    clock.now += 61_000; // past the interval
    heartbeat("reviewing");
    await new Promise((r) => setTimeout(r, 0));

    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ activity: "reviewing" });
  });

  test("a failing poster never surfaces through the heartbeat wiring (fire-and-forget is safe)", async () => {
    const poster: PresencePoster = {
      async request() {
        throw new Error("Flair down");
      },
    };
    const clock = { now: 1_000_000 };
    const heartbeat = makeHeartbeat(poster, 60_000, clock);

    // Calling this must not throw synchronously, and must not produce an
    // unhandled rejection (postPresenceSafe's own catch guarantees the
    // returned promise never rejects, so `void postPresenceSafe(...)` above
    // is safe even without a `.catch()`).
    expect(() => heartbeat("coding")).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});
