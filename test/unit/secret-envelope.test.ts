// Compatibility tests for src/lib/secret-envelope.ts.
//
// The claim under test is NOT "our encrypt round-trips with our decrypt" — we
// have no decrypt, and self-consistency would prove nothing anyway. The claim is
// that **Harper can read what we write**, so the oracle has to be Harper's code.
//
// `parseEnvelopeFields` and `decryptEnvelope` below are vendored VERBATIM from
// the published `harper@5.2.0` (`utility/secretEnvelope.ts`, MIT, "intentionally
// free of Harper imports … safe to publish"). They are the reference reader, not
// a reimplementation of it — if they drift from upstream this test stops meaning
// what it says, so they carry the version they came from.
//
// Why vendor rather than import `harper`: flair bundles 5.1.x today, which does
// not have this module, and the whole point is that we build envelopes for
// REMOTE targets whose version we discover at runtime. Importing would tie the
// test to the engine we ship instead of the one that will read the secret.
import { describe, expect, test } from "bun:test";
import { createDecipheriv, generateKeyPairSync, privateDecrypt, constants } from "node:crypto";
import { encryptEnvelope, fingerprintOf, sealSecret, ENV_ENCRYPTED_PREFIX } from "../../src/lib/secret-envelope.js";

// ─── Reference reader, harper@5.2.0 utility/secretEnvelope.ts ────────────────
const BASE64_REGEX = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/;

interface RefFields { kid?: string; k: string; iv: string; ct: string; tag: string }

function parseEnvelopeFields(body: string): RefFields {
  let env: RefFields;
  try {
    env = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new Error("malformed secret envelope");
  }
  if (!env || typeof env !== "object" || Array.isArray(env) || (env.kid !== undefined && typeof env.kid !== "string")) {
    throw new Error("malformed secret envelope");
  }
  for (const field of ["k", "iv", "ct", "tag"] as const) {
    const v = env[field];
    if (typeof v !== "string" || (v.length === 0 && field !== "ct") || !BASE64_REGEX.test(v)) {
      throw new Error("malformed secret envelope");
    }
  }
  return env;
}

function decryptEnvelope(body: string, privateKeyPem: string, keyFingerprint: string): string {
  const env = parseEnvelopeFields(body);
  if (env.kid && env.kid !== keyFingerprint) throw new Error(`no secrets key for kid ${env.kid}`);
  const aesKey = privateDecrypt(
    { key: privateKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(env.k, "base64"),
  );
  const decipher = createDecipheriv("aes-256-gcm", aesKey, Buffer.from(env.iv, "base64"));
  decipher.setAuthTag(Buffer.from(env.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(env.ct, "base64")), decipher.final()]).toString("utf8");
}
// ─── end reference ──────────────────────────────────────────────────────────

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKey, privateKey };
}

describe("secret envelopes are readable by Harper's own decryptor", () => {
  test("a sealed value decrypts back to the plaintext", () => {
    const { publicKey, privateKey } = keypair();
    const body = encryptEnvelope("FLAIR_MCP_OAUTH=1", publicKey);
    expect(decryptEnvelope(body, privateKey, fingerprintOf(publicKey))).toBe("FLAIR_MCP_OAUTH=1");
  });

  test("a multi-line PEM survives — the signing key is the real payload", () => {
    // The RS256 signing key is the largest and most structurally fragile thing
    // we send: newlines, header/footer lines, base64 body. A format that mangled
    // it would still look fine on a short value.
    const { publicKey, privateKey } = keypair();
    const { privateKey: payload } = keypair();
    const body = encryptEnvelope(payload, publicKey);
    const out = decryptEnvelope(body, privateKey, fingerprintOf(publicKey));
    expect(out).toBe(payload);
    expect(out.split("\n").length).toBeGreaterThan(3);
  });

  test("the empty value is representable", () => {
    // parseEnvelopeFields allows an empty `ct` specifically — so an empty secret
    // must round-trip rather than being rejected as malformed.
    const { publicKey, privateKey } = keypair();
    expect(decryptEnvelope(encryptEnvelope("", publicKey), privateKey, fingerprintOf(publicKey))).toBe("");
  });

  test("unicode survives the utf8 boundary", () => {
    const { publicKey, privateKey } = keypair();
    const v = "clé—secret—🔐";
    expect(decryptEnvelope(encryptEnvelope(v, publicKey), privateKey, fingerprintOf(publicKey))).toBe(v);
  });

  test("the body parses as a well-formed envelope by the reference parser", () => {
    const { publicKey } = keypair();
    const env = parseEnvelopeFields(encryptEnvelope("x", publicKey));
    for (const f of ["k", "iv", "ct", "tag"] as const) expect(typeof env[f]).toBe("string");
    expect(env.kid).toBe(fingerprintOf(publicKey));
  });
});

