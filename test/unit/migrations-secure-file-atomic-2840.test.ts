// migrations-secure-file-atomic-2840.test.ts — flair#2840 round 4b: `writeSecureFile`
// must not expose a truncated file to a concurrent reader.
//
// Before: a plain writeFileSync truncates the target and then fills it, so a
// reader landing between those two steps sees an empty or partial file. The
// migration state file is read on boot seeding and by HealthDetail, and the
// parse error is swallowed as `{}`, so that window loses the unconfirmed record
// a restart would otherwise seed from the file. Writers are also
// read-modify-write, so a truncated read makes one writer drop every other
// migration's entry.
//
// The witness here is a READER in another realm (worker_threads) hammering the
// same path while the parent writes a large payload repeatedly: zero read or
// parse errors, and every read is byte-identical to the old or the new payload.
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureSecureDir, secureFileFsync, secureFileTempSuffix, writeSecureFile } from "../../resources/migrations/dir-safety.ts";

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

  it("leaves the file at mode 0600 narrowed by the process umask, and no temporary file behind, after a successful write", () => {
    const dir = secureDir();
    const file = join(dir, "state.json");
    writeSecureFile(file, NEW, dir);

    // Read before stat: assert on what was read, then on the mode.
    expect(readFileSync(file, "utf8")).toBe(NEW);
    expect(statSync(file).mode & 0o777).toBe(0o600 & ~process.umask());
    expect(readdirSync(dir)).toEqual(["state.json"]);
  });

  it("flushes the temporary file's data before the rename publishes it", () => {
    const dir = secureDir();
    const file = join(dir, "state.json");
    writeSecureFile(file, OLD, dir);

    const realSync = secureFileFsync.sync;
    const seen: { fsynced: number; targetAtFsync: string | null }[] = [];
    secureFileFsync.sync = (fd: number) => {
      let targetAtFsync: string | null;
      try {
        targetAtFsync = readFileSync(file, "utf8");
      } catch {
        targetAtFsync = null;
      }
      seen.push({ fsynced: fd, targetAtFsync });
      realSync(fd);
    };
    try {
      writeSecureFile(file, NEW, dir);
    } finally {
      secureFileFsync.sync = realSync;
    }

    expect(seen.length).toBe(1);
    // The rename has not happened yet: the target still holds the old contents.
    expect(seen[0].targetAtFsync).toBe(OLD);
    expect(readFileSync(file, "utf8")).toBe(NEW);
  });

  it("removes its temporary file when the rename fails (target is a directory)", () => {
    const dir = secureDir();
    const file = join(dir, "state.json");
    mkdirSync(file);

    expect(() => writeSecureFile(file, NEW, dir)).toThrow();
    expect(readdirSync(dir)).toEqual(["state.json"]);
  });

  it("throws on a file already at its temporary path and leaves that file and its contents in place", () => {
    const dir = secureDir();
    const file = join(dir, "state.json");
    writeSecureFile(file, OLD, dir);
    // The seam fixes the temporary name, so this pre-creates the exact path the
    // next call opens.
    const temp = join(dir, `.state.json.${process.pid}.collision-2840.tmp`);
    writeFileSync(temp, "another writer's file");
    const realNext = secureFileTempSuffix.next;
    secureFileTempSuffix.next = () => "collision-2840";
    try {
      expect(() => writeSecureFile(file, NEW, dir)).toThrow(/EEXIST/);
    } finally {
      secureFileTempSuffix.next = realNext;
    }
    expect(readFileSync(temp, "utf8")).toBe("another writer's file");
    expect(readFileSync(file, "utf8")).toBe(OLD);
  });
});
