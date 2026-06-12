/**
 * flair-agent-auth — Ed25519 agent authentication.
 *
 * The verification logic that used to live in the instance-wide `server.http`
 * auth-middleware, extracted into a per-resource helper. Resources call
 * `verifyAgentRequest()` from their `allow*()` methods to identify + authorize
 * the calling agent. This keeps flair's auth PER-RESOURCE (Harper-native) so it
 * composes on a multi-component hub instead of a global gate that 401s siblings.
 *
 * Plugin-shaped on purpose (config via env today, extractable to a standalone
 * @tps/agent-auth Harper plugin later — the "agent auth as its own plugin" path).
 *
 * Auth model: an agent presents `Authorization: TPS-Ed25519 <id>:<ts>:<nonce>:<sig>`.
 * The signature covers `<id>:<ts>:<nonce>:<METHOD>:<pathname><search>` and is
 * verified against the agent's stored Ed25519 public key. Replay is bounded by a
 * 30s timestamp window + a per-(agent,nonce) seen-set pruned to that window.
 */
import { databases } from "@harperfast/harper";

const WINDOW_MS = Number(process.env.FLAIR_AGENT_AUTH_WINDOW_MS) || 30_000;

// Replay protection: remember recently-seen (agent:nonce), pruned by the window.
const nonceSeen = new Map<string, number>();

// ─── Crypto helpers ───────────────────────────────────────────────────────────

function b64ToArrayBuffer(b64: string): ArrayBuffer {
  // Handle both standard and URL-safe base64.
  const std = b64.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(std);
  const buf = new ArrayBuffer(bin.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
  return buf;
}

const keyCache = new Map<string, CryptoKey>();
async function importEd25519Key(publicKeyStr: string): Promise<CryptoKey> {
  const cached = keyCache.get(publicKeyStr);
  if (cached) return cached;
  // Accept hex (64-char) or base64 (44-char) encoded 32-byte Ed25519 public key.
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

// ─── Admin resolution ─────────────────────────────────────────────────────────
// Admin agents come from FLAIR_ADMIN_AGENTS (comma-separated) OR Agent records
// with role === "admin". OR-combined, cached 60s. Distinct from Harper's
// super_user — admin here gates flair-policy decisions (promotions, raw ops).

let adminCacheExpiry = 0;
let adminCache: Set<string> = new Set();

async function getAdminAgents(): Promise<Set<string>> {
  const now = Date.now();
  if (now < adminCacheExpiry) return adminCache;
  const fromEnv = (process.env.FLAIR_ADMIN_AGENTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const fromDb: string[] = [];
  try {
    const results = await (databases as any).flair.Agent.search([{ attribute: "role", value: "admin", condition: "equals" }]);
    for await (const row of results) if (row?.id) fromDb.push(row.id);
  } catch { /* Agent table may be empty */ }
  adminCache = new Set([...fromEnv, ...fromDb]);
  adminCacheExpiry = now + 60_000;
  return adminCache;
}

export async function isAdmin(agentId: string): Promise<boolean> {
  return (await getAdminAgents()).has(agentId);
}

// ─── Agent request verification ───────────────────────────────────────────────

export interface AgentAuth {
  agentId: string;
  isAdmin: boolean;
}

const HEADER_RE = /^TPS-Ed25519\s+([^:]+):(\d+):([^:]+):(.+)$/;

async function doVerify(request: any): Promise<AgentAuth | null> {
  const header: string =
    request?.headers?.get?.("authorization") ??
    request?.headers?.asObject?.authorization ??
    "";
  const m = HEADER_RE.exec(header);
  if (!m) return null;

  const [, agentId, tsRaw, nonce, signatureB64] = m;
  const ts = Number(tsRaw);
  const now = Date.now();
  if (!Number.isFinite(ts) || Math.abs(now - ts) > WINDOW_MS) return null;

  // Prune expired nonces, then reject replays within the window.
  for (const [k, t] of nonceSeen) if (now - t > WINDOW_MS) nonceSeen.delete(k);
  const nonceKey = `${agentId}:${nonce}`;
  if (nonceSeen.has(nonceKey)) return null;

  const agent = await (databases as any).flair.Agent.get(agentId).catch(() => null);
  if (!agent?.publicKey) return null;

  // Canonical signed payload: id:ts:nonce:METHOD:pathname+search (must match the
  // TPS CLI signer exactly — changing this breaks every agent's auth).
  const url = new URL(request.url, "http://localhost");
  const payload = `${agentId}:${tsRaw}:${nonce}:${request.method}:${url.pathname}${url.search}`;
  try {
    const key = await importEd25519Key(String(agent.publicKey));
    const ok = await crypto.subtle.verify(
      { name: "Ed25519" } as any,
      key,
      b64ToArrayBuffer(signatureB64),
      new TextEncoder().encode(payload),
    );
    if (!ok) return null;
  } catch {
    return null;
  }

  nonceSeen.set(nonceKey, ts);
  return { agentId, isAdmin: await isAdmin(agentId) };
}

/**
 * Verify a TPS-Ed25519 signed request → the authenticated agent, or null.
 *
 * MEMOIZED per request object: `allow*` may run several times for one request,
 * and re-running doVerify would (a) waste a crypto verify and (b) double-consume
 * the nonce (the 2nd call would see a replay and fail). We verify once and cache
 * the result (including null) on the request.
 */
export async function verifyAgentRequest(request: any): Promise<AgentAuth | null> {
  if (!request) return null;
  if (request._flairAgentAuth !== undefined) return request._flairAgentAuth;
  const result = await doVerify(request);
  try { request._flairAgentAuth = result; } catch { /* frozen request — fine, just no cache */ }
  return result;
}
