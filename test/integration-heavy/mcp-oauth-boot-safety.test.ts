/**
 * flair#1136 / flair#1152 / flair#1180: Boot-safety, config-shape, and
 * mutation-proof integration tests for the shipped @harperfast/oauth config
 * block.
 *
 * Since flair#1152 the shipped config.yaml carries `mcp.enabled:
 * ${FLAIR_MCP_OAUTH}` (whole-token env reference) and — flair#1180 — NO
 * `resource` key (the component's resolveResource() derives `<issuer>/mcp` at
 * request time). These tests boot ephemeral Harper instances against the
 * shipped and mutated configs and verify:
 *
 *   0. RESOLVED VERSION: the installed @harperfast/oauth is >= 2.5.0. Below
 *      that, normalizeBooleanField does not exist and an unresolved
 *      ${FLAIR_MCP_OAUTH} placeholder is a TRUTHY STRING — the env-referenced
 *      `enabled` fails OPEN. Sherlock's binding (flair#1152 review): this
 *      assertion lives in the SAME file as the behavioral gate below, so a
 *      future downgrade or partial install trips both in one CI run.
 *   1. SHIPPED SHAPE: config.yaml carries the whole-token env reference and
 *      no resource key.
 *   2. BOOT-SAFETY + ${ENV} BACKSTOP (behavioral gate): the ACTUAL shipped
 *      config with FLAIR_MCP_* env unset boots CLEAN with /mcp 404 — i.e.
 *      oauth 2.5.0's normalizeBooleanField deleted the unresolved placeholder
 *      and the plugin default (disabled) applied — and the unconfigured
 *      github provider is skipped with the library's warning rather than
 *      failing the boot over its redirectUri (2.8.1; HarperFast/oauth#259).
 *      On oauth < 2.5.0 this test
 *      FAILS (truthy placeholder + unresolved issuer -> degraded boot, /mcp
 *      500). A red here is the dependency drift speaking — treat it as a
 *      positive control, not a flake.
 *   2b. NO SIGNING KEY (flair#2194): the shipped config with FLAIR_MCP_OAUTH on
 *      and NO signing key boots CLEAN — the block no longer declares
 *      signingKeyPem, so @harperfast/oauth no longer refuses the load over that
 *      unresolved placeholder.
 *   2c. DECLARED PIN STILL FAILS (flair#2194): a config that DOES declare
 *      `signingKeyPem: ${VAR}` with the variable unset still degrades the boot,
 *      the load error naming the variable — the library's check is NOT loosened.
 *   2d. NO PROVIDER (flair#2194): no-provider boot returns 404 for both
 *      protected-resource forms and 401 for an unauthenticated /mcp request.
 *      A token minted with a provider returns 401 after provider removal.
 *   3. MUTATION-PROVE (literal true): mcp.enabled: true + env unset -> boots
 *      DEGRADED. Proves test 2's clean-boot assertions CAN fire.
 *   4. GARBAGE VALUE (flair#1152 residual): FLAIR_MCP_OAUTH=maybe. Measured
 *      on oauth 2.5.0 the component's coerceConfigBoolean accepts ONLY
 *      "true"/"false" and DELETES anything else — so garbage disables the
 *      component too, and flair's strict mcpOAuthEnabled() stays false: BOTH
 *      sides off, no /mcp handler, no data path. (The AS-metadata 200 in that
 *      state is flair's OWN discovery document — oauth-discovery.ts serves it
 *      whenever the strict flag is off — NOT the component's AS; the test
 *      asserts the discriminating field.) If either reader's vocabulary ever
 *      changes, this test is the tripwire.
 *   5. ENABLED: shipped config VERBATIM + FLAIR_MCP_OAUTH=true (and the
 *      github provider's client id, secret and redirectUri) -> /mcp
 *      mounts, the component's github provider initializes, the COMPONENT's
 *      AS metadata advertises CIMD, and the RFC 9728
 *      metadata carries the DERIVED `<issuer>/mcp` resource (flair#1180 — no
 *      composite literal). "true" is the ONE value both readers accept:
 *      flair's flag takes 1/true/yes/on but the component deletes anything
 *      but "true"/"false", so e.g. FLAIR_MCP_OAUTH=1 yields a guarded /mcp
 *      with NO authorization server behind it (fail-closed broken-on).
 *   6. BROKEN-ON (flair#1285): FLAIR_MCP_OAUTH=1 with the FULL enablement env
 *      otherwise staged — the exact state a regression re-staging '1' in
 *      buildSecretsBundle would ship. Asserts BOTH halves at boot level:
 *      flair's /mcp handler IS mounted and guarded (401), AND the component's
 *      authorization-server surface is NOT (component-dispatched
 *      /oauth/mcp/authorize answers 404, and the AS well-known — which flair's
 *      discovery handler deliberately falls through when the strict flag is on
 *      — has nobody behind it). The unit coverage in mcp-oauth-flag only
 *      exercises flair's side of the vocabulary table; this is the
 *      discriminating boot test for the divergence itself.
 */

