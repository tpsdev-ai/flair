/**
 * flair#2270 — the IdP redirect-URI variable: derive, migrate, degrade.
 *
 * Unit coverage for src/lib/mcp-oauth-env.ts. The behavioural, real-Harper side
 * of the same change lives in
 * test/integration-heavy/mcp-oauth-redirect-upgrade-2270.test.ts.
 *
 * Nothing here asserts a VALUE of a secret-shaped variable — only names,
 * booleans and the redirect itself (a public origin).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  idpEnvNames,
  isUnresolvedEnvValue,
  mcpOAuthEnabledIn,
  redirectUriForIssuer,
  guardMcpOAuthEnv,
  planRedirectMigration,
  describeMcpRedirectFinding,
  renderRedirectMigration,
} from "../../src/lib/mcp-oauth-env.ts";

const REDIRECT = idpEnvNames().redirectUri; // OAUTH_GITHUB_REDIRECT_URI

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "flair-2270-unit-"));
  writeFileSync(join(dir, "config.yaml"), "name: flair\n", "utf-8");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function envPath(): string {
  return join(dir, ".env");
}
function envText(): string {
  return readFileSync(envPath(), "utf-8");
}

describe("redirectUriForIssuer / isUnresolvedEnvValue", () => {
  test("derives origin + /oauth, dropping any path or trailing slash", () => {
    expect(redirectUriForIssuer("https://flair.example.com")).toBe("https://flair.example.com/oauth");
    expect(redirectUriForIssuer("https://flair.example.com/")).toBe("https://flair.example.com/oauth");
    expect(redirectUriForIssuer("https://flair.example.com:8443/whatever")).toBe("https://flair.example.com:8443/oauth");
    expect(redirectUriForIssuer("http://127.0.0.1:9926")).toBe("http://127.0.0.1:9926/oauth");
  });

  test("refuses a non-HTTP(S) or non-absolute issuer rather than inventing a value", () => {
    expect(redirectUriForIssuer("ftp://x")).toBeNull();
    expect(redirectUriForIssuer("not a url")).toBeNull();
    expect(redirectUriForIssuer("")).toBeNull();
    expect(redirectUriForIssuer(null)).toBeNull();
    expect(redirectUriForIssuer(undefined)).toBeNull();
  });

  test("blank and whole-token placeholders read as missing; real values do not", () => {
    expect(isUnresolvedEnvValue(undefined)).toBe(true);
    expect(isUnresolvedEnvValue("")).toBe(true);
    expect(isUnresolvedEnvValue("   ")).toBe(true);
    expect(isUnresolvedEnvValue("${OAUTH_GITHUB_REDIRECT_URI}")).toBe(true);
    expect(isUnresolvedEnvValue("https://flair.example.com/oauth")).toBe(false);
  });

  test("mcpOAuthEnabledIn mirrors flair's strict reader", () => {
    expect(mcpOAuthEnabledIn({ FLAIR_MCP_OAUTH: "true" })).toBe(true);
    expect(mcpOAuthEnabledIn({ FLAIR_MCP_OAUTH: "1" })).toBe(true);
    expect(mcpOAuthEnabledIn({ FLAIR_MCP_OAUTH: "maybe" })).toBe(false);
    expect(mcpOAuthEnabledIn({})).toBe(false);
  });
});

describe("guardMcpOAuthEnv — the degraded-start decision", () => {
  test("no-op when MCP is off", () => {
    const env = { OAUTH_GITHUB_CLIENT_ID: "c", OAUTH_GITHUB_CLIENT_SECRET: "s" };
    expect(guardMcpOAuthEnv(env).degraded).toBe(false);
    expect(env.OAUTH_GITHUB_CLIENT_ID).toBe("c");
  });

  test("no-op when the redirect is set", () => {
    const env = { FLAIR_MCP_OAUTH: "true", OAUTH_GITHUB_CLIENT_ID: "c", OAUTH_GITHUB_CLIENT_SECRET: "s", [REDIRECT]: "https://x/oauth" };
    expect(guardMcpOAuthEnv(env).degraded).toBe(false);
    expect(env.OAUTH_GITHUB_CLIENT_SECRET).toBe("s");
  });

  test("no-op when no credentials are staged (the provider is already unconfigured)", () => {
    const env = { FLAIR_MCP_OAUTH: "true", FLAIR_MCP_ISSUER: "https://x" };
    expect(guardMcpOAuthEnv(env).degraded).toBe(false);
  });

  test("degrades and neutralizes the provider when credentials are staged without a redirect", () => {
    const env = { FLAIR_MCP_OAUTH: "true", OAUTH_GITHUB_CLIENT_ID: "CREDVAL", OAUTH_GITHUB_CLIENT_SECRET: "CREDVAL" };
    const decision = guardMcpOAuthEnv(env);
    expect(decision.degraded).toBe(true);
    expect(decision.reason).toContain(REDIRECT);
    expect(decision.neutralizedVars).toEqual(["OAUTH_GITHUB_CLIENT_ID", "OAUTH_GITHUB_CLIENT_SECRET"]);
    // The credential variables are gone, so @harperfast/oauth skips the
    // provider instead of throwing and taking the instance down.
    expect(env.OAUTH_GITHUB_CLIENT_ID).toBeUndefined();
    expect(env.OAUTH_GITHUB_CLIENT_SECRET).toBeUndefined();
    // Never surfaces a value.
    expect(JSON.stringify(decision)).not.toContain("CREDVAL");
  });

  test("a placeholder-valued redirect is treated as missing", () => {
    const env = { FLAIR_MCP_OAUTH: "true", OAUTH_GITHUB_CLIENT_ID: "c", OAUTH_GITHUB_CLIENT_SECRET: "s", [REDIRECT]: "${" + REDIRECT + "}" };
    expect(guardMcpOAuthEnv(env).degraded).toBe(true);
  });
});

describe("planRedirectMigration — the upgrade path", () => {
  test("not-enabled when MCP is off and nothing was advertised", () => {
    const r = planRedirectMigration({ configPath: join(dir, "config.yaml"), env: { OAUTH_GITHUB_CLIENT_ID: "c", OAUTH_GITHUB_CLIENT_SECRET: "s" } });
    expect(r.action).toBe("not-enabled");
    expect(existsSync(envPath())).toBe(false);
  });

  test("already-set leaves an existing value verbatim", () => {
    writeFileSync(envPath(), `${REDIRECT}=https://kept.example.com/oauth\n`, { mode: 0o600 });
    const r = planRedirectMigration({
      configPath: join(dir, "config.yaml"),
      env: { FLAIR_MCP_OAUTH: "true", FLAIR_MCP_ISSUER: "https://derived.example.com", OAUTH_GITHUB_CLIENT_ID: "c", OAUTH_GITHUB_CLIENT_SECRET: "s" },
    });
    expect(r.action).toBe("already-set");
    expect(envText()).toContain("https://kept.example.com/oauth");
  });

  test("stages the redirect derived from the issuer, and never returns the value", () => {
    const r = planRedirectMigration({
      configPath: join(dir, "config.yaml"),
      env: { FLAIR_MCP_OAUTH: "true", FLAIR_MCP_ISSUER: "https://flair.example.com", OAUTH_GITHUB_CLIENT_ID: "c", OAUTH_GITHUB_CLIENT_SECRET: "s" },
    });
    expect(r.action).toBe("staged");
    expect(r.wrote).toBe(true);
    expect(envText()).toContain(`${REDIRECT}=https://flair.example.com/oauth`);
    // The result object carries names/paths only.
    expect(JSON.stringify(r)).not.toContain("flair.example.com");
  });

  test("no-issuer does not write (an unknown issuer is never guessed)", () => {
    const r = planRedirectMigration({
      configPath: join(dir, "config.yaml"),
      env: { FLAIR_MCP_OAUTH: "true", OAUTH_GITHUB_CLIENT_ID: "c", OAUTH_GITHUB_CLIENT_SECRET: "s" },
    });
    expect(r.action).toBe("no-issuer");
    expect(existsSync(envPath())).toBe(false);
  });

  test("no-credentials does not stage a redirect for a provider that is not configured", () => {
    const r = planRedirectMigration({
      configPath: join(dir, "config.yaml"),
      env: { FLAIR_MCP_OAUTH: "true", FLAIR_MCP_ISSUER: "https://flair.example.com" },
    });
    expect(r.action).toBe("no-credentials");
    expect(existsSync(envPath())).toBe(false);
  });

  test("an advertised issuer drives the migration even when the CLI env carries no MCP flag", () => {
    const r = planRedirectMigration({
      configPath: join(dir, "config.yaml"),
      env: {},
      advertisedIssuer: "https://flair.example.com",
    });
    expect(r.action).toBe("staged");
    expect(envText()).toContain(`${REDIRECT}=https://flair.example.com/oauth`);
  });

  test("renderRedirectMigration names the variable, never the value", () => {
    const r = planRedirectMigration({
      configPath: join(dir, "config.yaml"),
      env: { FLAIR_MCP_OAUTH: "true", FLAIR_MCP_ISSUER: "https://flair.example.com", OAUTH_GITHUB_CLIENT_ID: "c", OAUTH_GITHUB_CLIENT_SECRET: "s" },
    });
    const line = renderRedirectMigration(r);
    expect(line).toContain(REDIRECT);
    expect(line).not.toContain("flair.example.com");
  });
});

describe("describeMcpRedirectFinding — flair doctor", () => {
  test("no finding when MCP is off", () => {
    expect(describeMcpRedirectFinding({ mcpEnabled: false, presentVarNames: ["OAUTH_GITHUB_CLIENT_ID", "OAUTH_GITHUB_CLIENT_SECRET"], advertisedIssuer: "https://x" })).toBeNull();
  });

  test("no finding when the redirect is present", () => {
    expect(describeMcpRedirectFinding({ mcpEnabled: true, presentVarNames: [REDIRECT, "OAUTH_GITHUB_CLIENT_ID"], advertisedIssuer: "https://x" })).toBeNull();
  });

  test("no finding when no credentials are staged", () => {
    expect(describeMcpRedirectFinding({ mcpEnabled: true, presentVarNames: ["FLAIR_MCP_OAUTH"], advertisedIssuer: "https://x" })).toBeNull();
  });

  test("reports the missing variable by name with the one-step remedy", () => {
    const f = describeMcpRedirectFinding({
      mcpEnabled: true,
      presentVarNames: ["FLAIR_MCP_OAUTH", "OAUTH_GITHUB_CLIENT_ID", "OAUTH_GITHUB_CLIENT_SECRET"],
      advertisedIssuer: "https://flair.example.com",
    })!;
    expect(f.isIssue).toBe(true);
    expect(f.message).toContain(REDIRECT);
    expect(f.fixHint).toContain(REDIRECT);
    expect(f.fixHint).toContain("flair mcp enable");
  });
});
