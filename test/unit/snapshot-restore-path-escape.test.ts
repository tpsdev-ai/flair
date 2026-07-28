// snapshot-restore-path-escape.test.ts — regression tests for the physical
// snapshot restore path escape.
//
// `flair snapshot restore` extracts with `preservePaths: true`, which is
// load-bearing for symlink TARGET fidelity (see
// src/lib/safe-snapshot-extract.ts) but also disables node-tar's two
// containment behaviours: stripping a leading "/" from entry paths, and
// rejecting ".." segments. Restore accepts archives this CLI did not create,
// so the archive is untrusted input and containment has to be enforced here.
//
// These tests build REAL tarballs with hand-rolled ustar headers — node-tar's
// own create() normalises exactly the paths under test away, so it cannot
// produce the malicious archives a restore actually has to survive.
//
// The `outsideDir` assertions are the point of the file: it is not enough
// that extraction throws, nothing may be written outside the target.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync,
  existsSync, readlinkSync, symlinkSync, realpathSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import {
  extractSnapshotSafely,
  validateSnapshotArchive,
  SnapshotPathEscapeError,
} from "../../src/lib/safe-snapshot-extract";
import { createDataSnapshot } from "../../src/cli";

// ─── minimal ustar writer ────────────────────────────────────────────────────
// Deliberately hand-rolled: it must be able to emit entry paths that a
// well-behaved tar writer refuses to produce.
const BLOCK = 512;

function octalField(n: number, len: number): string {
  return n.toString(8).padStart(len - 1, "0") + "\0";
}

/** ustar splits long paths across prefix(155) + "/" + name(100). */
function splitUstar(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  for (let i = path.length - 100; i < path.length; i++) {
    if (path[i] === "/") {
      const prefix = path.slice(0, i);
      const name = path.slice(i + 1);
      if (Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155) return { name, prefix };
    }
  }
  // Throw rather than truncate — a silently truncated entry would make a
  // vulnerable build look safe, which is the exact failure this file guards.
  throw new Error(`path too long for ustar (${Buffer.byteLength(path)} bytes): ${path}`);
}

interface TarEntry {
  name: string;
  body?: string;
  /** "0" regular, "2" symlink, "1" hard link, "5" directory */
  type?: string;
  linkname?: string;
  mode?: number;
}

function tarHeader(e: TarEntry, size: number): Buffer {
  const buf = Buffer.alloc(BLOCK, 0);
  const { name, prefix } = splitUstar(e.name);
  // A linkname longer than the 100-byte ustar field is emitted as a preceding
  // GNU LongLink block (see writeTarGz); truncating here is the convention,
  // the LongLink body is what the reader actually uses.
  const linkname = (e.linkname ?? "").slice(0, 100);
  buf.write(name, 0, 100, "utf8");
  buf.write(octalField(e.mode ?? 0o644, 8), 100, 8);
  buf.write(octalField(0, 8), 108, 8);
  buf.write(octalField(0, 8), 116, 8);
  buf.write(octalField(size, 12), 124, 12);
  buf.write(octalField(Math.floor(Date.now() / 1000), 12), 136, 12);
  buf.write("        ", 148, 8); // checksum placeholder
  buf.write(e.type ?? "0", 156, 1);
  buf.write(linkname, 157, 100, "utf8");
  buf.write("ustar\0", 257, 6);
  buf.write("00", 263, 2);
  if (prefix) buf.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const b of buf) sum += b;
  buf.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return buf;
}

/** Body blocks for a payload, zero-padded to the 512-byte block size. */
function bodyBlocks(payload: Buffer): Buffer[] {
  if (payload.length === 0) return [];
  const rem = payload.length % BLOCK;
  return rem === 0 ? [payload] : [payload, Buffer.alloc(BLOCK - rem, 0)];
}

function writeTarGz(path: string, entries: TarEntry[]): string {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const body = Buffer.from(e.body ?? "");
    // GNU LongLink: carries a link target that does not fit the 100-byte
    // ustar field. Keeps these tests independent of how long the OS temp
    // directory path happens to be.
    if (e.linkname && Buffer.byteLength(e.linkname) > 100) {
      const payload = Buffer.from(e.linkname + "\0");
      parts.push(tarHeader({ name: "././@LongLink", type: "K" }, payload.length));
      parts.push(...bodyBlocks(payload));
    }
    parts.push(tarHeader(e, body.length));
    if (body.length) {
      parts.push(body);
      const rem = body.length % BLOCK;
      if (rem !== 0) parts.push(Buffer.alloc(BLOCK - rem, 0));
    }
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0)); // end of archive
  writeFileSync(path, gzipSync(Buffer.concat(parts)));
  return path;
}

// ─── fixture ────────────────────────────────────────────────────────────────
// Layout: <root>/nest/data   = restore target
//         <root>/outside     = must stay empty, always
let root: string;
let targetDir: string;
let outsideDir: string;

