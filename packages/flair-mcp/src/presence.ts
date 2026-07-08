/**
 * Auto-presence — shared, pure/testable logic behind flair#598.
 *
 * Presence (`POST /Presence`, resources/Presence.ts) only ever updated via the
 * manual `flair presence set` CLI command, which in practice nobody runs — so
 * the roster is permanently stale and the active/idle/offline derivation it
 * powers (Office Space collision detection) never means anything. This module
 * makes presence a SIDE EFFECT of normal agent activity instead: every flair-mcp
 * tool call (and the flair-session-start hook) can call `postPresenceSafe()`
 * to refresh the calling agent's own `lastHeartbeatAt`, rate-limited so it
 * doesn't turn into a write storm.
 *
 * Everything here is a pure function or a single fire-and-forget async
 * wrapper — no module-level mutable state lives in this file. The rate-limit
 * clock (`lastSentAt`) and the "last known task" text are owned by each
 * CALLER (flair-mcp/src/index.ts's runMcp() closure, session-start-hook.ts's
 * per-invocation scope) — this file only decides "is it time yet" and "what
 * does the POST body look like", so both call sites share ONE implementation
 * of those decisions without sharing any actual state.
 */

// ─── Activity derivation ────────────────────────────────────────────────────

/** Mirrors VALID_ACTIVITIES in resources/Presence.ts — keep in sync. */
export type PresenceActivity = "coding" | "reviewing" | "planning" | "idle";

/**
 * Derive a presence `activity` from the SAME context signals the `bootstrap`
 * tool and the SessionStart hook already receive (channel/surface) — no new
 * inputs, no separate classifier call. Two narrow, name-based overrides for
 * the surfaces that are unambiguous on their own; everything else (including
 * no surface at all, e.g. the session-start hook) falls through to "coding",
 * since an MCP tool call is, definitionally, an agent doing something — never
 * "idle" (idle/offline are purely functions of elapsed time since the last
 * heartbeat; see derivePresenceStatus() in resources/Presence.ts).
 */
export function deriveActivity(ctx: { surface?: string; channel?: string } = {}): PresenceActivity {
  const surface = (ctx.surface ?? "").toLowerCase();
  if (surface.includes("review")) return "reviewing";
  if (surface.includes("plan") || surface.includes("spec") || surface.includes("design")) return "planning";
  return "coding";
}

// ─── Rate limiting ──────────────────────────────────────────────────────────

/**
 * Pure "is it time to send another heartbeat" check. The caller owns the
 * clock (`lastSentAt`) — this function has no memory of its own, which is
 * what makes it trivially unit-testable (no fake timers, no module reset
 * between tests).
 */
export function shouldSendHeartbeat(now: number, lastSentAt: number | null, minIntervalMs: number): boolean {
  if (lastSentAt == null) return true;
  return now - lastSentAt >= minIntervalMs;
}

/**
 * Minimum gap between auto-presence POSTs triggered by MCP tool activity.
 *
 * 3 minutes: the issue's proposal asks for "once per few minutes" (2-5min).
 * 3min sits in the middle of that range —
 *   - frequent enough that an actively-used agent survives at least one
 *     missed beat before crossing the 10-minute OFFLINE threshold
 *     (offlineThresholdMs() in resources/Presence.ts, default 600_000ms) —
 *     a dropped/delayed write doesn't flip the roster to offline;
 *   - infrequent enough that a hot loop (e.g. memory_search called several
 *     times a minute while an agent works through a task) doesn't turn every
 *     tool call into a presence write — this is the rate limiter's whole job.
 * Not tuned to the 90s ACTIVE threshold (idleThresholdMs(), default 90_000ms)
 * — matching that would mean heartbeating roughly every other tool call,
 * defeating the point of rate limiting. An agent that's genuinely active but
 * calls flair-mcp tools less than once every ~3min will read as "idle" (not
 * "offline") between heartbeats, which is the correct signal: idle already
 * means "present but no recent activity", exactly this case.
 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 3 * 60 * 1000;
const HEARTBEAT_INTERVAL_FLOOR_MS = 30_000;
const HEARTBEAT_INTERVAL_CEILING_MS = 15 * 60 * 1000;

/** Resolve the heartbeat rate-limit interval from env, clamped to a sane range
 *  (same validate-don't-trust-`??` pattern as FLAIR_MCP_PARENT_POLL_MS /
 *  FLAIR_HOOK_TIMEOUT_MS elsewhere in this package — an empty-string override
 *  must not silently become `0` and defeat the rate limit). */
