/**
 * flair#3032 — the issuer check is held on every request, not only at
 * registration.
 *
 * A real Harper boots with the MCP surface enabled and a matching issuer. While
 * it runs, the component's configured mcp.issuer changes to a different origin.
 * The next /mcp request must answer with the boot guard's named refusal
 * ("differs from FLAIR_MCP_ISSUER") and its remedy — not with the wrapper's
 * generic invalid_token — and the admin Instance page must report that refusal
 * instead of the mounted URL. Restoring the issuer serves requests again and the
 * page reports the URL again.
 *
 * The live issuer is read from the oauth resource's mcpConfig
 * (OAuthResource.mcpConfig), which a successful @harperfast/oauth reload
 * republishes; a reload that leaves no valid provider clears it (the per-request
 * check reports that as an unavailable refusal). This test exercises the republish
 * through Harper's config.yaml watcher rather than poking the module.
 */

import { describe, test, expect, afterAll } from "bun:test";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, symlinkSync, copyFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
  startHarper, stopHarpers, type HarperInstance, HARPER_STOP_BUDGET_MS,
} from "../helpers/harper-lifecycle.js";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SHIPPED_CONFIG = join(REPO_ROOT, "config.yaml");

const ISSUER_A = "https://issuer-a.flair.test";
const ISSUER_B = "https://issuer-b.flair.test";
const ISSUER_LINE = "    issuer: ${FLAIR_MCP_ISSUER}";
const REFUSAL_RULE = "(differs from FLAIR_MCP_ISSUER)";

let instances: HarperInstance[] = [];
let tempDirs: string[] = [];

function mcpServerEnv(values: Record<string, string> = {}): Record<string, string | undefined> {
  return {
    FLAIR_MCP_OAUTH: undefined,
    FLAIR_MCP_ISSUER: undefined,
    FLAIR_PUBLIC_URL: undefined,
    FLAIR_MCP_SIGNING_KEY_PEM: undefined,
    OAUTH_GITHUB_CLIENT_ID: undefined,
    OAUTH_GITHUB_CLIENT_SECRET: undefined,
    OAUTH_GITHUB_REDIRECT_URI: undefined,
    ...values,
  };
}

function makeWorkDir(prefix: string): string {
  const workDir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(workDir);
  symlinkSync(join(REPO_ROOT, "node_modules"), join(workDir, "node_modules"));
  symlinkSync(join(REPO_ROOT, "dist"), join(workDir, "dist"));
  cpSync(join(REPO_ROOT, "schemas"), join(workDir, "schemas"), { recursive: true });
  copyFileSync(SHIPPED_CONFIG, join(workDir, "config.yaml"));
  return workDir;
}

/** Rewrite one config.yaml line in place, the way an operator edits it. */
function rewriteIssuerLine(workDir: string, from: string, to: string): void {
  const path = join(workDir, "config.yaml");
  const before = readFileSync(path, "utf-8");
  expect(before).toContain(from);
  writeFileSync(path, before.replace(from, to), "utf-8");
}

