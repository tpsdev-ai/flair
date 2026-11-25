/**
 * agent-key-file-3077.test.ts — the shared agent-key file policy (flair#3077
 * slice A) on real files in a temp root.
 *
 * Covered: a missing keys directory is created 0700; an existing 0755
 * directory the current user owns is tightened with one notice line; a
 * symlinked directory or key is refused; an existing 0644 key is refused
 * before its bytes are read; and a failed write removes only the file this
 * call created.
 */
import { describe, expect, test, spyOn } from "bun:test";
import { chmodSync, existsSync, fstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import {
  AgentKeyFileRefusal,
  createAgentKeyFile,
  ensureAgentKeysDir,
  readExistingAgentKey,
  setAgentKeyFileTestHooks,
} from "../../src/lib/agent-key-file.ts";

function keysDir(): string {
  return join(tempDir("flair-keyfile-3077-"), "keys");
}

test("a missing keys directory is created 0700, even under a zero umask", () => {
  const dir = keysDir();
  const previous = process.umask(0);
  try {
    ensureAgentKeysDir(dir);
  } finally {
    process.umask(previous);
  }
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

test("a symlinked keys directory is refused", () => {
  const real = tempDir("flair-keyfile-3077-");
  mkdirSync(real, { recursive: true });
  const link = join(tempDir("flair-keyfile-3077-"), "keys");
  symlinkSync(real, link);
  expect(() => ensureAgentKeysDir(link)).toThrow(AgentKeyFileRefusal);
  expect(() => ensureAgentKeysDir(link)).toThrow(/symlink/);
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

test("an existing 0644 key is refused before it is read and is left untouched", () => {
  const dir = keysDir();
  ensureAgentKeysDir(dir);
  const keyPath = join(dir, "wide.key");
  const prior = Buffer.alloc(32, 7);
  writeFileSync(keyPath, prior, { mode: 0o600 });
  chmodSync(keyPath, 0o644);
  expect(() => readExistingAgentKey(keyPath)).toThrow(/chmod 600 /);
  expect(readFileSync(keyPath).equals(prior)).toBe(true);
  expect(statSync(keyPath).mode & 0o777).toBe(0o644);
});

test("a failed write removes only the file this call created", () => {
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
  expect(readFileSync(sibling, "utf8")).toBe("keep");
});

test("a fresh key is 0600 at its first write under a zero umask", () => {
  const dir = keysDir();
  ensureAgentKeysDir(dir);
  const keyPath = join(dir, "fresh.key");
  const observed: number[] = [];
  setAgentKeyFileTestHooks({
    beforeFirstWrite: (fd) => {
      observed.push(fstatSync(fd).mode & 0o777);
    },
  });
  const previous = process.umask(0);
  try {
    createAgentKeyFile(keyPath, Buffer.alloc(32, 1));
  } finally {
    process.umask(previous);
    setAgentKeyFileTestHooks(undefined);
  }
  expect(observed).toEqual([0o600]);
  expect(statSync(keyPath).mode & 0o777).toBe(0o600);
});

test.skipIf(process.platform !== "win32")("win32 reuses an existing key without a permission refusal", () => {
  const dir = keysDir();
  ensureAgentKeysDir(dir);
  const keyPath = join(dir, "windows.key");
  const prior = Buffer.alloc(32, 4);
  writeFileSync(keyPath, prior);
  expect(Buffer.from(readExistingAgentKey(keyPath)!).equals(prior)).toBe(true);
});