export function resolveHeartbeatIntervalMs(): number {
  const raw = process.env.FLAIR_PRESENCE_HEARTBEAT_MS;
  const parsed = raw != null ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= HEARTBEAT_INTERVAL_FLOOR_MS && parsed <= HEARTBEAT_INTERVAL_CEILING_MS
    ? parsed
    : DEFAULT_HEARTBEAT_INTERVAL_MS;
}

// ─── Timeout ────────────────────────────────────────────────────────────────

/**
 * Per-write timeout for auto-presence POSTs. Deliberately much shorter than
 * FlairClient's general-purpose default (30s, client.ts DEFAULT_TIMEOUT) —
 * auto-presence is a side effect, never the reason a tool call or a session
 * hook waits. A dead/slow Flair daemon must not hold anything open.
 */
export const DEFAULT_PRESENCE_TIMEOUT_MS = 3_000;
const PRESENCE_TIMEOUT_FLOOR_MS = 500;
const PRESENCE_TIMEOUT_CEILING_MS = 10_000;

export function resolvePresenceTimeoutMs(): number {
  const raw = process.env.FLAIR_PRESENCE_TIMEOUT_MS;
  const parsed = raw != null ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= PRESENCE_TIMEOUT_FLOOR_MS && parsed <= PRESENCE_TIMEOUT_CEILING_MS
    ? parsed
    : DEFAULT_PRESENCE_TIMEOUT_MS;
}

/** Race a promise against a timeout. Rejects with a timeout error if exceeded.
 *  (Same idiom as session-start-hook.ts's withTimeout — duplicated rather than
 *  imported to keep this module dependency-free of that one; it's four lines.) */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("presence_post_timeout")), ms);
    (timer as unknown as { unref?: () => void }).unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// ─── POST body ──────────────────────────────────────────────────────────────

/**
 * Build the POST /Presence body. Exported so tests can pin the exact shape.
 * Never includes agentId — identity is attributed server-side from the
 * Ed25519 signature on the request (Presence.post(), agent-auth.ts), exactly
 * like flair_workspace_set / flair_orgevent in index.ts. currentTask is
 * omitted (not sent as null/empty) when absent, so callers that don't know a
 * task can still heartbeat without explicitly clearing one that was set
 * earlier — see postPresenceSafe()'s doc comment for why that matters.
 */
export function buildPresenceBody(activity: PresenceActivity, currentTask?: string): Record<string, unknown> {
  const body: Record<string, unknown> = { activity };
  if (currentTask) body.currentTask = currentTask;
  return body;
}

// ─── Fire-and-forget POST ───────────────────────────────────────────────────

/** Minimal surface a presence write needs from a Flair client — matches
 *  FlairClient.request()'s shape exactly, so the real client satisfies this
 *  with zero adapter code, and tests can inject a stub without a live server
 *  or a real FlairClient instance. */
export interface PresencePoster {
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
}

/**
 * POST /Presence and NEVER throw or reject — every failure mode (timeout,
 * network error, 401/403/500 from the server, a malformed response) is
 * caught and swallowed here, in this one place, so every call site gets the
 * guarantee for free instead of re-implementing it. Not awaiting the
 * returned promise is what makes a call site "fire and forget"; the promise
 * itself resolving-never-rejecting is what makes doing that safe (no
 * unhandled rejection even if a caller forgets the `.catch()` belt-and-
 * suspenders).
 *
 * currentTask is intentionally the caller's responsibility, not derived here:
 * Presence.post() (resources/Presence.ts) treats an ABSENT currentTask as an
 * explicit clear — `sanitizeCurrentTask(undefined)` returns `null`, which then
 * overwrites any previously-set task on every merge. That's correct for the
 * CLI (`flair presence set --activity X` with no `--task` IS an explicit "no
 * task" statement) but wrong for an automatic heartbeat, which should never
 * silently erase a task a human or bootstrap() set minutes earlier. Callers
 * that want tasks preserved across heartbeats must track and re-pass the last
 * known task themselves (see index.ts's `lastKnownTask` / session-start-hook's
 * per-invocation scope) — this function just forwards whatever it's given.
 */
export async function postPresenceSafe(
  poster: PresencePoster,
  activity: PresenceActivity,
  currentTask: string | undefined,
  timeoutMs: number,
): Promise<void> {
  try {
    await withTimeout(poster.request("POST", "/Presence", buildPresenceBody(activity, currentTask)), timeoutMs);
  } catch {
    // Silent by design — see doc comment above. A flair instance that's down
    // or slow must never slow down or break the caller.
  }
}