import { describe, test, expect, beforeAll, afterEach, afterAll } from "bun:test";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, symlinkSync, copyFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import yaml from "js-yaml";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle.js";
import { mcpOAuthEnabled } from "../../resources/mcp-oauth-flag.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SHIPPED_CONFIG = join(REPO_ROOT, "config.yaml");

// The exact whole-token env reference the shipped config must carry
// (flair#1152). Composites never interpolate — whole-token or nothing.
const ENABLED_ENV_REFERENCE = "${FLAIR_MCP_OAUTH}";

let instances: HarperInstance[] = [];
let tempDirs: string[] = [];

// ── Env hygiene: every boot in this file must control the FLAIR_MCP_* env ──
// The shipped config now REFERENCES the environment, so an ambient
// FLAIR_MCP_OAUTH leaking in from the runner would change what these tests
// boot. Save once, restore after every test.
const MCP_ENV_KEYS = [
  "FLAIR_MCP_OAUTH",
  "FLAIR_MCP_ISSUER",
  "FLAIR_PUBLIC_URL",
  "FLAIR_MCP_SIGNING_KEY_PEM",
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
});

function makeWorkDirWithShippedConfig(prefix: string, mutate?: (shipped: string) => string): string {
  const workDir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(workDir);
  // Symlink node_modules and dist so Harper can find @harperfast/oauth and
  // the JS resources (mcp-oauth.ts, etc.).
  symlinkSync(join(REPO_ROOT, "node_modules"), join(workDir, "node_modules"));
  symlinkSync(join(REPO_ROOT, "dist"), join(workDir, "dist"));
  cpSync(join(REPO_ROOT, "schemas"), join(workDir, "schemas"), { recursive: true });
  if (mutate) {
    const shipped = readFileSync(SHIPPED_CONFIG, "utf-8");
    writeFileSync(join(workDir, "config.yaml"), mutate(shipped), "utf-8");
  } else {
    // NEVER boot in-place (cwd: REPO_ROOT) — Harper WRITES to config.yaml in
    // its cwd at boot (adds ports, etc.), which would corrupt the committed
    // file. Copy the ACTUAL shipped config verbatim instead.
    copyFileSync(SHIPPED_CONFIG, join(workDir, "config.yaml"));
  }
  return workDir;
}

// ─── 0. RESOLVED @harperfast/oauth VERSION (flair#1152 precondition) ────────

