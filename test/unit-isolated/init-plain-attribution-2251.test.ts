import { beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ensureCliBuild } from "../helpers/build-cli-once.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const ROOT = resolve(import.meta.dir, "../..");
const CLI = pathToFileURL(join(ROOT, "dist/cli.js")).href;
const INIT = pathToFileURL(join(ROOT, "dist/commands/init.js")).href;
const TCP_PROBE = pathToFileURL(join(ROOT, "dist/lib/init-tcp-probe.js")).href;
const HTTP_PORT = 20991;
const OPS_PORT = 20990;
const OWN_PID = 4242;

beforeAll(() => ensureCliBuild(), 120_000);

type Scenario = "own" | "free" | "missing-free" | "missing-listener" | "unknown" | "missing-error" | "missing-real-free";

interface Event {
  kind: "probe" | "fetch" | "auth" | "tcp" | "closed";
  host?: string;
  port?: number;
  url?: string;
}

function runPlain(scenario: Scenario, probePort = HTTP_PORT) {
  const home = tempDir("ipa-");
  const events = join(home, "events.jsonl");
  const actions = join(home, "actions.json");
  writeFileSync(events, "");
  writeFileSync(actions, JSON.stringify([]));
  if (scenario === "own") {
    const dataDir = join(home, ".flair", "data");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "harper-config.yaml"), `rootPath: ${dataDir}\n`);
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(FLAIR_|HARPER_|HDB_|FABRIC_|ROOTPATH$)/.test(key),
  ));
  Object.assign(env, { HOME: home, USERPROFILE: home, FLAIR_ADMIN_PASS: "plain-attribution-password" });
  const script = `
    import { mock } from "bun:test";
    import * as childProcess from "node:child_process";
    import { EventEmitter } from "node:events";
    import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const events = ${JSON.stringify(events)};
    const actionsPath = ${JSON.stringify(actions)};
    const log = event => appendFileSync(events, JSON.stringify(event) + "\\n");
    let running = false;
    const probe = await import(${JSON.stringify(TCP_PROBE)});
    const readPort = probe.localPortState;
    const connect = ({ host, port }) => {
      log({ kind: "tcp", port, host });
      const socket = new EventEmitter();
      socket.setTimeout = () => {};
      socket.destroy = () => { log({ kind: "closed", port }); };
      queueMicrotask(() => {
        if (port === ${probePort} && ${scenario === "missing-listener"}) socket.emit("connect");
        else if (port === ${probePort} && ${scenario === "unknown"}) socket.emit("timeout");
        else socket.emit("error", Object.assign(new Error("fixture"), { code: ${JSON.stringify(scenario === "missing-error" ? "EACCES" : "ECONNREFUSED")} }));
      });
      return socket;
    };
    if (${scenario !== "missing-real-free"}) mock.module(${JSON.stringify(TCP_PROBE)}, () => ({ ...probe, localPortState: (port, host) => readPort(port, host, connect) }));
    mock.module("node:child_process", () => ({ ...childProcess, spawn: (command, args, options) => {
      const actions = JSON.parse(readFileSync(actionsPath, "utf8"));
      actions.push(args[1]);
      writeFileSync(actionsPath, JSON.stringify(actions));
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
      proc.unref = () => {}; proc.kill = () => {};
      if (args[1] === "install") {
        writeFileSync(join(options.env.ROOTPATH, "harper-config.yaml"), "rootPath: " + options.env.ROOTPATH + "\\n");
        queueMicrotask(() => proc.emit("exit", 0));
      } else if (args[1] === "run") {
        running = true;
      } else {
        throw new Error("unexpected spawn");
      }
      return proc;
    } }));
    const init = await import(${JSON.stringify(INIT)});
    const bindCli = init.bindCli;
    mock.module(${JSON.stringify(INIT)}, () => ({ ...init, bindCli: fns => bindCli({ ...fns,
      harperBin: () => "fixture-harper.js",
      registerInitLaunchdService: async () => ({ kind: "managed", lines: [] }),
      repointMainServiceUnit: () => ({ kind: "unchanged" }),
      resolveInstanceServingPid: ${scenario === "own" ? `() => ${OWN_PID}` : "fns.resolveInstanceServingPid"},
    }) }));
    const stored = new Map();
    globalThis.fetch = async (url, options = {}) => {
      const authorized = new Headers(options.headers).get("Authorization") !== null;
      log({ kind: authorized ? "auth" : "fetch", url: String(url) });
      if (!running && ${scenario !== "own"}) throw new Error("released port");
      if (options.method === "PUT") stored.set(String(url), { id: decodeURIComponent(String(url).split("/").pop()), ...JSON.parse(options.body) });
      return new Response(JSON.stringify(stored.get(String(url)) ?? {}), { status: stored.has(String(url)) || /\\/health$/i.test(String(url)) ? 200 : 404 });
    };
    const { program, setOccupiedListenerLookupForTests } = await import(${JSON.stringify(CLI)});
    setOccupiedListenerLookupForTests({
      pids: (port) => { log({ kind: "probe", port }); return ${scenario === "own" ? `[${OWN_PID}]` : scenario === "free" ? "[]" : "null"}; },
      rootPath: () => ({ rootPath: null, environReadable: false }),
    });
    await program.parseAsync(${JSON.stringify([
      "init", "--port", String(HTTP_PORT), "--ops-port", String(OPS_PORT),
      "--no-mcp", "--skip-soul", "--skip-smoke", "--skip-hook", "--skip-claude-md",
    ])}, { from: "user" });
    writeFileSync(actionsPath, JSON.stringify(JSON.parse(readFileSync(actionsPath, "utf8"))));
  `;
  const result = spawnSync("bun", ["--eval", script], { cwd: home, env, encoding: "utf8", timeout: 25_000 });
  const eventList: Event[] = readFileSync(events, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  return { result, home, events: eventList, actions: JSON.parse(readFileSync(actions, "utf8")) as string[] };
}

