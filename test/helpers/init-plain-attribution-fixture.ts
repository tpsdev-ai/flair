import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tempDir } from "./temp-dir.ts";

const ROOT = resolve(import.meta.dir, "../..");
const CLI = pathToFileURL(join(ROOT, "dist/cli.js")).href;
const INIT = pathToFileURL(join(ROOT, "dist/commands/init.js")).href;
const SPAWN_ATTRIBUTION = pathToFileURL(join(ROOT, "dist/lib/init-spawn-attribution.js")).href;
const TCP_PROBE = pathToFileURL(join(ROOT, "dist/lib/init-tcp-probe.js")).href;
export const HTTP_PORT = 20991;
export const OPS_PORT = 20990;
const OWN_PID = 4242;

type Scenario = "own" | "own-stopped" | "own-stopped-real-free" | "own-launchd" | "foreign-launchd" | "free" | "missing-free" | "missing-listener" | "unknown" | "missing-error" | "missing-real-free" | "spawned" | "child-dead" | "other-child" | "post-unknown" | "root-mismatch" | "root-missing" | "install-race" | "owner-unknown" | "proc-mismatch" | "real-decoy" | "child-starting" | "lsof-child" | "lsof-empty" | "lsof-unknown";

interface Event {
  kind: "probe" | "fetch" | "auth" | "tcp" | "closed" | "child-alive" | "stopped" | "attribution";
  host?: string;
  port?: number;
  url?: string;
}

