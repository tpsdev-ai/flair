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

// ─── Signing ────────────────────────────────────────────────────────────────

/**
 * Create a detached Ed25519 signature over the canonical form of a body.
 * Returns base64url-encoded signature.
 */
export function signBody(body: Record<string, any>, secretKey: Uint8Array): string {
  const message = new TextEncoder().encode(canonicalize(body));
  const sig = nacl.sign.detached(message, secretKey);
  return Buffer.from(sig).toString("base64url");
}

/**
 * Verify a signature field on a request body.
 * The canonical form is the body WITHOUT the `signature` field.
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
