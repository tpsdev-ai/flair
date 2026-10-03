import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
function runInit(f: Fixture, args: string[], listener: "unknown" | "foreign" | "local" | "foreign-ops" | "many" = "unknown", occupied = true, credential: "explicit" | "saved" = "explicit", httpOccupied = occupied) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(FLAIR_|HARPER_|HDB_|FABRIC_|ROOTPATH$)/.test(key),
  ));
  Object.assign(env, { HOME: f.home, USERPROFILE: f.home, NO_COLOR: "1" });
  if (credential === "explicit") env.FLAIR_ADMIN_PASS = PASSWORD;
  else writeFileSync(join(f.home, ".flair", "admin-pass"), PASSWORD + "\n", { mode: 0o600 });
  const argv = ["init", "--port", String(HTTP_PORT), "--ops-port", String(OPS_PORT),
    "--no-mcp", "--skip-soul", "--skip-smoke", "--skip-hook", "--skip-claude-md", ...args];
  const script = `
    const { appendFileSync } = await import("node:fs");
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
  return spawnSync("node", ["--input-type=module", "-e", script], {
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
    test(`${flag} with --skip-start refuses before setup or requests`, () => {
      const f = fixture();
      const result = runInit(f, ["--skip-start", flag, "canary"], "unknown", false);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain("--skip-start cannot be combined with --agent or --agent-id");
      expect(result.stderr).toContain("omit --agent/--agent-id for installation only");
      expect(result.stderr).toContain("flair init --agent <id> without --skip-start");
      expect(result.stdout).not.toContain("registered");
      expect(result.stdout).not.toContain("initialized successfully");
      expect(requests(f)).toEqual([]);
      expectNoSetup(f);
    }, 30_000);
  }

  for (const skip of [true]) {
    for (const listener of ["unknown", "foreign", "local"] as const) {
      test(`empty directory, occupied port, ${listener} attribution, skip-start=${skip}: no credentials or success`, () => {
        const f = fixture();
        const result = runInit(f, skip ? ["--skip-start"] : [], listener);
        expect(result.error).toBeUndefined();
        expect(result.status, result.stdout + result.stderr).toBe(1);
        expect(result.stderr).toContain(`port ${HTTP_PORT} answered /health with HTTP 401`);
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

  test("an attributed installed listener permits skip-start and queues the seed", () => {
    const f = fixture(true);
    const config = readFileSync(join(f.dataDir, "harper-config.yaml"), "utf8");
    const result = runInit(f, ["--skip-start"], "local");
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("using-flair skill: pending");
    expect(readFileSync(join(f.dataDir, "harper-config.yaml"), "utf8")).toBe(config);
    expect(existsSync(join(f.dataDir, "using-flair-seed-pending"))).toBe(true);
    expect(requests(f).every(r => r.authorization === null)).toBe(true);
  }, 30_000);

  test("an attributed HTTP listener does not authorize a foreign operations listener", () => {
    const f = fixture(true);
    const result = runInit(f, ["--skip-start"], "foreign-ops");
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain(`port ${OPS_PORT}`);
    expect(result.stderr).toContain("/foreign/ops");
    expect(requests(f)).toEqual([
      { url: `http://127.0.0.1:${HTTP_PORT}/health`, authorization: null },
      { url: `http://127.0.0.1:${OPS_PORT}/`, authorization: null },
    ]);
    expect(existsSync(join(f.home, ".flair", "admin-pass"))).toBe(false);
    expect(existsSync(join(f.home, ".flair", "keys"))).toBe(false);
  }, 30_000);
  test("a stopped HTTP port does not authorize an occupied foreign operations port", () => {
    const f = fixture();
    const result = runInit(f, ["--skip-start"], "foreign-ops", true, "explicit", false);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain(`port ${OPS_PORT} answered with HTTP 401`);
    expect(requests(f).every(r => r.authorization === null)).toBe(true);
    expectNoSetup(f);
  }, 30_000);

  test("an HTTP listener without a health response still requires attribution", () => {
    const f = fixture();
    const result = runInit(f, ["--skip-start"], "unknown", true, "explicit", false);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain(`port ${HTTP_PORT} has a listener without a /health response`);
    expect(requests(f).every(r => r.authorization === null)).toBe(true);
    expectNoSetup(f);
  }, 30_000);

});
