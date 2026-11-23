/**
 * doctor-shim-missing-node-3056.test.ts — flair#3056, through the `flair
 * doctor` command.
 *
 * Each case runs the real CLI (`src/cli.ts doctor`) in a scratch HOME holding
 * the federation-sync unit and shim that the real `enableScheduler` writes
 * (skipLoad), with peers declared through FLAIR_FEDERATION_HUB. A fake
 * `launchctl` / `systemctl` first on PATH reports the job loaded with a chosen
 * last exit code; the repo's service-manager tripwire sits behind it, so a call
 * that misses the fake fails the case instead of reaching the host. The port
 * is one nothing listens on.
 *
 * Doctor names the node path on the shim's exec line when that path does not
 * exist, whatever the recorded last exit; it does not when the path exists
 * (an opt alias that moved to a newer version) or when the unit runs another
 * program.
 */
import { describe, it, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import { installServiceManagerTripwire } from "../helpers/fake-launchctl.ts";
import { childOverranDeadline, cliLeg } from "../helpers/child-deadline.ts";
import { enableScheduler } from "../../src/federation/scheduler.ts";

const REPO = join(import.meta.dir, "..", "..");
const CLI_SOURCE = join(REPO, "src", "cli.ts");
const TEMPLATES = join(REPO, "templates");
const CHILD_DEADLINE_MS = 30_000;
const CASE_BUDGET_MS = 45_000;
const PLATFORM = process.platform === "darwin" ? "darwin" : "linux";

/** Quote `value` as one POSIX-shell word. */
const q = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * A `launchctl` and a `systemctl` that log every call and report the
 * federation-sync job loaded with `lastExit` as its recorded last exit.
 */
function fakeServiceManager(root: string, lastExit: number): { dir: string; log: string } {
  const dir = join(root, "fake-bin");
  mkdirSync(dir, { recursive: true });
  const log = join(root, "service-manager.log");
  writeFileSync(log, "");
  const launchctl = [
    "#!/bin/sh",
    `printf 'launchctl %s\\n' "$*" >> ${q(log)} || exit 1`,
    `case " $* " in`,
    `  *" print gui/"*"/dev.flair.federation.sync "*)`,
    `    printf 'gui/0/dev.flair.federation.sync = {\\n\\tstate = waiting\\n\\tlast exit code = ${lastExit}\\n}\\n'`,
    "    exit 0;;",
    "esac",
    "printf 'Could not find service\\n' >&2",
    "exit 113",
    "",
  ];
  const systemctl = [
    "#!/bin/sh",
    `printf 'systemctl %s\\n' "$*" >> ${q(log)} || exit 1`,
    `case " $* " in`,
    `  *" is-active flair-federation-sync.timer "*) printf 'active\\n'; exit 0;;`,
    `  *" show flair-federation-sync.service "*)`,
    `    printf 'ExecMainStatus=${lastExit}\\nResult=${lastExit === 0 ? "success" : "exit-code"}\\nExecMainExitTimestampMonotonic=4242\\n'`,
    "    exit 0;;",
    `  *" show "*) printf 'MainPID=0\\nFragmentPath=\\nDropInPaths=\\nWorkingDirectory=\\n'; exit 0;;`,
    `  *" is-active "*) printf 'inactive\\n'; exit 3;;`,
    "esac",
    "exit 0",
    "",
  ];
  for (const [name, lines] of [["launchctl", launchctl], ["systemctl", systemctl]] as const) {
    writeFileSync(join(dir, name), lines.join("\n"));
    chmodSync(join(dir, name), 0o755);
  }
  return { dir, log };
}

async function deadPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

interface Fixture {
  root: string;
  home: string;
  shim: string;
  unitPath: string;
}

/** A scratch HOME with the federation-sync unit + shim `enableScheduler` writes, baking `nodeBin`. */
function fixture(root: string, nodeBin: string): Fixture {
  const home = join(root, "home");
  mkdirSync(join(home, ".flair", "bin"), { recursive: true });
  writeFileSync(join(home, ".flair", "admin-pass"), "x\n", { mode: 0o600 });
  const tree = join(root, "tree");
  mkdirSync(join(tree, "dist"), { recursive: true });
  writeFileSync(join(tree, "dist", "cli.js"), "// flair\n");
  const shim = join(home, ".flair", "bin", "flair-federation-sync");
  const plist = join(home, "Library", "LaunchAgents", "dev.flair.federation.sync.plist");
  const service = join(home, ".config", "systemd", "user", "flair-federation-sync.service");
  enableScheduler({
    intervalSeconds: 300,
    adminPassFile: join(home, ".flair", "admin-pass"),
    flairBin: join(tree, "dist", "cli.js"),
    nodeBin,
    platformOverride: PLATFORM,
    shimPathOverride: shim,
    launchdPlistOverride: plist,
    systemdServiceOverride: service,
    systemdTimerOverride: join(home, ".config", "systemd", "user", "flair-federation-sync.timer"),
    homeOverride: home,
    templateRootOverride: TEMPLATES,
    skipLoad: true,
  });
  return { root, home, shim, unitPath: PLATFORM === "darwin" ? plist : service };
}

/** Run `flair doctor` against `port` in the fixture's HOME; returns the "Scheduled drivers" section. */
function runDoctor(f: Fixture, port: number, lastExit: number): { section: string; calls: string[] } {
  const fake = fakeServiceManager(f.root, lastExit);
  const tripwire = installServiceManagerTripwire("flair-3056-doctor-tripwire-");
  const cwd = join(f.root, "cwd");
  mkdirSync(cwd, { recursive: true });
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith("FLAIR_") || key.startsWith("HDB_")) continue;
    env[key] = value;
  }
  Object.assign(env, {
    HOME: f.home,
    USERPROFILE: f.home,
    PATH: `${fake.dir}:${tripwire.dir}:${process.env.PATH ?? ""}`,
    FLAIR_FEDERATION_HUB: "https://hub.example",
    NO_COLOR: "1",
  });
  const args = [CLI_SOURCE, "doctor", "--port", String(port)];
  const startedAt = Date.now();
  const r = spawnSync(process.execPath, args, { cwd, env, encoding: "utf8", timeout: CHILD_DEADLINE_MS });
  if (r.signal !== null) {
    throw new Error(
      childOverranDeadline("flair CLI", cliLeg(args.slice(1)), CHILD_DEADLINE_MS, {
        status: r.status,
        signal: r.signal,
        elapsedMs: Date.now() - startedAt,
        stdout: r.stdout,
        stderr: r.stderr,
      }),
    );
  }
  tripwire.assertClear();
  const out = r.stdout ?? "";
  const at = out.indexOf("Scheduled drivers");
  if (at < 0) throw new Error(`doctor printed no Scheduled drivers section: ${JSON.stringify({ stdout: out, stderr: r.stderr })}`);
  const calls = readFileSync(fake.log, "utf-8").split("\n").filter((l) => l !== "");
  return { section: out.slice(at), calls };
}