const MARKER = "written-outside-the-target-dir\n";

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "flair-test-escape-")));
  targetDir = join(root, "nest", "data");
  outsideDir = join(root, "outside");
  mkdirSync(targetDir, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function expectNothingEscaped() {
  expect(readdirSync(outsideDir)).toEqual([]);
}

describe("snapshot restore — path containment (untrusted archives)", () => {
  test("rejects an absolute-path entry and writes nothing outside the target", async () => {
    const tarball = join(root, "evil.tar.gz");
    writeTarGz(tarball, [
      { name: "harper-config.yaml", body: "# benign\n" },
      { name: join(outsideDir, "pwned-absolute.txt"), body: MARKER },
    ]);

    await expect(
      extractSnapshotSafely({ file: tarball, targetDir }),
    ).rejects.toThrow(SnapshotPathEscapeError);

    expectNothingEscaped();
    expect(existsSync(join(outsideDir, "pwned-absolute.txt"))).toBe(false);
  });

  test('rejects a ".." traversal entry and writes nothing outside the target', async () => {
    const tarball = join(root, "evil.tar.gz");
    writeTarGz(tarball, [
      { name: "harper-config.yaml", body: "# benign\n" },
      { name: "../../outside/pwned-dotdot.txt", body: MARKER },
    ]);

    await expect(
      extractSnapshotSafely({ file: tarball, targetDir }),
    ).rejects.toThrow(SnapshotPathEscapeError);

    expectNothingEscaped();
    expect(existsSync(join(outsideDir, "pwned-dotdot.txt"))).toBe(false);
  });

  test("rejects a symlink whose target escapes, so nothing can be written through it", async () => {
    const tarball = join(root, "evil.tar.gz");
    writeTarGz(tarball, [
      { name: "harper-config.yaml", body: "# benign\n" },
      { name: "escape", type: "2", linkname: "../../outside" },
      { name: "escape/pwned-symlink.txt", body: MARKER },
    ]);

    await expect(
      extractSnapshotSafely({ file: tarball, targetDir }),
    ).rejects.toThrow(SnapshotPathEscapeError);

    expectNothingEscaped();
    expect(existsSync(join(outsideDir, "pwned-symlink.txt"))).toBe(false);
  });

  test("rejects a hard link pointing outside the target", async () => {
    const secret = join(outsideDir, "secret.txt");
    writeFileSync(secret, "sensitive\n");
    const tarball = join(root, "evil.tar.gz");
    writeTarGz(tarball, [
      { name: "harper-config.yaml", body: "# benign\n" },
      { name: "leak.txt", type: "1", linkname: "../../outside/secret.txt" },
    ]);

    await expect(
      extractSnapshotSafely({ file: tarball, targetDir }),
    ).rejects.toThrow(SnapshotPathEscapeError);

    expect(existsSync(join(targetDir, "leak.txt"))).toBe(false);
  });

  // Second layer: an entry that is lexically clean ("escape/x.txt" — not
  // absolute, no "..") but resolves outside because `escape` is a symlink
  // already on disk. The listing-time check cannot see this; the
  // filesystem-aware guard during extraction must.
  test("refuses to write through a pre-existing escaping symlink in the target", async () => {
    symlinkSync(outsideDir, join(targetDir, "escape"));
    const tarball = join(root, "evil.tar.gz");
    writeTarGz(tarball, [
      { name: "escape/pwned-through-symlink.txt", body: MARKER },
    ]);

    await expect(
      extractSnapshotSafely({ file: tarball, targetDir }),
    ).rejects.toThrow(SnapshotPathEscapeError);

    expectNothingEscaped();
  });

  test("the refusal names the offending entry and says nothing was extracted", async () => {
    const tarball = join(root, "evil.tar.gz");
    writeTarGz(tarball, [{ name: "../../outside/pwned.txt", body: MARKER }]);

    let err: any;
    try {
      await validateSnapshotArchive({ file: tarball, targetDir });
    } catch (e) { err = e; }

    expect(err).toBeInstanceOf(SnapshotPathEscapeError);
    // An operator has to be able to act on this at 3am: what was rejected,
    // why, and what state their data directory is in.
    expect(err.message).toContain("../../outside/pwned.txt");
    expect(err.message).toContain(targetDir);
    expect(err.message).toContain("Nothing was extracted");
  });

  test("validateSnapshotArchive writes nothing at all when it refuses", async () => {
    const tarball = join(root, "evil.tar.gz");
    writeTarGz(tarball, [
      { name: "harper-config.yaml", body: "# benign\n" },
      { name: "../../outside/pwned.txt", body: MARKER },
    ]);

    await expect(validateSnapshotArchive({ file: tarball, targetDir })).rejects.toThrow();

    // Not even the benign entry — refusal is whole-archive, and it happens
    // before the restore path's destructive rm of the data directory.
    expect(readdirSync(targetDir)).toEqual([]);
    expectNothingEscaped();
  });
});

describe("snapshot restore — legitimate archives still restore correctly", () => {
  test("extracts a normal snapshot, preserving nested files and modes", async () => {
    const tarball = join(root, "good.tar.gz");
    writeTarGz(tarball, [
      { name: "harper-config.yaml", body: "port: 9926\n" },
      { name: "models", type: "5", mode: 0o755 },
      { name: "models/weights.bin", body: "weights\n" },
    ]);

    await extractSnapshotSafely({ file: tarball, targetDir });

    expect(existsSync(join(targetDir, "harper-config.yaml"))).toBe(true);
    expect(existsSync(join(targetDir, "models", "weights.bin"))).toBe(true);
    expectNothingEscaped();
  });

  // This is the create-side reason preservePaths exists, and the reason the
  // fix could not simply flip it to false: WITHOUT preservePaths node-tar
  // strips the leading "/" off an absolute symlink target, so an in-bounds
  // link restores as a broken RELATIVE path.
  test("restores an in-bounds ABSOLUTE symlink target verbatim (leading / intact)", async () => {
    const absTarget = join(targetDir, "models", "real.bin");
    const tarball = join(root, "good.tar.gz");
    writeTarGz(tarball, [
      { name: "models", type: "5", mode: 0o755 },
      { name: "models/real.bin", body: "weights\n" },
      { name: "models/current.bin", type: "2", linkname: absTarget },
    ]);

    await extractSnapshotSafely({ file: tarball, targetDir });

    const link = readlinkSync(join(targetDir, "models", "current.bin"));
    expect(link).toBe(absTarget);
    expect(link.startsWith("/")).toBe(true);
  });

  // A real snapshot's FIRST entry is "./" — createDataSnapshot archives the
  // file list ["."]. Its destination IS the target directory, so a guard that
  // checks the entry's PARENT resolves above the target and rejects every
  // legitimate snapshot. Synthetic fixtures that skip the root entry hide
  // this; CI's restore drill did not.
  test('accepts the "./" root entry that real snapshots begin with', async () => {
    const tarball = join(root, "good.tar.gz");
    writeTarGz(tarball, [
      { name: "./", type: "5", mode: 0o700 },
      { name: "./harper-config.yaml", body: "port: 9926\n" },
      { name: "./models/", type: "5", mode: 0o755 },
      { name: "./models/weights.bin", body: "weights\n" },
    ]);

    await extractSnapshotSafely({ file: tarball, targetDir });

    expect(existsSync(join(targetDir, "harper-config.yaml"))).toBe(true);
    expect(existsSync(join(targetDir, "models", "weights.bin"))).toBe(true);
    expectNothingEscaped();
  });

  // End-to-end against the REAL producer: whatever shape createDataSnapshot
  // actually emits must survive its own restore. This is the pairing a
  // hand-built fixture cannot guarantee stays honest as the writer evolves.
  test("round-trips a snapshot produced by the real createDataSnapshot", async () => {
    const dataDir = join(root, "nest", "data");
    const snapshotRoot = join(root, "snapshots");
    mkdirSync(join(dataDir, "models"), { recursive: true });
    writeFileSync(join(dataDir, "harper-config.yaml"), "port: 9926\n");
    writeFileSync(join(dataDir, "models", "real.bin"), "weights\n");
    // In-bounds symlink stored with an ABSOLUTE target — the case
    // preservePaths exists for.
    symlinkSync(join(dataDir, "models", "real.bin"), join(dataDir, "models", "current.bin"));

    const { path: snapshotPath } = await createDataSnapshot(dataDir, snapshotRoot);

    rmSync(dataDir, { recursive: true, force: true });
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });

    await extractSnapshotSafely({ file: snapshotPath, targetDir: dataDir });

    expect(existsSync(join(dataDir, "harper-config.yaml"))).toBe(true);
    expect(existsSync(join(dataDir, "models", "real.bin"))).toBe(true);
    // Absolute symlink target restored verbatim, leading "/" intact.
    expect(readlinkSync(join(dataDir, "models", "current.bin")))
      .toBe(join(dataDir, "models", "real.bin"));
    expectNothingEscaped();
  });

  test("allows an in-bounds RELATIVE symlink", async () => {
    const tarball = join(root, "good.tar.gz");
    writeTarGz(tarball, [
      { name: "models", type: "5", mode: 0o755 },
      { name: "models/real.bin", body: "weights\n" },
      { name: "models/current.bin", type: "2", linkname: "real.bin" },
    ]);

    await extractSnapshotSafely({ file: tarball, targetDir });

    expect(readlinkSync(join(targetDir, "models", "current.bin"))).toBe("real.bin");
  });
});
