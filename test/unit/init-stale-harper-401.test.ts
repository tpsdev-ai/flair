import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { program, seedAgentViaOpsApi, setOccupiedListenerLookupForTests } from "../../src/cli.js";
import { flairDataDir } from "../../src/lib/flair-paths.js";
import { listenerRootPathOnPlatform } from "../../src/lib/init-listener-environ.js";
import { parseNullSeparatedEnviron, extractRootPath } from "../../src/lib/daemon-liveness.js";
import {
  foreignOccupiedListenerDetail,
  listenerFromLookup,
  occupiedListenerAuthFailure,
  stableAnsweredHolder,
  type OccupiedHarperListener,
} from "../../src/lib/init-occupied-listener.js";
import { childOverranDeadline, cliLeg } from "../helpers/child-deadline.js";
import { installFakeServiceManager } from "../helpers/fake-launchctl.ts";

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts");
const CHILD_DEADLINE_MS = 30_000;
const CASE_BUDGET_MS = 40_000;

const STUB_SCRIPT = `
const http = require("http");
const fs = require("fs");
const role = process.env.STUB_ROLE || "both";
const logPath = process.env.STUB_LOG;
function note(req) {
  if (!logPath) return;
  fs.appendFileSync(logPath, JSON.stringify({
    method: req.method,
    url: req.url,
    authorization: req.headers.authorization || null,
  }) + "\\n");
}
function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      note(req);
      handler(req, res);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}
function ok(_req, res) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ status: "ok" }));
}
function denied(_req, res) {
  res.writeHead(401, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "Login failed" }));
}
(async () => {
  const out = { pid: process.pid, httpPort: null, opsPort: null };
  if (role === "both" || role === "http") {
    const health = await listen(ok);
    out.httpPort = health.address().port;
  }
  if (role === "both" || role === "ops") {
    const ops = await listen(denied);
    out.opsPort = ops.address().port;
  }
  process.stdout.write(JSON.stringify(out) + "\\n");
})();
`;

let scratch: string | null = null;
const children: ChildProcess[] = [];

// flair#2057: init drives a darwin launchd step. Its one launchctl call is a
// `launchctl unload` of the legacy (pre-flair#693) plist, made only when that
// plist exists and its ROOTPATH is the data dir being initialised
// (cleanupLegacyLaunchdPlist in src/cli.ts). No fixture here creates one, but
// if a fixture or init ever reaches that call it must not land on the
// developer's own GUI launchd domain. flair#2062: on a systemd host, init's
// Linux tree assessment also asks `systemctl --user show` about the caller's
// cgroup unit. So lay the shared fake `launchctl`/`systemctl` first on PATH
// (like the command-level launchd tests do) with a tripwire directly behind it:
// no run in this file — in-process or spawned — can reach the host's service
// manager. See test/helpers/fake-launchctl.ts.
let fakeServiceManager: ReturnType<typeof installFakeServiceManager> | undefined;
let savedPath: string | undefined;

beforeEach(() => {
  // Capture PATH before installing, so a failed install cannot leave teardown
  // restoring an unset value (which would delete PATH for later tests).
  savedPath = process.env.PATH;
  fakeServiceManager = undefined;
  fakeServiceManager = installFakeServiceManager("flair-1749-svc-");
  process.env.PATH = `${fakeServiceManager.pathEntry}:${savedPath ?? ""}`;
  // Proves the fakes — not the tripwire, not the host binaries — answer
  // launchctl and systemctl for this PATH. This is the tripwire's own mutation
  // check: drop a fake and this throws the named tripwire message.
  fakeServiceManager.assertShadowed("launchctl");
  fakeServiceManager.assertShadowed("systemctl");
});

afterEach(() => {
  try {
    // Any byte in the tripwire log means some run reached a service manager that
    // was not the fake. That must never happen in a unit test.
    fakeServiceManager?.assertClear();
  } finally {
    fakeServiceManager?.cleanup();
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  }
});

afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
  }
  children.length = 0;
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

