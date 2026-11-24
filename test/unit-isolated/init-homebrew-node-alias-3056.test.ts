/**
 * init-homebrew-node-alias-3056.test.ts — flair#3056, through `flair init`.
 *
 * Each case runs the built CLI's `flair init` in a child bun process with a
 * scratch HOME, against an instance the child presents as already running for
 * the data directory (the fixture shape of init-own-listener.test.ts: a stub
 * process recorded in hdb.pid, an injected listener lookup and fetch). The
 * child sets process.execPath to a node binary in a temp Homebrew Cellar whose
 * `opt/node` alias resolves to it, and process.argv[1] to this checkout's
 * dist/cli.js.
 *
 *   - darwin: the child's registerInitLaunchdService runs the real
 *     writeInitLaunchdPlist with the options init passes it, then reports the
 *     service managed without calling launchctl. The fresh plist records the
 *     alias.
 *   - both platforms: a federation-sync shim that enableScheduler wrote with
 *     the Cellar node and this checkout's dist/cli.js is re-pointed to the
 *     alias by init's call to rewriteFederationSchedulerRuntime.
 */
import { beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ensureCliBuild } from "../helpers/build-cli-once.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { enableScheduler } from "../../src/federation/scheduler.ts";

const ROOT = resolve(import.meta.dir, "../..");
const CLI_PATH = join(ROOT, "dist", "cli.js");
const CLI = pathToFileURL(CLI_PATH).href;
const TCP_PROBE = pathToFileURL(join(ROOT, "dist/lib/init-tcp-probe.js")).href;
const INIT = pathToFileURL(join(ROOT, "dist/commands/init.js")).href;
const PASSWORD = "homebrew-alias-password";
const isDarwin = process.platform === "darwin";
const CHILD_DEADLINE_MS = 20_000;
const CASE_BUDGET_MS = 30_000;

beforeAll(() => ensureCliBuild(), 120_000);

interface Fixture {
  home: string;
  dataDir: string;
  cellar: string;
  alias: string;
  result: string;
}

/** A scratch HOME and data dir, plus a Cellar node binary and its `opt/node` alias. */
function fixture(): Fixture {
  const home = tempDir("flair-3056-init-");
  const dataDir = join(home, "data");
  mkdirSync(dataDir);
  chmodSync(dataDir, 0o700);
  writeFileSync(join(dataDir, "harper-config.yaml"), `rootPath: ${dataDir}\n`);
  const prefix = join(home, "homebrew");
  const cellar = join(prefix, "Cellar", "node", "26.10.0_1", "bin", "node");
  mkdirSync(dirname(cellar), { recursive: true });
  writeFileSync(cellar, "#!/bin/sh\n", { mode: 0o755 });
  mkdirSync(join(prefix, "opt"));
  symlinkSync(join("..", "Cellar", "node", "26.10.0_1"), join(prefix, "opt", "node"));
  return { home, dataDir, cellar, alias: join(prefix, "opt", "node", "bin", "node"), result: join(home, "launchd-step.json") };
}

