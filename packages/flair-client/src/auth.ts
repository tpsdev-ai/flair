/**
 * Ed25519 request signing for Flair.
 *
 * Signs requests with: agentId:timestamp:nonce:METHOD:/path
 * Produces: TPS-Ed25519 agentId:timestamp:nonce:base64(signature)
 */

import { randomUUID, sign as ed25519Sign, createPrivateKey, type KeyObject } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** Resolve an Ed25519 private key from a file (base64 PKCS8 DER or raw 32-byte seed). */
export function loadPrivateKey(path: string): KeyObject {
  const raw = readFileSync(path);
  // Try as base64-encoded PKCS8 DER first
  const decoded = raw.length === 32 ? raw : Buffer.from(raw.toString("utf-8").trim(), "base64");
  const der = decoded.length === 32
    ? Buffer.concat([PKCS8_ED25519_PREFIX, decoded])
    : decoded;
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

/** Find the agent's private key file from standard locations. */
export function resolveKeyPath(agentId: string, keyPath?: string): string | null {
  if (keyPath) {
    const resolved = resolve(keyPath.replace(/^~/, homedir()));
    return existsSync(resolved) ? resolved : null;
  }
  const candidates = [
    process.env.FLAIR_KEY_DIR ? resolve(process.env.FLAIR_KEY_DIR, `${agentId}.key`) : null,
    resolve(homedir(), ".flair", "keys", `${agentId}.key`),
    resolve(homedir(), ".tps", "secrets", "flair", `${agentId}-priv.key`),
  ].filter(Boolean) as string[];
  return candidates.find(existsSync) ?? null;
}

/** Build an Authorization header for a Flair request. */
export function signRequest(
  agentId: string,
  privateKey: KeyObject,
  method: string,
  path: string,
): string {
  const ts = Date.now().toString();
  const nonce = randomUUID();
  const payload = `${agentId}:${ts}:${nonce}:${method}:${path}`;
  const sig = ed25519Sign(null, Buffer.from(payload), privateKey);
  return `TPS-Ed25519 ${agentId}:${ts}:${nonce}:${sig.toString("base64")}`;
}
