/**
 * agent-key-file-3077.test.ts — the shared agent-key file policy (flair#3077
 * slice A) on real files in a temp root.
 *
 * Covered (POSIX): a missing keys directory is requested with mode 0700 (the
 * umask may make it narrower) and observed at 0700 with zero umask before
 * anything else touches it; an existing 0755 directory the current user
 * owns is tightened with one notice line, while an owned 0500 keeps its mode;
 * a symlinked directory or key is refused; an existing key with group/world
 * bits is refused before its bytes are read; positive partial writes resume;
 * zero-byte and throwing writes fail and remove the temp file this call
 * created, best effort; an owner-only key that appears before
 * publication is reused, not overwritten; a reused key's directory is synced
 * before the key is returned, and a created keys directory repeats its parent
 * sync on the next call; and owned-by-another-user, non-directory and
 * non-regular paths are refused. An existing install whose flair home is
 * group-writable (umask 002) is tightened once with a notice, and the key
 * write proceeds.
 */
import { afterEach, describe, expect, mock, test, spyOn } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import { withHome } from "../../src/lib/home.ts";
import { program } from "../../src/cli.ts";
import {
  AgentKeyFileRefusal,
  createAgentKeyFile,
  ensureAgentKeysDir,
  readExistingAgentKey,
  readOrCreateAgentKey,
  setAgentKeyFileTestHooks,
} from "../../src/lib/agent-key-file.ts";

afterEach(() => {
  mock.restore();
});

function keysDir(): string {
  return join(tempDir("flair-keyfile-3077-"), "keys");
}

function tempEntries(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.includes(".tmp-"));
}

test("a missing keys directory requested with mode 0700 is observed at 0700 with zero umask before anything else touches it", () => {
  const dir = keysDir();
  const observed: number[] = [];
  setAgentKeyFileTestHooks({
    afterKeysDirCreate: (created) => {
      observed.push(statSync(created).mode & 0o777);
    },
  });
  const previous = process.umask(0);
  try {
    ensureAgentKeysDir(dir);
  } finally {
    process.umask(previous);
    setAgentKeyFileTestHooks(undefined);
  }
  expect(observed).toEqual([0o700]);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
});

test("an existing 0755 keys directory owned by the current user is tightened to 0700 with one notice", () => {
  const dir = keysDir();
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o755);
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  try {
    ensureAgentKeysDir(dir);
  } finally {
    log.mockRestore();
  }
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(lines.filter((line) => line.includes(dir))).toHaveLength(1);
  expect(lines[0]).toContain("tightened");
});

test("an owned keys directory without group or world bits keeps its mode", () => {
  const dir = keysDir();
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o500);
  ensureAgentKeysDir(dir);
  expect(statSync(dir).mode & 0o777).toBe(0o500);
});

test("a symlinked keys directory is refused", () => {
  const real = tempDir("flair-keyfile-3077-");
  mkdirSync(real, { recursive: true });
  const link = join(tempDir("flair-keyfile-3077-"), "keys");
  symlinkSync(real, link);
  expect(() => ensureAgentKeysDir(link)).toThrow(AgentKeyFileRefusal);
  expect(() => ensureAgentKeysDir(link)).toThrow(/symlink/);
});

test("a keys path that is a regular file is refused", () => {
  const dir = keysDir();
  writeFileSync(dir, "not a directory");
  expect(() => ensureAgentKeysDir(dir)).toThrow(/not a directory/);
});

test("a keys directory owned by another user is refused", () => {
  if (typeof process.getuid !== "function") return;
  const uid = process.getuid();
  const dir = keysDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // The ancestor walk reads the uid first and sees the real one; the
  // keys-directory check then sees a uid that does not own the directory.
  let calls = 0;
  spyOn(process, "getuid").mockImplementation(() => (calls++ === 0 ? uid : uid + 1));
  expect(() => ensureAgentKeysDir(dir)).toThrow(/not owned by the current user/);
});

test("a symlinked key file is refused", () => {
  const dir = keysDir();
  ensureAgentKeysDir(dir);
  const target = join(tempDir("flair-keyfile-3077-"), "target.key");
  writeFileSync(target, Buffer.alloc(32), { mode: 0o600 });
  const link = join(dir, "linked.key");
  symlinkSync(target, link);
  expect(() => readExistingAgentKey(link)).toThrow(/symlink/);
});

test("an existing key with group/world bits is refused before its bytes are read and is left untouched", () => {
  const dir = keysDir();
  ensureAgentKeysDir(dir);
  const keyPath = join(dir, "wide.key");
  const prior = Buffer.alloc(32, 7);
  writeFileSync(keyPath, prior, { mode: 0o600 });
  chmodSync(keyPath, 0o644);
  let readCalled = false;
  setAgentKeyFileTestHooks({
    beforeKeyRead: () => {
      readCalled = true;
    },
  });
  try {
    expect(() => readExistingAgentKey(keyPath)).toThrow(/chmod 600 /);
  } finally {
    setAgentKeyFileTestHooks(undefined);
  }
  expect(readCalled).toBe(false);
  const bytes = readFileSync(keyPath);
  expect(bytes.equals(prior)).toBe(true);
  expect(statSync(keyPath).mode & 0o777).toBe(0o644);
});

test("a key file owned by another user is refused", () => {
  if (typeof process.getuid !== "function") return;
  const uid = process.getuid();
  const dir = keysDir();
  ensureAgentKeysDir(dir);
  const keyPath = join(dir, "other.key");
  writeFileSync(keyPath, Buffer.alloc(32), { mode: 0o600 });
  spyOn(process, "getuid").mockReturnValue(uid + 1);
  expect(() => readExistingAgentKey(keyPath)).toThrow(/owned by another user/);
});

test("a key path that is a directory is refused", () => {
  const dir = keysDir();
  ensureAgentKeysDir(dir);
  const keyPath = join(dir, "dir.key");
  mkdirSync(keyPath);
  expect(() => readExistingAgentKey(keyPath)).toThrow(/not a regular file/);
});

