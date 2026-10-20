import { describe, test, expect, afterAll } from "bun:test";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, copyFileSync, cpSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import nacl from "tweetnacl";
import { buildEd25519Auth } from "../../src/lib/auth-resolve.ts";
import { childOverranDeadline } from "../helpers/child-deadline.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarpers, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle.js";
import { planRedirectMigration, readTargetMcpRedirectFinding } from "../../src/lib/mcp-oauth-env.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SHIPPED_CONFIG = join(REPO_ROOT, "config.yaml");
const ISSUER = "https://flair-2270.test";
const REDIRECT = "OAUTH_GITHUB_REDIRECT_URI";

let instances: HarperInstance[] = [];
let tempDirs: string[] = [];

// ── Server env: each boot declares the whole FLAIR_MCP_* set ────────────────
// The shipped config references the environment, so an ambient value on the
// runner would change what these tests boot. An `undefined` value removes an
// inherited one. The same object feeds the in-process redirect planner.
function mcpServerEnv(values: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    FLAIR_MCP_OAUTH: undefined,
    FLAIR_MCP_ISSUER: undefined,
    FLAIR_PUBLIC_URL: undefined,
    OAUTH_GITHUB_CLIENT_ID: undefined,
    OAUTH_GITHUB_CLIENT_SECRET: undefined,
    OAUTH_GITHUB_REDIRECT_URI: undefined,
    ...values,
  };
}

