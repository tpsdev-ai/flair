/**
 * flair#3120: the federation node keystore seed file and its generated
 * passphrase file stay owner-only when the file already exists.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keystore, keyPath, keysDir } from "../../src/keystore.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const SAVED_HOME = process.env.HOME;
const SAVED_PASSPHRASE = process.env.FLAIR_KEY_PASSPHRASE;

beforeEach(() => {
  process.env.HOME = tempDir("flair-3120-keys-");
});

afterEach(() => {
  if (SAVED_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = SAVED_HOME;
  if (SAVED_PASSPHRASE === undefined) delete process.env.FLAIR_KEY_PASSPHRASE;
  else process.env.FLAIR_KEY_PASSPHRASE = SAVED_PASSPHRASE;
});

describe("keystore credential files (flair#3120)", () => {
  test("setPrivateKeySeed over an existing 0644 seed publishes the new bytes at 0600", () => {
    process.env.FLAIR_KEY_PASSPHRASE = "test-passphrase-3120";
    const seed = new Uint8Array(32).fill(7);
    mkdirSync(keysDir(), { recursive: true, mode: 0o700 });
    const p = keyPath("instance-a");
    writeFileSync(p, "old-seed-bytes", { mode: 0o644 });
    chmodSync(p, 0o644);
    const inodeBefore = statSync(p).ino;

    keystore.setPrivateKeySeed("instance-a", seed);

    const stored = readFileSync(p);
    const st = statSync(p);
    expect(Array.from(keystore.getPrivateKeySeed("instance-a") ?? [])).toEqual(Array.from(seed));
    expect(stored.equals(Buffer.from("old-seed-bytes"))).toBe(false);
    expect(st.mode & 0o777).toBe(0o600);
    // A new inode means the bytes were published by rename, not written in place.
    expect(st.ino).not.toBe(inodeBefore);
  });

  test("a 0644 passphrase file is refused before it is read", () => {
    delete process.env.FLAIR_KEY_PASSPHRASE;
    const seed = new Uint8Array(32).fill(9);
    keystore.setPrivateKeySeed("instance-a", seed);
    const pp = join(keysDir(), ".passphrase");
    const seedPath = keyPath("instance-a");
    const storedBefore = readFileSync(seedPath);
    chmodSync(pp, 0o644);

    expect(() => keystore.setPrivateKeySeed("instance-b", seed)).toThrow(`chmod 600 ${pp}`);
    expect(existsSync(keyPath("instance-b"))).toBe(false);
    // The existing seed is not decrypted: with a valid passphrase it would return.
    expect(keystore.getPrivateKeySeed("instance-a")).toBeNull();
    expect(readFileSync(seedPath).equals(storedBefore)).toBe(true);
  });
});
