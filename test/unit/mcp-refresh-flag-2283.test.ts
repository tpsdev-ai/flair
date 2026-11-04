/**
 * mcp-refresh-flag-2283.test.ts — flair#2283 item 2.
 *
 * These drive `refreshMcpOAuthFlag` with mocked fetch and a real RSA key.
 * A refused push response and a request without a confirmed response are distinct;
 * the latter's outcome could not be confirmed (it may have been stored).
 * Real Harper coverage is in test/integration-heavy/mcp-refresh-real-harper-2283.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, privateDecrypt, createDecipheriv, constants } from "node:crypto";
import { defaultRefreshSecretsStagingPath, defaultSecretsStagingPath, refreshMcpOAuthFlag } from "../../src/lib/mcp-enable.ts";
import { ENV_ENCRYPTED_PREFIX } from "../../src/lib/secret-envelope.ts";

const INSTANCE = "https://agent-a.harperfabric.com";
const { publicKey: PUB, privateKey: PRIV } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

/** Decrypt the envelope produced by sealSecret. */
function decryptEnvelope(envelope: string): string {
  const env = JSON.parse(Buffer.from(envelope.slice(ENV_ENCRYPTED_PREFIX.length), "base64url").toString("utf8"));
  const aes = privateDecrypt({ key: PRIV, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(env.k, "base64"));
  const d = createDecipheriv("aes-256-gcm", aes, Buffer.from(env.iv, "base64"));
  d.setAuthTag(Buffer.from(env.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(env.ct, "base64")), d.final()]).toString("utf8");
}

type Shape = "plugin-live" | "plugin-absent";

let shape: Shape = "plugin-live";

/** An ops-API and discovery stub.
 *  - `disablePush` makes the capability probe fail.
 *  - `otherIssuer` answers the discovery path for any host that is NOT `INSTANCE`
 *    with a live MCP document advertising that other issuer — the "a live AS
 *    elsewhere" shape blocker 2 describes.
 *  - `discovery(url)` answers the discovery path first when it returns a Response.
 *  - `restartWithoutEffect` acknowledges a restart but never changes the PID, so
 *    the restart verification must fail.
 *  - `failPush` makes the capability probe succeed but the `set_secret` response refuse,
 *    so refresh takes its fallback AFTER the push rather than at the probe.
 *  - `inertPush` makes `set_secret` answer successfully and returns a read-back
 *    row with `processEnv:false`; storage with `processEnv=true` is unconfirmed.
 *  - `throwOn` throws after recording receipt of the named ops operation.
 *
 *  The ops fake advances the Harper PID ONLY when a `restart` was actually
 *  requested: a run that never restarts (or restarts ineffectively) sees an
 *  unchanged PID, so the verification cannot pass on a no-op. */