const STAGED_ENV: Record<string, string | undefined> = {
  FLAIR_MCP_OAUTH: "true",
  FLAIR_MCP_ISSUER: ISSUER,
  OAUTH_GITHUB_CLIENT_ID: "upgrade-2270-client",
  OAUTH_GITHUB_CLIENT_SECRET: "upgrade-2270-secret",
};
afterAll(async () => {
  // flair#2568: every instance this file started, stopped concurrently (one
  // stop deadline for the set, not one per instance); best effort, as before.
  await stopHarpers(instances).catch(() => { /* best effort */ });
  for (const d of tempDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  instances = [];
  tempDirs = [];
}, HARPER_STOP_BUDGET_MS);

function makeWorkDir(prefix: string): string {
  const workDir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(workDir);
  symlinkSync(join(REPO_ROOT, "node_modules"), join(workDir, "node_modules"));
  symlinkSync(join(REPO_ROOT, "dist"), join(workDir, "dist"));
  copyFileSync(SHIPPED_CONFIG, join(workDir, "config.yaml"));
  // config.yaml loads schemas/*.graphql from the app dir; without them no flair resource loads
  // (HealthDetail answers 403). Copied, not linked: Harper's schema glob does not follow a
  // symlinked directory (as test/integration-heavy/deploy-public-url.test.ts also copies it).
  cpSync(join(REPO_ROOT, "schemas"), join(workDir, "schemas"), { recursive: true });
  return workDir;
}


describe("flair#2270 degraded start: credentials staged, redirect missing", () => {
  test("doctor --agent reports the missing redirect with an unusable ambient credential", async () => {
    const workDir = makeWorkDir("flair-2270-doctor-");
    const harper = await startHarper({
      cwd: workDir,
      harperBinDir: REPO_ROOT,
      serverEnv: mcpServerEnv(STAGED_ENV),
    });
    instances.push(harper);
    expect(harper.external).toBe(false);
    expect(harper.ownsInstallDir).toBe(true);
    expect(harper.process).not.toBeNull();
    for (const url of [harper.httpURL, harper.opsURL]) {
      expect(new URL(url).hostname).toBe("127.0.0.1");
      expect(["9925", "9926"]).not.toContain(new URL(url).port);
    }

    const cliHome = mkdtempSync(join(tmpdir(), "flair-2270-doctor-home-"));
    tempDirs.push(cliHome);
    const keysDir = join(cliHome, ".flair", "keys");
    mkdirSync(keysDir, { recursive: true });
    const agentId = "doctor-2270-agent";
    const pair = nacl.sign.keyPair();
    const keyPath = join(keysDir, `${agentId}.key`);
    writeFileSync(keyPath, Buffer.from(pair.secretKey.slice(0, 32)), { mode: 0o600 });
    const auth = `Basic ${Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64")}`;
    const insert = await fetch(harper.opsURL, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "insert", database: "flair", table: "Agent", records: [{
        id: agentId,
        name: agentId,
        publicKey: Buffer.from(pair.publicKey).toString("base64"),
        createdAt: new Date().toISOString(),
      }] }),
      signal: AbortSignal.timeout(10_000),
    });
    expect(insert.status).toBe(200);
    const detail = await fetch(`${harper.httpURL}/HealthDetail`, {
      headers: { Authorization: buildEd25519Auth(agentId, "GET", "/HealthDetail", keyPath) },
      signal: AbortSignal.timeout(10_000),
    });
    expect(detail.status).toBe(200);
    expect((await detail.json()).mcpOAuthProvider).toEqual({ credentialsPresent: true, redirectPresent: false });
    const wrongPassword = `${harper.admin.password}-wrong`;
    const ambient = await fetch(`${harper.httpURL}/HealthDetail`, {
      headers: { Authorization: `Basic ${Buffer.from(`${harper.admin.username}:${wrongPassword}`).toString("base64")}` },
      signal: AbortSignal.timeout(10_000),
    });
    expect([401, 403]).toContain(ambient.status);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(FLAIR_|HARPER_|HDB_|FABRIC_|OAUTH_)/.test(key),
    ));
    const startedAt = Date.now();
    const result = spawnSync("node", [join(REPO_ROOT, "dist", "cli.js"), "doctor", "--port", new URL(harper.httpURL).port, "--agent", agentId], {
      cwd: cliHome,
      env: { ...env, HOME: cliHome, USERPROFILE: cliHome, FLAIR_URL: harper.httpURL,
        FLAIR_OPS_PORT: new URL(harper.opsURL).port, FLAIR_AGENT_ID: "unregistered-ambient-agent",
        FLAIR_ADMIN_PASS: wrongPassword, NO_COLOR: "1" },
      encoding: "utf8",
      timeout: 30_000,
    });
    if (result.error || result.signal !== null) {
      throw new Error(childOverranDeadline("flair CLI", "doctor --agent", 30_000, { ...result, elapsedMs: Date.now() - startedAt }));
    }
    const output = result.stdout.replace(/\x1b\[[0-9;]*m/g, "");
    expect(output).toContain(`✗ ${REDIRECT} is missing from the target's github OAuth configuration`);
    expect(output).not.toContain("MCP OAuth redirect: cannot verify");
    expect(output).toMatch(/[1-9]\d* issues? found/);
    expect(result.status).toBe(1);
  }, 180_000);

  test(
    "missing redirect disables the provider and MCP route",
    async () => {
      const workDir = makeWorkDir("flair-2270-degraded-");
      const harper = await startHarper({
        cwd: workDir,
        harperBinDir: REPO_ROOT,
        serverEnv: mcpServerEnv(STAGED_ENV),
      });
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
      const workDir = makeWorkDir("flair-2270-migrated-");

      const result = planRedirectMigration({
        configPath: join(workDir, "config.yaml"),
        env: STAGED_ENV,
      });
      expect(result.action).toBe("staged");
      expect(existsSync(join(workDir, ".env"))).toBe(true);
      const dotenv = readFileSync(join(workDir, ".env"), "utf-8");
      expect(dotenv).toContain(`${REDIRECT}=${ISSUER}/oauth`);

      const harper = await startHarper({
        cwd: workDir,
        harperBinDir: REPO_ROOT,
        serverEnv: mcpServerEnv(STAGED_ENV),
      });
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
      const workDir = makeWorkDir("flair-2270-idempotent-");
      writeFileSync(join(workDir, ".env"), `${REDIRECT}=https://kept.example.com/oauth\n`, { mode: 0o600 });

      const result = planRedirectMigration({
        configPath: join(workDir, "config.yaml"),
        env: STAGED_ENV,
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
      const workDir = makeWorkDir("flair-2270-fresh-");
      const harper = await startHarper({
        cwd: workDir,
        harperBinDir: REPO_ROOT,
        serverEnv: mcpServerEnv(),
      });
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
    const workDir = makeWorkDir("flair-2270-off-");
    const harper = await startHarper({
      cwd: workDir,
      harperBinDir: REPO_ROOT,
      serverEnv: mcpServerEnv({ ...STAGED_ENV, FLAIR_MCP_OAUTH: "false" }),
    });
    instances.push(harper);
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