test("a key path that is a FIFO is refused", () => {
  if (process.platform === "win32") return;
  const dir = keysDir();
  ensureAgentKeysDir(dir);
  const keyPath = join(dir, "pipe.key");
  const made = spawnSync("mkfifo", [keyPath], { timeout: 5000 });
  expect(made.status).toBe(0);
  expect(() => readExistingAgentKey(keyPath)).toThrow(/not a regular file/);
});

test("a throwing write leaves no key file and no temp file", () => {
  const dir = keysDir();
  ensureAgentKeysDir(dir);
  const sibling = join(dir, "keep.pub");
  writeFileSync(sibling, "keep");
  const keyPath = join(dir, "partial.key");
  setAgentKeyFileTestHooks({
    writeSeedFile: () => {
      throw new Error("fixture write failure");
    },
  });
  try {
    expect(() => createAgentKeyFile(keyPath, Buffer.alloc(32))).toThrow("fixture write failure");
  } finally {
    setAgentKeyFileTestHooks(undefined);
  }
  expect(existsSync(keyPath)).toBe(false);
  expect(tempEntries(dir)).toHaveLength(0);
  expect(readFileSync(sibling, "utf8")).toBe("keep");
});

test("a zero-byte write throws and leaves no file for the caller to register", () => {
  const dir = keysDir();
  ensureAgentKeysDir(dir);
  const keyPath = join(dir, "zero.key");
  const pubPath = join(dir, "zero.pub");
  setAgentKeyFileTestHooks({ writeSeedFile: () => 0 });
  try {
    expect(() => {
      readOrCreateAgentKey(keyPath, () => Buffer.alloc(32));
      writeFileSync(pubPath, "registered");
    }).toThrow(/short write/);
  } finally {
    setAgentKeyFileTestHooks(undefined);
  }
  expect(existsSync(keyPath)).toBe(false);
  expect(existsSync(pubPath)).toBe(false);
  expect(tempEntries(dir)).toHaveLength(0);
});

test("a short write followed by a zero-byte write throws and leaves no file", () => {
  const dir = keysDir();
  ensureAgentKeysDir(dir);
  const keyPath = join(dir, "short.key");
  let calls = 0;
  setAgentKeyFileTestHooks({
    writeSeedFile: () => (calls++ === 0 ? 8 : 0),
  });
  try {
    expect(() => createAgentKeyFile(keyPath, Buffer.alloc(32))).toThrow(/short write/);
  } finally {
    setAgentKeyFileTestHooks(undefined);
  }
  expect(existsSync(keyPath)).toBe(false);
  expect(tempEntries(dir)).toHaveLength(0);
});

test("a short write resumes until every byte is written", () => {
  const dir = keysDir();
  ensureAgentKeysDir(dir);
  const keyPath = join(dir, "resumed.key");
  const seed = Buffer.alloc(32, 3);
  let calls = 0;
  setAgentKeyFileTestHooks({
    writeSeedFile: (fd, value) => {
      if (calls++ === 0) {
        const part = value.subarray(0, 8);
        writeSync(fd, part);
        return part.length;
      }
      writeSync(fd, value);
      return value.length;
    },
  });
  try {
    createAgentKeyFile(keyPath, seed);
  } finally {
    setAgentKeyFileTestHooks(undefined);
  }
  expect(readFileSync(keyPath).equals(seed)).toBe(true);
  expect(tempEntries(dir)).toHaveLength(0);
});

test("the recorded identity is the temp file's when a hook replaces the final path right after publication", () => {
  const dir = keysDir();
  ensureAgentKeysDir(dir);
  const keyPath = join(dir, "swapped.key");
  const seed = Buffer.alloc(32, 7);
  let tempIdentity: { dev: number; ino: number } | undefined;
  let recorded: { dev: number; ino: number } | undefined;
  setAgentKeyFileTestHooks({
    beforeFirstWrite: (fd) => {
      const created = fstatSync(fd);
      tempIdentity = { dev: created.dev, ino: created.ino };
    },
    afterPublish: (finalPath) => {
      const replacement = join(dir, "swapped-replacement");
      writeFileSync(replacement, "replacement bytes");
      renameSync(replacement, finalPath);
    },
  });
  try {
    createAgentKeyFile(keyPath, seed, (_path, identity) => {
      recorded = identity;
    });
  } finally {
    setAgentKeyFileTestHooks(undefined);
  }
  expect(recorded).toEqual(tempIdentity);
  expect(readFileSync(keyPath, "utf8")).toBe("replacement bytes");
});

test("a file that appears at the final path before publish is reused, not overwritten", () => {
  const dir = keysDir();
  ensureAgentKeysDir(dir);
  const keyPath = join(dir, "raced.key");
  const raced = Buffer.alloc(32, 9);
  setAgentKeyFileTestHooks({
    beforePublish: (_tempPath, finalPath) => {
      writeFileSync(finalPath, raced, { mode: 0o600 });
    },
  });
  let contents: ReturnType<typeof readOrCreateAgentKey> | undefined;
  try {
    contents = readOrCreateAgentKey(keyPath, () => Buffer.alloc(32, 1));
  } finally {
    setAgentKeyFileTestHooks(undefined);
  }
  expect(contents?.created).toBe(false);
  expect(Buffer.from(contents!.bytes).equals(raced)).toBe(true);
  const bytes = readFileSync(keyPath);
  expect(bytes.equals(raced)).toBe(true);
  expect(tempEntries(dir)).toHaveLength(0);
});