interface StubReady {
  httpPort: number | null;
  opsPort: number | null;
  pid: number;
}

function startStub(rootPath: string, role: "both" | "http" | "ops", logPath: string, harperEntry = false): Promise<StubReady> {
  const scriptPath = harperEntry
    ? join(scratch!, "node_modules", "harper", "dist", "bin", "harper.js")
    : join(scratch!, `stub-${role}.js`);
  if (harperEntry) mkdirSync(join(scratch!, "node_modules", "harper", "dist", "bin"), { recursive: true });
  writeFileSync(scriptPath, STUB_SCRIPT);
  const child = spawn(process.execPath, [scriptPath, ...(harperEntry ? ["run", "."] : [])], {
    env: { ...process.env, ROOTPATH: rootPath, STUB_ROLE: role, STUB_LOG: logPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`stub ${role} did not become ready: ${buf}`)), 5_000);
    child.stdout?.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      clearTimeout(timer);
      resolve(JSON.parse(buf.slice(0, nl)) as StubReady);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`stub ${role} exited before ready (${code}): ${buf}`));
    });
  });
}

function readStubLog(logPath: string): { method: string; url: string; authorization: string | null }[] {
  if (!existsSync(logPath)) return [];
  const raw = readFileSync(logPath, "utf-8").trim();
  if (!raw) return [];
  return raw.split("\n").map((line) => JSON.parse(line) as { method: string; url: string; authorization: string | null });
}

function isolatedEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  for (const key of [
    "FLAIR_ADMIN_PASS",
    "HDB_ADMIN_PASSWORD",
    "FLAIR_URL",
    "FLAIR_TARGET",
    "FLAIR_OPS_PORT",
    "FLAIR_OPS_TARGET",
    "FLAIR_ADMIN_USER",
    "FLAIR_SOCKET_GROUP",
    "ROOTPATH",
  ]) {
    delete env[key];
  }
  return env;
}

function runInit(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn("bun", [CLI_PATH, "init", ...args], {
      cwd: join(import.meta.dir, "..", ".."),
      env,
      // Numeric literals: check-cli-spawn-budgets does not read CHILD_DEADLINE_MS.
      timeout: 30_000,
      killSignal: "SIGTERM",
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code, signal) => {
      if (signal !== null) {
        reject(new Error(childOverranDeadline("flair CLI", cliLeg(["init", ...args]), CHILD_DEADLINE_MS, {
          status: code,
          signal,
          stdout,
          stderr,
          elapsedMs: Date.now() - startedAt,
          timeoutSignal: "SIGTERM",
        })));
        return;
      }
      resolve({ code, stdout, stderr });
    });
    child.on("error", (err) => reject(err));
  });
}

const ISOLATED_ENV_KEYS = [
  "HOME",
  "FLAIR_ADMIN_PASS",
  "HDB_ADMIN_PASSWORD",
  "FLAIR_URL",
  "FLAIR_TARGET",
  "FLAIR_OPS_PORT",
  "FLAIR_OPS_TARGET",
  "FLAIR_ADMIN_USER",
  "FLAIR_SOCKET_GROUP",
  "ROOTPATH",
] as const;

