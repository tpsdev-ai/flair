import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tempDir } from "../helpers/temp-dir.ts";
import { startHarper, stopHarper } from "../helpers/harper-lifecycle.ts";
import { readProcessStartTimeMs } from "../../src/lib/process-start-time.ts";

const root = resolve(import.meta.dir, "../..");

test("the built start command replaces an exited Harper owner after unreachable health and a refused connection", async () => {
  const home = tempDir("s");
  const dataDir = join(home, ".flair", "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const inst = await startHarper({ installDir: dataDir, homeDir: home, cwd: root });
  let replacement: number | undefined;
  const sidecar = join(dataDir, "flair-daemon.json");
  try {
    if (!inst.process?.pid) throw new Error("This fixture requires a local Harper process");
    const pid = inst.process.pid;
    const startTimeMs = readProcessStartTimeMs(pid);
    expect(startTimeMs).not.toBeNull();
    const port = Number(new URL(inst.httpURL).port);
    expect(Number(readFileSync(join(dataDir, "hdb.pid"), "utf8").trim())).toBe(pid);
    writeFileSync(sidecar, JSON.stringify({ pid, startTimeMs, port, flairVersion: "test" }), { mode: 0o600 });
    const exited = new Promise<void>((done) => inst.process!.once("exit", () => done()));
    inst.process.kill("SIGKILL");
    await exited;
    const preload = join(home, "health-timeout.mjs");
    writeFileSync(preload, `
const realFetch = globalThis.fetch;
let probes = 0;
globalThis.fetch = (...args) => {
  if (String(args[0]) === 'http://127.0.0.1:${port}/Health' && ++probes <= 2) {
    return Promise.reject(new Error('fixture health timeout'));
  }
  return realFetch(...args);
};
`);
    writeFileSync(join(home, ".flair", "config.yaml"), `port: ${port}\nopsPort: ${new URL(inst.opsURL).port}\n`);
    const result = spawnSync("node", ["--import", preload, join(root, "dist/cli.js"), "start", "--port", String(port)], {
      cwd: root, encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL",
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(FLAIR_|HARPER_|HDB_|FABRIC_)/.test(key))),
        HOME: home, USERPROFILE: home, HDB_ADMIN_PASSWORD: inst.admin.password,
        FLAIR_ADMIN_PASS: inst.admin.password, FLAIR_MODELS_DIR: process.env.FLAIR_MODELS_DIR ?? join(root, "models") },
    });
    if (existsSync(sidecar)) {
      const record = JSON.parse(readFileSync(sidecar, "utf8"));
      if (record.pid !== pid && record.port === port) replacement = record.pid;
    }
    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(replacement).toBeDefined();
    expect(replacement).not.toBe(pid);
    const health = await fetch(`${inst.httpURL}/Health`, { signal: AbortSignal.timeout(5_000) });
    expect(health.ok).toBe(true);
  } finally {
    if (replacement) {
      try { process.kill(replacement, "SIGKILL"); } catch { /* already exited */ }
    }
    await stopHarper(inst);
  }
}, 180_000);