describe("flair#1152 precondition: resolved @harperfast/oauth version", () => {
  test("node_modules resolves @harperfast/oauth >= 2.5.0 (normalizeBooleanField fail-safe)", () => {
    // This reads the RESOLVED tree, not the declared dependency: the drift
    // that motivated it was a checkout whose package.json AND lockfile said
    // 2.5.0 while node_modules held 2.4.0 — where the env-referenced
    // mcp.enabled fails OPEN (an unresolved placeholder is a truthy string).
    // A declared-version pin is not a control when the resolved tree
    // diverges. Fails here => run a fresh install; do NOT ship the
    // env-referenced config against the older component.
    const pkgPath = join(REPO_ROOT, "node_modules", "@harperfast", "oauth", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
    expect(typeof pkg.version).toBe("string");
    const version = pkg.version!;
    const [major, minor] = version.split("-")[0]!.split(".").map(Number);
    expect(Number.isFinite(major)).toBe(true);
    expect(Number.isFinite(minor)).toBe(true);
    // >= 2.5.0: major > 2, or major == 2 and minor >= 5.
    const atLeast250 = major! > 2 || (major === 2 && minor! >= 5);
    if (!atLeast250) {
      throw new Error(
        `resolved @harperfast/oauth is ${version} (< 2.5.0) — normalizeBooleanField is missing, ` +
        `so the shipped mcp.enabled: ${ENABLED_ENV_REFERENCE} placeholder fails OPEN when unset. ` +
        `Re-run a clean install; the behavioral gate in this file should be red too.`,
      );
    }
  });
});

// ─── 1. SHIPPED SHAPE (flair#1152 + flair#1180) ─────────────────────────────

describe("flair#1152/#1180 shipped config shape", () => {
  test("mcp.enabled is the whole-token env reference; no resource key; issuer whole-token; github redirectUri a whole-token reference", () => {
    const doc = yaml.load(readFileSync(SHIPPED_CONFIG, "utf-8")) as any;
    const mcp = doc["@harperfast/oauth"].mcp;
    // flair#1152: the on/off choice lives in the ENVIRONMENT. A literal here
    // (true OR false) reintroduces the packed-file revert problem.
    expect(mcp.enabled).toBe(ENABLED_ENV_REFERENCE);
    // flair#1180: NO resource key — the component derives `<issuer>/mcp` at
    // request time. A composite like `${FLAIR_MCP_ISSUER}/mcp` NEVER
    // interpolates (whole-token-only expansion) and fails every connect with
    // invalid_target. (Escape hatch for a non-standard resource: an explicit
    // LITERAL absolute URL — which this assertion would catch; loosen it
    // deliberately if that day comes.)
    expect("resource" in mcp).toBe(false);
    // issuer stays the whole-token reference that interpolates correctly.
    expect(mcp.issuer).toBe("${FLAIR_MCP_ISSUER}");
    // DCR stays explicitly disabled (flair#756) — untouched by the reshape.
    expect(mcp.dynamicClientRegistration.enabled).toBe(false);
    // The github provider carries a whole-token redirectUri reference beside
    // its credentials: since @harperfast/oauth 2.7.0 a CONFIGURED provider
    // needs one, and 2.8.1 skips an UNCONFIGURED provider before that check
    // (HarperFast/oauth#259). A literal here would re-introduce the
    // packed-file revert problem the two credential references avoid.
    const github = doc["@harperfast/oauth"].providers.github;
    expect(github.clientId).toBe("${OAUTH_GITHUB_CLIENT_ID}");
    expect(github.clientSecret).toBe("${OAUTH_GITHUB_CLIENT_SECRET}");
    expect(github.redirectUri).toBe("${OAUTH_GITHUB_REDIRECT_URI}");
  });
});

// ─── 2. BOOT-SAFETY + ${ENV} BACKSTOP: shipped config, env unset ────────────

describe("flair#1136/#1152 boot-safety: shipped config with env-referenced mcp.enabled, env unset", () => {
  test(
    "Harper boots CLEAN with the ACTUAL shipped config.yaml and no FLAIR_MCP_* env (oauth 2.5.0+ deletes the unresolved placeholder)",
    async () => {
      // BEHAVIORAL GATE for the resolved-version precondition above: on
      // oauth < 2.5.0 the unresolved ${FLAIR_MCP_OAUTH} placeholder is a
      // truthy string — the plugin tries to load with an unresolved issuer,
      // boot degrades, and /mcp answers 500, so this test goes RED alongside
      // the version assertion. That red is the drift speaking — a positive
      // control, not a flake.
      clearMcpEnv();
      const workDir = makeWorkDirWithShippedConfig("flair-boot-safety-");

      const harper = await startHarper({
        cwd: workDir,
        harperBinDir: REPO_ROOT,
      });
      instances.push(harper);

      // Harper came up — the process is running.
      expect(harper.httpURL).toBeTruthy();
      expect(harper.opsURL).toBeTruthy();

      // Ops API is healthy (Harper is running, NOT degraded).
      const opsRes = await fetch(harper.opsURL, {
        signal: AbortSignal.timeout(10_000),
      });
      expect(opsRes.status).toBe(200);

      // /mcp returns 404 — MCP is OFF (not degraded). When the plugin
      // degrades (enabled truthy + issuer unset), /mcp returns 500. A 404
      // here proves the shipped default is inert with no env set.
      const mcpRes = await fetch(`${harper.httpURL}/mcp`, {
        signal: AbortSignal.timeout(10_000),
      });
      expect(mcpRes.status).toBe(404);

      // SHAPE (a): none of the OAUTH_GITHUB_* variables is set, so the github
      // provider is UNCONFIGURED and @harperfast/oauth 2.8.1 skips it — with
      // this warning, emitted before the provider's redirectUri is ever
      // evaluated (HarperFast/oauth#259). On 2.8.0 the redirectUri check ran
      // first and failed the plugin's load, which is what made this boot
      // degraded. The shipped block now carries a redirectUri env reference;
      // that this boot stays clean proves an unset credential pair still
      // short-circuits.
      const log = harper.getLog?.() ?? "";
      expect(log).toContain("OAuth provider 'github' not configured. Missing: clientId, clientSecret");
    },
    120_000,
  );
});

// ─── 2b. BOOT-SAFETY: MCP on with NO staged signing key (flair#2194) ─────────

describe("flair#2194 boot-safety: shipped config with MCP on and no signing key", () => {
  test(
    "configured provider and no signing key boots clean",
    async () => {
      clearMcpEnv();
      process.env.FLAIR_MCP_OAUTH = "true";
      process.env.FLAIR_MCP_ISSUER = "https://test.example.com";
      process.env.OAUTH_GITHUB_CLIENT_ID = "no-signing-key-client";
      process.env.OAUTH_GITHUB_CLIENT_SECRET = "no-signing-key-secret";
      process.env.OAUTH_GITHUB_REDIRECT_URI = "https://test.example.com/oauth";

      const workDir = makeWorkDirWithShippedConfig("flair-no-signing-key-");
      const harper = await startHarper({
        cwd: workDir,
        harperBinDir: REPO_ROOT,
      });
      instances.push(harper);

      // Clean boot — the ops API answers 200 (a degraded boot answers 500).
      const opsRes = await fetch(harper.opsURL, { signal: AbortSignal.timeout(10_000) });
      expect(opsRes.status).toBe(200);
      const discovery = await fetch(`${harper.httpURL}/.well-known/oauth-protected-resource`, { signal: AbortSignal.timeout(10_000) });
      expect(discovery.status).toBe(200);

      // flair's /mcp is mounted and guarded (401 — not 404/disabled, not 500/degraded).
      const mcpRes = await fetch(`${harper.httpURL}/mcp`, { signal: AbortSignal.timeout(10_000) });
      expect(mcpRes.status).toBe(401);

      // The load did not stop on the signing key the way it did before the fix.
      const log = harper.getLog?.() ?? "";
      expect(log).not.toContain("mcp.signingKeyPem is the unresolved env placeholder");
    },
    120_000,
  );
});

// ─── 2c/2d. DECLARED PIN FAILS / NO PROVIDER (flair#2194) ────────────────────

describe("flair#2194: a declared signingKeyPem with an unset variable still fails the boot loudly", () => {
  test(
    "mcp.signingKeyPem declared with `${FLAIR_MCP_SIGNING_KEY_PEM}` unset: the plugin load is refused, naming the variable",
    async () => {
      clearMcpEnv();
      process.env.FLAIR_MCP_OAUTH = "true";
      process.env.FLAIR_MCP_ISSUER = "https://test.example.com";
      process.env.OAUTH_GITHUB_CLIENT_ID = "declared-pin-client";
      process.env.OAUTH_GITHUB_CLIENT_SECRET = "declared-pin-secret";
      process.env.OAUTH_GITHUB_REDIRECT_URI = "https://test.example.com/oauth";
      const workDir = makeWorkDirWithShippedConfig("flair-declared-pin-", (shipped) =>
        shipped.replace("    enabled: ${FLAIR_MCP_OAUTH}", "    enabled: ${FLAIR_MCP_OAUTH}\n    signingKeyPem: ${FLAIR_MCP_SIGNING_KEY_PEM}"),
      );
      const harper = await startHarper({ cwd: workDir, harperBinDir: REPO_ROOT });
      instances.push(harper);

      // The library's hard check is intact: a DECLARED, unresolved pin degrades the boot.
      const healthRes = await fetch(`${harper.httpURL}/health`, { signal: AbortSignal.timeout(10_000) });
      expect(healthRes.status).toBe(500);
      // The plugin's load error names the variable, in the instance's own log.
      const log = harper.getLog?.() ?? "";
      expect(log).toContain("mcp.signingKeyPem is the unresolved env placeholder");
      expect(log).toContain("${FLAIR_MCP_SIGNING_KEY_PEM}");
    },
    120_000,
  );
});

describe("flair#2194: MCP on with NO provider configured — fail-closed discovery", () => {
  test("a token minted with a provider returns 401 after provider removal and restart", async () => {
    clearMcpEnv();
    const issuer = "https://provider-removal.flair.test";
    process.env.FLAIR_MCP_OAUTH = "true";
    process.env.FLAIR_MCP_ISSUER = issuer;
    process.env.OAUTH_GITHUB_CLIENT_ID = "provider-removal-client";
    process.env.OAUTH_GITHUB_CLIENT_SECRET = "provider-removal-secret";
    process.env.OAUTH_GITHUB_REDIRECT_URI = `${issuer}/oauth`;
    const workDir = makeWorkDirWithShippedConfig("flair-provider-removal-");
    let harper = await startHarper({ cwd: workDir, harperBinDir: REPO_ROOT });
    instances.push(harper);
    const verifier = randomBytes(32).toString("base64url");
    const clientId = "provider-removal-client";
    const redirectUri = `${issuer}/callback`;
    for (const [table, records] of [
      ["harper_oauth_mcp_clients", [{
        client_id: clientId, grant_types: JSON.stringify(["authorization_code"]),
        response_types: JSON.stringify(["code"]), redirect_uris: JSON.stringify([redirectUri]),
        token_endpoint_auth_method: "none",
      }]],
      ["mcp_auth_codes", [{
        code: "provider-removal-code", client_id: clientId, user: "provider-removal-agent",
        resource: `${issuer}/mcp`, code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256", redirect_uri: redirectUri, scope: "", client_auth_method: "none",
      }]],
    ] as const) {
      const res = await fetch(harper.opsURL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64") },
        body: JSON.stringify({ operation: "insert", database: "oauth", table, records }),
        signal: AbortSignal.timeout(10_000),
      });
      expect(res.status).toBe(200);
    }
    const mintRes = await fetch(`${harper.httpURL}/oauth/mcp/token`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId,
        code: "provider-removal-code", code_verifier: verifier, redirect_uri: redirectUri }).toString(),
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
    expect((await postMcp()).status).toBe(200);
    const installDir = harper.installDir;
    await stopHarper(harper, { keepInstallDir: true });
    delete process.env.OAUTH_GITHUB_CLIENT_ID;
    delete process.env.OAUTH_GITHUB_CLIENT_SECRET;
    delete process.env.OAUTH_GITHUB_REDIRECT_URI;
    harper = await startHarper({ cwd: workDir, harperBinDir: REPO_ROOT, installDir });
    instances.push(harper);
    expect((await fetch(harper.opsURL, { signal: AbortSignal.timeout(10_000) })).status).toBe(200);
    expect(harper.getLog?.() ?? "").toContain("OAuth provider 'github' not configured. Missing: clientId, clientSecret");
    const kid = JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString("utf8")).kid;
    const keyRes = await fetch(harper.opsURL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Basic " + Buffer.from(`${harper.admin.username}:${harper.admin.password}`).toString("base64") },
      body: JSON.stringify({ operation: "search_by_value", database: "oauth", table: "harper_oauth_mcp_keys",
        search_attribute: "kid", search_value: kid, get_attributes: ["kid", "public_key_pem"] }),
      signal: AbortSignal.timeout(10_000),
    });
    expect(keyRes.status).toBe(200);
    const keys = await keyRes.json() as { kid: string; public_key_pem: string }[];
    expect(keys).toHaveLength(1);
    expect(keys[0]!.kid).toBe(kid);
    expect(keys[0]!.public_key_pem).toContain("BEGIN PUBLIC KEY");
    expect((await postMcp()).status).toBe(401);
  }, 300_000);

  test(
    "no OAUTH_GITHUB_* set: boots clean, both protected-resource forms 404 and unauthenticated /mcp returns 401",
    async () => {
      clearMcpEnv();
      process.env.FLAIR_MCP_OAUTH = "true";
      process.env.FLAIR_MCP_ISSUER = "https://test.example.com";
      const workDir = makeWorkDirWithShippedConfig("flair-no-provider-");
      const harper = await startHarper({ cwd: workDir, harperBinDir: REPO_ROOT });
      instances.push(harper);

      const opsRes = await fetch(harper.opsURL, { signal: AbortSignal.timeout(10_000) });
      expect(opsRes.status).toBe(200);

      // @harperfast/oauth 2.8.1 skips the uncredentialed github provider, so the
      // plugin ends with none and clears its MCP config: no discovery documents.
      for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
        const res = await fetch(`${harper.httpURL}${path}`, { signal: AbortSignal.timeout(10_000) });
        expect(res.status).toBe(404);
      }
      // /mcp is still mounted by flair and denies the unauthenticated request.
      const mcpRes = await fetch(`${harper.httpURL}/mcp`, { signal: AbortSignal.timeout(10_000) });
      expect(mcpRes.status).toBe(401);
    },
    120_000,
  );
});

