/**
 * POST /Presence — agent heartbeat writes its own presence.
 * GET  /Presence — public-safe presence roster for The Office Space.
 *
 * Extends the auto-generated Presence table resource (from schema.graphql).
 * Overrides get() for public-safe roster and post() for Ed25519-authed
 * heartbeat writes.
 *
 * Auth:
 *   GET  — public (returns only allowlisted fields; safe for public renderer).
 *          currentTask is additionally content-gated to verified agents only
 *          (#592) — anonymous callers get the roster with currentTask=null.
 *   POST — Ed25519 agent credential (TPS-Ed25519 header). Agent writes only its
 *          own record; cross-agent writes are rejected (403).
 *
 * Security (Sherlock):
 *   - Write: per-agent Ed25519 auth. Cross-agent → 403.
 *   - Read: field-allowlisted to public-safe set. No secrets, no admin data.
 *   - currentTask is agent-authored free text → cap length, escape on render.
 *   - currentTask CONTENT gate (#592): the roster (id/displayName/role/
 *     runtime/activity/presenceStatus/lastHeartbeatAt) is genuinely
 *     public-safe and stays world-readable, but currentTask is free text that
 *     the coordination convention (`presence set --task "investigating
 *     <host>: <symptom>"`) has put customer names and preprod hostnames in.
 *     sanitizeCurrentTask() only trims/caps length — it does not redact
 *     content. get() additionally gates currentTask itself to verified
 *     in-org agents only; see get()'s inline comment.
 */

import { databases } from "@harperfast/harper";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { resolveAgentAuth, verifyAgentRequest } from "./agent-auth.js";
import { WINDOW_MS, isNonceReplay, recordNonce, importEd25519Key, b64ToArrayBuffer } from "./ed25519-auth.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const CURRENT_TASK_MAX_LENGTH = 200;
const VALID_ACTIVITIES = new Set(["coding", "reviewing", "planning", "debugging", "idle"]);

function idleThresholdMs(): number {
  const env = process.env.PRESENCE_IDLE_THRESHOLD_MS;
  return env ? Number(env) || 90_000 : 90_000;
}

function offlineThresholdMs(): number {
  const env = process.env.PRESENCE_OFFLINE_THRESHOLD_MS;
  return env ? Number(env) || 600_000 : 600_000;
}

// ─── Version stamping (flair#639) ──────────────────────────────────────────────
//
// Auto-presence (packages/flair-mcp/src/presence.ts, flair#608) gives agents a
// heartbeat, but the record never said which Flair *instance* served it —
// fleet skew across hosts was only discoverable by probing each one by hand.
// Every heartbeat now stamps the RUNNING server's own flair + harper versions,
// so `flair doctor`'s fleet-presence section (src/cli.ts + src/fleet-presence.ts)
// can flag stale instances org-relatively, no per-host probing required.

/**
 * Resolve the running @tpsdev-ai/flair version from package.json (duplicated
 * from resources/health.ts / admin-layout.ts / AdminInstance.ts — same "keep
 * in sync" idiom noted in those files: each resource module keeps its own
 * copy for dependency isolation rather than importing a shared helper).
 * `process.env.npm_package_version` is only populated inside `npm run`, so
 * reading package.json relative to THIS running module is the only way to
 * report the version of the code that's actually executing.
 */
function resolveVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(here, "..", "..", "package.json"),
      join(here, "..", "package.json"),
    ];
    for (const p of candidates) {
      if (existsSync(p)) {
        const pkg = JSON.parse(readFileSync(p, "utf-8"));
        if (pkg.version) return pkg.version;
      }
    }
  } catch { /* fall through */ }
  return process.env.npm_package_version ?? "dev";
}

/**
 * Resolve the running @harperfast/harper version. Unlike flair's own
 * package.json (readable via a plain relative path above), Harper's package
 * only exports "." → dist/index.js — there's no "./package.json" subpath, so
 * requiring it directly throws (Node's exports-map enforcement). Resolve the
 * main entry via createRequire instead, then walk up from dist/index.js to
 * the package root's package.json. Returns null (not a placeholder string)
 * on failure so callers/readers can tell "genuinely unknown" apart from a
 * real version — same tri-state as fabric-upgrade.ts's last-resort Harper
 * version lookup.
 */
