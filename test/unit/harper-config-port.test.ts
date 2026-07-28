// harper-config-port.test.ts — regression tests for flair#914: the port was
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
// The port is read from HARPER'S OWN CONFIG in the data directory, not from a
// Flair-owned file beside it. Harper writes `harper-config.yaml` at install and
// rewrites it from its environment on every boot, so it describes the instance
// served from that directory and is maintained by the process that binds the
// socket. A Flair-owned copy of the same three facts was a second record with
// nothing to reconcile it — and it goes stale the first time an existing data
// directory is booted on a different port (flair#937).
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
//   - No Harper is ever spawned. Harper's config is written by the fixture in
//     the shape Harper writes it, which is what resolution reads.
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

/** `DEFAULT_PORT` in src/cli.ts. A refusal must never quietly answer with it. */
const DEFAULT_PORT = 19926;

describe("flair#914 — an instance's port comes from Harper's config in its data directory", () => {
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
   * operator comment survives only if resolution READS this file and never
   * rewrites it. Without it, a mutation that rewrote the file produced the same
   * bytes on a canonical fixture and no test noticed.
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

  /**
   * Harper's own config, in the shape Harper writes it — nested `http.port` and
   * `operationsApi.network.port`, alongside `rootPath`. Nesting is the point:
   * a resolver that line-matched a bare `port:` key would pick whichever block
   * came first, so the ops block is written FIRST here on purpose.
   *
   * `opsPortValue` takes Harper's host-qualified form (`"127.0.0.1:9925"`) as
   * well as a bare port, because Harper persists both (`opsNetworkPortValue`).
   */
  function writeHarperConfig(
    dataDir: string,
    opts: { httpPort?: number; opsPortValue?: string | number } = {},
  ): void {
    const dir = resolve(dataDir);
    mkdirSync(dir, { recursive: true });
    const lines = ["# Harper configuration", `rootPath: ${dir}`];
    if (opts.opsPortValue !== undefined) {
      lines.push("operationsApi:", "  network:", `    port: "${opts.opsPortValue}"`, "    cors: true");
    }
    if (opts.httpPort !== undefined) {
      lines.push("http:", `  port: ${opts.httpPort}`, "  cors: true");
    }
    writeFileSync(join(dir, "harper-config.yaml"), `${lines.join("\n")}\n`);
  }

  /** Proof that resolution never conjures a Flair-owned port file (flair#937). */
  function flairOwnedPortFiles(dataDir: string): string[] {
    return ["flair-instance.yaml", "flair-coordinates.yaml", "flair-ports.yaml"]
      .filter((n) => existsSync(join(resolve(dataDir), n)));
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

  // ─── 1. Harper's config is the answer for a named instance ──────────────

  test("resolves a named instance's port from Harper's config, never from the per-user file", async () => {
    // Two ports in play, and they must not be confusable: the per-user file
    // carries one instance's port, the scratch directory carries its own.
    const stub = await spawnHealthStub();
    writeLegacyPerUserConfig();
    const scratch = newScratchDataDir();
    // The ops block carries the per-user file's number, and comes FIRST in the
    // document: a resolver reading the wrong nested key lands on it too, so a
    // single assertion catches both wrong sources.
    writeHarperConfig(scratch, { httpPort: stub.port, opsPortValue: `127.0.0.1:${LEGACY_PER_USER_PORT}` });

    // No --port: the CLI has to work out which port this directory serves.
    const { stderr, exitCode } = await runCli(["snapshot", "create", "--data-dir", scratch]);

    // It found the stub's port — which it can only have got from Harper's
    // config in that directory — and then refused to signal it, because the
    // flair#910 attribution guard could not tie that listener to this
    // directory (no hdb.pid). Both halves matter: the port is instance-correct
    // AND the guard still fires on it.
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain(`port ${stub.port}`);
    expect(stderr).toContain("cannot be attributed");
    expect(stderr).toContain(resolve(scratch));
    expect(stderr).not.toContain(String(LEGACY_PER_USER_PORT));

    expect(await stub.alive()).toBe(true);
    expect(existsSync(join(defaultDataDir, "DEFAULT-INSTANCE-MARKER"))).toBe(true);
  }, 30_000);

  test("reads the port out of Harper's LEGACY config filename too", async () => {
    // An install predating Harper's harperdb-config.yaml → harper-config.yaml
    // rename still serves from the old name, and Harper still falls back to it.
    // Reading only the current name would make a working instance unaddressable.
    const stub = await spawnHealthStub();
    const scratch = newScratchDataDir();
    writeHarperConfig(scratch, { httpPort: stub.port });
    const dir = resolve(scratch);
    writeFileSync(join(dir, "harperdb-config.yaml"), readFileSync(join(dir, "harper-config.yaml"), "utf-8"));
    rmSync(join(dir, "harper-config.yaml"));

    const { stderr, exitCode } = await runCli(["snapshot", "create", "--data-dir", scratch]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain(`port ${stub.port}`);
    expect(stderr).toContain("cannot be attributed");
    expect(await stub.alive()).toBe(true);
  }, 30_000);

  // ─── 2. the default install keeps its per-user file ─────────────────────

  test("a default install with only the per-user config resolves from it, and nothing is written", async () => {
    writeLegacyPerUserConfig();
    const before = perUserConfig();

    // `doctor` is read-only — it resolves the port, probes it, and starts
    // nothing.
    const { stdout, exitCode } = await runCli(["doctor"]);

    // The install still works and still answers on its recorded port.
    expect(stdout).toContain(`(port: ${LEGACY_PER_USER_PORT})`);
    expect(exitCode).not.toBe(0); // no Harper running in the fixture; unrelated to the port

    // Nothing was migrated, copied or invented. The per-user file is
    // byte-identical (read, never rewritten), no Flair-owned port file appeared
    // beside the data directory, and Harper's config was not fabricated for it.
    expect(perUserConfig()).toBe(before);
    expect(flairOwnedPortFiles(defaultDataDir)).toEqual([]);
    expect(existsSync(join(defaultDataDir, "harper-config.yaml"))).toBe(false);
    expect(existsSync(join(defaultDataDir, "DEFAULT-INSTANCE-MARKER"))).toBe(true);
  }, 30_000);

  test("Harper's config outranks the per-user file for the default install", async () => {
    const stub = await spawnHealthStub();
    // The per-user file says one thing; Harper — the process that actually
    // bound the socket — says another. Harper wins, because it is the one that
    // cannot be wrong about which port it is serving.
    writeLegacyPerUserConfig(LEGACY_PER_USER_PORT);
    writeHarperConfig(defaultDataDir, { httpPort: stub.port });
    const before = perUserConfig();

    const { stdout } = await runCli(["doctor"]);

    expect(stdout).toContain(`Harper responding on port ${stub.port}`);
    // The per-user file is still reported as the file it is, and it now
    // disagrees — which is precisely why it is no longer the authority.
    expect(stdout).toContain(`(port: ${LEGACY_PER_USER_PORT})`);
    expect(perUserConfig()).toBe(before);
    expect(await stub.alive()).toBe(true);
  }, 30_000);

  test("a Harper config with no http.port falls through to the per-user file for the default install", async () => {
    // Harper's config exists but has not recorded an HTTP port — the shape a
    // data directory has between `harper install` and a boot that sets one.
    // Its mere presence must not be read as an answer.
    const stub = await spawnHealthStub();
    writeLegacyPerUserConfig(stub.port);
    writeFileSync(join(defaultDataDir, "harper-config.yaml"), "some: config\n");
    const before = perUserConfig();

    const { stdout } = await runCli(["doctor"]);

    expect(stdout).toContain(`Harper responding on port ${stub.port}`);
    expect(perUserConfig()).toBe(before);
    expect(readFileSync(join(defaultDataDir, "harper-config.yaml"), "utf-8")).toBe("some: config\n");
    expect(await stub.alive()).toBe(true);
  }, 30_000);

  // ─── 3. the case that must NOT silently default ─────────────────────────

  test("a non-default data directory with no Harper config is refused, not defaulted", async () => {
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
    // And names what it looked for, so the operator can see why it failed.
    expect(stderr).toContain("harper-config.yaml");
    // It did NOT fall back to the per-user file, and it did NOT default.
    expect(stderr).not.toContain(String(stub.port));
    expect(stderr).not.toContain(String(DEFAULT_PORT));

    // Nothing was signalled, and nothing was invented on disk.
    expect(await stub.alive()).toBe(true);
    expect(flairOwnedPortFiles(scratch)).toEqual([]);
    expect(existsSync(join(resolve(scratch), "harper-config.yaml"))).toBe(false);
    expect(existsSync(join(defaultDataDir, "DEFAULT-INSTANCE-MARKER"))).toBe(true);
  }, 30_000);

  test("a non-default directory whose Harper config records no http.port is refused too", async () => {
    // The presence of Harper's config is not the signal — a resolvable port is.
    // A directory Harper installed into but never booted has no port to give,
    // and guessing one is the bug this fixes.
    const stub = await spawnHealthStub();
    writeLegacyPerUserConfig(stub.port);
    const scratch = newScratchDataDir();
    writeFileSync(join(resolve(scratch), "harper-config.yaml"), "some: config\n");

    const { stderr, exitCode } = await runCli(["snapshot", "create", "--data-dir", scratch]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("cannot determine which port");
    expect(stderr).toContain(resolve(scratch));
    expect(stderr).not.toContain(String(stub.port));
    expect(stderr).not.toContain(String(DEFAULT_PORT));
    expect(await stub.alive()).toBe(true);
  }, 30_000);

  // ─── 4. the headline defect: two instances ──────────────────────────────

  test("two instances resolve to their own ports, and neither can renumber the other", async () => {
    writeLegacyPerUserConfig();
    const before = perUserConfig();
    // Two live listeners, so the resolution below has something to find and a
    // wrong answer is visible rather than inferred.
    const stubA = await spawnHealthStub();
    const stubB = await spawnHealthStub();
    expect(stubA.port).not.toBe(stubB.port);
    const instanceA = newScratchDataDir();
    const instanceB = newScratchDataDir();
    writeHarperConfig(instanceA, { httpPort: stubA.port, opsPortValue: `127.0.0.1:${stubA.port - 1}` });
    writeHarperConfig(instanceB, { httpPort: stubB.port, opsPortValue: `0.0.0.0:${stubB.port - 1}` });

    // Resolution agrees, per directory, with no --port and no ambiguity. Each
    // refusal names the port of the instance it was pointed at and nothing
    // else — the guard from flair#910 reporting an instance-correct port.
    const fromA = await runCli(["snapshot", "create", "--data-dir", instanceA]);
    expect(fromA.stderr).toContain(`port ${stubA.port}`);
    expect(fromA.stderr).not.toContain(String(stubB.port));
    const fromB = await runCli(["snapshot", "create", "--data-dir", instanceB]);
    expect(fromB.stderr).toContain(`port ${stubB.port}`);
    expect(fromB.stderr).not.toContain(String(stubA.port));

    // Neither directory's record was disturbed by addressing the other, and the
    // default install's record was never in the conversation.
    expect(readFileSync(join(resolve(instanceA), "harper-config.yaml"), "utf-8")).toContain(`port: ${stubA.port}`);
    expect(readFileSync(join(resolve(instanceB), "harper-config.yaml"), "utf-8")).toContain(`port: ${stubB.port}`);
    expect(perUserConfig()).toBe(before);

    expect(await stubA.alive()).toBe(true);
    expect(await stubB.alive()).toBe(true);
  }, 60_000);

  test("a non-default init leaves the per-user file alone; a default init writes it", async () => {
    // This is the flair#914 fix itself, and it now lives entirely in the guard
    // on the per-user write. `init --data-dir X --port P` used to write
    // ~/.flair/config.yaml unconditionally, so it renumbered the DEFAULT
    // install every time somebody created a second instance.
    writeLegacyPerUserConfig();
    const before = perUserConfig();
    const instanceA = newScratchDataDir();

    const a = await runCli(["init", "--skip-start", "--no-mcp", "--data-dir", instanceA, "--port", "20991"]);
    expect(a.exitCode).toBe(0);
    // Untouched: still the operator's hand-edited file, still the old port.
    expect(perUserConfig()).toBe(before);
    expect(perUserConfig()).toContain(`port: ${LEGACY_PER_USER_PORT}`);
    // And no Flair-owned port file was left beside the new directory either.
    expect(flairOwnedPortFiles(instanceA)).toEqual([]);

    // The default install is the one case where the per-user file IS about this
    // instance, so init still records it there.
    const d = await runCli(["init", "--skip-start", "--no-mcp", "--port", "20992"]);
    expect(d.exitCode).toBe(0);
    expect(perUserConfig()).toContain("port: 20992");
    expect(flairOwnedPortFiles(defaultDataDir)).toEqual([]);
    expect(existsSync(join(defaultDataDir, "DEFAULT-INSTANCE-MARKER"))).toBe(true);
  }, 60_000);

  // ─── 5. flair#910's guard, on a port that now comes from Harper ─────────

  test("the flair#910 attribution guard passes when Harper's recorded port is the one this instance serves", async () => {
    // The guard's evidence is independent of the port's source: hdb.pid is
    // written by the running process, the listening PIDs come from lsof. Here
    // they agree, so the stop is attributable and proceeds — which is what
    // makes the refusals above refusals rather than a resolver that never
    // succeeds.
    const stub = await spawnHealthStub();
    const scratch = newScratchDataDir();
    writeHarperConfig(scratch, { httpPort: stub.port });
    // The stub IS this instance, as far as the data directory is concerned.
    writeFileSync(join(resolve(scratch), "hdb.pid"), `${stub.pid}\n`);

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

  // ─── 6. a snapshot must not take the restore near the source instance ────
  //
  // darwin-only, and the reason is the HARNESS, not the behaviour: the code
  // under test is platform-independent, but this is the only test here that has
  // to drive a restore all the way THROUGH to its restart leg. On darwin that
  // leg is a launchctl call the recording shim absorbs; everywhere else it
  // spawns a real Harper and waits a minute for health. Gating beats spawning a
  // database in a unit test.

  test.if(process.platform === "darwin")(
    "restoring a snapshot acts on the target instance and never on the source's port",
    async () => {
      // A snapshot is a byte-exact copy of a data directory, so it carries the
      // SOURCE instance's harper-config.yaml — including, here, a port that
      // belongs to a live listener. The restore resolves the TARGET's port
      // BEFORE the extract and hands it to the restart explicitly, so the
      // source's port never becomes an address this host acts on. (The restart
      // is what makes the directory self-describing again: Harper rewrites
      // http.port from that spawn's environment as it boots. Here the launchctl
      // shim absorbs the restart, so this test pins the half it can observe —
      // that nothing was aimed at the source.)
      const foreign = await spawnHealthStub();
      const target = await spawnHealthStub();
      expect(foreign.port).not.toBe(target.port);

      // Built in-process, so making the fixture does not itself have to drive
      // a stop/start cycle.
      const sourceDir = mkdtempSync(join(tmpdir(), "flair914-source-"));
      scratchDirs.push(sourceDir);
      writeHarperConfig(sourceDir, { httpPort: foreign.port, opsPortValue: `0.0.0.0:${foreign.port - 1}` });
      const { path: snapshotPath } = await createDataSnapshot(sourceDir, join(tmpHome, ".flair", "upgrade-snapshots"));

      // The instance being restored into: its own port, and a launchd
      // registration so both the stop and the restart are launchctl calls the
      // recording shim eats. No hdb.pid on purpose — the stop leg waits for a
      // recorded PID to exit, and the listener this test needs alive for the
      // restart's health check is that same process.
      const dest = newScratchDataDir();
      writeHarperConfig(dest, { httpPort: target.port, opsPortValue: `127.0.0.1:${target.port - 1}` });
      const destLabel = launchdLabel(dest);
      writeFileSync(
        launchdPlistPath(destLabel, join(tmpHome, "Library", "LaunchAgents")),
        `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n  <key>Label</key><string>${destLabel}</string>\n`
          + `  <key>EnvironmentVariables</key>\n  <dict>\n    <key>ROOTPATH</key><string>${dest}</string>\n  </dict>\n</dict>\n</plist>\n`,
      );

      const { exitCode } = await runCli(["snapshot", "restore", snapshotPath, "--data-dir", dest, "--yes"]);
      expect(exitCode).toBe(0);

      // The data arrived.
      expect(existsSync(join(resolve(dest), "harper-config.yaml"))).toBe(true);
      // Every lifecycle call this restore made was aimed at THIS instance's
      // launchd label — the stop and the restart both. The source instance was
      // never addressed, and it is still serving.
      const calls = existsSync(launchctlLog) ? readFileSync(launchctlLog, "utf-8") : "";
      expect(calls).toContain(destLabel);
      expect(calls).not.toContain(launchdLabel(sourceDir));
      expect(await foreign.alive()).toBe(true);
      // And no Flair-owned port file was resurrected beside the restored data.
      expect(flairOwnedPortFiles(dest)).toEqual([]);
    },
    60_000,
  );
});
