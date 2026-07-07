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
import { resolveAgentAuth, verifyAgentRequest } from "./agent-auth.js";
import { WINDOW_MS, isNonceReplay, recordNonce, importEd25519Key, b64ToArrayBuffer } from "./ed25519-auth.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const CURRENT_TASK_MAX_LENGTH = 200;
const VALID_ACTIVITIES = new Set(["coding", "reviewing", "planning", "idle"]);

function idleThresholdMs(): number {
  const env = process.env.PRESENCE_IDLE_THRESHOLD_MS;
  return env ? Number(env) || 90_000 : 90_000;
}

function offlineThresholdMs(): number {
  const env = process.env.PRESENCE_OFFLINE_THRESHOLD_MS;
  return env ? Number(env) || 600_000 : 600_000;
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

// ─── Public-safe field allowlist ──────────────────────────────────────────────

const ROSTER_ALLOWLIST = new Set([
  "id",
  "displayName",
  "role",
  "runtime",
  "activity",
  "presenceStatus",
  "currentTask",
  "lastHeartbeatAt",
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
    const includeCurrentTask = agentAuth !== null;

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

        const entry: Record<string, unknown> = {
          id: agentId,
          displayName: agent?.displayName ?? agent?.name ?? agentId,
          role: agent?.role ?? "agent",
          runtime: agent?.runtime ?? null,
          activity: row?.activity ?? "idle",
          presenceStatus: derivePresenceStatus(
            now,
            typeof row?.lastHeartbeatAt === "number"
              ? row.lastHeartbeatAt
              : Number(row?.lastHeartbeatAt ?? 0),
            idleThreshold,
            offlineThreshold,
          ),
          // Anonymous/unverified readers get `null` here (key stays present,
          // schema-stable) instead of the sanitized task text — see the
          // currentTask CONTENT gate doc above get().
          currentTask: includeCurrentTask ? sanitizeCurrentTask(row?.currentTask) : null,
          lastHeartbeatAt: typeof row?.lastHeartbeatAt === "number"
            ? row.lastHeartbeatAt
            : Number(row?.lastHeartbeatAt ?? 0),
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

      const record: Record<string, unknown> = {
        agentId,
        lastHeartbeatAt: now,
        currentTask: sanitizeCurrentTask(currentTask),
        activity: activity ?? (existing?.activity ?? "idle"),
      };

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
