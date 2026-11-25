/**
 * agent-key-file-temp-3077.test.ts — flair#3077 slice A.
 *
 * Two promises of the key-file helper, observed at the module boundary rather
 * than through a hook:
 *   - a temp name that already exists is retried with a new random suffix, and
 *     the occupying entry is never unlinked or changed; after the retry bound
 *     the call throws and still leaves the occupying entry alone.
 *   - a key with group or world bits is refused with no read call on the opened
 *     descriptor before the refusal.
 *
 * Isolated: this file owns its `node:crypto` and `node:fs` mocks (only
 * `randomBytes` and a counting `readFileSync` are replaced; every other export
 * is the real one), because both seams are inside
 * src/lib/agent-key-file.ts.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { basename, join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";

const realCrypto = require("node:crypto") as typeof import("node:crypto");
const realFs = require("node:fs") as typeof import("node:fs");

let nextFill = 1;
let constantFill: number | null = null;
let randomCalls = 0;

mock.module("node:crypto", () => ({
  ...realCrypto,
  randomBytes: (size: number) => {
    randomCalls += 1;
    const fill = constantFill ?? nextFill++;
    return Buffer.alloc(size, fill);
  },
}));

let readFileSyncCalls = 0;

mock.module("node:fs", () => ({
  ...realFs,
  readFileSync: ((...args: Parameters<typeof realFs.readFileSync>) => {
    readFileSyncCalls += 1;
    return realFs.readFileSync(...args);
  }) as typeof realFs.readFileSync,
}));

const { createAgentKeyFile, ensureAgentKeysDir, readExistingAgentKey } = await import(
  "../../src/lib/agent-key-file.ts"
);

beforeEach(() => {
  nextFill = 1;
  constantFill = null;
  randomCalls = 0;
  readFileSyncCalls = 0;
});

function keysDir(): string {
  return join(tempDir("flair-keyfile-temp-3077-"), "keys");
}

function tempName(dir: string, name: string, fill: number): string {
  return join(dir, `.${name}.tmp-${Buffer.alloc(8, fill).toString("hex")}`);
}

function tempEntries(dir: string): string[] {
  return realFs.readdirSync(dir).filter((name) => name.includes(".tmp-"));
}

describe("flair#3077 — a temp name this call did not create is never unlinked", () => {
  test("a taken temp name is retried, the occupying entry survives byte-identical and the key is created", () => {
    const dir = keysDir();
    ensureAgentKeysDir(dir);
    const keyPath = join(dir, "agent.key");
    const occupantPath = tempName(dir, "agent.key", 1);
    const occupant = Buffer.from("another call's temp file");
    realFs.writeFileSync(occupantPath, occupant, { mode: 0o600 });
    const seed = Buffer.alloc(32, 5);

    createAgentKeyFile(keyPath, seed);

    expect(realFs.readFileSync(occupantPath).equals(occupant)).toBe(true);
    expect(realFs.readFileSync(keyPath).equals(seed)).toBe(true);
    expect(tempEntries(dir)).toEqual([basename(occupantPath)]);
  });

  test("a temp name taken on every attempt throws after the bound and leaves the occupying entry alone", () => {
    const dir = keysDir();
    ensureAgentKeysDir(dir);
    const keyPath = join(dir, "agent.key");
    const occupantPath = tempName(dir, "agent.key", 9);
    const occupant = Buffer.from("another call's temp file");
    realFs.writeFileSync(occupantPath, occupant, { mode: 0o600 });
    constantFill = 9;

    let code: string | undefined;
    try {
      createAgentKeyFile(keyPath, Buffer.alloc(32, 5));
    } catch (error) {
      code = (error as NodeJS.ErrnoException).code;
    }

    expect(code).toBe("EEXIST");
    expect(randomCalls).toBe(5);
    expect(realFs.readFileSync(occupantPath).equals(occupant)).toBe(true);
    expect(realFs.existsSync(keyPath)).toBe(false);
    expect(tempEntries(dir)).toEqual([basename(occupantPath)]);
  });
});

describe("flair#3077 — the wide-mode refusal happens before a read", () => {
  test("a key with group or world bits is refused with no readFileSync call", () => {
    const dir = keysDir();
    ensureAgentKeysDir(dir);
    const keyPath = join(dir, "wide.key");
    realFs.writeFileSync(keyPath, Buffer.alloc(32, 7), { mode: 0o600 });
    realFs.chmodSync(keyPath, 0o644);
    readFileSyncCalls = 0;

    expect(() => readExistingAgentKey(keyPath)).toThrow(/chmod 600 /);

    expect(readFileSyncCalls).toBe(0);
  });
});
