/**
 * Deterministic name-based UUID from SHA-256 (RFC 9562 version 8).
 *
 * Cursor Cloud Agents require a client-supplied `bc-<uuid>` for idempotent
 * create. This must be a function of the OrgEvent id — `crypto.randomUUID()`
 * would mint a new agent on every redelivery. SHA-1 UUID v5 is the RFC
 * name-based form, but CodeQL flags SHA-1 as a weak primitive; SHA-256
 * with version 8 is the same contract with a strong hash.
 */

import { createHash } from "node:crypto";

/** RFC 4122 Appendix C — DNS namespace. */
export const DNS_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new Error(`invalid uuid: ${uuid}`);
  }
  return Buffer.from(hex, "hex");
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Name-based UUID: SHA-256(namespace bytes || name) → 16 bytes, version 8,
 * RFC 4122 variant. Same name + namespace always yields the same id.
 */
export function uuidFromSha256(name: string, namespace: string): string {
  const hash = createHash("sha256").update(uuidToBytes(namespace)).update(name, "utf8").digest();
  const bytes = Uint8Array.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytesToUuid(bytes);
}
