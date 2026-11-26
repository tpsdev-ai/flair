import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, fstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getPassphrase, keystore, keyPath, keysDir } from "../../src/keystore.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const SAVED_HOME = process.env.HOME;
const SAVED_PASSPHRASE = process.env.FLAIR_KEY_PASSPHRASE;

beforeEach(() => {
  process.env.HOME = tempDir("flair-3120-keys-");
  delete process.env.FLAIR_KEY_PASSPHRASE;
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
    // The replacement has a new inode.
    expect(st.ino).not.toBe(inodeBefore);
  });

  test("a 0644 passphrase file is refused before it is read", () => {
    delete process.env.FLAIR_KEY_PASSPHRASE;
    const seed = new Uint8Array(32).fill(9);
    keystore.setPrivateKeySeed("instance-a", seed);
    const pp = join(keysDir(), ".passphrase");
    expect(statSync(pp).mode & 0o777).toBe(0o600);
    const seedPath = keyPath("instance-a");
    const storedBefore = readFileSync(seedPath);
    chmodSync(pp, 0o644);

    expect(() => keystore.setPrivateKeySeed("instance-b", seed)).toThrow(`chmod 600 ${pp}`);
    expect(existsSync(keyPath("instance-b"))).toBe(false);
    // The existing seed is not decrypted: with a valid passphrase it would return.
    expect(keystore.getPrivateKeySeed("instance-a")).toBeNull();
    expect(readFileSync(seedPath).equals(storedBefore)).toBe(true);
    expect(statSync(pp).mode & 0o777).toBe(0o644);
  });
});

for (const mode of [0o644, 0o600]) {
  test(`a competing ${mode.toString(8)} passphrase is preserved`, () => {
    const pp = join(keysDir(), ".passphrase");
    const winner = "competing-passphrase";
    let winnerInode = 0;
    let reads = 0;
    const hooks = {
      beforePublish: () => {
        writeFileSync(pp, winner, { mode });
        chmodSync(pp, mode);
        winnerInode = statSync(pp).ino;
      },
      read: (source: string | number) => {
        reads++;
        return readFileSync(source, "utf-8");
      },
    };
    if (mode === 0o644) {
      expect(() => getPassphrase(hooks)).toThrow(`chmod 600 ${pp}`);
      expect(reads).toBe(0);
    } else {
      expect(getPassphrase(hooks)).toBe(winner);
      expect(reads).toBe(1);
    }
    expect(readFileSync(pp, "utf-8")).toBe(winner);
    expect(statSync(pp).mode & 0o777).toBe(mode);
    expect(statSync(pp).ino).toBe(winnerInode);
    expect(readdirSync(keysDir())).toEqual([".passphrase"]);
  });
}

test("interleaved first uses return the stored passphrase", () => {
  let winner = "";
  const result = getPassphrase({ beforePublish: () => { winner = getPassphrase(); } });
  expect(result).toBe(winner);
  expect(readFileSync(join(keysDir(), ".passphrase"), "utf-8")).toBe(winner);
  expect(readdirSync(keysDir())).toEqual([".passphrase"]);
});

for (const code of ["ENOTSUP", "ENOSYS"]) {
  test(`passphrase publication refuses ${code} and removes its stage`, () => {
    let staged = "";
    expect(() => getPassphrase({ link: (source, destination) => {
      staged = String(source);
      expect(destination).toBe(join(keysDir(), ".passphrase"));
      expect(readFileSync(staged, "utf8")).not.toBe("");
      throw Object.assign(new Error("unsupported link"), { code });
    } })).toThrow(`keys dir ${keysDir()} does not support hard links; set FLAIR_KEY_PASSPHRASE or use a keys dir on a volume that does`);
    expect(staged).not.toBe("");
    expect(existsSync(staged)).toBe(false);
    expect(readdirSync(keysDir())).toEqual([]);
  });
}

for (const content of ["", " \n\t"]) {
  test(`an empty trimmed passphrase (${JSON.stringify(content)}) refuses seed encryption`, () => {
    mkdirSync(keysDir(), { recursive: true, mode: 0o700 });
    const pp = join(keysDir(), ".passphrase");
    writeFileSync(pp, content, { mode: 0o600 });
    expect(statSync(pp).mode & 0o777).toBe(0o600);
    expect(() => keystore.setPrivateKeySeed("instance-empty", new Uint8Array(32))).toThrow(`passphrase file ${pp} is empty`);
    expect(readFileSync(pp, "utf8")).toBe(content);
    expect(readdirSync(keysDir())).toEqual([".passphrase"]);
  });
}

test("a wide passphrase is refused without reading bytes", () => {
  mkdirSync(keysDir(), { recursive: true });
  const pp = join(keysDir(), ".passphrase");
  writeFileSync(pp, "wide", { mode: 0o644 });
  chmodSync(pp, 0o644);
  let reads = 0;
  expect(() => getPassphrase({ read: (source) => {
    reads++;
    return readFileSync(source, "utf-8");
  } })).toThrow(`chmod 600 ${pp}`);
  expect(reads).toBe(0);
});

test("a passphrase symlink is refused without reading its target", () => {
  mkdirSync(keysDir(), { recursive: true });
  const target = join(keysDir(), "target");
  writeFileSync(target, "target-passphrase", { mode: 0o600 });
  symlinkSync(target, join(keysDir(), ".passphrase"));
  let reads = 0;
  expect(() => getPassphrase({ read: (source) => {
    reads++;
    return readFileSync(source, "utf-8");
  } })).toThrow();
  expect(reads).toBe(0);
});

test("passphrase reading uses the checked descriptor after path replacement", () => {
  mkdirSync(keysDir(), { recursive: true });
  const pp = join(keysDir(), ".passphrase");
  writeFileSync(pp, "original-passphrase", { mode: 0o600 });
  expect(getPassphrase({ fstat: (fd) => {
    const st = fstatSync(fd);
    renameSync(pp, `${pp}.old`);
    writeFileSync(pp, "replacement-passphrase", { mode: 0o600 });
    return st;
  } })).toBe("original-passphrase");
});