// ─── 3. MUTATION-PROVE: enabled:true + no env → DEGRADED ────────────────────

describe("flair#1136 mutation-prove: mcp.enabled: true with env unset", () => {
  test(
    "literal true: Harper boots DEGRADED when mcp.enabled is true but FLAIR_MCP_* env is unset",
    async () => {
      clearMcpEnv();
      const shipped = readFileSync(SHIPPED_CONFIG, "utf-8");
      const mutated = shipped.replace(`enabled: ${ENABLED_ENV_REFERENCE}`, "enabled: true");
      // The mutation must actually land — if the shipped enabled line ever
      // changes shape, this replace would silently no-op and the test below
      // would fail confusingly on the clean boot instead.
      expect(mutated).not.toBe(shipped);
      const workDir = makeWorkDirWithShippedConfig("flair-mutation-prove-literal-", () => mutated);

      // Harper boots but the plugin fails to load: with mcp.enabled literal
      // true the block is ACTIVE and the unresolved issuer ("${FLAIR_MCP_ISSUER}"
      // literal, env unset) is not a valid URL. Harper catches the error and
      // continues in a degraded state. (The signing key is no longer declared
      // by the shipped block — flair#2194 — so the issuer is the first
      // unresolved placeholder it validates.)
      const harper = await startHarper({
        cwd: workDir,
        harperBinDir: REPO_ROOT,
      });
      instances.push(harper);

      // PROOF: the health endpoint is degraded (500, not 200).
      // The boot-safety test checks for 200/404 — this proves it CAN fire.
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
    },
    120_000,
  );
});