test.skipIf(process.platform === "win32")("a raced key's directory sync failure refuses with nothing returned, and the raced key is returned once the sync works", () => {
  const dir = keysDir();
  ensureAgentKeysDir(dir);
  const keyPath = join(dir, "raced-unsynced.key");
  const raced = Buffer.alloc(32, 9);
  let syncFails = true;
  setAgentKeyFileTestHooks({
    beforePublish: (_tempPath, finalPath) => {
      writeFileSync(finalPath, raced, { mode: 0o600 });
    },
    syncKeysDir: (fd) => {
      if (syncFails) throw new Error("fixture sync failure");
      fsyncSync(fd);
    },
  });
  let returned: ReturnType<typeof readOrCreateAgentKey> | undefined;
  let caught: unknown;
  try {
    try {
      returned = readOrCreateAgentKey(keyPath, () => Buffer.alloc(32, 1));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgentKeyFileRefusal);
    expect((caught as Error).message).toContain("not confirmed durable");
    expect(returned).toBeUndefined();
    syncFails = false;
    returned = readOrCreateAgentKey(keyPath, () => Buffer.alloc(32, 1));
  } finally {
    setAgentKeyFileTestHooks(undefined);
  }
  expect(returned?.created).toBe(false);
  expect(Buffer.from(returned!.bytes).equals(raced)).toBe(true);
  expect(tempEntries(dir)).toHaveLength(0);
});

test.skipIf(process.platform === "win32")("a wide key appearing before publication is refused before reading and left untouched", () => {
  const dir = keysDir();
  ensureAgentKeysDir(dir);
  const keyPath = join(dir, "raced-wide.key");
  const raced = Buffer.alloc(32, 9);
  let reads = 0;
  setAgentKeyFileTestHooks({
    beforePublish: (_tempPath, finalPath) => {
      writeFileSync(finalPath, raced, { mode: 0o600 });
      chmodSync(finalPath, 0o644);
    },
    beforeKeyRead: () => {
      reads += 1;
    },
  });
  try {
    expect(() => readOrCreateAgentKey(keyPath, () => Buffer.alloc(32, 1))).toThrow(
      `run chmod 600 ${keyPath} to make it owner-only`,
    );
  } finally {
    setAgentKeyFileTestHooks(undefined);
  }
  expect(reads).toBe(0);
  expect(readFileSync(keyPath).equals(raced)).toBe(true);
  expect(statSync(keyPath).mode & 0o777).toBe(0o644);
  expect(tempEntries(dir)).toHaveLength(0);
});

test("a fresh key is 0600 at its first write under a zero umask and its bytes are complete", () => {
  const dir = keysDir();
  ensureAgentKeysDir(dir);
  const keyPath = join(dir, "fresh.key");
  const seed = Buffer.alloc(32, 1);
  const observed: number[] = [];
  setAgentKeyFileTestHooks({
    beforeFirstWrite: (fd) => {
      observed.push(fstatSync(fd).mode & 0o777);
    },
  });
  const previous = process.umask(0);
  try {
    createAgentKeyFile(keyPath, seed);
  } finally {
    process.umask(previous);
    setAgentKeyFileTestHooks(undefined);
  }
  expect(observed).toEqual([0o600]);
  const bytes = readFileSync(keyPath);
  expect(bytes.equals(seed)).toBe(true);
  expect(statSync(keyPath).mode & 0o777).toBe(0o600);
  expect(tempEntries(dir)).toHaveLength(0);
});

test.skipIf(process.platform === "win32")("createAgentKeyFile syncs the key's directory after publication", () => {
  const dir = keysDir();
  ensureAgentKeysDir(dir);
  const keyPath = join(dir, "durable.key");
  const events: string[] = [];
  let syncs = 0;
  setAgentKeyFileTestHooks({
    afterPublish: () => {
      events.push("published");
    },
    syncKeysDir: (fd) => {
      expect(fstatSync(fd).isDirectory()).toBe(true);
      syncs += 1;
      events.push("sync");
      fsyncSync(fd);
    },
  });
  try {
    createAgentKeyFile(keyPath, Buffer.alloc(32));
  } finally {
    setAgentKeyFileTestHooks(undefined);
  }
  expect(syncs).toBe(1);
  expect(events).toEqual(["published", "sync"]);
  expect(existsSync(keyPath)).toBe(true);
});

test.skipIf(process.platform === "win32")("the keys-directory sync uses the keys directory's own device and inode", () => {
  const dir = keysDir();
  ensureAgentKeysDir(dir);
  const keyPath = join(dir, "synced-identity.key");
  const moved = `${dir}.moved`;
  let syncs = 0;
  let synced: number[] = [];
  let checked: number[] = [];
  setAgentKeyFileTestHooks({
    syncKeysDir: (fd) => {
      const held = fstatSync(fd);
      const movedDir = statSync(moved);
      synced = [held.dev, held.ino];
      checked = [movedDir.dev, movedDir.ino];
      syncs += 1;
      fsyncSync(fd);
    },
  });
  // The final-path callback runs after the bound check and before the sync;
  // moving the checked directory there makes a fresh open of the path reach
  // the replacement, so only the held descriptor matches the moved directory.
  const onCreated = (path: string) => {
    if (path !== keyPath) return;
    renameSync(dir, moved);
    mkdirSync(dir, { mode: 0o700 });
  };
  try {
    createAgentKeyFile(keyPath, Buffer.alloc(32), onCreated);
  } finally {
    setAgentKeyFileTestHooks(undefined);
  }
  expect(syncs).toBe(1);
  expect(synced).toEqual(checked);
  expect(readdirSync(moved)).toContain("synced-identity.key");
});

test.skipIf(process.platform === "win32")("a keys directory replaced between the check and the write is refused and leaves no key in either directory", () => {
  const dir = keysDir();
  ensureAgentKeysDir(dir);
  const moved = `${dir}.moved`;
  setAgentKeyFileTestHooks({
    afterKeysDirCheck: () => {
      renameSync(dir, moved);
      mkdirSync(dir, { mode: 0o700 });
    },
  });
  let caught: unknown;
  try {
    createAgentKeyFile(join(dir, "agent-a.key"), Buffer.alloc(32));
  } catch (error) {
    caught = error;
  } finally {
    setAgentKeyFileTestHooks(undefined);
  }
  expect(caught).toBeInstanceOf(AgentKeyFileRefusal);
  expect((caught as Error).message).toBe(
    `keys directory ${dir} changed after the key was written; the key it wrote at ${join(dir, "agent-a.key")} was removed. ` +
      `Retry once the directory is stable`,
  );
  expect(readdirSync(moved)).toEqual([]);
  expect(readdirSync(dir)).toEqual([]);
});

