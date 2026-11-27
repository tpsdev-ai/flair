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
 * non-regular paths are refused.
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
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
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

test.skipIf(process.platform === "win32")("a failed directory sync refuses with the published key path and leaves the key", () => {
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
  expect((caught as Error).message).toContain("not confirmed durable");
  expect(existsSync(keyPath)).toBe(true);
  expect(statSync(keyPath).mode & 0o777).toBe(0o600);
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
    // The first create publishes the key, then refuses on its directory sync.
    expect(attempt).toThrow(/not confirmed durable/);
    expect(existsSync(keyPath)).toBe(true);
    // A retry reads that published key and repeats the sync before returning it.
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