// ─── 4. GARBAGE VALUE: FLAIR_MCP_OAUTH=maybe → inert AS, no data path ──────

describe("flair#1152 garbage value: FLAIR_MCP_OAUTH=maybe", () => {
  test("flair's strict mcpOAuthEnabled() stays false for a garbage value (in-process divergence)", () => {
    // The asymmetry that keeps the garbage case inert, asserted at its
    // source: the component treats any non-empty resolved string as truthy;
    // this function does not.
    clearMcpEnv();
    process.env.FLAIR_MCP_OAUTH = "maybe";
    expect(mcpOAuthEnabled()).toBe(false);
    // Positive control — the same code path DOES accept the real values, so
    // a broken import/allowlist can't fake the assertion above.
    process.env.FLAIR_MCP_OAUTH = "1";
    expect(mcpOAuthEnabled()).toBe(true);
  });

  test(
    "a garbage value disables BOTH sides — component deletes it, flair's strict flag stays off",
    async () => {
      // The spec (and the flair#1152 security review) modeled the component
      // as reading `enabled` truthy-string, predicting garbage would mount an
      // inert AS. MEASURED on oauth 2.5.0 it is safer than that: the
      // component's coerceConfigBoolean accepts ONLY "true"/"false" and
      // normalizeBooleanField DELETES any other string ("maybe" included, and
      // "1"/"yes"/"on" too) so the disabled default applies — the upstream
      // "treat any non-boolean string as absent" ask is ALREADY implemented.
      // flair's strict flag is also off for "maybe": no /mcp handler, no AS,
      // no data path. Boot stays CLEAN (the deleted flag means the plugin
      // never validates the issuer). If either reader's vocabulary changes,
      // an assertion below flips — re-derive the whole table before shipping
      // that change.
      clearMcpEnv();
      process.env.FLAIR_MCP_OAUTH = "maybe";
      process.env.FLAIR_MCP_ISSUER = "https://test.example.com";
      process.env.OAUTH_GITHUB_CLIENT_ID = "test-client-id";
      process.env.OAUTH_GITHUB_CLIENT_SECRET = "test-client-secret";
      process.env.OAUTH_GITHUB_REDIRECT_URI = "https://test.example.com/oauth";

      const workDir = makeWorkDirWithShippedConfig("flair-garbage-value-");
      const harper = await startHarper({
        cwd: workDir,
        harperBinDir: REPO_ROOT,
      });
      instances.push(harper);

      // Clean boot — the deleted flag leaves the plugin fully inert (a
      // degraded boot here would answer 500 on everything).
      const opsRes = await fetch(harper.opsURL, {
        signal: AbortSignal.timeout(10_000),
      });
      expect(opsRes.status).toBe(200);

      // The AS-metadata path answers 200 — but it is FLAIR'S OWN discovery
      // document (oauth-discovery.ts serves it whenever the strict flag is
      // off — it SHADOWS the component's well-known handlers in that state,
      // so this document alone cannot reveal whether the component mounted).
      // Flair's document names the in-process /OAuthToken endpoint.
      const metaRes = await fetch(
        `${harper.httpURL}/.well-known/oauth-authorization-server`,
        { signal: AbortSignal.timeout(10_000) },
      );
      expect(metaRes.status).toBe(200);
      const meta = await metaRes.json();
      expect(String(meta.token_endpoint)).toContain("/OAuthToken");

      // THE component-mount tripwire: /oauth/mcp/* is dispatched by the
      // component itself (never shadowed by flair) and its dispatcher
      // answers 404 whenever mcp.enabled is falsy (existence-hiding,
      // dist/lib/mcp/index.js handleMCPGet). Garbage was DELETED by
      // normalizeBooleanField -> disabled -> 404 here. If the component's
      // vocabulary ever widens back to truthy-string, this becomes a live
      // authorize endpoint (non-404) and THIS assertion fires.
      const authorizeRes = await fetch(
        `${harper.httpURL}/oauth/mcp/authorize`,
        { signal: AbortSignal.timeout(10_000) },
      );
      expect(authorizeRes.status).toBe(404);

      // flair side: mcpOAuthEnabled() is strict — no /mcp handler was
      // registered. 404, not 401 (mounted+guarded) and not 500 (degraded).
      const mcpRes = await fetch(`${harper.httpURL}/mcp`, {
        signal: AbortSignal.timeout(10_000),
      });
      expect(mcpRes.status).toBe(404);
    },
    120_000,
  );
});

