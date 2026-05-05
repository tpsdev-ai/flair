import { patchRecord } from "./table-helpers.js";
import { server, databases } from "@harperfast/harper";
import { getEmbedding } from "./embeddings-provider.js";

// --- Admin credentials ---
// Admin auth is sourced exclusively from Harper's own environment variables
// (HDB_ADMIN_PASSWORD / FLAIR_ADMIN_PASSWORD). No filesystem token file.
//
// FLAIR_ADMIN_TOKEN env var is still accepted for backwards compat but
// emits a deprecation warning on first use.
//
// No permanent cache — env vars are read on every call. This is a no-op
// performance-wise (env reads are fast) but means a process restart with a
// different password works immediately without stale state.
let _deprecationWarned = false;

function getAdminPass(): string | null {
  // Primary source: Harper's own admin password (set at startup via env)
  const primary = process.env.HDB_ADMIN_PASSWORD ?? process.env.FLAIR_ADMIN_PASSWORD;
  if (primary) return primary;

  // Backwards compat: FLAIR_ADMIN_TOKEN (deprecated — never write to disk)
  if (process.env.FLAIR_ADMIN_TOKEN) {
    if (!_deprecationWarned) {
      console.warn("[auth] DEPRECATION: FLAIR_ADMIN_TOKEN is deprecated. Use HDB_ADMIN_PASSWORD instead.");
      _deprecationWarned = true;
    }
    return process.env.FLAIR_ADMIN_TOKEN;
  }

  // No admin password configured — return null and let callers fall through
  return null;
}

const WINDOW_MS = 30_000;
const nonceSeen = new Map<string, number>();

// ─── Admin resolution ─────────────────────────────────────────────────────────
// Admin agents: from FLAIR_ADMIN_AGENTS env var (comma-separated) OR
// Agent records with role === "admin". Both sources are OR-combined.
// Result is cached for 60s to avoid per-request DB hits.

let adminCacheExpiry = 0;
let adminCache: Set<string> = new Set();

async function getAdminAgents(): Promise<Set<string>> {
  const now = Date.now();
  if (now < adminCacheExpiry) return adminCache;

  const from_env = (process.env.FLAIR_ADMIN_AGENTS ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);

  let from_db: string[] = [];
  try {
    const results = await (databases as any).flair.Agent.search([{ attribute: "role", value: "admin", condition: "equals" }]);
    for await (const row of results) {
      if (row?.id) from_db.push(row.id);
    }
  } catch { /* Agent table might not be populated yet */ }

  adminCache = new Set([...from_env, ...from_db]);
  adminCacheExpiry = now + 60_000;
  return adminCache;
}

export async function isAdmin(agentId: string): Promise<boolean> {
  const admins = await getAdminAgents();
  return admins.has(agentId);
}

// ─── Crypto helpers ───────────────────────────────────────────────────────────

