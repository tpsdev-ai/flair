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
 *     NOT pretend. It leaves the 0600 staged file for manual application and fails:
 *     the FUNCTION returns `{ ok: false }`, which the `flair mcp enable` CLI turns
 *     into a non-zero exit. This file asserts the staged file's bytes, its 0600 mode,
 *     and the failed step.
 *
 *   CI boots the OSS harness, which answers with no secrets custody, so CI exercises
 *   only the refusal branch. The push-success branch is asserted here from the same
 *   recorded evidence, but CI does not run it — this file does not claim it did.
 *
 * `resolveOpsUrl` sends a loopback served origin's ops calls to HOSTED_OPS_PORT
 * (9925); a routing fetch rewrites that origin to the harness's REAL ops port, so the
 * actual ops API is exercised. Discovery reads (only reached on the push-success
 * branch) stay at the served origin, which is also real.
 *
 * The routing fetch records an exchange only after its response body is read (a
 * router that threw before its fetch resolved, or a response whose body was never
 * read, records nothing), so the assertions below are
 * made against the request refresh ITSELF issues — its own capability probe — and
 * against Harper's own answer to it, rather than a probe this file runs separately.
 * A fetch that broke the ops route (rejecting every ops request) would leave no such
 * exchange and no refusal text, and would fail this file.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, copyFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarpers, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle.js";
import { refreshMcpOAuthFlag, resolveOpsUrl } from "../../src/lib/mcp-enable.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SHIPPED_CONFIG = join(REPO_ROOT, "config.yaml");

let instances: HarperInstance[] = [];
let tempDirs: string[] = [];

// ── Server env: each boot declares the whole FLAIR_MCP_* set ────────────────
// The shipped config references the environment, so an ambient value on the
// runner would change what this boot sees. An `undefined` value removes an
// inherited one.
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

afterAll(async () => {
  // flair#2568: every instance this file started, stopped concurrently (one
  // stop deadline for the set, not one per instance); best effort, as before.
  await stopHarpers(instances).catch(() => { /* best effort */ });
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  instances = [];
  tempDirs = [];
}, HARPER_STOP_BUDGET_MS);

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

/** An ops exchange refresh itself made, recorded as it passes through the router. */
interface OpsExchange {
  url: string;
  operation: string | null;
  status: number;
  body: string;
}

/** Rewrite ops calls that resolve to HOSTED_OPS_PORT to the harness's real ops
 *  port; pass every other request (the served origin, i.e. discovery) through.
 *  An ops exchange is recorded only after its response body is read, so the test
 *  can assert on the request refresh ITSELF issued and on Harper's own answer to it. */
function routingFetch(harper: HarperInstance, record: OpsExchange[]): typeof fetch {
  const hostedOrigin = new URL(resolveOpsUrl(harper.httpURL)).origin;
  const realOpsOrigin = new URL(harper.opsURL).origin;
  return (async (input: any, init: any) => {
    const raw = typeof input === "string" ? input : input.url;
    const u = new URL(raw);
    if (u.origin === hostedOrigin) {
      const res = await fetch(`${realOpsOrigin}${u.pathname}${u.search}`, init);
      let operation: string | null = null;
      try {
        operation = JSON.parse(String(init?.body ?? ""))?.operation ?? null;
      } catch {
        /* non-JSON ops body — record it without an operation name */
      }
      record.push({ url: `${realOpsOrigin}${u.pathname}`, operation, status: res.status, body: await res.clone().text() });
      return res;
    }
    return fetch(raw, init);
  }) as typeof fetch;
}