// ─── 5. ENABLED: shipped config VERBATIM + env → /mcp mounts ────────────────

describe("flair#1152 enabled path: shipped config verbatim + env set", () => {
  test(
    "/mcp mounts, CIMD advertises, and RFC 9728 metadata carries the DERIVED <issuer>/mcp resource",
    async () => {
      // flair#1152's whole point, end-to-end: NO config mutation. The shipped
      // file already references the environment, so setting the env vars is
      // the entire enablement story — nothing for a re-packed deploy to
      // revert.
      //
      // "true", NOT "1": the component's coerceConfigBoolean accepts only
      // "true"/"false" and deletes anything else, while flair's flag takes
      // 1/true/yes/on — so "true" is the one value that enables BOTH sides
      // (and it is what buildSecretsBundle stages). With "1" this test fails:
      // /mcp is guarded (flair on) but the AS metadata 404s (component off).
      clearMcpEnv();
      process.env.FLAIR_MCP_OAUTH = "true";
      process.env.FLAIR_MCP_ISSUER = "https://test.example.com";
      process.env.OAUTH_GITHUB_CLIENT_ID = "test-client-id";
      process.env.OAUTH_GITHUB_CLIENT_SECRET = "test-client-secret";
      process.env.OAUTH_GITHUB_REDIRECT_URI = "https://test.example.com/oauth";

      const workDir = makeWorkDirWithShippedConfig("flair-enabled-");
      const harper = await startHarper({
        cwd: workDir,
        harperBinDir: REPO_ROOT,
      });
      instances.push(harper);

      // SHAPE (b): the github provider is CONFIGURED here — clientId,
      // clientSecret AND the redirectUri the shipped block now references —
      // so the component builds it. Provider construction is offline (GitHub
      // is a static preset; no discovery or JWKS fetch — the constructor only
      // validates config), so this line is the whole proof, no network needed.
      const log = harper.getLog?.() ?? "";
      expect(log).toContain("OAuth provider 'github' initialized (github)");

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

      // flair#1180 regression: with NO resource key configured, the RFC 9728
      // Protected Resource Metadata advertises the DERIVED `<issuer>/mcp` —
      // the same canonical value flair's in-process route binds tokens to.
      // Under the old composite config this document carried the literal
      // string "${FLAIR_MCP_ISSUER}/mcp" and every connect died with
      // invalid_target.
      const prmRes = await fetch(
        `${harper.httpURL}/.well-known/oauth-protected-resource/mcp`,
        { signal: AbortSignal.timeout(10_000) },
      );
      expect(prmRes.status).toBe(200);
      const prm = await prmRes.json();
      expect(prm.resource).toBe("https://test.example.com/mcp");
    },
    120_000,
  );
});

