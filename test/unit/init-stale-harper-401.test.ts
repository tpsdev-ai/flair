/**
 * flair#1749 — `flair init` skips starting Harper when the port already
 * answers, then a later operations-API 401 blames `--admin-pass`. The
 * password is the one this init has; the process on the port is a different
 * Harper. The 401 must name that listener and how to stop it, and must not
 * say the credentials are wrong.
 *
 * Init must not kill or restart a process it did not start. The stub is
 * still alive after init exits; the message prints `kill`, it does not run it.
 *
 * The self-started case (no occupied-listener context on the seed) keeps
 * today's credential hint.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedAgentViaOpsApi } from "../../src/cli.js";
import {
  describeOccupiedListener,
  foreignOccupiedListenerDetail,
  occupiedListenerAuthFailure,
  staleHarperBeforeAuthNotice,
  type OccupiedHarperListener,
} from "../../src/lib/init-occupied-listener.js";
import { childOverranDeadline, cliLeg } from "../helpers/child-deadline.js";

const CLI_PATH = join(import.meta.dir, "..", "..", "src", "cli.ts");
const CHILD_DEADLINE_MS = 30_000;
const CASE_BUDGET_MS = 40_000;

const STUB_SCRIPT = `
const http = require("http");
function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}
(async () => {
  const health = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
  });
  const ops = await listen((_req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Login failed" }));
  });
  process.stdout.write(JSON.stringify({
    httpPort: health.address().port,
    opsPort: ops.address().port,
    pid: process.pid,
  }) + "\\n");
})();
`;

let scratch: string | null = null;
let stub: ChildProcess | null = null;

afterEach(() => {
  if (stub && stub.exitCode === null && !stub.killed) stub.kill("SIGTERM");
  stub = null;
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

function startStub(rootPath: string): Promise<{ httpPort: number; opsPort: number; pid: number }> {
  const scriptPath = join(scratch!, "stub.js");
  writeFileSync(scriptPath, STUB_SCRIPT);
  const child = spawn(process.execPath, [scriptPath], {
    env: { ...process.env, ROOTPATH: rootPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  stub = child;
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`stub did not become ready: ${buf}`)), 5_000);
    child.stdout?.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      clearTimeout(timer);
      resolve(JSON.parse(buf.slice(0, nl)));
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`stub exited before ready (${code}): ${buf}`));
    });
  });
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

describe("flair#1749 — init 401 against a Harper this init did not start", () => {
  test("occupied port: the 401 names the listener and the kill, not the credentials", async () => {
    scratch = mkdtempSync(join(tmpdir(), "flair-1749-"));
    const home = join(scratch, "home");
    const dataDir = join(scratch, "data");
    const staleDataDir = join(scratch, "stale-harper");
    const keysDir = join(scratch, "keys");
    mkdirSync(home, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(staleDataDir, { recursive: true });
    mkdirSync(keysDir, { recursive: true });

    const listener = await startStub(staleDataDir);
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
    ], env);
    const output = stdout + stderr;

    expect(code).not.toBe(0);
    expect(output).toContain("Harper already running");
    expect(output).toContain(String(listener.pid));
    expect(output).toContain(staleDataDir);
    expect(output).toContain("admin credentials differ");
    expect(output).toContain(`kill ${listener.pid}`);
    expect(output).toContain("flair stop");
    expect(output).toContain("admin password will not match");
    // The server body may still say "Login failed". The hint must not.
    expect(output).not.toContain("wrong password");
    expect(output).not.toContain("wrong username");
    expect(output).not.toContain("rejected the admin credentials");
    expect(output).not.toMatch(/credentials are wrong/i);
    expect(output).not.toContain("this-init-password");
    // Hazard: init prints the kill; it does not perform it.
    expect(stub?.exitCode).toBe(null);
    expect(stub?.killed).toBe(false);
  }, CASE_BUDGET_MS);

  test("no admin password: the refusal names the listener and the kill, not the credentials", async () => {
    scratch = mkdtempSync(join(tmpdir(), "flair-1749-"));
    const home = join(scratch, "home");
    const dataDir = join(scratch, "data");
    const staleDataDir = join(scratch, "stale-harper");
    mkdirSync(home, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(staleDataDir, { recursive: true });

    const listener = await startStub(staleDataDir);
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

    const { code, stdout, stderr } = await runInit([
      "--agent", "canary",
      "--port", String(listener.httpPort),
      "--ops-port", String(listener.opsPort),
      "--data-dir", dataDir,
      "--no-mcp",
      "--skip-soul",
    ], env);
    const output = stdout + stderr;

    expect(code).not.toBe(0);
    expect(output).toContain("already answering on port");
    expect(output).toContain("flair stop");
    expect(output).toContain(String(listener.pid));
    expect(output).toContain(staleDataDir);
    expect(output).toContain(`kill ${listener.pid}`);
    expect(output).toContain("admin password will not match");
    expect(output).not.toContain("wrong password");
    expect(output).not.toContain("wrong username");
    expect(output).not.toContain("Operations API insert failed");
    expect(stub?.exitCode).toBe(null);
    expect(stub?.killed).toBe(false);
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

  test("seed against an occupied listener names it and does not blame credentials", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => new Response('{"error":"Login failed"}', { status: 401 })) as typeof fetch;
    const listener: OccupiedHarperListener = { port: 19926, pids: [42], dataDirs: ["/var/stale-harper"] };
    try {
      await seedAgentViaOpsApi(19925, "canary", "pubkey", "admin", "this-init-password", listener);
      throw new Error("expected seed to throw");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain("Operations API insert failed (401)");
      expect(msg).toContain("Login failed");
      expect(msg).toContain("pid 42");
      expect(msg).toContain("/var/stale-harper");
      expect(msg).toContain("admin credentials differ");
      expect(msg).toContain("kill 42");
      expect(msg).toContain("flair stop");
      expect(msg).toContain("flair init --data-dir /var/stale-harper");
      expect(msg).not.toContain("wrong password");
      expect(msg).not.toContain("wrong username");
      expect(msg).not.toContain("rejected the admin credentials");
      expect(msg).not.toContain("this-init-password");
      expect((err as { flairFriendly?: boolean }).flairFriendly).toBe(true);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe("occupied-listener messages (flair#1749)", () => {
  test("nothing readable falls back to the unnamed instance, with flair stop and no kill", () => {
    const msg = occupiedListenerAuthFailure({
      lead: "Operations API insert failed (401): ",
      bodyText: '{"error":"Login failed"}',
      listener: { port: 19926, pids: [], dataDirs: [] },
    });
    expect(msg).toContain("a Harper instance this init did not start");
    expect(msg).toContain("admin credentials differ");
    expect(msg).toContain("flair stop");
    expect(msg).not.toContain("kill ");
    expect(msg).not.toContain("wrong password");
    expect(describeOccupiedListener({ pids: [], dataDirs: [] })).toBe(
      "a Harper instance this init did not start",
    );
  });

  test("a matching data directory is not announced before auth", () => {
    const notice = staleHarperBeforeAuthNotice("/data/this-init", {
      port: 19926,
      pids: [7],
      dataDirs: ["/data/this-init"],
    });
    expect(notice).toBe(null);
  });

  test("a different data directory is named before auth, with the kill and no signal", () => {
    const notice = staleHarperBeforeAuthNotice("/data/this-init", {
      port: 19926,
      pids: [7],
      dataDirs: ["/data/other"],
    });
    expect(notice).toContain("pid 7");
    expect(notice).toContain("/data/other");
    expect(notice).toContain("/data/this-init");
    expect(notice).toContain("admin password will not match");
    expect(notice).toContain("kill 7");
    expect(notice).toContain("will not stop a process it did not start");
    expect(notice).not.toContain("wrong password");
  });
});
