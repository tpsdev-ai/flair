/**
 * Tests for `flair mcp enable/disable/status` (flair#719, corrected by
 * flair#756) — src/lib/mcp-enable.ts.
 *
 * House style matches test/unit/mcp-grant-family.test.ts: mock global/
 * injected `fetch`, write/read real files under a mkdtemp temp dir, never
 * touch ~/.flair or a real Harper instance, never make a real network call.
 *
 * flair#756 (2026-07-19): CIMD-only, DCR removed entirely. #754 shipped
 * `enable`'s default flow pre-registering claude.ai via DCR + a DCR gate
 * token. That contradicted the strategic direction (Nathan, on the record):
 * CIMD-only looking forward, DCR is not the path — and the scope was
 * amended same-day from "CIMD-first with a --with-dcr legacy hatch" to full
 * removal. This file replaces the DCR-era tests: no DCR calls anywhere in
 * the default flow (structural assertion), the config block explicitly
 * disables `dynamicClientRegistration` and never writes gate-token fields,
 * and self-verify/status confirm CIMD is actually advertised. Coverage:
 *   - the orchestration order (dry-run stops after the local/pure steps;
 *     the live path ends at self-verify — no DCR call after restart)
 *   - local-origin refusal (the exact addendum message, zero fetch calls)
 *   - dry-run (no remote calls, signing key still materializes on disk)
 *   - self-verify failure names the step to re-run, never reports success
 *     on hope — including the new CIMD-not-advertised failure mode
 *   - disable symmetry (flag-off confirmation gate, then restart only)
 *   - no secret VALUES ever appear in an EnableMcpResult/DisableMcpResult/
 *     McpStatusResult (paths/mechanism/counts only)
 *   - structural: buildMcpOAuthConfigBlock always disables DCR explicitly
 *     and never writes initialAccessToken/allowedRedirectUriHosts
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";

import {
  isLocalOrigin,
  checkLocalOriginRefusal,
  isFabricOrigin,
  selectSecretsMechanism,
  generateRsaSigningKeyPair,
  ensureSigningKeyFile,
  buildMcpOAuthConfigBlock,
  idpCallbackUrl,
  buildSecretsBundle,
  writeSecretsStagingFile,
  provisionSecrets,
  provisionIdpIdentityMapping,
  triggerRemoteRestart,
  updateLocalConfigMcpEnabled,
  selfVerifyMcpMetadata,
  buildClaudePasteBlock,
  enableMcp,
  disableMcp,
  mcpStatus,
  REQUIRED_ACCESS_TOKEN_TTL,
  DEFAULT_CIMD_ALLOWED_HOSTS,
  type EnableMcpResult,
} from "../../src/lib/mcp-enable.ts";

let dir: string;
const ISSUER = "https://flair.example.com";

// Minimal local component config the standalone enableMcp path writes to.
// tempPaths() points localConfigPath here so the local-config-update step
// never falls back to its default search (["config.yaml", ~/.flair/config.yaml])
// and mutates the repo's own ./config.yaml — which poisoned the mcp-oauth
// boot-safety integration test during the flair#1136 0.42.0 release cut.
const LOCAL_CONFIG_YAML = `name: flair
rest: true
"@harperfast/oauth":
  package: "@harperfast/oauth"
  mcp:
    enabled: false
`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "flair-mcp-enable-"));
  writeFileSync(join(dir, "config.yaml"), LOCAL_CONFIG_YAML, "utf-8");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ─── local-origin detection (scenario addendum, binding) ────────────────────

describe("isLocalOrigin / checkLocalOriginRefusal", () => {
  test.each([
    "http://localhost:9926",
    "http://127.0.0.1:9926",
    "http://[::1]:9926",
    "http://foo.local:9926",
    "http://10.0.1.5:9926",
    "http://172.16.0.1:9926",
    "http://172.31.255.255:9926",
    "http://192.168.1.1:9926",
    "http://169.254.1.1:9926",
    "not a url at all",
  ])("%s is local", (url) => {
    expect(isLocalOrigin(url)).toBe(true);
  });

  test.each([
    "https://flair.example.com",
    "https://my-flair.harperfabric.com",
    "https://8.8.8.8",
    "https://172.32.0.1", // outside the 172.16-31 private range
  ])("%s is NOT local", (url) => {
    expect(isLocalOrigin(url)).toBe(false);
  });

  test("checkLocalOriginRefusal returns the exact addendum message for a local origin", () => {
    const result = checkLocalOriginRefusal("http://localhost:9926");
    expect(result).toEqual({
      refused: true,
      message: "claude.ai connectors need a public HTTPS origin; this instance is local. See the hosted-shape docs.",
    });
  });

  test("checkLocalOriginRefusal passes a public origin", () => {
    expect(checkLocalOriginRefusal(ISSUER)).toEqual({ refused: false });
  });
});

// ─── secrets-mechanism selection ─────────────────────────────────────────────

describe("isFabricOrigin / selectSecretsMechanism", () => {
  test("a *.harperfabric.com origin defaults to fabric-env-secrets", () => {
    expect(isFabricOrigin("https://tps.dtrt.harperfabric.com")).toBe(true);
    expect(selectSecretsMechanism("https://tps.dtrt.harperfabric.com")).toBe("fabric-env-secrets");
  });

  test("a non-Fabric origin defaults to env-file", () => {
    expect(isFabricOrigin(ISSUER)).toBe(false);
    expect(selectSecretsMechanism(ISSUER)).toBe("env-file");
  });

  test("an explicit override always wins", () => {
    expect(selectSecretsMechanism("https://tps.dtrt.harperfabric.com", "env-file")).toBe("env-file");
    expect(selectSecretsMechanism(ISSUER, "fabric-env-secrets")).toBe("fabric-env-secrets");
  });
});

// ─── RS256 keypair (Sherlock: generateKeyPairSync, not a PRNG shortcut) ─────

describe("generateRsaSigningKeyPair / ensureSigningKeyFile", () => {
  test("produces a real RSA keypair via crypto.generateKeyPairSync (PEM-shaped, 2048-bit)", () => {
    const { publicKey, privateKey } = generateRsaSigningKeyPair();
    expect(privateKey).toContain("BEGIN PRIVATE KEY");
    expect(publicKey).toContain("BEGIN PUBLIC KEY");
  });

  test("generates + writes a 0600 file on first call", () => {
    const path = join(dir, "signing-key.pem");
    const result = ensureSigningKeyFile(path);
    expect(result.reused).toBe(false);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf-8")).toContain("BEGIN PRIVATE KEY");
  });

  test("reuses an existing key file instead of rotating it (idempotent)", () => {
    const path = join(dir, "signing-key.pem");
    const first = ensureSigningKeyFile(path);
    const firstContent = readFileSync(path, "utf-8");
    const second = ensureSigningKeyFile(path);
    expect(second.reused).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe(firstContent);
  });
});

// ─── config block (Sherlock: accessTokenTtl must be explicit 900; flair#756:
// DCR must be explicitly disabled, CIMD allowedHosts must be set) ───────────

describe("buildMcpOAuthConfigBlock", () => {
  test("matches the installed @harperfast/oauth 2.2.0 field names, CIMD-only shape", () => {
    const block = buildMcpOAuthConfigBlock({ idpProvider: "github" });
    const oauth = block["@harperfast/oauth"] as any;
    expect(oauth.package).toBe("@harperfast/oauth");
    expect(oauth.providers.github.clientId).toBe("${OAUTH_GITHUB_CLIENT_ID}");
    expect(oauth.providers.github.clientSecret).toBe("${OAUTH_GITHUB_CLIENT_SECRET}");
    // flair#1152: mcp.enabled is the WHOLE-TOKEN env reference — never a
    // literal boolean. The on/off choice lives in the environment, so a
    // re-packed deploy cannot revert it.
    expect(oauth.mcp.enabled).toBe("${FLAIR_MCP_OAUTH}");
    expect(oauth.mcp.accessTokenTtl).toBe(REQUIRED_ACCESS_TOKEN_TTL);
    expect(oauth.mcp.accessTokenTtl).toBe(900);
    expect(oauth.mcp.clientIdMetadataDocuments.allowedHosts).toEqual(DEFAULT_CIMD_ALLOWED_HOSTS);
    expect(oauth.mcp.signingKeyPem).toBe("${FLAIR_MCP_SIGNING_KEY_PEM}");
  });

  test("flair#1180: NO resource key is emitted — the component derives <issuer>/mcp", () => {
    // The old composite `resource: "${FLAIR_MCP_ISSUER}/mcp"` NEVER
    // interpolated (env expansion is whole-token-only) and failed every
    // connect with invalid_target. Absent, the component's resolveResource()
    // derives `<issuer>/mcp` at request time — identical to flair's
    // in-process derivation. An operator needing a non-standard resource
    // sets an explicit LITERAL absolute URL in config.yaml by hand.
    const block = buildMcpOAuthConfigBlock({ idpProvider: "github" });
    const mcp = (block["@harperfast/oauth"] as any).mcp;
    expect("resource" in mcp).toBe(false);
    // And nothing else in the block smuggles the composite back in.
    expect(JSON.stringify(block)).not.toContain("${FLAIR_MCP_ISSUER}/mcp");
  });

  test("flair#756: dynamicClientRegistration is ALWAYS explicitly disabled — never omitted", () => {
    // Ground truth (see mcp-enable.ts's module header + dcr.js:161-167): an
    // ABSENT dynamicClientRegistration block leaves DCR's own default
    // (open, ungated registration) live. Only an explicit `enabled: false`
    // actually 404s /oauth/mcp/register. This is the load-bearing assertion
    // that the config we write can never accidentally re-enable DCR.
    const block = buildMcpOAuthConfigBlock({ idpProvider: "github" });
    const mcp = (block["@harperfast/oauth"] as any).mcp;
    expect(mcp.dynamicClientRegistration).toBeDefined();
    expect(mcp.dynamicClientRegistration.enabled).toBe(false);
  });

  test("flair#756: never writes initialAccessToken or allowedRedirectUriHosts — there is no gate-token machinery left", () => {
    const block = buildMcpOAuthConfigBlock({ idpProvider: "github" });
    const mcp = (block["@harperfast/oauth"] as any).mcp;
    expect(mcp.dynamicClientRegistration.initialAccessToken).toBeUndefined();
    expect(mcp.dynamicClientRegistration.allowedRedirectUriHosts).toBeUndefined();
    expect(Object.keys(mcp.dynamicClientRegistration)).toEqual(["enabled"]);
    const text = JSON.stringify(block);
    expect(text).not.toContain("FLAIR_MCP_DCR_TOKEN");
    expect(text).not.toContain("initialAccessToken");
  });

  test("no literal secret material — every sensitive field is an ${ENV_VAR} placeholder", () => {
    const block = buildMcpOAuthConfigBlock({ idpProvider: "github" });
    const text = JSON.stringify(block);
    expect(text).toContain("${FLAIR_MCP_SIGNING_KEY_PEM}");
    expect(text).not.toContain("BEGIN PRIVATE KEY");
  });

  test("respects a custom idp provider and CIMD allowed-hosts list", () => {
    const block = buildMcpOAuthConfigBlock({ idpProvider: "google", cimdAllowedHosts: ["example.com"] });
    const oauth = block["@harperfast/oauth"] as any;
    expect(oauth.providers.google.clientId).toBe("${OAUTH_GOOGLE_CLIENT_ID}");
    expect(oauth.mcp.clientIdMetadataDocuments.allowedHosts).toEqual(["example.com"]);
    // Disabling DCR is never conditional on the CIMD override.
    expect(oauth.mcp.dynamicClientRegistration.enabled).toBe(false);
  });
});

describe("idpCallbackUrl", () => {
  test("matches the @harperfast/oauth README's documented callback shape", () => {
    expect(idpCallbackUrl(ISSUER, "github")).toBe("https://flair.example.com/oauth/github/callback");
    expect(idpCallbackUrl(`${ISSUER}/`, "github")).toBe("https://flair.example.com/oauth/github/callback");
  });
});

// ─── secrets bundle + staging file ───────────────────────────────────────────

describe("buildSecretsBundle / writeSecretsStagingFile / provisionSecrets", () => {
  test("bundle includes the flag, issuer, signing key, and IdP creds — no DCR token field", () => {
    const bundle = buildSecretsBundle({
      issuer: ISSUER,
      signingKeyPem: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
      idpProvider: "github",
      idpClientId: "client-id-value",
      idpClientSecret: "client-secret-value",
    });
    // "true" EXACTLY (flair#1152): the component's coerceConfigBoolean
    // accepts only "true"/"false" and DELETES anything else — staging "1"
    // (flair-truthy, component-deleted) yields a guarded /mcp with NO
    // authorization server behind it.
    expect(bundle.FLAIR_MCP_OAUTH).toBe("true");
    expect(bundle.FLAIR_MCP_ISSUER).toBe(ISSUER);
    expect(bundle.FLAIR_MCP_SIGNING_KEY_PEM).toContain("BEGIN PRIVATE KEY");
    expect(bundle.OAUTH_GITHUB_CLIENT_ID).toBe("client-id-value");
    expect(bundle.OAUTH_GITHUB_CLIENT_SECRET).toBe("client-secret-value");
    expect(bundle.FLAIR_MCP_DCR_TOKEN).toBeUndefined();
    expect(Object.keys(bundle)).not.toContain("FLAIR_MCP_DCR_TOKEN");
  });

  test("staging file is written 0600 and contains the values (this file IS meant to carry secret material)", () => {
    const path = join(dir, "secrets.env");
    writeSecretsStagingFile(path, { FOO: "bar-secret" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf-8")).toContain("FOO=bar-secret");
  });

  test("provisionSecrets never returns raw values — only mechanism/path/varNames/instructions", () => {
    const path = join(dir, "secrets.env");
    const result = provisionSecrets(ISSUER, { FLAIR_MCP_SIGNING_KEY_PEM: "super-secret-value" }, { stagingPath: path });
    expect(result.mechanism).toBe("env-file");
    expect(result.path).toBe(path);
    expect(result.varNames).toEqual(["FLAIR_MCP_SIGNING_KEY_PEM"]);
    expect(JSON.stringify(result)).not.toContain("super-secret-value");
    // The value legitimately lives in the staged file, just not in the result.
    expect(readFileSync(path, "utf-8")).toContain("super-secret-value");
  });

  test("Fabric origin defaults to fabric-env-secrets and says so in the instructions", () => {
    const path = join(dir, "secrets.env");
    const result = provisionSecrets("https://tps.dtrt.harperfabric.com", { A: "b" }, { stagingPath: path });
    expect(result.mechanism).toBe("fabric-env-secrets");
    expect(result.instructions).toContain("Fabric Studio");
  });
});

// ─── identity mapping (Credential kind:idp) ──────────────────────────────────

function mockOpsFetch(opts: {
  existingPrincipal?: boolean;
  existingCredential?: { id: string } | null;
  failFind?: boolean;
  failFindStatus?: number;
  failInsert?: boolean;
  failUpsert?: boolean;
} = {}): { fetchImpl: typeof fetch; calls: any[] } {
  const calls: any[] = [];
  const fetchImpl = (async (url: any, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ url: String(url), body });
    if (body.operation === "search_by_value" && body.table === "Agent") {
      if (opts.failFind) return new Response("boom", { status: opts.failFindStatus ?? 500 });
      return new Response(JSON.stringify(opts.existingPrincipal ? [{ id: body.search_value }] : []), { status: 200 });
    }
    if (body.operation === "insert" && body.table === "Agent") {
      if (opts.failInsert) return new Response("insert failed", { status: 500 });
      return new Response(JSON.stringify({ message: "inserted" }), { status: 200 });
    }
    if (body.operation === "search_by_conditions" && body.table === "Credential") {
      return new Response(JSON.stringify(opts.existingCredential ? [opts.existingCredential] : []), { status: 200 });
    }
    if (body.operation === "upsert" && body.table === "Credential") {
      if (opts.failUpsert) return new Response("upsert failed", { status: 500 });
      return new Response(JSON.stringify({ message: "upserted" }), { status: 200 });
    }
    if (body.operation === "set_configuration") {
      return new Response(JSON.stringify({ message: "Configuration successfully set." }), { status: 200 });
    }
    if (body.operation === "restart") {
      return new Response(JSON.stringify({ message: "restarting" }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("provisionIdpIdentityMapping", () => {
  test("creates the principal when missing and a fresh credential", async () => {
    const { fetchImpl, calls } = mockOpsFetch({ existingPrincipal: false, existingCredential: null });
    const result = await provisionIdpIdentityMapping(
      { opsPortOrUrl: ISSUER, adminUser: "admin", adminPass: "pw", principal: "self", principalKind: "human", idpProvider: "github", idpSubject: "octocat" },
      { fetchImpl, now: () => "2026-07-19T00:00:00.000Z" },
    );
    expect(result.principalCreated).toBe(true);
    expect(result.credentialReused).toBe(false);
    const ops = calls.map((c) => c.body.operation);
    expect(ops).toEqual(["search_by_value", "insert", "search_by_conditions", "upsert"]);
    const credRecord = calls[3].body.records[0];
    expect(credRecord.kind).toBe("idp");
    expect(credRecord.idpProvider).toBe("github");
    expect(credRecord.idpSubject).toBe("octocat");
    expect(credRecord.principalId).toBe("self");
  });

  test("reuses an existing principal and an existing credential mapping (idempotent re-run)", async () => {
    const { fetchImpl, calls } = mockOpsFetch({ existingPrincipal: true, existingCredential: { id: "cred_existing" } });
    const result = await provisionIdpIdentityMapping(
      { opsPortOrUrl: ISSUER, adminUser: "admin", adminPass: "pw", principal: "self", principalKind: "human", idpProvider: "github", idpSubject: "octocat" },
      { fetchImpl },
    );
    expect(result.principalCreated).toBe(false);
    expect(result.credentialReused).toBe(true);
    expect(result.credentialId).toBe("cred_existing");
    const ops = calls.map((c) => c.body.operation);
    expect(ops).toEqual(["search_by_value", "search_by_conditions", "upsert"]);
  });

  test("throws on a failed principal lookup, never proceeds to write", async () => {
    const { fetchImpl, calls } = mockOpsFetch({ failFind: true });
    await expect(
      provisionIdpIdentityMapping(
        { opsPortOrUrl: ISSUER, adminUser: "admin", adminPass: "pw", principal: "self", principalKind: "human", idpProvider: "github", idpSubject: "octocat" },
        { fetchImpl },
      ),
    ).rejects.toThrow(/the ops API call to .* failed/);
      // The old wording was "failed to look up principal '<x>'", which was wrong
      // and expensive: a MISSING principal returns 200 [] and the code below
      // creates it, so reaching this branch means the ops CALL failed. Blaming
      // the principal sent a reader to inspect principals while the real cause
      // was the endpoint. The guarantee under test — throws before any write —
      // is unchanged.
    expect(calls).toHaveLength(1);
  });

    test("a 404 names the served-origin cause and the flag that fixes it", async () => {
      // The failure an operator actually hit: ops calls sent to the served
      // origin, where the flair REST component owns "/" and answers 404. The old
      // message pointed at principals; this one has to point at the port.
      const { fetchImpl } = mockOpsFetch({ failFind: true, failFindStatus: 404 });
      await expect(
        provisionIdpIdentityMapping(
          { opsPortOrUrl: ISSUER, adminUser: "admin", adminPass: "pw", principal: "self", principalKind: "human", idpProvider: "github", idpSubject: "octocat" },
          { fetchImpl },
        ),
      ).rejects.toThrow(/served origin rather than the ops API/);
    });
});

// ─── restart only ────────────────────────────────────────────────────────────

describe("triggerRemoteRestart", () => {
  test("calls restart only", async () => {
    const { fetchImpl, calls } = mockOpsFetch();
    await triggerRemoteRestart(ISSUER, "admin", "pw", { fetchImpl });
    expect(calls.map((c) => c.body.operation)).toEqual(["restart"]);
  });

  test("throws on a non-2xx restart response", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    await expect(triggerRemoteRestart(ISSUER, "admin", "pw", { fetchImpl })).rejects.toThrow(/restart failed/);
  });
});

// ─── self-verify (never reports success on hope; flair#756 adds the CIMD
// advertisement check) ────────────────────────────────────────────────────

const CIMD_METADATA = {
  issuer: ISSUER,
  registration_endpoint: `${ISSUER}/oauth/mcp/register`,
  token_endpoint: `${ISSUER}/oauth/mcp/token`,
  client_id_metadata_document_supported: true,
  token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
};

describe("selfVerifyMcpMetadata", () => {
  test("ok:true, cimdSupported:true on a well-formed metadata response advertising CIMD", async () => {
    const fetchImpl = (async (url: any) => {
      expect(String(url)).toBe(`${ISSUER}/.well-known/oauth-authorization-server`);
      return new Response(JSON.stringify(CIMD_METADATA), { status: 200 });
    }) as typeof fetch;
    const result = await selfVerifyMcpMetadata(ISSUER, { fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.cimdSupported).toBe(true);
    expect(result.registrationEndpoint).toBe(`${ISSUER}/oauth/mcp/register`);
  });

  test("ok:false with a named reason on a non-2xx", async () => {
    const fetchImpl = (async () => new Response("not found", { status: 404 })) as typeof fetch;
    const result = await selfVerifyMcpMetadata(ISSUER, { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("404");
    expect(result.detail).toContain("FLAIR_MCP_OAUTH");
  });

  test("ok:false when the endpoint is unreachable", async () => {
    const fetchImpl = (async () => { throw new TypeError("fetch failed: connection refused"); }) as typeof fetch;
    const result = await selfVerifyMcpMetadata(ISSUER, { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("could not reach");
  });

  test("ok:false on an issuer mismatch (defense against a spoofed/misrouted response)", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ issuer: "https://evil.example.com", registration_endpoint: "x", token_endpoint: "y" }), { status: 200 })) as typeof fetch;
    const result = await selfVerifyMcpMetadata(ISSUER, { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("unexpected");
  });

  test("ok:false on non-JSON response", async () => {
    const fetchImpl = (async () => new Response("<html>nope</html>", { status: 200 })) as typeof fetch;
    const result = await selfVerifyMcpMetadata(ISSUER, { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("did not return JSON");
  });

  test("flair#756: ok:false, cimdSupported:false when client_id_metadata_document_supported is missing", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ issuer: ISSUER, registration_endpoint: `${ISSUER}/oauth/mcp/register`, token_endpoint: `${ISSUER}/oauth/mcp/token` }),
        { status: 200 },
      )) as typeof fetch;
    const result = await selfVerifyMcpMetadata(ISSUER, { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.cimdSupported).toBe(false);
    expect(result.detail).toContain("CIMD");
  });

  test("flair#756: ok:false when token_endpoint_auth_methods_supported doesn't include \"none\"", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          issuer: ISSUER,
          registration_endpoint: `${ISSUER}/oauth/mcp/register`,
          token_endpoint: `${ISSUER}/oauth/mcp/token`,
          client_id_metadata_document_supported: true,
          token_endpoint_auth_methods_supported: ["client_secret_basic"],
        }),
        { status: 200 },
      )) as typeof fetch;
    const result = await selfVerifyMcpMetadata(ISSUER, { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.cimdSupported).toBe(false);
  });

  test("flair#1000: flair's OWN authorization-server document is named as such, not blamed on CIMD config", async () => {
    // Since flair#1000, /.well-known/oauth-authorization-server is served by
    // flair itself whenever FLAIR_MCP_OAUTH is off — so a 200 here no longer
    // means the plugin answered. The operator's actual mistake is the flag (or
    // the missing component declaration); sending them to
    // clientIdMetadataDocuments.enabled would misdirect.
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          issuer: ISSUER,
          registration_endpoint: `${ISSUER}/OAuthRegister`,
          token_endpoint: `${ISSUER}/OAuthToken`,
          token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
          code_challenge_methods_supported: ["S256"],
        }),
        { status: 200 },
      )) as typeof fetch;
    const result = await selfVerifyMcpMetadata(ISSUER, { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("FLAIR_MCP_OAUTH");
    expect(result.detail).toContain("@harperfast/oauth");
    // Must NOT blame CIMD configuration — that is the misdirection this guards.
    expect(result.detail).not.toContain("clientIdMetadataDocuments");
  });
});

describe("buildClaudePasteBlock", () => {
  test("includes the resource URL, and explicitly says no client ID is needed", () => {
    const block = buildClaudePasteBlock(`${ISSUER}/mcp`);
    expect(block).toContain(`${ISSUER}/mcp`);
    expect(block).toContain("Settings");
    expect(block).toContain("no client ID");
  });
});

// ─── enableMcp orchestration ──────────────────────────────────────────────────

function fullMockFetch(overrides: { verifyStatus?: number; verifyBody?: any; sysInfoPidProvider?: () => number } = {}): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  let _sysInfoCallCount = 0;
  const fetchImpl = (async (url: any, init?: RequestInit) => {
    const urlStr = String(url);
    if (urlStr === `${ISSUER}/.well-known/oauth-authorization-server`) {
      calls.push("self-verify");
      const status = overrides.verifyStatus ?? 200;
      const body = overrides.verifyBody ?? CIMD_METADATA;
      return new Response(JSON.stringify(body), { status });
     }
     // Ops API (identity mapping + set_configuration + restart + system_information)
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push(`ops:${body.operation}`);
    if (body.operation === "search_by_value") return new Response(JSON.stringify([{ id: "self" }]), { status: 200 }); // principal exists
    if (body.operation === "search_by_conditions") return new Response(JSON.stringify([]), { status: 200 }); // no existing credential
    if (body.operation === "system_information") {
       _sysInfoCallCount++;
       const pid = overrides.sysInfoPidProvider
            ? overrides.sysInfoPidProvider()
            : (_sysInfoCallCount === 1 ? 12345 : 67890);    // happy path: PID changes (real restart)
      return new Response(JSON.stringify({ harperdb_processes: { core: [{ pid }] } }), { status: 200 });
      }
    return new Response(JSON.stringify({ message: "ok" }), { status: 200 });
   }) as typeof fetch;
  return { fetchImpl, calls };
}

const BASE_PARAMS = {
  instance: ISSUER,
  idpClientId: "client-id",
  idpClientSecret: "client-secret",
  idpSubject: "octocat",
  adminUser: "admin",
  adminPass: "pw",
};

function tempPaths() {
  return {
    signingKeyFilePath: join(dir, "signing-key.pem"),
    secretsStagingPath: join(dir, "secrets.env"),
    localConfigPath: join(dir, "config.yaml"),
  };
}

describe("enableMcp — local-origin refusal", () => {
  test("refuses immediately with zero fetch calls", async () => {
    const { fetchImpl, calls } = fullMockFetch();
    const result = await enableMcp(
      { ...BASE_PARAMS, ...tempPaths(), instance: "http://localhost:9926" },
      { fetchImpl },
    );
    expect(result.ok).toBe(false);
    expect(result.refused?.message).toContain("claude.ai connectors need a public HTTPS origin");
    expect(result.failedStep).toBe("local-origin-check");
    expect(calls).toHaveLength(0);
  });
});

describe("enableMcp — dry-run", () => {
  test("generates the signing key on disk and stops before any remote call", async () => {
    const { fetchImpl, calls } = fullMockFetch();
    const paths = tempPaths();
    const result = await enableMcp({ ...BASE_PARAMS, ...paths, dryRun: true }, { fetchImpl });

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(calls).toHaveLength(0);
    expect(existsSync(paths.signingKeyFilePath)).toBe(true);
    expect(result.issuer).toBe(ISSUER);
    expect(result.resource).toBe(`${ISSUER}/mcp`);
    expect(result.callbackUrl).toBe(`${ISSUER}/oauth/github/callback`);
  });

  test("still fails at idp-credentials when required values are missing, even in dry-run", async () => {
    const { fetchImpl, calls } = fullMockFetch();
    const paths = tempPaths();
    const result = await enableMcp(
      { instance: ISSUER, adminUser: "admin", adminPass: "pw", dryRun: true, ...paths },
      { fetchImpl },
    );
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("idp-credentials");
    expect(calls).toHaveLength(0);
  });
});

describe("enableMcp — the confirm-secrets-applied gate", () => {
  test("refuses to restart without confirmation, and never calls restart", async () => {
    const { fetchImpl, calls } = fullMockFetch();
    const result = await enableMcp({ ...BASE_PARAMS, ...tempPaths() }, { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("secrets-provisioning");
    expect(calls.filter((c) => c === "ops:restart")).toHaveLength(0);
    // Identity mapping DOES run before the gate.
    expect(calls).toContain("ops:search_by_value");
  });

  test("an interactive confirmPrompt returning false also refuses", async () => {
    const { fetchImpl } = fullMockFetch();
    const result = await enableMcp(
      { ...BASE_PARAMS, ...tempPaths() },
      { fetchImpl, confirmPrompt: async () => false },
    );
    expect(result.ok).toBe(false);
  });
});

describe("enableMcp — full happy path", () => {
  test("runs every step in order and returns a working paste block with no DCR call anywhere", async () => {
    const { fetchImpl, calls } = fullMockFetch();
    const result = await enableMcp(
      { ...BASE_PARAMS, ...tempPaths(), confirmSecretsApplied: true },
      { fetchImpl },
    );

    expect(result.ok).toBe(true);
    expect(result.steps.every((s) => s.ok)).toBe(true);
    expect(result.steps.map((s) => s.step)).toEqual([
      "local-origin-check",
      "signing-key",
      "config-block",
      "idp-credentials",
      "secrets-provisioning",
      "identity-mapping",
      "local-config-update",
      "restart",
      "verify-restart",
      "self-verify",
    ]);
    expect(result.pasteBlock).toContain(`${ISSUER}/mcp`);
    expect(result.pasteBlock).not.toContain("Client ID:");
    expect(result.secretsMechanism).toBe("env-file");

    // flair#756: no DCR call anywhere in the flow — the only calls after
    // restart are the ops API restart itself and self-verify.
    expect(calls).not.toContain("dcr-register");
    expect(calls.some((c) => c.includes("oauth/mcp/register"))).toBe(false);
    // flair#1136: set_configuration is removed — only restart is called.
    expect(calls).not.toContain("ops:set_configuration");
    const restartIdx = calls.indexOf("ops:restart");
    const verifyIdx = calls.indexOf("self-verify");
    expect(restartIdx).toBeGreaterThan(-1);
    expect(verifyIdx).toBeGreaterThan(restartIdx);
  });

  test("no secret VALUES ever appear anywhere in the result object", async () => {
    const { fetchImpl } = fullMockFetch();
    const SENTINEL_SECRET = "client-secret";
    const result = await enableMcp(
      { ...BASE_PARAMS, ...tempPaths(), idpClientSecret: SENTINEL_SECRET, confirmSecretsApplied: true },
      { fetchImpl },
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SENTINEL_SECRET);
    expect(serialized).not.toContain("BEGIN PRIVATE KEY");
  });

  test("performs zero console output (pure, injectable I/O only)", async () => {
    const { fetchImpl } = fullMockFetch();
    const originalLog = console.log;
    const originalError = console.error;
    let calls = 0;
    console.log = () => { calls++; };
    console.error = () => { calls++; };
    try {
      await enableMcp({ ...BASE_PARAMS, ...tempPaths(), confirmSecretsApplied: true }, { fetchImpl });
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
    expect(calls).toBe(0);
  });
});

describe("enableMcp — self-verify failure names the step to re-run", () => {
  test("ok:false, failedStep 'self-verify', but the restart step already succeeded", async () => {
    const { fetchImpl } = fullMockFetch({ verifyStatus: 404 });
    const result = await enableMcp(
      { ...BASE_PARAMS, ...tempPaths(), confirmSecretsApplied: true },
      { fetchImpl },
    );
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("self-verify");
    const byStep = Object.fromEntries(result.steps.map((s) => [s.step, s.ok]));
    expect(byStep["restart"]).toBe(true);
    expect(byStep["self-verify"]).toBe(false);
    // Never reports success on hope.
    expect(result.ok).not.toBe(true);
  });

  test("flair#756: self-verify also fails when the restarted instance doesn't advertise CIMD", async () => {
    const { fetchImpl } = fullMockFetch({
      verifyBody: {
        issuer: ISSUER,
        registration_endpoint: `${ISSUER}/oauth/mcp/register`,
        token_endpoint: `${ISSUER}/oauth/mcp/token`,
        // client_id_metadata_document_supported omitted — CIMD not advertised.
        token_endpoint_auth_methods_supported: ["client_secret_basic"],
      },
    });
    const result = await enableMcp(
      { ...BASE_PARAMS, ...tempPaths(), confirmSecretsApplied: true },
      { fetchImpl },
    );
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("self-verify");
  });
});

// ─── disableMcp — symmetry with enable's confirmation gate ──────────────────

describe("disableMcp", () => {
  test("refuses without confirmation, calls restart zero times", async () => {
    const { fetchImpl, calls } = mockOpsFetch();
    const result = await disableMcp({ instance: ISSUER, adminUser: "admin", adminPass: "pw" }, { fetchImpl });
    expect(result.ok).toBe(false);
    expect(calls.filter((c) => c.body.operation === "restart")).toHaveLength(0);
  });

  test("confirmFlagOff:true triggers exactly one restart call", async () => {
    const { fetchImpl, calls } = mockOpsFetch();
    const result = await disableMcp({ instance: ISSUER, adminUser: "admin", adminPass: "pw", confirmFlagOff: true }, { fetchImpl });
    expect(result.ok).toBe(true);
    expect(calls.map((c) => c.body.operation)).toEqual(["restart"]);
  });

  test("an interactive confirmPrompt gates the same way", async () => {
    const { fetchImpl } = mockOpsFetch();
    const refused = await disableMcp({ instance: ISSUER, adminUser: "admin", adminPass: "pw" }, { fetchImpl, confirmPrompt: async () => false });
    expect(refused.ok).toBe(false);
    const allowed = await disableMcp({ instance: ISSUER, adminUser: "admin", adminPass: "pw" }, { fetchImpl, confirmPrompt: async () => true });
    expect(allowed.ok).toBe(true);
  });

  test("a restart failure is reported, not swallowed", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    const result = await disableMcp({ instance: ISSUER, adminUser: "admin", adminPass: "pw", confirmFlagOff: true }, { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("restart failed");
  });
});

// ─── mcpStatus ────────────────────────────────────────────────────────────────

describe("mcpStatus", () => {
  test("enabled:true, cimdSupported:true when the metadata endpoint advertises CIMD", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify(CIMD_METADATA), { status: 200 })) as typeof fetch;
    const result = await mcpStatus({ instance: ISSUER }, { fetchImpl, countMachineClients: () => 3 });
    expect(result.enabled).toBe(true);
    expect(result.cimdSupported).toBe(true);
    expect(result.machineClientCount).toBe(3);
  });

  test("enabled:false when the endpoint is unreachable/disabled", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 404 })) as typeof fetch;
    const result = await mcpStatus({ instance: ISSUER }, { fetchImpl });
    expect(result.enabled).toBe(false);
  });

  test("enabled:false when the endpoint answers but doesn't advertise CIMD", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ issuer: ISSUER, registration_endpoint: "x", token_endpoint: "y" }),
        { status: 200 },
      )) as typeof fetch;
    const result = await mcpStatus({ instance: ISSUER }, { fetchImpl });
    expect(result.enabled).toBe(false);
    expect(result.cimdSupported).toBe(false);
  });
});

// ─── flair#1120: restart verification ─────────────────────────────────────

import {
  captureBootDiscriminator,
} from "../../src/lib/mcp-enable.js";

const OPS_URL = "https://flair.example.com:9925/";

describe("captureBootDiscriminator", () => {
  test("extracts the PID from harperdb_processes.core[0]", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ harperdb_processes: { core: [{ pid: 12345 }] } }),
         { status: 200 },
       )) as typeof fetch;
    const result = await captureBootDiscriminator("https://flair.example.com", "admin", "pw", { fetchImpl });
    expect(result.pid).toBe(12345);
   });

  test("throws on non-2xx response", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    await expect(captureBootDiscriminator("https://flair.example.com", "admin", "pw", { fetchImpl })).rejects.toThrow("system_information failed (HTTP 500)");
   });

  test("throws when no PID is found in the response body", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ harperdb_processes: { core: [] } }), { status: 200 })) as typeof fetch;
    await expect(captureBootDiscriminator("https://flair.example.com", "admin", "pw", { fetchImpl })).rejects.toThrow("no harperdb_processes.core entry with a PID");
   });
});

describe("enableMcp — flair#1120 restart verification", () => {
  test("sysinfo fails on first call: failedStep is restart, never identity-mapping", async () => {
    const calls: any[] = [];
    let sysInfoCount = 0;
    const fetchImpl = (async (url: any, init?: RequestInit) => {
      const urlStr = String(url);
      const body = JSON.parse(String(init?.body ?? "{}"));
      calls.push({ url: urlStr, body });
      if (body.operation === "system_information") {
        sysInfoCount++;
           // First call (pre-restart capture) always fails
        if (sysInfoCount === 1) {
          return new Response("sysinfo boom", { status: 500 });
          }
        return new Response(JSON.stringify({ harperdb_processes: { core: [{ pid: 67890 }] } }), { status: 200 });
           }
      if (body.operation === "search_by_value") return new Response(JSON.stringify([{ id: "self" }]), { status: 200 });
      if (body.operation === "search_by_conditions") return new Response(JSON.stringify([]), { status: 200 });
      if (body.table === "Credential") return new Response(JSON.stringify([]), { status: 200 });
      if (body.operation === "upsert") return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (urlStr.includes(".well-known")) {
        return new Response(JSON.stringify(CIMD_METADATA), { status: 200 });
          }
      return new Response(JSON.stringify({ message: "ok" }), { status: 200 });
         }) as typeof fetch;

    const paths = tempPaths();
    const result = await enableMcp(
         {
         ...BASE_PARAMS,
         ...paths,
        confirmSecretsApplied: true,
        },
        { fetchImpl },
        );

    expect(result.ok).toBe(false);
       // captureBootDiscriminator is the first act of restart,
       // so its failure must be attributed there — never back to identity-mapping.
    expect(result.failedStep).toBe("restart");
    expect(result.failedStep).not.toBe("identity-mapping");
    });

  test("unchanged PID after restart fails at verify-restart with loud error, never prints checkmark", async () => {
    const calls: any[] = [];
    let sysInfoCallCount = 0;
    // Mock fetch: system_information always returns same PID (simulating thread bounce)
    const fetchImpl = (async (url: any, init?: RequestInit) => {
      const urlStr = String(url);
      const body = JSON.parse(String(init?.body ?? "{}"));
      calls.push({ url: urlStr, body });
      if (body.operation === "system_information") {
        sysInfoCallCount++;
         // Always same PID — thread bounce
        return new Response(JSON.stringify({ harperdb_processes: { core: [{ pid: 12345 }] } }), { status: 200 });
       }
      if (body.operation === "search_by_value") return new Response(JSON.stringify([{ id: "self" }]), { status: 200 });
      if (body.operation === "search_by_conditions") return new Response(JSON.stringify([]), { status: 200 });
      if (body.table === "Credential") return new Response(JSON.stringify([]), { status: 200 });
      if (body.operation === "upsert") return new Response(JSON.stringify({ ok: true }), { status: 200 });
       // self-verify endpoint
      if (urlStr.includes(".well-known")) {
        return new Response(JSON.stringify(CIMD_METADATA), { status: 200 });
       }
      // ops API default success
      return new Response(JSON.stringify({ message: "ok" }), { status: 200 });
     }) as typeof fetch;

    const paths = tempPaths();
    const result = await enableMcp(
       {
        ...BASE_PARAMS,
        ...paths,
        confirmSecretsApplied: true,
       },
       {
         fetchImpl,
         waitForOpsApiTimeoutMs: 200,
         waitForOpsApiPollMs: 10,
        },
     );

    // The overall result must be a failure
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("verify-restart");
     // The verify-restart step must be in the step list and must NOT have a checkmark
    const verifyStep = result.steps.find((s) => s.step === "verify-restart");
    expect(verifyStep).toBeDefined();
    expect(verifyStep!.ok).toBe(false);
    expect(verifyStep!.detail).toContain("did not confirm a new process");
     // self-verify must NOT have run (we fail before reaching it)
    expect(result.steps.some((s) => s.step === "self-verify")).toBe(false);
   });

  test("changed PID after restart passes verification and proceeds to self-verify", async () => {
    const calls: any[] = [];
    let sysInfoCallCount = 0;
    // Mock fetch: system_information returns different PID on second call (real restart)
    const fetchImpl = (async (url: any, init?: RequestInit) => {
      const urlStr = String(url);
      const body = JSON.parse(String(init?.body ?? "{}"));
      calls.push({ url: urlStr, body });
      if (body.operation === "system_information") {
        sysInfoCallCount++;
         // First call = pre-restart PID, second call = post-restart PID
        const pid = sysInfoCallCount === 1 ? 12345 : 67890;
        return new Response(JSON.stringify({ harperdb_processes: { core: [{ pid }] } }), { status: 200 });
       }
      if (body.operation === "search_by_value") return new Response(JSON.stringify([{ id: "self" }]), { status: 200 });
      if (body.operation === "search_by_conditions") return new Response(JSON.stringify([]), { status: 200 });
      if (body.table === "Credential") return new Response(JSON.stringify([]), { status: 200 });
      if (body.operation === "upsert") return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (urlStr.includes(".well-known")) {
        return new Response(JSON.stringify(CIMD_METADATA), { status: 200 });
       }
      return new Response(JSON.stringify({ message: "ok" }), { status: 200 });
     }) as typeof fetch;

    const paths = tempPaths();
    const result = await enableMcp(
       {
        ...BASE_PARAMS,
        ...paths,
        confirmSecretsApplied: true,
       },
       { fetchImpl },
     );

    // The overall result must succeed
    expect(result.ok).toBe(true);
     // All steps including verify-restart must be ok
    const verifyStep = result.steps.find((s) => s.step === "verify-restart");
    expect(verifyStep).toBeDefined();
    expect(verifyStep!.ok).toBe(true);
    expect(verifyStep!.detail).toContain("pid changed 12345 -> 67890");
     // self-verify must also have run
    const selfVerifyStep = result.steps.find((s) => s.step === "self-verify");
    expect(selfVerifyStep).toBeDefined();
   });

    // --- race: old process still answering post-restart (false-alarm prevention) ---

  test("old PID for first 2 polls then new PID: SUCCEEDS (no false alarm)", async () => {
    const calls: any[] = [];
    let sysInfoCount = 0;
    const fetchImpl = (async (url: any, init?: RequestInit) => {
      const urlStr = String(url);
      const body = JSON.parse(String(init?.body ?? "{}"));
      calls.push({ url: urlStr, body });
      if (body.operation === "system_information") {
        sysInfoCount++;
        if (sysInfoCount === 1) {
          return new Response(JSON.stringify({ harperdb_processes: { core: [{ pid: 12345 }] } }), { status: 200 });
          }
        if (sysInfoCount <= 3) {
          return new Response(JSON.stringify({ harperdb_processes: { core: [{ pid: 12345 }] } }), { status: 200 });
          }
        return new Response(JSON.stringify({ harperdb_processes: { core: [{ pid: 67890 }] } }), { status: 200 });
        }
      if (body.operation === "search_by_value") return new Response(JSON.stringify([{ id: "self" }]), { status: 200 });
      if (body.operation === "search_by_conditions") return new Response(JSON.stringify([]), { status: 200 });
      if (body.table === "Credential") return new Response(JSON.stringify([]), { status: 200 });
      if (body.operation === "upsert") return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (urlStr.includes(".well-known")) {
        return new Response(JSON.stringify(CIMD_METADATA), { status: 200 });
        }
      return new Response(JSON.stringify({ message: "ok" }), { status: 200 });
      }) as typeof fetch;

    const paths = tempPaths();
    const result = await enableMcp(
        {
          ...BASE_PARAMS,
          ...paths,
          confirmSecretsApplied: true,
        },
        {
          fetchImpl,
          waitForOpsApiTimeoutMs: 5000,
          waitForOpsApiPollMs: 10,
        },
      );

    expect(result.ok).toBe(true);
    const verifyStep = result.steps.find((s) => s.step === "verify-restart");
    expect(verifyStep).toBeDefined();
    expect(verifyStep!.ok).toBe(true);
    expect(verifyStep!.detail).toContain("pid changed 12345 -> 67890");
    const sysInfoCalls = calls.filter((c) => c.body.operation === "system_information");
    expect(sysInfoCalls.length).toBeGreaterThanOrEqual(4); // pre-capture + at least 2 polls + 1 success
  });

  test("always old PID: thread-bounce failure after timeout, failedStep verify-restart", async () => {
    const calls: any[] = [];
    let sysInfoCount = 0;
    const fetchImpl = (async (url: any, init?: RequestInit) => {
      const urlStr = String(url);
      const body = JSON.parse(String(init?.body ?? "{}"));
      calls.push({ url: urlStr, body });
      if (body.operation === "system_information") {
        sysInfoCount++;
          // Always same PID — thread bounce, never changes
        return new Response(JSON.stringify({ harperdb_processes: { core: [{ pid: 12345 }] } }), { status: 200 });
        }
      if (body.operation === "search_by_value") return new Response(JSON.stringify([{ id: "self" }]), { status: 200 });
      if (body.operation === "search_by_conditions") return new Response(JSON.stringify([]), { status: 200 });
      if (body.table === "Credential") return new Response(JSON.stringify([]), { status: 200 });
      if (body.operation === "upsert") return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (urlStr.includes(".well-known")) {
        return new Response(JSON.stringify(CIMD_METADATA), { status: 200 });
        }
      return new Response(JSON.stringify({ message: "ok" }), { status: 200 });
      }) as typeof fetch;

    const paths = tempPaths();
    const result = await enableMcp(
        {
          ...BASE_PARAMS,
          ...paths,
          confirmSecretsApplied: true,
        },
        {
          fetchImpl,
          waitForOpsApiTimeoutMs: 200,
          waitForOpsApiPollMs: 20,
        },
      );

    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("verify-restart");
    const verifyStep = result.steps.find((s) => s.step === "verify-restart");
    expect(verifyStep).toBeDefined();
    expect(verifyStep!.ok).toBe(false);
    expect(verifyStep!.detail).toContain("did not confirm a new process");
    expect(verifyStep!.detail).toContain("Restart the instance manually, then re-run: flair mcp enable");
    const sysInfoCalls = calls.filter((c) => c.body.operation === "system_information");
    expect(sysInfoCalls.length).toBeGreaterThanOrEqual(5);
  });
});

// ─── flair#1136: updateLocalConfigMcpEnabled ────────────────────────────────

describe("updateLocalConfigMcpEnabled (flair#1136)", () => {
  let configDir: string;
  let configPath: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "flair-test-config-"));
    configPath = join(configDir, "config.yaml");
  });

  afterEach(() => {
    try { rmSync(configDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  // Regression guard (flair#1136): no test in this suite may mutate the repo's
  // own config.yaml. The no-explicit-path variant of updateLocalConfigMcpEnabled
  // once did — poisoning the mcp-oauth boot-safety integration test during the
  // 0.42.0 release cut (release.sh runs unit + integration in one process, so a
  // unit-test mutation reaches the integration lane; CI's separate lanes hid it).
  const REPO_CONFIG = join(import.meta.dir, "..", "..", "config.yaml");
  let repoConfigBefore = "";
  beforeAll(() => { repoConfigBefore = readFileSync(REPO_CONFIG, "utf-8"); });
  afterAll(() => {
    expect(readFileSync(REPO_CONFIG, "utf-8")).toBe(repoConfigBefore);
  });

  // The flair#1152 shape: no `resource` key (flair#1180 — derived by the
  // component), and mcp.enabled carrying either literal `false` (decisively
  // off) or the whole-token env reference (the shipped/enabled shape).
  const ENV_REF = "${FLAIR_MCP_OAUTH}";
  const CONFIG_WITH_MCP_DISABLED = `name: flair
rest: true
"@harperfast/oauth":
  package: "@harperfast/oauth"
  providers:
    github:
      clientId: "\${OAUTH_GITHUB_CLIENT_ID}"
      clientSecret: "\${OAUTH_GITHUB_CLIENT_SECRET}"
  mcp:
    enabled: false
    issuer: "\${FLAIR_MCP_ISSUER}"
    accessTokenTtl: 900
    dynamicClientRegistration:
      enabled: false
    clientIdMetadataDocuments:
      allowedHosts:
        - "claude.ai"
        - "claude.com"
    signingKeyPem: "\${FLAIR_MCP_SIGNING_KEY_PEM}"
`;
  const CONFIG_WITH_ENV_REF = CONFIG_WITH_MCP_DISABLED.replace(
    "enabled: false",
    `enabled: "\${FLAIR_MCP_OAUTH}"`,
  );

  test("enable writes the WHOLE-TOKEN env reference — never literal true (flair#1152)", () => {
    writeFileSync(configPath, CONFIG_WITH_MCP_DISABLED, "utf-8");
    const result = updateLocalConfigMcpEnabled(true, configPath);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain(`mcp.enabled set to ${ENV_REF}`);
    // Re-parse to verify the mutation is structural, not string-level.
    const updated = readFileSync(configPath, "utf-8");
    const doc = yaml.load(updated) as any;
    // The env reference — the on/off choice lives in the environment
    // (FLAIR_MCP_OAUTH, staged to "true" by the secrets bundle), so a re-packed
    // deploy can no longer revert it. A literal true here is the regression.
    expect(doc["@harperfast/oauth"].mcp.enabled).toBe(ENV_REF);
    expect(doc["@harperfast/oauth"].mcp.enabled).not.toBe(true);
    // dynamicClientRegistration.enabled is a separate key and stays false.
    expect(doc["@harperfast/oauth"].mcp.dynamicClientRegistration.enabled).toBe(false);
  });

  test("legacy literal true is normalized to the env reference on enable", () => {
    const legacyEnabled = CONFIG_WITH_MCP_DISABLED.replace("enabled: false", "enabled: true");
    writeFileSync(configPath, legacyEnabled, "utf-8");
    const result = updateLocalConfigMcpEnabled(true, configPath);
    expect(result.ok).toBe(true);
    const doc = yaml.load(readFileSync(configPath, "utf-8")) as any;
    expect(doc["@harperfast/oauth"].mcp.enabled).toBe(ENV_REF);
  });

  test("disable writes literal false — decisively off regardless of environment", () => {
    writeFileSync(configPath, CONFIG_WITH_ENV_REF, "utf-8");
    const result = updateLocalConfigMcpEnabled(false, configPath);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("mcp.enabled set to false");
    const doc = yaml.load(readFileSync(configPath, "utf-8")) as any;
    expect(doc["@harperfast/oauth"].mcp.enabled).toBe(false);
  });

  test("already at target value: no-op (disabled)", () => {
    writeFileSync(configPath, CONFIG_WITH_MCP_DISABLED, "utf-8");
    const result = updateLocalConfigMcpEnabled(false, configPath);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("already false");
    // File unchanged.
    expect(readFileSync(configPath, "utf-8")).toBe(CONFIG_WITH_MCP_DISABLED);
  });

  test("already at target value: no-op (env reference present, enable)", () => {
    writeFileSync(configPath, CONFIG_WITH_ENV_REF, "utf-8");
    const result = updateLocalConfigMcpEnabled(true, configPath);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain(`already ${ENV_REF}`);
    // File unchanged.
    expect(readFileSync(configPath, "utf-8")).toBe(CONFIG_WITH_ENV_REF);
  });

  test("file not found at explicit path", () => {
    const result = updateLocalConfigMcpEnabled(true, "/nonexistent/config.yaml");
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("not found");
  });

  test("file not found: reports the searched path (no ambient mutation)", () => {
    // Do NOT call updateLocalConfigMcpEnabled(true) with no path: its default
    // search is ["config.yaml", ~/.flair/config.yaml], so from the repo root it
    // finds and MUTATES the repo's own config.yaml, and from elsewhere would
    // mutate a real ~/.flair config. That poisoned the boot-safety integration
    // test during the flair#1136 release cut. Use an explicit missing path.
    const missing = join(configDir, "does-not-exist", "config.yaml");
    const result = updateLocalConfigMcpEnabled(true, missing);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("not found");
  });

  test("no @harperfast/oauth block in config", () => {
    const noOauth = "name: flair\nrest: true\n";
    writeFileSync(configPath, noOauth, "utf-8");
    const result = updateLocalConfigMcpEnabled(true, configPath);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("@harperfast/oauth block not found");
  });

  test("no mcp key under @harperfast/oauth", () => {
    const noMcp = `name: flair
"@harperfast/oauth":
  package: "@harperfast/oauth"
  providers:
    github:
      clientId: "x"
      clientSecret: "y"
`;
    writeFileSync(configPath, noMcp, "utf-8");
    const result = updateLocalConfigMcpEnabled(true, configPath);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("mcp key not found");
  });

  test("updates ONLY mcp.enabled when both enabled keys are present (flair#1136 safety)", () => {
    // This is the critical safety test: the config has TWO `enabled: false`
    // keys (mcp.enabled and dynamicClientRegistration.enabled). The YAML-based
    // implementation navigates to the exact key, so it can never flip the
    // wrong one.
    writeFileSync(configPath, CONFIG_WITH_MCP_DISABLED, "utf-8");
    const result = updateLocalConfigMcpEnabled(true, configPath);
    expect(result.ok).toBe(true);
    const doc = yaml.load(readFileSync(configPath, "utf-8")) as any;
    // Only mcp.enabled updated — to the env reference (flair#1152).
    expect(doc["@harperfast/oauth"].mcp.enabled).toBe(ENV_REF);
    // dynamicClientRegistration.enabled is untouched.
    expect(doc["@harperfast/oauth"].mcp.dynamicClientRegistration.enabled).toBe(false);
  });

  test("loud no-op when config is malformed YAML", () => {
    writeFileSync(configPath, "this is not valid: yaml: [", "utf-8");
    const result = updateLocalConfigMcpEnabled(true, configPath);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("cannot parse");
  });

  test("preserves other config content structurally", () => {
    writeFileSync(configPath, CONFIG_WITH_MCP_DISABLED, "utf-8");
    updateLocalConfigMcpEnabled(true, configPath);
    const doc = yaml.load(readFileSync(configPath, "utf-8")) as any;
    expect(doc.name).toBe("flair");
    expect(doc.rest).toBe(true);
    expect(doc["@harperfast/oauth"].package).toBe("@harperfast/oauth");
    expect(doc["@harperfast/oauth"].mcp.accessTokenTtl).toBe(900);
    expect(doc["@harperfast/oauth"].mcp.clientIdMetadataDocuments.allowedHosts).toEqual(["claude.ai", "claude.com"]);
  });
});

// ─── flair#1136: Fabric operator-deploy path ────────────────────────────────

describe("enableMcp — Fabric operator-deploy (flair#1136)", () => {
  test("Fabric origin: reports operator-deploy requirement, never restarts", async () => {
    const FABRIC_ISSUER = "https://my-flair.harperfabric.com";
    const calls: string[] = [];
    const fetchImpl = (async (url: any, init?: RequestInit) => {
      const urlStr = String(url);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push(`ops:${body.operation ?? urlStr}`);
      if (body.operation === "search_by_value") return new Response(JSON.stringify([{ id: "self" }]), { status: 200 });
      if (body.operation === "search_by_conditions") return new Response(JSON.stringify([]), { status: 200 });
      if (body.operation === "upsert") return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response(JSON.stringify({ message: "ok" }), { status: 200 });
    }) as typeof fetch;

    const result = await enableMcp(
      {
        instance: FABRIC_ISSUER,
        idpClientId: "client-id",
        idpClientSecret: "client-secret",
        idpSubject: "octocat",
        adminUser: "admin",
        adminPass: "pw",
        signingKeyFilePath: join(dir, "signing-key.pem"),
        secretsStagingPath: join(dir, "secrets.env"),
        confirmSecretsApplied: true,
      },
      { fetchImpl },
    );

    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("fabric-operator-deploy");
    // Must NOT call restart.
    expect(calls).not.toContain("ops:restart");
    // Must report the requirement loudly.
    const fabricStep = result.steps.find((s) => s.step === "fabric-operator-deploy");
    expect(fabricStep).toBeDefined();
    expect(fabricStep!.ok).toBe(false);
    expect(fabricStep!.detail).toContain("harperfabric.com");
    // flair#1152: the guidance is env-first — set FLAIR_MCP_OAUTH in the
    // instance environment; NEVER "edit the deployed config.yaml" (a
    // re-packed deploy reverts that edit, which was the whole bug).
    expect(fabricStep!.detail).toContain("FLAIR_MCP_OAUTH");
    expect(fabricStep!.detail).toContain("environment");
    expect(fabricStep!.detail).not.toContain("mcp.enabled: true");
    // Earlier steps (secrets, identity) still succeeded.
    const byStep = Object.fromEntries(result.steps.map((s) => [s.step, s.ok]));
    expect(byStep["secrets-provisioning"]).toBe(true);
    expect(byStep["identity-mapping"]).toBe(true);
  });

  test("Fabric origin: result includes issuer and resource for status checks", async () => {
    const FABRIC_ISSUER = "https://my-flair.harperfabric.com";
    const fetchImpl = (async (url: any, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (body.operation === "search_by_value") return new Response(JSON.stringify([{ id: "self" }]), { status: 200 });
      if (body.operation === "search_by_conditions") return new Response(JSON.stringify([]), { status: 200 });
      if (body.operation === "upsert") return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response(JSON.stringify({ message: "ok" }), { status: 200 });
    }) as typeof fetch;

    const result = await enableMcp(
      {
        instance: FABRIC_ISSUER,
        idpClientId: "client-id",
        idpClientSecret: "client-secret",
        idpSubject: "octocat",
        adminUser: "admin",
        adminPass: "pw",
        signingKeyFilePath: join(dir, "signing-key.pem"),
        secretsStagingPath: join(dir, "secrets.env"),
        confirmSecretsApplied: true,
      },
      { fetchImpl },
    );

    expect(result.issuer).toBe(FABRIC_ISSUER);
    expect(result.resource).toBe(`${FABRIC_ISSUER}/mcp`);
    expect(result.secretsMechanism).toBe("fabric-env-secrets");
  });
});

// ─── flair#1136: standalone path with local config update ───────────────────

describe("enableMcp — standalone local config update (flair#1136)", () => {
  test("standalone: local-config-update step runs before restart", async () => {
    const { fetchImpl } = fullMockFetch();
    const result = await enableMcp(
      { ...BASE_PARAMS, ...tempPaths(), confirmSecretsApplied: true },
      { fetchImpl },
    );

    expect(result.ok).toBe(true);
    const steps = result.steps.map((s) => s.step);
    const localConfigIdx = steps.indexOf("local-config-update");
    const restartIdx = steps.indexOf("restart");
    expect(localConfigIdx).toBeGreaterThan(-1);
    expect(restartIdx).toBeGreaterThan(localConfigIdx);
  });

  test("standalone: no set_configuration call anywhere", async () => {
    const { fetchImpl, calls } = fullMockFetch();
    await enableMcp(
      { ...BASE_PARAMS, ...tempPaths(), confirmSecretsApplied: true },
      { fetchImpl },
    );
    expect(calls).not.toContain("ops:set_configuration");
  });

  test("standalone: restart IS called (only restart, not set_configuration)", async () => {
    const { fetchImpl, calls } = fullMockFetch();
    await enableMcp(
      { ...BASE_PARAMS, ...tempPaths(), confirmSecretsApplied: true },
      { fetchImpl },
    );
    expect(calls).toContain("ops:restart");
  });
});
