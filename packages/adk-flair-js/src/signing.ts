/**
 * TPS-Ed25519 request signing for adk-flair.
 *
 * Loads a PKCS8 base64-encoded Ed25519 private key from a keyfile and
 * produces `TPS-Ed25519 <agent-id>:<timestamp>:<nonce>:<base64-sig>`
 * Authorization headers for Flair API requests.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// PKCS8 DER prefix for an Ed25519 private key. Prepending this to a raw
// 32-byte seed yields a full 48-byte PKCS8 DER that `createPrivateKey` accepts.
// Mirrors src/lib/auth-resolve.ts:buildEd25519Auth so the adapter reads exactly
// the keyfiles Flair itself writes and signs with.
const ED25519_PKCS8_HEADER = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);

/**
 * Expand a leading `~` / `~/` to the current user's home directory.
 *
 * `flair agent add <id>` and the README both hand users paths like
 * `~/.flair/keys/<id>.key`. Node's `fs` does not expand `~` — a shell does —
 * so a raw `readFileSync("~/...")` throws ENOENT for a cold user copying the
 * quickstart verbatim. Expand here so the documented path just works.
 */
export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/**
 * Load and validate an Ed25519 private key from a Flair keyfile.
 *
 * Accepts every on-disk encoding Flair itself produces or consumes (mirrors
 * src/lib/auth-resolve.ts), so the keyfile written by `flair agent add`
 * (a raw 32-byte seed) loads without a conversion step:
 *
 *   - raw 32-byte Ed25519 seed (binary) — what `flair agent add` writes
 *   - base64-encoded raw 32-byte seed
 *   - base64-encoded PKCS8 DER (the historical adk-flair format)
 *   - PEM (`-----BEGIN PRIVATE KEY-----`)
 *
 * Parses the key material eagerly (in the constructor path) so that a bad
 * keyfile fails immediately — before ADK's exception-swallowing search path
 * can turn it into permanent silent empty recall.
 *
 * A leading `~`/`~/` in the path is expanded to the home directory.
 *
 * @param keyfilePath - Path to the keyfile (`~` accepted)
 * @returns A Node.js KeyObject for the Ed25519 private key
 * @throws If the keyfile is missing, unreadable, or contains invalid key material
 */
export function loadEd25519Key(keyfilePath: string): crypto.KeyObject {
  const resolvedPath = expandHome(keyfilePath);

  let raw: Buffer;
  try {
    raw = fs.readFileSync(resolvedPath);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      throw new Error(
        `FLAIR_KEYFILE: keyfile not found at "${resolvedPath}"` +
          (resolvedPath !== keyfilePath ? ` (expanded from "${keyfilePath}")` : "") +
          `. Provision one with: flair agent add <agent-id> ` +
          `(writes ~/.flair/keys/<agent-id>.key), then point FLAIR_KEYFILE at it.`,
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `FLAIR_KEYFILE: cannot read keyfile at "${resolvedPath}": ${msg}`,
    );
  }

  if (raw.length === 0) {
    throw new Error(`FLAIR_KEYFILE: keyfile at "${resolvedPath}" is empty`);
  }

  let key: crypto.KeyObject;
  try {
    key = parseEd25519(raw);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `FLAIR_KEYFILE: invalid Ed25519 key material in "${resolvedPath}": ${msg}`,
    );
  }

  // Verify it's actually an Ed25519 key
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(
      `FLAIR_KEYFILE: expected Ed25519 key in "${resolvedPath}", ` +
        `got ${key.asymmetricKeyType ?? "unknown"}`,
    );
  }

  return key;
}

/**
 * Turn raw keyfile bytes into an Ed25519 KeyObject, trying each format Flair
 * emits. Throws if none parse.
 */
function parseEd25519(raw: Buffer): crypto.KeyObject {
  // 1) Raw 32-byte seed on disk (binary) — `flair agent add` format.
  if (raw.length === 32) {
    return crypto.createPrivateKey({
      key: Buffer.concat([ED25519_PKCS8_HEADER, raw]),
      format: "der",
      type: "pkcs8",
    });
  }

  const text = raw.toString("utf-8").trim();

  // 2) PEM.
  if (text.includes("-----BEGIN")) {
    return crypto.createPrivateKey(text);
  }

  // 3/4) base64 — either a raw 32-byte seed or a full PKCS8 DER.
  const decoded = Buffer.from(text, "base64");
  if (decoded.length === 0) {
    throw new Error("keyfile did not decode to any key material");
  }
  if (decoded.length === 32) {
    return crypto.createPrivateKey({
      key: Buffer.concat([ED25519_PKCS8_HEADER, decoded]),
      format: "der",
      type: "pkcs8",
    });
  }
  return crypto.createPrivateKey({
    key: decoded,
    format: "der",
    type: "pkcs8",
  });
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
