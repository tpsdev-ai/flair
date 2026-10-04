import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSecureFile } from "../src/action-recall-cache.ts";

let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "flair-cache-truncate-"))); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

for (const phase of ["before-read", "after-read"]) {
  test(`cache refuses concurrent truncation ${phase} that leaves parseable JSON`, async () => {
    const path = join(root, "cache.json");
    const json = '{"v":1}';
    await fs.writeFile(path, json + " ".repeat(100), { mode: 0o600 });
    const realOpen = fs.open;
    let truncated = false;
    const openSpy = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      if (String(args[0]) === path) {
        const realRead = handle.read.bind(handle);
        handle.read = (async (...readArgs: Parameters<typeof handle.read>) => {
          if (!truncated && phase === "before-read") { await fs.truncate(path, json.length); truncated = true; }
          const result = await realRead(...readArgs);
          if (!truncated && phase === "after-read") { await fs.truncate(path, json.length); truncated = true; }
          return result;
        }) as typeof handle.read;
      }
      return handle;
    });
    try {
      const result = await readSecureFile(path, 1024);
      expect(truncated).toBe(true);
      expect(JSON.parse(await fs.readFile(path, "utf8"))).toEqual({ v: 1 });
      expect(result.ok).toBe(false);
    } finally { openSpy.mockRestore(); }
  });
}