function opsFetch(
  opts: { disablePush?: boolean; failPush?: boolean; pushStatus?: number; inertPush?: boolean; otherIssuer?: string; throwOn?: string; discovery?: (url: URL) => Response | undefined; restartWithoutEffect?: boolean } = {},
) {
  const sent: any[] = [];
  let restarts = 0;
  const impl = (async (input: any, init: any) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    // Discovery responses are synthetic.
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      const custom = opts.discovery?.(url);
      if (custom) return custom;
      if (opts.otherIssuer && url.hostname !== new URL(INSTANCE).hostname) {
        return Response.json({ issuer: opts.otherIssuer, token_endpoint: `${opts.otherIssuer}/oauth/mcp/token` });
      }
      return Response.json({ issuer: INSTANCE, token_endpoint: `${INSTANCE}/${shape === "plugin-live" ? "oauth/mcp/token" : "OAuthToken"}` });
    }
    const body = JSON.parse(init.body);
    sent.push(body);
    const op = body.operation;
    if (opts.throwOn && op === opts.throwOn) throw new Error(`fixture: ${op} exploded`);
    if (op === "get_secrets_public_key") {
      return opts.disablePush
        ? Response.json({ error: "Operation 'get_secrets_public_key' not found" }, { status: 400 })
        : Response.json({ public_key: PUB });
    }
    if (op === "set_secret") {
      return opts.failPush
        ? Response.json({ error: "set_secret refused by fixture" }, { status: 400 })
        : Response.json({ ok: true }, { status: opts.pushStatus ?? 200 });
    }
    if (op === "search_by_value") return Response.json([{ name: body.search_value, processEnv: !opts.inertPush }]);
    if (op === "restart") {
      if (!opts.restartWithoutEffect) restarts++;
      return Response.json({ ok: true });
    }
    if (op === "system_information") return Response.json({ harperdb_processes: { core: [{ pid: 100 + restarts }] } });
    return Response.json({ ok: true });
  }) as unknown as typeof fetch;
  return { impl, sent };
}

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "flair-2283-refresh-"));
});
// Each case starts with NO staging file at the explicit path: `refreshMcpOAuthFlag`
// now REFUSES by name an explicit path that already holds a file (flair#2283 round 8),
// so a leftover file from a prior case would be refused rather than overwritten.
beforeEach(() => {
  rmSync(join(dir, "refresh.env"), { force: true });
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function base() {
  return {
    instance: INSTANCE,
    adminUser: "admin",
    adminPass: "pw",
    secretsStagingPath: join(dir, "refresh.env"),
  };
}

const FAST = { waitForOpsApiTimeoutMs: 500, waitForOpsApiPollMs: 10 };

describe("refreshMcpOAuthFlag (flair#2283 item 2)", () => {
  test("a local encryption failure stages fallback without claiming a stored push", async () => {
    const { impl, sent } = opsFetch();
    const result = await refreshMcpOAuthFlag(base(), {
      fetchImpl: impl,
      sealImpl: () => { throw new Error("fixture encryption failure"); },
      ...FAST,
    });
    expect(sent.map((body) => body.operation)).toEqual(["get_secrets_public_key"]);
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("secrets-provisioning");
    const detail = result.steps.find((step) => step.step === "secrets-provisioning")?.detail ?? "";
    expect(detail).toContain("local encryption failure: nothing was sent, nothing stored");
    expect(detail).not.toContain("may have been stored");
    expect(detail).not.toContain("push was refused by the target");
    expect(result.secretsPath).toBe(base().secretsStagingPath);
    expect(readFileSync(base().secretsStagingPath, "utf8")).toBe("FLAIR_MCP_OAUTH=true\n");
  });

  test("pushes FLAIR_MCP_OAUTH=true, restarts, and the public document names the MCP token endpoint", async () => {
    shape = "plugin-live";
    const { impl, sent } = opsFetch();
    const result = await refreshMcpOAuthFlag(base(), { fetchImpl: impl, ...FAST });
    expect(result.ok).toBe(true);
    // The one variable pushed is FLAIR_MCP_OAUTH, and its sealed value decrypts to "true".
    const pushedNames = sent.filter((b) => b.operation === "set_secret").map((b) => b.name);
    expect(pushedNames).toEqual(["FLAIR_MCP_OAUTH"]);
    const setCall = sent.find((b) => b.operation === "set_secret");
    expect(Object.keys(setCall)).not.toContain("value"); // never plaintext on the wire
    expect(setCall.processEnv).toBe(true);
    // The sealed value decrypts to the requested "true".
    expect(decryptEnvelope(String(setCall.envelope))).toBe("true");
    // It restarted and self-verified.
    expect(sent.some((b) => b.operation === "restart")).toBe(true);
    expect(result.steps.find((s) => s.step === "self-verify")?.ok).toBe(true);
    // Successful push and marker responses do not produce a fallback path.
    expect(result.secretsPath).toBeUndefined();
  });

  test("refuses success when the target document advertises flair's own token endpoint", async () => {
    shape = "plugin-absent";
    const { impl } = opsFetch();
    const result = await refreshMcpOAuthFlag(base(), { fetchImpl: impl, ...FAST });
    expect(result.ok).toBe(false);
    expect(result.refused).toBeDefined();
    expect(result.failedStep).toBe("issuer-target-binding");
    expect(result.steps.find((s) => s.step === "issuer-target-binding")?.detail).toContain(
      "not the MCP authorization server's token endpoint",
    );
    // No fallback file was written, so no secretsPath (flair#2283 round 9).
    expect(result.secretsPath).toBeUndefined();
  });

  // A matching public document must not bypass the target issuer check.
  test("a mismatched --issuer is refused, not reported ok", async () => {
    shape = "plugin-absent";
    const OTHER = "https://live-elsewhere.example.com";
    const { impl } = opsFetch({ otherIssuer: OTHER });
    const result = await refreshMcpOAuthFlag({ ...base(), issuer: OTHER }, { fetchImpl: impl, ...FAST });
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("issuer-target-binding");
    // The refusal names the mismatch: the target advertises INSTANCE, not OTHER.
    expect(result.refused?.message ?? "").toContain(INSTANCE);
    expect(result.refused?.message ?? "").toContain(OTHER);
    expect(result.steps.find((s) => s.step === "self-verify")?.ok).not.toBe(true);
    expect(result.secretsPath).toBeUndefined();
  });

  test("a failed capability probe creates fallback at an unoccupied explicit path", async () => {
    shape = "plugin-live";
    const { impl } = opsFetch({ disablePush: true });
    const stagedPath = base().secretsStagingPath;
    rmSync(stagedPath, { force: true });
    const result = await refreshMcpOAuthFlag(base(), { fetchImpl: impl, ...FAST });
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("secrets-provisioning");
    expect(result.steps.find((s) => s.step === "secrets-provisioning")?.detail).toContain(stagedPath);
    // The fallback file is not merely NAMED in the message: it is really on disk,
    // mode 0600, and carries the requested flag value. Naming a path that was never written would still satisfy the old
    // assertion; this one reads the file back and checks its permission bits.
    expect(readFileSync(stagedPath, "utf8")).toBe("FLAIR_MCP_OAUTH=true\n");
    expect(statSync(stagedPath).mode & 0o777).toBe(0o600);
    // The file really exists, so the result NAMES it (flair#2283 round 9).
    expect(result.secretsPath).toBe(stagedPath);
  });

  // flair#2283 round 9: the OTHER fallback branch. The capability probe SUCCEEDS
  // (so this is not the probe-refusal path) but the `set_secret` response refuses the push, so the
  // fallback file is written AFTER the push — and the result carries that path.
  test("a refused push response creates fallback and reports the refusal", async () => {
    shape = "plugin-live";
    const { impl, sent } = opsFetch({ failPush: true });
    const stagedPath = base().secretsStagingPath;
    rmSync(stagedPath, { force: true });
    const result = await refreshMcpOAuthFlag(base(), { fetchImpl: impl, ...FAST });
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("secrets-provisioning");
    // The probe succeeded and the server refused the push.
    expect(sent.some((b) => b.operation === "get_secrets_public_key")).toBe(true);
    expect(sent.some((b) => b.operation === "set_secret")).toBe(true);
    expect(result.steps.find((s) => s.step === "secrets-provisioning")?.detail).toContain(stagedPath);
    expect(readFileSync(stagedPath, "utf8")).toBe("FLAIR_MCP_OAUTH=true\n");
    expect(result.secretsPath).toBe(stagedPath);
    const detail = result.steps.find((s) => s.step === "secrets-provisioning")?.detail ?? "";
    expect(detail).toContain("push was refused by the target");
    expect(detail).toContain("HTTP 400");
    expect(detail).not.toContain("push outcome could not be confirmed");
  });

  test("a set_secret request without a confirmed response reports that it may have been stored", async () => {
    const { impl, sent } = opsFetch({ throwOn: "set_secret" });
    const result = await refreshMcpOAuthFlag(base(), { fetchImpl: impl, ...FAST });
    expect(sent.some((b) => b.operation === "set_secret")).toBe(true);
    expect(sent.some((b) => b.operation === "search_by_value")).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("secrets-provisioning");
    const detail = result.steps.find((s) => s.step === "secrets-provisioning")?.detail ?? "";
    expect(detail).toContain("push outcome could not be confirmed");
    expect(detail).toContain("it may have been stored");
    expect(detail).not.toContain("was not pushed");
    expect(detail).not.toContain("push was refused");
    expect(readFileSync(base().secretsStagingPath, "utf8")).toBe("FLAIR_MCP_OAUTH=true\n");
    expect(result.secretsPath).toBe(base().secretsStagingPath);
  });

  // `set_secret` answered successfully; the returned row lacks processEnv=true.
  test("a successful set_secret response with processEnv=false read-back is reported as unconfirmed", async () => {
    shape = "plugin-live";
    const { impl, sent } = opsFetch({ inertPush: true });
    const stagedPath = base().secretsStagingPath;
    rmSync(stagedPath, { force: true });
    const result = await refreshMcpOAuthFlag(base(), { fetchImpl: impl, ...FAST });
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("secrets-provisioning");
    // The push was attempted and read back; the row just did not show processEnv=true.
    expect(sent.some((b) => b.operation === "set_secret")).toBe(true);
    expect(sent.some((b) => b.operation === "search_by_value")).toBe(true);
    const detail = result.steps.find((s) => s.step === "secrets-provisioning")?.detail ?? "";
    expect(detail).toContain("could not be confirmed");
    expect(detail).not.toContain("was not pushed");
    // The fallback is still left on disk and named.
    expect(readFileSync(stagedPath, "utf8")).toBe("FLAIR_MCP_OAUTH=true\n");
    expect(result.secretsPath).toBe(stagedPath);
  });

  // A thrown read-back after a successful set_secret response is unconfirmed.
  test("a read-back that throws after a successful set_secret response is reported as unconfirmed", async () => {
    shape = "plugin-live";
    const { impl, sent } = opsFetch({ throwOn: "search_by_value", pushStatus: 201 });
    const stagedPath = base().secretsStagingPath;
    rmSync(stagedPath, { force: true });
    const result = await refreshMcpOAuthFlag(base(), { fetchImpl: impl, ...FAST });
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("secrets-provisioning");
    // The push itself was issued; the read-back is what threw.
    expect(sent.some((b) => b.operation === "set_secret")).toBe(true);
    expect(sent.some((b) => b.operation === "search_by_value")).toBe(true);
    const detail = result.steps.find((s) => s.step === "secrets-provisioning")?.detail ?? "";
    expect(detail).toContain("could not be confirmed");
    expect(detail).not.toContain("was not pushed");
    expect(detail).toContain("push returned HTTP 201");
    expect(detail).not.toContain("push returned 200");
    // A thrown read-back leaves storage unknown.
    // The fallback is still staged and named.
    expect(readFileSync(stagedPath, "utf8")).toBe("FLAIR_MCP_OAUTH=true\n");
    expect(result.secretsPath).toBe(stagedPath);
  });

  test("--dry-run makes no remote call", async () => {
    const { impl } = opsFetch();
    // Count EVERY fetch — ops calls AND discovery reads — not just the ops bodies
    // the stub records. A dry run that still probed discovery would leave `sent`
    // empty yet issue a request; this counts the request itself.
    let fetches = 0;
    const counting = (async (input: any, init: any) => {
      fetches++;
      return impl(input, init);
    }) as unknown as typeof fetch;
    const result = await refreshMcpOAuthFlag({ ...base(), dryRun: true }, { fetchImpl: counting, ...FAST });
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(fetches).toBe(0);
    expect(result.secretsPath).toBeUndefined();
  });

  // flair#2283 round 2: after the target binding, the PUBLIC document must name
  // the SAME verified issuer and its token endpoint. Here the target is fine (its
  // document advertises PUBLIC with the MCP token endpoint) but the public document
  // names a DIFFERENT issuer — a check that trusted the document's own issuer would
  // call this ok. It must be refused, not ok:true.
  test("a public document naming a different issuer than the verified target is refused, not ok:true", async () => {
    const PUBLIC = "https://public.example.com";
    const STRANGER = "https://stranger.example.com";
    const { impl } = opsFetch({
      discovery: (url) => {
        if (url.hostname === new URL(INSTANCE).hostname) {
          // The target's own document advertises the issuer being verified.
          return Response.json({ issuer: PUBLIC, token_endpoint: `${PUBLIC}/oauth/mcp/token` });
        }
        if (url.hostname === new URL(PUBLIC).hostname) {
          // The public document names a different issuer entirely.
          return Response.json({ issuer: STRANGER, token_endpoint: `${STRANGER}/oauth/mcp/token` });
        }
        return undefined;
      },
    });
    const result = await refreshMcpOAuthFlag({ ...base(), issuer: PUBLIC }, { fetchImpl: impl, ...FAST });
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("self-verify");
    // The target binding passed; the refusal names the public document's issuer.
    expect(result.steps.find((s) => s.step === "issuer-target-binding")?.ok).toBe(true);
    expect(result.steps.find((s) => s.step === "self-verify")?.ok).not.toBe(true);
    expect(result.steps.find((s) => s.step === "self-verify")?.detail).toContain(STRANGER);
    expect(result.secretsPath).toBeUndefined();
  });

  // The ops stub advances its PID only on an effective simulated restart.
  test("an acknowledged but ineffective restart fails the PID check", async () => {
    shape = "plugin-live";
    const { impl } = opsFetch({ restartWithoutEffect: true });
    const result = await refreshMcpOAuthFlag(base(), { fetchImpl: impl, ...FAST });
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("verify-restart");
    expect(result.steps.find((s) => s.step === "verify-restart")?.ok).not.toBe(true);
    // The restart failure does not name a fallback path.
    expect(result.secretsPath).toBeUndefined();
  });

  test("an unexpected ops error after the push returns no secretsPath", async () => {
    shape = "plugin-live";
    const { impl } = opsFetch({ throwOn: "system_information" });
    const result = await refreshMcpOAuthFlag(base(), { fetchImpl: impl, ...FAST });
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("restart");
    expect(result.secretsPath).toBeUndefined();
  });

  // flair#2283 round 8: `--refresh-flag` and ordinary `mcp enable` must NOT share a
  // default staging file. They stage different bundles (enable: the full IdP
  // credentials bundle; refresh: the single FLAIR_MCP_OAUTH var) and a refresh that
  // wrote its one-var file to the enable path would erase a bundle a prior enable had
  // staged. Here a full bundle sits at the enable path; a refresh with an unavailable capability probe
  // (and an unoccupied fallback path) must leave that bundle byte-identical and
  // land its own file elsewhere.
  test("refresh writes its own default file, never truncating a staged IdP bundle at the enable path", async () => {
    shape = "plugin-live";
    const home = mkdtempSync(join(tmpdir(), "flair-2283-refresh-home-"));
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const enablePath = defaultSecretsStagingPath(INSTANCE);
      const refreshPath = defaultRefreshSecretsStagingPath(INSTANCE);
      expect(refreshPath).not.toBe(enablePath);
      mkdirSync(join(home, ".flair"), { recursive: true });
      const idpBundle =
        "FLAIR_MCP_OAUTH=true\n" +
        "OAUTH_GITHUB_CLIENT_ID=idp-client\n" +
        "OAUTH_GITHUB_CLIENT_SECRET=idp-secret\n" +
        "OAUTH_GITHUB_REDIRECT_URI=https://agent-a.harperfabric.com/oauth\n";
      writeFileSync(enablePath, idpBundle, { mode: 0o600 });

      // disablePush => the capability probe fails => refresh takes its fallback and
      // WRITES its staged file. A shared default path would truncate the bundle above.
      const { impl } = opsFetch({ disablePush: true });
      const result = await refreshMcpOAuthFlag({ instance: INSTANCE, adminUser: "admin", adminPass: "pw" }, { fetchImpl: impl, ...FAST });
      expect(result.ok).toBe(false);

      expect(readFileSync(enablePath, "utf8")).toBe(idpBundle);
      expect(readFileSync(refreshPath, "utf8")).toBe("FLAIR_MCP_OAUTH=true\n");
      expect(result.secretsPath).toBe(refreshPath);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevProfile;
      rmSync(home, { recursive: true, force: true });
    }
  });

  // flair#2283 round 8: an EXPLICIT staging path is the operator's own file. A
  // refresh must refuse a path that already holds a file BY NAME rather than
  // truncate it (it may be a credentials bundle), and must not even probe the
  // target before doing so.
  test("an explicit --secrets-path that already holds a file is refused by name, not truncated", async () => {
    const explicit = join(dir, "occupied.env");
    const existing =
      "OAUTH_GITHUB_CLIENT_ID=keep-me\n" + "OAUTH_GITHUB_CLIENT_SECRET=keep-me-too\n";
    writeFileSync(explicit, existing, { mode: 0o600 });

    const { impl, sent } = opsFetch();
    const result = await refreshMcpOAuthFlag({ ...base(), secretsStagingPath: explicit }, { fetchImpl: impl, ...FAST });

    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("secrets-provisioning");
    expect(result.refused?.message ?? "").toContain(explicit);
    // The file is untouched, and no request was made (a truncate-then-probe would
    // have both emptied it and issued the ops probe).
    expect(readFileSync(explicit, "utf8")).toBe(existing);
    expect(sent).toEqual([]);
    expect(result.secretsPath).toBeUndefined();
  });

  // flair#2283 round 10: refresh's OWN default filename can be occupied too — an
  // operator may name `defaultRefreshSecretsStagingPath` in `mcp enable
  // --secrets-path`, staging the full IdP bundle there. When refresh then needs its
  // fallback, it must refuse BY NAME and write nothing, never truncating that bundle;
  // the writer opens exclusively (`wx`), so the file is byte-identical afterwards and
  // the result names the refusal instead of a path it did not write.
  test("an occupied default staging path is refused when fallback is needed", async () => {
    shape = "plugin-live";
    const home = mkdtempSync(join(tmpdir(), "flair-2283-refresh-home-occ-"));
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const refreshPath = defaultRefreshSecretsStagingPath(INSTANCE);
      mkdirSync(join(home, ".flair"), { recursive: true });
      const idpBundle =
        "FLAIR_MCP_OAUTH=true\n" +
        "OAUTH_GITHUB_CLIENT_ID=idp-client\n" +
        "OAUTH_GITHUB_CLIENT_SECRET=idp-secret\n" +
        "OAUTH_GITHUB_REDIRECT_URI=https://agent-a.harperfabric.com/oauth\n";
      writeFileSync(refreshPath, idpBundle, { mode: 0o600 });

      // A thrown read-back leaves storage unconfirmed; refresh needs its fallback,
      // whose path IS the file above. A truncating writer would erase the bundle.
      const { impl } = opsFetch({ throwOn: "search_by_value" });
      const result = await refreshMcpOAuthFlag(
        { instance: INSTANCE, adminUser: "admin", adminPass: "pw" },
        { fetchImpl: impl, ...FAST },
      );

      expect(result.ok).toBe(false);
      expect(result.failedStep).toBe("secrets-provisioning");
      // The refusal names the occupied path, and nothing was written.
      expect(result.refused?.message ?? "").toContain(refreshPath);
      expect(result.refused?.message ?? "").toContain("storage with processEnv=true could not be confirmed");
      expect(result.refused?.message ?? "").not.toContain("was not pushed");
      expect(readFileSync(refreshPath, "utf8")).toBe(idpBundle);
      expect(result.secretsPath).toBeUndefined();
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevProfile;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
