// instance-local-port.test.ts — regression tests for flair#914: the port was
// recorded in `~/.flair/config.yaml`, which holds ONE port for the whole user.
// `flair init --data-dir X --port P` wrote it unconditionally, so a second
// instance silently overwrote the first's recorded port, and `resolveHttpPort()`
// then answered a per-instance question from a file that cannot tell instances
// apart — with no data directory as input at all.
//
// This is the dual of flair#902 (fixed in flair#910): that one resolved the
// INSTANCE from the wrong directory; this one resolved the PORT from a file
// with no notion of instances. Both are the same shape — a lookup keyed by
// something other than the thing it describes.
//
// What these tests pin, and how they stay safe on a host with a real Flair
// running:
//
//   - HOME is a throwaway directory, so `defaultDataDir()`, `configPath()` and
//     `defaultLaunchAgentsDir()` all resolve inside the fixture. HOME isolation
//     is via a genuinely spawned subprocess — Bun's `os.homedir()` ignores an
//     in-process `process.env.HOME` mutation (same rule as
//     snapshot-datadir-instance-targeting.test.ts).
//   - `launchctl` is a recording shim on PATH. Nothing is loaded, started or
//     stopped for real.
//   - Every test that lets the CLI reach a port-based SIGTERM points it at a
//     listener this test spawned. Where the CLI must refuse, the assertion is
//     that the listener is STILL SERVING — a killed listener fails the test
//     instead of taking anything else down.
//   - `init` runs with `--skip-start`, so no Harper is ever spawned; the
//     coordinates it persists are the thing under test.
//
// All but the last test are deliberately platform-independent: the launchd
// path is macOS-only, but the port path is the ONLY path on Linux (where CI
// runs) and the defect is in resolution, which is shared. The exception is
// noted where it sits, and it is gated on the harness, not on the behaviour.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createDataSnapshot, launchdLabel, launchdPlistPath } from "../../src/cli";

const cliPath = join(import.meta.dirname, "..", "..", "src", "cli.ts");

/** The per-user port a pre-flair#914 install has recorded. Never a resolved answer for a NAMED instance. */
const LEGACY_PER_USER_PORT = 20881;

