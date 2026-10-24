// migrations-secure-file-atomic-2840.test.ts — flair#2840 round 4b: `writeSecureFile`
// must not expose a truncated file to a concurrent reader.
//
// Before: a plain writeFileSync truncates the target and then fills it, so a
// reader landing between those two steps sees an empty or partial file. The
// migration state file is read on boot seeding and by HealthDetail, and the
// parse error is swallowed as `{}`, so that window loses the unconfirmed record
// this PR keeps across a restart. Writers are also read-modify-write, so a
// truncated read makes one writer drop every other migration's entry.
//
// The witness here is a READER in another realm (worker_threads) hammering the
// same path while the parent writes a large payload repeatedly: zero read or
// parse errors, and every read is byte-identical to the old or the new payload.
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureSecureDir, writeSecureFile } from "../../resources/migrations/dir-safety.ts";

const WORKER = join(import.meta.dirname, "..", "helpers", "migrations-secure-file-reader-2840.ts");

function payload(marker: string): string {
  const rows = Array.from({ length: 12000 }, (_, i) => ({ id: `${marker}-${i}`, note: "n".repeat(24) }));
  return JSON.stringify({ marker, rows }, null, 2) + "\n";
}
const OLD = payload("old");
const NEW = payload("new");

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function secureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "flair-atomic-2840-"));
  dirs.push(dir);
  ensureSecureDir(dir);
  return dir;
}

describe("writeSecureFile — atomic replacement (flair#2840)", () => {
  it(
    "a concurrent reader never sees a partial file: every read is the old or the new payload",
    async () => {
      const dir = secureDir();
      const file = join(dir, "state.json");
      const stopFile = join(dir, "stop");
      writeSecureFile(file, OLD, dir);

      const worker = new Worker(new URL(WORKER, import.meta.url), {
        workerData: { file, stopFile, expected: [OLD, NEW], deadlineMs: 30_000 },
      });
      const done = new Promise<any>((resolve, reject) => {
        worker.on("message", (m) => {
          if (m?.kind === "done") resolve(m);
        });
        worker.once("error", reject);
      });

      // The reader is started; give it a moment to enter its loop, then write.
      await new Promise((r) => setTimeout(r, 25));
      let current = OLD;
      for (let i = 0; i < 500; i++) {
        current = current === OLD ? NEW : OLD;
        writeSecureFile(file, current, dir);
      }
      writeFileSync(stopFile, "");
      const result = await done;
      await worker.terminate();

      expect(result.reads).toBeGreaterThan(0);
      expect(result.readErrors).toBe(0);
      expect(result.parseErrors).toBe(0);
      expect(result.unexpected).toBe(0);
      // And the last write is what the file holds.
      expect(readFileSync(file, "utf8")).toBe(current);
    },
    40_000,
  );

  it("leaves the file at 0600 and no temporary file behind after a successful write", () => {
    const dir = secureDir();
    const file = join(dir, "state.json");
    writeSecureFile(file, NEW, dir);

    // Read before stat: assert on what was read, then on the mode.
    expect(readFileSync(file, "utf8")).toBe(NEW);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["state.json"]);
  });

  it("removes its temporary file when the rename fails (target is a directory)", () => {
    const dir = secureDir();
    const file = join(dir, "state.json");
    mkdirSync(file);

    expect(() => writeSecureFile(file, NEW, dir)).toThrow();
    expect(readdirSync(dir)).toEqual(["state.json"]);
  });

  it("opens its temporary file exclusively at 0600, so a pre-existing path is never reused", () => {
    // The temporary name carries 8 random bytes, so a test cannot predict the
    // path to pre-create (2^64 candidates). Assert the open flag that makes a
    // collision fail instead of reopening the existing file.
    const source = readFileSync(join(import.meta.dirname, "..", "..", "resources", "migrations", "dir-safety.ts"), "utf8");
    expect(source).toContain('writeFileSync(temp, contents, { mode: 0o600, flag: "wx" })');
  });
});