function resolveHarperVersion(): string | null {
  try {
    const req = createRequire(import.meta.url);
    const mainPath = req.resolve("@harperfast/harper");
    const pkgPath = join(dirname(mainPath), "..", "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (typeof pkg.version === "string") return pkg.version;
    }
  } catch { /* fall through */ }
  return null;
}

/**
 * Build the record to persist for a presence heartbeat. Pure — no Harper
 * calls, no version resolution of its own — so the record SHAPE (and post()'s
 * merge-vs-insert plumbing around it) can be unit-tested without a live
 * Harper or the real filesystem. Callers pass already-resolved versions
 * (resolveVersion()/resolveHarperVersion() above), so tests can pin them
 * directly. Mirrors buildPresenceBody() in packages/flair-mcp/src/presence.ts
 * — same "exported pure builder, exported for tests" idiom, server side.
 */
export function buildPresenceRecord(
  agentId: string,
  now: number,
  currentTask: unknown,
  activity: string | undefined,
  existingActivity: string | undefined,
  existingActivityUpdatedAt: number | null | undefined,
  flairVersion: string,
  harperVersion: string | null,
): Record<string, unknown> {
  // A heartbeat "asserts" what the agent is doing when it carries an activity
  // and/or a (non-empty) currentTask. Only such a beat re-stamps
  // activityUpdatedAt to `now`; a pure liveness beat (neither field) refreshes
  // lastHeartbeatAt but PRESERVES the prior stamp — so activity ages on its own
  // and lapses to last-known once the agent stops asserting it, with no manual
  // clear (natural-presence). Backward compatible: today every real heartbeat
  // carries activity, so this simply keeps activity fresh while an agent works.
  const asserted = activity !== undefined || sanitizeCurrentTask(currentTask) !== null;
  return {
    agentId,
    lastHeartbeatAt: now,
    currentTask: sanitizeCurrentTask(currentTask),
    activity: activity ?? (existingActivity ?? "idle"),
    activityUpdatedAt: asserted ? now : (existingActivityUpdatedAt ?? null),
    flairVersion,
    harperVersion,
  };
}

// ─── Nonce replay + crypto helpers ─────────────────────────────────────────────
// WINDOW_MS, isNonceReplay/recordNonce (the ONE shared nonce store), and
// importEd25519Key all live in ./ed25519-auth.ts — the single
// shared implementation imported by auth-middleware.ts, agent-auth.ts, and
// Presence.ts so a nonce recorded via any one of the three call sites is
// visible to the other two, and the crypto/decoder logic can't drift.

// ─── Status derivation (pure — exported for unit testing) ─────────────────────

export function derivePresenceStatus(
  now: number,
  lastHeartbeatAt: number | null | undefined,
  idleMs?: number,
  offlineMs?: number,
): "active" | "idle" | "offline" {
  const idle = idleMs ?? idleThresholdMs();
  const offline = offlineMs ?? offlineThresholdMs();

  if (lastHeartbeatAt == null || !Number.isFinite(lastHeartbeatAt)) return "offline";
  const elapsed = now - lastHeartbeatAt;

  if (elapsed < 0) return "active";
  if (elapsed < idle) return "active";
  if (elapsed < offline) return "idle";
  return "offline";
}

// ─── Activity decay (natural-presence) ─────────────────────────────────────────
//
// Presence is a LIVENESS BEACON, not a sticky status board: an offline agent
// has, by definition, no *current* activity, so returning its last `activity`
// / `currentTask` as if live is a lie (an agent offline 13 days still read as
// `activity: "debugging"`; another showed a finished-task `currentTask` 20h
// after going dark). These two pure functions decide "is this record's
// activity still CURRENT, or has it lapsed into last-known?" — same offline
// threshold, and the SAME graceful-degradation-on-old-records discipline, as
// derivePresenceStatus() above and flair#639's version staleness.

/**
 * Resolve the timestamp used to judge activity freshness. Prefer the per-field
 * `activityUpdatedAt` stamp (additive/nullable, mirrors flair#639); fall back
 * to `lastHeartbeatAt` for records written before this feature existed — so an
 * old row degrades to "activity is exactly as fresh as its heartbeat" (never
 * claiming activity is FRESHER than the beat that carried it) rather than
 * reading as permanently stale or throwing. Returns null only when NEITHER is
 * a finite number (nothing to judge against → treated as stale by callers).
 */
