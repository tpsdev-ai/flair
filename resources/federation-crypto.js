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
export function canonicalize(obj) {
    return JSON.stringify(sortKeys(obj));
}
function sortKeys(val) {
    if (val === null || val === undefined || typeof val !== "object")
        return val;
    if (Array.isArray(val))
        return val.map(sortKeys);
    const sorted = {};
    for (const key of Object.keys(val).sort()) {
        sorted[key] = sortKeys(val[key]);
    }
    return sorted;
}
// ─── Signing ────────────────────────────────────────────────────────────────
/**
 * Create a detached Ed25519 signature over the canonical form of a body.
 * Returns base64url-encoded signature.
 */
export function signBody(body, secretKey) {
    const message = new TextEncoder().encode(canonicalize(body));
    const sig = nacl.sign.detached(message, secretKey);
    return Buffer.from(sig).toString("base64url");
}
/**
 * Verify a signature field on a request body.
 * The canonical form is the body WITHOUT the `signature` field.
 */
export function verifyBodySignature(body, publicKeyB64url) {
    const { signature, ...rest } = body;
    if (!signature)
        return false;
    try {
        const message = new TextEncoder().encode(canonicalize(rest));
        const sig = Buffer.from(signature, "base64url");
        const pubKey = Buffer.from(publicKeyB64url, "base64url");
        return nacl.sign.detached.verify(message, new Uint8Array(sig), new Uint8Array(pubKey));
    }
    catch {
        return false;
    }
}
