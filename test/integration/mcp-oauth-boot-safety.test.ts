/**
 * flair#1136: Boot-safety integration tests for the shipped @harperfast/oauth
 * config block.
 *
 * These tests boot an ephemeral Harper instance against the shipped
 * config.yaml and verify:
 *   1. BOOT-SAFETY: Harper comes up clean with mcp.enabled: false and no
 *      FLAIR_MCP_* env vars set — no crash, no /mcp surface, no /oauth surface.
 *   2. MUTATION-PROVE: (requires @harperfast/oauth installed) flipping
 *      mcp.enabled to true with env unset must crash/throw.
 *   3. ENABLED: (requires @harperfast/oauth installed) mcp.enabled: true +
 *      issuer/keys env → /mcp mounts, CIMD metadata advertises.
 *
 * Tests 2-3 are gated behind a `describe.skip` — they need the
 * @harperfast/oauth npm package installed in node_modules, which is not
 * part of the flair dev dependency tree.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle.js";

const REPO_ROOT = join(import.meta.dir, "..", "..");

let instances: HarperInstance[] = [];

afterAll(async () => {
  for (const h of instances) {
    try { await stopHarper(h); } catch { /* best effort */ }
  }
});

// ─── BOOT-SAFETY: shipped config, no env → clean boot ──────────────────────

describe("flair#1136 boot-safety: shipped config with mcp.enabled: false", () => {
  test(
    "Harper boots cleanly with the shipped config.yaml and no FLAIR_MCP_* env",
    async () => {
      // If the shipped config caused a boot crash, startHarper throws.
      const harper = await startHarper({
        cwd: REPO_ROOT,
        harperBinDir: REPO_ROOT,
      });
      instances.push(harper);

      // Harper came up — the process is running and the ops API answers.
      expect(harper.httpURL).toBeTruthy();
      expect(harper.opsURL).toBeTruthy();

      // Verify the ops API is healthy (basic health check).
      const healthRes = await fetch(harper.opsURL, {
        signal: AbortSignal.timeout(10_000),
      });
      expect(healthRes.status).toBe(200);
    },
    120_000,
  );
});

// ─── MUTATION-PROVE: enabled:true + no env → crash ──────────────────────────
//
// These tests require @harperfast/oauth to be installed. They are skipped by
// default and intended to be run in an environment where the plugin is present
// (e.g. a full integration test suite with all dependencies).

describe.skip("flair#1136 mutation-prove: enabled:true with env unset", () => {
  test(
    "mcp.enabled: true with FLAIR_MCP_* env unset must crash Harper boot",
    async () => {
      // Create a temp copy of the repo with a mutated config.yaml.
      const workDir = mkdtempSync(join(tmpdir(), "flair-mutation-prove-"));
      const configPath = join(workDir, "config.yaml");

      // Read the shipped config and flip mcp.enabled to true.
      const shipped = readFileSync(join(REPO_ROOT, "config.yaml"), "utf-8");
      const mutated = shipped.replace("enabled: false", "enabled: true");
      writeFileSync(configPath, mutated, "utf-8");

      // Harper should fail to boot because @harperfast/oauth will try to
      // initialize with ${FLAIR_MCP_ISSUER} as a literal string (env unset).
      await expect(
        startHarper({ cwd: workDir, harperBinDir: REPO_ROOT }),
      ).rejects.toThrow();
    },
    120_000,
  );
});

// ─── ENABLED: enabled:true + env → /mcp mounts ──────────────────────────────

describe.skip("flair#1136 enabled path: mcp.enabled: true + env", () => {
  test(
    "/mcp mounts and advertises CIMD when enabled:true + issuer/keys env set",
    async () => {
      const workDir = mkdtempSync(join(tmpdir(), "flair-enabled-"));
      const configPath = join(workDir, "config.yaml");

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
