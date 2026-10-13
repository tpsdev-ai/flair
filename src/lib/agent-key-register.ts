/**
 * agent-key-register.ts — the pure, dependency-light helpers for the admin-only
 * key-registration operation (POST /AgentKeyRegister, flair#2266) and the
 * federation rule that ships with it.
 *
 * Kept out of the resource so a unit test can exercise the key-format rule, the
 * fingerprint rule and the refusal names without standing up Harper. Imports
 * only `node:crypto` (a builtin), so a static resource import reaches a
 * dependency-free compiled helper.
 */
import { createHash } from "node:crypto";

/** The stored `publicKey` value of an Agent row seeded but not yet registered. */
export const PENDING_PUBLIC_KEY = "pending";

/**
 * The test-only pause point the concurrency/rollback test arms (flair#2266),
 * inside the registration's OWNED transaction, after the fresh read and before
 * the staging. Named as a DIRECT string literal at the resource call site
 * (flair#2382's checker resolves only literals or `spec.point`); this export is
 * the single source the integration test arms and must stay equal to the
 * literal.
 */
export const AGENT_KEY_REGISTER_PAUSE_POINT = "agent-key-register";

/** 400: the request body is missing or malformed (invalid agentId / publicKey). */
export const REGISTRATION_REQUEST_INVALID = "registration_request_invalid";
/** 404: no Agent row with that id. */
export const AGENT_NOT_FOUND = "agent_not_found";
/** 403: the row did not originate on this instance (a foreign home or sync provenance). */
export const AGENT_NOT_LOCAL = "agent_not_local";
/** 403: the row is deactivated. */
export const AGENT_INACTIVE = "agent_inactive";
/** 409: the stored key is not exactly `pending`. */
export const AGENT_KEY_NOT_PENDING = "agent_key_not_pending";
/** 409: another registration is in progress, or the row changed under this one. */
export const REGISTRATION_CONFLICT = "registration_conflict";
/** 503: the registration store is unavailable, or committed state could not be confirmed. */
export const REGISTRATION_UNAVAILABLE = "registration_unavailable";

/** The OrgEvent kind a committed registration writes (fingerprint only, never the key). */
export const AGENT_KEY_REGISTERED_EVENT = "agent_key_registered";

/** A canonical, unpadded, base64url-encoded 32-byte Ed25519 public key. */
const CANONICAL_B64URL_43 = /^[A-Za-z0-9_-]{43}$/;

/**
 * True iff `value` is a canonical, unpadded base64url encoding of a 32-byte
 * Ed25519 public key. The length check alone is not enough: the round trip
 * proves the encoding is canonical (43 base64url characters encode 32 bytes and
 * two leftover bits, so a non-canonical tail would re-encode differently).
 */
export function isCanonicalEd25519Base64url(value: unknown): boolean {
  if (typeof value !== "string" || !CANONICAL_B64URL_43.test(value)) return false;
  try {
    const buf = Buffer.from(value, "base64url");
    return buf.length === 32 && buf.toString("base64url") === value;
  } catch {
    return false;
  }
}

/**
 * The audit fingerprint of a registered key: sha256 (hex) of its canonical
 * base64url string. The key itself is never stored or logged.
 */
export function keyFingerprint(canonicalKey: string): string {
  return createHash("sha256").update(canonicalKey, "utf8").digest("hex");
}