export function activityFreshnessAt(
  activityUpdatedAt: number | null | undefined,
  lastHeartbeatAt: number | null | undefined,
): number | null {
  if (typeof activityUpdatedAt === "number" && Number.isFinite(activityUpdatedAt)) return activityUpdatedAt;
  if (typeof lastHeartbeatAt === "number" && Number.isFinite(lastHeartbeatAt)) return lastHeartbeatAt;
  return null;
}

/**
 * Pure decay rule: is a record's activity/currentTask still CURRENT? Activity
 * is fresh while its freshness stamp is younger than the SAME offline
 * threshold that flips presenceStatus to "offline" — so an offline agent can
 * never present a live-looking activity label. Because the stamp only moves
 * forward when a heartbeat actually carries activity (see buildPresenceRecord),
 * activity also lapses INDEPENDENTLY of raw liveness: an agent that keeps
 * heartbeating liveness but stops asserting what it's doing decays to
 * last-known on its own, no manual "clear" call needed. Clock skew (a stamp in
 * the future) is treated as fresh, matching derivePresenceStatus().
 */
export function isActivityFresh(
  now: number,
  activityUpdatedAt: number | null | undefined,
  lastHeartbeatAt: number | null | undefined,
  offlineMs?: number,
): boolean {
  const offline = offlineMs ?? offlineThresholdMs();
  const at = activityFreshnessAt(activityUpdatedAt, lastHeartbeatAt);
  if (at == null) return false;
  const elapsed = now - at;
  if (elapsed < 0) return true;
  return elapsed < offline;
}

// ─── Public-safe field allowlist ──────────────────────────────────────────────

// flairVersion/harperVersion (flair#639) are content-gated the SAME way as
// currentTask (see get()'s includeVerifiedFields) even though version
// numbers aren't free text — precedent is HealthDetail vs the public /Health
// endpoint (resources/health.ts): version info is deliberately withheld from
// anonymous callers to avoid fingerprinting a publicly exposed instance for
// known-CVE targeting. Anonymous readers get null for both, same as currentTask.
// activity/lastActivity/activityUpdatedAt/activityAgeMs/activityFresh
// (natural-presence) are all public-safe: `activity` and `lastActivity` are a
// fixed vocabulary label (coding|reviewing|planning|debugging|idle), the two timestamps
// and the boolean are liveness metadata of the same class as the already-public
// lastHeartbeatAt. Only `currentTask` (free text) stays content-gated to
// verified readers — see get()'s includeVerifiedFields.
const ROSTER_ALLOWLIST = new Set([
  "id",
  "displayName",
  "role",
  "runtime",
  "activity",
  "lastActivity",
  "activityUpdatedAt",
  "activityAgeMs",
  "activityFresh",
  "presenceStatus",
  "currentTask",
  "lastHeartbeatAt",
  "flairVersion",
  "harperVersion",
]);

function sanitizeCurrentTask(task: unknown): string | null {
  if (typeof task !== "string") return null;
  const trimmed = task.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, CURRENT_TASK_MAX_LENGTH);
}

function pickAllowlisted(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (ROSTER_ALLOWLIST.has(key)) out[key] = record[key];
  }
  return out;
}

// ─── Resource ─────────────────────────────────────────────────────────────────

/**
 * Extends the auto-generated Presence table resource (from schema.graphql) so
 * Harper resolves the /Presence path without conflict. Overrides get() for the
 * public-safe roster view and post() for Ed25519-authed heartbeat writes.
 */
export class Presence extends (databases as any).flair.Presence {
  /** Bypass Harper's role gate for GET (public-safe data only). */
  allowRead() {
    return true;
  }

  /** Bypass Harper's role gate for POST (Ed25519 auth handled internally). */
  allowCreate() {
    return true;
  }

