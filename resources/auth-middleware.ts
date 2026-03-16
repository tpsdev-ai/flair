import { patchRecord } from "./table-helpers.js";
import { server, tables } from "@harperfast/harper";
import { initEmbeddings, getEmbedding } from "./embeddings-provider.js";

// --- Admin credentials ---
// Admin auth is sourced exclusively from Harper's own environment variables
// (HDB_ADMIN_PASSWORD / FLAIR_ADMIN_PASSWORD). No filesystem token file.
//
// FLAIR_ADMIN_TOKEN env var is still accepted for backwards compat but
// emits a deprecation warning on first use.
let _adminPass: string | null = null;
let _deprecationWarned = false;

function getAdminPass(): string {
  if (_adminPass) return _adminPass;

  // Primary source: Harper's own admin password (set at startup via env)
  const primary = process.env.HDB_ADMIN_PASSWORD ?? process.env.FLAIR_ADMIN_PASSWORD;
  if (primary) {
    _adminPass = primary;
    return _adminPass;
  }

  // Backwards compat: FLAIR_ADMIN_TOKEN (deprecated — never write to disk)
  if (process.env.FLAIR_ADMIN_TOKEN) {
    if (!_deprecationWarned) {
      console.warn("[auth] DEPRECATION: FLAIR_ADMIN_TOKEN is deprecated. Use HDB_ADMIN_PASSWORD instead.");
      _deprecationWarned = true;
    }
    _adminPass = process.env.FLAIR_ADMIN_TOKEN;
    return _adminPass;
  }

  const msg = "[auth] FATAL: no admin password found. Set HDB_ADMIN_PASSWORD env var.";
  console.error(msg);
  throw new Error(msg);
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
    const results = await (tables as any).Agent.search([{ attribute: "role", value: "admin", condition: "equals" }]);
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

initEmbeddings().catch((err: any) => console.error("[embeddings] init:", err.message));

async function backfillEmbedding(memoryId: string): Promise<void> {
  try {
    const record = await (tables as any).Memory.get(memoryId);
    if (!record?.content) return;
    if (record.embedding?.length > 100) return;
    const embedding = await getEmbedding(record.content);
    if (!embedding) return;
    await patchRecord((tables as any).Memory, memoryId, { embedding });
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
    url.pathname.startsWith("/AgentCard/")
  ) return nextLayer(request);

  // Skip re-entry: if we already swapped auth to Basic, pass through
  if ((request as any)._tpsAuthVerified) return nextLayer(request);

  const header = request.headers.get("authorization") || request.headers?.asObject?.authorization || "";

  // ── Basic admin auth ──────────────────────────────────────────────────────
  // Allow Basic auth with the admin password for CLI operations (backup, etc.)
  // This is checked BEFORE Ed25519 so admin tools can use simple auth.
  if (header.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(header.slice(6), "base64").toString("utf-8");
      const [user, pass] = decoded.split(":");
      if (user === "admin" && pass === getAdminPass()) {
        // Mark as verified and pass through to Harper with admin credentials
        (request as any)._tpsAuthVerified = true;
        request.headers.set("x-tps-agent", "admin");
        if (request.headers.asObject) (request.headers.asObject as any)["x-tps-agent"] = "admin";
        return nextLayer(request);
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

  const agent = await (tables as any).Agent.get(agentId);
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

  const superAuth = "Basic " + btoa("admin:" + getAdminPass());
  request.headers.set("authorization", superAuth);
  if (request.headers.asObject) request.headers.asObject.authorization = superAuth;

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
            const record = await (tables as any).OrgEvent.get(eventId);
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
            const record = await (tables as any).WorkspaceState.get(wsId);
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
            const record = await (tables as any).Memory.get(memId);
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

  // ── SemanticSearch: agentId must match authenticated agent ─────────────────
  // Non-admin agents can only search their own memories (plus MemoryGrant access,
  // which is enforced inside SemanticSearch.ts using the x-tps-agent header).
  if (!request.tpsAgentIsAdmin &&
      method === "POST" &&
      (url.pathname === "/SemanticSearch" || url.pathname === "/SemanticSearch/")) {
    try {
      const clone = request.clone();
      const body = await clone.json();
      if (body?.agentId && body.agentId !== agentId) {
        return new Response(JSON.stringify({
          error: "forbidden: agentId must match authenticated agent",
        }), { status: 403, headers: { "Content-Type": "application/json" } });
      }
    } catch { /* malformed body — let resource return its own error */ }
  }

  // ── BootstrapMemories: agentId must match authenticated agent ───────────────
  if (!request.tpsAgentIsAdmin &&
      method === "POST" &&
      (url.pathname === "/BootstrapMemories" || url.pathname === "/BootstrapMemories/")) {
    try {
      const clone = request.clone();
      const body = await clone.json();
      if (body?.agentId && body.agentId !== agentId) {
        return new Response(JSON.stringify({
          error: "forbidden: agentId must match authenticated agent",
        }), { status: 403, headers: { "Content-Type": "application/json" } });
      }
    } catch { /* malformed body — let resource return its own error */ }
  }

  // ── Memory POST (create): agentId must match authenticated agent ────────────
  if (!request.tpsAgentIsAdmin &&
      method === "POST" &&
      (url.pathname === "/Memory" || url.pathname === "/Memory/")) {
    try {
      const clone = request.clone();
      const body = await clone.json();
      if (body?.agentId && body.agentId !== agentId) {
        return new Response(JSON.stringify({
          error: "forbidden: cannot create memories for another agent",
        }), { status: 403, headers: { "Content-Type": "application/json" } });
      }
    } catch {}
  }

  // ── Soul POST/PUT: agentId must match authenticated agent ───────────────────
  if (!request.tpsAgentIsAdmin &&
      (method === "POST" || method === "PUT") &&
      (url.pathname === "/Soul" || url.pathname === "/Soul/" || url.pathname.startsWith("/Soul/"))) {
    try {
      const clone = request.clone();
      const body = await clone.json();
      if (body?.agentId && body.agentId !== agentId) {
        return new Response(JSON.stringify({
          error: "forbidden: cannot write another agent's soul",
        }), { status: 403, headers: { "Content-Type": "application/json" } });
      }
    } catch {}
  }

  // ── Memory PUT: agentId must match authenticated agent ──────────────────────
  if (!request.tpsAgentIsAdmin &&
      method === "PUT" &&
      (url.pathname === "/Memory" || url.pathname === "/Memory/" || url.pathname.startsWith("/Memory/"))) {
    try {
      const clone = request.clone();
      const body = await clone.json();
      if (body?.agentId && body.agentId !== agentId) {
        return new Response(JSON.stringify({
          error: "forbidden: cannot write memories for another agent",
        }), { status: 403, headers: { "Content-Type": "application/json" } });
      }
    } catch {}
  }

  // ── Memory GET: non-admin can only read own memories (by ID) ────────────────
  if (!request.tpsAgentIsAdmin && method === "GET") {
    if (url.pathname.startsWith("/Memory/")) {
      try {
        const pathParts = url.pathname.split("/").filter(Boolean);
        const memId = pathParts[1] ? decodeURIComponent(pathParts[1]) : null;
        if (memId) {
          const record = await (tables as any).Memory.get(memId);
          if (record && record.agentId && record.agentId !== agentId) {
            // Allow office-wide memories
            if (record.visibility !== "office") {
              // Check MemoryGrant
              let hasGrant = false;
              try {
                for await (const grant of (tables as any).MemoryGrant.search({
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