function b64ToArrayBuffer(b64: string): ArrayBuffer {
  // Handle both standard and URL-safe base64
  const std = b64.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(std);
  const buf = new ArrayBuffer(bin.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
  return buf;
}

const keyCache = new Map<string, CryptoKey>();
async function importEd25519Key(publicKeyStr: string): Promise<CryptoKey> {
  if (keyCache.has(publicKeyStr)) return keyCache.get(publicKeyStr)!;
  // Accept hex (64-char) or base64 (44-char) encoded 32-byte Ed25519 public key
  let raw: ArrayBuffer;
  if (/^[0-9a-f]{64}$/i.test(publicKeyStr)) {
    // Hex-encoded raw key (TPS CLI default: Buffer.toString('hex'))
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


async function backfillEmbedding(memoryId: string): Promise<void> {
  try {
    const record = await (databases as any).flair.Memory.get(memoryId);
    if (!record?.content) return;
    if (record.embedding?.length > 100) return;
    const embedding = await getEmbedding(record.content);
    if (!embedding) return;
    await patchRecord((databases as any).flair.Memory, memoryId, { embedding });
    console.log(`[auto-embed] ${memoryId}: ${embedding.length}d`);
  } catch (err: any) {
    console.error(`[auto-embed] Failed for ${memoryId}: ${err.message}`);
  }
}

// ─── HTTP middleware ──────────────────────────────────────────────────────────

server.http(async (request: any, nextLayer: any) => {
  const url = new URL(request.url, "http://" + (request.headers.get("host") || "localhost"));

  if (
    url.pathname === "/health" ||
    url.pathname === "/Health" ||
    url.pathname === "/a2a" ||
    url.pathname === "/A2AAdapter" ||
    url.pathname === "/AgentCard" ||
    url.pathname.startsWith("/A2AAdapter/") ||
    url.pathname.startsWith("/AgentCard/") ||
    // FederationSync uses Ed25519 body-signature auth (handled by the resource)
    url.pathname === "/FederationSync" ||
    // FederationPair uses one-time PairingToken in the request body, validated
    // by the resource itself (allowCreate=true on the Resource lets anonymous
    // POST through Harper's role gate). Bearer can't be used here because
    // Harper's auth layer claims any "Bearer X" Authorization header for itself.
    url.pathname === "/FederationPair" ||
    // OAuth 2.1 public endpoints (spec requires no pre-auth)
    url.pathname === "/OAuthRegister" ||
    url.pathname === "/OAuthAuthorize" ||
    url.pathname === "/OAuthToken" ||
    url.pathname === "/OAuthRevoke" ||
    url.pathname === "/.well-known/oauth-authorization-server" ||
    url.pathname === "/OAuthMetadata" ||
    // ObservationCenter HTML shell is public — the page itself is just markup
    // and inline JS, with no embedded data. The JS prompts for admin-pass and
    // auths every API call (/Agent, /SemanticSearch, /FederationPeers, etc).
    // Without this allow-list entry, the HTML is 401-blocked on hosted Flair
    // instances (rockit-local works only because authorizeLocal=true).
    url.pathname === "/ObservationCenter"
  ) return nextLayer(request);

  // If Harper has already authorized this request (e.g. authorizeLocal=true on localhost),
  // trust Harper's auth decision and pass through without requiring additional headers.
  if (request.user?.role?.permission?.super_user === true) {
    return nextLayer(request);
  }

  // Skip re-entry: if we already swapped auth to Basic, pass through
  if ((request as any)._tpsAuthVerified) return nextLayer(request);

  const header = request.headers.get("authorization") || request.headers?.asObject?.authorization || "";

  // ── Basic admin / super_user auth ──────────────────────────────────────────
  // Allow Basic auth for CLI operations (backup, etc.). Two paths:
  // 1. HDB_ADMIN_PASSWORD env-var fast-path (user must be "admin" with exact pass)
  // 2. Harper super_user check — any user with super_user:true permission accepted
  // Checked BEFORE Ed25519 so admin tools can use simple auth.
  if (header.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(header.slice(6), "base64").toString("utf-8");
      const colonIdx = decoded.indexOf(":");
      const user = colonIdx >= 0 ? decoded.slice(0, colonIdx) : decoded;
      const pass = colonIdx >= 0 ? decoded.slice(colonIdx + 1) : "";

      // Path 1: Env-var fast-path (back-compat). Only matches user==="admin"
      // with exact HDB_ADMIN_PASSWORD. Non-match falls through to Path 2.
      const adminPass = getAdminPass();
      if (adminPass !== null && user === "admin" && pass === adminPass) {
        // Mark as verified and set Harper user directly
        (request as any)._tpsAuthVerified = true;
        try {
          request.user = await (server as any).getUser("admin", null, request);
        } catch { /* fallback: let original Basic header pass through */ }
        request.headers.set("x-tps-agent", "admin");
        if (request.headers.asObject) (request.headers.asObject as any)["x-tps-agent"] = "admin";
        request.tpsAgent = "admin";
        request.tpsAgentIsAdmin = true;
        return nextLayer(request);
      }

      // Path 2: Harper super_user check — any user with super_user:true
      let harperUser: any = null;
      try {
        harperUser = await (server as any).getUser(user, pass, request);
      } catch { /* fall through — invalid creds, non-existent user, etc. */ }

      if (harperUser?.role?.permission?.super_user === true) {
        (request as any)._tpsAuthVerified = true;
        request.user = harperUser;
        request.headers.set("x-tps-agent", user);
        if (request.headers.asObject) (request.headers.asObject as any)["x-tps-agent"] = user;
        request.tpsAgent = user;
        request.tpsAgentIsAdmin = true;
        return nextLayer(request);
      }

      // Path 3: flair_pair_initiator — restricted to /FederationPair only.
      // Bootstrap credentials (pair-bootstrap-<id>) may only be used on this
      // one endpoint. Any other path must fall through to 401.
      if (url.pathname === "/FederationPair" && user.startsWith("pair-bootstrap-")) {
        let pairUser: any = null;
        try {
          pairUser = await (server as any).getUser(user, pass, request);
        } catch { /* fall through */ }

        if (
          pairUser?.role === "flair_pair_initiator" &&
          pairUser?.active === true
        ) {
          (request as any)._tpsAuthVerified = true;
          request.user = pairUser;
          request.headers.set("x-tps-agent", user);
          if (request.headers.asObject) (request.headers.asObject as any)["x-tps-agent"] = user;
          request.tpsAgent = user;
          request.tpsAgentIsAdmin = false;
          return nextLayer(request);
        }
      }
    } catch { /* fall through to Ed25519 check */ }
    return new Response(JSON.stringify({ error: "invalid_admin_credentials" }), { status: 401 });
  }

  // ── Ed25519 agent auth ────────────────────────────────────────────────────
  const m = header.match(/^TPS-Ed25519\s+([^:]+):(\d+):([^:]+):(.+)$/);

  if (!m) {
    return new Response(JSON.stringify({ error: "missing_or_invalid_authorization" }), { status: 401 });
  }

  const [, agentId, tsRaw, nonce, signatureB64] = m;
  const ts = Number(tsRaw);
  const now = Date.now();

  if (!Number.isFinite(ts) || Math.abs(now - ts) > WINDOW_MS)
    return new Response(JSON.stringify({ error: "timestamp_out_of_window" }), { status: 401 });

  for (const [k, signatureTs] of nonceSeen.entries())
    if (now - signatureTs > WINDOW_MS) nonceSeen.delete(k);

  const nonceKey = `${agentId}:${nonce}`;
  if (nonceSeen.has(nonceKey))
    return new Response(JSON.stringify({ error: "nonce_replay_detected" }), { status: 401 });

  const agent = await (databases as any).flair.Agent.get(agentId);
  if (!agent) return new Response(JSON.stringify({ error: "unknown_agent" }), { status: 401 });

  try {
    const payload = `${agentId}:${tsRaw}:${nonce}:${request.method}:${url.pathname}${url.search}`;
    const key = await importEd25519Key(agent.publicKey);
    const sigBuf = b64ToArrayBuffer(signatureB64);
    const payloadBuf = new TextEncoder().encode(payload);
      const ok = await crypto.subtle.verify(
      { name: "Ed25519" } as any, key,
      sigBuf,
      payloadBuf
    );
      if (!ok) return new Response(JSON.stringify({ error: "invalid_signature" }), { status: 401 });
  } catch (e: any) {
      return new Response(JSON.stringify({ error: "signature_verification_failed", detail: e?.message }), { status: 401 });
  }

  nonceSeen.set(nonceKey, ts);
  request.tpsAgent = agentId;
  (request as any)._tpsAuthVerified = true;
  request.tpsAgentIsAdmin = await isAdmin(agentId);

  // Swap the Authorization header to Basic admin auth so Harper's internal auth
  // pipeline (passport) authenticates the request with full permissions including
  // HNSW vector search. This requires HDB_ADMIN_PASSWORD to be set.
  // NOTE: server.getUser() alone doesn't grant HNSW permissions in Harper v5.
  const adminPass = getAdminPass();
  if (adminPass !== null) {
    try {
      const superAuth = "Basic " + btoa("admin:" + adminPass);
      request.headers.set("authorization", superAuth);
      if (request.headers.asObject) request.headers.asObject.authorization = superAuth;
    } catch {
      // Header manipulation failed — fall back to getUser
      try {
        request.user = await (server as any).getUser("admin", null, request);
      } catch {}
    }
  } else {
    // No admin password configured — try server.getUser as fallback (limited permissions)
    try {
      request.user = await (server as any).getUser("admin", null, request);
    } catch {}
  }

  // Propagate authenticated agent to downstream resources via header.
  // Resources can read this to enforce agent-level scoping.
  request.headers.set("x-tps-agent", agentId);
  if (request.headers.asObject) (request.headers.asObject as any)["x-tps-agent"] = agentId;

  // ── Raw query endpoint block (non-admins) ─────────────────────────────────
  // SQL and GraphQL endpoints bypass all resource-level scoping — block them
  // for non-admin agents. Admins (bootstrap, consolidation scripts) still pass.
  if (!request.tpsAgentIsAdmin) {
    const rawPath = url.pathname.toLowerCase();
    if (
      rawPath === "/sql" || rawPath.startsWith("/sql/") ||
      rawPath === "/graphql" || rawPath.startsWith("/graphql/")
    ) {
      return new Response(
        JSON.stringify({ error: "forbidden: raw query endpoints require admin access" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }
  }

  // ── Server-side permission guards ──────────────────────────────────────────

  const method = request.method.toUpperCase();
  const isMutation = method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";

  if (isMutation) {
    // OrgEvent: authorId must match authenticated agent
    if ((url.pathname === "/OrgEvent" || url.pathname.startsWith("/OrgEvent/")) &&
        (method === "POST" || method === "PUT" || method === "PATCH")) {
      if (!request.tpsAgentIsAdmin) {
        try {
          const clone = request.clone();
          const body = await clone.json();
          if (body?.authorId && body.authorId !== agentId) {
            return new Response(JSON.stringify({
              error: "forbidden: authorId must match authenticated agent"
            }), { status: 403 });
          }
        } catch {}
      }
    }

    // OrgEvent DELETE: ownership check
    if (url.pathname.startsWith("/OrgEvent/") && method === "DELETE") {
      if (!request.tpsAgentIsAdmin) {
        try {
          const pathParts = url.pathname.split("/").filter(Boolean);
          const eventId = pathParts[1] ? decodeURIComponent(pathParts[1]) : null;
          if (eventId) {
            const record = await (databases as any).flair.OrgEvent.get(eventId);
            if (record && record.authorId && record.authorId !== agentId) {
              return new Response(JSON.stringify({
                error: "forbidden: cannot delete events authored by another agent"
              }), { status: 403 });
            }
          }
        } catch {}
      }
    }

    // WorkspaceState: agent-scoped mutations (non-admin can only write own records)
    if ((url.pathname === "/WorkspaceState" || url.pathname.startsWith("/WorkspaceState/")) &&
        (method === "POST" || method === "PUT" || method === "PATCH")) {
      if (!request.tpsAgentIsAdmin) {
        try {
          const clone = request.clone();
          const body = await clone.json();
          if (body?.agentId && body.agentId !== agentId) {
            return new Response(JSON.stringify({
              error: "forbidden: cannot write workspace state for another agent"
            }), { status: 403 });
          }
        } catch {}
      }
    }

    // WorkspaceState DELETE: ownership check
    if ((url.pathname.startsWith("/WorkspaceState/")) && method === "DELETE") {
      if (!request.tpsAgentIsAdmin) {
        try {
          const pathParts = url.pathname.split("/").filter(Boolean);
          const wsId = pathParts[1] ? decodeURIComponent(pathParts[1]) : null;
          if (wsId) {
            const record = await (databases as any).flair.WorkspaceState.get(wsId);
            if (record && record.agentId && record.agentId !== agentId) {
              return new Response(JSON.stringify({
                error: "forbidden: cannot delete workspace state for another agent"
              }), { status: 403 });
            }
          }
        } catch {}
      }
    }

    // Soul PUT: only owner or admin
    if (url.pathname.startsWith("/Soul") && (method === "PUT" || method === "POST")) {
      if (!request.tpsAgentIsAdmin) {
        let bodyAgentId: string | null = null;
        try {
          const clone = request.clone();
          const body = await clone.json();
          bodyAgentId = body?.agentId ?? null;
        } catch {}
        if (bodyAgentId && bodyAgentId !== agentId) {
          return new Response(JSON.stringify({ error: "forbidden: non-admin cannot modify another agent's soul" }), { status: 403 });
        }
      }
    }

    // Memory promotion guard: only admin can approve or set durability=permanent
    if (((url.pathname === "/Memory" || url.pathname.startsWith("/Memory/") || url.pathname === "/memory" || url.pathname.startsWith("/memory/"))) &&
        (method === "PUT" || method === "POST" || method === "PATCH")) {
      if (!request.tpsAgentIsAdmin) {
        try {
          const clone = request.clone();
          const body = await clone.json();
          const setsApproved = body?.promotionStatus === "approved";
          const setsPermanent = body?.durability === "permanent";
          const setsArchived = body?.archived === true;
          if (setsApproved || setsPermanent || setsArchived) {
            return new Response(JSON.stringify({
              error: "forbidden: only admins can approve promotions, set permanent durability, or archive memories"
            }), { status: 403 });
          }
        } catch {}
      }
    }

    // Memory PUT/DELETE: ownership check (non-admin can only modify their own memories)
    if (((url.pathname === "/Memory" || url.pathname.startsWith("/Memory/") || url.pathname === "/memory" || url.pathname.startsWith("/memory/"))) &&
        (method === "PUT" || method === "DELETE" || method === "PATCH")) {
      if (!request.tpsAgentIsAdmin) {
        try {
          const pathParts = url.pathname.split("/").filter(Boolean);
          const memId = pathParts[1] ? decodeURIComponent(pathParts[1]) : null;
          if (memId) {
            const record = await (databases as any).flair.Memory.get(memId);
            if (record && record.agentId && record.agentId !== agentId) {
              return new Response(JSON.stringify({
                error: `forbidden: cannot modify memory owned by ${record.agentId}`
              }), { status: 403 });
            }
            if (method === "DELETE" && record?.durability === "permanent") {
              return new Response(JSON.stringify({
                error: "forbidden: only admins can purge permanent memories"
              }), { status: 403 });
            }
          }
        } catch {}
      }
    }
  }

  // ── WorkspaceState read guard: agent-scoped reads ───────────────────────────
  if (method === "GET" && !request.tpsAgentIsAdmin) {
    if (url.pathname === "/WorkspaceState" || url.pathname === "/WorkspaceState/") {
      const queryAgent = url.searchParams.get("agentId");
      if (queryAgent && queryAgent !== agentId) {
        return new Response(JSON.stringify({
          error: "forbidden: cannot read workspace state for another agent"
        }), { status: 403, headers: { "Content-Type": "application/json" } });
      }
    }
  }

  // ── Mutation scoping: agentId in body must match authenticated agent ────────
  // The resource handlers also enforce this (defense-in-depth), but rejecting
  // early avoids unnecessary work. We don't use request.clone().json() because
  // Harper's Request is not a Web API Request — it wraps a Node.js stream.
  // Instead, the resource-level check (e.g. BootstrapMemories line 58) handles
  // body-level enforcement since it receives the parsed data from Harper's REST
  // layer. The middleware's job is identity verification (done above).

  // ── Memory GET: non-admin can only read own memories (by ID) ────────────────
  if (!request.tpsAgentIsAdmin && method === "GET") {
    if (url.pathname.startsWith("/Memory/")) {
      try {
        const pathParts = url.pathname.split("/").filter(Boolean);
        const memId = pathParts[1] ? decodeURIComponent(pathParts[1]) : null;
        if (memId) {
          const record = await (databases as any).flair.Memory.get(memId);
          if (record && record.agentId && record.agentId !== agentId) {
            // Allow office-wide memories
            if (record.visibility !== "office") {
              // Check MemoryGrant
              let hasGrant = false;
              try {
                for await (const grant of (databases as any).flair.MemoryGrant.search({
                  conditions: [{ attribute: "granteeId", comparator: "equals", value: agentId }],
                })) {
                  if (grant.ownerId === record.agentId &&
                      (grant.scope === "read" || grant.scope === "search")) {
                    hasGrant = true;
                    break;
                  }
                }
              } catch {}
              if (!hasGrant) {
                return new Response(JSON.stringify({
                  error: `forbidden: cannot read memory owned by ${record.agentId}`,
                }), { status: 403, headers: { "Content-Type": "application/json" } });
              }
            }
          }
        }
      } catch { /* record not found or table error — let resource handle */ }
    }
  }

  // ── Embedding backfill ─────────────────────────────────────────────────────

  const isMemoryWrite = isMutation && (url.pathname === "/Memory" || url.pathname.startsWith("/Memory/"));
  let memoryId: string | null = null;
  if (isMemoryWrite) {
    const pathParts = url.pathname.split("/").filter(Boolean);
    memoryId = pathParts.length >= 2 ? decodeURIComponent(pathParts[1]) : (request.headers.get("x-memory-id") ?? null);
  }

  const response = await nextLayer(request);

  if (isMemoryWrite && memoryId && response.status >= 200 && response.status < 300) {
    backfillEmbedding(memoryId).catch(() => {});
  }

  return response;
}, { runFirst: true });
