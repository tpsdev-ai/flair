import { beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ensureCliBuild } from "../helpers/build-cli-once.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const ROOT = resolve(import.meta.dir, "../..");
const CLI = pathToFileURL(join(ROOT, "dist/cli.js")).href;
const TCP_PROBE = pathToFileURL(join(ROOT, "dist/lib/init-tcp-probe.js")).href;
const ATTRIBUTION = pathToFileURL(join(ROOT, "dist/lib/init-spawn-attribution.js")).href;
const INIT = pathToFileURL(join(ROOT, "dist/commands/init.js")).href;

beforeAll(() => ensureCliBuild(), 120_000);

for (const { skipStart, occupied } of [
  { skipStart: false, occupied: false },
  { skipStart: true, occupied: false },
  { skipStart: false, occupied: true },
]) {
  test(`fresh HOME from another cwd, occupied=${occupied}, skip-start=${skipStart}`, () => {    const home = tempDir("ipl-");
    const log = join(home, "actions.json");
    const requests = join(home, "requests.jsonl");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(FLAIR_|HARPER_|HDB_|FABRIC_|ROOTPATH$)/.test(key),
    ));
    Object.assign(env, { HOME: home, USERPROFILE: home, FLAIR_ADMIN_PASS: "plain-init-password" });
    const script = `
      import { mock } from "bun:test";
      import * as childProcess from "node:child_process";
      const realSpawn = childProcess.spawn;
    import { EventEmitter } from "node:events";
      import { appendFileSync, existsSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      const actions = [];
      writeFileSync(${JSON.stringify(log)}, JSON.stringify(actions));
      let running = false;
      let ownChild;
      mock.module("node:child_process", () => ({ ...childProcess, spawn: (command, args, options) => {
        actions.push(args[1]);
        writeFileSync(${JSON.stringify(log)}, JSON.stringify(actions));
        const proc = new EventEmitter();
        proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
        proc.unref = () => {}; proc.kill = () => {};
        if (args[1] === "install") {
          writeFileSync(join(options.env.ROOTPATH, "harper-config.yaml"), "rootPath: " + options.env.ROOTPATH + "\\n");
          queueMicrotask(() => proc.emit("exit", 0));
        } else if (args[1] === "run") {
          ownChild = realSpawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore", env: options.env });
          running = true;
          return ownChild;
        }
        else throw new Error("unexpected spawn");
        return proc;
      } }));
      mock.module(${JSON.stringify(TCP_PROBE)}, () => ({ localPortState: async () => running || ${occupied} ? "listening" : "free" }));
      const attribution = await import(${JSON.stringify(ATTRIBUTION)});
      const track = attribution.trackInitChild;
      mock.module(${JSON.stringify(ATTRIBUTION)}, () => ({ ...attribution,
        trackInitChild: child => track(child, { platform: "darwin" }),
      }));
      const init = await import(${JSON.stringify(INIT)});
      const bindCli = init.bindCli;
      mock.module(${JSON.stringify(INIT)}, () => ({ ...init, bindCli: fns => bindCli({ ...fns,
        harperBin: () => "fixture-harper.js",
        registerInitLaunchdService: async () => ({ kind: "managed", lines: [] }),
        repointMainServiceUnit: () => ({ kind: "unchanged" }),
        waitForHealth: async () => {
          if (!${occupied} && (!running || !existsSync(join(process.env.HOME, ".flair/data/harper-config.yaml")))) throw new Error("own install/start missing");
        },
      }) }));
      const stored = new Map();
      globalThis.fetch = async (url, options = {}) => {
        appendFileSync(${JSON.stringify(requests)}, JSON.stringify({ authorization: new Headers(options.headers).get("Authorization") }) + "\\n");
        if (!running && !${occupied}) throw new Error("released port");
        if (options.method === "PUT") stored.set(String(url), { id: decodeURIComponent(String(url).split("/").pop()), ...JSON.parse(options.body) });
        return new Response(JSON.stringify(stored.get(String(url)) ?? {}), { status: stored.has(String(url)) ? 200 : 404 });
      };
      const { program, setOccupiedListenerLookupForTests } = await import(${JSON.stringify(CLI)});
      setOccupiedListenerLookupForTests({ pids: () => { if (${occupied}) return [42]; return running ? [ownChild.pid] : []; }, rootPath: () => ({ rootPath: null, environReadable: false }) });
      await program.parseAsync(${JSON.stringify(["init", "--port", "20991", "--ops-port", "20990", "--no-mcp", "--skip-soul", "--skip-smoke", "--skip-hook", "--skip-claude-md", ...(skipStart ? ["--skip-start"] : [])])}, { from: "user" });
      writeFileSync(${JSON.stringify(log)}, JSON.stringify(actions));
      ownChild?.kill("SIGKILL");
      process.exit(0);
    `;
    const result = spawnSync("bun", ["--eval", script], { cwd: home, env, encoding: "utf8", timeout: 20_000 });
    expect(result.error).toBeUndefined();
    if (occupied) {
      // Plain init attributes the listener before any credential; an
      // unattributed listener refuses by name and receives none (flair#2251).
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain("Refusing init");
      expect(result.stderr).toContain("port 20991");
      expect(result.stderr).toContain("pid 42");
      expect(result.stderr).toContain("Remedy:");
      expect(JSON.parse(readFileSync(log, "utf8")), result.stdout + result.stderr).toEqual([]);
      const sent = readFileSync(requests, "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(sent.length).toBeGreaterThan(0);
      expect(sent.every(r => r.authorization === null)).toBe(true);
      return;
    }
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("Flair initialized");
    expect(JSON.parse(readFileSync(log, "utf8")), result.stdout + result.stderr).toEqual(skipStart ? ["install"] : ["install", "run"]);
    const sent = readFileSync(requests, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(sent.some(r => r.authorization !== null)).toBe(!skipStart);
  }, 30_000);
}