describe("flair#914 — the port lives beside the data directory it describes", () => {
  let tmpHome: string;
  let shimBin: string;
  let defaultDataDir: string;
  let launchctlLog: string;
  const scratchDirs: string[] = [];
  const spawned: Array<{ kill: (s?: number) => void }> = [];

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "flair914-home-"));
    shimBin = mkdtempSync(join(tmpdir(), "flair914-bin-"));

    mkdirSync(join(tmpHome, "Library", "LaunchAgents"), { recursive: true });
    defaultDataDir = join(tmpHome, ".flair", "data");
    mkdirSync(defaultDataDir, { recursive: true });
    // A marker whose survival proves the default install was never touched.
    writeFileSync(join(defaultDataDir, "DEFAULT-INSTANCE-MARKER"), "do not delete me\n");

    launchctlLog = join(tmpHome, "launchctl-invocations.log");
    writeFileSync(
      join(shimBin, "launchctl"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "$LAUNCHCTL_LOG"\nexit 0\n`,
      { mode: 0o755 },
    );
  });

  afterEach(() => {
    for (const proc of spawned.splice(0)) {
      // SIGKILL: one stub deliberately ignores SIGTERM, and a survivor would
      // hold its port into the next test.
      try { proc.kill(9); } catch { /* already gone */ }
    }
    for (const dir of [tmpHome, shimBin, ...scratchDirs.splice(0)]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function newScratchDataDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "flair914-scratch-"));
    scratchDirs.push(dir);
    return dir;
  }

  async function runCli(args: string[], extraEnv: Record<string, string> = {}) {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      HOME: tmpHome,
      PATH: `${shimBin}:${process.env.PATH ?? ""}`,
      LAUNCHCTL_LOG: launchctlLog,
      ...extraEnv,
    };
    // FLAIR_URL outranks every config rung, so an ambient one in the
    // developer's shell would mask exactly what these tests measure.
    delete env.FLAIR_URL;
    delete env.FLAIR_TARGET;
    const proc = Bun.spawn(["bun", cliPath, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  }

  /**
   * The per-user `~/.flair/config.yaml` a pre-flair#914 install carries.
   *
   * Deliberately NOT byte-identical to what `writeConfig` would emit: the
   * operator comment survives only if the migration READS this file and never
   * rewrites it. Without it, a mutation that rewrote the file on migration
   * produced the same bytes on a canonical fixture and no test noticed.
   */
  function writeLegacyPerUserConfig(port: number = LEGACY_PER_USER_PORT): void {
    mkdirSync(join(tmpHome, ".flair"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".flair", "config.yaml"),
      `# Flair configuration\n# operator note: hand-edited, keep this line\nport: ${port}\n`,
    );
  }

  function perUserConfig(): string {
    const p = join(tmpHome, ".flair", "config.yaml");
    return existsSync(p) ? readFileSync(p, "utf-8") : "";
  }

  function instanceConfig(dataDir: string): string {
    const p = join(resolve(dataDir), "flair-instance.yaml");
    return existsSync(p) ? readFileSync(p, "utf-8") : "";
  }

  function recordedPort(dataDir: string): number | null {
    const m = instanceConfig(dataDir).match(/^\s*port:\s*(\d+)/m);
    return m ? Number(m[1]) : null;
  }

  /**
   * A stand-in for "an instance is listening on this port". Runs in its own
   * process so that a SIGTERM the CLI should never have sent kills only this
   * stub — and is then visible as a failed assertion, not a dead test runner.
   */
  async function spawnHealthStub(): Promise<{ port: number; pid: number; alive: () => Promise<boolean> }> {
    const portFile = join(tmpHome, `stub-port-${spawned.length}`);
    const script = join(tmpHome, `health-stub-${spawned.length}.mjs`);
    writeFileSync(
      script,
      [
        `import { createServer } from "node:http";`,
        `import { writeFileSync } from "node:fs";`,
        `const srv = createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"status":"ok"}'); });`,
        `srv.listen(0, "127.0.0.1", () => writeFileSync(process.argv[2], String(srv.address().port)));`,
      ].join("\n"),
    );
    const proc = Bun.spawn(["bun", script, portFile], { stdout: "ignore", stderr: "ignore" });
    spawned.push(proc);
    for (let i = 0; i < 100 && !existsSync(portFile); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!existsSync(portFile)) throw new Error("health stub did not report a port");
    const port = Number(readFileSync(portFile, "utf-8").trim());
    return {
      port,
      pid: (proc as unknown as { pid: number }).pid,
      alive: async () => {
        try {
          return (await fetch(`http://127.0.0.1:${port}/Health`, { signal: AbortSignal.timeout(2000) })).ok;
        } catch {
          return false;
        }
      },
    };
  }

  // ─── 1. the instance's own file is the answer ───────────────────────────

  test("resolves a named instance's port from its own config, never from the per-user file", async () => {
    // Two ports in play, and they must not be confusable: the per-user file
    // carries one instance's port, the scratch directory carries its own.
    const stub = await spawnHealthStub();
    writeLegacyPerUserConfig();
    const scratch = newScratchDataDir();
    writeFileSync(join(scratch, "flair-instance.yaml"), `port: ${stub.port}\n`);

    // No --port: the CLI has to work out which port this directory serves.
    const { stderr, exitCode } = await runCli(["snapshot", "create", "--data-dir", scratch]);

    // It found the stub's port — which it can only have got from the
    // instance-local file — and then refused to signal it, because the
    // flair#910 attribution guard could not tie that listener to this
    // directory (no hdb.pid). Both halves matter: the port is instance-correct
    // AND the guard still fires on it.
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain(`port ${stub.port}`);
    expect(stderr).toContain("cannot be attributed");
    expect(stderr).toContain(resolve(scratch));
    // The per-user file's port never entered the resolution.
    expect(stderr).not.toContain(String(LEGACY_PER_USER_PORT));

    expect(await stub.alive()).toBe(true);
    expect(existsSync(join(defaultDataDir, "DEFAULT-INSTANCE-MARKER"))).toBe(true);
  }, 30_000);

  // ─── 2. the migration: default dir, legacy per-user file ────────────────

  test("a default install with only the legacy per-user config migrates on first use and is unchanged by it", async () => {
    writeLegacyPerUserConfig();
    const before = perUserConfig();
    expect(instanceConfig(defaultDataDir)).toBe(""); // nothing there yet

    // `doctor` is read-only — it resolves the port, probes it, and starts
    // nothing. The migration is a side effect of the resolution, which is the
    // point: an existing install upgrades on first use, whatever that use is.
    const { stdout, exitCode } = await runCli(["doctor"]);

    // The install still works and still answers on its recorded port.
    expect(stdout).toContain(`(port: ${LEGACY_PER_USER_PORT})`);
    expect(exitCode).not.toBe(0); // no Harper running in the fixture; unrelated to the port

    // Migrated: the port now lives beside the data directory it describes.
    expect(recordedPort(defaultDataDir)).toBe(LEGACY_PER_USER_PORT);
    // And nothing else moved. The per-user file is byte-identical — the
    // migration reads it, it does not rewrite or delete it — and the data
    // directory's contents are untouched.
    expect(perUserConfig()).toBe(before);
    expect(existsSync(join(defaultDataDir, "DEFAULT-INSTANCE-MARKER"))).toBe(true);
  }, 30_000);

  test("once migrated, the instance's own file outranks the per-user file", async () => {
    const stub = await spawnHealthStub();
    writeLegacyPerUserConfig(stub.port);

    // First use migrates stub.port into the data directory.
    await runCli(["doctor"]);
    expect(recordedPort(defaultDataDir)).toBe(stub.port);

    // Now the per-user file changes underneath it — which is exactly what a
    // pre-fix `flair init --data-dir <elsewhere> --port <other>` did to it.
    writeLegacyPerUserConfig(LEGACY_PER_USER_PORT);

    const { stdout } = await runCli(["doctor"]);
    // Resolution still answers with THIS instance's port: doctor reached the
    // live stub. The per-user file is reported as the file it is, and it now
    // disagrees — which is precisely why it is no longer the authority.
    expect(stdout).toContain(`Harper responding on port ${stub.port}`);
    expect(stdout).toContain(`(port: ${LEGACY_PER_USER_PORT})`);
    expect(await stub.alive()).toBe(true);
  }, 30_000);

  // ─── 3. the case that must NOT silently default ─────────────────────────

  test("a non-default data directory with no instance config is refused, not defaulted", async () => {
    // The per-user file points at a live listener. Under the old resolution
    // this command would have found that port and signalled it.
    const stub = await spawnHealthStub();
    writeLegacyPerUserConfig(stub.port);
    const scratch = newScratchDataDir();

    const { stderr, exitCode } = await runCli(["snapshot", "create", "--data-dir", scratch]);

    expect(exitCode).not.toBe(0);
    // Names the directory and the remedy — a refusal has to say what to pass.
    expect(stderr).toContain("cannot determine which port");
    expect(stderr).toContain(resolve(scratch));
    expect(stderr).toContain("--port");
    // It did NOT fall back to the per-user file, and it did NOT default.
    expect(stderr).not.toContain(String(stub.port));
    expect(stderr).not.toContain("19926");

    // Nothing was signalled, and nothing was invented on disk: no instance
    // config conjured for a directory we know nothing about, and no migration
    // fired for the default install either.
    expect(await stub.alive()).toBe(true);
    expect(instanceConfig(scratch)).toBe("");
    expect(instanceConfig(defaultDataDir)).toBe("");
    expect(existsSync(join(defaultDataDir, "DEFAULT-INSTANCE-MARKER"))).toBe(true);
  }, 30_000);

  // ─── 4. the headline defect: two instances ──────────────────────────────

  test("a second instance's init does not overwrite the first's recorded port", async () => {
    writeLegacyPerUserConfig();
    const before = perUserConfig();
    // Two live listeners, so the resolution below has something to find and a
    // wrong answer is visible rather than inferred.
    const stubA = await spawnHealthStub();
    const stubB = await spawnHealthStub();
    expect(stubA.port).not.toBe(stubB.port);
    const instanceA = newScratchDataDir();
    const instanceB = newScratchDataDir();

    // The real init path, twice. --skip-start so no Harper is spawned; the
    // coordinates it persists are what is under test.
    const a = await runCli(["init", "--skip-start", "--no-mcp", "--data-dir", instanceA, "--port", String(stubA.port)]);
    expect(a.exitCode).toBe(0);
    const b = await runCli(["init", "--skip-start", "--no-mcp", "--data-dir", instanceB, "--port", String(stubB.port)]);
    expect(b.exitCode).toBe(0);

    // Each instance kept its own port. This is the whole bug: B's init used to
    // land on the same per-user file A's had written, so A's port was gone.
    expect(recordedPort(instanceA)).toBe(stubA.port);
    expect(recordedPort(instanceB)).toBe(stubB.port);

    // And neither of them touched the default install's record.
    expect(perUserConfig()).toBe(before);

    // Resolution agrees, per directory, with no --port and no ambiguity. Each
    // refusal names the port of the instance it was pointed at and nothing
    // else — the guard from flair#910 reporting an instance-correct port.
    const fromA = await runCli(["snapshot", "create", "--data-dir", instanceA]);
    expect(fromA.stderr).toContain(`port ${stubA.port}`);
    expect(fromA.stderr).not.toContain(String(stubB.port));
    const fromB = await runCli(["snapshot", "create", "--data-dir", instanceB]);
    expect(fromB.stderr).toContain(`port ${stubB.port}`);
    expect(fromB.stderr).not.toContain(String(stubA.port));

    expect(await stubA.alive()).toBe(true);
    expect(await stubB.alive()).toBe(true);
  }, 60_000);

  // ─── 5. the install everybody already has ───────────────────────────────

  test("an existing single-instance install keeps working on its own port, untouched, and upgrades on first use", async () => {
    // A pre-flair#914 install: Harper already in the default data directory,
    // port recorded only in the per-user file, and something answering on it.
    const stub = await spawnHealthStub();
    writeLegacyPerUserConfig(stub.port);
    writeFileSync(join(defaultDataDir, "harper-config.yaml"), "some: config\n");
    const before = perUserConfig();

    const first = await runCli(["doctor"]);
    // It found the running instance — on the port this install has always
    // used, resolved through the migration.
    expect(first.stdout).toContain(`Harper responding on port ${stub.port}`);
    expect(recordedPort(defaultDataDir)).toBe(stub.port);

    // Untouched: the per-user file is byte-identical (read, never rewritten),
    // and nothing in the data directory was disturbed.
    expect(perUserConfig()).toBe(before);
    expect(existsSync(join(defaultDataDir, "DEFAULT-INSTANCE-MARKER"))).toBe(true);
    expect(readFileSync(join(defaultDataDir, "harper-config.yaml"), "utf-8")).toBe("some: config\n");

    // Second use goes straight to the instance-local file. Same answer, and
    // the migration does not run twice or drift.
    const second = await runCli(["doctor"]);
    expect(second.stdout).toContain(`Harper responding on port ${stub.port}`);
    expect(recordedPort(defaultDataDir)).toBe(stub.port);
    expect(perUserConfig()).toBe(before);
    expect(await stub.alive()).toBe(true);

    // Re-running init is doctor's standing remedy, so it has to keep working
    // on this install. It does not assert the port here on purpose: init's
    // `--port` option carries a commander default of 19926, so init always
    // states a port and never consults the config rung at all. That is
    // pre-existing (an install on a custom port is renumbered to 19926 by a
    // bare `flair init` on unmodified main too) and is reported separately —
    // it is not this change's to alter.
    const reinit = await runCli(["init", "--skip-start", "--no-mcp"]);
    expect(reinit.exitCode).toBe(0);
    expect(existsSync(join(defaultDataDir, "DEFAULT-INSTANCE-MARKER"))).toBe(true);
  }, 60_000);

  // ─── 6. flair#910's guard, on a port that now comes from the instance ───

  test("the flair#910 attribution guard passes when the instance-local port is the one this instance serves", async () => {
    // The guard's evidence is independent of the port's source: hdb.pid is
    // written by the running process, the listening PIDs come from lsof. Here
    // they agree, so the stop is attributable and proceeds — which is what
    // makes the refusals above refusals rather than a resolver that never
    // succeeds.
    const stub = await spawnHealthStub();
    const scratch = newScratchDataDir();
    writeFileSync(join(scratch, "flair-instance.yaml"), `port: ${stub.port}\n`);
    // The stub IS this instance, as far as the data directory is concerned.
    writeFileSync(join(scratch, "hdb.pid"), `${stub.pid}\n`);

    // A deliberately unopenable "snapshot" (a directory — tar's first read is
    // EISDIR). restore stops FIRST, then validates the archive, so this
    // exercises the stop and halts before the destructive half — nothing is
    // extracted and no Harper is started.
    const notAnArchive = mkdtempSync(join(tmpdir(), "flair914-notanarchive-"));
    scratchDirs.push(notAnArchive);

    const { stderr, exitCode } = await runCli([
      "snapshot", "restore", notAnArchive, "--data-dir", scratch, "--yes",
    ]);

    expect(exitCode).not.toBe(0);
    // Not a refusal — it got past the stop and failed on the archive.
    expect(stderr).not.toContain("cannot be attributed");
    expect(stderr).toContain("was NOT modified");
    // The stop actually happened: the process this data directory claims is
    // its own was signalled, and nothing else was.
    expect(await stub.alive()).toBe(false);
    expect(existsSync(join(defaultDataDir, "DEFAULT-INSTANCE-MARKER"))).toBe(true);
  }, 30_000);

  // ─── 7. a snapshot must not rename the port of the instance it lands in ──
  //
  // darwin-only, and the reason is the HARNESS, not the behaviour: the code
  // under test (re-asserting the port after the extract) is platform-
  // independent, but this is the only test here that has to drive a restore
  // all the way THROUGH to its restart leg. On darwin that leg is a launchctl
  // call the recording shim absorbs; everywhere else it spawns a real Harper
  // and waits a minute for health. Gating beats spawning a database in a unit
  // test — and the assertion is on a file written before the restart either
  // way.

  test.if(process.platform === "darwin")(
    "restoring a snapshot does not give the target instance the source instance's port",
    async () => {
      // A snapshot is a byte-exact copy of a data directory, so it carries the
      // SOURCE instance's flair-instance.yaml — including, here, a port that
      // belongs to a live listener. If the extract's copy were left in place,
      // the restored directory would claim a port it does not serve, and the
      // next command to address it would act on somebody else's instance.
      const foreign = await spawnHealthStub();
      const target = await spawnHealthStub();
      expect(foreign.port).not.toBe(target.port);

      // Built in-process, so making the fixture does not itself have to drive
      // a stop/start cycle.
      const sourceDir = mkdtempSync(join(tmpdir(), "flair914-source-"));
      scratchDirs.push(sourceDir);
      writeFileSync(join(sourceDir, "harper-config.yaml"), "some: config\n");
      writeFileSync(join(sourceDir, "flair-instance.yaml"), `port: ${foreign.port}\nopsBind: 0.0.0.0\n`);
      const { path: snapshotPath } = await createDataSnapshot(sourceDir, join(tmpHome, ".flair", "upgrade-snapshots"));

      // The instance being restored into: its own port, its own ops bind, and
      // a launchd registration so both the stop and the restart are launchctl
      // calls the recording shim eats. No hdb.pid on purpose — the stop leg
      // waits for a recorded PID to exit, and the listener this test needs
      // alive for the restart's health check is that same process.
      const dest = newScratchDataDir();
      writeFileSync(join(dest, "flair-instance.yaml"), `port: ${target.port}\nopsBind: 127.0.0.1\n`);
      const destLabel = launchdLabel(dest);
      writeFileSync(
        launchdPlistPath(destLabel, join(tmpHome, "Library", "LaunchAgents")),
        `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n  <key>Label</key><string>${destLabel}</string>\n`
          + `  <key>EnvironmentVariables</key>\n  <dict>\n    <key>ROOTPATH</key><string>${dest}</string>\n  </dict>\n</dict>\n</plist>\n`,
      );

      const { exitCode } = await runCli(["snapshot", "restore", snapshotPath, "--data-dir", dest, "--yes"]);
      expect(exitCode).toBe(0);

      // The data arrived; the identity did not.
      expect(existsSync(join(dest, "harper-config.yaml"))).toBe(true);
      expect(recordedPort(dest)).toBe(target.port);
      expect(instanceConfig(dest)).not.toContain(String(foreign.port));
      expect(instanceConfig(dest)).toContain("opsBind: 127.0.0.1");
      // Nothing went near the instance the snapshot came from.
      expect(await foreign.alive()).toBe(true);
    },
    60_000,
  );
});
