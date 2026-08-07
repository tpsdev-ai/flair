/**
 * TPS-Ed25519 request signing for adk-flair.
 *
 * Loads a PKCS8 base64-encoded Ed25519 private key from a keyfile and
 * produces `TPS-Ed25519 <agent-id>:<timestamp>:<nonce>:<base64-sig>`
 * Authorization headers for Flair API requests.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";

/**
 * Load and validate an Ed25519 private key from a PKCS8 base64 keyfile.
 *
 * Parses the key material in the constructor path so that a bad keyfile
 * fails immediately (before ADK's exception-swallowing search path can
 * turn it into permanent silent empty recall).
 *
 * @param keyfilePath - Path to the keyfile (PKCS8 DER, base64-encoded)
 * @returns A Node.js KeyObject for the Ed25519 private key
 * @throws If the keyfile is missing, unreadable, or contains invalid key material
 */
export function loadEd25519Key(keyfilePath: string): crypto.KeyObject {
  let b64: string;
  try {
    b64 = fs.readFileSync(keyfilePath, "utf-8").trim();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `FLAIR_KEYFILE: cannot read keyfile: ${msg}`
    );
  }

  if (b64.length === 0) {
    throw new Error("FLAIR_KEYFILE: keyfile is empty");
  }

  let der: Buffer;
  try {
    der = Buffer.from(b64, "base64");
  } catch {
    throw new Error("FLAIR_KEYFILE: keyfile is not valid base64");
  }

  if (der.length === 0) {
    throw new Error("FLAIR_KEYFILE: keyfile decoded to empty key material");
  }

  let key: crypto.KeyObject;
  try {
    key = crypto.createPrivateKey({
      key: der,
      format: "der",
      type: "pkcs8",
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `FLAIR_KEYFILE: invalid Ed25519 key material: ${msg}`
    );
  }

  // Verify it's actually an Ed25519 key
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(
      `FLAIR_KEYFILE: expected Ed25519 key, got ${key.asymmetricKeyType ?? "unknown"}`
    );
  }

  return key;
}

/**
 * Build the TPS-Ed25519 Authorization header value.
 *
 * Format: `TPS-Ed25519 <agent-id>:<timestamp>:<nonce>:<base64-sig>`
 *
 * @param privateKey - The loaded Ed25519 private key
 * @param agentId - The Flair agent ID
 * @param method - HTTP method (e.g. "POST")
 * @param path - Request path (e.g. "/SemanticSearch")
 * @returns The Authorization header value
 */
export function signRequest(
  privateKey: crypto.KeyObject,
  agentId: string,
  method: string,
  path: string,
): string {
  const ts = String(Date.now());
  const nonce = crypto.randomUUID();
  const payload = `${agentId}:${ts}:${nonce}:${method}:${path}`;
  const sig = crypto.sign(null, Buffer.from(payload, "utf-8"), privateKey);
  const sigB64 = sig.toString("base64");
  return `TPS-Ed25519 ${agentId}:${ts}:${nonce}:${sigB64}`;
}
