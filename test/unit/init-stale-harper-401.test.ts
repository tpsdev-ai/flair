/**
 * flair#1749 — `flair init` and a Harper it did not start.
 *
 * A different data directory is identified before any authenticated request,
 * and that stub sees no Authorization header. An operations-port 401 names
 * only a process verified to hold that port: a different process on the HTTP
 * port is not a kill target. ROOTPATH is read on Linux (`/proc`) and, best
 * effort, on macOS (`ps -Eww`); when it cannot be read the documented
 * fallback is "a Harper instance this init did not start". `flair stop` is
 * offered only when the data directory still records the process.
 *
 * The self-started seed keeps today's credential hint. Init does not signal
 * a process it did not start.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedAgentViaOpsApi } from "../../src/cli.js";
import {
  describeOccupiedListener,
  DIFFERENT_DIR_DOES_NOT_PROVE_PASSWORD,
  flairStopCanIdentify,
  foreignOccupiedListenerDetail,
  HTTP_HOLDER_DID_NOT_NECESSARILY_REJECT,
  occupiedListenerAuthFailure,
  pidsVerifiedOnAnsweredPort,
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

/**
 * Linux reads ROOTPATH from /proc. macOS uses ps -Eww, which can fail or
 * truncate. Either the directory is named or the documented fallback is.
 */
function expectDataDirOrFallback(output: string, dataDir: string): void {
  if (output.includes(dataDir)) return;
  expect(output).toContain("a Harper instance this init did not start");
}

function expectVerifiedPidOrFallback(output: string, pid: number): void {
  if (output.includes(`pid ${pid}`)) {
    expect(output).toContain(`kill ${pid}`);
    return;
  }
  expect(output).toContain("a Harper instance this init did not start");
  expect(output).not.toMatch(/\bkill \d+/);
}

const listenerBase = {
  port: 19926,
  pids: [] as number[],
  dataDirs: [] as string[],
  flairStopApplies: false,
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
    const { code, stdout, stderr } = await runInit([
      "--agent", "canary",
      "--port", String(listener.httpPort),
      "--ops-port", String(listener.opsPort),
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
    const requests = readStubLog(logPath);

    expect(code).not.toBe(0);
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
    expectDataDirOrFallback(output, staleDataDir);
    expectVerifiedPidOrFallback(output, listener.pid);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((req) => req.authorization === null)).toBe(true);
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
    const { code, stdout, stderr } = await runInit([
      "--agent", "canary",
      "--port", String(listener.httpPort),
      "--ops-port", String(listener.opsPort),
      "--data-dir", dataDir,
      "--no-mcp",
      "--skip-soul",
    ], isolatedEnv(home));
    const output = stdout + stderr;
    const requests = readStubLog(logPath);

    expect(code).not.toBe(0);
    expect(output).toContain("already answering on port");
    expect(output).not.toContain("flair stop");
    expect(output).not.toContain("wrong password");
    expect(output).not.toContain("Operations API insert failed");
    expect(output).not.toContain("admin password will not match");
    expectDataDirOrFallback(output, staleDataDir);
    expectVerifiedPidOrFallback(output, listener.pid);
    expect(requests.every((req) => req.authorization === null)).toBe(true);
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
      flairStopApplies: false,
    };
    try {
      await seedAgentViaOpsApi(19925, "canary", "pubkey", "admin", "this-init-password", listener);
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

  test("flair stop is offered only when the data directory still records the pid", () => {
    const withStop = occupiedListenerAuthFailure({
      lead: "Operations API insert failed (401): ",
      bodyText: "Login failed",
      listener: { port: 19925, pids: [42], dataDirs: ["/var/still-there"], flairStopApplies: true },
    });
    expect(withStop).toContain("flair stop");
    expect(withStop).toContain("kill 42");
    const deleted = occupiedListenerAuthFailure({
      lead: "Operations API insert failed (401): ",
      bodyText: "Login failed",
      listener: { port: 19925, pids: [42], dataDirs: ["/var/deleted"], flairStopApplies: false },
    });
    expect(deleted).not.toContain("flair stop");
    expect(deleted).toContain("kill 42");
    expect(flairStopCanIdentify({ recordedPid: 42, sidecarPid: 42, listenerPids: [42] })).toBe(true);
    expect(flairStopCanIdentify({ recordedPid: null, sidecarPid: null, listenerPids: [42] })).toBe(false);
    expect(flairStopCanIdentify({ recordedPid: 42, sidecarPid: 99, listenerPids: [42] })).toBe(false);
  });

  test("a pid that does not hold the port that answered is not named", () => {
    expect(pidsVerifiedOnAnsweredPort([111], [222])).toEqual([]);
    expect(pidsVerifiedOnAnsweredPort([222], [222])).toEqual([222]);
    expect(pidsVerifiedOnAnsweredPort([111, 222], null)).toEqual([]);
    const msg = occupiedListenerAuthFailure({
      lead: "Operations API insert failed (401): ",
      bodyText: "Login failed",
      listener: { port: 19925, pids: pidsVerifiedOnAnsweredPort([111], [222]), dataDirs: [], flairStopApplies: false },
    });
    expect(msg).toContain("a Harper instance this init did not start");
    expect(msg).not.toContain("pid 111");
    expect(msg).not.toContain("kill 111");
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
      flairStopApplies: false,
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

  test("the up-front refusal qualifies a foreign directory and omits flair stop when the directory is gone", () => {
    const msg = foreignOccupiedListenerDetail(
      { port: 19926, pids: [7], dataDirs: ["/data/other"], flairStopApplies: false },
      "/data/this-init",
    );
    expect(msg).toContain("pid 7");
    expect(msg).toContain(DIFFERENT_DIR_DOES_NOT_PROVE_PASSWORD);
    expect(msg).toContain("kill 7");
    expect(msg).not.toContain("flair stop");
    expect(msg).not.toContain("will not match");
  });
});
