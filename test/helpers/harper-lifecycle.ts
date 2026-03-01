import { spawn, ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HTTP_PORT = 9926;
const STARTUP_TIMEOUT_MS = 30_000;

export interface HarperInstance {
  httpURL: string;
  installDir: string;
  process: ChildProcess;
  admin: { username: string; password: string };
}

export async function startHarper(): Promise<HarperInstance> {
  const installDir = await mkdtemp(join(tmpdir(), "flair-test-"));

  const proc = spawn("npx", ["harperdb", "run",
    `--ROOTPATH=${installDir}`,
    "--DEFAULTS_MODE=dev",
    "--HDB_ADMIN_USERNAME=admin",
    "--HDB_ADMIN_PASSWORD=test123",
    "--THREADS_COUNT=1",
    `--HTTP_PORT=127.0.0.1:${HTTP_PORT}`,
  ], {
    cwd: process.cwd(),
    env: { ...process.env },
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error("Harper startup timed out"));
    }, STARTUP_TIMEOUT_MS);

    proc.stdout?.on("data", (data: Buffer) => {
      if (data.toString().includes("successfully started")) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`Harper exited with ${code}`));
    });
  });

  return {
    httpURL: `http://127.0.0.1:${HTTP_PORT}`,
    installDir,
    process: proc,
    admin: { username: "admin", password: "test123" },
  };
}

export async function stopHarper(inst: HarperInstance): Promise<void> {
  inst.process.kill();
  await new Promise<void>(r => {
    inst.process.on("exit", r);
    setTimeout(() => { try { inst.process.kill("SIGKILL"); } catch {} r(); }, 2000);
  });
  await rm(inst.installDir, { recursive: true, force: true, maxRetries: 4 });
}
