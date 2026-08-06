/**
 * Client-side `enc:v1:` secret envelopes — the wire format Harper's env-secrets
 * feature reads (`hdb_secret` store and encrypted `.env` entries).
 *
 * ── Why this is reimplemented rather than imported ──────────────────────────
 * `harper@5.2.0` ships this as `utility/secretEnvelope.ts`, deliberately free of
 * Harper imports and described in its own header as "safe to publish". We could
 * import it — except that `flair mcp enable` builds the envelope for a REMOTE
 * target whose Harper version is discovered at runtime and is routinely NEWER
 * than the one flair bundles. Importing would tie the format we can produce to
 * the engine we happen to ship, which is exactly backwards: the local engine has
 * nothing to do with what the remote instance can read.
 *
 * So it is reimplemented, and the compatibility claim is TESTED rather than
 * asserted — test/unit/secret-envelope.test.ts runs Harper's own
 * `decryptEnvelope` (vendored verbatim into the test as a reference oracle)
 * against envelopes this module produces. A round-trip against ourselves would
 * only prove self-consistency, which is worth nothing here: the reader is
 * someone else's code.
 *
 * ── The format, from harper@5.2.0 utility/secretEnvelope.ts ─────────────────
 * Hybrid: AES-256-GCM encrypts the value, RSA-OAEP(SHA-256) wraps the AES key.
 *
 *   envelope = base64url(JSON.stringify({ kid, k, iv, ct, tag }))
 *   kid = sha256(DER SPKI of the public key), hex
 *   k   = base64(RSA-OAEP(aesKey))     iv  = base64(12 random bytes)
 *   ct  = base64(ciphertext)           tag = base64(GCM auth tag)
 *
 * The `enc:v1:` marker is NOT part of the body — it is added by callers, the
 * same split Harper uses (the marker lives in `utility/envFile.ts`).
 *
 * Nothing here reads or writes a secret to disk, and no value is logged. The
 * plaintext exists only as an argument.
 */
import { createCipheriv, createHash, createPublicKey, publicEncrypt, randomBytes, constants } from "node:crypto";

/** Marker prefixed to an envelope body. Harper keys the encrypted-value path on this. */
export const ENV_ENCRYPTED_PREFIX = "enc:v1:";

export interface EnvelopeFields {
  kid?: string;
  k: string;
  iv: string;
  ct: string;
  tag: string;
}

/**
 * SHA-256 (hex) of the DER SPKI public key — the stable key id used as `kid`.
 *
 * The server derives `kid` from the sealed body and trusts only that one, never
 * a separate client-supplied field, so getting this wrong surfaces as a refusal
 * to decrypt rather than as a silently-wrong secret.
 */
export function fingerprintOf(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  return createHash("sha256").update(der as Buffer).digest("hex");
}

/**
 * Seal `plaintext` for the holder of `publicKeyPem`. Returns the envelope BODY,
 * without the `enc:v1:` marker.
 *
 * Randomised per call (fresh AES key and IV), so two calls on the same input
 * differ — which is why the tests assert decryptability by the reference
 * implementation rather than comparing against a fixed string.
 */
export function encryptEnvelope(plaintext: string, publicKeyPem: string, kid?: string): string {
  const aesKey = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", aesKey, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const k = publicEncrypt(
    { key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    aesKey,
  );
  const envelope: EnvelopeFields = {
    kid: kid ?? fingerprintOf(publicKeyPem),
    k: k.toString("base64"),
    iv: iv.toString("base64"),
    ct: ct.toString("base64"),
    tag: tag.toString("base64"),
  };
  return Buffer.from(JSON.stringify(envelope)).toString("base64url");
}

/** Seal and prefix — what a caller sends as `set_secret`'s `envelope` field. */
export function sealSecret(plaintext: string, publicKeyPem: string): string {
  return ENV_ENCRYPTED_PREFIX + encryptEnvelope(plaintext, publicKeyPem);
}
