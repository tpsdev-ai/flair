import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ensureCliBuild } from "../helpers/build-cli-once.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { flairConfigPath } from "../../src/lib/flair-paths.ts";

const ROOT = resolve(import.meta.dir, "../..");
const CLI = pathToFileURL(join(ROOT, "dist/cli.js")).href;
const PASSWORD = "skip-start-safety-password";
const HTTP_PORT = 20991;
const OPS_PORT = 20990;

function fixture(installed = false) {
  const home = tempDir("iss-");
  const dataDir = join(home, ".flair", "data");
  mkdirSync(dataDir, { recursive: true });
  if (installed) writeFileSync(join(dataDir, "harper-config.yaml"), `rootPath: ${dataDir}\n`);
  return { home, dataDir, log: join(home, "requests.jsonl") };
}

type Fixture = ReturnType<typeof fixture>;
function runInit(f: Fixture, args: string[], listener: "unknown" | "foreign" | "local" | "foreign-ops" | "many" = "unknown", occupied = true, credential: "explicit" | "saved" = "explicit", httpOccupied = occupied, runtime: "node" | "bun" = "node") {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(FLAIR_|HARPER_|HDB_|FABRIC_|ROOTPATH$)/.test(key),
  ));
  Object.assign(env, { HOME: f.home, USERPROFILE: f.home, NO_COLOR: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" });
  if (credential === "explicit") env.FLAIR_ADMIN_PASS = PASSWORD;
  else writeFileSync(join(f.home, ".flair", "admin-pass"), PASSWORD + "\n", { mode: 0o600 });
  const argv = ["init", "--port", String(HTTP_PORT), "--ops-port", String(OPS_PORT),
    "--no-mcp", "--skip-soul", "--skip-smoke", "--skip-hook", "--skip-claude-md", ...args];
  const script = `
    ${runtime === "bun" ? `
    const { mock } = await import("bun:test");
    const socketLimitPath = ${JSON.stringify(pathToFileURL(join(ROOT, "dist/lib/socket-path-limit.js")).href)};
    const socketLimit = await import(socketLimitPath);
    mock.module(socketLimitPath, () => ({ ...socketLimit, opsSocketPathRefusal: () => null }));
    ` : ""}
    const { appendFileSync } = await import("node:fs");
    const { EventEmitter } = await import("node:events");
    const net = await import("node:net");
    net.default.createConnection = ({ port }) => {
      const socket = new EventEmitter();
      socket.setTimeout = () => {};
      socket.destroy = () => {};
      queueMicrotask(() => {
        if (port === ${HTTP_PORT} ? ${httpOccupied} : ${occupied}) socket.emit("connect");
        else socket.emit("error", Object.assign(new Error("fixture stopped"), { code: "ECONNREFUSED" }));
      });
      return socket;
    };
    (await import("node:module")).syncBuiltinESMExports();
    globalThis.fetch = async (url, options = {}) => {
      appendFileSync(${JSON.stringify(f.log)}, JSON.stringify({ url: String(url), authorization: new Headers(options.headers).get("Authorization") }) + "\\n");
      if (String(url).includes(":${HTTP_PORT}/") ? !${httpOccupied} : !${occupied}) throw new Error("fixture stopped");
      return new Response("fixture listener", { status: 401 });
    };
    const { program, setOccupiedListenerLookupForTests } = await import(${JSON.stringify(CLI)});
    let port;
    setOccupiedListenerLookupForTests({
      pids: (value) => { port = value; if (value === ${HTTP_PORT} && !${httpOccupied} && ${listener === "foreign-ops"}) return []; return ${occupied ? listener === "many" ? "[42, 43]" : "[42]" : "[]"}; },
      rootPath: () => ({
        rootPath: ${listener === "unknown" ? "null" : listener === "foreign" ? '"/foreign/data"' : listener === "foreign-ops" ? `port === ${OPS_PORT} ? "/foreign/ops" : ${JSON.stringify(f.dataDir)}` : JSON.stringify(f.dataDir)},
        environReadable: ${listener !== "unknown"},
      }),
    });
    await program.parseAsync(${JSON.stringify(argv)}, { from: "user" });
  `;
  return spawnSync(runtime, ["--input-type=module", "-e", script], {
    cwd: ROOT, env, encoding: "utf8", timeout: 20_000,
  });
}

function requests(f: Fixture): Array<{ url: string; authorization: string | null }> {
  return existsSync(f.log) ? readFileSync(f.log, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
}

function expectNoSetup(f: Fixture) {
  expect(existsSync(join(f.dataDir, "harper-config.yaml"))).toBe(false);
  expect(existsSync(join(f.home, ".flair", "admin-pass"))).toBe(false);
  expect(existsSync(join(f.home, ".flair", "keys"))).toBe(false);
  expect(existsSync(join(f.dataDir, "using-flair-seed-pending"))).toBe(false);
  expect(existsSync(flairConfigPath(f.home))).toBe(false);
}

describe("local init skip-start safety through the built CLI", () => {
  beforeAll(() => ensureCliBuild(), 120_000);

  for (const flag of ["--agent", "--agent-id"]) {
    test(`${flag} with --skip-start writes local configuration and defers registration without requests`, () => {
      const f = fixture(true);
      const config = readFileSync(join(f.dataDir, "harper-config.yaml"), "utf8");
      const result = runInit(f, ["--skip-start", flag, "canary"]);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain('Agent registration deferred. After flair start, run flair init --agent "canary"');
      expect(result.stdout).toContain("no agent registered");
      expect(result.stdout).not.toContain("registered ✓");
      expect(result.stdout).not.toContain("verified");
      expect(requests(f)).toEqual([]);
      expect(readFileSync(join(f.home, ".flair", "keys", "canary.key")).length).toBe(32);
      expect(existsSync(join(f.home, ".flair", "keys", "canary.pub"))).toBe(true);
      expect(existsSync(flairConfigPath(f.home))).toBe(true);
      expect(existsSync(join(f.dataDir, "using-flair-seed-pending"))).toBe(true);
      expect(readFileSync(join(f.dataDir, "harper-config.yaml"), "utf8")).toBe(config);
      const key = readFileSync(join(f.home, ".flair", "keys", "canary.key"));
      const passPath = join(f.home, ".flair", "admin-pass");
      const pass = readFileSync(passPath);
      const passStat = statSync(passPath);
      const rerun = runInit(f, ["--skip-start", flag, "canary"]);
      expect(rerun.status, rerun.stdout + rerun.stderr).toBe(0);
      expect(readFileSync(join(f.home, ".flair", "keys", "canary.key"))).toEqual(key);
      expect(readFileSync(passPath)).toEqual(pass);
      expect(statSync(passPath).ino).toBe(passStat.ino);
      expect(statSync(passPath).mtimeMs).toBe(passStat.mtimeMs);
      expect(requests(f)).toEqual([]);
    }, 30_000);
  }

  for (const flag of ["--agent", "--agent-id"]) {
    for (const missingPass of [false, true]) {
      test(`${flag} with --skip-start refuses ${missingPass ? "a missing pass file with a persisted user" : "a different supplied password"} without requests or writes`, () => {
        const f = fixture(true);
        const passPath = join(f.home, ".flair", "admin-pass");
        const dataDir = join(f.home, "d");
        mkdirSync(dataDir);
        writeFileSync(join(dataDir, "harper-config.yaml"), `rootPath: ${dataDir}\n`);
        writeFileSync(join(dataDir, "hdb.pid"), "42\n");
        if (missingPass) {
          mkdirSync(join(dataDir, "system"));
          writeFileSync(join(dataDir, "system", "hdb_user.mdb"), "fixture-user");
        } else {
          writeFileSync(passPath, "saved-password\n", { mode: 0o600 });
        }
        const snapshot = () => readdirSync(f.home, { recursive: true }).sort().map(name => {
          const path = join(f.home, String(name));
          const stat = lstatSync(path);
          return { name, ino: stat.ino, mode: stat.mode, mtimeMs: stat.mtimeMs,
            bytes: stat.isFile() ? readFileSync(path) : null };
        });
        const before = snapshot();
        const result = runInit({ ...f, dataDir }, ["--data-dir", dataDir, "--skip-start", flag, "canary"], "local", true, "explicit", true, "bun");
        expect(result.error).toBeUndefined();
        expect(result.status, result.stdout + result.stderr).toBe(1);
        expect(result.stderr).toBe(
          `Refusing to write ${passPath}: credential verification is deferred by --skip-start. ` +
            `No pass file was written; any existing file is unchanged. ` +
            `Re-run init without --skip-start to verify a different supplied credential.\n`,
        );
        expect(snapshot()).toEqual(before);
        expect(existsSync(passPath)).toBe(!missingPass);
        expect(requests(f)).toEqual([]);
      }, 30_000);
    }
  }

  test("--agent with --skip-start refuses --reset-admin-pass without requests or writes", () => {
    const f = fixture(true);
    const result = runInit(f, ["--skip-start", "--agent", "canary", "--reset-admin-pass"]);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain("Cannot rotate the admin password: Harper is not running and --skip-start was set");
    expect(requests(f)).toEqual([]);
    expect(existsSync(join(f.home, ".flair", "keys"))).toBe(false);
    expect(existsSync(join(f.home, ".flair", "admin-pass"))).toBe(false);
  }, 30_000);

  test("--agent with --skip-start installs an empty data directory without starting or requests", () => {
    const f = fixture();
    const actions = join(f.home, "actions.json");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(FLAIR_|HARPER_|HDB_|FABRIC_|ROOTPATH$)/.test(key),
    ));
    Object.assign(env, { HOME: f.home, USERPROFILE: f.home, NO_COLOR: "1", FLAIR_ADMIN_PASS: PASSWORD });
    const script = `
      import { mock } from "bun:test";
      import * as childProcess from "node:child_process";
      import { EventEmitter } from "node:events";
      import { appendFileSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      const actions = [];
      mock.module("node:child_process", () => ({ ...childProcess, spawn: (command, args, options) => {
        actions.push(args[1]);
        writeFileSync(${JSON.stringify(actions)}, JSON.stringify(actions));
        const proc = new EventEmitter();
        proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
        proc.unref = () => {}; proc.kill = () => {};
        if (args[1] !== "install") throw new Error("unexpected spawn");
        writeFileSync(join(options.env.ROOTPATH, "harper-config.yaml"), "rootPath: " + options.env.ROOTPATH + "\\n");
        queueMicrotask(() => proc.emit("exit", 0));
        return proc;
      } }));
      const init = await import(${JSON.stringify(pathToFileURL(join(ROOT, "dist/commands/init.js")).href)});
      const bindCli = init.bindCli;
      mock.module(${JSON.stringify(pathToFileURL(join(ROOT, "dist/commands/init.js")).href)}, () => ({ ...init, bindCli: fns => bindCli({ ...fns,
        harperBin: () => "fixture-harper.js",
      }) }));
      globalThis.fetch = async (url, options = {}) => {
        appendFileSync(${JSON.stringify(f.log)}, JSON.stringify({ url: String(url), authorization: new Headers(options.headers).get("Authorization") }) + "\\n");
        throw new Error("fixture stopped");
      };
      const { program } = await import(${JSON.stringify(CLI)});
      await program.parseAsync(${JSON.stringify(["init", "--port", String(HTTP_PORT), "--ops-port", String(OPS_PORT),
        "--no-mcp", "--skip-soul", "--skip-smoke", "--skip-hook", "--skip-claude-md", "--skip-start", "--agent", "canary"])}, { from: "user" });
    `;
    const result = spawnSync("bun", ["--eval", script], { cwd: f.home, env, encoding: "utf8", timeout: 20_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(actions, "utf8"))).toEqual(["install"]);
    expect(existsSync(join(f.dataDir, "harper-config.yaml"))).toBe(true);
    expect(result.stdout).toContain('Agent registration deferred. After flair start, run flair init --agent "canary"');
    expect(result.stdout).toContain("no agent registered");
    expect(readFileSync(join(f.home, ".flair", "keys", "canary.key")).length).toBe(32);
    expect(requests(f)).toEqual([]);
  }, 30_000);

  for (const skip of [true]) {
    for (const listener of ["unknown", "foreign", "local"] as const) {
      test(`empty directory, occupied port, ${listener} attribution, skip-start=${skip}: no credentials or success`, () => {
        const f = fixture();
        const result = runInit(f, skip ? ["--skip-start"] : [], listener);
        expect(result.error).toBeUndefined();
        expect(result.status, result.stdout + result.stderr).toBe(1);
        expect(result.stderr).toContain(`port ${HTTP_PORT}, pid 42: attribution to this data directory was not confirmed`);
        expect(result.stderr).toContain("pid 42");
        expect(result.stderr).toContain("Remedy:");
        expect(result.stderr).toContain("--port and --ops-port");
        expect(result.stderr).not.toContain(PASSWORD);
        expect(result.stdout).not.toContain("initialized successfully");
        expect(requests(f)).toEqual([{ url: `http://127.0.0.1:${HTTP_PORT}/health`, authorization: null }]);
        expectNoSetup(f);
      }, 30_000);
    }
  }

  for (const listener of ["unknown", "foreign", "many"] as const) {
    test(`installed directory with ${listener} attribution still refuses before credentials`, () => {
      const f = fixture(true);
      const result = runInit(f, ["--skip-start"], listener);
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(existsSync(join(f.home, ".flair", "admin-pass"))).toBe(false);
      expect(existsSync(join(f.dataDir, "using-flair-seed-pending"))).toBe(false);
      expect(requests(f).every(r => r.authorization === null)).toBe(true);
    }, 30_000);
  }

  test("a saved credential does not authorize an unattributed listener", () => {
    const f = fixture();
    const result = runInit(f, ["--skip-start"], "unknown", true, "saved");
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(readFileSync(join(f.home, ".flair", "admin-pass"), "utf8")).toBe(PASSWORD + "\n");
    expect(requests(f).every(r => r.authorization === null)).toBe(true);
    expect(existsSync(join(f.dataDir, "using-flair-seed-pending"))).toBe(false);
  }, 30_000);

  test("an installed config and matching ROOTPATH without a PID file refuse skip-start", () => {
    const f = fixture(true);
    const config = readFileSync(join(f.dataDir, "harper-config.yaml"), "utf8");
    const result = runInit(f, ["--skip-start"], "local");
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain(`port ${HTTP_PORT}`);
    expect(result.stderr).toContain("attribution to this data directory was not confirmed");
    expect(readFileSync(join(f.dataDir, "harper-config.yaml"), "utf8")).toBe(config);
    expect(existsSync(join(f.dataDir, "using-flair-seed-pending"))).toBe(false);
    expect(requests(f).every(r => r.authorization === null)).toBe(true);
  }, 30_000);
  test("a stopped HTTP port does not authorize an occupied foreign operations port", () => {
    const f = fixture();
    const result = runInit(f, ["--skip-start"], "foreign-ops", true, "explicit", false);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain(`port ${OPS_PORT}`);
    expect(requests(f).every(r => r.authorization === null)).toBe(true);
    expectNoSetup(f);
  }, 30_000);

  test("an injected PID with a simulated free HTTP port refuses before attribution", () => {
    const f = fixture();
    const result = runInit(f, ["--skip-start"], "unknown", true, "explicit", false);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain(`port ${HTTP_PORT}, pid 42: TCP readiness check failed`);
    expect(result.stderr).not.toContain("attribution to this data directory");
    expect(requests(f).every(r => r.authorization === null)).toBe(true);
    expectNoSetup(f);
  }, 30_000);

});
