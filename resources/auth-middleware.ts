import { server, tables } from "harper";
import { initEmbeddings, getEmbedding } from "./embeddings-provider.js";
import { readFileSync } from "node:fs";

// --- Admin token (loaded once at startup, never hardcoded) ---
// Reads from ~/.tps/secrets/flair/harper-admin-token, then env vars.
// Fails loudly rather than falling back to a hardcoded default.
let _adminToken: string | null = null;
function getAdminToken(): string {
  if (_adminToken) return _adminToken;
  const tokenFile = (process.env.HOME ?? "") + "/.tps/secrets/flair/harper-admin-token";
  try {
    _adminToken = readFileSync(tokenFile, "utf8").trim();
    return _adminToken;
  } catch {
    const envToken = process.env.FLAIR_ADMIN_TOKEN ?? process.env.HDB_ADMIN_PASSWORD;
    if (envToken) {
      _adminToken = envToken;
      return _adminToken;
    }
    const msg = "[auth] FATAL: no admin token found. Run: tps flair install";
    console.error(msg);
    throw new Error(msg);
  }
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
  const bin = atob(b64);
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
    await (tables as any).Memory.put({ ...record, embedding });
    console.log(`[auto-embed] ${memoryId}: ${embedding.length}d`);
  } catch (err: any) {
    console.error(`[auto-embed] Failed for ${memoryId}: ${err.message}`);
  }
}

// ─── HTTP middleware ──────────────────────────────────────────────────────────

server.http(async (request: any, nextLayer: any) => {
  const url = new URL(request.url, "http://" + (request.headers.get("host") || "localhost"));

  if (url.pathname === "/health" || url.pathname === "/Health") return nextLayer(request);

  // Skip re-entry: if we already swapped auth to Basic, pass through
  if ((request as any)._tpsAuthVerified) return nextLayer(request);

  const header = request.headers.get("authorization") || request.headers?.asObject?.authorization || "";
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

  const superAuth = "Basic " + btoa("admin:" + getAdminToken());
  request.headers.set("authorization", superAuth);
  if (request.headers.asObject) request.headers.asObject.authorization = superAuth;

  // ── Server-side permission guards ──────────────────────────────────────────

  const method = request.method.toUpperCase();
  const isMutation = method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";

  if (isMutation) {
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