test.skipIf(process.platform === "win32")("a keys directory moved after the key is linked is refused, and the key in the moved directory is reported, not removed", () => {
  const dir = keysDir();
  ensureAgentKeysDir(dir);
  const moved = `${dir}.moved`;
  setAgentKeyFileTestHooks({
    afterPublish: () => {
      renameSync(dir, moved);
      mkdirSync(dir, { mode: 0o700 });
    },
  });
  let caught: unknown;
  try {
    createAgentKeyFile(join(dir, "agent-a.key"), Buffer.alloc(32));
  } catch (error) {
    caught = error;
  } finally {
    setAgentKeyFileTestHooks(undefined);
  }
  expect(caught).toBeInstanceOf(AgentKeyFileRefusal);
  expect((caught as Error).message).toBe(
    `keys directory ${dir} changed after the key was written; the key path no longer names the file this command wrote, ` +
      `so a key linked into the checked directory before it moved was not removed. Retry once the directory is stable`,
  );
  // The moved directory keeps the linked key and its temp link; the
  // replacement is empty.
  const left = readdirSync(moved);
  expect(left).toHaveLength(2);
  expect(left).toContain("agent-a.key");
  expect(left.filter((name) => name.includes(".tmp-"))).toHaveLength(1);
  expect(readdirSync(dir)).toEqual([]);
});

test.skipIf(process.platform === "win32")("an older install's group-writable flair home is tightened once, and the key write succeeds", () => {
  const home = tempDir("flair-keyfile-3077-");
  const flairHome = join(home, ".flair");
  const dir = join(flairHome, "keys");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(flairHome, 0o775);
  chmodSync(dir, 0o775);
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  const previousUmask = process.umask(0o002);
  const firstRun: string[] = [];
  let secondRun: string[] = [];
  try {
    withHome(home, () => {
      createAgentKeyFile(join(dir, "agent-a.key"), Buffer.alloc(32));
    });
    firstRun.push(...lines);
    lines.length = 0;
    withHome(home, () => {
      createAgentKeyFile(join(dir, "agent-b.key"), Buffer.alloc(32));
    });
    secondRun = [...lines];
  } finally {
    process.umask(previousUmask);
    log.mockRestore();
  }
  expect(existsSync(join(dir, "agent-a.key"))).toBe(true);
  expect(existsSync(join(dir, "agent-b.key"))).toBe(true);
  expect(statSync(join(dir, "agent-a.key")).mode & 0o777).toBe(0o600);
  expect(statSync(flairHome).mode & 0o777).toBe(0o755);
  const notices = firstRun.filter((line) => line.includes(`Directory ${flairHome} in the flair home`));
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain("0775");
  expect(notices[0]).toContain("0755");
  expect(secondRun.filter((line) => line.includes(`Directory ${flairHome} in the flair home`))).toHaveLength(0);
});

test.skipIf(process.platform === "win32")("a keys directory under an ancestor another user can change is refused, naming that ancestor", () => {
  const home = tempDir("flair-keyfile-3077-");
  const shared = join(home, "shared");
  mkdirSync(shared, { mode: 0o700 });
  chmodSync(shared, 0o777);
  const dir = join(shared, "keys");
  let caught: unknown;
  try {
    withHome(home, () => {
      ensureAgentKeysDir(dir);
      createAgentKeyFile(join(dir, "agent-a.key"), Buffer.alloc(32));
    });
  } catch (error) {
    caught = error;
  } finally {
    setAgentKeyFileTestHooks(undefined);
  }
  expect(caught).toBeInstanceOf(AgentKeyFileRefusal);
  const message = (caught as Error).message;
  expect(message).toContain(shared);
  expect(message).toContain("0777");
  expect(message).toContain("uid");
  expect(existsSync(join(dir, "agent-a.key"))).toBe(false);
  expect(existsSync(dir)).toBe(false);
});

