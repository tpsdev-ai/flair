// flair#3188 — the published client applies the agent-ID rule before it
// derives any key path from an id. An id outside the rule gets no candidates,
// so nothing is probed or read; a valid id resolves exactly as before.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keyPathCandidates, resolveKeyPath, formatKeyLookup } from "../src/auth.js";
import { FlairClient, MissingSigningKeyError } from "../src/client.js";

const INVALID_IDS = [
  "",
  "a/b",
  "a\\b",
  "..",
  "../escape",
  ".hidden",
  "with space",
  "a\0b",
  "a".repeat(65),
  "\u0430gent", // Cyrillic а, a lookalike of ASCII a
  "agent\u2011a", // non-breaking hyphen
];

let scratch: string[] = [];
const savedKeyDir = process.env.FLAIR_KEY_DIR;

beforeEach(() => {
  delete process.env.FLAIR_KEY_DIR;
  scratch = [];
});

afterEach(() => {
  if (savedKeyDir === undefined) delete process.env.FLAIR_KEY_DIR;
  else process.env.FLAIR_KEY_DIR = savedKeyDir;
  for (const p of scratch) rmSync(p, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `flair-3188-${prefix}-`));
  scratch.push(dir);
  return dir;
}

async function refusal(client: FlairClient): Promise<unknown> {
  try {
    await client.loadSigningKey();
    return null;
  } catch (error) {
    return error;
  }
}

describe("flair#3188 — an id outside the agent-ID rule has no key paths", () => {
  test("keyPathCandidates returns no candidates, with and without an explicit key path", () => {
    const home = tempDir("candidates");
    for (const id of INVALID_IDS) {
      expect(keyPathCandidates(id, undefined, [home]), JSON.stringify(id)).toEqual([]);
      expect(keyPathCandidates(id, join(home, "explicit.key"), [home]), JSON.stringify(id)).toEqual([]);
    }
  });

  test("resolveKeyPath finds nothing for an id outside the rule", () => {
    const home = tempDir("resolve");
    for (const id of INVALID_IDS) {
      expect(resolveKeyPath(id, undefined, [home]), JSON.stringify(id)).toBeNull();
    }
  });

  test("loadSigningKey refuses with a message naming the rule", async () => {
    const client = new FlairClient({ agentId: "../escape" });
    const error = await refusal(client);
    expect(error).toBeInstanceOf(MissingSigningKeyError);
    expect((error as Error).message).toContain("invalid agent id");
    expect((error as Error).message).toContain("^[a-zA-Z0-9_-]{1,64}$");
  });

  test("an id outside the rule reads no file outside the key directories", async () => {
    // FLAIR_KEY_DIR is the first candidate source, so an unchecked id would
    // reach `<keyDir>/../escape.key`. A valid seed sits there: loading it
    // would succeed, so a refusal proves the file was never read.
    const root = tempDir("planted");
    const keyDir = join(root, "keys");
    mkdirSync(keyDir, { recursive: true });
    const escapedKey = join(keyDir, "..", "escape.key");
    writeFileSync(escapedKey, Buffer.alloc(32, 7));
    process.env.FLAIR_KEY_DIR = keyDir;

    const client = new FlairClient({ agentId: "../escape" });
    const error = await refusal(client);
    expect(error).toBeInstanceOf(MissingSigningKeyError);
    expect(resolveKeyPath("../escape")).toBeNull();
  });

  test("formatKeyLookup names the rule for an invalid id", () => {
    const text = formatKeyLookup({
      agentId: "../escape",
      home: "/home/agent",
      candidates: [],
      resolvedPath: null,
      signed: false,
    });
    expect(text).toContain("invalid agent id");
    expect(text).toContain("^[a-zA-Z0-9_-]{1,64}$");
    expect(text).not.toContain("Looked for a key at");
  });
});

describe("flair#3188 — a valid id behaves as before", () => {
  test("resolveKeyPath finds the key in the standard location", () => {
    const home = tempDir("valid");
    mkdirSync(join(home, ".flair", "keys"), { recursive: true });
    const keyPath = join(home, ".flair", "keys", "agent-a.key");
    writeFileSync(keyPath, Buffer.alloc(32, 7));
    expect(resolveKeyPath("agent-a", undefined, [home])).toBe(keyPath);
  });

  test("loadSigningKey loads the key", async () => {
    const dir = tempDir("valid-load");
    const keyPath = join(dir, "agent-a.key");
    writeFileSync(keyPath, Buffer.alloc(32, 7));
    const client = new FlairClient({ agentId: "agent-a", keyPath });
    const key = await client.loadSigningKey();
    expect(key.type).toBe("private");
    expect(key.asymmetricKeyType).toBe("ed25519");
  });
});
