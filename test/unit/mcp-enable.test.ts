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
 *   - dry-run (no remote calls and no file written)
 *   - self-verify failure names the step to re-run, never reports success
 *     on hope — including the new CIMD-not-advertised failure mode
 *   - disable symmetry (flag-off confirmation gate, then restart only)
 *   - no secret VALUES ever appear in an EnableMcpResult/DisableMcpResult/
 *     McpStatusResult (paths/mechanism/counts only)
 *   - structural: buildMcpOAuthConfigBlock always disables DCR explicitly
 *     and never writes initialAccessToken/allowedRedirectUriHosts
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { tmpdir, hostname as osHostname } from "node:os";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import yaml from "js-yaml";
import { resolveHome, withHome } from "../../src/lib/home.ts";
import { agentInsertSchemaError } from "../helpers/agent-insert-schema.ts";
import { importEd25519Key } from "../../resources/ed25519-auth.ts";

import {
  isLocalOrigin,
  checkLocalOriginRefusal,
  isFabricOrigin,
  selectSecretsMechanism,
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
  HOSTED_OPS_PORT,
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

  test("checkLocalOriginRefusal names a local hostname", () => {
    const result = checkLocalOriginRefusal("http://localhost:9926");
    expect(result).toEqual({
      refused: true,
      reason: "local",
      message: "Issuer refused: local hostname or loopback, unspecified, reserved 0.0.0.0/8, private or link-local IP literal.",
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

// ─── config block (Sherlock: accessTokenTtl must be explicit 900; flair#756:
// DCR must be explicitly disabled, CIMD allowedHosts must be set) ───────────

describe("buildMcpOAuthConfigBlock", () => {
  test("matches the installed @harperfast/oauth 2.2.0 field names, CIMD-only shape", () => {
    const block = buildMcpOAuthConfigBlock({ idpProvider: "github" });
    const oauth = block["@harperfast/oauth"] as any;
    expect(oauth.package).toBe("@harperfast/oauth");
    expect(oauth.providers.github.clientId).toBe("${OAUTH_GITHUB_CLIENT_ID}");
    expect(oauth.providers.github.clientSecret).toBe("${OAUTH_GITHUB_CLIENT_SECRET}");
    // Since @harperfast/oauth 2.7.0 a configured provider needs a redirectUri
    // (2.8.1 skips an unconfigured one before that check) — the shipped block
    // carries the same whole-token reference shape.
    expect(oauth.providers.github.redirectUri).toBe("${OAUTH_GITHUB_REDIRECT_URI}");
    // flair#1152: mcp.enabled is the WHOLE-TOKEN env reference — never a
    // literal boolean. The on/off choice lives in the environment, so a
    // re-packed deploy cannot revert it.
    expect(oauth.mcp.enabled).toBe("${FLAIR_MCP_OAUTH}");
    expect(oauth.mcp.accessTokenTtl).toBe(REQUIRED_ACCESS_TOKEN_TTL);
    expect(oauth.mcp.accessTokenTtl).toBe(900);
    expect(oauth.mcp.clientIdMetadataDocuments.allowedHosts).toEqual(DEFAULT_CIMD_ALLOWED_HOSTS);
    expect("signingKeyPem" in oauth.mcp).toBe(false);
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
    // No secret material anywhere: the credentials are whole-token references,
    // and the signing key is not emitted at all (flair#2194).
    expect(text).toContain("${OAUTH_GITHUB_CLIENT_SECRET}");
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
  test("bundle includes the flag, issuer, and IdP creds — no signing key, no DCR token field", () => {
    const bundle = buildSecretsBundle({
      issuer: ISSUER,
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
    expect(bundle.FLAIR_MCP_SIGNING_KEY_PEM).toBeUndefined();
    expect(bundle.OAUTH_GITHUB_CLIENT_ID).toBe("client-id-value");
    expect(bundle.OAUTH_GITHUB_CLIENT_SECRET).toBe("client-secret-value");
    expect(bundle.OAUTH_GITHUB_REDIRECT_URI).toBe("https://flair.example.com/oauth");
    expect(bundle.FLAIR_MCP_DCR_TOKEN).toBeUndefined();
    expect(Object.keys(bundle)).not.toContain("FLAIR_MCP_DCR_TOKEN");
  });

  test.each([
    ["https://flair.example.com/", "https://flair.example.com/oauth"],
    ["https://flair.example.com:8443///", "https://flair.example.com:8443/oauth"],
    ["https://flair.example.com/issuer", "https://flair.example.com/oauth"],
  ])("GitHub credentials include the redirect base for issuer %s", (issuer, redirectUri) => {
    const bundle = buildSecretsBundle({
      issuer,
      idpProvider: "github",
      idpClientId: "client-id-value",
      idpClientSecret: "client-secret-value",
    });
    expect(bundle.OAUTH_GITHUB_CLIENT_ID).toBe("client-id-value");
    expect(bundle.OAUTH_GITHUB_CLIENT_SECRET).toBe("client-secret-value");
    expect(bundle.OAUTH_GITHUB_REDIRECT_URI).toBe(redirectUri);
  });

  test.each(["", "   ", "flair.example.com", "${FLAIR_MCP_ISSUER}", "file:///tmp/flair"])(
    "refuses a GitHub bundle with an unknown HTTP(S) origin: %s",
    (issuer) => {
      let error: unknown;
      try {
        buildSecretsBundle({
          issuer,
          idpProvider: "github",
          idpClientId: "client-id-value",
          idpClientSecret: "client-secret-value",
        });
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({
        name: "IdpRedirectOriginError",
        message: expect.stringContaining("OAUTH_GITHUB_REDIRECT_URI"),
      });
    },
  );

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

/**
 * A minimal in-memory Credential table for the ops-API mocks (flair#1317).
 *
 * `provisionIdpIdentityMapping` now READS BACK its own write to assert the
 * `(kind, idpSubject)` uniqueness invariant, so a mock that answers every
 * `search_by_conditions` with a constant `[]` can no longer express a
 * SUCCESSFUL provision — the read-back would see zero active credentials and
 * the function would (correctly) fail closed. A fixture that cannot express
 * the success path cannot express the defect either, so the mocks get a real
 * (tiny) store rather than a constant.
 *
 * `handle` answers the two Credential ops and returns `null` for anything
 * else, so each caller keeps its own fallthrough.
 */
function credentialTable(seed: Record<string, any>[] = []) {
  const rows = new Map<string, any>(
    seed.map((r) => [String(r.id), { kind: "idp", status: "active", createdAt: "2026-10-02T00:00:00.000Z", ...r }]),
  );
  const handle = (body: any): Response | null => {
    if (body?.operation === "search_by_conditions" && (body.table ?? "Credential") === "Credential") {
      const cond = (name: string) =>
        (body.conditions ?? []).find((c: any) => c.search_attribute === name)?.search_value;
      const kind = cond("kind");
      const subject = cond("idpSubject");
      const provider = cond("idpProvider");
      const hits = [...rows.values()].filter(
        (r) =>
          (kind === undefined || r.kind === kind) &&
          (subject === undefined || r.idpSubject === subject) &&
          (provider === undefined || r.idpProvider === provider),
      );
      return new Response(JSON.stringify(hits), { status: 200 });
    }
    if (body?.operation === "upsert" && body.table === "Credential") {
      // Merge semantics, as the ops API applies: attributes absent from the
      // record (JSON.stringify already dropped the `undefined`s) leave the
      // stored value alone.
      for (const rec of body.records ?? []) {
        const id = String(rec.id);
        rows.set(id, { ...(rows.get(id) ?? {}), ...rec });
      }
      return new Response(JSON.stringify({ message: "upserted" }), { status: 200 });
    }
    return null;
  };
  return { rows, handle, active: () => [...rows.values()].filter((r) => r.status !== "revoked") };
}

function mockOpsFetch(opts: {
  existingPrincipal?: boolean;
  existingCredential?: Record<string, any> | null;
  /** flair#1317 — seed several rows for one subject (the pre-fix duplicate state). */
  existingCredentials?: Record<string, any>[];
  failFind?: boolean;
  failFindStatus?: number;
  failInsert?: boolean;
  failUpsert?: boolean;
  /** flair#2115 — answer the Credential search with a failed response. */
  failCredSearch?: boolean;
  /** flair#2115 — answer the Credential search with 200 and a body that is NOT a list. */
  credSearchNotAList?: boolean;
  /** flair#2115 — answer the Credential search with 200 and this body. */
  credSearchBody?: unknown;
  /** flair#2115 — answer the Agent search with 200 and this body. */
  agentSearchBody?: unknown;
  /** flair#1317 — make the post-write invariant read-back lie (see its test). */
  poisonReadBack?: (rows: Map<string, any>) => void;
} = {}): { fetchImpl: typeof fetch; calls: any[]; creds: ReturnType<typeof credentialTable> } {
  const calls: any[] = [];
  const seed = opts.existingCredentials ?? (opts.existingCredential ? [opts.existingCredential] : []);
  const creds = credentialTable(
    seed.map((c) => ({ idpProvider: "github", idpSubject: "octocat", principalId: "self", ...c })),
  );
  let principalPresent = opts.existingPrincipal ?? false;
  const fetchImpl = (async (url: any, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ url: String(url), body });
    if (body.operation === "search_by_value" && body.table === "Agent") {
      if (opts.failFind) return new Response("boom", { status: opts.failFindStatus ?? 500 });
      if ("agentSearchBody" in opts) return new Response(JSON.stringify(opts.agentSearchBody), { status: 200 });
      return new Response(JSON.stringify(principalPresent ? [{ id: body.search_value }] : []), { status: 200 });
    }
    if (body.operation === "insert" && body.table === "Agent") {
      const error = agentInsertSchemaError(body.records ?? []);
      if (error) return error;
      if (opts.failInsert) return new Response("insert failed", { status: 500 });
      principalPresent = true;
      return new Response(JSON.stringify({ message: "inserted" }), { status: 200 });
    }
    if (body.operation === "upsert" && body.table === "Credential" && opts.failUpsert) {
      return new Response("upsert failed", { status: 500 });
    }
    if (body.operation === "search_by_conditions" && body.table === "Credential") {
      if (opts.failCredSearch) return new Response("boom", { status: 500 });
      if (opts.credSearchNotAList) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if ("credSearchBody" in opts) return new Response(JSON.stringify(opts.credSearchBody), { status: 200 });
    }
    const credRes = creds.handle(body);
    if (credRes) {
      // The write has landed; let a test corrupt the store before the
      // invariant read-back sees it.
      if (body.operation === "upsert") opts.poisonReadBack?.(creds.rows);
      return credRes;
    }
    if (body.operation === "set_configuration") {
      return new Response(JSON.stringify({ message: "Configuration successfully set." }), { status: 200 });
    }
    if (body.operation === "restart") {
      return new Response(JSON.stringify({ message: "restarting" }), { status: 200 });
    }
    if (body.operation === "sql") {
      // flair#2433 — the create path resolves the instance's own id from the
      // Instance table before it inserts the Agent row.
      return new Response(JSON.stringify([{ id: "inst-local-2433" }]), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls, creds };
}

describe("provisionIdpIdentityMapping", () => {
  for (const field of ["name", "publicKey", "createdAt"]) {
    test(`ops fake rejects an Agent insert missing ${field}`, async () => {
      const { fetchImpl } = mockOpsFetch();
      const record: Record<string, unknown> = {
        id: "self", name: "self", publicKey: "idp:github:octocat", createdAt: "2026-10-02T00:00:00.000Z",
      };
      delete record[field];
      const response = await fetchImpl(ISSUER, {
        method: "POST",
        body: JSON.stringify({ operation: "insert", database: "flair", table: "Agent", records: [record] }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: `Property ${field} is required` });
      const found = await fetchImpl(ISSUER, {
        method: "POST",
        body: JSON.stringify({ operation: "search_by_value", table: "Agent", search_value: "self" }),
      });
      expect(await found.json()).toEqual([]);
    });
  }

  test("creates the principal when missing and a fresh credential", async () => {
    const { fetchImpl, calls } = mockOpsFetch({ existingPrincipal: false, existingCredential: null });
    const result = await provisionIdpIdentityMapping(
      { opsPortOrUrl: ISSUER, adminUser: "admin", adminPass: "pw", principal: "self", principalKind: "human", idpProvider: "github", idpSubject: "octocat" },
      { fetchImpl, now: () => "2026-07-19T00:00:00.000Z" },
    );
    expect(result.principalCreated).toBe(true);
    expect(result.credentialReused).toBe(false);
    expect(result.credentialSuperseded).toBe(false);
    expect(result.supersededCredentialIds).toEqual([]);
    const ops = calls.map((c) => c.body.operation);
    expect(ops).toEqual(["search_by_value", "search_by_conditions", "search_by_value", "search_by_conditions", "sql", "insert", "search_by_value", "search_by_conditions", "upsert", "search_by_conditions"]);
    const agentRecord = calls.find((c) => c.body.operation === "insert")!.body.records[0];
    expect(agentRecord.publicKey).toBe("idp:github:octocat");
    await expect(importEd25519Key(agentRecord.publicKey)).rejects.toThrow();
    const credRecord = calls.find((c) => c.body.operation === "upsert")!.body.records[0];
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
    expect(result.credentialSuperseded).toBe(false);
    expect(result.credentialId).toBe("cred_existing");
    const ops = calls.map((c) => c.body.operation);
    expect(ops).toEqual(["search_by_value", "search_by_conditions", "search_by_value", "search_by_conditions", "upsert", "search_by_conditions"]);
  });

  // ─── flair#2115 — the pre-write read (the step `flair principal link` reuses) ──

  test("flair#2115: the pre-write Credential read refuses a FAILED response, writing nothing", async () => {
    // This read decides which rows the batch revokes. Answered with [] on
    // failure, it said "no rows for this subject" — and the write that followed
    // re-pointed a mapping it could not see. It refuses instead.
    const { fetchImpl, calls } = mockOpsFetch({ existingPrincipal: true, failCredSearch: true });
    await expect(
      provisionIdpIdentityMapping(
        { opsPortOrUrl: ISSUER, adminUser: "admin", adminPass: "pw", principal: "self", principalKind: "human", idpProvider: "github", idpSubject: "octocat" },
        { fetchImpl },
      ),
    ).rejects.toThrow(/ops API read at .* failed \(HTTP 500\)/);
    // The call log itself: no upsert, no revocation, after the failed read.
    expect(calls.map((c) => c.body.operation)).toEqual(["search_by_value", "search_by_conditions"]);
  });

  test("flair#2115: the pre-write Credential read refuses a body that is NOT a record list", async () => {
    const { fetchImpl, calls } = mockOpsFetch({ existingPrincipal: true, credSearchNotAList: true });
    await expect(
      provisionIdpIdentityMapping(
        { opsPortOrUrl: ISSUER, adminUser: "admin", adminPass: "pw", principal: "self", principalKind: "human", idpProvider: "github", idpSubject: "octocat" },
        { fetchImpl },
      ),
    ).rejects.toThrow(/did not answer with a record list/);
    expect(calls.map((c) => c.body.operation)).toEqual(["search_by_value", "search_by_conditions"]);
  });

  test("flair#2115: the pre-write Credential read refuses [null] rows, writing nothing", async () => {
    const { fetchImpl, calls } = mockOpsFetch({ existingPrincipal: true, credSearchBody: [null] });
    await expect(
      provisionIdpIdentityMapping(
        { opsPortOrUrl: ISSUER, adminUser: "admin", adminPass: "pw", principal: "self", principalKind: "human", idpProvider: "github", idpSubject: "octocat" },
        { fetchImpl },
      ),
    ).rejects.toThrow(/answered with a malformed Credential record \(entry 0\)/);
    expect(calls.map((c) => c.body.operation)).toEqual(["search_by_value", "search_by_conditions"]);
  });

  const MALFORMED_AGENT_ANSWERS: Array<[unknown, RegExp]> = [
    [{ ok: true }, /did not answer with a record list/],
    ["not json rows", /did not answer with a record list/],
    [[null], /answered with a malformed Agent record \(entry 0\)/],
    [[{ name: "self" }], /answered with a malformed Agent record \(entry 0\)/],
    [[{ id: "someone-else" }], /query-mismatch:id/],
  ];

  for (const [agentSearchBody, reason] of MALFORMED_AGENT_ANSWERS) {
    test(`flair#2115: the Agent read refuses ${JSON.stringify(agentSearchBody)} — no principal created, nothing written`, async () => {
      const { fetchImpl, calls } = mockOpsFetch({ agentSearchBody });
      await expect(
        provisionIdpIdentityMapping(
          { opsPortOrUrl: ISSUER, adminUser: "admin", adminPass: "pw", principal: "self", principalKind: "human", idpProvider: "github", idpSubject: "octocat" },
          { fetchImpl },
        ),
      ).rejects.toThrow(reason);
      expect(calls.map((c) => c.body.operation)).toEqual(["search_by_value"]);
    });
  }

  // ─── flair#1317 — the (kind, idpSubject) uniqueness constraint ─────────────

  test("flair#1317: the dedup lookup keys on (kind, idpSubject) ONLY — provider must not narrow it", async () => {
    // The defect in one assertion. The old lookup added an idpProvider
    // condition, so a credential written under another provider name was
    // invisible to dedup while remaining visible to the resolver, whose key is
    // (kind, idpSubject).
    const { fetchImpl, calls } = mockOpsFetch({ existingPrincipal: true });
    await provisionIdpIdentityMapping(
      { opsPortOrUrl: ISSUER, adminUser: "admin", adminPass: "pw", principal: "self", principalKind: "human", idpProvider: "github", idpSubject: "octocat" },
      { fetchImpl },
    );
    const searches = calls.filter((c) => c.body.operation === "search_by_conditions");
    expect(searches.length).toBe(3); // the dedup lookup, the pre-write guard, the invariant read-back
    for (const s of searches) {
      const attrs = s.body.conditions.map((c: any) => c.search_attribute).sort();
      expect(attrs).toEqual(["idpSubject", "kind"]);
    }
  });

  test("flair#1317: a re-link under a DIFFERENT provider supersedes — new credential active, prior REVOKED, reported by id", async () => {
    const { fetchImpl, creds } = mockOpsFetch({
      existingPrincipal: true,
      existingCredential: { id: "cred_jit", idpProvider: "mcp-oauth", principalId: "agt_jit" },
    });
    const result = await provisionIdpIdentityMapping(
      { opsPortOrUrl: ISSUER, adminUser: "admin", adminPass: "pw", principal: "self", principalKind: "human", idpProvider: "github", idpSubject: "octocat" },
      { fetchImpl, now: () => "2026-08-24T00:00:00.000Z" },
    );
    expect(result.credentialReused, "a cross-provider re-link is not a reuse").toBe(false);
    expect(result.credentialSuperseded).toBe(true);
    expect(result.supersededCredentialIds).toEqual(["cred_jit"]);
    expect(result.credentialId).not.toBe("cred_jit");

    // The store, not the return value: exactly one resolvable row, and the
    // prior one is RETAINED with the terminal state (not deleted, not soft).
    expect(creds.active().map((r) => r.id)).toEqual([result.credentialId]);
    expect(creds.rows.get("cred_jit")?.status).toBe("revoked");
    expect(creds.rows.get("cred_jit")?.principalId, "the revoked row keeps its prior principal for audit").toBe("agt_jit");
  });

  test("flair#1317: supersede is ONE batched write — no observable two-active or zero-active window", async () => {
    // Sherlock's atomicity requirement, at the granularity this surface can be
    // observed: the re-point/insert and every revocation leave in a SINGLE
    // ops-API operation, and the new credential is first in the batch so even a
    // partially-applied batch can never strand the subject with zero.
    const { fetchImpl, calls } = mockOpsFetch({
      existingPrincipal: true,
      existingCredentials: [
        { id: "cred_a", idpProvider: "mcp-oauth", principalId: "agt_a" },
        { id: "cred_b", idpProvider: "okta", principalId: "agt_b" },
      ],
    });
    const result = await provisionIdpIdentityMapping(
      { opsPortOrUrl: ISSUER, adminUser: "admin", adminPass: "pw", principal: "self", principalKind: "human", idpProvider: "github", idpSubject: "octocat" },
      { fetchImpl },
    );
    const upserts = calls.filter((c) => c.body.operation === "upsert" && c.body.table === "Credential");
    expect(upserts.length, "one write, not a deactivate-then-create sequence").toBe(1);
    const records = upserts[0].body.records;
    expect(records[0].id, "the surviving credential is written FIRST").toBe(result.credentialId);
    expect(records[0].status).toBe("active");
    expect(records.slice(1).map((r: any) => [r.id, r.status])).toEqual([
      ["cred_a", "revoked"],
      ["cred_b", "revoked"],
    ]);
    // …and the pre-existing duplicate state is HEALED, not preserved.
    expect(result.supersededCredentialIds).toEqual(["cred_a", "cred_b"]);
  });

  test("flair#1317: a REVOKED credential is never resurrected — same provider, same subject mints a fresh one", async () => {
    // Sherlock addition 2: "revoked" is terminal. Reusing a revoked row would
    // make the supersede a soft flag with a re-activation path back.
    const { fetchImpl, creds } = mockOpsFetch({
      existingPrincipal: true,
      existingCredential: { id: "cred_dead", idpProvider: "github", status: "revoked" },
    });
    const result = await provisionIdpIdentityMapping(
      { opsPortOrUrl: ISSUER, adminUser: "admin", adminPass: "pw", principal: "self", principalKind: "human", idpProvider: "github", idpSubject: "octocat" },
      { fetchImpl },
    );
    expect(result.credentialId).not.toBe("cred_dead");
    expect(result.credentialReused).toBe(false);
    expect(creds.rows.get("cred_dead")?.status, "the revoked row stays revoked").toBe("revoked");
    // It was already dead, so nothing was superseded by this call.
    expect(result.credentialSuperseded).toBe(false);
  });

  test("flair#1317: the post-write invariant read-back can FAIL — a store left with two active rows throws, never returns a mapping", async () => {
    // The check must be able to fire. Poison the store right after the write so
    // the read-back sees the very state the fix exists to prevent; if this
    // still returned a mapping, the invariant assertion would be decorative.
    const { fetchImpl } = mockOpsFetch({
      existingPrincipal: true,
      poisonReadBack: (rows) => {
        rows.set("cred_smuggled", {
          id: "cred_smuggled", kind: "idp", status: "active",
          idpProvider: "smuggled", idpSubject: "octocat", principalId: "agt_other", createdAt: "2026-10-02T00:00:00.000Z",
        });
      },
    });
    await expect(
      provisionIdpIdentityMapping(
        { opsPortOrUrl: ISSUER, adminUser: "admin", adminPass: "pw", principal: "self", principalKind: "human", idpProvider: "github", idpSubject: "octocat" },
        { fetchImpl },
      ),
    ).rejects.toThrow(/post-write-mismatch/);
  });

  test("flair#1317: the invariant error names the actor, the state and the remedy", async () => {
    const { fetchImpl } = mockOpsFetch({
      existingPrincipal: true,
      poisonReadBack: (rows) => rows.clear(), // write vanished → zero active
    });
    const err = await provisionIdpIdentityMapping(
      { opsPortOrUrl: ISSUER, adminUser: "admin", adminPass: "pw", principal: "self", principalKind: "human", idpProvider: "github", idpSubject: "octocat" },
      { fetchImpl },
    ).catch((e) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("octocat");           // which subject
    expect(err.message).toContain("0 resolvable (principal-bearing) active");           // what state
    expect(err.message).toContain("flair#1317");         // why it matters
    expect(err.message).toMatch(/revoke the rows/);      // what to do
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

    test("a 404 names the served-origin cause and the address the command derived", async () => {
      // The failure an operator actually hit: ops calls sent to the served
      // origin, where the flair REST component owns "/" and answers 404. The old
      // message pointed at principals; this one has to point at the port.
      const { fetchImpl } = mockOpsFetch({ failFind: true, failFindStatus: 404 });
      const err: Error = await provisionIdpIdentityMapping(
        { hostedOrigin: ISSUER, adminUser: "admin", adminPass: "pw", principal: "self", principalKind: "human", idpProvider: "github", idpSubject: "octocat" },
        { fetchImpl },
      ).then(() => { throw new Error("expected a throw"); }, (e: Error) => e);
      expect(err.message).toMatch(/served origin rather than the ops API/);
      // flair#2116: the remedy used to be "Pass --ops-url <url>", a flag
      // `flair mcp enable` does not have. It now names where the address came
      // from and the address itself.
      expect(err.message).not.toContain("--ops-url");
      expect(err.message).toContain("has no option to override it");
      expect(err.message).toContain("answer at https://flair.example.com:9925/");
    });
});

// ─── flair#2102 — the ops target is the one the caller names ─────────────────

describe("provisionIdpIdentityMapping — ops target (flair#2102)", () => {
  const MAPPING = {
    adminUser: "admin", adminPass: "pw", principal: "self", principalKind: "human" as const,
    idpProvider: "github", idpSubject: "octocat",
  };

  test("a local URL string with a non-default port: every request goes to exactly that port, and nothing else is contacted", async () => {
    const creds = credentialTable();
    const received: { host: string; operation: string }[] = [];
    let principalPresent = false;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const body: any = await req.json().catch(() => ({}));
        received.push({ host: req.headers.get("host") ?? "", operation: body.operation });
        if (body.operation === "search_by_value") return Response.json(principalPresent ? [{ id: body.search_value }] : []);
        if (body.operation === "sql") return Response.json([{ id: "inst-local-2433" }]);
        if (body.operation === "insert") {
          const error = agentInsertSchemaError(body.records ?? []);
          if (error) return error;
          principalPresent = true;
          return Response.json({ message: "inserted" });
        }
        return creds.handle(body) ?? new Response("unexpected operation", { status: 400 });
      },
    });
    try {
      expect(server.port).not.toBe(HOSTED_OPS_PORT);
      const origin = `http://127.0.0.1:${server.port}`;
      // Every destination the helper asks for is recorded, and only the stub's
      // is forwarded: a wrong port fails here and never reaches the network.
      const attempted: string[] = [];
      const fetchImpl = (async (url: any, init?: RequestInit) => {
        attempted.push(String(url));
        if (String(url) !== `${origin}/`) throw new Error(`unexpected destination ${String(url)}`);
        return fetch(url, { ...init, signal: AbortSignal.timeout(5_000) });
      }) as typeof fetch;

      const result = await provisionIdpIdentityMapping({ opsPortOrUrl: origin, ...MAPPING }, { fetchImpl });

      expect(attempted).toEqual(Array(10).fill(`${origin}/`));
      expect(received.map((r) => r.operation)).toEqual([
        "search_by_value", "search_by_conditions", "search_by_value", "search_by_conditions", "sql", "insert", "search_by_value", "search_by_conditions", "upsert", "search_by_conditions",
      ]);
      expect(received.every((r) => r.host === `127.0.0.1:${server.port}`)).toBe(true);
      expect(creds.active().map((r) => r.id)).toEqual([result.credentialId]);
    } finally {
      server.stop(true);
    }
  }, 15_000);

  test.each([
    [19925, "http://127.0.0.1:19925/"],
    ["http://127.0.0.1:19925", "http://127.0.0.1:19925/"],
    ["https://ops.example.com:8443/", "https://ops.example.com:8443/"],
    ["https://flair.example.com", "https://flair.example.com/"],
  ] as const)("opsPortOrUrl %p is used as given: %s", async (opsPortOrUrl, expected) => {
    const { fetchImpl, calls } = mockOpsFetch({ existingPrincipal: true });
    await provisionIdpIdentityMapping({ opsPortOrUrl, ...MAPPING }, { fetchImpl });
    expect(calls.length).toBe(6);
    expect(calls.every((c) => c.url === expected)).toBe(true);
  });

  test.each([
    ["https://flair.example.com", `https://flair.example.com:${HOSTED_OPS_PORT}/`],
    ["https://flair.example.com/", `https://flair.example.com:${HOSTED_OPS_PORT}/`],
    ["http://10.0.0.5:8443", `http://10.0.0.5:${HOSTED_OPS_PORT}/`],
  ])("hostedOrigin %p resolves to its host at the hosted ops port", async (hostedOrigin, expected) => {
    const { fetchImpl, calls } = mockOpsFetch({ existingPrincipal: true });
    await provisionIdpIdentityMapping({ hostedOrigin, ...MAPPING }, { fetchImpl });
    expect(calls.length).toBe(6);
    expect(calls.every((c) => c.url === expected)).toBe(true);
  });

  test.each([
    ["a bare host name", { opsPortOrUrl: "flair.example.com" }, "opsPortOrUrl <unparseable value> names"],
    ["host:port with no scheme", { opsPortOrUrl: "127.0.0.1:19925" }, "opsPortOrUrl <unparseable value> names"],
    ["a non-http scheme", { opsPortOrUrl: "ftp://ops.example.com:21" }, "opsPortOrUrl ftp://ops.example.com names"],
    ["a parsed ops URL without a hostname", { opsPortOrUrl: "file:///tmp" }, "opsPortOrUrl <unparseable value> names"],
    ["a URL with a path", { opsPortOrUrl: "http://127.0.0.1:19925/ops" }, "opsPortOrUrl http://127.0.0.1:19925 names"],
    ["a URL with a query", { opsPortOrUrl: "http://127.0.0.1:19925/?a=1" }, "opsPortOrUrl http://127.0.0.1:19925 names"],
    ["port 0", { opsPortOrUrl: 0 }, "opsPortOrUrl <unparseable value> names"],
    ["port 65536", { opsPortOrUrl: 65536 }, "opsPortOrUrl <unparseable value> names"],
    ["a fractional port", { opsPortOrUrl: 19925.5 }, "opsPortOrUrl <unparseable value> names"],
    ["a non-string, non-number", { opsPortOrUrl: null }, "opsPortOrUrl <unparseable value> names"],
    ["both forms", { opsPortOrUrl: 19925, hostedOrigin: "https://flair.example.com" }, "got both opsPortOrUrl <unparseable value> and hostedOrigin https://flair.example.com"],
    ["neither form", {}, "got neither opsPortOrUrl nor hostedOrigin"],
    ["an unparseable hostedOrigin", { hostedOrigin: "::::not a url::::" }, "hostedOrigin <unparseable value> as a served origin"],
    ["a non-http hostedOrigin", { hostedOrigin: "ftp://flair.example.com" }, "hostedOrigin ftp://flair.example.com as a served origin"],
    ["a parsed hostedOrigin without a hostname", { hostedOrigin: "file:///tmp" }, "hostedOrigin <unparseable value> as a served origin"],
    ["a bare hostedOrigin", { hostedOrigin: "flair.example.com" }, "hostedOrigin <unparseable value> as a served origin"],
    ["a hostedOrigin with a path", { hostedOrigin: "https://flair.example.com/path" }, "hostedOrigin https://flair.example.com as a served origin"],
    ["a hostedOrigin with a query", { hostedOrigin: "https://flair.example.com/?x=1" }, "hostedOrigin https://flair.example.com as a served origin"],
  ])("refuses %s before any request, showing only parsed URL components and the accepted forms", async (_label, target, named) => {
    const attempted: string[] = [];
    const fetchImpl = (async (url: any) => {
      attempted.push(String(url));
      throw new Error("no request expected");
    }) as typeof fetch;
    const err = await provisionIdpIdentityMapping({ ...MAPPING, ...target } as any, { fetchImpl }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain(named);
    expect(err!.message).toContain("Accepted, exactly one of: opsPortOrUrl as a port number (1-65535) on 127.0.0.1");
    expect(err!.message).toContain(`hostedOrigin as the same canonical http:// or https:// origin form`);
    expect(err!.message).toContain("exactly equal its parsed URL origin or that origin followed by /");
    expect(err!.message).toContain("No request was sent.");
    expect(attempted).toEqual([]);
  });

  test.each([
    [{ opsPortOrUrl: "http://user:s3cret@127.0.0.1:19925" }, "http://127.0.0.1:19925", ["user", "s3cret"]],
    [{ hostedOrigin: "user:s3cret@flair.example.com" }, "<unparseable value>", ["user", "s3cret"]],
    [{ opsPortOrUrl: "https://alice@private.invalid:pw123@ops.example.com" }, "https://ops.example.com", ["alice", "private.invalid", "pw123"]],
    [{ hostedOrigin: "https://alice@private.invalid:pw123@flair.example.com" }, "https://flair.example.com", ["alice", "private.invalid", "pw123"]],
  ])("refuses a target carrying credentials, and the message does not repeat them: %p", async (target, shown, hidden) => {
    const attempted: string[] = [];
    const fetchImpl = (async (url: any) => {
      attempted.push(String(url));
      throw new Error("no request expected");
    }) as typeof fetch;
    const err = await provisionIdpIdentityMapping({ ...MAPPING, ...target } as any, { fetchImpl }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    for (const part of hidden) expect(err!.message).not.toContain(part);
    expect(err!.message).toContain(shown);
    expect(attempted).toEqual([]);
  });

  test.each(([
    "https:/flair.example.com",
    "https:\n//alice:pw123@ops.example.com",
    "https://ops.example.com/?",
    "https://ops.example.com/#",
  ] as const).flatMap((value) => (["opsPortOrUrl", "hostedOrigin"] as const).map((field) => [value, field] as const)))(
    "rejects noncanonical URL %p as %s without including its raw value or credentials",
    async (value, field) => {
      const attempted: string[] = [];
      const fetchImpl = (async (url: any) => {
        attempted.push(String(url));
        throw new Error("no request expected");
      }) as typeof fetch;
      const err = await provisionIdpIdentityMapping({ ...MAPPING, [field]: value } as any, { fetchImpl }).then(
        () => null,
        (e: Error) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toContain("Accepted, exactly one of:");
      expect(err!.message).not.toContain(value);
      expect(err!.message).not.toContain("alice");
      expect(err!.message).not.toContain("pw123");
      expect(attempted).toEqual([]);
    },
  );

  test("a 404 from a caller-named ops URL gives a neutral hint, not a served-origin diagnosis", async () => {
    const { fetchImpl } = mockOpsFetch({ failFind: true, failFindStatus: 404 });
    const err = await provisionIdpIdentityMapping(
      { opsPortOrUrl: "https://ops.example.com:8443", ...MAPPING },
      { fetchImpl },
    ).then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("failed (HTTP 404)");
    expect(err!.message).toContain("opsPortOrUrl names this address; verify that the ops API answers requests at https://ops.example.com:8443/");
    expect(err!.message).not.toContain("served origin rather than the ops API");
    expect(err!.message).not.toContain('REST component owns "/"');
    expect(err!.message).not.toContain("DIFFERENT port");
    expect(err!.message).not.toContain("flair mcp enable");
  });

  test("`flair mcp enable` asks for the hosted form: its identity-mapping requests go to the instance host at the hosted ops port", async () => {
    const { fetchImpl: inner } = fullMockFetch();
    const mappingUrls: string[] = [];
    const fetchImpl = (async (url: any, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.table === "Agent" || body.table === "Credential") mappingUrls.push(String(url));
      return inner(url, init);
    }) as typeof fetch;
    const result = await enableMcp({ ...BASE_PARAMS, ...tempPaths(), confirmSecretsApplied: true }, { fetchImpl });
    expect(result.ok).toBe(true);
    expect(mappingUrls.length).toBe(6);
    expect(mappingUrls.every((u) => u === `http://127.0.0.1:${HOSTED_OPS_PORT}/`)).toBe(true);
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
    // A response was read, so this is not the unreachable case.
    expect(result.unreachable).toBeUndefined();
  });

  test("ok:false when the endpoint is unreachable", async () => {
    const fetchImpl = (async () => { throw new TypeError("fetch failed: connection refused"); }) as typeof fetch;
    const result = await selfVerifyMcpMetadata(ISSUER, { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("could not reach");
    // flair#2116: marked, so a caller can tell "nothing was read" from "read and not active".
    expect(result.unreachable).toBe(true);
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

  test("flair#2190: a valid issuer + CIMD with a DIFFERENT token endpoint is refused, naming expected vs found", async () => {
    const wrong = "https://tokens.elsewhere.example/mcp/token";
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ...CIMD_METADATA, token_endpoint: wrong }), { status: 200 })) as typeof fetch;
    const result = await selfVerifyMcpMetadata(ISSUER, { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain(`token_endpoint=${JSON.stringify(wrong)}`);
    expect(result.detail).toContain(`${ISSUER}/oauth/mcp/token`);
  });

  test("flair#2190: the exact MCP token endpoint passes", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify(CIMD_METADATA), { status: 200 })) as typeof fetch;
    const result = await selfVerifyMcpMetadata(ISSUER, { fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.tokenEndpoint).toBe(`${ISSUER}/oauth/mcp/token`);
  });

  test("flair#2190: a trailing slash on the issuer is normalized, so the exact endpoint still matches", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify(CIMD_METADATA), { status: 200 })) as typeof fetch;
    const result = await selfVerifyMcpMetadata(`${ISSUER}/`, { fetchImpl });
    expect(result.ok).toBe(true);
  });

  test("flair#2190: the endpoint comparison is exact, like the rest of the code — trailing slash, case and default-port variants on token_endpoint are refused", async () => {
    for (const token_endpoint of [
      `${ISSUER}/oauth/mcp/token/`,
      `${ISSUER}/oauth/MCP/token`,
      "https://flair.example.com:443/oauth/mcp/token",
    ]) {
      const fetchImpl = (async () =>
        new Response(JSON.stringify({ ...CIMD_METADATA, token_endpoint }), { status: 200 })) as typeof fetch;
      const result = await selfVerifyMcpMetadata(ISSUER, { fetchImpl });
      expect(result.ok).toBe(false);
      expect(result.detail).toContain("not the MCP authorization server's");
    }
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

function fullMockFetch(overrides: { verifyStatus?: number; verifyBody?: any; sysInfoPidProvider?: () => number; existingCredentials?: Record<string, any>[] } = {}): { fetchImpl: typeof fetch; calls: string[]; creds: ReturnType<typeof credentialTable> } {
  const calls: string[] = [];
  const creds = credentialTable(overrides.existingCredentials);
  let _sysInfoCallCount = 0;
  const fetchImpl = (async (url: any, init?: RequestInit) => {
    const urlStr = String(url);
    if (new URL(urlStr).pathname === "/.well-known/oauth-authorization-server") {
      calls.push("self-verify");
      const status = overrides.verifyStatus ?? 200;
      const body = overrides.verifyBody ?? CIMD_METADATA;
      return new Response(JSON.stringify(body), { status });
     }
     // Ops API (identity mapping + set_configuration + restart + system_information)
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push(`ops:${body.operation}`);
    if (body.operation === "search_by_value") return new Response(JSON.stringify([{ id: "self" }]), { status: 200 }); // principal exists
    const credRes = creds.handle(body); // Credential search/upsert against a real (tiny) store
    if (credRes) return credRes;
    if (body.operation === "system_information") {
       _sysInfoCallCount++;
       const pid = overrides.sysInfoPidProvider
            ? overrides.sysInfoPidProvider()
            : (_sysInfoCallCount === 1 ? 12345 : 67890);    // happy path: PID changes (real restart)
      return new Response(JSON.stringify({ harperdb_processes: { core: [{ pid }] } }), { status: 200 });
      }
    return new Response(JSON.stringify({ message: "ok" }), { status: 200 });
   }) as typeof fetch;
  return { fetchImpl, calls, creds };
}

const TARGET = "http://127.0.0.1:9926";

const BASE_PARAMS = {
  instance: TARGET,
  issuer: ISSUER,
  idpClientId: "client-id",
  idpClientSecret: "client-secret",
  idpSubject: "octocat",
  adminUser: "admin",
  adminPass: "pw",
};

function tempPaths() {
  return {
    secretsStagingPath: join(dir, "secrets.env"),
    localConfigPath: join(dir, "config.yaml"),
  };
}

describe("enableMcp — local-origin refusal", () => {
  test("refuses immediately with zero fetch calls", async () => {
    const { fetchImpl, calls } = fullMockFetch();
    const result = await enableMcp(
      { ...BASE_PARAMS, ...tempPaths(), instance: "http://localhost:9926", issuer: undefined },
      { fetchImpl },
    );
    expect(result.ok).toBe(false);
    expect(result.refused?.message).toContain("Issuer refused: local hostname");
    expect(result.failedStep).toBe("local-origin-check");
    expect(calls).toHaveLength(0);
  });
});

describe("enableMcp — dry-run", () => {
  test("writes no file, generates no signing key, and stops before any remote call", async () => {
    const { fetchImpl, calls } = fullMockFetch();
    const paths = tempPaths();
    const listingBefore = readdirSync(dir).sort();
    const configBefore = readFileSync(paths.localConfigPath, "utf-8");
    const result = await enableMcp({ ...BASE_PARAMS, ...paths, dryRun: true }, { fetchImpl });

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(calls).toHaveLength(0);
    expect(readdirSync(dir).sort()).toEqual(listingBefore);
    expect(readFileSync(paths.localConfigPath, "utf-8")).toBe(configBefore);
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

describe("enableMcp — the issuer must be an http(s) origin", () => {
  test.each([ISSUER, `${ISSUER}/`, `${ISSUER}:8443`, "http://flair.example.com", "https://[2001:db8::1]:8443/"])(
    "accepts canonical --issuer %s under --dry-run",
    async (issuer) => {
      const { fetchImpl, calls } = fullMockFetch();
      const result = await enableMcp({ ...BASE_PARAMS, ...tempPaths(), issuer, dryRun: true }, { fetchImpl });
      expect(result.ok).toBe(true);
      expect(calls).toHaveLength(0);
    },
  );
  test.each([
    "https://flair.example.com/issuer", "https://flair.example.com/oauth", "",
    "https://flair.example.com/?", "https://flair.example.com/#",
    "https://flair.example.com?", "https://flair.example.com#",
    "https://flair.example.com/?x=1", "https://flair.example.com/#fragment",
    "https://flair.example.com/a/..", "https://flair.example.com/.",
    "https://flair.example.com/..", "https://flair.example.com/%2e",
    "https://flair.example.com/a/%2e%2e", "https://flair.example.com//",
    "https://flair.example.com/issuer/", "https://user:pass@flair.example.com",
    "https:\\flair.example.com", " https://flair.example.com", "https://flair.example.com\n",
    "ftp://flair.example.com", "flair.example.com", "https:///flair.example.com",
    "https://FLAIR.example.com", "https://flair.example.com:443",
  ])(
    "refuses --issuer %s before any write, with and without --dry-run",
    async (badIssuer) => {
      for (const dryRun of [true, false]) {
        const { fetchImpl, calls } = fullMockFetch();
        const paths = tempPaths();
        const listingBefore = readdirSync(dir).sort();
        const configBefore = readFileSync(paths.localConfigPath, "utf-8");
        const result = await enableMcp(
          { ...BASE_PARAMS, ...paths, issuer: badIssuer, confirmSecretsApplied: true, dryRun },
          { fetchImpl },
        );
        expect(result.ok).toBe(false);
        expect(result.failedStep).toBe(["", "flair.example.com"].includes(badIssuer) ? "local-origin-check" : "issuer-origin-check");
        expect(result.refused?.message).toContain(["", "flair.example.com"].includes(badIssuer) ? "Issuer refused: invalid URL." : "must be an absolute http(s) origin");
        expect(calls).toHaveLength(0);
        expect(existsSync(paths.secretsStagingPath)).toBe(false);
        expect(readdirSync(dir).sort()).toEqual(listingBefore);
        expect(readFileSync(paths.localConfigPath, "utf-8")).toBe(configBefore);
      }
    },
  );
});

describe("enableMcp — the confirm-secrets-applied gate", () => {
  function pushedSecretsFetch() {
    const { fetchImpl: baseFetch, calls } = fullMockFetch();
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    const setNames: string[] = [];
    const readBackNames: string[] = [];
    const fetchImpl = (async (url: any, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.operation === "get_secrets_public_key") {
        return new Response(JSON.stringify({ public_key: publicKey }), { status: 200 });
      }
      if (body.operation === "set_secret") {
        setNames.push(body.name);
        return new Response("{}", { status: 200 });
      }
      if (body.operation === "search_by_value" && body.table === "hdb_secret") {
        readBackNames.push(body.search_value);
        return new Response(JSON.stringify([{ name: body.search_value, processEnv: true }]), { status: 200 });
      }
      return baseFetch(url, init);
    }) as typeof fetch;
    return { fetchImpl, calls, setNames, readBackNames };
  }

  test("refuses to restart without confirmation, and never calls restart", async () => {
    const { fetchImpl, calls } = fullMockFetch();
    const result = await enableMcp({ ...BASE_PARAMS, ...tempPaths() }, { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("secrets-provisioning");
    expect(calls.filter((c) => c === "ops:restart")).toHaveLength(0);
    // Identity mapping DOES run before the gate.
    expect(calls).toContain("ops:search_by_value");
    expect(result.steps.at(-1)?.detail).toBe(
      `not applied: pass --confirm-secrets-applied once the staged secrets are live on ${TARGET}, then re-run \`flair mcp enable\` (earlier steps are idempotent and will reuse what's already provisioned).`,
    );
  });

  test("an interactive confirmPrompt returning false also refuses", async () => {
    const { fetchImpl } = fullMockFetch();
    let prompt = "";
    const result = await enableMcp(
      { ...BASE_PARAMS, ...tempPaths() },
      { fetchImpl, confirmPrompt: async (message) => { prompt = message; return false; } },
    );
    expect(result.ok).toBe(false);
    expect(prompt).toBe(`Have you applied the 5 vars staged at ${join(dir, "secrets.env")} to ${TARGET}'s environment?`);
  });

  test("pushed and read-back Fabric secrets, without confirmation: asks for a restart and never calls restart", async () => {
    const { fetchImpl, calls, setNames, readBackNames } = pushedSecretsFetch();
    const instance = "https://my-flair.harperfabric.com";
    const result = await enableMcp({ ...BASE_PARAMS, ...tempPaths(), instance }, { fetchImpl });

    expect(result.failedStep).toBe("secrets-provisioning");
    expect(setNames.length).toBeGreaterThan(0);
    expect(readBackNames).toEqual(setNames);
    expect(result.steps.find((s) => s.step === "secrets-provisioning" && s.ok)?.detail).toContain("pushed to the target");
    const detail = result.steps.at(-1)!.detail;
    expect(detail).toContain(`the secrets were pushed to ${instance} and read back; restart the Fabric instance`);
    expect(detail).toContain("--confirm-secrets-applied");
    expect(detail).not.toContain("staged secrets");
    expect(detail).not.toContain("not applied");
    expect(calls).not.toContain("ops:restart");
  });

  test("pushed and read-back standalone secrets, declined prompt: asks to load them", async () => {
    const { fetchImpl, calls, setNames, readBackNames } = pushedSecretsFetch();
    let prompt = "";
    const result = await enableMcp(
      { ...BASE_PARAMS, ...tempPaths() },
      { fetchImpl, confirmPrompt: async (message) => { prompt = message; return false; } },
    );

    expect(result.failedStep).toBe("secrets-provisioning");
    expect(setNames.length).toBeGreaterThan(0);
    expect(readBackNames).toEqual(setNames);
    expect(prompt).toContain(`secrets were pushed to ${TARGET} and read back`);
    expect(prompt).toContain("loaded them into the instance's process environment");
    expect(prompt).not.toContain("staged");
    const detail = result.steps.at(-1)!.detail;
    expect(detail).toContain(`the secrets were pushed to ${TARGET} and read back; load them into the instance's process environment`);
    expect(detail).not.toContain("staged secrets");
    expect(calls).not.toContain("ops:restart");
  });
});

describe("enableMcp — config-block step (flair#2116)", () => {
  test("reports the shipped block: mcp.enabled env reference (not false), DCR off and the allowed hosts, as in the repo's config.yaml", async () => {
    const { fetchImpl } = fullMockFetch();
    const result = await enableMcp({ ...BASE_PARAMS, ...tempPaths(), dryRun: true }, { fetchImpl });
    const step = result.steps.find((s) => s.step === "config-block");
    expect(step?.ok).toBe(true);
    expect(step!.detail).toContain("this step writes nothing");
    expect(step!.detail).toContain("mcp.enabled=${FLAIR_MCP_OAUTH}");
    expect(step!.detail).not.toContain("mcp.enabled=false");
    // Every field it reports as shipped is the one the shipped component config carries.
    const mcp = shippedMcpBlock();
    expect(step!.detail).toContain(`mcp.enabled=${mcp.enabled}`);
    expect(step!.detail).toContain(`dynamicClientRegistration.enabled=${mcp.dynamicClientRegistration.enabled}`);
    expect(step!.detail).toContain(`clientIdMetadataDocuments.allowedHosts=${JSON.stringify(mcp.clientIdMetadataDocuments.allowedHosts)})`);
    expect(step!.detail).not.toContain("--cimd-allowed-hosts");
  });

  test("labels --cimd-allowed-hosts as requested and points to the cimd-allowed-hosts step above, never as the shipped list (flair#2116)", async () => {
    const { fetchImpl } = fullMockFetch();
    const result = await enableMcp(
      { ...BASE_PARAMS, ...tempPaths(), dryRun: true, cimdAllowedHosts: ["example.com"] },
      { fetchImpl },
    );
    const step = result.steps.find((s) => s.step === "config-block")!;
    const shippedHosts = JSON.stringify(shippedMcpBlock().clientIdMetadataDocuments.allowedHosts);
    expect(step.detail).toContain(`clientIdMetadataDocuments.allowedHosts=${shippedHosts})`);
    expect(step.detail).not.toContain('allowedHosts=["example.com"]');
    expect(step.detail).toContain(
      '--cimd-allowed-hosts ["example.com"] was requested; the cimd-allowed-hosts step above says whether and when this run writes it',
    );
    // "above": the step the pointer names ran, and was reported, before this one.
    const cimdStep = result.steps.findIndex((s) => s.step === "cimd-allowed-hosts");
    expect(cimdStep).toBeGreaterThanOrEqual(0);
    expect(cimdStep).toBeLessThan(result.steps.indexOf(step));
  });
});

/** The `@harperfast/oauth` → `mcp` block of the repo's shipped config.yaml. */
function shippedMcpBlock(): any {
  const doc = yaml.load(readFileSync(join(import.meta.dir, "..", "..", "config.yaml"), "utf8")) as any;
  return doc["@harperfast/oauth"].mcp;
}

describe("enableMcp — full happy path", () => {
  test("enable heals a subject mapped to two principals and prints SUPERSEDED", async () => {
    const { fetchImpl, creds } = fullMockFetch({ existingCredentials: [
      { id: "cred_self", kind: "idp", idpProvider: "github", idpSubject: "octocat", principalId: "self" },
      { id: "cred_stray", kind: "idp", idpProvider: "okta", idpSubject: "octocat", principalId: "agt_b" },
    ] });
    const result = await enableMcp(
      { ...BASE_PARAMS, ...tempPaths(), confirmSecretsApplied: true }, { fetchImpl },
    );
    expect(result.ok).toBe(true);
    expect(creds.active().map(row => [row.id, row.principalId])).toEqual([["cred_self", "self"]]);
    expect(creds.rows.get("cred_stray")?.status).toBe("revoked");
    expect(result.steps.find(step => step.step === "identity-mapping")?.detail).toMatch(/SUPERSEDED:.*cred_stray/);
  });

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
      "issuer-origin-check",
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

    // flair#756: no DCR call anywhere in the flow. Metadata is read from the
    // target after restart, then checked at the public issuer.
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
  test("standalone refuses target metadata redirected to a valid public issuer", async () => {
    const publicIssuer = "https://other.public.example";
    const targetUrl = `${TARGET}/.well-known/oauth-authorization-server`;
    const publicUrl = `${publicIssuer}/.well-known/oauth-authorization-server`;
    const publicMetadata = {
      ...CIMD_METADATA,
      issuer: publicIssuer,
      token_endpoint: `${publicIssuer}/oauth/mcp/token`,
    };
    const { fetchImpl: baseFetch, calls } = fullMockFetch();
    const fetchImpl = (async (url: any, init?: RequestInit) => {
      if (String(url) === targetUrl) {
        calls.push("target-metadata");
        return init?.redirect === "manual"
          ? new Response(null, { status: 302, headers: { Location: publicUrl } })
          : new Response(JSON.stringify(publicMetadata), { status: 200 });
      }
      if (String(url) === publicUrl) {
        calls.push("public-metadata");
        return new Response(JSON.stringify(publicMetadata), { status: 200 });
      }
      return baseFetch(url, init);
    }) as typeof fetch;
    const result = await enableMcp(
      { ...BASE_PARAMS, ...tempPaths(), issuer: publicIssuer, confirmSecretsApplied: true },
      { fetchImpl },
    );

    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("self-verify");
    expect(result.refused?.message).toContain("--instance answered with a redirect; point --instance at the instance itself");
    expect(result.pasteBlock).toBeUndefined();
    expect(calls).toContain("ops:restart");
    expect(calls).toContain("target-metadata");
    expect(calls).not.toContain("public-metadata");
  });

  test("standalone refuses an unrelated issuer before checking its valid public metadata", async () => {
    const publicIssuer = "https://other.public.example";
    const { fetchImpl: baseFetch, calls } = fullMockFetch();
    const fetchImpl = (async (url: any, init?: RequestInit) => {
      if (String(url) === `${publicIssuer}/.well-known/oauth-authorization-server`) {
        calls.push("public-self-verify");
        return new Response(JSON.stringify({
          ...CIMD_METADATA,
          issuer: publicIssuer,
          token_endpoint: `${publicIssuer}/oauth/mcp/token`,
        }), { status: 200 });
      }
      return baseFetch(url, init);
    }) as typeof fetch;
    const result = await enableMcp(
      { ...BASE_PARAMS, ...tempPaths(), issuer: publicIssuer, confirmSecretsApplied: true },
      { fetchImpl },
    );

    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("self-verify");
    expect(result.refused?.message).toContain(`names issuer="${ISSUER}"; expected ${publicIssuer}`);
    expect(result.pasteBlock).toBeUndefined();
    expect(calls).not.toContain("public-self-verify");
  });

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

  test("confirmFlagOff:true requests one restart without claiming the route is unmounted", async () => {
    const { fetchImpl, calls } = mockOpsFetch();
    const result = await disableMcp({ instance: ISSUER, adminUser: "admin", adminPass: "pw", confirmFlagOff: true }, { fetchImpl });
    expect(result.ok).toBe(true);
    expect(calls.map((c) => c.body.operation)).toEqual(["restart"]);
    expect(result.detail).toBe(`restart requested for ${ISSUER}`);
    expect(result.detail).not.toMatch(/\/mcp.*(?:mount|route)/i);
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
    const creds = credentialTable();
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
      const credRes = creds.handle(body); // flair#1317: the mapping step reads its own write back
      if (credRes) return credRes;
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
    const creds = credentialTable();
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
      const credRes = creds.handle(body); // flair#1317: the mapping step reads its own write back
      if (credRes) return credRes;
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
    const creds = credentialTable();
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
      const credRes = creds.handle(body); // flair#1317: the mapping step reads its own write back
      if (credRes) return credRes;
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
    const creds = credentialTable();
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
      const credRes = creds.handle(body); // flair#1317: the mapping step reads its own write back
      if (credRes) return credRes;
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
    const creds = credentialTable();
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
      const credRes = creds.handle(body); // flair#1317: the mapping step reads its own write back
      if (credRes) return credRes;
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

  test("file not found at explicit path: re-run with the same explicit path", () => {
    const result = updateLocalConfigMcpEnabled(true, configPath);
    expect(result.ok).toBe(false);
    expect(result.detail).toBe(
      `local config.yaml not found (tried: ${configPath}). ` +
      `Place your component config.yaml at ${configPath}, then re-run with the same explicit path.`,
    );
  });

  test("file not found without explicit path: CLI remedy names only its search paths", () => {
    const cwd = process.cwd();
    try {
      process.chdir(configDir);
      withHome(configDir, () => {
        const homeConfig = join(resolveHome(), ".flair", "config.yaml");
        expect(homeConfig).toBe(join(configDir, ".flair", "config.yaml"));
        const result = updateLocalConfigMcpEnabled(true);
        expect(result.ok).toBe(false);
        expect(result.detail).toBe(
          `local config.yaml not found (tried: config.yaml, ${homeConfig}). ` +
          `Re-run \`flair mcp enable\` from the directory that holds your component config.yaml (or place it at ${homeConfig}).`,
        );
      });
    } finally {
      process.chdir(cwd);
    }
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
  test("Fabric origin: missing target issuer refuses at binding before restart", async () => {
    const FABRIC_ISSUER = "https://my-flair.harperfabric.com";
    const calls: string[] = [];
    const creds = credentialTable();
    const fetchImpl = (async (url: any, init?: RequestInit) => {
      const urlStr = String(url);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push(`ops:${body.operation ?? urlStr}`);
      if (body.operation === "search_by_value") return new Response(JSON.stringify([{ id: "self" }]), { status: 200 });
      const credRes = creds.handle(body); // flair#1317: the mapping step reads its own write back
      if (credRes) return credRes;
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
        secretsStagingPath: join(dir, "secrets.env"),
        confirmSecretsApplied: true,
      },
      { fetchImpl },
    );

    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("issuer-target-binding");
    // Must NOT call restart.
    expect(calls).not.toContain("ops:restart");
    const bindingStep = result.steps.find((s) => s.step === "issuer-target-binding");
    expect(bindingStep).toBeDefined();
    expect(bindingStep!.ok).toBe(false);
    expect(bindingStep!.detail).toContain("harperfabric.com");
    // A target response without an issuer cannot bind the public check.
    expect(bindingStep!.detail).toContain("FLAIR_MCP_ISSUER");
    expect(bindingStep!.detail).toContain("target's own metadata");
    expect(bindingStep!.detail).not.toContain("mcp.enabled: true");
    // Earlier steps (secrets, identity) still succeeded.
    const byStep = Object.fromEntries(result.steps.map((s) => [s.step, s.ok]));
    expect(byStep["secrets-provisioning"]).toBe(true);
    expect(byStep["identity-mapping"]).toBe(true);
  });

  // flair#2116: the step used to fail unconditionally, so every re-run after
  // the operator's restart ended at it with the same instructions.
  const FABRIC = "https://my-flair.harperfabric.com";
  const fabricParams = () => ({
    instance: FABRIC,
    idpClientId: "client-id",
    idpClientSecret: "client-secret",
    idpSubject: "octocat",
    adminUser: "admin",
    adminPass: "pw",
    secretsStagingPath: join(dir, "secrets.env"),
    confirmSecretsApplied: true,
  });
  const fabricFetch = (wellKnown: () => Promise<Response>, ops?: (body: any) => Response | null) => {
    const calls: string[] = [];
    const creds = credentialTable();
    const fetchImpl = (async (url: any, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr === `${FABRIC}/.well-known/oauth-authorization-server`) {
        calls.push("self-verify");
        return wellKnown();
      }
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push(`ops:${body.operation ?? urlStr}`);
      const custom = ops?.(body);
      if (custom) return custom;
      if (body.operation === "search_by_value") return new Response(JSON.stringify([{ id: "self" }]), { status: 200 });
      const credRes = creds.handle(body);
      if (credRes) return credRes;
      return new Response(JSON.stringify({ message: "ok" }), { status: 200 });
    }) as typeof fetch;
    return { fetchImpl, calls };
  };

  test("Fabric re-run once the operator has restarted: the step passes on self-verify and enable completes", async () => {
    const live = {
      ...CIMD_METADATA,
      issuer: FABRIC,
      registration_endpoint: undefined,
      token_endpoint: `${FABRIC}/oauth/mcp/token`,
    };
    const { fetchImpl, calls } = fabricFetch(async () => new Response(JSON.stringify(live), { status: 200 }));
    const result = await enableMcp(fabricParams(), { fetchImpl });

    expect(result.ok).toBe(true);
    expect(result.failedStep).toBeUndefined();
    expect(result.steps.every((s) => s.ok)).toBe(true);
    expect(result.steps.map((s) => s.step).slice(-2)).toEqual(["fabric-operator-deploy", "self-verify"]);
    const step = result.steps.find((s) => s.step === "fabric-operator-deploy")!;
    expect(step.detail).toContain(`already passes self-verify on ${FABRIC}`);
    expect(step.detail).toContain(`Issuer ${FABRIC} matched the target's own OAuth authorization-server metadata`);
    expect(result.pasteBlock).toContain(`${FABRIC}/mcp`);
    // Still never restarts a Fabric instance.
    expect(calls).not.toContain("ops:restart");
    expect(calls).toContain("self-verify");
  });

  const PUBLIC = "https://flair.public.example";
  const publicMetadata = {
    ...CIMD_METADATA,
    issuer: PUBLIC,
    token_endpoint: `${PUBLIC}/oauth/mcp/token`,
  };
  function proxyFetch(targetResponse: (init?: RequestInit) => Response) {
    const { fetchImpl: opsFetch } = fabricFetch(async () => new Response("unused", { status: 500 }));
    const calls: string[] = [];
    const fetchImpl = (async (url: any, init?: RequestInit) => {
      const address = String(url);
      if (address === `${FABRIC}/.well-known/oauth-authorization-server`) {
        calls.push("target-metadata");
        return targetResponse(init);
      }
      if (address === `${PUBLIC}/.well-known/oauth-authorization-server`) {
        calls.push("public-metadata");
        return new Response(JSON.stringify(publicMetadata), { status: 200 });
      }
      return opsFetch(url, init);
    }) as typeof fetch;
    return { fetchImpl, calls };
  }

  test("unrelated public issuer metadata cannot complete a Fabric target", async () => {
    const { fetchImpl, calls } = proxyFetch(() => new Response(JSON.stringify({
      ...CIMD_METADATA,
      issuer: FABRIC,
      token_endpoint: `${FABRIC}/oauth/mcp/token`,
    }), { status: 200 }));
    const result = await enableMcp({ ...fabricParams(), issuer: PUBLIC }, { fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("issuer-target-binding");
    expect(result.refused?.message).toContain(`names issuer="${FABRIC}"; expected ${PUBLIC}`);
    expect(result.pasteBlock).toBeUndefined();
    expect(calls).toEqual(["target-metadata"]);
  });

  test("a matching public proxy issuer completes even when it differs from --instance", async () => {
    const { fetchImpl, calls } = proxyFetch(() => new Response(JSON.stringify(publicMetadata), { status: 200 }));
    const result = await enableMcp({ ...fabricParams(), issuer: PUBLIC }, { fetchImpl });

    expect(result.ok).toBe(true);
    expect(result.issuer).toBe(PUBLIC);
    expect(result.pasteBlock).toContain(`${PUBLIC}/mcp`);
    expect(result.steps.find((s) => s.step === "fabric-operator-deploy")?.detail)
      .toContain(`Issuer ${PUBLIC} matched the target's own OAuth authorization-server metadata at ${FABRIC}/.well-known/oauth-authorization-server`);
    expect(calls).toEqual(["target-metadata", "public-metadata"]);
    const staged = readFileSync(join(dir, "secrets.env"), "utf8");
    expect(staged).toContain(`FLAIR_MCP_ISSUER=${PUBLIC}`);
    expect(staged).toContain(`OAUTH_GITHUB_CLIENT_ID=${BASE_PARAMS.idpClientId}`);
    expect(staged).toContain(`OAUTH_GITHUB_CLIENT_SECRET=${BASE_PARAMS.idpClientSecret}`);
    expect(staged).toContain(`OAUTH_GITHUB_REDIRECT_URI=${PUBLIC}/oauth`);
  });

  test("Fabric refuses target metadata redirected to valid public issuer metadata", async () => {
    const publicUrl = `${PUBLIC}/.well-known/oauth-authorization-server`;
    const { fetchImpl, calls } = proxyFetch((init) => init?.redirect === "manual"
      ? new Response(null, { status: 302, headers: { Location: publicUrl } })
      : new Response(JSON.stringify(publicMetadata), { status: 200 }));
    const result = await enableMcp({ ...fabricParams(), issuer: PUBLIC }, { fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("issuer-target-binding");
    expect(result.refused?.message).toContain("--instance answered with a redirect; point --instance at the instance itself");
    expect(result.pasteBlock).toBeUndefined();
    expect(calls).toEqual(["target-metadata"]);
  });

  test("Fabric refuses an opaque redirect from target metadata", async () => {
    const opaque = new Response(null, { status: 200 });
    Object.defineProperty(opaque, "type", { value: "opaqueredirect" });
    const { fetchImpl, calls } = proxyFetch(() => opaque);
    const result = await enableMcp({ ...fabricParams(), issuer: PUBLIC }, { fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("issuer-target-binding");
    expect(result.refused?.message).toContain("--instance answered with a redirect; point --instance at the instance itself");
    expect(calls).toEqual(["target-metadata"]);
  });

  test("the target's own OAuth server cannot bind a public MCP issuer", async () => {
    const { fetchImpl, calls } = proxyFetch(() => new Response(JSON.stringify({
      issuer: PUBLIC,
      token_endpoint: `${PUBLIC}/OAuthToken`,
    }), { status: 200 }));
    const result = await enableMcp({ ...fabricParams(), issuer: PUBLIC }, { fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.refused?.message).toContain("not the MCP authorization server's token endpoint");
    expect(result.pasteBlock).toBeUndefined();
    expect(calls).toEqual(["target-metadata"]);
  });

  test("unparseable target metadata refuses before public issuer verification", async () => {
    const { fetchImpl, calls } = proxyFetch(() => new Response("not json", { status: 200 }));
    const result = await enableMcp({ ...fabricParams(), issuer: PUBLIC }, { fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.refused?.message).toContain(`${FABRIC}/.well-known/oauth-authorization-server did not return JSON`);
    expect(result.refused?.message).toContain("Check the OAuth authorization-server metadata served by --instance");
    expect(result.pasteBlock).toBeUndefined();
    expect(calls).toEqual(["target-metadata"]);
  });

  test("Fabric first run: missing target metadata refuses with a named remedy", async () => {
    const { fetchImpl } = fabricFetch(async () => new Response("Not found", { status: 404 }));
    const result = await enableMcp(fabricParams(), { fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("issuer-target-binding");
    const step = result.steps.find((s) => s.step === "issuer-target-binding")!;
    expect(result.refused?.message).toBe(step.detail);
    expect(step.detail).toContain("Cannot confirm the target's configured issuer");
    expect(step.detail).toContain("returned HTTP 404");
    expect(step.detail).toContain("Check the OAuth authorization-server metadata served by --instance");
    expect(step.detail).toContain("FLAIR_MCP_ISSUER");
    expect(result.pasteBlock).toBeUndefined();
  });

  test("Fabric first run after an env-secrets push: matching target metadata still needs public activation", async () => {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    let metadataReads = 0;
    const { fetchImpl } = fabricFetch(
      async () => ++metadataReads === 1
        ? new Response(JSON.stringify({ ...CIMD_METADATA, issuer: FABRIC, token_endpoint: `${FABRIC}/oauth/mcp/token` }), { status: 200 })
        : new Response("Not found", { status: 404 }),
      (body) => {
        if (body.operation === "get_secrets_public_key") return new Response(JSON.stringify({ public_key: publicKey }), { status: 200 });
        if (body.operation === "set_secret") return new Response("{}", { status: 200 });
        if (body.operation === "search_by_value" && body.table === "hdb_secret") {
          return new Response(JSON.stringify([{ name: body.search_value, processEnv: true }]), { status: 200 });
        }
        return null;
      },
    );
    const result = await enableMcp(fabricParams(), { fetchImpl });

    expect(result.failedStep).toBe("fabric-operator-deploy");
    expect(result.steps.find((s) => s.step === "secrets-provisioning")!.detail).toContain("pushed to the target");
    const step = result.steps.find((s) => s.step === "fabric-operator-deploy")!;
    expect(step.detail).toContain("the secrets were pushed to the instance above");
    expect(step.detail).toContain("self-verify on https://my-flair.harperfabric.com has not passed yet");
    expect(step.detail).not.toContain("apply the staged secrets");
    expect(metadataReads).toBe(2);
  });

  test("Fabric: a failed public self-verify read after a matching target read never completes enable", async () => {
    let metadataReads = 0;
    const { fetchImpl, calls } = fabricFetch(async () => {
      if (++metadataReads === 1) return new Response(JSON.stringify({ ...CIMD_METADATA, issuer: FABRIC, token_endpoint: `${FABRIC}/oauth/mcp/token` }), { status: 200 });
      throw new Error("ECONNRESET");
    });
    const result = await enableMcp(fabricParams(), { fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("fabric-operator-deploy");
    expect(result.pasteBlock).toBeUndefined();
    expect(result.steps.some((s) => s.step === "self-verify")).toBe(false);
    expect(calls).not.toContain("ops:restart");
    const detail = result.steps.find((s) => s.step === "fabric-operator-deploy")!.detail;
    expect(detail).toContain(`the public issuer could not be reached (could not reach ${FABRIC}/.well-known/oauth-authorization-server: ECONNRESET)`);
    expect(detail).toContain("does not show that the environment is wrong or that a restart is needed");
    expect(detail).toContain("resolves in DNS");
    expect(detail).toContain("reach it over HTTPS");
    expect(detail).not.toContain("To activate");
    expect(result.refused).toBeUndefined();
    expect(metadataReads).toBe(2);
  });

  test("Fabric origin: result includes issuer and resource for status checks", async () => {
    const FABRIC_ISSUER = "https://my-flair.harperfabric.com";
    const creds = credentialTable();
    const fetchImpl = (async (url: any, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (body.operation === "search_by_value") return new Response(JSON.stringify([{ id: "self" }]), { status: 200 });
      const credRes = creds.handle(body); // flair#1317: the mapping step reads its own write back
      if (credRes) return credRes;
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

describe("enableMcp — URL target classification (flair#2189)", () => {
  const CUSTOM = "https://mcp.acme.example";
  const customParams = () => ({
    ...BASE_PARAMS,
    ...tempPaths(),
    instance: CUSTOM,
    issuer: CUSTOM,
    confirmSecretsApplied: true,
  });

  test("a remote target reporting this machine's hostname is refused before any change", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: any, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push(`ops:${body.operation ?? String(url)}`);
      if (body.operation === "system_information") {
        return new Response(
          JSON.stringify({ system: { hostname: osHostname() }, harperdb_processes: { core: [{ pid: 4242 }] } }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ message: "ok" }), { status: 200 });
    }) as typeof fetch;

    const configBefore = readFileSync(join(dir, "config.yaml"), "utf-8");
    const result = await enableMcp(customParams(), { fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("target-shape-check");
    expect(result.refused?.message).toContain("--fabric");
    expect(result.refused?.message).toContain(CUSTOM);
    expect(calls).toEqual([]);
    expect(calls).not.toContain("ops:restart");
    expect(calls.some((c) => c.includes("get_secrets_public_key") || c.includes("set_secret"))).toBe(false);
    expect(readFileSync(join(dir, "config.yaml"), "utf-8")).toBe(configBefore);
    expect(existsSync(join(dir, "signing-key.pem"))).toBe(false);
    expect(existsSync(join(dir, "secrets.env"))).toBe(false);
  });

  test("the same target with --fabric takes the Fabric branch", async () => {
    const meta = {
      issuer: CUSTOM,
      token_endpoint: `${CUSTOM}/oauth/mcp/token`,
      client_id_metadata_document_supported: true,
      token_endpoint_auth_methods_supported: ["none"],
    };
    const calls: string[] = [];
    const creds = credentialTable();
    const fetchImpl = (async (url: any, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr === `${CUSTOM}/.well-known/oauth-authorization-server`) {
        calls.push("metadata");
        return new Response(JSON.stringify(meta), { status: 200 });
      }
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push(`ops:${body.operation ?? urlStr}`);
      if (body.operation === "search_by_value") return new Response(JSON.stringify([{ id: "self" }]), { status: 200 });
      const credRes = creds.handle(body);
      if (credRes) return credRes;
      return new Response(JSON.stringify({ message: "ok" }), { status: 200 });
    }) as typeof fetch;

    const result = await enableMcp({ ...customParams(), fabric: true }, { fetchImpl });

    expect(result.ok, JSON.stringify(result.steps)).toBe(true);
    expect(result.steps.map((s) => s.step).slice(-2)).toEqual(["fabric-operator-deploy", "self-verify"]);
    expect(calls).not.toContain("ops:restart");
    expect(result.steps.some((s) => s.step === "target-shape-check")).toBe(false);
  });

  test.each(["http://127.0.0.1:9926", "http://127.23.45.67:9926", "http://localhost:9926", "http://[::1]:9926"])("loopback target %s with a public issuer takes the standalone branch", async (instance) => {
    const { fetchImpl, calls } = fullMockFetch();
    const result = await enableMcp({ ...BASE_PARAMS, ...tempPaths(), instance, confirmSecretsApplied: true }, { fetchImpl });
    expect(calls).toContain("ops:restart");
    expect(result.ok).toBe(true);
    expect(result.steps.some((s) => s.step === "target-shape-check")).toBe(false);
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

  // ─── flair#2193: a failed local config update must stop before the restart ──

  test.each(["explicit-path", "CLI-shaped"])("flair#2193: %s assembled failure detail preserves the caller's retry path and stops before restart", async (caller) => {
    const { fetchImpl, calls } = fullMockFetch();
    const explicitPath = join(dir, "absent-config.yaml");
    const { localConfigPath, ...paths } = tempPaths();
    const homeDir = mkdtempSync(join(dir, "home-"));
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    const cwd = process.cwd();
    let homeConfig: string;
    let result: EnableMcpResult;
    try {
      process.env.HOME = homeDir;
      process.env.USERPROFILE = homeDir;
      homeConfig = join(resolveHome(), ".flair", "config.yaml");
      expect(homeConfig).toBe(join(homeDir, ".flair", "config.yaml"));
      if (caller === "CLI-shaped") {
        rmSync(localConfigPath);
        expect(existsSync(homeConfig)).toBe(false);
        process.chdir(dir);
      }
      result = await enableMcp(
        { ...BASE_PARAMS, ...paths, ...(caller === "explicit-path" ? { localConfigPath: explicitPath } : {}), confirmSecretsApplied: true },
        { fetchImpl },
      );
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevProfile;
      process.chdir(cwd);
    }

    // No success result (the CLI exits non-zero on ok:false).
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("local-config-update");
    // No restart, and none of the restart step's own calls: the flow stopped
    // before captureBootDiscriminator.
    expect(calls).not.toContain("ops:restart");
    expect(calls).not.toContain("ops:system_information");
    const failed = result.steps.find((s) => s.step === "local-config-update" && !s.ok);
    expect(failed?.detail).toBe(caller === "explicit-path"
      ? `local config.yaml not found (tried: ${explicitPath}). ` +
        `Place your component config.yaml at ${explicitPath}, then re-run with the same explicit path. ` +
        "This command did not restart the instance. Fix the cause above, then retry the call with the same explicit path."
      : `local config.yaml not found (tried: config.yaml, ${homeConfig}). ` +
        `Re-run \`flair mcp enable\` from the directory that holds your component config.yaml (or place it at ${homeConfig}). ` +
        "This command did not restart the instance. Fix the cause above, then re-run `flair mcp enable`.");
  });
});
