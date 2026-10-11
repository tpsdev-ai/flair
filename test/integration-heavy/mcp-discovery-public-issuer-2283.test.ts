/**
 * mcp-discovery-public-issuer-2283.test.ts — flair#2283, blocker 1, against REAL
 * Harper.
 *
 * The discriminator compares a discovery document's strings against an issuer the
 * CALLER knows independently of the document (the configured `FLAIR_PUBLIC_URL` /
 * `FLAIR_MCP_ISSUER`), while doctor and deploy reach the instance over loopback.
 * Flair advertises `FLAIR_PUBLIC_URL` (its own AS) and `FLAIR_MCP_ISSUER` (the
 * @harperfast/oauth plugin's AS) — both PUBLIC origins. Comparing the token
 * endpoint against the probed loopback address alone turned a configured instance
 * serving flair's own AS into "unrecognized" instead of the named failure, and a
 * live plugin document into "unrecognized" too.
 *
 * This boots the SHIPPED component against a public issuer distinct from its local
 * address — the repo's hermetic Harper boot harness — and drives both the
 * discriminator (with the public issuer supplied as a caller-known candidate) and
 * the real `flair doctor` command.
 */
import { describe, test, expect, beforeAll, afterEach, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, copyFileSync, cpSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle.js";
import { childOverranDeadline } from "../helpers/child-deadline.ts";
import { discriminateMcpOAuthDiscovery, reportMcpOAuthDiscovery } from "../../src/lib/mcp-enable.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SHIPPED_CONFIG = join(REPO_ROOT, "config.yaml");
const CLI_ENTRY = join(REPO_ROOT, "src", "cli.ts");
/** Two public origins, NEITHER of them the 127.0.0.1 address Harper binds. */
const FLAIR_PUBLIC = "https://flair-2283-public.test";
const PLUGIN_ISSUER = "https://flair-2283-plugin.test";

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
  copyFileSync(SHIPPED_CONFIG, join(workDir, "config.yaml"));
  // config.yaml loads schemas/*.graphql from the app dir; copied (not linked):
  // Harper's schema glob does not follow a symlinked directory.
  cpSync(join(REPO_ROOT, "schemas"), join(workDir, "schemas"), { recursive: true });
  return workDir;
}

