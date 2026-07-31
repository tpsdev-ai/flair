// snapshot-datadir-instance-targeting.test.ts — regression tests for
// flair#902: `stopFlairProcess`/`startFlairProcess` took a port and nothing
// else, resolved the data directory internally from `defaultDataDir()`, and
// so acted on the DEFAULT instance no matter what `--data-dir` the caller
// was given. `flair snapshot restore --data-dir <scratch>` — the cautious
// "restore it somewhere else and look at it first" move — stopped the live
// install instead, and reported success.
//
// What these tests pin, and how they stay safe on a host with a real Flair
// running:
//
//   - HOME is a throwaway directory, so `defaultDataDir()`,
//     `defaultLaunchAgentsDir()` and the snapshot root all resolve inside
//     the fixture. HOME isolation is via a genuinely spawned subprocess —
//     Bun's `os.homedir()` ignores an in-process `process.env.HOME`
//     mutation (same rule as upgrade-data-snapshot.test.ts).
//   - `launchctl` is a recording shim on PATH. Nothing is loaded, started or
//     stopped for real; the assertions are on the LABEL the CLI resolved,
//     never on an actual stop.
//   - The one test that lets the CLI reach a port-based SIGTERM points it at
//     a listener this test spawned and then asserts that listener is STILL
//     SERVING — a killed listener fails the test instead of taking anything
//     else down.
//
// The launchd tests are darwin-only because `stopFlairProcess`'s launchd
// branch is itself gated on `process.platform === "darwin"`. CI runs on
// ubuntu, where the port-based path is the ONLY path — which is why the
// port-attribution test below is deliberately platform-independent: it is
// both the Linux face of this bug and the one that catches the regression
// everywhere.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createDataSnapshot, launchdLabel, launchdPlistPath } from "../../src/cli";

const isDarwin = process.platform === "darwin";
const cliPath = join(import.meta.dirname, "..", "..", "src", "cli.ts");