/** Run `flair init` in a child with `process.execPath` set to the fixture's Cellar node. */
function runInit(f: Fixture) {
  const bin = join(f.home, "node_modules/harper/dist/bin");
  mkdirSync(bin, { recursive: true });
  const entry = join(bin, "harper.js");
  writeFileSync(entry, "console.log('ready'); setTimeout(() => {}, 60000);\n");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(FLAIR_|HARPER_|HDB_|FABRIC_|ROOTPATH$)/.test(key),
  ));
  Object.assign(env, { HOME: f.home, USERPROFILE: f.home, FLAIR_ADMIN_PASS: PASSWORD });
  const script = `
    import { mock } from "bun:test";
    import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    import { once } from "node:events";
    process.execPath = ${JSON.stringify(f.cellar)};
    process.argv[1] = ${JSON.stringify(CLI_PATH)};
    mock.module(${JSON.stringify(TCP_PROBE)}, () => ({ localPortState: async () => "listening" }));
    const child = spawn("node", ${JSON.stringify([entry, "run", "."])}, { stdio: ["ignore", "pipe", "ignore"] });
    await once(child.stdout, "data");
    try {
      writeFileSync(${JSON.stringify(join(f.dataDir, "hdb.pid"))}, String(child.pid), { mode: 0o600 });
      const init = await import(${JSON.stringify(INIT)});
      const bindCli = init.bindCli;
      mock.module(${JSON.stringify(INIT)}, () => ({ ...init, bindCli: fns => bindCli({ ...fns,
        registerInitLaunchdService: async (args) => {
          const { writeInitLaunchdPlist } = await import(${JSON.stringify(CLI)});
          const r = await writeInitLaunchdPlist(args.write, { prove: async () => null });
          writeFileSync(${JSON.stringify(f.result)}, JSON.stringify({ kind: r.kind, plistPath: args.write.plistPath }));
          return { kind: "managed", lines: [{ stream: "out", text: "launchd plist: " + r.kind }] };
        },
        repointMainServiceUnit: () => ({ kind: "unchanged" }),
        proveAdminPassAgainstInstance: async () => null,
        resolveInstanceServingPid: (dir, port, deps) => fns.resolveInstanceServingPid(dir, port, { ...deps,
          findListeningPids: deps?.findListeningPids ?? (() => [child.pid]),
          readCmdline: pid => pid === child.pid ? ${JSON.stringify(`node ${entry} run .`)} : null,
          readStartSecondMs: () => Date.now(),
        }),
      }) }));
      const stored = new Map();
      globalThis.fetch = async (url, options = {}) => {
        if (options.method === "PUT") stored.set(String(url), { id: decodeURIComponent(String(url).split("/").pop()), ...JSON.parse(options.body) });
        return new Response(JSON.stringify(stored.get(String(url)) ?? {}), { status: stored.has(String(url)) || /\\/health$/i.test(String(url)) || String(url).endsWith(":20990/") ? 200 : 404 });
      };
      const { program, setOccupiedListenerLookupForTests } = await import(${JSON.stringify(CLI)});
      setOccupiedListenerLookupForTests({ pids: () => [child.pid], rootPath: () => ({ rootPath: null, environReadable: false }) });
      process.exit = code => { throw Object.assign(new Error("fixture exit"), { exitCode: code ?? 0 }); };
      try {
        await program.parseAsync(${JSON.stringify(["init", "--data-dir", f.dataDir, "--port", "20991", "--ops-port", "20990", "--no-mcp", "--skip-soul", "--skip-smoke", "--skip-hook", "--skip-claude-md"])}, { from: "user" });
      } catch (error) {
        if (typeof error.exitCode !== "number") throw error;
        process.exitCode = error.exitCode;
      }
    } finally {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  `;
  return spawnSync("bun", ["--eval", script], {
    cwd: ROOT,
    env: { ...env, FLAIR_TEST_ALLOW_BUN_HARPER: "exercise init-homebrew-node-alias-3056 process fixture arguments" },
    encoding: "utf8",
    timeout: CHILD_DEADLINE_MS,
  });
}

test.skipIf(!isDarwin)("darwin: the fresh launchd plist flair init writes records the opt alias of its Cellar node", () => {
  const f = fixture();

  const r = runInit(f);

  expect(r.error).toBeUndefined();
  expect(r.status, r.stdout + r.stderr).toBe(0);
  const step = JSON.parse(readFileSync(f.result, "utf8")) as { kind: string; plistPath: string };
  expect(step.kind).toBe("written");
  const plist = readFileSync(step.plistPath, "utf8");
  expect(plist).toContain(`<string>${f.alias}</string>`);
  expect(plist).not.toContain(f.cellar);
}, CASE_BUDGET_MS);

test("flair init re-points an existing federation-sync shim from a Cellar node to its opt alias", () => {
  const f = fixture();
  const shim = join(f.home, ".flair", "bin", "flair-federation-sync");
  const fedPass = join(f.home, "fed-admin-pass");
  mkdirSync(dirname(shim), { recursive: true });
  writeFileSync(fedPass, "x\n", { mode: 0o600 });
  enableScheduler({
    intervalSeconds: 300,
    adminPassFile: fedPass,
    flairBin: CLI_PATH,
    nodeBin: f.cellar,
    platformOverride: isDarwin ? "darwin" : "linux",
    shimPathOverride: shim,
    launchdPlistOverride: join(f.home, "Library", "LaunchAgents", "dev.flair.federation.sync.plist"),
    systemdServiceOverride: join(f.home, ".config", "systemd", "user", "flair-federation-sync.service"),
    systemdTimerOverride: join(f.home, ".config", "systemd", "user", "flair-federation-sync.timer"),
    homeOverride: f.home,
    templateRootOverride: join(ROOT, "templates"),
    skipLoad: true,
  });
  const execLine = () => readFileSync(shim, "utf8").split("\n").find((l) => l.startsWith("exec "));
  expect(execLine()).toBe(`exec "${f.cellar}" "${CLI_PATH}" federation sync "$@"`);

  const r = runInit(f);

  expect(r.error).toBeUndefined();
  expect(r.status, r.stdout + r.stderr).toBe(0);
  expect(r.stdout).toContain("Federation sync shim re-pointed at this CLI's install tree");
  expect(execLine()).toBe(`exec "${f.alias}" "${CLI_PATH}" federation sync "$@"`);
}, CASE_BUDGET_MS);