// ─── 6. BROKEN-ON (flair#1285): FLAIR_MCP_OAUTH=1 → guarded /mcp, NO AS ──────

describe("flair#1285 vocabulary-asymmetry broken-on: FLAIR_MCP_OAUTH=1", () => {
  test(
    "flair's /mcp is mounted+guarded (401) while the component's authorization server is NOT mounted",
    async () => {
      // The exact state a regression re-staging '1' in buildSecretsBundle
      // (src/lib/mcp-enable.ts) would deploy: the FULL enablement env —
      // issuer, IdP credentials — with the flag spelled "1".
      // flair's strict reader (resources/mcp-oauth-flag.ts) accepts 1/true/
      // yes/on; the component's coerceConfigBoolean accepts ONLY "true"/
      // "false" and DELETES anything else, so its disabled default applies.
      // Result: broken-on — every /mcp request 401s and there is no
      // authorization server for the client to satisfy the challenge against.
      // Fail-closed (no unauthenticated data path), but broken; case 5 pins
      // the one spelling that works, this pins the divergence itself.
      clearMcpEnv();
      process.env.FLAIR_MCP_OAUTH = "1";
      process.env.FLAIR_MCP_ISSUER = "https://test.example.com";
      process.env.OAUTH_GITHUB_CLIENT_ID = "test-client-id";
      process.env.OAUTH_GITHUB_CLIENT_SECRET = "test-client-secret";
      process.env.OAUTH_GITHUB_REDIRECT_URI = "https://test.example.com/oauth";

      const workDir = makeWorkDirWithShippedConfig("flair-broken-on-");
      const harper = await startHarper({
        cwd: workDir,
        harperBinDir: REPO_ROOT,
      });
      instances.push(harper);

      // Boot is CLEAN: normalizeBooleanField deleted the "1", so the plugin
      // never validated its config and never degraded the boot.
      const opsRes = await fetch(harper.opsURL, {
        signal: AbortSignal.timeout(10_000),
      });
      expect(opsRes.status).toBe(200);

      // HALF 1 — flair's side is ON: /mcp is registered and guarded.
      // 401, not 404 (that would mean flair's reader stopped accepting "1" —
      // re-derive the whole vocabulary table before shipping that) and not
      // 500 (degraded boot).
      const mcpRes = await fetch(`${harper.httpURL}/mcp`, {
        signal: AbortSignal.timeout(10_000),
      });
      expect(mcpRes.status).toBe(401);

      // HALF 2a — the component's AS is NOT mounted. /oauth/mcp/* is
      // dispatched by the component itself and NEVER shadowed by flair (the
      // same tripwire case 4 uses): its dispatcher answers 404 whenever
      // mcp.enabled is falsy, and "1" was deleted. If the component's
      // vocabulary ever widens to accept "1", this becomes a live authorize
      // endpoint (non-404) and THIS assertion fires — at which point '1'
      // would be broken differently, not fixed; re-derive the table.
      const authorizeRes = await fetch(
        `${harper.httpURL}/oauth/mcp/authorize`,
        { signal: AbortSignal.timeout(10_000) },
      );
      expect(authorizeRes.status).toBe(404);

      // HALF 2b — the client-visible symptom: NO AS metadata anywhere. With
      // the strict flag ON, flair's discovery handler deliberately falls
      // through to the component's well-known handlers (makeWellKnownHandler
      // behaviour 2, resources/oauth-discovery.ts) — and the component is not
      // there to answer. Contrast case 4 (flag off → flair's own document,
      // 200) and case 5 (component on → component document, 200): here the
      // 401 challenge from /mcp has no authorization server behind it at all.
      const metaRes = await fetch(
        `${harper.httpURL}/.well-known/oauth-authorization-server`,
        { signal: AbortSignal.timeout(10_000) },
      );
      expect(metaRes.status).toBe(404);
    },
    120_000,
  );
});
