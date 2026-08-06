/**
 * Live Flair test helper — mirrors the Python conftest.py live_flair fixture.
 *
 * Priority:
 *   1. FLAIR_TEST_URL + FLAIR_TEST_KEYFILE → use external Flair directly
 *   2. Otherwise → boot ephemeral Harper via boot-harper.mjs, generate keys,
 *      register agent, return a ready FlairMemoryService
 *
 * Includes the build-gate fix: if the repo dist/ is missing, attempts an
 * auto-build before booting Harper.
 */

import { FlairMemoryService } from "../../src/index.js";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";

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

/**
 * Find a usable Node.js/bun binary.
 */
function findNodeBin(): string | null {
  // Prefer bun (what the repo uses)
  try {
    const result = spawn("bun", ["--version"], { stdio: "pipe", timeout: 5000 });
    return "bun";
  } catch {
    // fall through
  }
  try {
    const result = spawn("node", ["--version"], { stdio: "pipe", timeout: 5000 });
    return "node";
  } catch {
    return null;
  }
}

/**
 * Build-gate: ensure the repo dist/ exists so Harper can serve.
 * Returns true if dist/ is ready, false if we should skip.
 */
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

  // Try to build
  try {
    const tscPath = path.join(REPO_ROOT, "node_modules", ".bin", "tsc");
    const result = spawn(nodeBin, [tscPath, "-p", "tsconfig.json", "--noCheck"], {
      cwd: REPO_ROOT,
      stdio: "pipe",
      timeout: 120_000,
    });
    // spawn is async in Node — we need sync for beforeAll
    // Use execSync instead
    const { execSync } = require("node:child_process");
    execSync(`${nodeBin} ${tscPath} -p tsconfig.json --noCheck`, {
      cwd: REPO_ROOT,
      timeout: 120_000,
      stdio: "pipe",
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

/**
 * Boot an ephemeral Harper instance via boot-harper.mjs.
 */
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

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      // The helper emits one JSON line then blocks
      if (stdout.includes("\n")) {
        const line = stdout.split("\n")[0];
        try {
          const config = JSON.parse(line) as HarperConfig;
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
      reject(new Error(`boot-harper failed to start: ${err.message}`));
    });

    proc.on("exit", (code: number | null) => {
      if (code !== null && code !== 0) {
        reject(
          new Error(`boot-harper exited ${code}: ${stderr.slice(0, 500)}`),
        );
      }
    });

    // Timeout after 30s
    setTimeout(() => {
      reject(new Error("boot-harper timed out after 30s"));
    }, 30_000);
  });
}

/**
 * Generate an Ed25519 keypair and write the private key to a temp file.
 */
function generateKeypair(): { keyfilePath: string; privateKey: crypto.KeyObject } {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  const b64 = Buffer.from(der).toString("base64");
  const keyfilePath = path.join(
    os.tmpdir(),
    `adk-flair-js-integration-${crypto.randomUUID()}.key`,
  );
  fs.writeFileSync(keyfilePath, b64, "utf-8");
  return { keyfilePath, privateKey };
}

/**
 * Register an agent with the Flair ops API.
 */
async function registerAgent(
  opsURL: string,
  adminUser: string,
  adminPass: string,
  agentId: string,
  publicKeyBytes: Buffer,
): Promise<void> {
  const auth = Buffer.from(`${adminUser}:${adminPass}`).toString("base64");
  const publicKeyB64 = publicKeyBytes.toString("base64");

  const resp = await fetch(`${opsURL}/Agent`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      id: agentId,
      publicKey: publicKeyB64,
    }),
  });

  if (resp.status >= 400) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Agent registration failed (${resp.status}): ${body.slice(0, 200)}`);
  }
}

/**
 * Get a live Flair configuration for integration tests.
 *
 * Returns null if no live Flair is available (tests should skip).
 */
export async function getLiveFlair(): Promise<LiveFlairConfig | null> {
  // Path 1: External Flair via env vars
  const externalUrl = process.env["FLAIR_TEST_URL"];
  const externalKeyfile = process.env["FLAIR_TEST_KEYFILE"];

  if (externalUrl && externalKeyfile) {
    const agentId =
      process.env["FLAIR_TEST_AGENT_ID"] ??
      `adk-integration-test-${crypto.randomUUID().slice(0, 8)}`;

    const b64 = fs.readFileSync(externalKeyfile, "utf-8").trim();
    const der = Buffer.from(b64, "base64");
    const privateKey = crypto.createPrivateKey({
      key: der,
      format: "der",
      type: "pkcs8",
    });

    return {
      httpUrl: externalUrl,
      agentId,
      keyfilePath: externalKeyfile,
      privateKey,
    };
  }

  // Path 2: Boot ephemeral Harper
  if (!ensureBuild()) {
    return null;
  }

  try {
    const { config: harperConfig, proc } = await bootEphemeralHarper();
    const { keyfilePath, privateKey } = generateKeypair();
    const agentId = `adk-integration-test-${crypto.randomUUID().slice(0, 8)}`;

    // Register agent
    const publicKey = crypto.createPublicKey(privateKey);
    const publicKeyBytes = publicKey.export({ format: "der", type: "spki" });
    await registerAgent(
      harperConfig.opsURL,
      harperConfig.adminUser,
      harperConfig.adminPass,
      agentId,
      publicKeyBytes,
    );

    const cleanup = async () => {
      proc.kill("SIGTERM");
      // Wait for process to exit
      await new Promise<void>((resolve) => {
        proc.on("exit", () => resolve());
        setTimeout(() => {
          proc.kill("SIGKILL");
          resolve();
        }, 5000);
      });
      try {
        fs.unlinkSync(keyfilePath);
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
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`SKIP: ephemeral Harper boot failed: ${msg}`);
    return null;
  }
}