/** Minimal launchd plist — Label + the ROOTPATH that identifies the instance it belongs to. */
function plistFor(label: string, rootPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ROOTPATH</key><string>${rootPath}</string>
  </dict>
</dict>
</plist>`;
}

describe("flair#902 — snapshot commands target the instance named by --data-dir", () => {
  let tmpHome: string;
  let shimBin: string;
  let scratchDataDir: string;
  let launchAgentsDir: string;
  let defaultDataDir: string;
  let launchctlLog: string;
  const spawned: Array<{ kill: (s?: number) => void }> = [];

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "flair902-home-"));
    shimBin = mkdtempSync(join(tmpdir(), "flair902-bin-"));
    scratchDataDir = mkdtempSync(join(tmpdir(), "flair902-scratch-"));

    launchAgentsDir = join(tmpHome, "Library", "LaunchAgents");
    mkdirSync(launchAgentsDir, { recursive: true });
    defaultDataDir = join(tmpHome, ".flair", "data");
    mkdirSync(defaultDataDir, { recursive: true });
    // A marker whose survival proves the default install was never touched.
    writeFileSync(join(defaultDataDir, "DEFAULT-INSTANCE-MARKER"), "do not delete me\n");

    launchctlLog = join(tmpHome, "launchctl-invocations.log");
    // Recording shim: every launchctl the CLI runs lands in the log, and
    // nothing reaches real launchd.
    writeFileSync(
      join(shimBin, "launchctl"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "$LAUNCHCTL_LOG"\nexit 0\n`,
      { mode: 0o755 },
    );
  });

  afterEach(() => {
    for (const proc of spawned.splice(0)) {
      try { proc.kill(); } catch { /* already gone */ }
    }
    for (const dir of [tmpHome, shimBin, scratchDataDir]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  async function runCli(args: string[], extraEnv: Record<string, string> = {}) {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      HOME: tmpHome,
      PATH: `${shimBin}:${process.env.PATH ?? ""}`,
      LAUNCHCTL_LOG: launchctlLog,
      ...extraEnv,
    };
    const proc = Bun.spawn(["bun", cliPath, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  }

  function launchctlInvocations(): string {
    return existsSync(launchctlLog) ? readFileSync(launchctlLog, "utf-8") : "";
  }

  /**
   * A stand-in for "an instance is listening on this port". Runs in its own
   * process so that a SIGTERM the CLI should never have sent kills only this
   * stub — and is then visible as a failed assertion, not a dead test runner.
   */
  async function spawnHealthStub(): Promise<{ port: number; url: string; alive: () => Promise<boolean> }> {
    const portFile = join(tmpHome, "stub-port");
    const script = join(tmpHome, "health-stub.mjs");
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
    const url = `http://127.0.0.1:${port}/Health`;
    return {
      port,
      url,
      alive: async () => {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
          return res.ok;
        } catch {
          return false;
        }
      },
    };
  }

  // ─── the headline defect, end to end ────────────────────────────────────

  test.if(isDarwin)(
    "snapshot restore --data-dir <scratch> resolves the SCRATCH instance's launchd label, never the default install's",
    async () => {
      const scratchLabel = launchdLabel(scratchDataDir);
      const defaultLabel = launchdLabel(defaultDataDir);
      expect(scratchLabel).not.toBe(defaultLabel);

      // Both instances are registered with launchd, which is what makes the
      // resolution a real choice rather than a lucky miss.
      writeFileSync(launchdPlistPath(scratchLabel, launchAgentsDir), plistFor(scratchLabel, scratchDataDir));
      writeFileSync(launchdPlistPath(defaultLabel, launchAgentsDir), plistFor(defaultLabel, defaultDataDir));

      // A real snapshot, taken from a third directory, so the restore has
      // something recognisable to write into the scratch data dir.
      const sourceDir = mkdtempSync(join(tmpdir(), "flair902-source-"));
      writeFileSync(join(sourceDir, "harper-config.yaml"), "some: config\n");
      const { path: snapshotPath } = await createDataSnapshot(sourceDir, join(tmpHome, ".flair", "upgrade-snapshots"));
      rmSync(sourceDir, { recursive: true, force: true });

      const stub = await spawnHealthStub();
      const { stdout, exitCode } = await runCli([
        "snapshot", "restore", snapshotPath,
        "--data-dir", scratchDataDir,
        "--port", String(stub.port),
        "--yes",
      ]);

      expect(exitCode).toBe(0);
      expect(stdout).toContain("Restored");

      // The whole point: every launchd verb the CLI issued names the scratch
      // instance. The default install's label never appears at all.
      const invocations = launchctlInvocations();
      expect(invocations).toContain(`stop ${scratchLabel}`);
      expect(invocations).toContain(`start ${scratchLabel}`);
      expect(invocations).not.toContain(defaultLabel);

      // And the default data directory is untouched — restore replaced the
      // directory it was pointed at, not ~/.flair/data.
      expect(existsSync(join(defaultDataDir, "DEFAULT-INSTANCE-MARKER"))).toBe(true);
      expect(existsSync(join(scratchDataDir, "harper-config.yaml"))).toBe(true);
    },
  );

  test.if(isDarwin)(
    "snapshot create --data-dir <scratch> quiesces the SCRATCH instance around the snapshot",
    async () => {
      const scratchLabel = launchdLabel(scratchDataDir);
      const defaultLabel = launchdLabel(defaultDataDir);
      writeFileSync(launchdPlistPath(scratchLabel, launchAgentsDir), plistFor(scratchLabel, scratchDataDir));
      writeFileSync(launchdPlistPath(defaultLabel, launchAgentsDir), plistFor(defaultLabel, defaultDataDir));
      writeFileSync(join(scratchDataDir, "harper-config.yaml"), "some: config\n");

      const stub = await spawnHealthStub();
      const { stdout, exitCode } = await runCli([
        "snapshot", "create",
        "--data-dir", scratchDataDir,
        "--port", String(stub.port),
      ]);

      expect(exitCode).toBe(0);
      expect(stdout).toContain("✅ Snapshot:");

      const invocations = launchctlInvocations();
      expect(invocations).toContain(`stop ${scratchLabel}`);
      expect(invocations).toContain(`start ${scratchLabel}`);
      expect(invocations).not.toContain(defaultLabel);
    },
  );

  // ─── the pre-flair#693 legacy label, which is global to the whole user ──

  test.if(isDarwin)(
    "refuses to stop the legacy launchd service when its plist belongs to another data dir",
    async () => {
      // `ai.tpsdev.flair` is a single label for the whole login session, so
      // resolveLaunchdLabel returns it for ANY data dir once that plist
      // exists — including a scratch one it has nothing to do with.
      writeFileSync(
        launchdPlistPath("ai.tpsdev.flair", launchAgentsDir),
        plistFor("ai.tpsdev.flair", defaultDataDir),
      );

      const sourceDir = mkdtempSync(join(tmpdir(), "flair902-source-"));
      writeFileSync(join(sourceDir, "harper-config.yaml"), "some: config\n");
      const { path: snapshotPath } = await createDataSnapshot(sourceDir, join(tmpHome, ".flair", "upgrade-snapshots"));
      rmSync(sourceDir, { recursive: true, force: true });

      // --port is explicit so this test reaches the launchd guard it is about.
      // Without it the CLI refuses earlier, at port resolution: a non-default
      // data dir with no instance-local config cannot be told which port it
      // serves (flair#914). The value is never used — the refusal below fires
      // before any port is touched — but leaving it out would have this test
      // silently start asserting on a different guard.
      const { stderr, exitCode } = await runCli([
        "snapshot", "restore", snapshotPath,
        "--data-dir", scratchDataDir,
        "--port", "20889",
        "--yes",
      ]);

      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("refusing to stop launchd service ai.tpsdev.flair");
      expect(stderr).toContain(resolve(defaultDataDir));
      // Refused before doing anything, and it did NOT quietly degrade into
      // the port-based stop.
      expect(launchctlInvocations()).toBe("");
      expect(existsSync(join(defaultDataDir, "DEFAULT-INSTANCE-MARKER"))).toBe(true);
    },
  );

  // ─── port-based stop: the only path on Linux, and the one CI runs ───────

  test("refuses a port-based stop it cannot attribute to --data-dir, leaving that instance running", async () => {
    // No launchd plists at all, so both platforms take the port path.
    const stub = await spawnHealthStub();
    expect(await stub.alive()).toBe(true);

    // A deliberately unopenable "snapshot" (a directory — tar's first read
    // is EISDIR). The fixed CLI never gets this far: it refuses at the stop.
    // The fixture exists so that a REGRESSION halts at archive validation
    // instead of carrying on into the destructive half of restore and
    // spawning a Harper — a mutation check should fail on the assertions
    // below, not leave processes behind.
    const snapshotPath = mkdtempSync(join(tmpdir(), "flair902-notanarchive-"));

    const { stderr, exitCode } = await runCli([
      "snapshot", "restore", snapshotPath,
      "--data-dir", scratchDataDir,
      "--port", String(stub.port),
      "--yes",
    ]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("cannot attribute");
    expect(stderr).toContain(resolve(scratchDataDir));

    // The instance on that port is still serving — it was never this
    // command's to stop.
    expect(await stub.alive()).toBe(true);
    // And the restore stopped before the destructive step.
    expect(existsSync(join(defaultDataDir, "DEFAULT-INSTANCE-MARKER"))).toBe(true);
    rmSync(snapshotPath, { recursive: true, force: true });
    // Generous timeout on purpose: a regression here does NOT refuse, it
    // SIGTERMs the stub and then waits 2s for a shutdown that is not coming.
    // The point is to fail on the assertions above with the evidence
    // attached, not on a 5s cutoff.
  }, 30_000);
});
