/**
 * Live Flair test helper — mirrors the Python conftest.py live_flair fixture.
 *
 * Env contract (identical to Python conftest.py):
 *
 *   External mode (FLAIR_TEST_URL set):
 *     FLAIR_TEST_URL          — Flair HTTP endpoint (required)
 *     FLAIR_TEST_OPS_URL      — Flair ops endpoint (optional; derived as http port-1)
 *     FLAIR_TEST_ADMIN_USER   — ops admin user (default: "admin")
 *     FLAIR_TEST_ADMIN_PASS   — ops admin password (default: "test123")
 *     FLAIR_TEST_AGENT_ID     — agent id (default: auto-generated)
 *
 *   Ephemeral mode (FLAIR_TEST_URL not set):
 *     Boots Harper via boot-harper.mjs, generates keypair, self-registers agent.
 *     Includes the build-gate fix: auto-builds if dist/ is missing.
 *
 * In BOTH modes the helper generates an Ed25519 keypair, writes a temp keyfile,
 * and registers the agent via the Flair ops API. No pre-provisioned keyfile needed.
 *
 * ─── Shared boot (cross-file) ───────────────────────────────────────────────
 *
 * bun test runs each file in a separate worker, so a module-level cache does
 * not share state across files. Instead we use a temp-file protocol:
 *
 *  1. On first call, this worker writes a lock file and boots Harper.
 *  2. It writes the Harper config to a shared JSON file, then removes the lock.
 *  3. Other workers see the shared config file and reuse it (after a health
 *     check to confirm Harper is still alive).
 *  4. If Harper dies or the config is stale, the next worker re-boots.
 *  5. If boot fails, a skip-flag file is written so ALL subsequent workers
 *     skip in milliseconds — no per-file 30s timeout burn.
 *
 * The shared config is cleaned up by the worker that booted Harper (via the
 * returned cleanup function). If that worker crashes, the next run's
 * health check detects the dead Harper and re-boots.
 */

import { FlairMemoryService } from "../../src/index.js";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execSync, type ChildProcess } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve repo root: test/helpers/ → packages/adk-flair-js/ → packages/ → repo root
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const BOOT_HELPER = path.join(
  REPO_ROOT,
  "packages",
  "adk-flair",
  "tests",
  "helpers",
  "boot-harper.mjs",
);

// ─── Shared-boot temp files ──────────────────────────────────────────────────
// These live in os.tmpdir() so they survive across bun test workers.

const SHARED_CONFIG_FILE = path.join(os.tmpdir(), "adk-flair-js-harper-config.json");
const SHARED_LOCK_FILE = path.join(os.tmpdir(), "adk-flair-js-harper.lock");
const SHARED_SKIP_FILE = path.join(os.tmpdir(), "adk-flair-js-harper-skip");

export interface LiveFlairConfig {
  httpUrl: string;
  agentId: string;
  keyfilePath: string;
  privateKey: crypto.KeyObject;
  /** If we booted an ephemeral Harper, this is the cleanup function. */
  cleanup?: () => Promise<void>;
}

interface HarperConfig {
  httpURL: string;
  opsURL: string;
  adminUser: string;
  adminPass: string;
  /** Ephemeral install tree — removed by the last worker during teardown. */
  installDir?: string;
}

// ─── Ed25519 key generation ──────────────────────────────────────────────────

function generateKeypair(): {
  privateKey: crypto.KeyObject;
  publicKeyB64: string;
  keyfileB64: string;
} {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const publicBytes = publicKey.export({ format: "der", type: "spki" });
  // Ed25519 SPKI DER has a 12-byte prefix; strip to raw 32 bytes
  const rawPublic = publicBytes.subarray(12);
  const publicKeyB64 = Buffer.from(rawPublic).toString("base64");

  const der = privateKey.export({ format: "der", type: "pkcs8" });
  const keyfileB64 = Buffer.from(der).toString("base64");

  return { privateKey, publicKeyB64, keyfileB64 };
}

