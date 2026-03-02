import { spawn, ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const getRandomPort = () => 10000 + Math.floor(Math.random() * 50000);
const STARTUP_TIMEOUT_MS = 45_000;

// Use harperdb from node_modules — works on any system with Node
const HARPER_BIN = join(process.cwd(), "node_modules", "harperdb", "bin", "harper.js");

// External service mode: set HARPER_HTTP_URL (and optionally HARPER_OPS_URL) to
// skip the local spawn and connect to an already-running Harper instance (e.g. Docker).
const HARPER_HTTP_URL = process.env.HARPER_HTTP_URL;
const HARPER_OPS_URL_ENV = process.env.HARPER_OPS_URL;
const HARPER_ADMIN_USER = process.env.HARPER_ADMIN_USER ?? "admin";
const HARPER_ADMIN_PASS = process.env.HARPER_ADMIN_PASS ?? "admin123";

export interface HarperInstance {
  httpURL: string;
  opsURL: string;
  installDir: string;
  process: ChildProcess | null;
  admin: { username: string; password: string };
  external: boolean;
}

async function waitForHealth(httpURL: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${httpURL}/Health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`Harper at ${httpURL} did not become healthy within ${timeoutMs}ms`);
}

async function ensureTables(opsURL: string, authHeader: string): Promise<void> {
  const tables = ["Agent", "Memory", "Soul", "MemoryGrant"];
  for (const table of tables) {
    try {
      await fetch(opsURL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({ operation: "create_table", table, schema: "data" }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {}
  }
}

export async function startHarper(): Promise<HarperInstance> {
  // ── External mode: connect to Docker service ─────────────────────────────
  if (HARPER_HTTP_URL) {
    const httpURL = HARPER_HTTP_URL;
    const opsURL = HARPER_OPS_URL_ENV ?? httpURL.replace(/:(\d+)($|\/)/, (_, port, rest) => `:${Number(port) - 1}${rest}`);
    const authHeader = "Basic " + btoa(`${HARPER_ADMIN_USER}:${HARPER_ADMIN_PASS}`);

    await waitForHealth(httpURL, 150_000);
    await ensureTables(opsURL, authHeader);

    return {
      httpURL,
      opsURL,
      installDir: "",
      process: null,
      admin: { username: HARPER_ADMIN_USER, password: HARPER_ADMIN_PASS },
      external: true,
    };
  }

  // ── Local mode: spawn Harper from node_modules ────────────────────────────
  const installDir = await mkdtemp(join(tmpdir(), "flair-test-"));
  const httpPort = getRandomPort();
  const opsPort = httpPort + 1;

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    ROOTPATH: installDir,
    DEFAULTS_MODE: "dev",
    HDB_ADMIN_USERNAME: "admin",
    HDB_ADMIN_PASSWORD: "test123",
    THREADS_COUNT: "1",
    NODE_HOSTNAME: "localhost",
    OPERATIONSAPI_NETWORK_PORT: String(opsPort),
    HTTP_PORT: String(httpPort),
  };

  const install = spawn(process.execPath, [HARPER_BIN, "install"], { cwd: process.cwd(), env });
  await new Promise<void>((resolve, reject) => {
    let output = "";
    install.stdout?.on("data", (d: Buffer) => output += d.toString());
    install.stderr?.on("data", (d: Buffer) => output += d.toString());
    install.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`Harper install exited ${code}: ${output}`)));
    install.on("error", reject);
    setTimeout(() => { install.kill(); reject(new Error(`Harper install timed out: ${output}`)); }, 20_000);
  });

  const proc = spawn(process.execPath, [HARPER_BIN, "dev", "."], { cwd: process.cwd(), env });

  let log = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`Harper startup timed out. Log:\n${log}`));
    }, STARTUP_TIMEOUT_MS);

    const onData = (data: Buffer) => {
      log += data.toString();
      if (log.includes("successfully started") || log.includes("listening on")) {
        clearTimeout(timer);
        resolve();
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`Harper exited ${code}. Log:\n${log}`));
    });
  });

  const httpURL = `http://127.0.0.1:${httpPort}`;
  const opsURL = `http://127.0.0.1:${opsPort}`;
  await waitForHealth(httpURL);

  return { httpURL, opsURL, installDir, process: proc, admin: { username: "admin", password: "test123" }, external: false };
}

export async function stopHarper(inst: HarperInstance): Promise<void> {
  if (inst.external) return;

  inst.process?.kill();
  await new Promise<void>(r => {
    inst.process?.on("exit", r);
    setTimeout(() => { try { inst.process?.kill("SIGKILL"); } catch {} r(); }, 3000);
  });
  if (inst.installDir) {
    await rm(inst.installDir, { recursive: true, force: true, maxRetries: 4 });
  }
}