/** The service-manager queries doctor makes for the federation-sync job on this platform. */
function expectFederationQueries(calls: string[]): void {
  if (PLATFORM === "darwin") {
    expect(calls.filter((c) => /^launchctl print gui\/\S+\/dev\.flair\.federation\.sync$/.test(c)).length).toBeGreaterThan(0);
  } else {
    expect(calls).toContain("systemctl --user is-active flair-federation-sync.timer");
    expect(calls.some((c) => c.startsWith("systemctl --user show flair-federation-sync.service "))).toBe(true);
  }
}

describe("flair doctor names the shim's missing node binary (flair#3056)", () => {
  for (const lastExit of [1, 0]) {
    it(`names it with a recorded last exit of ${lastExit}`, async () => {
      const root = tempDir("flair-3056-doctor-");
      const nodeBin = join(root, "homebrew", "Cellar", "node", "26.10.0_1", "bin", "node");
      const f = fixture(root, nodeBin);

      const { section, calls } = runDoctor(f, await deadPort(), lastExit);

      expectFederationQueries(calls);
      expect(section).toContain(`Federation sync driver DEGRADED — the node binary its shim execs does not exist (${nodeBin})`);
      expect(section).toContain(`${f.unitPath} runs ${f.shim}, whose exec line names ${nodeBin}; that path does not exist.`);
      expect(section).toContain("Fix: flair init");
    }, CASE_BUDGET_MS);
  }

  it("does not name it when the shim's opt alias moved to a newer version that exists", async () => {
    const root = tempDir("flair-3056-doctor-");
    const prefix = join(root, "homebrew");
    const newer = join(prefix, "Cellar", "node", "26.12.1", "bin", "node");
    mkdirSync(dirname(newer), { recursive: true });
    writeFileSync(newer, "#!/bin/sh\n", { mode: 0o755 });
    mkdirSync(join(prefix, "opt"), { recursive: true });
    symlinkSync(join("..", "Cellar", "node", "26.12.1"), join(prefix, "opt", "node"));
    const alias = join(prefix, "opt", "node", "bin", "node");
    const f = fixture(root, alias);

    const { section, calls } = runDoctor(f, await deadPort(), 0);

    expectFederationQueries(calls);
    expect(section).toContain("Federation sync driver: loaded (last run: exit 0)");
    expect(section).not.toContain("does not exist");
  }, CASE_BUDGET_MS);

  it("does not attribute it to the shim when the unit runs another program", async () => {
    const root = tempDir("flair-3056-doctor-");
    const nodeBin = join(root, "homebrew", "Cellar", "node", "26.10.0_1", "bin", "node");
    const f = fixture(root, nodeBin);
    const unit = readFileSync(f.unitPath, "utf-8");
    const other = join(root, "other-sync.sh");
    const changed = PLATFORM === "darwin"
      ? unit.replace(`<string>${f.shim}</string>`, `<string>${other}</string>`)
      : unit.replace(`ExecStart=${f.shim}`, `ExecStart=${other}`);
    expect(changed).not.toBe(unit);
    writeFileSync(f.unitPath, changed);

    const { section, calls } = runDoctor(f, await deadPort(), 1);

    expectFederationQueries(calls);
    expect(section).toContain("Federation sync driver DEGRADED — loaded, but its last run failed");
    expect(section).not.toContain(nodeBin);
  }, CASE_BUDGET_MS);
});
