/**
 * Keystore — encrypted file-based storage for Ed25519 private key seeds.
 *
 * Primary: AES-256-GCM encrypted files at ~/.flair/keys/<instanceId>.key
 * Fallback: HarperDB (migration path from pre-keystore installs)
 *
 * Encryption key derived via HKDF from FLAIR_KEY_PASSPHRASE env var,
 * or a machine-specific default (hostname + username). Not high-security
 * but strictly better than plaintext in the database.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir, hostname, userInfo } from "node:os";
import {
  createHash,
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
 * Derive a 256-bit encryption key using HKDF.
 * Input keying material: FLAIR_KEY_PASSPHRASE env var, or hostname+username.
 */
function deriveKey(): Buffer {
  const passphrase =
    process.env.FLAIR_KEY_PASSPHRASE ??
    `${hostname()}:${userInfo().username}:flair-keystore-default`;

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
