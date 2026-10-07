/**
 * flair#2270 — REAL Harper: an install enabled by an older `flair mcp enable`
 * upgrades healthy, and an install whose redirect variable is still missing
 * starts DEGRADED rather than 500ing.
 *
 * The shipped `config.yaml` references `${OAUTH_GITHUB_REDIRECT_URI}`, and
 * `@harperfast/oauth` refuses to load a CONFIGURED provider whose redirect is
 * unresolved — a failure that takes the whole instance down (`/health` 500).
 * The older enablement staged the credentials but not this variable.
 *
 *   2. DEGRADED — credentials staged, redirect missing: the boot guard leaves
 *      the provider unconfigured so the component starts, /mcp is not mounted,
 *      `/health` is not 500, and the reason names the variable.
 *   1. MIGRATED — `planRedirectMigration` stages the derived redirect through
 *      the component `.env` (the file the shipped config's `loadEnv` reads),
 *      and the same env then boots healthy with the provider initialized.
 *   3. FRESH — no MCP env at all is unchanged (clean boot, /mcp 404).
 *
 * Every boot controls the FLAIR_MCP_* / OAUTH_GITHUB_* environment (an ambient
 * value would change what these tests boot).
 */
import { describe, test, expect, beforeAll, afterEach, afterAll } from "bun:test";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, symlinkSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle.js";
import { planRedirectMigration } from "../../src/lib/mcp-oauth-env.ts";

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

/** A work dir carrying the shipped config.yaml, with node_modules/dist
 *  symlinked (NEVER boot in-place — Harper writes to its cwd's config). */
function makeWorkDir(prefix: string): string {
  const workDir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(workDir);
  symlinkSync(join(REPO_ROOT, "node_modules"), join(workDir, "node_modules"));
  symlinkSync(join(REPO_ROOT, "dist"), join(workDir, "dist"));
  copyFileSync(SHIPPED_CONFIG, join(workDir, "config.yaml"));
  return workDir;
}

/** The env an install created by the PREVIOUS release's `mcp enable` carries:
 *  the flag, the issuer and the IdP credentials — but not the redirect. */
function stageOldInstallEnv(): void {
  process.env.FLAIR_MCP_OAUTH = "true";
  process.env.FLAIR_MCP_ISSUER = ISSUER;
  process.env.OAUTH_GITHUB_CLIENT_ID = "upgrade-2270-client";
  process.env.OAUTH_GITHUB_CLIENT_SECRET = "upgrade-2270-secret";
}

// ─── 2. DEGRADED (the guard) ─────────────────────────────────────────────────

describe("flair#2270 degraded start: credentials staged, redirect missing", () => {
  test(
    "the instance boots DEGRADED, not failing (/health not 500, /mcp not mounted, reason names the variable)",
    async () => {
      clearMcpEnv();
      stageOldInstallEnv();
      const workDir = makeWorkDir("flair-2270-degraded-");
      const harper = await startHarper({ cwd: workDir, harperBinDir: REPO_ROOT });
      instances.push(harper);

      // The old symptom was a 500 here (the component load failed and an error
      // resource shadowed the whole surface). Degraded now.
      const health = await fetch(`${harper.httpURL}/health`, { signal: AbortSignal.timeout(10_000) });
      expect(health.status).not.toBe(500);

      // flair's /mcp is deliberately NOT mounted — a guarded route with no
      // provider behind it would only 401. 404, never 500.
      const mcp = await fetch(`${harper.httpURL}/mcp`, { signal: AbortSignal.timeout(10_000) });
      expect(mcp.status).toBe(404);

      const log = harper.getLog?.() ?? "";
      expect(log).toContain("MCP auth unavailable");
      expect(log).toContain(REDIRECT);
    },
    120_000,
  );
});

// ─── 1. MIGRATED (the upgrade path) ──────────────────────────────────────────

describe("flair#2270 upgrade path: the migration stages the redirect and the boot is healthy", () => {
  test(
    "planRedirectMigration writes the derived redirect, and the SAME env then boots with the provider initialized",
    async () => {
      clearMcpEnv();
      stageOldInstallEnv();
      const workDir = makeWorkDir("flair-2270-migrated-");

      // The upgrade path derives the redirect from the issuer the running
      // instance advertised (the CLI is not started inside the instance env).
      const result = planRedirectMigration({
        configPath: join(workDir, "config.yaml"),
        env: process.env as Record<string, string | undefined>,
      });
      // The MCP flag lives in process.env here, so this stages for real.
      expect(result.action).toBe("staged");
      expect(existsSync(join(workDir, ".env"))).toBe(true);
      const dotenv = readFileSync(join(workDir, ".env"), "utf-8");
      expect(dotenv).toContain(`${REDIRECT}=${ISSUER}/oauth`);

      const harper = await startHarper({ cwd: workDir, harperBinDir: REPO_ROOT });
      instances.push(harper);

      const health = await fetch(`${harper.httpURL}/health`, { signal: AbortSignal.timeout(10_000) });
      expect(health.status).not.toBe(500);

      // MCP auth works: the provider initializes and /mcp is mounted+guarded.
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
    "the migration is idempotent and never rewrites an operator-set redirect",
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

// ─── 3. FRESH ────────────────────────────────────────────────────────────────

describe("flair#2270 fresh install is unchanged", () => {
  test(
    "no MCP env at all: clean boot, /mcp 404, no redirect staged",
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
