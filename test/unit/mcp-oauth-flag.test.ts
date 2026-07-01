/**
 * mcp-oauth-flag.test.ts — the FLAIR_MCP_OAUTH feature flag + AS config helpers.
 *
 * Pure env-driven logic (no Harper import), so it runs standalone. The
 * security-relevant assertions: the flag is OFF by default and for any
 * non-truthy value (so a typo can't silently enable an auth surface), and
 * mcpAuthConfig() returns undefined unless BOTH the flag is on AND an issuer is
 * configured (so withMCPAuth is never handed a half-configured, floating-issuer
 * config — the audience-confusion risk the plugin's checklist warns about).
 */

import { describe, it, expect, afterEach } from "bun:test";
import {
  mcpOAuthEnabled,
  mcpIssuer,
  mcpResource,
  mcpAuthConfig,
} from "../../resources/mcp-oauth-flag.ts";

const ENV_KEYS = ["FLAIR_MCP_OAUTH", "FLAIR_MCP_ISSUER", "FLAIR_PUBLIC_URL"];
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("mcpOAuthEnabled — default-OFF", () => {
  it("unset → OFF", () => {
    clearEnv();
    expect(mcpOAuthEnabled()).toBe(false);
  });

  it("empty string → OFF", () => {
    clearEnv();
    process.env.FLAIR_MCP_OAUTH = "";
    expect(mcpOAuthEnabled()).toBe(false);
  });

  it.each(["1", "true", "TRUE", "yes", "on", " On "])("truthy %p → ON", (v) => {
    clearEnv();
    process.env.FLAIR_MCP_OAUTH = v;
    expect(mcpOAuthEnabled()).toBe(true);
  });

  it.each(["0", "false", "no", "off", "enabled", "2", "y"])("non-truthy %p → OFF", (v) => {
    clearEnv();
    process.env.FLAIR_MCP_OAUTH = v;
    expect(mcpOAuthEnabled()).toBe(false);
  });
});

describe("mcpIssuer / mcpResource", () => {
  it("unset → undefined", () => {
    clearEnv();
    expect(mcpIssuer()).toBeUndefined();
    expect(mcpResource()).toBeUndefined();
  });

  it("FLAIR_MCP_ISSUER wins", () => {
    clearEnv();
    process.env.FLAIR_MCP_ISSUER = "https://flair.example.com";
    process.env.FLAIR_PUBLIC_URL = "https://other.example.com";
    expect(mcpIssuer()).toBe("https://flair.example.com");
  });

  it("falls back to FLAIR_PUBLIC_URL", () => {
    clearEnv();
    process.env.FLAIR_PUBLIC_URL = "https://pub.example.com";
    expect(mcpIssuer()).toBe("https://pub.example.com");
  });

  it("resource is issuer + /mcp (trailing slash trimmed)", () => {
    clearEnv();
    process.env.FLAIR_MCP_ISSUER = "https://flair.example.com/";
    expect(mcpResource()).toBe("https://flair.example.com/mcp");
  });
});

describe("mcpAuthConfig — requires flag ON *and* issuer set", () => {
  it("flag off → undefined (even with issuer)", () => {
    clearEnv();
    process.env.FLAIR_MCP_ISSUER = "https://flair.example.com";
    expect(mcpAuthConfig()).toBeUndefined();
  });

  it("flag on but no issuer → undefined (never a floating iss/aud)", () => {
    clearEnv();
    process.env.FLAIR_MCP_OAUTH = "1";
    expect(mcpAuthConfig()).toBeUndefined();
  });

  it("flag on + issuer → pinned enabled config", () => {
    clearEnv();
    process.env.FLAIR_MCP_OAUTH = "1";
    process.env.FLAIR_MCP_ISSUER = "https://flair.example.com";
    expect(mcpAuthConfig()).toEqual({
      enabled: true,
      issuer: "https://flair.example.com",
      resource: "https://flair.example.com/mcp",
    });
  });
});
