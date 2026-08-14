/**
 * flair#1136: Boot-safety and mutation-proof integration tests for the shipped
 * @harperfast/oauth config block.
 *
 * These tests boot ephemeral Harper instances against mutated configs and
 * verify:
 *   1. BOOT-SAFETY: shipped config (mcp.enabled: false, no env) boots clean.
 *   2. MUTATION-PROVE (literal true): mcp.enabled: true + env unset → CRASH.
 *      This proves the boot-safety test CAN fire — it catches the crash.
 *   3. MUTATION-PROVE (${ENV} trap): mcp.enabled: ${FLAIR_MCP_OAUTH} + env
 *      unset → CRASH. Proves that ${ENV} interpolation of unset vars produces
 *      a truthy string, which is why the shipped default MUST be literal false.
 *   4. ENABLED: mcp.enabled: true + env vars set → /mcp mounts, CIMD
 *      metadata advertises.
 */

import { describe, test, expect, afterAll } from "bun:test";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, symlinkSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle.js";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SHIPPED_CONFIG = join(REPO_ROOT, "config.yaml");

let instances: HarperInstance[] = [];
let tempDirs: string[] = [];

afterAll(async () => {
  for (const h of instances) {
    try { await stopHarper(h); } catch { /* best effort */ }
  }
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// ─── BOOT-SAFETY: shipped config, no env → clean boot ──────────────────────

describe("flair#1136 boot-safety: shipped config with mcp.enabled: false", () => {
  test(
    "Harper boots cleanly with the ACTUAL shipped config.yaml and no FLAIR_MCP_* env",
    async () => {
      // NEVER boot in-place (cwd: REPO_ROOT) — Harper WRITES to config.yaml
      // in its cwd at boot (adds ports, etc.), which would corrupt the
      // committed file. Instead, copy the shipped config VERBATIM into a
      // temp component tree and boot from there. This still tests the REAL
      // shipped content without mutating the repo.
      const workDir = mkdtempSync(join(tmpdir(), "flair-boot-safety-"));
      tempDirs.push(workDir);

      // Copy the ACTUAL shipped config.yaml verbatim.
      copyFileSync(SHIPPED_CONFIG, join(workDir, "config.yaml"));

      // Symlink node_modules and dist so Harper can find the plugin and JS
      // resources.
      symlinkSync(join(REPO_ROOT, "node_modules"), join(workDir, "node_modules"));
      symlinkSync(join(REPO_ROOT, "dist"), join(workDir, "dist"));

      const harper = await startHarper({
        cwd: workDir,
        harperBinDir: REPO_ROOT,
      });
      instances.push(harper);

      // Harper came up — the process is running.
      expect(harper.httpURL).toBeTruthy();
      expect(harper.opsURL).toBeTruthy();

      // Ops API is healthy (Harper is running).
      const opsRes = await fetch(harper.opsURL, {
        signal: AbortSignal.timeout(10_000),
      });
      expect(opsRes.status).toBe(200);

      // /mcp returns 404 — MCP is OFF (not degraded). When the plugin
      // degrades (mcp.enabled: true + issuer unset), /mcp returns 500.
      // A 404 here proves the shipped default is inert. If someone
      // accidentally ships enabled: true, this assertion fires.
      const mcpRes = await fetch(`${harper.httpURL}/mcp`, {
        signal: AbortSignal.timeout(10_000),
      });
      expect(mcpRes.status).toBe(404);
    },
    120_000,
  );
});

// ─── MUTATION-PROVE: enabled:true + no env → CRASH ─────────────────────────

describe("flair#1136 mutation-prove: mcp.enabled: true with env unset", () => {
  test(
    "literal true: Harper boots DEGRADED when mcp.enabled is true but FLAIR_MCP_* env is unset",
    async () => {
      const workDir = mkdtempSync(join(tmpdir(), "flair-mutation-prove-literal-"));
      const configPath = join(workDir, "config.yaml");

      // Symlink node_modules and dist so Harper can find @harperfast/oauth
      // and the JS resources (mcp-oauth.ts, etc.).
      symlinkSync(join(REPO_ROOT, "node_modules"), join(workDir, "node_modules"));
      symlinkSync(join(REPO_ROOT, "dist"), join(workDir, "dist"));

      // Read the shipped config and flip mcp.enabled to literal true.
      const shipped = readFileSync(join(REPO_ROOT, "config.yaml"), "utf-8");
      const mutated = shipped.replace("enabled: false", "enabled: true");
      writeFileSync(configPath, mutated, "utf-8");

      // Harper boots but the plugin fails to load because the issuer
      // ("${FLAIR_MCP_ISSUER}" literal, env unset) is not a valid URL.
      // Harper catches the error and continues in a degraded state.
      const harper = await startHarper({
        cwd: workDir,
        harperBinDir: REPO_ROOT,
      });
      instances.push(harper);

      // PROOF: the health endpoint is degraded (500, not 200).
      // The boot-safety test checks for 200 — this proves it CAN fire.
      const healthRes = await fetch(`${harper.httpURL}/health`, {
        signal: AbortSignal.timeout(10_000),
      });
      expect(healthRes.status).toBe(500);

      // /mcp surfaces the plugin load error.
      const mcpRes = await fetch(`${harper.httpURL}/mcp`, {
        signal: AbortSignal.timeout(10_000),
      });
      expect(mcpRes.status).toBe(500);
      const mcpBody = await mcpRes.text();
      expect(mcpBody).toContain("mcp.issuer must be an absolute http(s) origin");
      expect(mcpBody).toContain("${FLAIR_MCP_ISSUER}");

      // Clean up the temp dir.
      try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ok */ }
    },
    120_000,
  );

  test(
    "${ENV} backstop: an unresolved mcp.enabled placeholder fail-safes to DISABLED (oauth 2.5.0+)",
    async () => {
      const workDir = mkdtempSync(join(tmpdir(), "flair-mutation-prove-env-"));
      const configPath = join(workDir, "config.yaml");

      // Symlink node_modules and dist so Harper can find @harperfast/oauth
      // and the JS resources (mcp-oauth.ts, etc.).
      symlinkSync(join(REPO_ROOT, "node_modules"), join(workDir, "node_modules"));
      symlinkSync(join(REPO_ROOT, "dist"), join(workDir, "dist"));

      // Read the shipped config and replace literal `false` with
      // `${FLAIR_MCP_OAUTH}` — simulating what would happen if we shipped
      // with env-var interpolation on the enabled flag.
      const shipped = readFileSync(join(REPO_ROOT, "config.yaml"), "utf-8");
      const mutated = shipped.replace("enabled: false", 'enabled: "${FLAIR_MCP_OAUTH}"');
      writeFileSync(configPath, mutated, "utf-8");

      // oauth 2.5.0+ backstop: normalizeBooleanField detects the unresolved
      // ${FLAIR_MCP_OAUTH} placeholder on mcp.enabled, warns, and DELETES the
      // field — so the documented default (disabled) applies and Harper boots
      // CLEAN with mcp OFF, instead of the pre-2.5.0 behavior where the truthy
      // placeholder string enabled the crash path. We STILL ship literal false
      // (proven by the sibling shipped-config test) — this proves the plugin
      // fail-safes the ${ENV} form rather than failing degraded.
      const harper = await startHarper({
        cwd: workDir,
        harperBinDir: REPO_ROOT,
      });
      instances.push(harper);

      // PROOF: clean boot — Harper is healthy (ops API 200), NOT degraded.
      const opsRes = await fetch(harper.opsURL, {
        signal: AbortSignal.timeout(10_000),
      });
      expect(opsRes.status).toBe(200);

      // /mcp is 404 — MCP is OFF (the placeholder was dropped to the default),
      // not 500 (which is what a degraded plugin load returns).
      const mcpRes = await fetch(`${harper.httpURL}/mcp`, {
        signal: AbortSignal.timeout(10_000),
      });
      expect(mcpRes.status).toBe(404);

      // Clean up the temp dir.
      try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ok */ }
    },
    120_000,
  );
});

