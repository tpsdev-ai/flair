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
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  applyRemoteConfigAndRestart,
  triggerRemoteRestart,
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "flair-mcp-enable-"));
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
    expect(oauth.mcp.enabled).toBe(true);
    expect(oauth.mcp.accessTokenTtl).toBe(REQUIRED_ACCESS_TOKEN_TTL);
    expect(oauth.mcp.accessTokenTtl).toBe(900);
    expect(oauth.mcp.clientIdMetadataDocuments.allowedHosts).toEqual(DEFAULT_CIMD_ALLOWED_HOSTS);
    expect(oauth.mcp.signingKeyPem).toBe("${FLAIR_MCP_SIGNING_KEY_PEM}");
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
    expect(bundle.FLAIR_MCP_OAUTH).toBe("1");
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
  failInsert?: boolean;
  failUpsert?: boolean;
} = {}): { fetchImpl: typeof fetch; calls: any[] } {
  const calls: any[] = [];
  const fetchImpl = (async (url: any, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ url: String(url), body });
    if (body.operation === "search_by_value" && body.table === "Agent") {
      if (opts.failFind) return new Response("boom", { status: 500 });
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
    ).rejects.toThrow(/failed to look up principal/);
    expect(calls).toHaveLength(1);
  });
});

// ─── apply config + restart ──────────────────────────────────────────────────

describe("applyRemoteConfigAndRestart", () => {
  test("calls set_configuration then restart, in that order", async () => {
    const { fetchImpl, calls } = mockOpsFetch();
    await applyRemoteConfigAndRestart(
      { opsPortOrUrl: ISSUER, adminUser: "admin", adminPass: "pw", configBlock: { "@harperfast/oauth": { mcp: { enabled: true } } } },
      { fetchImpl },
    );
    expect(calls.map((c) => c.body.operation)).toEqual(["set_configuration", "restart"]);
    // set_configuration's body spreads the config block at the top level
    // alongside `operation` (matches @harperfast/harper's setConfiguration
    // destructuring: `{ operation, hdb_user, hdbAuthHeader, ...configFields }`).
    expect(calls[0].body["@harperfast/oauth"]).toEqual({ mcp: { enabled: true } });
  });

  test("a failed set_configuration never calls restart", async () => {
    const calls: any[] = [];
    const fetchImpl = (async (url: any, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      calls.push(body);
      if (body.operation === "set_configuration") return new Response("nope", { status: 500 });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    await expect(
      applyRemoteConfigAndRestart({ opsPortOrUrl: ISSUER, adminUser: "admin", adminPass: "pw", configBlock: {} }, { fetchImpl }),
    ).rejects.toThrow(/set_configuration failed/);
    expect(calls).toHaveLength(1);
  });
});

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

function fullMockFetch(overrides: { verifyStatus?: number; verifyBody?: any } = {}): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (url: any, init?: RequestInit) => {
    const urlStr = String(url);
    if (urlStr === `${ISSUER}/.well-known/oauth-authorization-server`) {
      calls.push("self-verify");
      const status = overrides.verifyStatus ?? 200;
      const body = overrides.verifyBody ?? CIMD_METADATA;
      return new Response(JSON.stringify(body), { status });
    }
    // Ops API (identity mapping + set_configuration + restart)
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push(`ops:${body.operation}`);
    if (body.operation === "search_by_value") return new Response(JSON.stringify([{ id: "self" }]), { status: 200 }); // principal exists
    if (body.operation === "search_by_conditions") return new Response(JSON.stringify([]), { status: 200 }); // no existing credential
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
  test("refuses to restart without confirmation, and never calls set_configuration/restart", async () => {
    const { fetchImpl, calls } = fullMockFetch();
    const result = await enableMcp({ ...BASE_PARAMS, ...tempPaths() }, { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("apply-config-and-restart");
    expect(calls.filter((c) => c === "ops:set_configuration" || c === "ops:restart")).toHaveLength(0);
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
    expect(result.failedStep).toBe("apply-config-and-restart");
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
      "apply-config-and-restart",
      "self-verify",
    ]);
    expect(result.pasteBlock).toContain(`${ISSUER}/mcp`);
    expect(result.pasteBlock).not.toContain("Client ID:");
    expect(result.secretsMechanism).toBe("env-file");

    // flair#756: no DCR call anywhere in the flow — the only calls after
    // restart are the ops API restart itself and self-verify.
    expect(calls).not.toContain("dcr-register");
    expect(calls.some((c) => c.includes("oauth/mcp/register"))).toBe(false);
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
    expect(byStep["apply-config-and-restart"]).toBe(true);
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
