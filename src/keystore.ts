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
import { resolveHome } from "./lib/home.js";
import { writeFilesAtomically } from "./lib/atomic-write.js";
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

/**
 * The keystore's home comes from the ONE shared resolver (src/lib/home.ts,
 * flair#1853 round 3): resolved at CALL time, with the platform rule (Windows
 * uses USERPROFILE, everywhere else HOME). The runtime caches `os.homedir()` at
 * process start, so a HOME set after start — the test harness in
 * test/helpers/sandbox-home.ts — would otherwise be invisible and the keystore
 * would reach the REAL ~/.flair/keys.
 */
function keysDir(): string {
  return join(resolveHome(), ".flair", "keys");
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

// ─── Seed ownership sidecars (flair#2200) ───────────────────────────────────
/** File name suffix of a seed's ownership sidecar, appended to the seed path. */
export const SEED_OWNER_SUFFIX = ".owner.json";

/** The sidecar's schema version. */
export const SEED_OWNER_VERSION = 1;

/** What a seed's ownership sidecar records. */
export interface SeedOwnerRecord {
  v: number;
  /** The Instance id the seed was minted for (equal to the seed's own file id). */
  instanceId: string;
  /** The data directory of the instance whose Instance table references that id. */
  dataDir: string;
}

/** The outcome of reading a seed's ownership sidecar. */
export type SeedOwnerRead =
  | { state: "ok"; instanceId: string; dataDir: string }
  | { state: "absent" }
  | { state: "unreadable"; reason: string }
  | { state: "malformed"; reason: string };

/** The sidecar path for `instanceId` — the seed path plus the owner suffix. */
export function seedOwnerPath(instanceId: string): string {
  return `${keyPath(instanceId)}${SEED_OWNER_SUFFIX}`;
}

/** Serialize an ownership record to the exact bytes the sidecar holds. */
export function serializeSeedOwner(record: SeedOwnerRecord): string {
  return `${JSON.stringify(record)}\n`;
}

/** Parse sidecar bytes into a read result. Pure — no filesystem access. */
export function parseSeedOwner(raw: string): SeedOwnerRead {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    return { state: "malformed", reason: `not valid JSON (${err instanceof Error ? err.message : String(err)})` };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { state: "malformed", reason: "not a JSON object" };
  }
  const rec = value as Record<string, unknown>;
  if (rec.v !== SEED_OWNER_VERSION) {
    return { state: "malformed", reason: `unsupported owner-record version ${JSON.stringify(rec.v)}` };
  }
  if (typeof rec.instanceId !== "string" || rec.instanceId.trim() === "") {
    return { state: "malformed", reason: "no instance id" };
  }
  if (typeof rec.dataDir !== "string" || rec.dataDir.trim() === "") {
    return { state: "malformed", reason: "no data directory" };
  }
  return { state: "ok", instanceId: rec.instanceId, dataDir: rec.dataDir };
}

/** Read a sidecar from its path, distinguishing absent / unreadable / malformed. */
export function readSeedOwnerAt(ownerPath: string): SeedOwnerRead {
  if (!existsSync(ownerPath)) return { state: "absent" };
  let raw: string;
  try {
    raw = readFileSync(ownerPath, "utf-8");
  } catch (err) {
    return { state: "unreadable", reason: err instanceof Error ? err.message : String(err) };
  }
  return parseSeedOwner(raw);
}

/** Read the ownership sidecar for `instanceId`, if any. */
export function readSeedOwner(instanceId: string): SeedOwnerRead {
  return readSeedOwnerAt(seedOwnerPath(instanceId));
}

/**
 * Record an instance seed's owner: write the sidecar atomically (owner-only,
 * mode 0600) beside the seed. The writer is the mint; a reader never invents
 * one. Throws on a write failure — the caller decides whether that is fatal.
 */
export function recordSeedOwner(instanceId: string, dataDir: string): void {
  const dir = keysDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFilesAtomically([
    {
      path: seedOwnerPath(instanceId),
      content: serializeSeedOwner({ v: SEED_OWNER_VERSION, instanceId, dataDir }),
      mode: 0o600,
    },
  ]);
}

// Export helpers for testing
export { encryptSeed, decryptSeed, deriveKey, keyPath, keysDir };
