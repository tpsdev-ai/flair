/**
 * Federation cryptographic utilities — pure functions, no HarperDB dependency.
 * Shared by Federation.ts (server) and cli.ts (client).
 */

import nacl from "tweetnacl";
import { protoSafeRecord } from "../src/lib/proto-safe-record.js";

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
  const src = val as Record<string, unknown>;
  // A null-prototype copy: an own `__proto__` key is kept in the signing input
  // rather than silently dropped (flair#2235).
  return protoSafeRecord(src, { keys: Object.keys(src).sort(), map: sortKeys });
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

/** Freshness window the federation endpoints (FederationPair, FederationSync) use, in ms. */
export const FEDERATION_WINDOW_MS = 30_000;

/**
 * An asynchronous, authoritative replay record — what the federation endpoints
 * use (resources/replay-store.ts's `federationReplayGuard`). Unlike
 * `NonceStore`, recording is a single check-and-record that can refuse.
 */
export interface ReplayRecorder {
  /** True only when this recorder already saw `nonce` recorded. A false proves nothing. */
  knownReplay(nonce: string, now?: number): boolean;
  /** Check-and-record `nonce`. Anything but "recorded" must refuse the request. */
  claim(nonce: string, now?: number): Promise<"recorded" | "replay" | "unavailable">;
}

export interface VerifyFreshOnceResult {
  ok: boolean;
  reason?: VerifyFreshResult["reason"] | "replay_store_unavailable";
}

type FreshPrecheck =
  | { ok: true; nonce: string; now: number; verificationBody: Record<string, any> }
  | { ok: false; reason: "stale" | "future" | "invalid_signature" };

/** Field presence and timestamp checks shared by both verify functions. */
function precheckFresh(body: Record<string, any>, windowMs: number): FreshPrecheck {
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

  // Canonical form includes _ts and _nonce.
  return { ok: true, nonce: _nonce, now, verificationBody: { _ts, _nonce, ...rest, signature } };
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
 * Default in-memory nonce store backed by a Map. It is local to one process
 * (and one Harper thread); the Flair server's federation endpoints record
 * nonces through `verifyBodySignatureFreshOnce` and resources/replay-store.ts
 * instead.
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
 * Replay detection is only as wide as `opts.nonceStore`; the Flair server's
 * endpoints use `verifyBodySignatureFreshOnce` below.
 */
export function verifyBodySignatureFresh(
  body: Record<string, any>,
  publicKeyB64url: string,
  opts: VerifyFreshOptions = {},
): VerifyFreshResult {
  const windowMs = opts.windowMs ?? 30_000;
  const nonceStore = opts.nonceStore;

  const pre = precheckFresh(body, windowMs);
  if (!pre.ok) return pre;
  const { nonce: _nonce, now } = pre;

  // ── Nonce replay check ───────────────────────────────────────────────
  if (nonceStore) {
    // Evict entries older than 2x window — keeps the store bounded
    nonceStore.evict(now - 2 * windowMs);
    if (nonceStore.has(_nonce)) return { ok: false, reason: "replay" };
  }

  // ── Signature verification — canonical form includes _ts, _nonce ─────
  if (!verifyBodySignature(pre.verificationBody, publicKeyB64url)) {
    return { ok: false, reason: "invalid_signature" };
  }

  // ── Record nonce ─────────────────────────────────────────────────────
  if (nonceStore) {
    nonceStore.set(_nonce, now);
  }

  return { ok: true };
}

/**
 * Verify a signed request body and record its nonce ONCE (the federation
 * endpoints' check).
 *
 * Same field, timestamp and signature checks as `verifyBodySignatureFresh`.
 * The nonce is claimed through `opts.replay` only AFTER the signature has
 * verified; a claim that is not "recorded" — a replay, an unusable store, or
 * anything thrown — refuses. `replay.knownReplay` may refuse earlier, on a hit
 * only.
 */
export async function verifyBodySignatureFreshOnce(
  body: Record<string, any>,
  publicKeyB64url: string,
  opts: { windowMs?: number; replay: ReplayRecorder },
): Promise<VerifyFreshOnceResult> {
  const pre = precheckFresh(body, opts.windowMs ?? FEDERATION_WINDOW_MS);
  if (!pre.ok) return pre;

  if (opts.replay.knownReplay(pre.nonce, pre.now)) return { ok: false, reason: "replay" };

  if (!verifyBodySignature(pre.verificationBody, publicKeyB64url)) {
    return { ok: false, reason: "invalid_signature" };
  }

  let claimed: "recorded" | "replay" | "unavailable";
  try {
    claimed = await opts.replay.claim(pre.nonce);
  } catch {
    claimed = "unavailable";
  }
  if (claimed === "recorded") return { ok: true };
  if (claimed === "replay") return { ok: false, reason: "replay" };
  return { ok: false, reason: "replay_store_unavailable" };
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
