/**
 * Keystore — encrypted file-based storage for Ed25519 private key seeds.
 *
 * Primary: AES-256-GCM encrypted files at ~/.flair/keys/<instanceId>.key
 * Fallback: HarperDB (migration path from pre-keystore installs)
 *
 * Encryption key derived via HKDF from FLAIR_KEY_PASSPHRASE env var,
 * or an auto-generated random passphrase stored at ~/.flair/keys/.passphrase
 * (mode 0600). Never falls back to guessable data.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  hkdfSync,
} from "node:crypto";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface KeyStore {
  getPrivateKeySeed(instanceId: string): Uint8Array | null;
  setPrivateKeySeed(instanceId: string, seed: Uint8Array): void;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function keysDir(): string {
  return join(homedir(), ".flair", "keys");
}

function keyPath(instanceId: string): string {
  // Sanitize instanceId to prevent directory traversal
  const safe = instanceId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(keysDir(), `${safe}.key`);
}

/**
 * Path to the auto-generated passphrase file.
 * Created on first keystore use if FLAIR_KEY_PASSPHRASE env var is not set.
 */
function passphrasePath(): string {
  return join(keysDir(), ".passphrase");
}

/**
 * Get or create the keystore passphrase.
 * Priority: FLAIR_KEY_PASSPHRASE env var > auto-generated file.
 * Never falls back to guessable data (hostname, username, etc.).
 */
function getPassphrase(): string {
  // Explicit env var takes priority
  if (process.env.FLAIR_KEY_PASSPHRASE) {
    return process.env.FLAIR_KEY_PASSPHRASE;
  }

  const pp = passphrasePath();

  // Read existing auto-generated passphrase
  if (existsSync(pp)) {
    return readFileSync(pp, "utf-8").trim();
  }

  // Generate a cryptographically random passphrase and persist it
  const dir = keysDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const generated = randomBytes(32).toString("base64url");
  writeFileSync(pp, generated, { mode: 0o600 });
  return generated;
}

/**
 * Derive a 256-bit encryption key using HKDF.
 * Input keying material: FLAIR_KEY_PASSPHRASE env var, or auto-generated random passphrase.
 */
function deriveKey(): Buffer {
  const passphrase = getPassphrase();
  return Buffer.from(
    hkdfSync("sha256", passphrase, "flair-keystore-salt", "flair-key-encryption", 32),
  );
}

// ─── File-based encrypted keystore ──────────────────────────────────────────

/**
 * Encrypt a seed with AES-256-GCM.
 * File format: 12-byte IV | 16-byte auth tag | ciphertext
 */
function encryptSeed(seed: Uint8Array): Buffer {
  const key = deriveKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(seed), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]);
}

/**
 * Decrypt a seed from the file format.
 */
function decryptSeed(data: Buffer): Uint8Array {
  const key = deriveKey();
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const ciphertext = data.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return new Uint8Array(decrypted);
}

// ─── KeyStore implementation ────────────────────────────────────────────────

class FileKeyStore implements KeyStore {
  getPrivateKeySeed(instanceId: string): Uint8Array | null {
    const p = keyPath(instanceId);
    if (!existsSync(p)) return null;
    try {
      const data = readFileSync(p);
      return decryptSeed(data);
    } catch {
      return null;
    }
  }

  setPrivateKeySeed(instanceId: string, seed: Uint8Array): void {
    const dir = keysDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const p = keyPath(instanceId);
    const encrypted = encryptSeed(seed);
    writeFileSync(p, encrypted, { mode: 0o600 });
  }
}

/** Singleton keystore instance. */
export const keystore: KeyStore = new FileKeyStore();

// Export helpers for testing
export { encryptSeed, decryptSeed, deriveKey, keyPath, keysDir };