test.skipIf(process.platform === "win32")("an existing key under an ancestor another user can change is refused on reuse, with the ancestor refusal itself", () => {
  const home = tempDir("flair-keyfile-3077-");
  const shared = join(home, "shared");
  mkdirSync(shared, { mode: 0o700 });
  chmodSync(shared, 0o777);
  const dir = join(shared, "keys");
  mkdirSync(dir, { mode: 0o700 });
  const keyPath = join(dir, "agent-a.key");
  const prior = Buffer.alloc(32, 6);
  writeFileSync(keyPath, prior, { mode: 0o600 });
  let caught: unknown;
  try {
    withHome(home, () => {
      readOrCreateAgentKey(keyPath, () => {
        throw new Error("create must not run");
      });
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AgentKeyFileRefusal);
  const message = (caught as Error).message;
  expect(message.startsWith(`keys directory ${dir} has ancestor ${realpathSync(shared)} owned by uid`)).toBe(true);
  expect(message).not.toContain("could not sync");
  expect(readFileSync(keyPath).equals(prior)).toBe(true);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
});

test.skipIf(process.platform === "win32")("an ancestor inside the flair home owned by another uid is refused (stat seam: process.getuid)", () => {
  if (typeof process.getuid !== "function") return;
  const realUid = process.getuid();
  const home = tempDir("flair-keyfile-3077-");
  const flairHome = join(home, ".flair");
  const dir = join(flairHome, "keys");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Not writable by others, so only the owner rule can refuse it.
  chmodSync(flairHome, 0o755);
  // A single-user test cannot chown a directory; ownership is read through
  // process.getuid(), mocked to a uid that owns none of the directories. The
  // ancestor walk runs before the keys-directory check, so it refuses first.
  const getuid = spyOn(process, "getuid").mockImplementation(() => realUid + 1);
  let caught: unknown;
  try {
    withHome(home, () => {
      createAgentKeyFile(join(dir, "agent-a.key"), Buffer.alloc(32));
    });
  } catch (error) {
    caught = error;
  } finally {
    getuid.mockRestore();
  }
  expect(caught).toBeInstanceOf(AgentKeyFileRefusal);
  expect((caught as Error).message).toContain(`has ancestor ${realpathSync(flairHome)} owned by uid ${realUid} with mode 0755;`);
  expect(existsSync(join(dir, "agent-a.key"))).toBe(false);
  expect(statSync(flairHome).mode & 0o777).toBe(0o755);
});

test.skipIf(process.platform === "win32")("an ancestor outside the flair home owned by another uid is refused (stat seam: process.getuid)", () => {
  if (typeof process.getuid !== "function") return;
  const realUid = process.getuid();
  const home = tempDir("flair-keyfile-3077-");
  const custom = join(home, "custom");
  const dir = join(custom, "keys");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Not writable by others, so only the owner rule can refuse it.
  chmodSync(custom, 0o755);
  const getuid = spyOn(process, "getuid").mockImplementation(() => realUid + 1);
  let caught: unknown;
  try {
    withHome(home, () => {
      createAgentKeyFile(join(dir, "agent-a.key"), Buffer.alloc(32));
    });
  } catch (error) {
    caught = error;
  } finally {
    getuid.mockRestore();
  }
  expect(caught).toBeInstanceOf(AgentKeyFileRefusal);
  expect((caught as Error).message).toContain(`has ancestor ${realpathSync(custom)} owned by uid ${realUid} with mode 0755;`);
  expect(existsSync(join(dir, "agent-a.key"))).toBe(false);
  expect(statSync(custom).mode & 0o777).toBe(0o755);
});

test.skipIf(process.platform === "win32")("a refused ancestor leaves an existing keys directory's mode unchanged", () => {
  const home = tempDir("flair-keyfile-3077-");
  const shared = join(home, "shared");
  mkdirSync(shared, { mode: 0o700 });
  chmodSync(shared, 0o777);
  const ensured = join(shared, "ensured");
  const written = join(shared, "written");
  for (const dir of [ensured, written]) {
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o755);
  }
  const refusals: unknown[] = [];
  withHome(home, () => {
    const attempts = [
      () => ensureAgentKeysDir(ensured),
      () => createAgentKeyFile(join(written, "agent-a.key"), Buffer.alloc(32)),
    ];
    for (const attempt of attempts) {
      try {
        attempt();
      } catch (error) {
        refusals.push(error);
      }
    }
  });
  expect(refusals).toHaveLength(2);
  for (const refusal of refusals) {
    expect(refusal).toBeInstanceOf(AgentKeyFileRefusal);
    expect((refusal as Error).message).toContain(`has ancestor ${realpathSync(shared)} owned by uid`);
  }
  expect(readdirSync(written)).toEqual([]);
  expect(statSync(ensured).mode & 0o777).toBe(0o755);
  expect(statSync(written).mode & 0o777).toBe(0o755);
});

test.skipIf(process.platform === "win32")("a symlinked flair home tightens nothing: a group-writable directory in its target is refused and keeps its mode", () => {
  const home = tempDir("flair-keyfile-3077-");
  const target = tempDir("flair-keyfile-3077-target-");
  const child = join(target, "sub");
  mkdirSync(child, { mode: 0o700 });
  chmodSync(child, 0o775);
  symlinkSync(target, join(home, ".flair"));
  let caught: unknown;
  try {
    withHome(home, () => {
      ensureAgentKeysDir(join(home, ".flair", "sub", "keys"));
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AgentKeyFileRefusal);
  expect((caught as Error).message).toContain(`has ancestor ${realpathSync(child)} owned by uid`);
  expect(existsSync(join(child, "keys"))).toBe(false);
  expect(statSync(child).mode & 0o777).toBe(0o775);
});

test.skipIf(process.platform === "win32")("the walk continues past a tightened flair home and refuses a world-writable ancestor above it", () => {
  const home = tempDir("flair-keyfile-3077-");
  const flairHome = join(home, ".flair");
  const dir = join(flairHome, "keys");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(flairHome, 0o777);
  chmodSync(home, 0o757);
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  let caught: unknown;
  try {
    // One walk: createAgentKeyFile walks again before the write.
    withHome(home, () => {
      ensureAgentKeysDir(dir);
    });
  } catch (error) {
    caught = error;
  } finally {
    log.mockRestore();
  }
  expect(caught).toBeInstanceOf(AgentKeyFileRefusal);
  expect((caught as Error).message).toContain(`has ancestor ${realpathSync(home)} owned by uid`);
  expect((caught as Error).message).toContain("with mode 0757;");
  expect(lines.filter((line) => line.includes(`Directory ${realpathSync(flairHome)} in the flair home`))).toHaveLength(1);
  expect(statSync(flairHome).mode & 0o777).toBe(0o755);
});

test.skipIf(process.platform === "win32")("a keys directory replaced between its check and its open is refused and nothing is written", () => {
  const dir = keysDir();
  ensureAgentKeysDir(dir);
  const moved = `${dir}.moved`;
  setAgentKeyFileTestHooks({
    beforeKeysDirOpen: () => {
      renameSync(dir, moved);
      mkdirSync(dir, { mode: 0o700 });
    },
  });
  let caught: unknown;
  try {
    createAgentKeyFile(join(dir, "agent-a.key"), Buffer.alloc(32));
  } catch (error) {
    caught = error;
  } finally {
    setAgentKeyFileTestHooks(undefined);
  }
  expect(caught).toBeInstanceOf(AgentKeyFileRefusal);
  expect((caught as Error).message).toBe(
    `keys directory ${dir} changed while it was being checked; retry the command once the directory is stable`,
  );
  expect(readdirSync(moved)).toEqual([]);
  expect(readdirSync(dir)).toEqual([]);
});

test.skipIf(process.platform === "win32")("a failed directory sync leaves a key path that another file replaced", () => {
  const dir = keysDir();
  ensureAgentKeysDir(dir);
  const keyPath = join(dir, "replaced.key");
  const other = Buffer.alloc(32, 9);
  setAgentKeyFileTestHooks({
    afterPublish: () => {
      unlinkSync(keyPath);
      writeFileSync(keyPath, other, { mode: 0o600 });
    },
    syncKeysDir: () => {
      throw new Error("fixture sync failure");
    },
  });
  let caught: unknown;
  try {
    createAgentKeyFile(keyPath, Buffer.alloc(32));
  } catch (error) {
    caught = error;
  } finally {
    setAgentKeyFileTestHooks(undefined);
  }
  expect(caught).toBeInstanceOf(AgentKeyFileRefusal);
  expect((caught as Error).message).toContain("no longer names the file this command wrote");
  expect(readFileSync(keyPath).equals(other)).toBe(true);
});

test.skipIf(process.platform === "win32")("on win32 a reused key's directory is neither re-moded nor synced (platform seam: a bun child)", () => {
  const home = tempDir("flair-keyfile-3077-");
  const dir = join(home, "keys");
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o755);
  const prior = Buffer.alloc(32, 5);
  writeFileSync(join(dir, "agent-a.key"), prior, { mode: 0o600 });
  const script = join(home, "win32-reuse.mjs");
  writeFileSync(script, `
Object.defineProperty(process, "platform", { value: "win32" });
const { join } = await import("node:path");
const keyFile = await import(${JSON.stringify(new URL("../../src/lib/agent-key-file.ts", import.meta.url).href)});
let syncs = 0;
keyFile.setAgentKeyFileTestHooks({ syncKeysDir: () => { syncs += 1; } });
const result = keyFile.readOrCreateAgentKey(join(process.argv[2], "agent-a.key"), () => {
  throw new Error("create must not run");
});
console.log(JSON.stringify({ created: result.created, bytes: Buffer.from(result.bytes).toString("hex"), syncs }));
`);
  const child = spawnSync("bun", [script, dir], { encoding: "utf8", timeout: 20_000 });
  expect(child.status).toBe(0);
  const report = JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "{}");
  expect(report).toEqual({ created: false, bytes: prior.toString("hex"), syncs: 0 });
  expect(statSync(dir).mode & 0o777).toBe(0o755);
}, 30_000);

test.skipIf(process.platform === "win32")("a sticky world-writable ancestor with a user-owned keys directory passes", () => {
  const home = tempDir("flair-keyfile-3077-");
  const shared = join(home, "shared");
  mkdirSync(shared, { mode: 0o700 });
  // Bun's chmod drops the sticky bit (measured on bun 1.3.10), so a node child
  // installs the precondition while the code under test observes it.
  const chmod = spawnSync("node", ["-e", `require("node:fs").chmodSync(${JSON.stringify(shared)}, 0o1777)`], {
    timeout: 10_000,
  });
  expect(chmod.status).toBe(0);
  expect(statSync(shared).mode & 0o1000).toBe(0o1000);
  const dir = join(shared, "keys");
  ensureAgentKeysDir(dir);
  const keyPath = join(dir, "agent-a.key");
  createAgentKeyFile(keyPath, Buffer.alloc(32));
  expect(existsSync(keyPath)).toBe(true);
  expect(statSync(keyPath).mode & 0o777).toBe(0o600);
});

test.skipIf(process.platform === "win32")("a normal keys directory under the test home and a custom --keys-dir under it pass", () => {
  const home = tempDir("flair-keyfile-3077-");
  const standard = join(home, ".flair", "keys");
  const custom = join(home, "custom", "keys");
  ensureAgentKeysDir(standard);
  ensureAgentKeysDir(custom);
  createAgentKeyFile(join(standard, "agent-a.key"), Buffer.alloc(32));
  createAgentKeyFile(join(custom, "agent-b.key"), Buffer.alloc(32));
  expect(existsSync(join(standard, "agent-a.key"))).toBe(true);
  expect(existsSync(join(custom, "agent-b.key"))).toBe(true);
});

test.skipIf(process.platform === "win32")("a failed directory sync refuses with the published key path and removes the key", () => {
  const dir = keysDir();
  ensureAgentKeysDir(dir);
  const keyPath = join(dir, "unsynced.key");
  setAgentKeyFileTestHooks({
    syncKeysDir: () => {
      throw new Error("fixture sync failure");
    },
  });
  let caught: unknown;
  try {
    createAgentKeyFile(keyPath, Buffer.alloc(32));
  } catch (error) {
    caught = error;
  } finally {
    setAgentKeyFileTestHooks(undefined);
  }
  expect(caught).toBeInstanceOf(AgentKeyFileRefusal);
  expect((caught as Error).message).toContain(keyPath);
  expect((caught as Error).message).toContain("was removed");
  expect(existsSync(keyPath)).toBe(false);
  expect(tempEntries(dir)).toHaveLength(0);
});

test.skipIf(process.platform === "win32")("a keys directory replaced by a symlink after creation is refused and nothing is written", () => {
  const dir = keysDir();
  const real = join(tempDir("flair-keyfile-3077-"), "real");
  mkdirSync(real, { recursive: true });
  setAgentKeyFileTestHooks({
    afterKeysDirCreate: (created) => {
      rmSync(created, { recursive: true });
      symlinkSync(real, created);
    },
  });
  try {
    expect(() => ensureAgentKeysDir(dir)).toThrow(AgentKeyFileRefusal);
    expect(() => ensureAgentKeysDir(dir)).toThrow(/symlink/);
  } finally {
    setAgentKeyFileTestHooks(undefined);
  }
  expect(readdirSync(real)).toHaveLength(0);
});

test.skipIf(process.platform === "win32")("a reused key is refused when its directory sync fails, and returned once the sync works", () => {
  const dir = keysDir();
  ensureAgentKeysDir(dir);
  const keyPath = join(dir, "reused.key");
  writeFileSync(keyPath, Buffer.alloc(32, 3), { mode: 0o600 });
  let syncFails = true;
  setAgentKeyFileTestHooks({
    syncKeysDir: (fd) => {
      if (syncFails) throw new Error("fixture sync failure");
      fsyncSync(fd);
    },
  });
  const registered: string[] = [];
  const attempt = () => {
    const contents = readOrCreateAgentKey(keyPath, () => Buffer.alloc(32, 3));
    registered.push(`created=${contents.created}`);
    return contents;
  };
  try {
    // The existing key is read, then its directory sync fails; the key stays.
    expect(attempt).toThrow(/not confirmed durable/);
    expect(existsSync(keyPath)).toBe(true);
    // A retry reads the key again and repeats the sync before returning it.
    expect(attempt).toThrow(AgentKeyFileRefusal);
    expect(attempt).toThrow(/not confirmed durable/);
    expect(registered).toHaveLength(0);
    syncFails = false;
    expect(attempt().created).toBe(false);
  } finally {
    setAgentKeyFileTestHooks(undefined);
  }
  expect(registered).toEqual(["created=false"]);
  expect(readFileSync(keyPath).length).toBe(32);
});

test.skipIf(process.platform === "win32")("a created keys directory whose parent sync fails is refused, and the next call repeats the parent sync", () => {
  const dir = keysDir();
  const parent = dirname(dir);
  let syncFails = true;
  let syncs = 0;
  let syncedParent: { dev: number; ino: number } | undefined;
  setAgentKeyFileTestHooks({
    syncKeysDir: (fd) => {
      syncs += 1;
      const st = fstatSync(fd);
      syncedParent = { dev: st.dev, ino: st.ino };
      if (syncFails) throw new Error("fixture sync failure");
      fsyncSync(fd);
    },
  });
  try {
    expect(() => ensureAgentKeysDir(dir)).toThrow(AgentKeyFileRefusal);
    expect(syncs).toBe(1);
    expect(syncedParent).toEqual({ dev: statSync(parent).dev, ino: statSync(parent).ino });
    // The directory exists now, so the next call takes the existing branch and
    // repeats the parent sync; its failure refuses.
    expect(existsSync(dir)).toBe(true);
    expect(() => ensureAgentKeysDir(dir)).toThrow(/not confirmed durable/);
    expect(syncs).toBe(2);
    syncFails = false;
    ensureAgentKeysDir(dir);
  } finally {
    setAgentKeyFileTestHooks(undefined);
  }
  expect(syncs).toBe(3);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
});

test.skipIf(process.platform === "win32")("a keys directory another process creates before the mkdir is synced in its parent", () => {
  const dir = keysDir();
  const parent = dirname(dir);
  const synced: Array<{ dev: number; ino: number }> = [];
  setAgentKeyFileTestHooks({
    beforeKeysDirCreate: (creating) => {
      mkdirSync(creating, { recursive: true, mode: 0o700 });
    },
    syncKeysDir: (fd) => {
      const st = fstatSync(fd);
      synced.push({ dev: st.dev, ino: st.ino });
      fsyncSync(fd);
    },
  });
  try {
    ensureAgentKeysDir(dir);
  } finally {
    setAgentKeyFileTestHooks(undefined);
  }
  expect(synced).toEqual([{ dev: statSync(parent).dev, ino: statSync(parent).ino }]);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
});

test.skipIf(process.platform === "win32")("a parent sync failure after another process created the keys directory refuses before a key is written", () => {
  const dir = keysDir();
  const keyPath = join(dir, "agent-a.key");
  setAgentKeyFileTestHooks({
    beforeKeysDirCreate: (creating) => {
      mkdirSync(creating, { recursive: true, mode: 0o700 });
    },
    syncKeysDir: () => {
      throw new Error("fixture sync failure");
    },
  });
  let caught: unknown;
  try {
    ensureAgentKeysDir(dir);
    readOrCreateAgentKey(keyPath, () => Buffer.alloc(32, 5));
  } catch (error) {
    caught = error;
  } finally {
    setAgentKeyFileTestHooks(undefined);
  }
  expect(caught).toBeInstanceOf(AgentKeyFileRefusal);
  expect((caught as Error).message).toContain("not confirmed durable");
  expect(existsSync(keyPath)).toBe(false);
});

const INSERT_LOG_OPS_SOURCE = `
const { appendFileSync, writeFileSync } = require("node:fs");
let stored = "";
const logPath = process.argv[3];
const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const body = await req.json();
    if (body.operation === "sql") return Response.json([]);
    if (body.operation === "search_by_value" && body.table === "Agent") {
      return Response.json(stored ? [{ id: "agent-a", name: "agent-a", publicKey: stored }] : []);
    }
    if (body.operation === "insert") {
      appendFileSync(logPath, "insert\\n");
      stored = body.records && body.records[0] ? body.records[0].publicKey : "";
      return Response.json({ inserted_hashes: 1 });
    }
    return Response.json({});
  },
});
writeFileSync(process.argv[2], String(server.port));
`;

const MOCK_OPS_SOURCE = `
const { writeFileSync } = require("node:fs");
let stored = "";
const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const body = await req.json();
    if (body.operation === "sql") return Response.json([]);
    if (body.operation === "search_by_value" && body.table === "Agent") {
      return Response.json(stored ? [{ id: "agent-a", name: "agent-a", publicKey: stored }] : []);
    }
    if (body.operation === "insert") {
      stored = body.records && body.records[0] ? body.records[0].publicKey : "";
      return Response.json({ inserted_hashes: 1 });
    }
    return Response.json({});
  },
});
writeFileSync(process.argv[2], String(server.port));
`;

test.skipIf(process.platform === "win32")("flair agent add creates a 0600 key in a fresh keys directory", async () => {
  const home = tempDir("flair-keyfile-3077-home-");
  const keysDir = join(home, "keys");
  const passFile = join(home, "admin-pass");
  const serverScript = join(home, "mock-ops.js");
  const portFile = join(home, "mock-ops.port");
  writeFileSync(passFile, "fixture-pass", { mode: 0o600 });
  writeFileSync(serverScript, MOCK_OPS_SOURCE);
  const server = Bun.spawn(["bun", serverScript, portFile], { stdout: "ignore", stderr: "ignore" });
  try {
    const deadline = Date.now() + 10_000;
    while (!existsSync(portFile)) {
      if (Date.now() > deadline) throw new Error("mock ops server did not start");
      await Bun.sleep(25);
    }
    const port = readFileSync(portFile, "utf8").trim();
    const r = spawnSync(
      "bun",
      [join(__dirname, "..", "..", "src", "cli.ts"), "agent", "add", "agent-a", "--keys-dir", keysDir,
        "--ops-target", `http://127.0.0.1:${port}`, "--admin-pass-file", passFile],
      { env: { ...process.env, HOME: home }, timeout: 20_000, encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    const privPath = join(keysDir, "agent-a.key");
    expect(readFileSync(privPath).length).toBe(32);
    expect(statSync(privPath).mode & 0o777).toBe(0o600);
  } finally {
    server.kill();
    await server.exited.catch(() => {});
  }
}, 30_000);

test.skipIf(process.platform !== "win32")("win32 reuses an existing key without a permission refusal", () => {
  const dir = keysDir();
  ensureAgentKeysDir(dir);
  const keyPath = join(dir, "windows.key");
  const prior = Buffer.alloc(32, 4);
  writeFileSync(keyPath, prior);
  expect(Buffer.from(readExistingAgentKey(keyPath)!).equals(prior)).toBe(true);
});

test.skipIf(process.platform === "win32")("flair agent add exits 1, writes no key and sends no insert when the keys-directory sync fails", async () => {
  const home = tempDir("flair-keyfile-3077-home-");
  const keysDir = join(home, "keys");
  const passFile = join(home, "admin-pass");
  const serverScript = join(home, "mock-ops.js");
  const portFile = join(home, "mock-ops.port");
  const insertLog = join(home, "inserts.log");
  writeFileSync(passFile, "fixture-pass", { mode: 0o600 });
  writeFileSync(serverScript, INSERT_LOG_OPS_SOURCE);
  const server = Bun.spawn(["bun", serverScript, portFile, insertLog], { stdout: "ignore", stderr: "ignore" });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    stdout.push(args.map((arg) => String(arg)).join(" "));
  });
  const errSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderr.push(args.map((arg) => String(arg)).join(" "));
  });
  const origExit = process.exit;
  process.exit = ((code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`);
  }) as typeof process.exit;
  let code = 0;
  try {
    const deadline = Date.now() + 10_000;
    while (!existsSync(portFile)) {
      if (Date.now() > deadline) throw new Error("mock ops server did not start");
      await Bun.sleep(25);
    }
    const port = readFileSync(portFile, "utf8").trim();
    setAgentKeyFileTestHooks({
      syncKeysDir: (fd) => {
        const synced = fstatSync(fd);
        const keys = statSync(keysDir);
        if (synced.dev === keys.dev && synced.ino === keys.ino) throw new Error("fixture sync failure");
        fsyncSync(fd);
      },
    });
    try {
      await program.parseAsync([
        "node", "flair", "agent", "add", "agent-a",
        "--keys-dir", keysDir,
        "--ops-target", `http://127.0.0.1:${port}`,
        "--admin-pass-file", passFile,
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const match = message.match(/^process\.exit\((\d+)\)$/);
      if (!match) throw error;
      code = Number(match[1]);
    }
  } finally {
    setAgentKeyFileTestHooks(undefined);
    process.exit = origExit;
    logSpy.mockRestore();
    errSpy.mockRestore();
    server.kill();
    await server.exited.catch(() => {});
  }
  expect(code).toBe(1);
  expect(existsSync(join(keysDir, "agent-a.key"))).toBe(false);
  expect(existsSync(keysDir) ? tempEntries(keysDir) : []).toHaveLength(0);
  expect(existsSync(insertLog) ? readFileSync(insertLog, "utf8") : "").toBe("");
  expect(stderr.join("\n")).toContain("was removed");
  expect(stdout.join("\n")).not.toContain("Keypair written");
}, 30_000);

