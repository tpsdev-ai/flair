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

// ─── Ephemeral Harper boot ───────────────────────────────────────────────────

async function bootEphemeralHarper(): Promise<{
  config: HarperConfig;
  proc: ChildProcess;
}> {
  const nodeBin = findNodeBin();
  if (!nodeBin) {
    throw new Error("No Node.js/bun runtime available");
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(nodeBin, [BOOT_HELPER], {
      cwd: REPO_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";

    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("boot-harper timed out after 30s"));
    }, 30_000);

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes("\n")) {
        const line = stdout.split("\n")[0];
        try {
          const config = JSON.parse(line) as HarperConfig;
          clearTimeout(timeout);
          resolve({ config, proc });
        } catch {
          // wait for more data
        }
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err: Error) => {
      clearTimeout(timeout);
      reject(new Error(`boot-harper failed to start: ${err.message}`));
    });

    proc.on("exit", (code: number | null) => {
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
  if (!fs.existsSync(BOOT_HELPER)) {
    console.log(
      "SKIP: FLAIR_TEST_URL not set and boot-harper.mjs helper not found — " +
        "set FLAIR_TEST_URL to a running Flair instance to run integration tests",
    );
    return null;
  }

  if (!ensureBuild()) {
    return null;
  }

  let harperConfig: HarperConfig;
  let proc: ChildProcess;

  try {
    const result = await bootEphemeralHarper();
    harperConfig = result.config;
    proc = result.proc;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(
      `SKIP: FLAIR_TEST_URL not set and ephemeral Harper failed to start: ${msg}`,
    );
    return null;
  }

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
  };

  return {
    httpUrl: harperConfig.httpURL,
    agentId,
    keyfilePath,
    privateKey,
    cleanup,
  };
}
