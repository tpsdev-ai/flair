import { describe, test, expect, beforeAll, afterEach, afterAll } from "bun:test";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, symlinkSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle.js";
import { planRedirectMigration, readTargetMcpRedirectFinding } from "../../src/lib/mcp-oauth-env.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SHIPPED_CONFIG = join(REPO_ROOT, "config.yaml");
const ISSUER = "https://flair-2270.test";
const REDIRECT = "OAUTH_GITHUB_REDIRECT_URI";

let instances: HarperInstance[] = [];
let tempDirs: string[] = [];

const MCP_ENV_KEYS = [
  "FLAIR_MCP_OAUTH",
  "FLAIR_MCP_ISSUER",
  "FLAIR_PUBLIC_URL",
  "OAUTH_GITHUB_CLIENT_ID",
  "OAUTH_GITHUB_CLIENT_SECRET",
  REDIRECT,
] as const;
const savedEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of MCP_ENV_KEYS) savedEnv[k] = process.env[k];
});
afterEach(() => {
  for (const k of MCP_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k]!;
  }
});
function clearMcpEnv(): void {
  for (const k of MCP_ENV_KEYS) delete process.env[k];
}
afterAll(async () => {
  for (const h of instances) {
    try {
      await stopHarper(h);
    } catch {
      /* best effort */
    }
  }
  for (const d of tempDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  instances = [];
  tempDirs = [];
});

function makeWorkDir(prefix: string): string {
  const workDir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(workDir);
  symlinkSync(join(REPO_ROOT, "node_modules"), join(workDir, "node_modules"));
  symlinkSync(join(REPO_ROOT, "dist"), join(workDir, "dist"));
  copyFileSync(SHIPPED_CONFIG, join(workDir, "config.yaml"));
  return workDir;
}

function stageOldInstallEnv(): void {
  process.env.FLAIR_MCP_OAUTH = "true";
  process.env.FLAIR_MCP_ISSUER = ISSUER;
  process.env.OAUTH_GITHUB_CLIENT_ID = "upgrade-2270-client";
  process.env.OAUTH_GITHUB_CLIENT_SECRET = "upgrade-2270-secret";
}


describe("flair#2270 degraded start: credentials staged, redirect missing", () => {
  test(
    "missing redirect disables the provider and MCP route",
    async () => {
      clearMcpEnv();
      stageOldInstallEnv();
      const workDir = makeWorkDir("flair-2270-degraded-");
      const harper = await startHarper({ cwd: workDir, harperBinDir: REPO_ROOT });
      instances.push(harper);

      const health = await fetch(`${harper.httpURL}/health`, { signal: AbortSignal.timeout(10_000) });
      expect(health.status).not.toBe(500);

      const mcp = await fetch(`${harper.httpURL}/mcp`, { signal: AbortSignal.timeout(10_000) });
      expect(mcp.status).toBe(404);

      const log = harper.getLog?.() ?? "";
      expect(log).toContain("MCP auth unavailable");
      expect(log).toContain(REDIRECT);
    },
    120_000,
  );
});


describe("flair#2270 redirect staging and Harper loadEnv", () => {
  test(
    "staged redirect reaches the provider through loadEnv",
    async () => {
      clearMcpEnv();
      stageOldInstallEnv();
      const workDir = makeWorkDir("flair-2270-migrated-");

      const result = planRedirectMigration({
        configPath: join(workDir, "config.yaml"),
        env: process.env as Record<string, string | undefined>,
      });
      expect(result.action).toBe("staged");
      expect(existsSync(join(workDir, ".env"))).toBe(true);
      const dotenv = readFileSync(join(workDir, ".env"), "utf-8");
      expect(dotenv).toContain(`${REDIRECT}=${ISSUER}/oauth`);

      const harper = await startHarper({ cwd: workDir, harperBinDir: REPO_ROOT });
      instances.push(harper);

      const health = await fetch(`${harper.httpURL}/health`, { signal: AbortSignal.timeout(10_000) });
      expect(health.status).not.toBe(500);

      const log = harper.getLog?.() ?? "";
      expect(log).not.toContain("Could not load component");
      expect(log).toContain("OAuth provider 'github' initialized (github)");
      const mcp = await fetch(`${harper.httpURL}/mcp`, { signal: AbortSignal.timeout(10_000) });
      expect(mcp.status).toBe(401);

      const meta = await fetch(`${harper.httpURL}/.well-known/oauth-authorization-server`, { signal: AbortSignal.timeout(10_000) });
      expect(meta.status).toBe(200);
      expect((await meta.json()).client_id_metadata_document_supported).toBe(true);
    },
    120_000,
  );

  test(
    "an operator redirect is retained",
    async () => {
      clearMcpEnv();
      stageOldInstallEnv();
      const workDir = makeWorkDir("flair-2270-idempotent-");
      writeFileSync(join(workDir, ".env"), `${REDIRECT}=https://kept.example.com/oauth\n`, { mode: 0o600 });

      const result = planRedirectMigration({
        configPath: join(workDir, "config.yaml"),
        env: process.env as Record<string, string | undefined>,
      });
      expect(result.action).toBe("already-set");
      expect(readFileSync(join(workDir, ".env"), "utf-8")).toContain("https://kept.example.com/oauth");
    },
    30_000,
  );
});


describe("flair#2270 fresh install", () => {
  test(
    "no MCP environment leaves the MCP route absent",
    async () => {
      clearMcpEnv();
      const workDir = makeWorkDir("flair-2270-fresh-");
      const harper = await startHarper({ cwd: workDir, harperBinDir: REPO_ROOT });
      instances.push(harper);

      const health = await fetch(`${harper.httpURL}/health`, { signal: AbortSignal.timeout(10_000) });
      expect(health.status).not.toBe(500);
      const mcp = await fetch(`${harper.httpURL}/mcp`, { signal: AbortSignal.timeout(10_000) });
      expect(mcp.status).toBe(404);
      expect(existsSync(join(workDir, ".env"))).toBe(false);
    },
    120_000,
  );
});


describe("flair#2270 provider with MCP disabled", () => {
  test("credentials without redirect boot and report missing target configuration", async () => {
    clearMcpEnv();
    stageOldInstallEnv();
    process.env.FLAIR_MCP_OAUTH = "false";
    const workDir = makeWorkDir("flair-2270-off-");
    const harper = await startHarper({ cwd: workDir, harperBinDir: REPO_ROOT });
    instances.push(harper);
    clearMcpEnv();
    const health = await fetch(`${harper.httpURL}/health`, { signal: AbortSignal.timeout(10_000) });
    expect(health.status).not.toBe(500);
    expect(harper.getLog?.()).not.toContain("Could not load component");
    expect(harper.getLog?.()).toContain(REDIRECT);
    const auth = `Basic ${Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64")}`;
    // Read and assert OUTSIDE readTargetMcpRedirectFinding: it treats any throw from its reader as
    // "target unavailable", which would swallow these assertions and leave only the isIssue check.
    const res = await fetch(`${harper.httpURL}/HealthDetail`, {
      headers: { Authorization: auth }, signal: AbortSignal.timeout(10_000),
    });
    expect(res.status).toBe(200);
    const detail = await res.json();
    expect(detail.mcpOAuthProvider).toEqual({ credentialsPresent: true, redirectPresent: false });
    const finding = await readTargetMcpRedirectFinding(async () => detail);
    expect(finding?.isIssue).toBe(true);
    expect(finding?.message).toContain(REDIRECT);
    const anonymous = await fetch(`${harper.httpURL}/HealthDetail`, { signal: AbortSignal.timeout(10_000) });
    expect([401, 403]).toContain(anonymous.status);
    const metadata = await fetch(`${harper.httpURL}/OAuthMetadata`, { signal: AbortSignal.timeout(10_000) });
    expect(metadata.status).toBe(200);
    expect(planRedirectMigration({ configPath: join(workDir, "config.yaml"), env: {} }).action).toBe("not-enabled");
    expect(existsSync(join(workDir, ".env"))).toBe(false);
  }, 120_000);
});