test.skipIf(process.platform === "win32")("flair agent add tightens an older install's group-writable key home and writes the key", async () => {
  const home = tempDir("flair-keyfile-3077-home-");
  const flairHome = join(home, ".flair");
  const keysDir = join(flairHome, "keys");
  const passFile = join(home, "admin-pass");
  const serverScript = join(home, "mock-ops.js");
  const portFile = join(home, "mock-ops.port");
  const insertLog = join(home, "inserts.log");
  mkdirSync(keysDir, { recursive: true, mode: 0o700 });
  chmodSync(flairHome, 0o775);
  chmodSync(keysDir, 0o775);
  writeFileSync(passFile, "fixture-pass", { mode: 0o600 });
  writeFileSync(serverScript, INSERT_LOG_OPS_SOURCE);
  const server = Bun.spawn(["bun", serverScript, portFile, insertLog], { stdout: "ignore", stderr: "ignore" });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    stdout.push(args.map((arg) => String(arg)).join(" "));
  });
  const errSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderr.push(args.map((arg) => String(arg)).join(" "));
  });
  const origExit = process.exit;
  process.exit = ((code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`);
  }) as typeof process.exit;
  const prevHome = process.env.HOME;
  const previousUmask = process.umask(0o002);
  let failure: unknown;
  let exitCode: number | undefined;
  try {
    const deadline = Date.now() + 10_000;
    while (!existsSync(portFile)) {
      if (Date.now() > deadline) throw new Error("mock ops server did not start");
      await Bun.sleep(25);
    }
    const port = readFileSync(portFile, "utf8").trim();
    process.env.HOME = home;
    try {
      await program.parseAsync([
        "node", "flair", "agent", "add", "agent-a",
        "--ops-target", `http://127.0.0.1:${port}`,
        "--admin-pass-file", passFile,
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const match = message.match(/^process\.exit\((\d+)\)$/);
      if (match) exitCode = Number(match[1]);
      else failure = error;
    }
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    process.umask(previousUmask);
    process.exit = origExit;
    logSpy.mockRestore();
    errSpy.mockRestore();
    server.kill();
    await server.exited.catch(() => {});
  }
  expect(failure).toBeUndefined();
  expect(exitCode).toBeUndefined();
  expect(existsSync(join(keysDir, "agent-a.key"))).toBe(true);
  expect(statSync(join(keysDir, "agent-a.key")).mode & 0o777).toBe(0o600);
  expect(statSync(flairHome).mode & 0o777).toBe(0o755);
  expect(stdout.filter((line) => line.includes(`Directory ${flairHome} in the flair home`))).toHaveLength(1);
  expect(stderr.join("\n")).toBe("");
}, 30_000);
