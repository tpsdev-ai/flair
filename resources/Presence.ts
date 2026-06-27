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
 *   POST — Ed25519 agent credential (TPS-Ed25519 header). Agent writes only its
 *          own record; cross-agent writes are rejected (403).
 *
 * Security (Sherlock):
 *   - Write: per-agent Ed25519 auth. Cross-agent → 403.
 *   - Read: field-allowlisted to public-safe set. No secrets, no admin data.
 *   - currentTask is agent-authored free text → cap length, escape on render.
 */

import { databases } from "@harperfast/harper";
import { resolveAgentAuth } from "./agent-auth.js";
import { b64ToArrayBuffer } from "./b64.js";
import { MCP_HIDDEN } from "./mcp-curation.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const WINDOW_MS = 30_000;
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

// ─── Nonce replay protection ──────────────────────────────────────────────────

const nonceSeen = new Map<string, number>();

function pruneNonces() {
  const now = Date.now();
  for (const [k, ts] of nonceSeen.entries()) {
    if (now - ts > WINDOW_MS) nonceSeen.delete(k);
  }
}

// ─── Crypto helpers ───────────────────────────────────────────────────────────
// b64ToArrayBuffer lives in ./b64.ts (shared with auth-middleware.ts + agent-auth.ts
// so the base64/base64url decoder can't drift across the three auth call sites).

const keyCache = new Map<string, CryptoKey>();

async function importEd25519Key(publicKeyStr: string): Promise<CryptoKey> {
  if (keyCache.has(publicKeyStr)) return keyCache.get(publicKeyStr)!;
  let raw: ArrayBuffer;
  if (/^[0-9a-f]{64}$/i.test(publicKeyStr)) {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = parseInt(publicKeyStr.slice(i * 2, i * 2 + 2), 16);
    raw = bytes.buffer;
  } else {
    raw = b64ToArrayBuffer(publicKeyStr);
  }
  const key = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" } as any, false, ["verify"]);
  keyCache.set(publicKeyStr, key);
  return key;
}

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
  // Suppress from the native MCP application profile (only FlairMcp is exposed). See mcp-curation.ts.
  static hidden = MCP_HIDDEN;
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
   */
  async get() {
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
          currentTask: sanitizeCurrentTask(row?.currentTask),
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

      pruneNonces();
      const nonceKey = `${headerAgentId}:${nonce}`;
      if (nonceSeen.has(nonceKey)) {
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

      nonceSeen.set(nonceKey, ts);
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