/** Run the real `flair doctor` against a booted Harper's HTTP port. */
function runDoctor(httpURL: string, extraEnv: Record<string, string>): { status: number | null; stdout: string } {
  const home = mkdtempSync(join(tmpdir(), "flair-2283-doctor-public-"));
  tempDirs.push(home);
  // A minimal PATH (a bare `sh`), as test/helpers/offline-doctor.ts does.
  const bin = join(home, "bin");
  mkdirSync(bin);
  symlinkSync("/bin/sh", join(bin, "sh"));
  const port = new URL(httpURL).port;
  const env: Record<string, string> = {
    HOME: home,
    USERPROFILE: home,
    TMPDIR: home,
    NO_COLOR: "1",
    PATH: bin,
    ...extraEnv,
  };
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [CLI_ENTRY, "doctor", "--port", port], {
    cwd: home,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error || result.signal !== null) {
    throw new Error(childOverranDeadline("flair CLI", "doctor", 30_000, { ...result, elapsedMs: Date.now() - startedAt }));
  }
  return { status: result.status, stdout: result.stdout.replace(/\x1b\[[0-9;]*m/g, "") };
}

async function wellKnown(httpURL: string): Promise<any> {
  const res = await fetch(`${httpURL}/.well-known/oauth-authorization-server`, { signal: AbortSignal.timeout(10_000) });
  expect(res.status).toBe(200);
  return res.json();
}

describe("flair#2283 — a configured instance whose document advertises a PUBLIC issuer", () => {
  test(
    "flair's own AS (FLAIR_PUBLIC_URL ≠ the probed address) is the named failure, not 'unrecognized'",
    async () => {
      clearMcpEnv();
      process.env.FLAIR_PUBLIC_URL = FLAIR_PUBLIC; // the flag stays OFF → flair's own AS
      const workDir = makeWorkDir("flair-2283-public-own-");
      const harper = await startHarper({ cwd: workDir, harperBinDir: REPO_ROOT });
      instances.push(harper);

      // The instance really is reachable on loopback, but the document it serves
      // advertises the public origin — the exact divergence blocker 1 is about.
      expect(new URL(harper.httpURL).hostname).toBe("127.0.0.1");
      expect(new URL(harper.httpURL).origin).not.toBe(FLAIR_PUBLIC);

      const doc = await wellKnown(harper.httpURL);
      expect(doc.issuer).toBe(FLAIR_PUBLIC);
      expect(doc.token_endpoint).toBe(`${FLAIR_PUBLIC}/OAuthToken`);

      // The discriminator, probed over loopback, recognises flair's own AS by the
      // issuer the document advertises — supplied here as a caller-known candidate.
      const observation = await discriminateMcpOAuthDiscovery(harper.httpURL, { expectedIssuers: [FLAIR_PUBLIC] });
      expect(observation.issuer).toBe(FLAIR_PUBLIC);
      expect(observation.state).toBe("plugin-absent");
      const report = reportMcpOAuthDiscovery(observation, true);
      expect(report.severity).toBe("error");

      // And the whole doctor command, run against the real instance, reports the
      // named failure (not an unconfirmed "unrecognized" warning). The public
      // origin is supplied to doctor's environment as the caller-known issuer.
      clearMcpEnv();
      const doctor = runDoctor(harper.httpURL, { FLAIR_MCP_OAUTH: "true", FLAIR_PUBLIC_URL: FLAIR_PUBLIC });
      expect(doctor.stdout).toContain("FLAIR_MCP_OAUTH is set but the MCP authorization server is absent");
      expect(doctor.stdout).not.toContain("could not be confirmed");
      expect(doctor.status).not.toBe(0);
    },
    180_000,
  );

  test(
    "the live plugin document (FLAIR_MCP_ISSUER ≠ the probed address) is a pass",
    async () => {
      clearMcpEnv();
      process.env.FLAIR_MCP_OAUTH = "true";
      process.env.FLAIR_MCP_ISSUER = PLUGIN_ISSUER;
      process.env.OAUTH_GITHUB_CLIENT_ID = "public-issuer-2283-client";
      process.env.OAUTH_GITHUB_CLIENT_SECRET = "public-issuer-2283-secret";
      process.env.OAUTH_GITHUB_REDIRECT_URI = `${PLUGIN_ISSUER}/oauth`;
      const workDir = makeWorkDir("flair-2283-public-live-");
      const harper = await startHarper({ cwd: workDir, harperBinDir: REPO_ROOT });
      instances.push(harper);

      const doc = await wellKnown(harper.httpURL);
      expect(doc.issuer).toBe(PLUGIN_ISSUER);
      expect(doc.token_endpoint).toBe(`${PLUGIN_ISSUER}/oauth/mcp/token`);

      const observation = await discriminateMcpOAuthDiscovery(harper.httpURL, { expectedIssuers: [PLUGIN_ISSUER] });
      expect(observation.issuer).toBe(PLUGIN_ISSUER);
      expect(observation.state).toBe("plugin-live");

      clearMcpEnv();
      const doctor = runDoctor(harper.httpURL, { FLAIR_MCP_OAUTH: "true", FLAIR_MCP_ISSUER: PLUGIN_ISSUER });
      expect(doctor.stdout).toContain("the metadata advertises the expected token endpoint");
      expect(doctor.stdout).not.toContain("FLAIR_MCP_OAUTH is set but the MCP authorization server is absent");
    },
    180_000,
  );

  // Item 3: the flag and the public issuers supplied through the component `.env`
  // file — the file Harper's `loadEnv` reads (shipped config.yaml declares
  // `loadEnv.files: .env`) — rather than this test's process environment. This
  // proves the real instance reads them from the component directory and serves the
  // plugin's document with that public issuer.
  test(
    "the flag and public issuers supplied through the component .env file (not process.env)",
    async () => {
      clearMcpEnv();
      const workDir = makeWorkDir("flair-2283-env-");
      writeFileSync(
        join(workDir, ".env"),
        [
          "FLAIR_MCP_OAUTH=true",
          `FLAIR_MCP_ISSUER=${PLUGIN_ISSUER}`,
          "OAUTH_GITHUB_CLIENT_ID=public-issuer-2283-client",
          "OAUTH_GITHUB_CLIENT_SECRET=public-issuer-2283-secret",
          `OAUTH_GITHUB_REDIRECT_URI=${PLUGIN_ISSUER}/oauth`,
          "",
        ].join("\n"),
      );
      const harper = await startHarper({ cwd: workDir, harperBinDir: REPO_ROOT });
      instances.push(harper);

      const doc = await wellKnown(harper.httpURL);
      expect(doc.issuer).toBe(PLUGIN_ISSUER);
      expect(doc.token_endpoint).toBe(`${PLUGIN_ISSUER}/oauth/mcp/token`);

      const observation = await discriminateMcpOAuthDiscovery(harper.httpURL, { expectedIssuers: [PLUGIN_ISSUER] });
      expect(observation.state).toBe("plugin-live");
    },
    180_000,
  );
});
