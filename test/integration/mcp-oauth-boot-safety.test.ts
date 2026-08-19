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
 *      and the plugin default (disabled) applied. On oauth < 2.5.0 this test
 *      FAILS (truthy placeholder + unresolved issuer -> degraded boot, /mcp
 *      500). A red here is the dependency drift speaking — treat it as a
 *      positive control, not a flake.
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
 *   5. ENABLED: shipped config VERBATIM + FLAIR_MCP_OAUTH=true -> /mcp
 *      mounts, the COMPONENT's AS metadata advertises CIMD, and the RFC 9728
 *      metadata carries the DERIVED `<issuer>/mcp` resource (flair#1180 — no
 *      composite literal). "true" is the ONE value both readers accept:
 *      flair's flag takes 1/true/yes/on but the component deletes anything
 *      but "true"/"false", so e.g. FLAIR_MCP_OAUTH=1 yields a guarded /mcp
 *      with NO authorization server behind it (fail-closed broken-on).
 */

import { describe, test, expect, beforeAll, afterEach, afterAll } from "bun:test";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, symlinkSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  test("mcp.enabled is the whole-token env reference; no resource key; issuer whole-token", () => {
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

      // Harper boots but the plugin fails to load because the issuer
      // ("${FLAIR_MCP_ISSUER}" literal, env unset) is not a valid URL.
      // Harper catches the error and continues in a degraded state.
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
      const { generateKeyPairSync } = await import("node:crypto");
      const { privateKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });
      process.env.FLAIR_MCP_OAUTH = "maybe";
      process.env.FLAIR_MCP_ISSUER = "https://test.example.com";
      process.env.FLAIR_MCP_SIGNING_KEY_PEM = privateKey;
      process.env.OAUTH_GITHUB_CLIENT_ID = "test-client-id";
      process.env.OAUTH_GITHUB_CLIENT_SECRET = "test-client-secret";

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
      // off), NOT the component's AS. Flair's document names the in-process
      // /OAuthToken endpoint; the component's names its own /oauth/mcp path.
      // If the component's AS ever mounts for a garbage value again
      // (vocabulary widened back to truthy-string), this discriminator flips.
      const metaRes = await fetch(
        `${harper.httpURL}/.well-known/oauth-authorization-server`,
        { signal: AbortSignal.timeout(10_000) },
      );
      expect(metaRes.status).toBe(200);
      const meta = await metaRes.json();
      expect(String(meta.token_endpoint)).toContain("/OAuthToken");

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
      const { generateKeyPairSync } = await import("node:crypto");
      const { privateKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });
      process.env.FLAIR_MCP_OAUTH = "true";
      process.env.FLAIR_MCP_ISSUER = "https://test.example.com";
      process.env.FLAIR_MCP_SIGNING_KEY_PEM = privateKey;
      process.env.OAUTH_GITHUB_CLIENT_ID = "test-client-id";
      process.env.OAUTH_GITHUB_CLIENT_SECRET = "test-client-secret";

      const workDir = makeWorkDirWithShippedConfig("flair-enabled-");
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
