// upgrade-data-snapshot.test.ts — Unit tests for flair#637's pre-upgrade
// data snapshot: createDataSnapshot() and pruneOldSnapshots(). Pure
// filesystem behavior against throwaway temp dirs — never touches this
// machine's real ~/.flair (both functions take an explicit `snapshotRoot`
// param for exactly this reason; see their doc comments in src/cli.ts).
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync,
  chmodSync, statSync, existsSync, readdirSync, utimesSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extract as tarExtract } from "tar";
import { program, createDataSnapshot, pruneOldSnapshots } from "../../src/cli";

function findCommand(root: any, path: string[]): any {
  let node = root;
  for (const name of path) {
    node = node.commands.find((c: any) => c.name() === name);
    if (!node) return null;
  }
  return node;
}

describe("flair upgrade — --no-snapshot flag wiring (flair#637)", () => {
  test("upgrade command registers --no-snapshot", () => {
    const upgrade = findCommand(program, ["upgrade"]);
    expect(upgrade).not.toBeNull();
    const optionNames = upgrade.options.map((o: any) => o.long);
    expect(optionNames).toContain("--no-snapshot");
  });
});

describe("createDataSnapshot", () => {
  let dataDir: string;
  let snapshotRoot: string;
  let extractDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "flair637-data-"));
    snapshotRoot = mkdtempSync(join(tmpdir(), "flair637-snaproot-"));
    extractDir = mkdtempSync(join(tmpdir(), "flair637-extract-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(snapshotRoot, { recursive: true, force: true });
    rmSync(extractDir, { recursive: true, force: true });
  });

  test("archives a regular file and preserves its exact mode (0600 stays 0600)", async () => {
    const secretPath = join(dataDir, "admin-pass");
    writeFileSync(secretPath, "super-secret", { mode: 0o600 });

    const { path: snapshotPath, bytes } = await createDataSnapshot(dataDir, snapshotRoot);
    expect(existsSync(snapshotPath)).toBe(true);
    expect(bytes).toBeGreaterThan(0);
    // The archive file itself is owner-only.
    expect(statSync(snapshotPath).mode & 0o777).toBe(0o600);

    // preservePaths: true mirrors what a real restore's `tar -xzf` does —
    // node-tar's own extract() would otherwise re-strip the leading `/`
    // from an absolute symlink target on the way back out, even though the
    // archive (created with preservePaths: true) already stored it intact.
    await tarExtract({ file: snapshotPath, cwd: extractDir, preservePaths: true });
    const restoredMode = statSync(join(extractDir, "admin-pass")).mode & 0o777;
    expect(restoredMode).toBe(0o600);
  });

  test("preserves a nested directory structure", async () => {
    mkdirSync(join(dataDir, "keys"), { recursive: true });
    writeFileSync(join(dataDir, "keys", "agent.key"), "key-material", { mode: 0o600 });
    writeFileSync(join(dataDir, "harper-config.yaml"), "some: config\n");

    const { path: snapshotPath } = await createDataSnapshot(dataDir, snapshotRoot);
    // preservePaths: true mirrors what a real restore's `tar -xzf` does —
    // node-tar's own extract() would otherwise re-strip the leading `/`
    // from an absolute symlink target on the way back out, even though the
    // archive (created with preservePaths: true) already stored it intact.
    await tarExtract({ file: snapshotPath, cwd: extractDir, preservePaths: true });

    expect(existsSync(join(extractDir, "harper-config.yaml"))).toBe(true);
    expect(existsSync(join(extractDir, "keys", "agent.key"))).toBe(true);
    expect(statSync(join(extractDir, "keys", "agent.key")).mode & 0o777).toBe(0o600);
  });

  test("keeps a symlink that points WITHIN the data dir", async () => {
    writeFileSync(join(dataDir, "real-file.txt"), "hello");
    symlinkSync(join(dataDir, "real-file.txt"), join(dataDir, "link-inside.txt"));

    const { path: snapshotPath } = await createDataSnapshot(dataDir, snapshotRoot);
    // preservePaths: true mirrors what a real restore's `tar -xzf` does —
    // node-tar's own extract() would otherwise re-strip the leading `/`
    // from an absolute symlink target on the way back out, even though the
    // archive (created with preservePaths: true) already stored it intact.
    await tarExtract({ file: snapshotPath, cwd: extractDir, preservePaths: true });

    expect(existsSync(join(extractDir, "link-inside.txt"))).toBe(true);
    expect(statSync(join(extractDir, "link-inside.txt")).isFile()).toBe(true);
  });

  test("skips a symlink that points OUTSIDE the data dir — never follows it, never archives its target", async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "flair637-outside-"));
    try {
      const outsideSecret = join(outsideDir, "outside-secret.txt");
      writeFileSync(outsideSecret, "should never appear in the snapshot");
      symlinkSync(outsideSecret, join(dataDir, "escape-link.txt"));
      writeFileSync(join(dataDir, "normal-file.txt"), "normal");

      const { path: snapshotPath } = await createDataSnapshot(dataDir, snapshotRoot);
      // preservePaths: true mirrors what a real restore's `tar -xzf` does —
    // node-tar's own extract() would otherwise re-strip the leading `/`
    // from an absolute symlink target on the way back out, even though the
    // archive (created with preservePaths: true) already stored it intact.
    await tarExtract({ file: snapshotPath, cwd: extractDir, preservePaths: true });

      expect(existsSync(join(extractDir, "normal-file.txt"))).toBe(true);
      expect(existsSync(join(extractDir, "escape-link.txt"))).toBe(false);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test("skips a broken symlink without throwing", async () => {
    symlinkSync(join(dataDir, "does-not-exist"), join(dataDir, "broken-link"));
    writeFileSync(join(dataDir, "normal-file.txt"), "normal");

    const { path: snapshotPath } = await createDataSnapshot(dataDir, snapshotRoot);
    // preservePaths: true mirrors what a real restore's `tar -xzf` does —
    // node-tar's own extract() would otherwise re-strip the leading `/`
    // from an absolute symlink target on the way back out, even though the
    // archive (created with preservePaths: true) already stored it intact.
    await tarExtract({ file: snapshotPath, cwd: extractDir, preservePaths: true });

    expect(existsSync(join(extractDir, "normal-file.txt"))).toBe(true);
    expect(existsSync(join(extractDir, "broken-link"))).toBe(false);
  });

  test("skips a unix domain socket without crashing the snapshot", async () => {
    const socketPath = join(dataDir, "operations-server");
    const server: Server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => resolve());
    });
    try {
      writeFileSync(join(dataDir, "normal-file.txt"), "normal");

      const { path: snapshotPath } = await createDataSnapshot(dataDir, snapshotRoot);
      // preservePaths: true mirrors what a real restore's `tar -xzf` does —
    // node-tar's own extract() would otherwise re-strip the leading `/`
    // from an absolute symlink target on the way back out, even though the
    // archive (created with preservePaths: true) already stored it intact.
    await tarExtract({ file: snapshotPath, cwd: extractDir, preservePaths: true });

      expect(existsSync(join(extractDir, "normal-file.txt"))).toBe(true);
      expect(existsSync(join(extractDir, "operations-server"))).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("pruneOldSnapshots", () => {
  let snapshotRoot: string;

  beforeEach(() => {
    snapshotRoot = mkdtempSync(join(tmpdir(), "flair637-prune-"));
  });

  afterEach(() => {
    rmSync(snapshotRoot, { recursive: true, force: true });
  });

  function makeSnapshotFile(name: string, mtimeOffsetSeconds: number) {
    const p = join(snapshotRoot, name);
    writeFileSync(p, "fake tarball");
    const t = new Date(Date.now() + mtimeOffsetSeconds * 1000);
    utimesSync(p, t, t);
  }

  test("keeps only the newest N (default 3), removes the rest", () => {
    // Oldest to newest by mtime offset.
    makeSnapshotFile("flair-data-a.tar.gz", -500);
    makeSnapshotFile("flair-data-b.tar.gz", -400);
    makeSnapshotFile("flair-data-c.tar.gz", -300);
    makeSnapshotFile("flair-data-d.tar.gz", -200);
    makeSnapshotFile("flair-data-e.tar.gz", -100);

    const removed = pruneOldSnapshots(3, snapshotRoot);
    expect(removed.length).toBe(2);
    const remaining = readdirSync(snapshotRoot).sort();
    expect(remaining).toEqual(["flair-data-c.tar.gz", "flair-data-d.tar.gz", "flair-data-e.tar.gz"]);
  });

  test("no-op when fewer snapshots than the retention count exist", () => {
    makeSnapshotFile("flair-data-a.tar.gz", -100);
    makeSnapshotFile("flair-data-b.tar.gz", -50);

    const removed = pruneOldSnapshots(3, snapshotRoot);
    expect(removed.length).toBe(0);
    expect(readdirSync(snapshotRoot).length).toBe(2);
  });

  test("ignores files that don't match the flair-data-*.tar.gz naming convention", () => {
    makeSnapshotFile("flair-data-a.tar.gz", -300);
    makeSnapshotFile("flair-data-b.tar.gz", -200);
    writeFileSync(join(snapshotRoot, "unrelated-file.txt"), "leave me alone");

    pruneOldSnapshots(1, snapshotRoot);
    expect(existsSync(join(snapshotRoot, "unrelated-file.txt"))).toBe(true);
  });

  test("returns an empty array when the snapshot root doesn't exist yet", () => {
    rmSync(snapshotRoot, { recursive: true, force: true });
    expect(pruneOldSnapshots(3, snapshotRoot)).toEqual([]);
  });
});