/** In-process init. The caller injects the listener lookup first. */
async function runInitInProcess(args: string[], home: string): Promise<{ stdout: string; stderr: string }> {
  const saved = ISOLATED_ENV_KEYS.map((key) => [key, process.env[key]] as const);
  const origExit = process.exit;
  const origLog = console.log;
  const origErr = console.error;
  let stdout = "";
  let stderr = "";
  process.env.HOME = home;
  for (const key of ISOLATED_ENV_KEYS) {
    if (key !== "HOME") delete process.env[key];
  }
  console.log = (...parts: unknown[]) => {
    stdout += parts.map((part) => String(part)).join(" ") + "\n";
  };
  console.error = (...parts: unknown[]) => {
    stderr += parts.map((part) => String(part)).join(" ") + "\n";
  };
  process.exit = ((code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`);
  }) as typeof process.exit;
  try {
    await program.parseAsync(["node", "flair", "init", ...args]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("process.exit")) throw err;
  } finally {
    process.exit = origExit;
    console.log = origLog;
    console.error = origErr;
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    setOccupiedListenerLookupForTests(null);
  }
  return { stdout, stderr };
}

/** `typeof fetch` is overloaded, so a one-status stub needs the double assertion. */
function loginFailedFetch(): typeof fetch {
  return (async () => new Response('{"error":"Login failed"}', { status: 401 })) as unknown as typeof fetch;
}

function expectHealthLoggedThenNoAuthorization(
  requests: { method: string; url: string; authorization: string | null }[],
): void {
  expect(requests.some((req) => req.method === "GET" && req.url === "/health")).toBe(true);
  expect(requests.every((req) => req.authorization === null)).toBe(true);
}

const SKIP_INIT_EXTRAS = [
  "--no-mcp",
  "--skip-soul",
  "--skip-hook",
  "--skip-claude-md",
  "--skip-smoke",
] as const;

const listenerBase = {
  port: 19926,
  pids: [] as number[],
  dataDirs: [] as string[],
};

describe("flair#1749 — init and a Harper this init did not start", () => {
  test("foreign data directory: stop before any authenticated request", async () => {
    scratch = mkdtempSync(join(tmpdir(), "flair-1749-"));
    const home = join(scratch, "home");
    const dataDir = join(scratch, "data");
    const staleDataDir = join(scratch, "stale-harper");
    const keysDir = join(scratch, "keys");
    const logPath = join(scratch, "requests.log");
    mkdirSync(home, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(staleDataDir, { recursive: true });
    mkdirSync(keysDir, { recursive: true });

    const listener = await startStub(staleDataDir, "both", logPath);
    setOccupiedListenerLookupForTests({
      pids: () => [listener.pid],
      rootPath: () => ({ rootPath: staleDataDir, environReadable: true }),
    });
    const { stdout, stderr } = await runInitInProcess([
      "--agent", "canary",
      "--port", String(listener.httpPort),
      "--ops-port", String(listener.opsPort),
      "--data-dir", dataDir,
      "--keys-dir", keysDir,
      "--admin-pass", "this-init-password",
      ...SKIP_INIT_EXTRAS,
    ], home);
    const output = stdout + stderr;
    const requests = readStubLog(logPath);

    expect(output).toContain("Refusing init");
    expect(output).toContain("attribution to this data directory was not confirmed");
    expect(output).not.toContain("Waiting for Harper health check");
    expect(output).not.toContain("Operations API insert failed");
    expect(output).not.toContain("admin password will not match");
    expect(output).not.toContain("admin credentials differ");
    expect(output).not.toContain("wrong password");
    expect(output).not.toContain("wrong username");
    expect(output).not.toContain("flair stop");
    expect(output).not.toContain("this-init-password");
    expect(output).toContain(staleDataDir);
    expect(output).toContain(`pid ${listener.pid}`);
    expect(output).toContain(`kill ${listener.pid}`);
    expectHealthLoggedThenNoAuthorization(requests);
    expect(requests.some((req) => req.method === "POST")).toBe(false);
    expect(children[0]?.exitCode).toBe(null);
    expect(children[0]?.killed).toBe(false);
  }, CASE_BUDGET_MS);

  test("no admin password: refusal names the listener and does not authenticate", async () => {
    scratch = mkdtempSync(join(tmpdir(), "flair-1749-"));
    const home = join(scratch, "home");
    const dataDir = join(scratch, "data");
    const staleDataDir = join(scratch, "stale-harper");
    const logPath = join(scratch, "requests.log");
    mkdirSync(home, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(staleDataDir, { recursive: true });

    const listener = await startStub(staleDataDir, "both", logPath);
    setOccupiedListenerLookupForTests({
      pids: () => [listener.pid],
      rootPath: () => ({ rootPath: staleDataDir, environReadable: true }),
    });
    const { stdout, stderr } = await runInitInProcess([
      "--agent", "canary",
      "--port", String(listener.httpPort),
      "--ops-port", String(listener.opsPort),
      "--data-dir", dataDir,
      "--no-mcp",
      "--skip-soul",
    ], home);
    const output = stdout + stderr;
    const requests = readStubLog(logPath);

    expect(output).toContain("Refusing init");
    expect(output).not.toContain("flair stop");
    expect(output).toContain(`kill ${listener.pid}`);
    expect(output).not.toContain("wrong password");
    expect(output).not.toContain("Operations API insert failed");
    expect(output).not.toContain("admin password will not match");
    expect(output).toContain(staleDataDir);
    expect(output).toContain(`pid ${listener.pid}`);
    expectHealthLoggedThenNoAuthorization(requests);
    expect(children[0]?.exitCode).toBe(null);
  }, CASE_BUDGET_MS);

  test("default-directory listener recorded by pidfile and sidecar does not offer flair stop", async () => {
    // The remedy removed in 191627a0 printed `flair stop` when defaultDataDir()'s
    // hdb.pid and flair-daemon.json both named a pid from the listener lookup.
    // Restoring that read beside the current lookup seam fails the assertion
    // below. That seam is not in 8baa0a85, so this test was not run there.
    scratch = mkdtempSync(join(tmpdir(), "flair-1749-"));
    const home = join(scratch, "home");
    const defaultDir = flairDataDir(home);
    const dataDir = join(scratch, "other");
    const logPath = join(scratch, "requests.log");
    mkdirSync(home, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(defaultDir, { recursive: true });

    const listener = await startStub(defaultDir, "both", logPath);
    writeFileSync(join(defaultDir, "hdb.pid"), `${listener.pid}\n`);
    writeFileSync(join(defaultDir, "flair-daemon.json"), `${JSON.stringify({ pid: listener.pid })}\n`);
    setOccupiedListenerLookupForTests({
      pids: () => [listener.pid],
      rootPath: () => ({ rootPath: defaultDir, environReadable: true }),
    });
    const { stdout, stderr } = await runInitInProcess([
      "--agent", "canary",
      "--port", String(listener.httpPort),
      "--ops-port", String(listener.opsPort),
      "--data-dir", dataDir,
      "--no-mcp",
      "--skip-soul",
    ], home);
    const output = stdout + stderr;
    const requests = readStubLog(logPath);

    expect(output).toContain("Refusing init");
    expect(output).toContain(defaultDir);
    expect(output).toContain(`pid ${listener.pid}`);
    expect(output).toContain(`kill ${listener.pid}`);
    expect(output).not.toContain("flair stop");
    expectHealthLoggedThenNoAuthorization(requests);
    expect(children[0]?.exitCode).toBe(null);
  }, CASE_BUDGET_MS);

  const operationsFixtureSupported = process.platform === "linux" && (() => {
    try { execFileSync("lsof", ["-v"], { stdio: "ignore" }); return true; }
    catch (e: any) { return e?.code !== "ENOENT"; }
  })();
  if (!operationsFixtureSupported) console.info("Skipping live listener attribution: requires Linux and lsof.");
  for (const decoyPort of ["http", "ops"] as const) test.skipIf(!operationsFixtureSupported)(`a ${decoyPort} listener declaring ROOTPATH without PID-file proof gets no credential`, async () => {
    scratch = mkdtempSync(join(tmpdir(), "flair-1749-"));
    const home = join(scratch, "home");
    const dataDir = join(scratch, "data");
    const keysDir = join(scratch, "keys");
    const httpLog = join(scratch, "http.log");
    const opsLog = join(scratch, "ops.log");
    mkdirSync(home, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(keysDir, { recursive: true });
    // Pin the modes a PID-file proof requires: ownedInitPidfilePid rejects a data
    // dir or hdb.pid with group/other write bits, and default create modes inherit
    // the umask (0002 yields 0775/0664).
    chmodSync(dataDir, 0o700);

    writeFileSync(join(dataDir, "harper-config.yaml"), `rootPath: ${dataDir}\n`);
    const httpHolder = await startStub(dataDir, "http", httpLog, decoyPort === "ops");
    const opsHolder = await startStub(dataDir, "ops", opsLog);
    if (decoyPort === "ops") writeFileSync(join(dataDir, "hdb.pid"), `${httpHolder.pid}\n`, { mode: 0o600 });
    const { code, stdout, stderr } = await runInit([
      "--agent", "canary",
      "--port", String(httpHolder.httpPort),
      "--ops-port", String(opsHolder.opsPort),
      "--data-dir", dataDir,
      "--keys-dir", keysDir,
      "--admin-pass", "this-init-password",
      "--no-mcp",
      "--skip-soul",
      "--skip-hook",
      "--skip-claude-md",
      "--skip-smoke",
    ], isolatedEnv(home));
    const output = stdout + stderr;

    expect(code).not.toBe(0);
    expect(output).toContain("Refusing init");
    expect(output).toContain(`port ${decoyPort === "http" ? httpHolder.httpPort : opsHolder.opsPort}`);
    expect(output).toContain("attribution to this data directory was not confirmed");
    expect(output).toContain("Remedy:");
    const decoyRequests = readStubLog(decoyPort === "http" ? httpLog : opsLog);
    expect(decoyRequests.length).toBeGreaterThan(0);
    expect(decoyRequests.every(req => req.authorization === null)).toBe(true);
    expect(readStubLog(decoyPort === "ops" ? httpLog : opsLog).every(req => req.authorization === null)).toBe(true);
    expect(children.every((child) => child.exitCode === null && child.killed === false)).toBe(true);
  }, 40_000);

  test.skipIf(!operationsFixtureSupported)("a PID-file listener reaches the operations 401 after authenticated health", async () => {
    scratch = mkdtempSync(join(tmpdir(), "flair-1749-"));
    const home = join(scratch, "home");
    const dataDir = join(scratch, "data");
    const keysDir = join(scratch, "keys");
    const logPath = join(scratch, "requests.log");
    mkdirSync(home);
    mkdirSync(dataDir);
    chmodSync(dataDir, 0o700);
    mkdirSync(keysDir);
    writeFileSync(join(dataDir, "harper-config.yaml"), `rootPath: ${dataDir}\n`);
    const listener = await startStub(dataDir, "both", logPath, true);
    writeFileSync(join(dataDir, "hdb.pid"), String(listener.pid), { mode: 0o600 });
    const { stdout, stderr } = await runInit([
      "--agent", "canary",
      "--port", String(listener.httpPort), "--ops-port", String(listener.opsPort),
      "--data-dir", dataDir, "--keys-dir", keysDir, "--admin-pass", "this-init-password",
      "--no-mcp", "--skip-soul", "--skip-hook", "--skip-claude-md", "--skip-smoke",
    ], isolatedEnv(home));
    expect(stdout + stderr).not.toContain("Refusing init");
    expect(stdout + stderr).toContain("Operations API insert failed (401)");
    const requests = readStubLog(logPath);
    expect(requests.some(req => req.url === "/Health" && req.authorization !== null)).toBe(true);
    expect(requests.some(req => req.method === "POST" && req.authorization !== null)).toBe(true);
  }, 40_000);

  test("self-started seed keeps today's credential 401 hint", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = loginFailedFetch();
    try {
      await seedAgentViaOpsApi(19925, "canary", "pubkey", "admin", "this-init-password");
      throw new Error("expected seed to throw");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain("Operations API insert failed (401)");
      expect(msg).toContain("Login failed");
      expect(msg).toContain("wrong password");
      expect(msg).toContain("wrong username");
      expect(msg).toContain("--admin-pass");
      expect(msg).not.toContain("this-init-password");
      expect(msg).not.toContain("a process not attributed to this data directory's instance");
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("operations 401 with an injected stable PID gives a credential remedy", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = loginFailedFetch();
    const listener: OccupiedHarperListener = {
      port: 19925,
      pids: [42],
      dataDirs: ["/var/stale-harper"],
    };
    try {
      await seedAgentViaOpsApi(19925, "canary", "pubkey", "admin", "this-init-password", {
        before: listener,
        reread: () => listener,
      });
      throw new Error("expected seed to throw");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain("Operations API insert failed (401)");
      expect(msg).toContain("Login failed");
      expect(msg).toContain("pid 42");
      expect(msg).toContain("check the admin password for this data directory");
      expect(msg).not.toContain("/var/stale-harper");
      expect(msg).not.toContain("kill 42");
      expect(msg).not.toContain("free the port");
      expect(msg).not.toContain("choose --port");
      expect(msg).not.toContain("flair stop");
      expect(msg).not.toContain("wrong password");
      expect(msg).not.toContain("admin credentials differ");
      expect(msg).not.toContain("this-init-password");
      expect((err as { flairFriendly?: boolean }).flairFriendly).toBe(true);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("a holder that changes during the request is not named", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = loginFailedFetch();
    const before: OccupiedHarperListener = {
      port: 19925,
      pids: [42],
      dataDirs: ["/var/before"],
    };
    const after: OccupiedHarperListener = {
      port: 19925,
      pids: [99],
      dataDirs: ["/var/after"],
    };
    try {
      await seedAgentViaOpsApi(19925, "canary", "pubkey", "admin", "this-init-password", {
        before,
        reread: () => after,
      });
      throw new Error("expected seed to throw");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain("admin authentication failed");
      expect(msg).not.toContain("pid 42");
      expect(msg).not.toContain("pid 99");
      expect(msg).not.toContain("/var/before");
      expect(msg).not.toContain("/var/after");
      expect(msg).not.toContain("flair stop");
      expect(msg).not.toMatch(/\bkill \d+/);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("several operations-port holders are not a kill list", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = loginFailedFetch();
    const many: OccupiedHarperListener = {
      port: 19925,
      pids: [42, 43],
      dataDirs: ["/var/a", "/var/b"],
    };
    try {
      await seedAgentViaOpsApi(19925, "canary", "pubkey", "admin", "this-init-password", {
        before: many,
        reread: () => many,
      });
      throw new Error("expected seed to throw");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain("admin authentication failed");
      expect(msg).not.toContain("pid 42");
      expect(msg).not.toContain("pid 43");
      expect(msg).not.toContain("kill 42");
      expect(msg).not.toContain("kill 43");
      expect(msg).not.toContain("flair stop");
      expect(msg).not.toMatch(/\bkill \d+/);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe("occupied-listener messages (flair#1749)", () => {
  test("injected empty PID lookup yields an authentication failure with no kill or flair stop", () => {
    const msg = occupiedListenerAuthFailure({
      lead: "Operations API insert failed (401): ",
      bodyText: '{"error":"Login failed"}',
      listener: { ...listenerBase, port: 19925 },
    });
    expect(msg).toContain("admin authentication failed");
    expect(msg).not.toContain("flair stop");
    expect(msg).not.toMatch(/\bkill \d+/);
    expect(msg).not.toContain("wrong password");
  });

  test("the 401 message names one stable holder and does not offer flair stop", () => {
    const msg = occupiedListenerAuthFailure({
      lead: "Operations API insert failed (401): ",
      bodyText: "Login failed",
      listener: { port: 19925, pids: [42], dataDirs: ["/var/still-there"] },
    });
    expect(msg).not.toContain("flair stop");
    expect(msg).toContain("pid 42");
    expect(msg).toContain("check the admin password for this data directory");
    expect(msg).not.toContain("kill 42");
    expect(msg).not.toContain("free the port");
  });

  test("injected changing or multiple PIDs are omitted", () => {
    const changed = stableAnsweredHolder(
      { port: 19925, pids: [111], dataDirs: ["/old"] },
      { port: 19925, pids: [222], dataDirs: ["/new"] },
    );
    expect(changed.pids).toEqual([]);
    const many = stableAnsweredHolder(
      { port: 19925, pids: [111, 222], dataDirs: ["/a"] },
      { port: 19925, pids: [111, 222], dataDirs: ["/a"] },
    );
    expect(many.pids).toEqual([]);
    const stable = stableAnsweredHolder(
      { port: 19925, pids: [222], dataDirs: ["/data"] },
      { port: 19925, pids: [222], dataDirs: ["/data"] },
    );
    expect(stable.pids).toEqual([222]);
    const msg = occupiedListenerAuthFailure({
      lead: "Operations API insert failed (401): ",
      bodyText: "Login failed",
      listener: changed,
    });
    expect(msg).toContain("admin authentication failed");
    expect(msg).not.toContain("pid 111");
    expect(msg).not.toContain("kill 111");
    expect(msg).not.toMatch(/\bkill \d+/);
  });

  test("the remedy uses the injected PID and directory without flair stop", () => {
    const msg = foreignOccupiedListenerDetail(
      { port: 19926, pids: [7], dataDirs: ["/data/other"] },
    );
    expect(msg).toContain("kill 7");
    expect(msg).not.toContain("flair stop");
    expect(msg).not.toContain("will not match");
  });

  test("several pids are not named and are not a kill list", () => {
    const msg = occupiedListenerAuthFailure({
      lead: "Operations API insert failed (401): ",
      bodyText: "Login failed",
      listener: { port: 19925, pids: [7, 8], dataDirs: ["/data/other"] },
    });
    expect(msg).not.toMatch(/\bkill \d+/);
  });
});

describe("init ROOTPATH lookup (flair#1749)", () => {
  test("linux environ keeps a ROOTPATH that contains a space", () => {
    const path = "/Users/John Doe/.flair";
    const raw = `PATH=/usr/bin\0ROOTPATH=${path}\0HOME=/Users/John Doe\0`;
    const rootPath = extractRootPath(parseNullSeparatedEnviron(raw));
    expect(rootPath).toBe(path);
    const read = listenerRootPathOnPlatform("linux", () => ({ rootPath, environReadable: true }));
    expect(read.rootPath).toBe(path);
  });

  test("an unavailable ROOTPATH lookup is not a foreign directory", () => {
    let linuxRead = false;
    const darwin = listenerRootPathOnPlatform("darwin", () => {
      linuxRead = true;
      return { rootPath: "/should-not-be-used", environReadable: true };
    });
    expect(linuxRead).toBe(false);
    expect(darwin).toEqual({ rootPath: null, environReadable: false });
    const listener = listenerFromLookup(19926, {
      pids: () => [9],
      rootPath: () => darwin,
    });
    expect(listener.dataDirs).toEqual([]);
    const src = readFileSync(join(import.meta.dir, "..", "..", "src", "lib", "init-listener-environ.ts"), "utf-8");
    expect(src).not.toContain("execFileSync");
    expect(src).not.toMatch(/["']ps["']/);
  });

  test("sidecar recovery does not use init's listener lookup", () => {
    const cliSrc = readFileSync(join(import.meta.dir, "..", "..", "src", "cli.ts"), "utf-8");
    const rootPathFn = cliSrc.slice(
      cliSrc.indexOf("function readProcessRootPath"),
      cliSrc.indexOf("let occupiedListenerLookupForTests"),
    );
    expect(rootPathFn).toContain("/proc/");
    expect(rootPathFn).not.toContain("darwin");
    expect(rootPathFn).not.toContain("ps");
    const occupiedFn = cliSrc.slice(
      cliSrc.indexOf("function readOccupiedListener"),
      cliSrc.indexOf("function inspectServingFlairPackage"),
    );
    expect(occupiedFn).toContain("readInitListenerRootPath");
    expect(occupiedFn).not.toContain("defaultDataDir()");
    expect(occupiedFn).not.toContain("readProcessRootPath");
    expect(occupiedFn).not.toContain("flair stop");
    const afterGather = cliSrc.slice(cliSrc.indexOf("async function gatherDaemonEvidence"));
    expect(afterGather).toContain("readProcessRootPath");
    expect(afterGather).not.toContain("readInitListenerRootPath");
  });
});