function writeTempKeyfile(agentId: string, keyfileB64: string): string {
  const keyfilePath = path.join(
    os.tmpdir(),
    `adk-flair-test-${agentId}.key`,
  );
  fs.writeFileSync(keyfilePath, keyfileB64, "utf-8");
  return keyfilePath;
}

// ─── Agent registration via ops API ─────────────────────────────────────────

async function registerAgent(
  opsUrl: string,
  adminUser: string,
  adminPass: string,
  agentId: string,
  publicKeyB64: string,
): Promise<void> {
  const auth = Buffer.from(`${adminUser}:${adminPass}`).toString("base64");
  const isoNow = new Date().toISOString();

  const resp = await fetch(opsUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Basic ${auth}`,
    },
    body: JSON.stringify({
      operation: "insert",
      database: "flair",
      table: "Agent",
      records: [
        {
          id: agentId,
          name: agentId,
          role: "agent",
          publicKey: publicKeyB64,
          createdAt: isoNow,
        },
      ],
    }),
  });

  if (resp.status >= 400) {
    const body = await resp.text().catch(() => "");
    throw new Error(
      `Agent registration failed: HTTP ${resp.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
    );
  }
}

// ─── Build gate ──────────────────────────────────────────────────────────────

function findNodeBin(): string | null {
  for (const candidate of ["bun", "node"]) {
    try {
      execSync(`${candidate} --version`, { stdio: "pipe", timeout: 5000 });
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

function ensureBuild(): boolean {
  const distDir = path.join(REPO_ROOT, "dist");
  if (fs.existsSync(distDir) && fs.readdirSync(distDir).length > 0) {
    return true;
  }

  const nodeBin = findNodeBin();
  if (!nodeBin) {
    console.log(
      "SKIP: FLAIR_TEST_URL not set and neither bun nor node is available — " +
        "set FLAIR_TEST_URL to a running Flair instance to run integration tests",
    );
    return false;
  }

  try {
    const tscPath = path.join(REPO_ROOT, "node_modules", ".bin", "tsc");
    execSync(`${nodeBin} ${tscPath} -p tsconfig.json --noCheck`, {
      cwd: REPO_ROOT,
      stdio: "pipe",
      timeout: 120_000,
    });
  } catch (buildErr: unknown) {
    const msg = buildErr instanceof Error ? buildErr.message : String(buildErr);
    console.log(
      `SKIP: FLAIR_TEST_URL not set and repo dist/ is missing — ` +
        `auto-build failed: ${msg.slice(0, 500)}`,
    );
    return false;
  }

  if (!fs.existsSync(distDir) || fs.readdirSync(distDir).length === 0) {
    console.log(
      "SKIP: FLAIR_TEST_URL not set and repo dist/ is missing — " +
        "build completed but dist/ is still empty; " +
        "run 'npm run build' manually or set FLAIR_TEST_URL",
    );
    return false;
  }

  return true;
}

// ─── Shared-boot coordination ────────────────────────────────────────────────

/**
 * Check whether a shared Harper config is still alive.
 * Returns the config if Harper responds to /health, null otherwise.
 */
async function checkSharedHarper(): Promise<HarperConfig | null> {
  try {
    if (!fs.existsSync(SHARED_CONFIG_FILE)) return null;
    const raw = fs.readFileSync(SHARED_CONFIG_FILE, "utf-8");
    const config = JSON.parse(raw) as HarperConfig;
    const resp = await fetch(`${config.httpURL}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (resp.ok) return config;
  } catch {
    // Harper dead or config unreadable — stale
  }
  // Remove stale config so next caller re-boots
  try { fs.unlinkSync(SHARED_CONFIG_FILE); } catch {}
  return null;
}

/**
 * Write the skip-flag file so all subsequent workers skip immediately.
 */
function writeSkipFlag(reason: string): void {
  try {
    fs.writeFileSync(SHARED_SKIP_FILE, reason, "utf-8");
  } catch {
    // best effort
  }
}

/**
 * Check whether a previous worker already marked this run as skip.
 * Returns the skip reason string, or null if no skip flag exists.
 */
function readSkipFlag(): string | null {
  try {
    if (fs.existsSync(SHARED_SKIP_FILE)) {
      return fs.readFileSync(SHARED_SKIP_FILE, "utf-8").trim();
    }
  } catch {}
  return null;
}

/**
 * Try to acquire the shared boot lock by writing our PID.
 * Returns true if we acquired it (or the lock is stale).
 */
function tryAcquireLock(): boolean {
  try {
    if (fs.existsSync(SHARED_LOCK_FILE)) {
      const pidStr = fs.readFileSync(SHARED_LOCK_FILE, "utf-8").trim();
      const pid = parseInt(pidStr, 10);
      if (!isNaN(pid)) {
        // Check if the lock holder is still alive
        try {
          process.kill(pid, 0); // signal 0 = existence check
          return false; // lock holder is alive
        } catch {
          // lock holder is dead — stale lock, we can take it
        }
      }
    }
    fs.writeFileSync(SHARED_LOCK_FILE, String(process.pid), "utf-8");
    return true;
  } catch {
    return false;
  }
}

function releaseLock(): void {
  try {
    if (fs.existsSync(SHARED_LOCK_FILE)) {
      const pidStr = fs.readFileSync(SHARED_LOCK_FILE, "utf-8").trim();
      if (String(process.pid) === pidStr) {
        fs.unlinkSync(SHARED_LOCK_FILE);
      }
    }
  } catch {}
}

// ─── Ephemeral Harper boot ───────────────────────────────────────────────────

/**
 * The booter's bounded budget. On a runner class that can't reach operating
 * latency, the full cold-start timeout would burn the per-test timeout
 * (200s). 60s is enough for a capable runner to complete the full cold-start
 * path (install + startup banner + dual health poll, ~125s in
 * harper-lifecycle.ts, minus the install step which is pre-cached in CI).
 * On a standard runner the booter skips clean like the waiters instead of
 * failing dirty after burning the full test timeout (flair#1119).
 */
const BOOT_TIMEOUT_MS = 60_000;

export async function bootEphemeralHarper(
  helperPath?: string,
  timeoutMs?: number,
): Promise<{
  config: HarperConfig;
  proc: ChildProcess;
}> {
  const nodeBin = findNodeBin();
  if (!nodeBin) {
    throw new Error("No Node.js/bun runtime available");
  }

  const bootScript = helperPath ?? BOOT_HELPER;
  const budget = timeoutMs ?? BOOT_TIMEOUT_MS;

  // Harper's NAPI modules require real Node.js (bun 1.3.x lacks uv_ip6_addr).
  // If the found binary is bun, we still use it to SPAWN boot-harper.mjs
  // (which imports TS via bun), but we tell harper-lifecycle to use node for
  // the actual Harper process. If node is not on PATH, set NODE_BIN to bun as
  // a last resort — Harper may fail to start, but we'll get a clear error
  // rather than a silent hang.
  const env: Record<string, string> = { ...process.env as Record<string, string> };
  if (nodeBin === "bun" && !env["NODE_BIN"]) {
    // Check if real node is available
    try {
      execSync("node --version", { stdio: "pipe", timeout: 5000 });
      env["NODE_BIN"] = "node";
    } catch {
      // No real node — Harper won't start, but we let it fail with a clear
      // error from harper-lifecycle rather than hanging.
    }
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(nodeBin, [bootScript], {
      cwd: REPO_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Kill the entire process group so Harper children are reaped too.
      // Negative PID signals the process group.
      try {
        if (proc.pid) process.kill(-proc.pid, "SIGKILL");
      } catch {
        proc.kill("SIGKILL");
      }
      reject(new Error(`boot-harper timed out after ${budget / 1000}s`));
    }, budget);

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      // The boot helper emits log lines (from harper-lifecycle) before the
      // JSON config line. Try to parse each complete line as JSON.
      const lines = stdout.split("\n");
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const config = JSON.parse(line) as HarperConfig;
          if (config.httpURL && config.opsURL) {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            resolve({ config, proc });
            return;
          }
        } catch {
          // Not JSON — a log line from harper-lifecycle, keep scanning
        }
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`boot-harper failed to start: ${err.message}`));
    });

    proc.on("exit", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== null && code !== 0) {
        reject(
          new Error(`boot-harper exited ${code}: ${stderr.slice(0, 500)}`),
        );
      }
    });
  });
}

// ─── Main entry point ────────────────────────────────────────────────────────

/**
 * Get a live Flair configuration for integration tests.
 *
 * Returns null if no live Flair is available (tests should skip visibly).
 * In both modes, generates an Ed25519 keypair, writes a temp keyfile,
 * and self-registers the agent via the ops API.
 *
 * Uses a shared-boot protocol so Harper is started ONCE across all test
 * files in a `bun test` run, and boot failures skip all subsequent files
 * in milliseconds.
 */
export async function getLiveFlair(): Promise<LiveFlairConfig | null> {
  const testUrl = process.env["FLAIR_TEST_URL"];

  if (testUrl) {
    // ── External mode: use the provided Flair instance ────────────────────
    const parsed = new URL(testUrl);
    const opsUrl =
      process.env["FLAIR_TEST_OPS_URL"] ??
      `${parsed.protocol}//${parsed.hostname}:${(parsed.port ? parseInt(parsed.port) : 19926) - 1}`;
    const adminUser = process.env["FLAIR_TEST_ADMIN_USER"] ?? "admin";
    const adminPass = process.env["FLAIR_TEST_ADMIN_PASS"] ?? "test123";
    const agentId =
      process.env["FLAIR_TEST_AGENT_ID"] ??
      `adk-integration-test-${crypto.randomUUID().slice(0, 8)}`;

    const { privateKey, publicKeyB64, keyfileB64 } = generateKeypair();
    const keyfilePath = writeTempKeyfile(agentId, keyfileB64);

    try {
      await registerAgent(opsUrl, adminUser, adminPass, agentId, publicKeyB64);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(
        `SKIP: agent registration failed against ${opsUrl}: ${msg}`,
      );
      try { fs.unlinkSync(keyfilePath); } catch {}
      return null;
    }

    const cleanup = async () => {
      try { fs.unlinkSync(keyfilePath); } catch {}
    };

    return {
      httpUrl: testUrl,
      agentId,
      keyfilePath,
      privateKey,
      cleanup,
    };
  }

  // ── Ephemeral mode: boot Harper via the Node.js helper ─────────────────

  // Fast path: a previous worker already marked this run as skip.
  const skipReason = readSkipFlag();
  if (skipReason) {
    console.log(`SKIP: ${skipReason}`);
    return null;
  }

  if (!fs.existsSync(BOOT_HELPER)) {
    const reason = "FLAIR_TEST_URL not set and boot-harper.mjs helper not found — " +
      "set FLAIR_TEST_URL to a running Flair instance to run integration tests";
    console.log(`SKIP: ${reason}`);
    writeSkipFlag(reason);
    return null;
  }

  if (!ensureBuild()) {
    writeSkipFlag("FLAIR_TEST_URL not set and repo build failed");
    return null;
  }

  // Shared-boot protocol: check for an already-running Harper first.
  const existing = await checkSharedHarper();
  if (existing) {
    // Another worker already booted Harper — reuse it.
    const agentId = `adk-integration-test-${crypto.randomUUID().slice(0, 8)}`;
    const { privateKey, publicKeyB64, keyfileB64 } = generateKeypair();
    const keyfilePath = writeTempKeyfile(agentId, keyfileB64);

    try {
      await registerAgent(
        existing.opsURL,
        existing.adminUser,
        existing.adminPass,
        agentId,
        publicKeyB64,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(
        `SKIP: agent registration failed against ${existing.opsURL}: ${msg}`,
      );
      try { fs.unlinkSync(keyfilePath); } catch {}
      return null;
    }

    return {
      httpUrl: existing.httpURL,
      agentId,
      keyfilePath,
      privateKey,
      cleanup: async () => {
        try { fs.unlinkSync(keyfilePath); } catch {}
      },
    };
  }

  // Try to acquire the boot lock. If another worker is already booting,
  // poll for the shared config to appear.
  if (!tryAcquireLock()) {
    // Another worker is booting — wait for the shared config file.
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      const config = await checkSharedHarper();
      if (config) {
        // Harper is up — proceed as a consumer.
        const agentId = `adk-integration-test-${crypto.randomUUID().slice(0, 8)}`;
        const { privateKey, publicKeyB64, keyfileB64 } = generateKeypair();
        const keyfilePath = writeTempKeyfile(agentId, keyfileB64);

        try {
          await registerAgent(
            config.opsURL,
            config.adminUser,
            config.adminPass,
            agentId,
            publicKeyB64,
          );
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(
            `SKIP: agent registration failed against ${config.opsURL}: ${msg}`,
          );
          try { fs.unlinkSync(keyfilePath); } catch {}
          return null;
        }

        return {
          httpUrl: config.httpURL,
          agentId,
          keyfilePath,
          privateKey,
          cleanup: async () => {
            try { fs.unlinkSync(keyfilePath); } catch {}
          },
        };
      }
      // Check if the booting worker wrote a skip flag (boot failed)
      const skip = readSkipFlag();
      if (skip) {
        console.log(`SKIP: ${skip}`);
        return null;
      }
    }
    // Timed out waiting for the other worker
    const reason = "FLAIR_TEST_URL not set and ephemeral Harper failed to start: " +
      "timed out waiting for another worker to boot Harper";
    console.log(`SKIP: ${reason}`);
    writeSkipFlag(reason);
    return null;
  }

  // We hold the lock — boot Harper.
  let harperConfig: HarperConfig;
  let proc: ChildProcess;

  try {
    const result = await bootEphemeralHarper();
    harperConfig = result.config;
    proc = result.proc;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const reason = `FLAIR_TEST_URL not set and ephemeral Harper failed to start: ${msg}`;
    console.log(`SKIP: ${reason}`);
    writeSkipFlag(reason);
    releaseLock();
    return null;
  }

  // Write shared config so other workers can reuse this Harper.
  try {
    fs.writeFileSync(SHARED_CONFIG_FILE, JSON.stringify(harperConfig), "utf-8");
  } catch {}
  releaseLock();

  const agentId = `adk-integration-test-${crypto.randomUUID().slice(0, 8)}`;
  const { privateKey, publicKeyB64, keyfileB64 } = generateKeypair();
  const keyfilePath = writeTempKeyfile(agentId, keyfileB64);

  try {
    await registerAgent(
      harperConfig.opsURL,
      harperConfig.adminUser,
      harperConfig.adminPass,
      agentId,
      publicKeyB64,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(
      `SKIP: agent registration failed against ${harperConfig.opsURL}: ${msg}`,
    );
    try { fs.unlinkSync(keyfilePath); } catch {}
    proc.kill("SIGTERM");
    try { fs.unlinkSync(SHARED_CONFIG_FILE); } catch {}
    return null;
  }

  const cleanup = async () => {
    try { fs.unlinkSync(keyfilePath); } catch {}
    try {
      proc.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        proc.on("exit", () => resolve());
        setTimeout(() => {
          try { proc.kill("SIGKILL"); } catch {}
          resolve();
        }, 5000);
      });
    } catch {
      // best effort
    }
    // Remove the ephemeral install tree. stopHarper (called by the
    // boot-harper.mjs SIGTERM handler above) also removes it, but if
    // stopHarper didn't complete before the SIGKILL fallback, the tree
    // survives. This is the last-worker-out safety net.
    if (harperConfig.installDir) {
      try {
        fs.rmSync(harperConfig.installDir, { recursive: true, force: true, maxRetries: 4 });
      } catch {
        // best effort
      }
    }
    // Remove shared config so the next run starts fresh
    try { fs.unlinkSync(SHARED_CONFIG_FILE); } catch {}
    try { fs.unlinkSync(SHARED_SKIP_FILE); } catch {}
  };

  return {
    httpUrl: harperConfig.httpURL,
    agentId,
    keyfilePath,
    privateKey,
    cleanup,
  };
}