  /**
   * GET /Presence — public-safe presence roster.
   *
   * Joins Presence records with Agent metadata and derives presenceStatus.
   * Only allowlisted fields are returned (no secrets, no admin data).
   *
   * currentTask CONTENT gate (#592): Harper routes every GET — collection
   * (`GET /Presence`) AND single-record (`GET /Presence/<id>`) — through this
   * SAME method (REST.js: `resource.get(target, request)`, one call site for
   * both; this override ignores `target` and always returns the full roster
   * array), so gating once here, before the loop, covers every read path with
   * no separate return site to miss.
   *
   * The gate keys off a valid TPS-Ed25519 SIGNATURE (verifyAgentRequest),
   * NOT resolveAgentAuth()/allowVerified — and that distinction is the whole
   * fix. /Presence is a public-passthrough in auth-middleware.ts: the
   * middleware early-returns WITHOUT annotating tpsAgent/tpsAnonymous, so a
   * resource-level resolver never sees a gate annotation for this path. Worse,
   * Harper's `authorizeLocal` (config default true) auto-authorizes any
   * *credential-less* loopback request as super_user — it injects request.user
   * ONLY "when there is no Authorization header" (node .../server/http.js). So a
   * bare, unauthenticated `GET /Presence` from loopback (exactly the anonymous
   * caller the issue is about, and what the integration test exercises against
   * a real spawned Harper) arrives with request.user = super_user and NO
   * signature. resolveAgentAuth() would classify that as `kind:"agent"` (its
   * super_user branch) and leak currentTask — which it did, against real
   * Harper, even though mocked unit tests using tpsAgent annotations passed.
   * A TPS-Ed25519 signature, by contrast, cannot be manufactured by
   * authorizeLocal (it requires the Authorization header, which suppresses the
   * super_user injection), so verifyAgentRequest() cleanly separates a real
   * in-org agent from an anonymous/loopback/Basic-admin caller. Only a valid
   * agent signature gets currentTask; everything else (anonymous, loopback
   * super_user, Basic-admin, internal in-process) gets currentTask=null.
   * allowRead() is UNCHANGED (still `true`) — the roster itself stays public;
   * only the free-text field is gated, per the issue's field-level option.
   *
   * flairVersion/harperVersion (flair#639) ride the SAME gate, renamed to
   * includeVerifiedFields since it now covers more than currentTask — see the
   * ROSTER_ALLOWLIST comment above for why version numbers are gated too.
   */
  async get() {
    // Extract the raw request the same way post() does (getContext().request
    // is populated for GET; fall back to the context itself). verifyAgentRequest
    // returns the agent for a valid TPS-Ed25519 signature, else null — see the
    // gate rationale above. Memoized per-request, so this is a no-op if any
    // other path already verified the same request.
    const ctx = (this as any).getContext?.();
    const request = ctx?.request ?? ctx;
    const agentAuth = request ? await verifyAgentRequest(request) : null;
    const includeVerifiedFields = agentAuth !== null;

    const now = Date.now();
    const idleThreshold = idleThresholdMs();
    const offlineThreshold = offlineThresholdMs();
    const results: Record<string, unknown>[] = [];

    try {
      const presenceRows = (databases as any).flair.Presence.search();
      for await (const row of presenceRows) {
        const agentId = row?.agentId;
        if (!agentId) continue;

        let agent: any = null;
        try {
          agent = await (databases as any).flair.Agent.get(agentId);
        } catch { /* agent may not exist or be deactivated */ }

        const lastHeartbeatAt = typeof row?.lastHeartbeatAt === "number"
          ? row.lastHeartbeatAt
          : Number(row?.lastHeartbeatAt ?? 0);
        // activityUpdatedAt is BigInt in the schema (Harper may hand it back as
        // number|string|bigint) and absent on pre-feature records — normalize
        // to a finite number or null so activityFreshnessAt() can fall back.
        const activityUpdatedAt = row?.activityUpdatedAt == null
          ? null
          : (typeof row.activityUpdatedAt === "number" ? row.activityUpdatedAt : Number(row.activityUpdatedAt));

        // NATURAL PRESENCE: bind activity/currentTask to freshness. A stale
        // record has no *current* activity — present the last-known label under
        // dedicated fields, never as the live `activity`. `activity` is the
        // CURRENT truth (falls to "idle" — the "nothing right now" vocabulary
        // value — once stale); `lastActivity` preserves the raw last-known
        // label so a reader can render "offline (was: coding)".
        const rawActivity = (typeof row?.activity === "string" && row.activity.length > 0)
          ? row.activity
          : "idle";
        const activityFresh = isActivityFresh(now, activityUpdatedAt, lastHeartbeatAt, offlineThreshold);
        const freshnessAt = activityFreshnessAt(activityUpdatedAt, lastHeartbeatAt);

        const entry: Record<string, unknown> = {
          id: agentId,
          displayName: agent?.displayName ?? agent?.name ?? agentId,
          role: agent?.role ?? "agent",
          runtime: agent?.runtime ?? null,
          // Current activity — only truthful while fresh; "idle" once decayed.
          activity: activityFresh ? rawActivity : "idle",
          // Last-known activity label regardless of freshness (public-safe, same
          // vocabulary as activity) → enables "was: <activity>" rendering.
          lastActivity: rawActivity,
          // When activity was last asserted (resolved; falls back to
          // lastHeartbeatAt for pre-feature records — see activityFreshnessAt).
          activityUpdatedAt: freshnessAt,
          // How stale that assertion is, so a reader can show "was active Xh
          // ago" without needing the server's clock or the threshold.
          activityAgeMs: freshnessAt != null ? Math.max(0, now - freshnessAt) : null,
          // The server's verdict — makes staleness impossible to misread.
          activityFresh,
          presenceStatus: derivePresenceStatus(
            now,
            lastHeartbeatAt,
            idleThreshold,
            offlineThreshold,
          ),
          // currentTask is current only when the reader is verified AND the
          // record is fresh. A stale record's task (a finished-task string it
          // never cleared) is NOT current → null, same as the anonymous case.
          // Anonymous/unverified readers always get null (key stays present,
          // schema-stable) — see the currentTask CONTENT gate doc above get().
          currentTask: (includeVerifiedFields && activityFresh) ? sanitizeCurrentTask(row?.currentTask) : null,
          lastHeartbeatAt,
          // flair#639: absent on records written before this feature (older
          // instance, never re-heartbeated since upgrading) — `row?.field ??
          // null` tolerates that directly, same as every other optional field
          // here. Gated to verified readers; see ROSTER_ALLOWLIST comment.
          flairVersion: includeVerifiedFields ? (row?.flairVersion ?? null) : null,
          harperVersion: includeVerifiedFields ? (row?.harperVersion ?? null) : null,
        };

        results.push(pickAllowlisted(entry));
      }
    } catch (err: any) {
      return new Response(
        JSON.stringify({ error: "presence_query_failed", detail: err?.message }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }

    return results;
  }

  /**
   * POST /Presence — agent heartbeat.
   *
   * Auth: TPS-Ed25519 header required. agentId from signature, NOT from body.
   * An agent may update ONLY its own presence; cross-agent writes → 403.
   *
   * Bypasses Harper's default table post handler — writes via databases.flair.Presence
   * directly so we control auth flow end-to-end.
   */
  async post(content: any, context?: any) {
    const ctx = (this as any).getContext?.();
    const request = ctx?.request ?? ctx;

    // ── Parse Ed25519 auth header ────────────────────────────────────────────
    const authHeader: string =
      request?.headers?.get?.("authorization") ??
      request?.headers?.asObject?.authorization ??
      "";

    // If the middleware already verified and set tpsAgent, trust it
    const middlewareAgent: string | undefined = request?.tpsAgent;

    let agentId: string;

    if (middlewareAgent) {
      agentId = middlewareAgent;
    } else {
      const m = authHeader.match(/^TPS-Ed25519\s+([^:]+):(\d+):([^:]+):(.+)$/);
      if (!m) {
        return new Response(
          JSON.stringify({ error: "Ed25519 agent auth required for heartbeat" }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      }

      const [, headerAgentId, tsRaw, nonce, sigB64] = m;
      const ts = Number(tsRaw);
      const now = Date.now();

      if (!Number.isFinite(ts) || Math.abs(now - ts) > WINDOW_MS) {
        return new Response(
          JSON.stringify({ error: "timestamp_out_of_window" }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      }

      if (isNonceReplay(headerAgentId, nonce, now)) {
        return new Response(
          JSON.stringify({ error: "nonce_replay_detected" }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      }

      const agent = await (databases as any).flair.Agent.get(headerAgentId).catch(() => null);
      if (!agent) {
        return new Response(
          JSON.stringify({ error: "unknown_agent" }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      }

      try {
        // request.url is just the path portion (e.g. "/Presence")
        const pathname = (request.url ?? "/Presence").split("?")[0];
        const payload = `${headerAgentId}:${tsRaw}:${nonce}:POST:${pathname}`;
        const key = await importEd25519Key(agent.publicKey);
        const sigBuf = b64ToArrayBuffer(sigB64);
        const payloadBuf = new TextEncoder().encode(payload);

        const ok = await crypto.subtle.verify(
          { name: "Ed25519" } as any,
          key,
          sigBuf,
          payloadBuf,
        );
        if (!ok) {
          return new Response(
            JSON.stringify({ error: "invalid_signature" }),
            { status: 401, headers: { "Content-Type": "application/json" } },
          );
        }
      } catch (e: any) {
        return new Response(
          JSON.stringify({ error: "signature_verification_failed", detail: e?.message }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      }

      recordNonce(headerAgentId, nonce, ts);
      agentId = headerAgentId;
    }

    // ── Validate body ────────────────────────────────────────────────────────
    const { currentTask, activity } = content || {};

    if (activity !== undefined && !VALID_ACTIVITIES.has(activity)) {
      return new Response(
        JSON.stringify({
          error: "invalid_activity",
          detail: `activity must be one of: ${[...VALID_ACTIVITIES].join(", ")}`,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // ── Write presence ───────────────────────────────────────────────────────
    const now = Date.now();

    try {
      let existing: any = null;
      try {
        existing = await (databases as any).flair.Presence.get(agentId);
      } catch { /* first heartbeat */ }

      // flair#639: stamp THIS server's own running versions on every
      // heartbeat — an upgrade takes effect on the instance's very next
      // heartbeat, no separate migration needed.
      const record = buildPresenceRecord(
        agentId,
        now,
        currentTask,
        activity,
        existing?.activity,
        // Preserve the prior activity-freshness stamp when THIS beat asserts no
        // activity/task (pure liveness) — normalize the BigInt-ish stored value
        // to a number so buildPresenceRecord's `?? null` fallback behaves.
        existing?.activityUpdatedAt == null ? null : Number(existing.activityUpdatedAt),
        resolveVersion(),
        resolveHarperVersion(),
      );

      if (existing) {
        const merged = { ...existing, ...record };
        await (databases as any).flair.Presence.put(merged);
      } else {
        await (databases as any).flair.Presence.put(record);
      }

      return {
        ok: true,
        agentId,
        lastHeartbeatAt: now,
        presenceStatus: "active" as const,
      };
    } catch (e: any) {
      return new Response(
        JSON.stringify({ error: "presence_write_failed", detail: e?.message }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
  }

  /**
   * PUT/DELETE are not part of the agent heartbeat contract (writes go through
   * POST, which carries its own Ed25519 auth). GET is intentionally public and
   * allowCreate=true lets POST self-auth — but those bypasses must NOT extend to
   * PUT/DELETE. The non-rejecting gate would otherwise let anonymous PUT/DELETE
   * straight to Harper's default handler (the leak this closes). Require a verified
   * non-anonymous principal, scoped to the agent's own record (Presence is keyed
   * by agentId).
   */
  async put(content: any, context?: any) {
    const auth = await resolveAgentAuth((this as any).getContext?.());
    if (auth.kind === "anonymous") {
      return new Response(JSON.stringify({ error: "authentication required" }), { status: 401, headers: { "Content-Type": "application/json" } });
    }
    if (auth.kind === "agent" && !auth.isAdmin && content?.agentId && content.agentId !== auth.agentId) {
      return new Response(JSON.stringify({ error: "forbidden: cannot write presence for another agent" }), { status: 403, headers: { "Content-Type": "application/json" } });
    }
    return super.put(content, context);
  }

  async delete(id: any) {
    const auth = await resolveAgentAuth((this as any).getContext?.());
    if (auth.kind === "anonymous") {
      return new Response(JSON.stringify({ error: "authentication required" }), { status: 401, headers: { "Content-Type": "application/json" } });
    }
    if (auth.kind === "agent" && !auth.isAdmin && id != null && String(id) !== auth.agentId) {
      return new Response(JSON.stringify({ error: "forbidden: cannot delete presence for another agent" }), { status: 403, headers: { "Content-Type": "application/json" } });
    }
    return super.delete(id);
  }
}
