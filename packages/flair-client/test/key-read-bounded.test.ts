/**
 * key-read-bounded.test.ts — flair#2086 item 1.
 *
 * flair-client reads the agent's key file. It used to do so synchronously
 * (`readFileSync`), which a hook binary's process deadline cannot interrupt.
 * The read is now asynchronous and size-capped: a FIFO at the path cannot
 * stall it (the open is non-blocking and the descriptor is refused as
 * non-regular BEFORE a byte is read), and an oversized file is refused before
 * it is read. Failure messages name the path and the cap, never the file's
 * contents.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KEY_FILE_MAX_BYTES, loadPrivateKey } from "../src/auth.js";

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
  test("a valid small key file still loads", async () => {
    const p = join(scratch(), "a.key");
    // 32-byte raw seed
    writeFileSync(p, Buffer.alloc(32, 7));
    expect(await loadPrivateKey(p)).toBeTruthy();
  });

  test("an oversized key file is refused before it is read", async () => {
    const p = join(scratch(), "big.key");
    writeFileSync(p, Buffer.alloc(KEY_FILE_MAX_BYTES + 1, 0x41));
    await expect(loadPrivateKey(p)).rejects.toThrow(/larger than \d+ bytes/);
  });

  test("a FIFO at the key path is refused, not blocked on", async () => {
    const p = join(scratch(), "fifo.key");
    execFileSync("mkfifo", [p], { timeout: 5_000 });
    await expect(loadPrivateKey(p)).rejects.toThrow(/not a regular file/);
  }, 10_000);
});
