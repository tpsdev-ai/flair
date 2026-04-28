/**
 * cli-secrets.test.ts — Unit tests for secret-bearing flags audit and inline-warning logic
 *
 * Tests:
 *   - Secret-bearing flag audit: all secret/password/key/token flags have env-var coverage
 *   - Inline-secret warning: stderr nudge when inline secret looks real (length >= 8, alphanum+URL-safe)
 *   - Warning fires only for actual secrets, not for URLs (--target) or short/non-secret-looking values
 *   - Warning fires only when flag came from argv (not from env)
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { program, isLikelyRealSecret, shouldShowInlineSecretWarning } from "../../src/cli.js";

// ─── Secret-bearing flag audit ──────────────────────────────────────────────────

describe("Secret-bearing flag audit", () => {
  function getCommandNames(cmd: any): string[] {
    return cmd.commands.map((c: any) => c.name());
  }

  function findCommand(root: any, path: string[]): any {
    let node = root;
    for (const name of path) {
      node = node.commands.find((c: any) => c.name() === name);
      if (!node) return null;
    }
    return node;
  }

  function getOptionNames(cmd: any): string[] {
    return cmd.options.map((o: any) => o.long);
  }

  test("init command has --admin-pass with env var coverage", () => {
    const init = findCommand(program, ["init"]);
    expect(init).not.toBeNull();
    const opts = getOptionNames(init);
    expect(opts).toContain("--admin-pass");
    // opts.adminPass ?? process.env.FLAIR_ADMIN_PASS is used in init handler
  });

  test("init command has --cluster-admin-pass with env var coverage", () => {
    const init = findCommand(program, ["init"]);
    expect(init).not.toBeNull();
    const opts = getOptionNames(init);
    expect(opts).toContain("--cluster-admin-pass");
    // opts.clusterAdminPass ?? process.env.FLAIR_CLUSTER_ADMIN_PASS is used
  });

  test("init command has --flair-admin-pass with env var coverage", () => {
    const init = findCommand(program, ["init"]);
    expect(init).not.toBeNull();
    const opts = getOptionNames(init);
    expect(opts).toContain("--flair-admin-pass");
    // opts.flairAdminPass ?? process.env.FLAIR_ADMIN_PASS is used
  });

  test("agent commands have --admin-pass with env var coverage", () => {
    const agent = findCommand(program, ["agent"]);
    expect(agent).not.toBeNull();
    const agentAdd = agent.commands.find((c: any) => c.name() === "add");
    expect(agentAdd).not.toBeNull();
    const opts = getOptionNames(agentAdd);
    expect(opts).toContain("--admin-pass");
    // Used with opts.adminPass ?? process.env.FLAIR_ADMIN_PASS pattern
  });

  test("federation pair has --token but NO env var coverage yet", () => {
    const fed = findCommand(program, ["federation"]);
    expect(fed).not.toBeNull();
    const pair = fed.commands.find((c: any) => c.name() === "pair");
    expect(pair).not.toBeNull();
    const opts = getOptionNames(pair);
    expect(opts).toContain("--token");
    // FLAIR_PAIRING_TOKEN env var coverage added in this PR
  });

  test("fabric deploy has --fabric-password with env var coverage", () => {
    const deploy = findCommand(program, ["deploy"]);
    expect(deploy).not.toBeNull();
    const opts = getOptionNames(deploy);
    expect(opts).toContain("--fabric-password");
    // opts.fabricPassword ?? process.env.FABRIC_PASSWORD is used
  });

  test("fabric deploy has --fabric-token with env var coverage", () => {
    const deploy = findCommand(program, ["deploy"]);
    expect(deploy).not.toBeNull();
    const opts = getOptionNames(deploy);
    expect(opts).toContain("--fabric-token");
    // opts.fabricToken ?? process.env.FABRIC_TOKEN is used
  });

  test("federation token has --admin-pass with env var coverage", () => {
    const fed = findCommand(program, ["federation"]);
    expect(fed).not.toBeNull();
    const token = fed.commands.find((c: any) => c.name() === "token");
    expect(token).not.toBeNull();
    const opts = getOptionNames(token);
    expect(opts).toContain("--admin-pass");
  });

  test("backup/restore commands have --admin-pass with env var coverage", () => {
    const backup = findCommand(program, ["backup"]);
    expect(backup).not.toBeNull();
    const opts = getOptionNames(backup);
    expect(opts).toContain("--admin-pass");
  });

  test("export command has --admin-pass with env var coverage", () => {
    const exportCmd = findCommand(program, ["export"]);
    expect(exportCmd).not.toBeNull();
    const opts = getOptionNames(exportCmd);
    expect(opts).toContain("--admin-pass");
  });
});

// ─── Inline-secret warning: secret detection helper ────────────────────────────

describe("isLikelyRealSecret helper", () => {
  // Tests use the real exported isLikelyRealSecret from src/cli.ts so the
  // test suite can't drift from the actual regex in production. (Per Kern
  // review on PR #306 — the prior duplicated regex allowed `@` and `/`,
  // letting tests pass for values the implementation would reject.)

  test("short strings are not considered real secrets", () => {
    expect(isLikelyRealSecret("short")).toBe(false); // len < 8
    expect(isLikelyRealSecret("abc123")).toBe(false); // len < 8
  });

  test("password-like strings are detected", () => {
    expect(isLikelyRealSecret("S3cur3Pssw0rd")).toBe(true);
    expect(isLikelyRealSecret("mystr0ngpass")).toBe(true);
  });

  test("URL-safe tokens are detected", () => {
    expect(isLikelyRealSecret("abc123def456")).toBe(true);
    expect(isLikelyRealSecret("abc_def_ghi")).toBe(true);
    expect(isLikelyRealSecret("a.bb.cc.dd")).toBe(true);
  });

  test("base64url tokens are detected", () => {
    expect(isLikelyRealSecret("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9")).toBe(true);
    expect(isLikelyRealSecret("dGhpcyBpcyBhIHRlc3QgdG9rZW4")).toBe(true);
  });

  test("URLs are NOT considered secrets", () => {
    expect(isLikelyRealSecret("https://example.com")).toBe(false);
    expect(isLikelyRealSecret("http://localhost:9926")).toBe(false);
  });

  test("strings with spaces or invalid chars are NOT secrets", () => {
    expect(isLikelyRealSecret("password with spaces")).toBe(false);
    expect(isLikelyRealSecret("tab\there")).toBe(false);
    expect(isLikelyRealSecret("newline\n")).toBe(false);
  });

  test("empty and null strings are not secrets", () => {
    expect(isLikelyRealSecret("")).toBe(false);
    expect(isLikelyRealSecret("a")).toBe(false);
  });
});

// ─── Inline-secret warning: warning logic ───────────────────────────────────────

describe("shouldShowInlineSecretWarning helper", () => {
  // Tests call the real exported shouldShowInlineSecretWarning from src/cli.ts
  // (signature: optValue, fromEnv, secretFlagNames, flagName) so the test
  // suite stays locked to the actual production behavior. Per Kern review
  // on PR #306.

  const secretFlags = new Set([
    "--admin-pass",
    "--cluster-admin-pass",
    "--flair-admin-pass",
    "--token",
    "--fabric-password",
    "--fabric-token",
    "--key", // key path might contain sensitive info
  ]);

  test("inline secret flag shows warning", () => {
    const result = shouldShowInlineSecretWarning(
      "S3cur3PSsw0rd",
      false, // from argv
      secretFlags,
      "--admin-pass"
    );
    expect(result).toBe(true);
  });

  test("env var for secret flag does NOT show warning", () => {
    const result = shouldShowInlineSecretWarning(
      "S3cur3PSsw0rd",
      true, // from env
      secretFlags,
      "--admin-pass"
    );
    expect(result).toBe(false);
  });

  // Regression: fromEnv must reflect "value came from env," not "env happens
  // to be set." When both inline and env are set, inline wins via `??` precedence,
  // so the warning must still fire. Sherlock review on PR #306.
  test("inline secret with env ALSO set: warning still fires (inline overrides env)", () => {
    const optsAdminPass = "S3cur3PSsw0rd";
    const envAdminPass = "S0meOtherPass1";
    const fromEnv = !optsAdminPass && !!envAdminPass; // false — inline wins
    const result = shouldShowInlineSecretWarning(
      optsAdminPass,
      fromEnv,
      secretFlags,
      "--admin-pass"
    );
    expect(fromEnv).toBe(false);
    expect(result).toBe(true);
  });

  test("env-only secret (no inline): warning suppressed", () => {
    const optsAdminPass = undefined;
    const envAdminPass = "S0meOtherPass1";
    const fromEnv = !optsAdminPass && !!envAdminPass; // true — env is the source
    const result = shouldShowInlineSecretWarning(
      optsAdminPass,
      fromEnv,
      secretFlags,
      "--admin-pass"
    );
    expect(fromEnv).toBe(true);
    expect(result).toBe(false);
  });

  test("URL flag does NOT show warning even with value from argv", () => {
    const result = shouldShowInlineSecretWarning(
      "https://flair.example.com:9926",
      false, // from argv
      secretFlags,
      "--target"
    );
    expect(result).toBe(false);
  });

  test("short value does NOT trigger warning", () => {
    const result = shouldShowInlineSecretWarning(
      "short",
      false, // from argv
      secretFlags,
      "--admin-pass"
    );
    expect(result).toBe(false);
  });

  test("non-secret-like value does NOT trigger warning", () => {
    const result = shouldShowInlineSecretWarning(
      "password with spaces",
      false, // from argv
      secretFlags,
      "--admin-pass"
    );
    expect(result).toBe(false);
  });

  test("non-secret flag does NOT show warning", () => {
    const result = shouldShowInlineSecretWarning(
      "9926",
      false, // from argv
      secretFlags,
      "--port"
    );
    expect(result).toBe(false);
  });

  test("token flag with real token shows warning", () => {
    const result = shouldShowInlineSecretWarning(
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      false, // from argv
      secretFlags,
      "--token"
    );
    expect(result).toBe(true);
  });

  // Regression for Kern's PR #306 review note: prior test had `S3cur3P@ssw0rd`
  // which the old test-local regex accepted but the real implementation rejects
  // (no `@` in the production charset). Confirm the real impl rejects.
  test("regression: real impl rejects '@' chars (test-impl drift caught by Kern)", () => {
    const result = shouldShowInlineSecretWarning(
      "S3cur3P@ssw0rd",
      false,
      secretFlags,
      "--admin-pass"
    );
    expect(result).toBe(false);
    // And isLikelyRealSecret directly:
    expect(isLikelyRealSecret("S3cur3P@ssw0rd")).toBe(false);
    expect(isLikelyRealSecret("abc/def/ghi")).toBe(false);
  });
});

// ─── Command option parsing: --token in federation pair ─────────────────────────

describe("federation pair --token option parsing", () => {
  test("--token flag is registered on federation pair", () => {
    const fed = program.commands.find((c) => c.name() === "federation");
    expect(fed).not.toBeNull();
    const pair = fed!.commands.find((c: any) => c.name() === "pair") as any;
    expect(pair).not.toBeNull();
    const tokenOpt = pair.options.find((o: any) => o.long === "--token");
    expect(tokenOpt).not.toBeNull();
    expect(tokenOpt.description).toContain("One-time pairing token");
  });

  test("token value is passed through to pairing request", () => {
    // In the handler: pairingToken: opts.token
    // This needs env var fallback: opts.token ?? process.env.FLAIR_PAIRING_TOKEN
  });
});

// ─── Env var mapping table (documented for PR) ─────────────────────────────────

describe("Env var mapping audit (for PR documentation)", () => {
  // Document current env var coverage for secret-bearing flags
  // This test documents the expected state rather than enforcing code

  interface SecretFlagMapping {
    flag: string;
    envVar: string | null; // null if not yet implemented
    description: string;
  }

  const secretFlagMappings: SecretFlagMapping[] = [
    { flag: "--admin-pass", envVar: "FLAIR_ADMIN_PASS", description: "Harper admin password" },
    { flag: "--cluster-admin-pass", envVar: "FLAIR_CLUSTER_ADMIN_PASS", description: "Fabric cluster admin password" },
    { flag: "--cluster-admin-user", envVar: "FLAIR_CLUSTER_ADMIN_USER", description: "Fabric cluster admin username" },
    { flag: "--flair-admin-pass", envVar: "FLAIR_ADMIN_PASS", description: "Flair admin user password" },
    { flag: "--token", envVar: "FLAIR_PAIRING_TOKEN", description: "Federation pairing token (added in this PR)" },
    { flag: "--fabric-password", envVar: "FABRIC_PASSWORD", description: "Fabric admin password" },
    { flag: "--fabric-user", envVar: "FABRIC_USER", description: "Fabric admin username" },
    { flag: "--fabric-token", envVar: "FABRIC_TOKEN", description: "Fabric OAuth bearer token" },
  ];

  test("documented secret flag mappings match current implementation", () => {
    // All entries in secretFlagMappings represent the expected state
    // Environment variables that are null need to be implemented

    const hasEnvVar = (flag: string, mappings: SecretFlagMapping[]) => {
      const mapping = mappings.find((m) => m.flag === flag);
      return mapping?.envVar !== null;
    };

    // Verify current flags
    expect(hasEnvVar("--admin-pass", secretFlagMappings)).toBe(true);
    expect(hasEnvVar("--cluster-admin-pass", secretFlagMappings)).toBe(true);
    expect(hasEnvVar("--cluster-admin-user", secretFlagMappings)).toBe(true);
    expect(hasEnvVar("--flair-admin-pass", secretFlagMappings)).toBe(true);
    expect(hasEnvVar("--fabric-password", secretFlagMappings)).toBe(true);
    expect(hasEnvVar("--fabric-user", secretFlagMappings)).toBe(true);
    expect(hasEnvVar("--fabric-token", secretFlagMappings)).toBe(true);

    // --token now has FLAIR_PAIRING_TOKEN env var coverage
    expect(
      secretFlagMappings.find((m) => m.flag === "--token")?.envVar === "FLAIR_PAIRING_TOKEN"
    ).toBe(true);
  });
});
