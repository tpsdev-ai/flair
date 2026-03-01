import { spawn, ChildProcess } from "node:child_process";
import { mkdtemp, rm, rename, stat } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

const getRandomPort = () => 10000 + Math.floor(Math.random() * 50000);
const STARTUP_TIMEOUT_MS = 45_000;
const HARPER_BIN = join(process.cwd(), "node_modules/harperdb/bin/harper.js");
const NODE_BIN = process.env.NODE24 || "/opt/homebrew/opt/node@24/bin/node";
const BOOT_PROPS = join(homedir(), ".harperdb", "hdb_boot_properties.file");
const BOOT_PROPS_BAK = BOOT_PROPS + ".test-bak";

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

  // Move existing boot props out of the way so install doesn't conflict
  const hadBootProps = existsSync(BOOT_PROPS);
  if (hadBootProps) {
    await rename(BOOT_PROPS, BOOT_PROPS_BAK);
  }

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

  try {
    // Step 1: Install
    const install = spawn(NODE_BIN, [HARPER_BIN, "install"], { cwd: process.cwd(), env });
    await new Promise<void>((resolve, reject) => {
      let output = "";
      install.stdout?.on("data", (d: Buffer) => output += d.toString());
      install.stderr?.on("data", (d: Buffer) => output += d.toString());
      install.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`Harper install exited ${code}: ${output}`)));
      install.on("error", reject);
      setTimeout(() => { install.kill(); reject(new Error(`Harper install timed out: ${output}`)); }, 20_000);
    });

    // Step 2: Start dev mode
    const proc = spawn(NODE_BIN, [HARPER_BIN, "dev", "."], { cwd: process.cwd(), env });

    let startupLog = "";
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error(`Harper startup timed out. Log:\n${startupLog}`));
      }, STARTUP_TIMEOUT_MS);

      const onData = (data: Buffer) => {
        startupLog += data.toString();
        if (startupLog.includes("successfully started") || startupLog.includes("listening on")) {
          clearTimeout(timer);
          resolve();
        }
      };
      proc.stdout?.on("data", onData);
      proc.stderr?.on("data", onData);
      proc.on("error", (err) => { clearTimeout(timer); reject(err); });
      proc.on("exit", (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(`Harper exited ${code}. Log:\n${startupLog}`));
      });
    });

    // Restore boot props immediately after start (so running instance isn't affected long)
    if (hadBootProps) {
      await rename(BOOT_PROPS_BAK, BOOT_PROPS);
    }

    const httpURL = `http://127.0.0.1:${httpPort}`;
    const opsURL = `http://127.0.0.1:${opsPort}`;

    for (let i = 0; i < 20; i++) {
      try {
        const res = await fetch(`${httpURL}/Health`, { signal: AbortSignal.timeout(1000) });
        if (res.ok) break;
      } catch {}
      await new Promise(r => setTimeout(r, 500));
    }

    return { httpURL, opsURL, installDir, process: proc, admin: { username: "admin", password: "test123" } };
  } catch (err) {
    // Restore boot props on failure
    if (hadBootProps && existsSync(BOOT_PROPS_BAK)) {
      await rename(BOOT_PROPS_BAK, BOOT_PROPS);
    }
    throw err;
  }
}

export async function stopHarper(inst: HarperInstance): Promise<void> {
  inst.process.kill();
  await new Promise<void>(r => {
    inst.process.on("exit", r);
    setTimeout(() => { try { inst.process.kill("SIGKILL"); } catch {} r(); }, 3000);
  });
  await rm(inst.installDir, { recursive: true, force: true, maxRetries: 4 });
  // Restore boot props if test crashed and left backup
  if (existsSync(BOOT_PROPS_BAK) && !existsSync(BOOT_PROPS)) {
    await rename(BOOT_PROPS_BAK, BOOT_PROPS);
  }
}
