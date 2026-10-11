/**
 * mcp-refresh-real-harper-2283.test.ts — flair#2283 item 2, against REAL Harper.
 *
 * The refresh unit file (test/unit/mcp-refresh-flag-2283.test.ts) injects a fake
 * ops API. This file drives the SAME `refreshMcpOAuthFlag` path against the Harper
 * harness CI already boots (test/helpers/harper-lifecycle.ts), so the branch the
 * code takes is chosen by the TARGET, not by the test:
 *
 *   - Harper answers `get_secrets_public_key`. When this build's node has secrets
 *     custody registered, the code pushes the one-var envelope (`set_secret`), reads
 *     the row back via `search_by_value` (the `processEnv` marker) and restarts; this
 *     file asserts those operations really happened.
 *   - When the build has NO secrets custody — the OSS harness answers
 *     `{"error":"secrets custody is not initialized on this node"}` — the code must
 *     NOT pretend. It leaves the 0600 staged file for manual application and returns
 *     non-zero. This file asserts the staged file's bytes, its 0600 mode, and the
 *     failed step.
 *
 * `resolveOpsUrl` sends a loopback served origin's ops calls to HOSTED_OPS_PORT
 * (9925); a routing fetch rewrites that origin to the harness's REAL ops port, so the
 * actual ops API is exercised. Discovery reads (only reached on the push-success
 * branch) stay at the served origin, which is also real.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, copyFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle.js";
import { refreshMcpOAuthFlag, resolveOpsUrl } from "../../src/lib/mcp-enable.ts";
import { probeSecretsCapability } from "../../src/lib/secrets-push.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SHIPPED_CONFIG = join(REPO_ROOT, "config.yaml");

let instances: HarperInstance[] = [];
let tempDirs: string[] = [];

const MCP_ENV_KEYS = [
  "FLAIR_MCP_OAUTH",
  "FLAIR_MCP_ISSUER",
  "FLAIR_PUBLIC_URL",
  "OAUTH_GITHUB_CLIENT_ID",
  "OAUTH_GITHUB_CLIENT_SECRET",
  "OAUTH_GITHUB_REDIRECT_URI",
] as const;
const savedEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of MCP_ENV_KEYS) savedEnv[k] = process.env[k];
});
afterAll(async () => {
  for (const k of MCP_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k]!;
  }
  for (const h of instances) {
    try { await stopHarper(h); } catch { /* best effort */ }
  }
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  instances = [];
  tempDirs = [];
});

function makeWorkDir(prefix: string): string {
  const workDir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(workDir);
  symlinkSync(join(REPO_ROOT, "node_modules"), join(workDir, "node_modules"));
  symlinkSync(join(REPO_ROOT, "dist"), join(workDir, "dist"));
  cpSync(join(REPO_ROOT, "schemas"), join(workDir, "schemas"), { recursive: true });
  copyFileSync(SHIPPED_CONFIG, join(workDir, "config.yaml"));
  return workDir;
}

function basicAuth(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

/** Rewrite ops calls that resolve to HOSTED_OPS_PORT to the harness's real ops
 *  port; pass every other request (the served origin, i.e. discovery) through. */
function routingFetch(harper: HarperInstance): typeof fetch {
  const hostedOrigin = new URL(resolveOpsUrl(harper.httpURL)).origin;
  const realOpsOrigin = new URL(harper.opsURL).origin;
  return (async (input: any, init: any) => {
    const raw = typeof input === "string" ? input : input.url;
    const u = new URL(raw);
    if (u.origin === hostedOrigin) {
      return fetch(`${realOpsOrigin}${u.pathname}${u.search}`, init);
    }
    return fetch(raw, init);
  }) as typeof fetch;
}

describe("flair#2283 — refreshMcpOAuthFlag against the real Harper harness", () => {
  test(
    "the target's real capability decides the branch: push+marker+restart, or the staged 0600 file and non-zero",
    async () => {
      for (const k of MCP_ENV_KEYS) delete process.env[k];
      // The migration's starting state: the legacy value the component deletes.
      process.env.FLAIR_MCP_OAUTH = "1";
      process.env.FLAIR_MCP_ISSUER = "https://refresh-2283.test";

      const workDir = makeWorkDir("flair-2283-refresh-real-");
      const harper = await startHarper({ cwd: workDir, harperBinDir: REPO_ROOT });
      instances.push(harper);

      // ── Assert Harper's ACTUAL capability response ─────────────────────────
      const cap = await probeSecretsCapability(harper.opsURL, basicAuth(harper.admin.username, harper.admin.password));
      // This build of Harper either has secrets custody (can take a pushed secret)
      // or it does not. Whichever it answers, the reason is never empty.
      expect(typeof cap.reason).toBe("string");
      expect(cap.reason.length).toBeGreaterThan(0);
      if (cap.available) expect(cap.publicKeyPem).toContain("BEGIN PUBLIC KEY");

      const stagedPath = join(workDir, "refresh.env");
      rmSync(stagedPath, { force: true });
      const result = await refreshMcpOAuthFlag(
        {
          instance: harper.httpURL, // a REAL loopback served origin
          adminUser: harper.admin.username,
          adminPass: harper.admin.password,
          secretsStagingPath: stagedPath,
        },
        { fetchImpl: routingFetch(harper), waitForOpsApiTimeoutMs: 60_000, waitForOpsApiPollMs: 250 },
      );

      if (cap.available) {
        // ── Supported branch: the push, the marker read-back, and the restart ─
        expect(result.steps.find((s) => s.step === "secrets-provisioning")?.ok).toBe(true);
        expect(result.steps.find((s) => s.step === "secrets-provisioning")?.detail).toContain("pushed");
        expect(result.steps.some((s) => s.step === "restart" && s.ok)).toBe(true);
        // The marker really materialised: read the row back from the REAL store.
        const row = await fetch(harper.opsURL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: basicAuth(harper.admin.username, harper.admin.password) },
          body: JSON.stringify({
            operation: "search_by_value",
            database: "system",
            table: "hdb_secret",
            search_attribute: "name",
            search_value: "FLAIR_MCP_OAUTH",
            get_attributes: ["name", "processEnv"],
          }),
        }).then((r) => r.json() as Promise<any[]>);
        expect(row?.[0]?.processEnv).toBe(true);
        // The staged file is left either way — it is the record of what was pushed.
        expect(existsSync(stagedPath)).toBe(true);
      } else {
        // ── Unsupported branch: fail closed, leave the 0600 file, exit non-zero ─
        expect(result.ok).toBe(false);
        expect(result.failedStep).toBe("secrets-provisioning");
        // The refusal names the staged file, and the file is really on disk at 0600
        // carrying exactly the one value the decryptor accepts.
        expect(result.steps.find((s) => s.step === "secrets-provisioning")?.detail).toContain(stagedPath);
        expect(existsSync(stagedPath)).toBe(true);
        expect(readFileSync(stagedPath, "utf8")).toBe("FLAIR_MCP_OAUTH=true\n");
        expect(statSync(stagedPath).mode & 0o777).toBe(0o600);
        // And it never claimed to have restarted: the fallback stops before the
        // restart, so no restart step is recorded.
        expect(result.steps.some((s) => s.step === "restart")).toBe(false);
      }
    },
    300_000,
  );
});