/** Bounded wait for a condition; 60 × 250 ms. */
async function waitFor(label: string, probe: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${label}`);
}

afterAll(async () => {
  await stopHarpers(instances).catch(() => { /* best effort */ });
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}, HARPER_STOP_BUDGET_MS);

describe("flair#3032 — a changed live issuer is refused per request, then served again when restored", () => {
  test(
    "matching issuer → served; changed issuer → named refusal + reported state; restored → served",
    async () => {
      const workDir = makeWorkDir("flair-per-request-issuer-");
      const harper = await startHarper({
        cwd: workDir,
        harperBinDir: REPO_ROOT,
        serverEnv: mcpServerEnv({
          FLAIR_MCP_OAUTH: "true",
          FLAIR_MCP_ISSUER: ISSUER_A,
          OAUTH_GITHUB_CLIENT_ID: "per-request-issuer-client",
          OAUTH_GITHUB_CLIENT_SECRET: "per-request-issuer-secret",
          OAUTH_GITHUB_REDIRECT_URI: `${ISSUER_A}/oauth`,
        }),
      });
      instances.push(harper);

      expect((await fetch(harper.opsURL, { signal: AbortSignal.timeout(10_000) })).status).toBe(200);

      // ── Mint a token for /mcp (the issuer-change fixture) ──
      const verifier = randomBytes(32).toString("base64url");
      const clientId = "per-request-issuer-client";
      const redirectUri = `${ISSUER_A}/callback`;
      const opsAuth = "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64");
      for (const [table, records] of [
        ["harper_oauth_mcp_clients", [{
          client_id: clientId, grant_types: JSON.stringify(["authorization_code"]),
          response_types: JSON.stringify(["code"]), redirect_uris: JSON.stringify([redirectUri]),
          token_endpoint_auth_method: "none",
        }]],
        ["mcp_auth_codes", [{
          code: "per-request-issuer-code", client_id: clientId, user: "per-request-issuer-agent",
          resource: `${ISSUER_A}/mcp`, code_challenge: createHash("sha256").update(verifier).digest("base64url"),
          code_challenge_method: "S256", redirect_uri: redirectUri, scope: "", client_auth_method: "none",
        }]],
      ] as const) {
        const res = await fetch(harper.opsURL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: opsAuth },
          body: JSON.stringify({ operation: "insert", database: "oauth", table, records }),
          signal: AbortSignal.timeout(10_000),
        });
        expect(res.status).toBe(200);
      }
      const mintRes = await fetch(`${harper.httpURL}/oauth/mcp/token`, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId,
          code: "per-request-issuer-code", code_verifier: verifier, redirect_uri: redirectUri }).toString(),
        signal: AbortSignal.timeout(10_000),
      });
      expect(mintRes.status).toBe(200);
      const { access_token: token } = await mintRes.json() as { access_token: string };
      expect(typeof token).toBe("string");

      const postMcp = () => fetch(`${harper.httpURL}/mcp`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
        signal: AbortSignal.timeout(10_000),
      });
      const instancePage = async () => {
        const res = await fetch(`${harper.httpURL}/AdminInstance`, {
          headers: { Authorization: opsAuth }, signal: AbortSignal.timeout(10_000),
        });
        expect(res.status).toBe(200);
        return res.text();
      };

      // ── Baseline: matching issuer, requests are served, page shows the URL ──
      expect((await postMcp()).status).toBe(200);
      expect(await instancePage()).toContain("/mcp</code>");

      // ── Change the component's configured issuer while Harper runs ──
      rewriteIssuerLine(workDir, ISSUER_LINE, `    issuer: ${ISSUER_B}`);
      let refusalBody = "";
      await waitFor("the per-request issuer refusal", async () => {
        const res = await postMcp();
        if (res.status !== 503) return false;
        refusalBody = await res.text();
        return true;
      });
      expect(refusalBody).toContain(REFUSAL_RULE);
      expect(refusalBody).toContain("Set FLAIR_MCP_ISSUER and mcp.issuer to the same public origin");
      expect(refusalBody).not.toContain(ISSUER_A);
      expect(refusalBody).not.toContain(ISSUER_B);

      // The recorded state reports the refusal, not the mounted URL.
      const refusedPage = await instancePage();
      expect(refusedPage).toContain("Issuer refused");
      expect(refusedPage).toContain(REFUSAL_RULE);
      expect(refusedPage).not.toContain("/mcp</code>");

      // ── Restore the shipped env reference: served again, page reports mounted ──
      rewriteIssuerLine(workDir, `    issuer: ${ISSUER_B}`, ISSUER_LINE);
      await waitFor("requests to be served again", async () => (await postMcp()).status === 200);
      const restoredPage = await instancePage();
      expect(restoredPage).toContain("/mcp</code>");
      expect(restoredPage).not.toContain("Issuer refused");
    },
    300_000,
  );
});
