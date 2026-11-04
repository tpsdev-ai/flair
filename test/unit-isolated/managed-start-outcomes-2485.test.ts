// managed-start-outcomes-2485.test.ts — flair#2485, driven through `flair start`.
//
// `flair start` on a launchd-managed instance prints a warning when the
// confirmation probe does not get a Flair health answer, naming what the probe
// saw (flair#2422). flair#2485 asks for command-level tests of that stderr for
// the foreign (incl. a redirect from the probed port), refused and unreachable
// outcomes, and for the probe to answer only for the port it probed.
//
// The darwin branch of `flair start` is exercised by overriding
// `process.platform` (the pattern test/unit-isolated/launchd-adopt-stop-deadline-2205.test.ts
// uses), with `launchctl`, `lsof` and `ps` answered by the mocked child_process
// module. Nothing here reaches the host's launchd and no Harper is spawned. The
// credentialed reachability wait goes to a loopback server this file starts and
// stops.
//
// The reachability wait (Authorization header) and the confirmation probe (none)
// are told apart by the header. In the redirect case the probe is served by the
// real fetch against the local server, so that case exercises the real
// `probeHealth`/`fetch` redirect behaviour rather than a stub of it.
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";

const savedHome = process.env.HOME;
const savedPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
let home = tempDir("flair2485-home-");
process.env.HOME = home;
Object.defineProperty(process, "platform", { value: "darwin" });
mock.module("node:os", () => ({ ...require("node:os"), homedir: () => home }));
mock.module("node:child_process", () => ({
  ...childProcess,
  execSync: (cmd: string) => {
    if (cmd.startsWith("launchctl ")) return "";
    throw new Error(`unexpected execSync: ${cmd}`);
  },
  execFileSync: (cmd: string) => {
    if (cmd === "lsof") return "";
    if (cmd === "ps" || cmd === "/bin/ps") return "";
    throw new Error(`unexpected execFileSync: ${cmd}`);
  },
  spawnSync: (cmd: string, args: string[]) => {
    if (cmd === "plutil") return { status: 0, stdout: "OK", stderr: "" };
    if (cmd === "launchctl") {
      if (args[0] === "list") return { status: 113, stdout: "", stderr: "" };
      if (args[0] === "print") return { status: 0, stdout: "domain = {}", stderr: "" };
      if (args[0] === "print-disabled") return { status: 0, stdout: "disabled services = {}", stderr: "" };
    }
    throw new Error(`unexpected spawnSync: ${cmd} ${args}`);
  },
}));

type Outcome = "redirect" | "refused" | "unreachable";
let outcome: Outcome = "refused";
let noAuthProbes = 0;

const realFetch = globalThis.fetch;
const netError = (code: string) => Object.assign(new Error(code), { cause: { code } });
const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  if (!url.endsWith("/Health")) return realFetch(input as string, init);
  // The reachability wait sends credentials; the confirmation probe does not.
  if (init?.headers) return realFetch(input as string, init);
  noAuthProbes += 1;
  // The first no-auth probe is gatherDaemonEvidence's: refused, so the command
  // reads the instance as NOT_RUNNING and proceeds to the launchd branch.
  if (noAuthProbes === 1) return Promise.reject(netError("ECONNREFUSED"));
  if (noAuthProbes > 2) return Promise.reject(netError("ECONNREFUSED"));
  if (outcome === "redirect") return realFetch(input as string, init); // real fetch + real 302
  if (outcome === "refused") return Promise.reject(netError("ECONNREFUSED"));
  return Promise.reject(Object.assign(new Error("timeout"), { cause: { code: "ETIMEDOUT" } }));
}) as unknown as typeof fetch);

const { buildRepairPlist, launchdLabel, launchdPlistPath, program } = await import("../../src/cli.ts");

afterAll(() => {
  fetchSpy.mockRestore();
  Object.defineProperty(process, "platform", savedPlatform);
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
});