test("re-init on this data directory's own adopted instance succeeds and attributes both ports", () => {
  const { result, events } = runPlain("own");
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain("Flair initialized");
  const probes = events.filter(e => e.kind === "probe").map(e => e.port);
  expect(probes).toContain(HTTP_PORT);
  expect(probes).toContain(OPS_PORT);
  // The operations port is probed before the first credential is sent.
  const firstAuth = events.findIndex(e => e.kind === "auth");
  const opsProbe = events.findIndex(e => e.kind === "probe" && e.port === OPS_PORT);
  expect(firstAuth).toBeGreaterThan(opsProbe);
}, 30_000);

test("the from-scratch flow with just-released ports still succeeds and probes first", () => {
  const { result, events, actions } = runPlain("free");
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain("Flair initialized");
  expect(actions).toEqual(["install", "run"]);
  const probes = events.filter(e => e.kind === "probe").map(e => e.port);
  expect(probes).toContain(HTTP_PORT);
  expect(probes).toContain(OPS_PORT);
  const firstAuth = events.findIndex(e => e.kind === "auth");
  const opsProbe = events.findIndex(e => e.kind === "probe" && e.port === OPS_PORT);
  expect(firstAuth).toBeGreaterThan(opsProbe);
}, 30_000);

test("a failed lsof probe and connect timeout remain unknown: init refuses and starts nothing", () => {
  const { result, events, actions } = runPlain("unknown");
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(result.stderr).toContain(`could not read the listener on port ${HTTP_PORT}`);
  expect(result.stderr).toContain("unknown");
  expect(actions).toEqual([]);
  expect(events.some(e => e.kind === "auth")).toBe(false);
}, 30_000);

test("missing lsof with ECONNREFUSED on both ports installs and starts before sending credentials", () => {
  const { result, events, actions } = runPlain("missing-free");
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain("Flair initialized");
  expect(actions).toEqual(["install", "run"]);
  expect(events.filter(e => e.kind === "tcp")).toEqual([
    { kind: "tcp", port: HTTP_PORT, host: "127.0.0.1" },
    { kind: "tcp", port: OPS_PORT, host: "127.0.0.1" },
  ]);
  expect(events.findIndex(e => e.kind === "auth")).toBeGreaterThan(events.findIndex(e => e.kind === "closed" && e.port === OPS_PORT));
}, 30_000);

for (const scenario of ["missing-listener", "missing-error"] as const) {
  test(`missing lsof with ${scenario} refuses before credentials or start`, () => {
    const { result, events, actions } = runPlain(scenario);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain("Refusing init");
    expect(result.stderr).toContain(`port ${HTTP_PORT}`);
    expect(result.stderr).toContain(scenario === "missing-listener" ? "not attributed" : "unknown");
    expect(actions).toEqual([]);
    expect(events.some(e => e.kind === "auth")).toBe(false);
    expect(events.some(e => e.kind === "closed")).toBe(true);
  }, 30_000);
}


for (const scenario of ["missing-listener", "unknown"] as const) {
  test(`missing lsof with operations port ${scenario} refuses before credentials`, () => {
    const { result, events, actions } = runPlain(scenario, OPS_PORT);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain(`port ${OPS_PORT}`);
    expect(actions).toEqual([]);
    expect(events.some(e => e.kind === "auth")).toBe(false);
  }, 30_000);
}

test("missing lsof with real refused TCP connections still initializes", () => {
  const { result, actions } = runPlain("missing-real-free");
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(actions).toEqual(["install", "run"]);
}, 30_000);
