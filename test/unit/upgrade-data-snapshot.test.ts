// upgrade-data-snapshot.test.ts — Unit tests for flair#637's pre-upgrade
// data snapshot: createDataSnapshot() and pruneOldSnapshots() (pure
// filesystem behavior against throwaway temp dirs — never touches this
// machine's real ~/.flair; both functions take an explicit `snapshotRoot`
// param for exactly this reason), PLUS the 2026-07-08 opt-in rewrite:
//
//   - decideUpgradeSnapshotAction: the pure gating decision behind `flair
//     upgrade`'s snapshot step (default = no snapshot, no abort; --snapshot
//     = same abort-on-failure mechanism as before).
//   - UPGRADE_SNAPSHOT_NUDGE_LINES: the exact non-blocking recommendation
//     text printed when --snapshot is omitted.
//   - The `flair snapshot create|list|restore` command namespace: Commander
//     wiring, plus real subprocess-driven behavior for the paths that don't
//     require actually starting a Harper process (list, and the fast-fail
//     legs of create/restore) — HOME isolation for those is via a genuinely
//     spawned subprocess (Bun's `os.homedir()` ignores an in-process
//     `process.env.HOME` mutation; a fresh child process reads it
//     correctly), never an in-process env mutation.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync,
  chmodSync, statSync, existsSync, readdirSync, utimesSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extract as tarExtract } from "tar";
import {
  program,
  createDataSnapshot,
  pruneOldSnapshots,
  decideUpgradeSnapshotAction,
  UPGRADE_SNAPSHOT_NUDGE_LINES,
} from "../../src/cli";

function findCommand(root: any, path: string[]): any {
  let node = root;
  for (const name of path) {
    node = node.commands.find((c: any) => c.name() === name);
    if (!node) return null;
  }
  return node;
}

