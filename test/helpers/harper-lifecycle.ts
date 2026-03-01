import { spawn, ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const getRandomPort = () => 10000 + Math.floor(Math.random() * 50000);
const STARTUP_TIMEOUT_MS = 45_000;

// Use harperdb from node_modules — works on any system with Node
const HARPER_BIN = join(process.cwd(), "node_modules", "harperdb", "bin", "harper.js");

export interface HarperInstance {
  httpURL: string;
  opsURL: string;
  installDir: string;
  process: ChildProcess;
  admin: { username: string; password: string };
}

export async function startHarper(): Promise<HarperInstance> {
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

  // Install: creates data dirs in ROOTPATH (no global state)
  const install = spawn(process.execPath, [HARPER_BIN, "install"], { cwd: process.cwd(), env });
  await new Promise<void>((resolve, reject) => {
    let output = "";
    install.stdout?.on("data", (d: Buffer) => output += d.toString());
    install.stderr?.on("data", (d: Buffer) => output += d.toString());
    install.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`Harper install exited ${code}: ${output}`)));
    install.on("error", reject);
    setTimeout(() => { install.kill(); reject(new Error(`Harper install timed out: ${output}`)); }, 20_000);
  });

  // Start dev mode with our component
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

  // Wait for HTTP readiness
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(`${httpURL}/Health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) break;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }

  return { httpURL, opsURL, installDir, process: proc, admin: { username: "admin", password: "test123" } };
}

export async function stopHarper(inst: HarperInstance): Promise<void> {
  inst.process.kill();
  await new Promise<void>(r => {
    inst.process.on("exit", r);
    setTimeout(() => { try { inst.process.kill("SIGKILL"); } catch {} r(); }, 3000);
  });
  await rm(inst.installDir, { recursive: true, force: true, maxRetries: 4 });
}