// ─── Format assertions, added because mutation testing exposed the gap ───────
//
// The tests above verify DECRYPTABILITY BY THE REFERENCE, and that turned out to
// be a weaker claim than "the format is right". Two deliberate deviations were
// NOT caught by them:
//
//   base64 body instead of base64url  -> still decrypts; Node's base64url
//                                        decoder accepts standard base64
//   16-byte IV instead of 12          -> still decrypts; GCM accepts variable
//                                        IV lengths and the length is carried
//                                        in the envelope itself
//
// Neither breaks Harper today. Both are wire-format drift that survives only
// because the reader is lenient, and "works because the other side forgives it"
// is not a property to ship a credential on. So the shape is asserted directly.
describe("the wire format is exactly as specified, not merely decryptable", () => {
  test("the IV is 12 bytes — the GCM standard, not whatever still decrypts", () => {
    const { publicKey } = keypair();
    const env = parseEnvelopeFields(encryptEnvelope("x", publicKey));
    expect(Buffer.from(env.iv, "base64").length).toBe(12);
  });

  test("the AES key is 256-bit", () => {
    // Recovered through the reference's own RSA unwrap, so this asserts what the
    // reader will actually receive rather than what we intended to send.
    const { publicKey, privateKey } = keypair();
    const env = parseEnvelopeFields(encryptEnvelope("x", publicKey));
    const aesKey = privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      Buffer.from(env.k, "base64"),
    );
    expect(aesKey.length).toBe(32);
  });

  test("the body is base64url — no +, / or = padding", () => {
    const { publicKey } = keypair();
    const body = encryptEnvelope("x".repeat(64), publicKey);
    expect(body).not.toMatch(/[+/=]/);
    expect(body).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("the GCM tag is 16 bytes", () => {
    const { publicKey } = keypair();
    const env = parseEnvelopeFields(encryptEnvelope("x", publicKey));
    expect(Buffer.from(env.tag, "base64").length).toBe(16);
  });
});

describe("the tests can actually fail (positive controls)", () => {
  // A compatibility suite that passes on a broken implementation is worse than
  // none — it certifies the thing it cannot see.
  test("a tampered ciphertext is rejected by the GCM tag", () => {
    const { publicKey, privateKey } = keypair();
    const env = JSON.parse(Buffer.from(encryptEnvelope("secret", publicKey), "base64url").toString("utf8"));
    const ct = Buffer.from(env.ct, "base64");
    ct[0] = ct[0] ^ 0xff;
    env.ct = ct.toString("base64");
    const tampered = Buffer.from(JSON.stringify(env)).toString("base64url");
    expect(() => decryptEnvelope(tampered, privateKey, fingerprintOf(publicKey))).toThrow();
  });

  test("a wrong kid is refused rather than decrypted", () => {
    const { publicKey, privateKey } = keypair();
    const body = encryptEnvelope("secret", publicKey);
    expect(() => decryptEnvelope(body, privateKey, "0".repeat(64))).toThrow(/no secrets key for kid/);
  });

  test("the wrong private key cannot open it", () => {
    const { publicKey } = keypair();
    const { privateKey: other } = keypair();
    expect(() => decryptEnvelope(encryptEnvelope("secret", publicKey), other, fingerprintOf(publicKey))).toThrow();
  });

  test("two seals of one value differ — the AES key and IV are per-call", () => {
    const { publicKey } = keypair();
    expect(encryptEnvelope("same", publicKey)).not.toBe(encryptEnvelope("same", publicKey));
  });
});

describe("sealSecret", () => {
  test("prefixes the marker and leaves a decryptable body behind it", () => {
    const { publicKey, privateKey } = keypair();
    const sealed = sealSecret("v", publicKey);
    expect(sealed.startsWith(ENV_ENCRYPTED_PREFIX)).toBe(true);
    const body = sealed.slice(ENV_ENCRYPTED_PREFIX.length);
    expect(decryptEnvelope(body, privateKey, fingerprintOf(publicKey))).toBe("v");
  });

  test("the marker is exactly Harper's", () => {
    // Keyed on verbatim in Harper's env loader; a drifted marker means the value
    // is stored as literal ciphertext and never decrypted.
    expect(ENV_ENCRYPTED_PREFIX).toBe("enc:v1:");
  });
});