describe("flair upgrade — --snapshot flag wiring (flair#637, opt-in rewrite)", () => {
  test("upgrade command registers --snapshot (opt-in) and no longer registers --no-snapshot", () => {
    const upgrade = findCommand(program, ["upgrade"]);
    expect(upgrade).not.toBeNull();
    const optionNames = upgrade.options.map((o: any) => o.long);
    expect(optionNames).toContain("--snapshot");
    expect(optionNames).not.toContain("--no-snapshot");
  });

  test("--snapshot defaults to falsy (opt-in, not opt-out)", () => {
    const upgrade = findCommand(program, ["upgrade"]);
    const snapshotOption = upgrade.options.find((o: any) => o.long === "--snapshot");
    expect(snapshotOption).not.toBeUndefined();
    // Commander gives boolean flags with no explicit default an undefined
    // default — falsy either way, which is what matters: no snapshot
    // unless the caller opts in.
    expect(snapshotOption.defaultValue).toBeFalsy();
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

// ─── decideUpgradeSnapshotAction — pure opt-in gating decision ────────────────
// This is the exact branch `flair upgrade`'s action calls into; testing it
// directly (rather than reimplementing the branches here) means a passing
// suite is a guarantee about the CLI's real behavior, not a parallel model
// of it that could drift.

describe("decideUpgradeSnapshotAction — opt-in gating (2026-07-08 rewrite)", () => {
  test("not upgrading @tpsdev-ai/flair at all: never snapshots, never nudges, regardless of --snapshot or data presence", () => {
    expect(decideUpgradeSnapshotAction(false, false, false)).toBe("not-upgrading");
    expect(decideUpgradeSnapshotAction(false, false, true)).toBe("not-upgrading");
    expect(decideUpgradeSnapshotAction(false, true, false)).toBe("not-upgrading");
    expect(decideUpgradeSnapshotAction(false, true, true)).toBe("not-upgrading");
  });

  test("DEFAULT BEHAVIOR: upgrading, --snapshot NOT passed, data exists → nudge only, no snapshot taken", () => {
    expect(decideUpgradeSnapshotAction(true, false, true)).toBe("nudge");
  });

  test("upgrading, --snapshot NOT passed, no data dir yet → nothing to nudge about", () => {
    expect(decideUpgradeSnapshotAction(true, false, false)).toBe("not-upgrading");
  });

  test("opt-in: upgrading, --snapshot passed, data exists → real snapshot flow", () => {
    expect(decideUpgradeSnapshotAction(true, true, true)).toBe("snapshot");
  });

  test("opt-in with nothing to snapshot: upgrading, --snapshot passed, no data dir yet → no-data (not an abort)", () => {
    expect(decideUpgradeSnapshotAction(true, true, false)).toBe("no-data");
  });
});

describe("UPGRADE_SNAPSHOT_NUDGE_LINES — the opt-out recommendation text", () => {
  test("is non-blocking, informational, and names both alternatives plus the opt-in flag", () => {
    const joined = UPGRADE_SNAPSHOT_NUDGE_LINES.join(" ");
    expect(joined).toContain("No pre-upgrade snapshot will be taken");
    expect(joined).toContain("flair snapshot create");
    expect(joined).toContain("flair backup");
    expect(joined).toContain("--snapshot");
    // Never a prompt — no question mark, no "[y/N]", nothing that implies
    // blocking on input.
    expect(joined).not.toMatch(/\?|\[y\/n\]/i);
  });
});

// ─── flair snapshot — Commander wiring ─────────────────────────────────────────

describe("flair snapshot — command namespace", () => {
  test("registers create, list, and restore subcommands", () => {
    const snapshotCmd = findCommand(program, ["snapshot"]);
    expect(snapshotCmd).not.toBeNull();
    const subNames = snapshotCmd.commands.map((c: any) => c.name());
    expect(subNames).toContain("create");
    expect(subNames).toContain("list");
    expect(subNames).toContain("restore");
  });

  test("does not collide with the logical `backup`/`restore` top-level commands", () => {
    // `flair backup` / `flair restore <path>` are the LOGICAL JSON
    // export/import (Agent/Memory/Soul over HTTP) — the physical snapshot
    // namespace must live under its own `flair snapshot` command, never as
    // a bare top-level `restore` collision.
    const topLevelNames = program.commands.map((c: any) => c.name());
    expect(topLevelNames).toContain("backup");
    expect(topLevelNames).toContain("restore");
    expect(topLevelNames).toContain("snapshot");
    // The top-level `restore` command must remain the logical JSON restore
    // (requires a positional <path> arg and has --merge/--replace options),
    // not the physical one.
    const topLevelRestore = findCommand(program, ["restore"]);
    const restoreOptionNames = topLevelRestore.options.map((o: any) => o.long);
    expect(restoreOptionNames).toContain("--merge");
    expect(restoreOptionNames).toContain("--replace");
    // And `flair snapshot restore` is a DIFFERENT command object from the
    // top-level `flair restore` — same verb, different namespace, not a
    // second registration of the same command.
    const nestedRestore = findCommand(program, ["snapshot", "restore"]);
    expect(nestedRestore).not.toBe(topLevelRestore);
  });

  test("snapshot create supports --data-dir override", () => {
    const create = findCommand(program, ["snapshot", "create"]);
    expect(create).not.toBeNull();
    const optionNames = create.options.map((o: any) => o.long);
    expect(optionNames).toContain("--data-dir");
  });

  test("snapshot restore requires a <path> argument and supports --yes", () => {
    const restore = findCommand(program, ["snapshot", "restore"]);
    expect(restore).not.toBeNull();
    expect(restore.registeredArguments.length).toBeGreaterThan(0);
    const optionNames = restore.options.map((o: any) => o.long);
    expect(optionNames).toContain("--yes");
  });
});

// ─── flair snapshot — real subprocess behavior ─────────────────────────────────
//
// Spawns the real CLI so HOME isolation is genuine (a freshly spawned
// process reads process.env.HOME correctly at startup; mutating
// process.env.HOME in THIS process would not — Bun's os.homedir() caches/
// ignores the live mutation, per the repo-wide rule). Covers only the paths
// that don't require a real Harper process to come up: `list` (pure
// filesystem read), and the fast-fail legs of `create`/`restore` that exit
// before ever calling stopFlairProcess.
//
// Deliberately NOT covered here (nor manually, on this dev host): the full
// stop → snapshot/replace → restart dance in `create`/`restore`.
// stopFlairProcess/startFlairProcess key off a HARDCODED launchd label
// (`ai.tpsdev.flair`) that is global to the current macOS user session,
// independent of HOME — so even an isolated-HOME run of `launchctl
// load/start/stop` against that label can address the SAME job as this
// machine's real, already-running Flair instance. Exercising that path for
// real on a shared dev host risks kicking a live service, not just a test
// fixture. The code itself is a straight, unmodified reuse of
// `flair upgrade`'s already-shipped stop/snapshot/prune/start sequence
// (same functions, same order) — no new logic there to un-verify — so this
// is a scoped, safety-motivated gap, not a shortcut; a CI runner or a
// disposable VM (no real ai.tpsdev.flair job in its launchd session) is the
// right place to add that end-to-end coverage.

describe("flair snapshot create/list/restore — subprocess behavior", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "flair-snapshot-cli-test-"));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  const cliPath = join(import.meta.dirname, "..", "..", "src", "cli.ts");

  async function runCli(args: string[], env: Record<string, string | undefined>): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const merged: Record<string, string> = { ...process.env } as Record<string, string>;
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete merged[k];
      else merged[k] = v;
    }
    const proc = Bun.spawn(["bun", cliPath, ...args], { env: merged, stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  }

  test("snapshot list: empty state reports no snapshots (json and human)", async () => {
    const jsonResult = await runCli(["snapshot", "list", "--json"], { HOME: tmpHome });
    expect(jsonResult.exitCode).toBe(0);
    expect(JSON.parse(jsonResult.stdout.trim())).toEqual([]);

    const humanResult = await runCli(["snapshot", "list"], { HOME: tmpHome });
    expect(humanResult.exitCode).toBe(0);
    expect(humanResult.stdout).toContain("no snapshots");
    expect(humanResult.stdout).toContain("flair snapshot create");
  });

  test("snapshot list: a real snapshot created via createDataSnapshot() (the exact primitive `snapshot create` reuses) shows up", async () => {
    // Seed ~/.flair/upgrade-snapshots the same way `flair snapshot create`
    // would — via the real, unmodified createDataSnapshot() — under the
    // isolated tmpHome, without needing the CLI to drive a Harper stop/start
    // around it.
    const fakeDataDir = mkdtempSync(join(tmpdir(), "flair-snapshot-cli-data-"));
    try {
      writeFileSync(join(fakeDataDir, "harper-config.yaml"), "some: config\n");
      const snapshotRoot = join(tmpHome, ".flair", "upgrade-snapshots");
      const { path: seededPath, bytes } = await createDataSnapshot(fakeDataDir, snapshotRoot);
      expect(existsSync(seededPath)).toBe(true);
      expect(bytes).toBeGreaterThan(0);

      const { stdout, exitCode } = await runCli(["snapshot", "list", "--json"], { HOME: tmpHome });
      expect(exitCode).toBe(0);
      const rows = JSON.parse(stdout.trim());
      expect(rows.length).toBe(1);
      expect(rows[0].path).toBe(seededPath);
      expect(rows[0].size).toBe(bytes);

      const humanResult = await runCli(["snapshot", "list"], { HOME: tmpHome });
      expect(humanResult.stdout).toContain("1 snapshot.");
    } finally {
      rmSync(fakeDataDir, { recursive: true, force: true });
    }
  });

  test("snapshot create: fails cleanly (before touching Flair) when --data-dir does not exist", async () => {
    const missingDir = join(tmpHome, "does-not-exist");
    const { stderr, exitCode } = await runCli(
      ["snapshot", "create", "--data-dir", missingDir],
      { HOME: tmpHome },
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("does not exist");
  });

  test("snapshot restore: fails cleanly (before touching Flair) when the snapshot path does not exist", async () => {
    const missingSnapshot = join(tmpHome, "no-such-snapshot.tar.gz");
    const { stderr, exitCode } = await runCli(
      ["snapshot", "restore", missingSnapshot],
      { HOME: tmpHome },
    );
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("does not exist");
  });

  test("snapshot restore: refuses to destroy data in a non-interactive shell without --yes (never silently destructive)", async () => {
    // A real (tiny) snapshot so the existence check passes and the
    // confirmation gate is what's actually being exercised.
    const fakeDataDir = mkdtempSync(join(tmpdir(), "flair-snapshot-restore-data-"));
    try {
      writeFileSync(join(fakeDataDir, "harper-config.yaml"), "some: config\n");
      const snapshotRoot = join(tmpHome, ".flair", "upgrade-snapshots");
      const { path: seededPath } = await createDataSnapshot(fakeDataDir, snapshotRoot);

      // Bun.spawn's stdin defaults to not being a TTY, so this exercises the
      // same "non-interactive" branch a cron/CI invocation would hit.
      const { stderr, exitCode } = await runCli(
        ["snapshot", "restore", seededPath],
        { HOME: tmpHome },
      );
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("refusing to destroy");
      expect(stderr).toContain("--yes");
    } finally {
      rmSync(fakeDataDir, { recursive: true, force: true });
    }
  });
});
