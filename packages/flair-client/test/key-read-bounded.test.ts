/**
 * key-read-bounded.test.ts — flair#2086 item 1.
 *
 * FlairClient reads the agent's key file asynchronously and with a size cap;
 * the published loadPrivateKey export remains synchronous. A FIFO cannot
 * stall loadPrivateKeyBounded (the open is non-blocking and the descriptor is refused as
 * non-regular BEFORE a byte is read). A file already oversized at fstat is
 * refused before reading; growth during reading is detected by one extra
 * byte. Oversized-file errors name the path and cap, never the file's
 * contents.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { KeyObject } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KEY_FILE_MAX_BYTES } from "../src/auth.js";
import { loadPrivateKey, loadPrivateKeyBounded } from "../src/index.js";

const dirs: string[] = [];

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "flair-key-read-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("flair#2086: the key-file read is asynchronous and bounded", () => {
  test("the published sync export returns a KeyObject immediately", () => {
    const p = join(scratch(), "sync.key");
    writeFileSync(p, Buffer.alloc(32, 7));
    expect(loadPrivateKey(p)).toBeInstanceOf(KeyObject);
  });

  test("a valid small key file still loads", async () => {
    const p = join(scratch(), "a.key");
    // 32-byte raw seed
    writeFileSync(p, Buffer.alloc(32, 7));
    expect(await loadPrivateKeyBounded(p)).toBeInstanceOf(KeyObject);
  });

  test("an oversized key file is refused before it is read", async () => {
    const p = join(scratch(), "big.key");
    writeFileSync(p, Buffer.alloc(KEY_FILE_MAX_BYTES + 1, 0x41));
    await expect(loadPrivateKeyBounded(p)).rejects.toThrow(/larger than \d+ bytes/);
  });

  test("a FIFO at the key path is refused, not blocked on", async () => {
    const p = join(scratch(), "fifo.key");
    execFileSync("mkfifo", [p], { timeout: 5_000 });
    await expect(loadPrivateKeyBounded(p)).rejects.toThrow(/not a regular file/);
  }, 10_000);
});