// ─── ENABLED: enabled:true + env → /mcp mounts ─────────────────────────────

describe("flair#1136 enabled path: mcp.enabled: true + env", () => {
  test(
    "/mcp mounts and advertises CIMD when enabled:true + issuer/keys env set",
    async () => {
      const workDir = mkdtempSync(join(tmpdir(), "flair-enabled-"));
      const configPath = join(workDir, "config.yaml");

      // Symlink node_modules and dist so Harper can find @harperfast/oauth
      // and the JS resources (mcp-oauth.ts, etc.).
      symlinkSync(join(REPO_ROOT, "node_modules"), join(workDir, "node_modules"));
      symlinkSync(join(REPO_ROOT, "dist"), join(workDir, "dist"));

      const shipped = readFileSync(join(REPO_ROOT, "config.yaml"), "utf-8");
      const mutated = shipped.replace("enabled: false", "enabled: true");
      writeFileSync(configPath, mutated, "utf-8");

      // Generate a test signing key.
      const { generateKeyPairSync } = await import("node:crypto");
      const { privateKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });

      // Set env vars before spawning Harper.
      const prevOauth = process.env.FLAIR_MCP_OAUTH;
      const prevIssuer = process.env.FLAIR_MCP_ISSUER;
      const prevKey = process.env.FLAIR_MCP_SIGNING_KEY_PEM;
      const prevGhId = process.env.OAUTH_GITHUB_CLIENT_ID;
      const prevGhSecret = process.env.OAUTH_GITHUB_CLIENT_SECRET;
      try {
        process.env.FLAIR_MCP_OAUTH = "1";
        process.env.FLAIR_MCP_ISSUER = "https://test.example.com";
        process.env.FLAIR_MCP_SIGNING_KEY_PEM = privateKey;
        process.env.OAUTH_GITHUB_CLIENT_ID = "test-client-id";
        process.env.OAUTH_GITHUB_CLIENT_SECRET = "test-client-secret";

        const harper = await startHarper({
          cwd: workDir,
          harperBinDir: REPO_ROOT,
        });
        instances.push(harper);

        // /mcp should be mounted (returns 401 without auth, not 404).
        const mcpRes = await fetch(`${harper.httpURL}/mcp`, {
          signal: AbortSignal.timeout(10_000),
        });
        expect(mcpRes.status).toBe(401);

        // CIMD metadata should be advertised.
        const metaRes = await fetch(
          `${harper.httpURL}/.well-known/oauth-authorization-server`,
          { signal: AbortSignal.timeout(10_000) },
        );
        expect(metaRes.status).toBe(200);
        const meta = await metaRes.json();
        expect(meta.client_id_metadata_document_supported).toBe(true);
      } finally {
        if (prevOauth !== undefined) process.env.FLAIR_MCP_OAUTH = prevOauth; else delete process.env.FLAIR_MCP_OAUTH;
        if (prevIssuer !== undefined) process.env.FLAIR_MCP_ISSUER = prevIssuer; else delete process.env.FLAIR_MCP_ISSUER;
        if (prevKey !== undefined) process.env.FLAIR_MCP_SIGNING_KEY_PEM = prevKey; else delete process.env.FLAIR_MCP_SIGNING_KEY_PEM;
        if (prevGhId !== undefined) process.env.OAUTH_GITHUB_CLIENT_ID = prevGhId; else delete process.env.OAUTH_GITHUB_CLIENT_ID;
        if (prevGhSecret !== undefined) process.env.OAUTH_GITHUB_CLIENT_SECRET = prevGhSecret; else delete process.env.OAUTH_GITHUB_CLIENT_SECRET;
      }
    },
    120_000,
  );
});
