/**
 * Federation cryptographic utilities — pure functions, no HarperDB dependency.
 * Shared by Federation.ts (server) and cli.ts (client).
 */

import nacl from "tweetnacl";

// ─── Canonical JSON ─────────────────────────────────────────────────────────

/**
 * Deterministic JSON serialization: recursively sort object keys, then stringify.
 * Used as the signing input for federation requests.
 */
export function canonicalize(obj: unknown): string {
  return JSON.stringify(sortKeys(obj));
}

function sortKeys(val: unknown): unknown {
  if (val === null || val === undefined || typeof val !== "object") return val;
  if (Array.isArray(val)) return val.map(sortKeys);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(val as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((val as Record<string, unknown>)[key]);
  }
  return sorted;
}

// ─── Nonce generation ───────────────────────────────────────────────────────

/**
 * Generate a random nonce for anti-replay protection.
 * 16 random bytes → base64url (22 chars, no padding). 128 bits of entropy
 * is sufficient for collision-resistance over the signing window.
 */
export function generateNonce(): string {
  return Buffer.from(nacl.randomBytes(16)).toString("base64url");
}

// ─── Fresh signing (with anti-replay) ───────────────────────────────────────

export interface SignFreshOptions {
  /** Timestamp to embed (default: Date.now()) */
  ts?: number;
  /** Nonce to embed (default: auto-generated) */
  nonce?: string;
}

export interface VerifyFreshResult {
  ok: boolean;
  reason?: "stale" | "future" | "replay" | "invalid_signature";
}

export interface VerifyFreshOptions {
  /** Maximum clock skew in milliseconds (default: 30_000) */
  windowMs?: number;
  /** Nonce store for replay detection */
  nonceStore?: NonceStore;
}

/**
 * A simple in-memory nonce store with TTL-based eviction.
 * Replaceable — callers can provide their own Map-like implementation.
 */
export interface NonceStore {
  has(key: string): boolean;
  set(key: string, value: number): void;
  /** Evict entries older than the given timestamp */
  evict(olderThan: number): void;
}

/**
 * Default in-memory nonce store backed by a Map.
 * Safe for module-level singleton use (e.g. federationNonceStore).
 */
export function createNonceStore(): NonceStore {
  const store = new Map<string, number>();
  return {
    has(key) { return store.has(key); },
    set(key, value) { store.set(key, value); },
    evict(olderThan) {
      for (const [k, ts] of store.entries()) {
        if (ts < olderThan) store.delete(k);
      }
    },
  };
}

/**
 * Sign a request body with embedded timestamp and nonce for anti-replay.
 *
 * Adds `_ts` and `_nonce` fields to the body, then signs the canonical form
 * (including those fields) using the existing `signBody`. Returns the body
 * with `_ts`, `_nonce`, and `signature` fields set.
 *
 * The caller sends the returned body as the JSON payload. The receiver
 * uses `verifyBodySignatureFresh` to validate it.
 */
export function signBodyFresh(
  body: Record<string, any>,
  secretKey: Uint8Array,
  opts?: SignFreshOptions,
): Record<string, any> {
  const tsBody: Record<string, any> = {
    ...body,
    _ts: opts?.ts ?? Date.now(),
    _nonce: opts?.nonce ?? generateNonce(),
  };
  const sig = signBody(tsBody, secretKey);
  return { ...tsBody, signature: sig };
}

/**
 * Verify a signed request body with anti-replay protection.
 *
 * 1. Validates the Ed25519 signature over the canonical form (including
 *    `_ts`, `_nonce`, and all other fields EXCEPT `signature`).
 * 2. Checks that the embedded `_ts` is within `opts.windowMs` of now.
 * 3. Checks that the embedded `_nonce` has not been seen before (replay).
 * 4. Records the nonce on success.
 *
 * Returns `{ ok: true }` on success, or `{ ok: false, reason: "..." }`.
 */
export function verifyBodySignatureFresh(
  body: Record<string, any>,
  publicKeyB64url: string,
  opts: VerifyFreshOptions = {},
): VerifyFreshResult {
  const windowMs = opts.windowMs ?? 30_000;
  const nonceStore = opts.nonceStore;

  const { signature, _ts, _nonce, ...rest } = body;

  // ── Field presence ───────────────────────────────────────────────────
  if (!signature) return { ok: false, reason: "invalid_signature" };
  if (_ts == null || !Number.isFinite(_ts)) return { ok: false, reason: "invalid_signature" };
  if (!_nonce || typeof _nonce !== "string") return { ok: false, reason: "invalid_signature" };

  // ── Timestamp check ──────────────────────────────────────────────────
  const now = Date.now();
  const delta = now - _ts;
  if (delta > windowMs) return { ok: false, reason: "stale" };
  if (delta < -windowMs) return { ok: false, reason: "future" };

  // ── Nonce replay check ───────────────────────────────────────────────
  if (nonceStore) {
    // Evict entries older than 2x window — keeps the store bounded
    nonceStore.evict(now - 2 * windowMs);
    if (nonceStore.has(_nonce)) return { ok: false, reason: "replay" };
  }

  // ── Signature verification — canonical form includes _ts, _nonce ─────
  const verificationBody = { _ts, _nonce, ...rest, signature };
  if (!verifyBodySignature(verificationBody, publicKeyB64url)) {
    return { ok: false, reason: "invalid_signature" };
  }

  // ── Record nonce ─────────────────────────────────────────────────────
  if (nonceStore) {
    nonceStore.set(_nonce, now);
  }

  return { ok: true };
}

// ─── Legacy signing (without anti-replay) ────────────────────────────────────
// Kept as implementation detail for signBodyFresh / verifyBodySignatureFresh.
// Callers should use the fresh variants for replay-safe federation operations.

/**
 * Create a detached Ed25519 signature over the canonical form of a body.
 * Returns base64url-encoded signature.
 *
 * NOTE: Prefer `signBodyFresh()` which includes anti-replay metadata (_ts, _nonce).
 */
export function signBody(body: Record<string, any>, secretKey: Uint8Array): string {
  const message = new TextEncoder().encode(canonicalize(body));
  const sig = nacl.sign.detached(message, secretKey);
  return Buffer.from(sig).toString("base64url");
}

/**
 * Verify a signature field on a request body.
 * The canonical form is the body WITHOUT the `signature` field.
 *
 * NOTE: Prefer `verifyBodySignatureFresh()` which adds timestamp and nonce
 * replay protection. This function performs ONLY signature validation.
 */
export function verifyBodySignature(
  body: Record<string, any>,
  publicKeyB64url: string,
): boolean {
  const { signature, ...rest } = body;
  if (!signature) return false;
  try {
    const message = new TextEncoder().encode(canonicalize(rest));
    const sig = Buffer.from(signature, "base64url");
    const pubKey = Buffer.from(publicKeyB64url, "base64url");
    return nacl.sign.detached.verify(message, new Uint8Array(sig), new Uint8Array(pubKey));
  } catch {
    return false;
  }
}