export function runPlain(scenario: Scenario, probePort = HTTP_PORT) {
  const home = tempDir("ipa-");
  const events = join(home, "events.jsonl");
  const actions = join(home, "actions.json");
  writeFileSync(events, "");
  writeFileSync(actions, JSON.stringify([]));
  if (["own", "own-stopped", "own-stopped-real-free", "own-launchd", "foreign-launchd"].includes(scenario)) {
    const dataDir = join(home, ".flair", "data");
    mkdirSync(dataDir, { recursive: true });
    // Pin the modes a PID-file proof requires: ownedInitPidfilePid rejects a
    // data dir or hdb.pid with group/other write bits, and default create modes
    // inherit the umask (0002 yields 0775/0664).
    chmodSync(dataDir, 0o700);
    writeFileSync(join(dataDir, "harper-config.yaml"), `rootPath: ${dataDir}\n`);
    writeFileSync(join(dataDir, "hdb.pid"), String(OWN_PID), { mode: 0o600 });
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(FLAIR_|HARPER_|HDB_|FABRIC_|ROOTPATH$)/.test(key),
  ));
  Object.assign(env, { HOME: home, USERPROFILE: home, FLAIR_ADMIN_PASS: "plain-attribution-password" });
  const script = `
    import { mock } from "bun:test";
    import * as childProcess from "node:child_process";
    const realSpawn = childProcess.spawn;
    import { EventEmitter } from "node:events";
    import { appendFileSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
    import { join } from "node:path";
    const events = ${JSON.stringify(events)};
    const actionsPath = ${JSON.stringify(actions)};
    const log = event => appendFileSync(events, JSON.stringify(event) + "\\n");
    let running = false;
    let ownChild;
    let decoy;
    const realFetch = globalThis.fetch;
    let installed = false;
    let stopped = false;
    let httpProbes = 0;
    const procRoot = join(${JSON.stringify(home)}, "proc");
    const attribution = await import(${JSON.stringify(SPAWN_ATTRIBUTION)});
    const track = attribution.trackInitChild;
    mock.module(${JSON.stringify(SPAWN_ATTRIBUTION)}, () => ({ ...attribution,
      trackInitChild: child => track(child, { platform: ${JSON.stringify(scenario.startsWith("lsof-") ? "darwin" : "linux")}, procRoot }),
    }));
    const probe = await import(${JSON.stringify(TCP_PROBE)});
    const readPort = probe.localPortState;
    const { connect: awaitNetConnect } = await import("node:net");
    let startupProbes = 0;
    const connect = ({ host, port }) => {
      log({ kind: "tcp", port, host });
      if (running && ${scenario === "real-decoy"} && port === ${probePort}) {
        return (awaitNetConnect)({ host, port });
      }
      const socket = new EventEmitter();
      socket.setTimeout = () => {};
      socket.destroy = () => { log({ kind: "closed", port }); };
      queueMicrotask(() => {
        if (installed && !running && ${scenario === "install-race"}) socket.emit("connect");
        else if (running && ${scenario === "post-unknown"}) socket.emit("timeout");
        else if (running && ${scenario === "child-starting"} && startupProbes++ === 0) socket.emit("error", Object.assign(new Error("starting"), { code: "ECONNREFUSED" }));
        else if (running) socket.emit("connect");
        else if (${["own", "own-launchd", "foreign-launchd"].includes(scenario)} && (port === ${HTTP_PORT} || ${scenario === "own"})) socket.emit("connect");
        else if (${scenario.startsWith("own-stopped")} && ((port === ${HTTP_PORT} && httpProbes === 1) || port === ${OPS_PORT})) socket.emit("connect");
        else if (port === ${probePort} && ${scenario === "missing-listener"}) socket.emit("connect");
        else if (port === ${probePort} && ${scenario === "unknown"}) socket.emit("timeout");
        else socket.emit("error", Object.assign(new Error("fixture"), { code: ${JSON.stringify(scenario === "missing-error" ? "EACCES" : "ECONNREFUSED")} }));
      });
      return socket;
    };
    mock.module(${JSON.stringify(TCP_PROBE)}, () => ({ ...probe, localPortState: (port, host) => {
      if (port === ${HTTP_PORT} && ${scenario.startsWith("own-stopped")}) {
        stopped = ++httpProbes > 1;
        if (stopped) log({ kind: "stopped", port });
      }
      return (!running && ${scenario === "missing-real-free"}) || (stopped && ${scenario === "own-stopped-real-free"})
        ? readPort(port, host) : readPort(port, host, connect);
    } }));
    mock.module("node:child_process", () => ({ ...childProcess, spawn: (command, args, options) => {
      const actions = JSON.parse(readFileSync(actionsPath, "utf8"));
      actions.push(args[1]);
      writeFileSync(actionsPath, JSON.stringify(actions));
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
      proc.unref = () => {}; proc.kill = () => {};
      if (args[1] === "install") {
        installed = true;
        writeFileSync(join(options.env.ROOTPATH, "harper-config.yaml"), "rootPath: " + options.env.ROOTPATH + "\\n");
        queueMicrotask(() => proc.emit("exit", 0));
      } else if (args[1] === "run") {
        ownChild = realSpawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore", env: options.env });
        running = true;
        mkdirSync(join(procRoot, "net"), { recursive: true });
        mkdirSync(join(procRoot, String(ownChild.pid), "fd"), { recursive: true });
        const rows = [${HTTP_PORT}, ${OPS_PORT}].map((port, i) =>
          "0: 0100007F:" + port.toString(16).toUpperCase() + " 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 " + (700 + i));
        writeFileSync(join(procRoot, "net", "tcp"), "header\\n" + rows.join("\\n") + "\\n");
        writeFileSync(join(procRoot, "net", "tcp6"), "header\\n");
        if (${scenario === "real-decoy"}) {
          decoy = Bun.serve({ hostname: "127.0.0.1", port: ${probePort}, fetch: req => {
            log({ kind: req.headers.has("Authorization") ? "auth" : "fetch", url: req.url });
            return new Response("{}", { status: 200 });
          } });
          const selected = rows.filter((_, i) => [${HTTP_PORT}, ${OPS_PORT}][i] !== ${probePort});
          writeFileSync(join(procRoot, "net", "tcp"), "header\\n" + selected.join("\\n") + "\\n");
        }
        if (${scenario !== "owner-unknown"}) for (let i = 0; i < 2; i++)
          symlinkSync("socket:[" + (${scenario === "proc-mismatch" ? 800 : 700} + i) + "]", join(procRoot, String(ownChild.pid), "fd", String(i)));
        if (${scenario === "child-dead"}) {
          ownChild.kill("SIGKILL");
          ownChild.emit("exit", 1);
          ownChild.exitCode = 1;
        }
        return ownChild;
      } else {
        throw new Error("unexpected spawn");
      }
      return proc;
    } }));
    if (${["root-mismatch", "root-missing"].includes(scenario)}) mock.module(${JSON.stringify(pathToFileURL(join(ROOT, "dist/lib/init-listener-environ.js")).href)}, () => ({ readInitListenerRootPath: () => ({ environReadable: true, rootPath: ${scenario === "root-missing" ? "null" : '"/other/data"'} }) }));
    const init = await import(${JSON.stringify(INIT)});
    const bindCli = init.bindCli;
    mock.module(${JSON.stringify(INIT)}, () => ({ ...init, bindCli: fns => bindCli({ ...fns,
      harperBin: () => "fixture-harper.js",
      registerInitLaunchdService: async () => ({ kind: "managed", lines: [] }),
      repointMainServiceUnit: () => ({ kind: "unchanged" }),
      resolveInstanceServingPid: ${["own", "own-stopped", "own-stopped-real-free", "own-launchd", "foreign-launchd"].includes(scenario) ? `() => { log({ kind: "attribution" }); return ${OWN_PID}; }` : "fns.resolveInstanceServingPid"},
    }) }));
    const stored = new Map();
    globalThis.fetch = async (url, options = {}) => {
      if (running && ${scenario === "real-decoy"} && String(url).includes(":" + ${probePort} + "/")) return realFetch(url, options);
      const authorized = new Headers(options.headers).get("Authorization") !== null;
      log({ kind: authorized ? "auth" : "fetch", url: String(url) });
      if ((!running && ${!["own", "own-stopped", "own-stopped-real-free", "own-launchd", "foreign-launchd"].includes(scenario)}) || (${["own-launchd", "foreign-launchd"].includes(scenario)} && String(url).includes(":" + ${OPS_PORT} + "/"))) throw new Error("released port");
      if (options.method === "PUT") stored.set(String(url), { id: decodeURIComponent(String(url).split("/").pop()), ...JSON.parse(options.body) });
      return new Response(JSON.stringify(stored.get(String(url)) ?? {}), { status: stored.has(String(url)) || /\\/health$/i.test(String(url)) ? 200 : 404 });
    };
    const { program, setOccupiedListenerLookupForTests } = await import(${JSON.stringify(CLI)});
    setOccupiedListenerLookupForTests({
      pids: (port) => { log({ kind: "probe", port }); return running && ${scenario === "lsof-child"} ? [ownChild.pid] : running && ${scenario === "lsof-empty"} ? [] : running && ${scenario === "other-child"} ? [ownChild.pid + 1] : ${["own", "own-stopped", "own-stopped-real-free"].includes(scenario) ? `stopped ? [] : [${OWN_PID}]` : ["own-launchd", "foreign-launchd"].includes(scenario) ? `port === ${HTTP_PORT} ? [${scenario === "own-launchd" ? OWN_PID : OWN_PID + 1}] : []` : scenario === "free" ? "[]" : "null"}; },
      rootPath: () => ({ rootPath: null, environReadable: false }),
    });
    const realExit = process.exit;
    process.exit = code => { throw Object.assign(new Error("fixture exit"), { exitCode: code }); };
    try {
    await program.parseAsync(${JSON.stringify([
      "init", ...(scenario === "real-decoy" ? ["--agent", "canary"] : []), "--port", String(HTTP_PORT), "--ops-port", String(OPS_PORT),
      "--no-mcp", "--skip-soul", "--skip-smoke", "--skip-hook", "--skip-claude-md",
    ])}, { from: "user" });
    } catch (error) {
      if (typeof error.exitCode !== "number") throw error;
      process.exitCode = error.exitCode;
    } finally {
      if (${scenario === "real-decoy"} && decoy) {
        process.kill(ownChild.pid, 0);
        log({ kind: "child-alive" });
      }
      ownChild?.kill("SIGKILL");
      decoy?.stop(true);
    }
    writeFileSync(actionsPath, JSON.stringify(JSON.parse(readFileSync(actionsPath, "utf8"))));
    realExit(process.exitCode ?? 0);
  `;
  const result = spawnSync("bun", ["--eval", script], { cwd: home, env, encoding: "utf8", timeout: 25_000 });
  const eventList: Event[] = readFileSync(events, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  return { result, home, events: eventList, actions: JSON.parse(readFileSync(actions, "utf8")) as string[] };
}
