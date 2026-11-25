/**
 * agent-key-file-3077.test.ts — the shared agent-key file policy (flair#3077
 * slice A) on real files in a temp root.
 *
 * Covered (POSIX): a missing keys directory is created 0700 and observed at
 * that mode before anything else touches it; an existing 0755 directory the current user
 * owns is tightened with one notice line, while an owned 0500 keeps its mode;
 * a symlinked directory or key is refused; an existing key with group/world
 * bits is refused before its bytes are read; positive partial writes resume;
 * zero-byte and throwing writes fail and remove the temp file this call
 * created, best effort; an owner-only key that appears before
 * publication is reused, not overwritten; and owned-by-another-user, non-directory and non-regular
 * paths are refused.
 */
import { afterEach, describe, expect, mock, test, spyOn } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  fstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
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

test("a missing keys directory is created 0700 before anything else touches it", () => {
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
  spyOn(process, "getuid").mockReturnValue(uid + 1);
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

test.skipIf(process.platform !== "win32")("win32 reuses an existing key without a permission refusal", () => {
  const dir = keysDir();
  ensureAgentKeysDir(dir);
  const keyPath = join(dir, "windows.key");
  const prior = Buffer.alloc(32, 4);
  writeFileSync(keyPath, prior);
  expect(Buffer.from(readExistingAgentKey(keyPath)!).equals(prior)).toBe(true);
});