describe("flair#2283 — refreshMcpOAuthFlag against the real Harper harness", () => {
  test(
    "the target's real capability decides the branch: push+marker+restart+discovery, or the staged 0600 file and { ok: false }",
    async () => {
      const workDir = makeWorkDir("flair-2283-refresh-real-");
      const harper = await startHarper({
        cwd: workDir,
        harperBinDir: REPO_ROOT,
        // The migration's starting state: the legacy value that leaves the component AS disabled.
        serverEnv: mcpServerEnv({
          FLAIR_MCP_OAUTH: "1",
          FLAIR_MCP_ISSUER: "https://refresh-2283.test",
        }),
      });
      instances.push(harper);

      const stagedPath = join(workDir, "refresh.env");
      rmSync(stagedPath, { force: true });
      const opsCalls: OpsExchange[] = [];
      const result = await refreshMcpOAuthFlag(
        {
          instance: harper.httpURL, // a REAL loopback served origin
          adminUser: harper.admin.username,
          adminPass: harper.admin.password,
          secretsStagingPath: stagedPath,
        },
        { fetchImpl: routingFetch(harper, opsCalls), waitForOpsApiTimeoutMs: 60_000, waitForOpsApiPollMs: 250 },
      );

      // ── refresh ITSELF reached the target's ops API ────────────────────────
      // This records the request refresh issued; the unit file
      // (test/unit/mcp-refresh-flag-2283.test.ts) replaces exactly this request with a
      // fake. An empty recording means refresh never got to the real ops API (a
      // broken route), which every assertion below depends on.
      const capCall = opsCalls.find((c) => c.operation === "get_secrets_public_key");
      expect(capCall, "refresh must issue its own get_secrets_public_key to the target's real ops API").toBeDefined();
      const provisionDetail = result.steps.find((s) => s.step === "secrets-provisioning")?.detail ?? "";

      if (/BEGIN PUBLIC KEY/.test(capCall!.body)) {
        // ── Supported branch: the push, the marker read-back, the restart, the
        //    discovery checks — and NO fallback file, because the push landed ────
        expect(capCall!.status).toBeGreaterThanOrEqual(200);
        expect(capCall!.status).toBeLessThan(300);
        expect(result.ok).toBe(true);
        expect(result.steps.find((s) => s.step === "secrets-provisioning")?.ok).toBe(true);
        expect(provisionDetail).toContain("pushed");
        // refresh ITSELF recorded the set_secret push and the marker read-back.
        expect(opsCalls.some((c) => c.operation === "set_secret")).toBe(true);
        expect(opsCalls.some((c) => c.operation === "search_by_value")).toBe(true);
        expect(result.steps.some((s) => s.step === "restart" && s.ok)).toBe(true);
        // The restart was VERIFIED by PID change, not merely requested.
        const verify = result.steps.find((s) => s.step === "verify-restart");
        expect(verify?.ok).toBe(true);
        expect(verify?.detail).toMatch(/pid changed \d+ -> \d+/);
        // Both discovery checks ran and passed.
        expect(result.steps.find((s) => s.step === "issuer-target-binding")?.ok).toBe(true);
        expect(result.steps.find((s) => s.step === "self-verify")?.ok).toBe(true);
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
        // flair#2283 round 9: the push LANDED, so refresh wrote no fallback file and
        // names none. A staged file here would mean it fell back despite the push.
        expect(existsSync(stagedPath)).toBe(false);
        expect(result.secretsPath).toBeUndefined();
      } else {
        // ── Unsupported branch: fail closed, leave the 0600 file, return { ok: false }
        // Harper refused the capability probe with ITS OWN words; refresh must carry
        // that refusal, not invent one.
        expect(capCall!.status).toBe(400);
        expect(capCall!.body).toContain("secrets custody is not initialized on this node");
        expect(result.ok).toBe(false);
        expect(result.failedStep).toBe("secrets-provisioning");
        expect(provisionDetail).toContain("secrets custody is not initialized on this node");
        // The refusal names the staged file, and the file is really on disk at 0600
        // carrying the requested flag update.
        expect(provisionDetail).toContain(stagedPath);
        expect(existsSync(stagedPath)).toBe(true);
        expect(readFileSync(stagedPath, "utf8")).toBe("FLAIR_MCP_OAUTH=true\n");
        expect(statSync(stagedPath).mode & 0o777).toBe(0o600);
        // The refusal wrote the fallback, so the result NAMES the file it staged.
        expect(result.secretsPath).toBe(stagedPath);
        // And it never claimed to have restarted: the fallback stops before the
        // restart, so no restart step is recorded.
        expect(result.steps.some((s) => s.step === "restart")).toBe(false);
      }
    },
    300_000,
  );
});
