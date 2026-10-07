import { beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ensureCliBuild } from "../helpers/build-cli-once.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const ROOT = resolve(import.meta.dir, "../..");
const CLI = pathToFileURL(join(ROOT, "dist/cli.js")).href;
const TCP_PROBE = pathToFileURL(join(ROOT, "dist/lib/init-tcp-probe.js")).href;
const INIT = pathToFileURL(join(ROOT, "dist/commands/init.js")).href;
const PASSWORD = "own-listener-password";

beforeAll(() => ensureCliBuild(), 120_000);

function runInit(proof: "own" | "foreign" | "other-pid" | "missing" | "declared" | "unrelated" | "sidecar-pid" | "sidecar-start" | "many", skipStart: boolean, authenticates = true) {
  const home = tempDir("iol-");
  const dataDir = join(home, "data");
  const log = join(home, "requests.jsonl");
  mkdirSync(dataDir);
  const adminPassPath = join(home, ".flair", "admin-pass");
  const originalAdminPass = Buffer.from([0x73, 0x61, 0x76, 0x65, 0x64, 0x0d, 0x0a, 0xff]);
  if (!authenticates) {
    mkdirSync(join(home, ".flair"));
    writeFileSync(adminPassPath, originalAdminPass, { mode: 0o600 });
  }
  writeFileSync(join(dataDir, "harper-config.yaml"), `rootPath: ${dataDir}\n`);
  const bin = join(home, "node_modules/harper/dist/bin");
  mkdirSync(bin, { recursive: true });
  const entry = join(bin, "harper.js");
  writeFileSync(entry, "console.log('ready'); setTimeout(() => {}, 60000);\n");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(FLAIR_|HARPER_|HDB_|FABRIC_|ROOTPATH$)/.test(key),
  ));
  Object.assign(env, { HOME: home, USERPROFILE: home, FLAIR_ADMIN_PASS: PASSWORD });
  const script = `
    import { mock } from "bun:test";
    import { spawn } from "node:child_process";
    import { appendFileSync, writeFileSync } from "node:fs";
    import { once } from "node:events";
    mock.module(${JSON.stringify(TCP_PROBE)}, () => ({ localPortState: async () => "listening" }));
    const child = spawn("node", ${JSON.stringify(proof === "unrelated" ? ["-e", "console.log('ready'); setTimeout(() => {}, 60000)"] : [entry, "run", "."])}, { stdio: ["ignore", "pipe", "ignore"] });
    await once(child.stdout, "data");
    try {
      if (${proof !== "missing" && proof !== "declared"}) writeFileSync(${JSON.stringify(join(dataDir, "hdb.pid"))}, String(child.pid));
      if (${proof === "sidecar-pid" || proof === "sidecar-start"}) writeFileSync(${JSON.stringify(join(dataDir, "flair-daemon.json"))}, JSON.stringify({ pid: ${proof === "sidecar-pid" ? "child.pid + 1" : "child.pid"}, startTimeMs: 0, port: 20991 }));
      const init = await import(${JSON.stringify(INIT)});
      const bindCli = init.bindCli;
      mock.module(${JSON.stringify(INIT)}, () => ({ ...init, bindCli: fns => bindCli({ ...fns,
        registerInitLaunchdService: async () => ({ kind: "managed", lines: [{ stream: "out", text: "already managed — unchanged" }] }),
        repointMainServiceUnit: () => ({ kind: "unchanged" }),
        proveAdminPassAgainstInstance: async () => ${authenticates ? "null" : JSON.stringify("injected credential rejection")},
        resolveInstanceServingPid: (dir, port, deps) => fns.resolveInstanceServingPid(dir, port, { ...deps,
          findListeningPids: deps?.findListeningPids ?? (() => [child.pid]),
          readCmdline: pid => pid === child.pid ? ${JSON.stringify(proof === "unrelated" ? "node -e unrelated" : `node ${entry} run .`)} : null,
          readStartSecondMs: () => Date.now(),
        }),
      }) }));
      const stored = new Map();
      globalThis.fetch = async (url, options = {}) => {
        appendFileSync(${JSON.stringify(log)}, JSON.stringify({ url: String(url), authorization: new Headers(options.headers).get("Authorization") }) + "\\n");
        if (options.method === "PUT") stored.set(String(url), { id: decodeURIComponent(String(url).split("/").pop()), ...JSON.parse(options.body) });
        return new Response(JSON.stringify(stored.get(String(url)) ?? {}), { status: stored.has(String(url)) || /\\/health$/i.test(String(url)) || String(url).endsWith(":20990/") ? 200 : 404 });
      };
      const { program, setOccupiedListenerLookupForTests } = await import(${JSON.stringify(CLI)});
      setOccupiedListenerLookupForTests({
        pids: port => ${proof === "many" ? "[child.pid, child.pid + 1]" : proof === "other-pid" ? "port === 20990 ? [child.pid + 1] : [child.pid]" : "[child.pid]"},
        rootPath: () => ({ rootPath: ${proof === "foreign" ? '"/another/data"' : proof === "declared" ? JSON.stringify(dataDir) : "null"}, environReadable: ${proof === "foreign" || proof === "declared"} }),
      });
      process.exit = code => { throw Object.assign(new Error("fixture exit"), { exitCode: code ?? 0 }); };
      try {
        await program.parseAsync(${JSON.stringify(["init", "--data-dir", dataDir, "--port", "20991", "--ops-port", "20990", "--no-mcp", "--skip-soul", "--skip-smoke", "--skip-hook", "--skip-claude-md", ...(skipStart ? ["--skip-start"] : [])])}, { from: "user" });
      } catch (error) {
        if (typeof error.exitCode !== "number") throw error;
        process.exitCode = error.exitCode;
      }
    } finally {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  `;
  const result = spawnSync("bun", ["--eval", script], { cwd: ROOT, env, encoding: "utf8", timeout: 20_000 });
  const requests = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  return { ...result, home, requests, adminPassPath, originalAdminPass };
}

for (const skipStart of [false, true]) {
  test(`injected listening probe and PID matching the PID file pass the gate, skip-start=${skipStart}`, () => {
    const result = runInit("own", skipStart);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("Flair initialized");
    expect(result.requests.some(r => r.authorization !== null)).toBe(!skipStart);
  }, 30_000);

  for (const proof of ["foreign", "other-pid", "missing", "declared", "unrelated", "sidecar-pid", "sidecar-start", "many"] as const) {
    test(`injected ${proof} listener fixture, skip-start=${skipStart}`, () => {
      const result = runInit(proof, skipStart);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain("attribution to this data directory was not confirmed");
      expect(result.requests.length).toBeGreaterThan(0);
      expect(result.requests.every(r => r.authorization === null)).toBe(true);
      expect(existsSync(join(result.home, ".flair", "admin-pass"))).toBe(false);
    }, 30_000);
  }
}

test("a rejected injected credential preserves admin-pass bytes", () => {
  const result = runInit("own", true, false);
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(result.stderr).toContain("does not authenticate");
  expect(result.stderr).toContain("injected credential rejection");
  expect(readFileSync(result.adminPassPath)).toEqual(result.originalAdminPass);
}, 30_000);
