/**
 * ed25519-auth — single shared source of truth for the TPS-Ed25519 auth
 * primitives used at all 3 signature-verification call sites:
 *
 *   - resources/auth-middleware.ts  (instance-wide HTTP gate)
 *   - resources/agent-auth.ts       (resolveAgentAuth's per-resource fallback)
 *   - resources/Presence.ts         (POST /Presence heartbeat auth)
 *
 * Before this module existed, each of the 3 files carried its OWN
 * module-level `nonceSeen` Map (replay guard) plus its own copy of
 * `importEd25519Key`. Three independent replay windows meant a nonce
 * recorded as "seen" via one path was invisible to the other two — a
 * defense-in-depth gap, and a drift hazard (any future fix to one copy
 * silently didn't apply to the other two). Consolidating all three into
 * this one module means there is exactly ONE replay guard and ONE
 * key-import implementation, imported by all 3 sites.
 *
 * `b64ToArrayBuffer` was already unified into resources/b64.ts in a prior
 * pass (see that file's header) — re-exported here so callers can import
 * everything Ed25519-auth-related from one place.
 *
 * NOT included here: resources/Federation.ts's replay guard. Federation
 * uses its own purpose-built NonceStore (federation-crypto.ts) for a
 * different signing scheme (federation peer-to-peer body signatures, not
 * agent TPS-Ed25519 auth) — deliberately left alone.
 *
 * Signed payload format (must match the TPS CLI signer exactly — changing
 * it breaks every agent's auth): `${agentId}:${ts}:${nonce}:${METHOD}:${pathname}${search}`.
 * Auth header format: `TPS-Ed25519 <agentId>:<ts>:<nonce>:<signatureB64>`.
 * nonceKey format (replay-guard map key): `${agentId}:${nonce}`.
 */
import { b64ToArrayBuffer } from "./b64.js";

export { b64ToArrayBuffer };

/**
 * Replay window, in ms. Confirmed identical (30_000) as a literal constant
 * in auth-middleware.ts and Presence.ts. agent-auth.ts alone additionally
 * read an (undocumented, never-set-anywhere) `FLAIR_AGENT_AUTH_WINDOW_MS`
 * env override — see the flag on this in the consolidation report; the
 * override is preserved here (uniformly, for all 3 sites) since no config,
 * docs, or test in this repo currently sets that var, so preserving it is
 * additive/no-op for today's deployments while keeping agent-auth.ts's
 * stated "plugin-shaped, config via env" design intent.
 */
export const WINDOW_MS = Number(process.env.FLAIR_AGENT_AUTH_WINDOW_MS) || 30_000;

// ─── Auth header parsing (single shared implementation) ────────────────────
//
// One parser for the `Authorization: TPS-Ed25519 <id>:<ts>:<nonce>:<sig>`
// header, used by all 3 call sites (auth-middleware.ts, agent-auth.ts,
// Presence.ts) so the grammar and its input bounds can't drift.

/**
 * Upper bound on the accepted Authorization header length. A well-formed
 * TPS-Ed25519 header (`TPS-Ed25519 <id>:<ts>:<nonce>:<sig>`) is a few hundred
 * chars at most; anything materially larger is malformed. The header is
 * untrusted client input, so we cap its length before running the regex,
 * keeping parse cost bounded regardless of the input's shape.
 */
export const MAX_AUTH_HEADER_LEN = 4096;

/**
 * TPS-Ed25519 auth header grammar.
 *
 * The two colon-delimited text captures use `[^:\s]+` (not `[^:]+`) so they are
 * disjoint from the preceding `\s+`: with no character shared between the two
 * adjacent quantifiers there is exactly one way to split any input, so matching
 * is linear-time on every input (including long, degenerate ones). A real
 * agentId / nonce / signature never contains whitespace, so excluding it is
 * behavior-preserving for well-formed headers.
 */
export const TPS_ED25519_HEADER_RE =
  /^TPS-Ed25519\s+([^:\s]+):(\d+):([^:\s]+):(.+)$/;

export interface ParsedAuthHeader {
  agentId: string;
  tsRaw: string;
  nonce: string;
  signatureB64: string;
}

/**
 * Parse a TPS-Ed25519 `Authorization` header value into its fields, or return
 * null if it is over `MAX_AUTH_HEADER_LEN` or doesn't match the grammar.
 * Callers treat null exactly as a header that carries no valid agent auth.
 */
export function parseTpsEd25519Header(header: string): ParsedAuthHeader | null {
  if (!header || header.length > MAX_AUTH_HEADER_LEN) return null;
  const m = TPS_ED25519_HEADER_RE.exec(header);
  if (!m) return null;
  return { agentId: m[1], tsRaw: m[2], nonce: m[3], signatureB64: m[4] };
}

// ─── Replay guard (single shared instance) ─────────────────────────────────
//
// nonceSeen is the ONE module-level singleton — the whole point of this
// consolidation. A nonce recorded via any one of the 3 call sites is
// immediately visible to the other two, because they all import this same
// module (Node/bun module cache = one instance per process).
const nonceSeen = new Map<string, number>();

/** Remove nonce records older than WINDOW_MS relative to `now`. */
export function pruneNonces(now: number = Date.now()): void {
  for (const [k, ts] of nonceSeen) {
    if (now - ts > WINDOW_MS) nonceSeen.delete(k);
  }
}

/**
 * Prune expired entries, then report whether (agentId, nonce) has already
 * been recorded within the current window. Returns true = REPLAY (reject).
 *
 * Deliberately does NOT record as a side effect — callers check this BEFORE
 * verifying the signature and call `recordNonce` only AFTER the signature is
 * confirmed valid (matches the pre-consolidation per-site behavior at all 3
 * sites exactly: an invalid-signature attempt never burns the nonce, so a
 * client that retries with a corrected signature isn't locked out).
 */
export function isNonceReplay(agentId: string, nonce: string, now: number = Date.now()): boolean {
  pruneNonces(now);
  return nonceSeen.has(`${agentId}:${nonce}`);
}

/** Record (agentId, nonce) as seen at `ts`. Call only after successful verification. */
export function recordNonce(agentId: string, nonce: string, ts: number): void {
  nonceSeen.set(`${agentId}:${nonce}`, ts);
}

/**
 * Test-only escape hatch: clear all recorded nonces. Never called by any
 * production call site — exists so unit tests can isolate the shared
 * singleton between cases instead of relying on WINDOW_MS-based expiry.
 */
export function __clearNoncesForTest(): void {
  nonceSeen.clear();
}

// ─── Ed25519 public key import (cached) ────────────────────────────────────
//
// Single shared key cache, keyed by the raw publicKeyStr. Consolidating the
// 3 previously-independent caches into one just avoids redundant
// crypto.subtle.importKey calls across sites for the same agent — no
// security-relevant behavior change (the cache holds only CryptoKey handles,
// never logged or exposed).
const keyCache = new Map<string, CryptoKey>();

/**
 * Import an agent's Ed25519 public key as a CryptoKey, cached by the raw
 * key string. Accepts hex (64-char) or base64/base64url (44-char, or
 * unpadded) encoded 32-byte Ed25519 public keys — identical logic across
 * all 3 pre-consolidation copies (auth-middleware.ts, agent-auth.ts,
 * Presence.ts).
 */
export async function importEd25519Key(publicKeyStr: string): Promise<CryptoKey> {
  const cached = keyCache.get(publicKeyStr);
  if (cached) return cached;
  // Accept hex (64-char) or base64 (44-char) encoded 32-byte Ed25519 public key.
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