const FLAIR_HEALTH = JSON.stringify({ ok: true, version: "0.0.0-test", searchReady: true, buildCommit: null });

const servers: Server[] = [];
let port = 0;

async function listen(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void): Promise<number> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return (server.address() as AddressInfo).port;
}

async function stopServers(): Promise<void> {
  for (const server of servers.splice(0)) {
    if (!server.listening) continue;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** The probed port: Flair 200 to the credentialed wait; the chosen answer to the bare probe. */
async function startProbed(mode: Outcome): Promise<void> {
  let targetPort = 0;
  if (mode === "redirect") {
    targetPort = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", connection: "close" });
      res.end(FLAIR_HEALTH);
    });
  }
  port = await listen((req, res) => {
    if (req.headers.authorization) {
      res.writeHead(200, { "content-type": "application/json", connection: "close" });
      res.end(FLAIR_HEALTH);
      return;
    }
    if (mode === "redirect") {
      res.writeHead(302, { location: `http://127.0.0.1:${targetPort}/Health`, connection: "close" });
      res.end();
      return;
    }
    res.writeHead(500, { connection: "close" });
    res.end();
  });
}

function fixture(): string {
  home = tempDir("flair2485-");
  process.env.HOME = home;
  const dataDir = join(home, ".flair", "data");
  const agentsDir = join(home, "Library", "LaunchAgents");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(agentsDir, { recursive: true });
  chmodSync(dataDir, 0o700);
  writeFileSync(join(home, ".flair", "admin-pass"), "fixture-pass\n", { mode: 0o600 });
  const config = { rootPath: dataDir, http: { port }, operationsApi: { network: { port: port - 1 } } };
  writeFileSync(join(dataDir, "harper-config.yaml"), JSON.stringify(config));
  writeFileSync(launchdPlistPath(launchdLabel(dataDir), agentsDir), buildRepairPlist(dataDir, config));
  return dataDir;
}

async function runStart(): Promise<string> {
  const errLines: string[] = [];
  const errSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errLines.push(args.map(String).join(" "));
    return undefined as unknown as void;
  });
  const logSpy = spyOn(console, "log").mockImplementation(() => undefined as unknown as void);
  const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`unexpected process.exit(${code})`);
  }) as unknown as typeof process.exit);
  try {
    await program.parseAsync(["node", "flair", "start", "--port", String(port)]);
  } finally {
    errSpy.mockRestore();
    logSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return errLines.join("\n");
}

beforeEach(() => {
  noAuthProbes = 0;
});

afterEach(async () => {
  await stopServers();
});

describe("flair#2485 — `flair start` names what the managed-start confirmation probe saw", () => {
  test("a redirect from the probed port is reported as a non-Flair answer, never as running", async () => {
    outcome = "redirect";
    await startProbed("redirect");
    fixture();
    const text = await runStart();
    expect(text).toContain(`The initial reachability wait on port ${port} passed, but the confirmation probe got a response that was not a Flair health answer`);
    expect(text).toContain(`did not return Flair health (foreign)`);
    expect(text).not.toContain("Flair is running on port");
  });

  test("a refused connection is reported as refused", async () => {
    outcome = "refused";
    await startProbed("refused");
    fixture();
    const text = await runStart();
    expect(text).toContain(`The initial reachability wait on port ${port} passed, but the confirmation probe's connection was refused (nothing was listening)`);
    expect(text).toContain(`did not return Flair health (refused)`);
    expect(text).not.toContain("Flair is running on port");
  });

  test("an unreachable port is reported as unreachable", async () => {
    outcome = "unreachable";
    await startProbed("unreachable");
    fixture();
    const text = await runStart();
    expect(text).toContain(`The initial reachability wait on port ${port} passed, but the confirmation probe could not reach the port (timeout or network error)`);
    expect(text).toContain(`did not return Flair health (unreachable)`);
    expect(text).not.toContain("Flair is running on port");
  });
});
