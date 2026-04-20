import { spawn, ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const getRandomPort = () => 10000 + Math.floor(Math.random() * 50000);
const STARTUP_TIMEOUT_MS = 45_000;

// Use @harperfast/harper from node_modules — spawned under node (not bun)
// because bun 1.3.x doesn't support uv_ip6_addr which Harper's NAPI modules need.
const HARPER_BIN = join(process.cwd(), "node_modules", "@harperfast", "harper", "dist", "bin", "harper.js");
const NODE_BIN = process.env.NODE_BIN ?? "node";

// External service mode: set HARPER_HTTP_URL (and optionally HARPER_OPS_URL) to
// skip the local spawn and connect to an already-running Harper instance (e.g. Docker).
const HARPER_HTTP_URL = process.env.HARPER_HTTP_URL;
const HARPER_OPS_URL_ENV = process.env.HARPER_OPS_URL;
const HARPER_ADMIN_USER = process.env.HARPER_ADMIN_USER ?? "admin";
const HARPER_ADMIN_PASS = process.env.HARPER_ADMIN_PASS ?? "test123";

export interface HarperInstance {
  httpURL: string;
  opsURL: string;
  installDir: string;
  process: ChildProcess | null;
  admin: { username: string; password: string };
  external: boolean;
}

async function waitForHealth(httpURL: string, timeoutMs = 60_000): Promise<void> {
  const url = `${httpURL}/health`;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  console.log(`[harper-lifecycle] waitForHealth: polling ${url} (timeout ${timeoutMs}ms)`);
  while (Date.now() < deadline) {
    attempt++;
    const elapsed = Date.now() - (deadline - timeoutMs);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      console.log(`[harper-lifecycle] waitForHealth: attempt ${attempt} → HTTP ${res.status} (${elapsed}ms elapsed)`);
      if (res.status > 0) {
        console.log(`[harper-lifecycle] waitForHealth: server alive after ${elapsed}ms`);
        return;
      }
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      console.log(`[harper-lifecycle] waitForHealth: attempt ${attempt} → error: ${msg} (${elapsed}ms elapsed)`);
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`Harper at ${httpURL} did not respond within ${timeoutMs}ms (${attempt} attempts)`);
}

export async function startHarper(): Promise<HarperInstance> {
  // ── External mode: connect to Docker service ─────────────────────────────
  if (HARPER_HTTP_URL) {
    const httpURL = HARPER_HTTP_URL;
    const opsURL = HARPER_OPS_URL_ENV ?? httpURL.replace(/:(\d+)($|\/)/, (_, port, rest) => `:${Number(port) - 1}${rest}`);
    console.log(`[harper-lifecycle] external mode: httpURL=${httpURL} opsURL=${opsURL} user=${HARPER_ADMIN_USER}`);
    await waitForHealth(httpURL, 120_000); // allow time for Docker install + start
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
    HOME: installDir,               // isolate from system Harper install (~/.harperdb)
    DEFAULTS_MODE: "dev",
    HDB_ADMIN_USERNAME: "admin",
    HDB_ADMIN_PASSWORD: "test123",
    THREADS_COUNT: "1",
    NODE_HOSTNAME: "127.0.0.1",     // IPv4 only — avoids bun uv_ip6_addr panic
    OPERATIONSAPI_NETWORK_PORT: String(opsPort),
    HTTP_PORT: String(httpPort),
  };

  const install = spawn(NODE_BIN, [HARPER_BIN, "install"], { cwd: process.cwd(), env });
  await new Promise<void>((resolve, reject) => {
    let output = "";
    install.stdout?.on("data", (d: Buffer) => output += d.toString());
    install.stderr?.on("data", (d: Buffer) => output += d.toString());
    install.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`Harper install exited ${code}: ${output}`)));
    install.on("error", reject);
    setTimeout(() => { install.kill(); reject(new Error(`Harper install timed out: ${output}`)); }, 20_000);
  });

  const proc = spawn(NODE_BIN, [HARPER_BIN, "dev", "."], { cwd: process.cwd(), env });

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
  // Poll both ports. Harper binds httpURL and opsURL at different moments during
  // startup; callers hit opsURL immediately (admin seed), so returning as soon
  // as httpURL answers was racy — agent-journey intermittently ECONNREFUSED on
  // opsURL even though httpURL was already serving 404s.
  await Promise.all([waitForHealth(httpURL), waitForHealth(opsURL)]);

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
