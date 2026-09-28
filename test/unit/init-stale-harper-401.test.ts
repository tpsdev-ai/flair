/**
 * flair#1749 — `flair init` and a Harper it did not start.
 *
 * The pre-auth check is one read. It names a different data directory only
 * when that read returned one, and the stub's health request carries no
 * Authorization. The lookup in those tests is injected, so they do not call
 * the host's lsof, /proc, or ps. An operations-port 401 is a different
 * check: the same sole PID before the insert and after the 401. These
 * messages do not offer `flair stop`. The self-started seed keeps today's
 * credential hint. Init does not signal a process it did not start.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { program, seedAgentViaOpsApi, setOccupiedListenerLookupForTests } from "../../src/cli.js";
import { flairDataDir } from "../../src/lib/flair-paths.js";
import { listenerRootPathOnPlatform } from "../../src/lib/init-listener-environ.js";
import { parseNullSeparatedEnviron, extractRootPath } from "../../src/lib/daemon-liveness.js";
import {
  describeOccupiedListener,
  DIFFERENT_DIR_DOES_NOT_PROVE_PASSWORD,
  foreignOccupiedListenerDetail,
  HTTP_HOLDER_DID_NOT_NECESSARILY_REJECT,
  listenerFromLookup,
  occupiedListenerAuthFailure,
  stableAnsweredHolder,
  staleHarperBeforeAuthNotice,
  type OccupiedHarperListener,
} from "../../src/lib/init-occupied-listener.js";
import { childOverranDeadline, cliLeg } from "../helpers/child-deadline.js";

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

function startStub(rootPath: string, role: "both" | "http" | "ops", logPath: string): Promise<StubReady> {
  const scriptPath = join(scratch!, `stub-${role}.js`);
  writeFileSync(scriptPath, STUB_SCRIPT);
  const child = spawn(process.execPath, [scriptPath], {
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
      timeout: CHILD_DEADLINE_MS,
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

    expect(output).toContain("Harper already running");
    expect(output).toContain(DIFFERENT_DIR_DOES_NOT_PROVE_PASSWORD);
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

    expect(output).toContain("already answering on port");
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
    // At 8baa0a85, defaultDataDir()'s hdb.pid and flair-daemon.json both naming
    // a pid in the listener list set flairStopApplies, and this refusal printed
    // `flair stop`. This assertion fails on that commit. A non-default
    // directory never produced the offer, so the cases above would pass there.
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

    expect(output).toContain("already answering on port");
    expect(output).toContain(defaultDir);
    expect(output).toContain(`pid ${listener.pid}`);
    expect(output).toContain(`kill ${listener.pid}`);
    expect(output).not.toContain("flair stop");
    expectHealthLoggedThenNoAuthorization(requests);
    expect(children[0]?.exitCode).toBe(null);
  }, CASE_BUDGET_MS);

  test("distinct port holders: the operations 401 does not name the HTTP pid", async () => {
    scratch = mkdtempSync(join(tmpdir(), "flair-1749-"));
    const home = join(scratch, "home");
    const dataDir = join(scratch, "data");
    const keysDir = join(scratch, "keys");
    const httpLog = join(scratch, "http.log");
    const opsLog = join(scratch, "ops.log");
    mkdirSync(home, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(keysDir, { recursive: true });

    // HTTP listener's ROOTPATH is this init's data dir, so it is not a
    // foreign directory and init continues to the operations insert.
    const httpHolder = await startStub(dataDir, "http", httpLog);
    const opsHolder = await startStub(join(scratch, "ops-harper"), "ops", opsLog);
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
    expect(output).toContain("Operations API insert failed (401)");
    expect(output).toContain(HTTP_HOLDER_DID_NOT_NECESSARILY_REJECT);
    expect(output).toContain(DIFFERENT_DIR_DOES_NOT_PROVE_PASSWORD);
    expect(output).not.toContain("wrong password");
    expect(output).not.toContain("wrong username");
    expect(output).not.toContain("admin credentials differ");
    expect(output).not.toContain(`pid ${httpHolder.pid}`);
    expect(output).not.toContain(`kill ${httpHolder.pid}`);
    // The operations holder is named only when verified on that port.
    if (output.includes(`pid ${opsHolder.pid}`)) {
      expect(output).toContain(`kill ${opsHolder.pid}`);
    } else {
      expect(output).toContain("a Harper instance this init did not start");
      expect(output).not.toMatch(/\bkill \d+/);
    }
    if (process.platform === "linux" || process.platform === "darwin") {
      expect(output).toContain(`pid ${opsHolder.pid}`);
      expect(output).toContain(`kill ${opsHolder.pid}`);
    }
    expect(httpHolder.pid).not.toBe(opsHolder.pid);
    expect(children.every((child) => child.exitCode === null && child.killed === false)).toBe(true);
  }, CASE_BUDGET_MS);

  test("self-started seed keeps today's credential 401 hint", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => new Response('{"error":"Login failed"}', { status: 401 })) as typeof fetch;
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
      expect(msg).not.toContain("a Harper instance this init did not start");
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("seed against a verified operations holder does not blame credentials", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => new Response('{"error":"Login failed"}', { status: 401 })) as typeof fetch;
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
      expect(msg).toContain("/var/stale-harper");
      expect(msg).toContain(DIFFERENT_DIR_DOES_NOT_PROVE_PASSWORD);
      expect(msg).toContain(HTTP_HOLDER_DID_NOT_NECESSARILY_REJECT);
      expect(msg).toContain("kill 42");
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
    globalThis.fetch = (async () => new Response('{"error":"Login failed"}', { status: 401 })) as typeof fetch;
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
      expect(msg).toContain("a Harper instance this init did not start");
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
    globalThis.fetch = (async () => new Response('{"error":"Login failed"}', { status: 401 })) as typeof fetch;
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
      expect(msg).toContain("a Harper instance this init did not start");
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
  test("nothing readable is the unattributed fallback, with no kill and no flair stop", () => {
    const msg = occupiedListenerAuthFailure({
      lead: "Operations API insert failed (401): ",
      bodyText: '{"error":"Login failed"}',
      listener: { ...listenerBase, port: 19925 },
    });
    expect(msg).toContain("a Harper instance this init did not start");
    expect(msg).toContain(DIFFERENT_DIR_DOES_NOT_PROVE_PASSWORD);
    expect(msg).toContain(HTTP_HOLDER_DID_NOT_NECESSARILY_REJECT);
    expect(msg).not.toContain("flair stop");
    expect(msg).not.toMatch(/\bkill \d+/);
    expect(msg).not.toContain("wrong password");
    expect(describeOccupiedListener({ pids: [], dataDirs: [] })).toBe(
      "a Harper instance this init did not start",
    );
  });

  test("the 401 message names one stable holder and does not offer flair stop", () => {
    const msg = occupiedListenerAuthFailure({
      lead: "Operations API insert failed (401): ",
      bodyText: "Login failed",
      listener: { port: 19925, pids: [42], dataDirs: ["/var/still-there"] },
    });
    expect(msg).not.toContain("flair stop");
    expect(msg).toContain("kill 42");
  });

  test("a holder change and several holders stay unattributed", () => {
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
    expect(msg).toContain("a Harper instance this init did not start");
    expect(msg).not.toContain("pid 111");
    expect(msg).not.toContain("kill 111");
    expect(msg).not.toMatch(/\bkill \d+/);
  });

  test("a matching data directory is not announced before auth", () => {
    const notice = staleHarperBeforeAuthNotice("/data/this-init", {
      ...listenerBase,
      pids: [7],
      dataDirs: ["/data/this-init"],
    });
    expect(notice).toBe(null);
  });

  test("a different data directory is named before auth and does not claim the passwords differ", () => {
    const notice = staleHarperBeforeAuthNotice("/data/this-init", {
      port: 19926,
      pids: [7],
      dataDirs: ["/data/other"],
    });
    expect(notice).toContain("pid 7");
    expect(notice).toContain("/data/other");
    expect(notice).toContain("/data/this-init");
    expect(notice).toContain(DIFFERENT_DIR_DOES_NOT_PROVE_PASSWORD);
    expect(notice).toContain("will not send its admin password");
    expect(notice).toContain("kill 7");
    expect(notice).not.toContain("flair stop");
    expect(notice).not.toContain("will not match");
    expect(notice).not.toContain("wrong password");
  });

  test("the up-front refusal qualifies a foreign directory and does not offer flair stop", () => {
    const msg = foreignOccupiedListenerDetail(
      { port: 19926, pids: [7], dataDirs: ["/data/other"] },
      "/data/this-init",
    );
    expect(msg).toContain("pid 7");
    expect(msg).toContain(DIFFERENT_DIR_DOES_NOT_PROVE_PASSWORD);
    expect(msg).toContain("kill 7");
    expect(msg).not.toContain("flair stop");
    expect(msg).not.toContain("will not match");
  });

  test("several pids are not named and are not a kill list", () => {
    const who = describeOccupiedListener({ pids: [7, 8], dataDirs: ["/data/other"] });
    expect(who).not.toContain("pid 7");
    expect(who).not.toContain("pid 8");
    expect(who).toContain("a Harper instance this init did not start");
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
    expect(staleHarperBeforeAuthNotice(path, {
      port: 19926,
      pids: [7],
      dataDirs: [read.rootPath!],
    })).toBe(null);
  });

  test("an injected readable ROOTPATH is the pre-auth directory", () => {
    const listener = listenerFromLookup(19926, {
      pids: () => [9],
      rootPath: () => ({ rootPath: "/data/stale", environReadable: true }),
    });
    const notice = staleHarperBeforeAuthNotice("/data/this-init", listener);
    expect(notice).toContain("/data/stale");
    expect(notice).toContain("pid 9");
    expect(notice).toContain("kill 9");
    expect(notice).not.toContain("flair stop");
    expect(notice).not.toContain("a Harper instance this init did not start");
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
    expect(staleHarperBeforeAuthNotice("/data/this-init", listener)).toBe(null);
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
