/**
 * mcp-refresh-flag-2283.test.ts — flair#2283 item 2.
 *
 * `flair mcp enable --refresh-flag` is the one-shot migration for an instance
 * that still holds the old staged value (`FLAIR_MCP_OAUTH=1`) — a value the
 * `@harperfast/oauth` component deletes, leaving its MCP authorization server
 * disabled. The flag pushes an encrypted `FLAIR_MCP_OAUTH=true` update, checks
 * the secret row's processEnv marker, verifies a restart by PID change, and checks the
 * target's own discovery document and the PUBLIC document read at the verified
 * issuer name that issuer with the MCP token endpoint — the shared discriminator,
 * bound to an issuer the caller knows. It does not run the IdP-credential intake
 * nor apply CIMD changes.
 *
 * These drive `refreshMcpOAuthFlag` with an injected fetch: ops calls go to a
 * stub (a real RSA public key, so the value is sealed through the real
 * `pushSecrets` path), and the discovery read is delegated to a REAL HTTP
 * server that answers each document shape on the wire.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, privateDecrypt, createDecipheriv, constants } from "node:crypto";
import { refreshMcpOAuthFlag } from "../../src/lib/mcp-enable.ts";
import { ENV_ENCRYPTED_PREFIX } from "../../src/lib/secret-envelope.ts";

const INSTANCE = "https://agent-a.harperfabric.com";
const { publicKey: PUB, privateKey: PRIV } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

/** Decrypt an enc:v1 envelope the way Harper's env-secrets decryptor does. */
function decryptEnvelope(envelope: string): string {
  const env = JSON.parse(Buffer.from(envelope.slice(ENV_ENCRYPTED_PREFIX.length), "base64url").toString("utf8"));
  const aes = privateDecrypt({ key: PRIV, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(env.k, "base64"));
  const d = createDecipheriv("aes-256-gcm", aes, Buffer.from(env.iv, "base64"));
  d.setAuthTag(Buffer.from(env.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(env.ct, "base64")), d.final()]).toString("utf8");
}

type Shape = "plugin-live" | "plugin-absent";

let server: ReturnType<typeof Bun.serve>;
let shape: Shape = "plugin-live";

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/.well-known/oauth-authorization-server") {
        const token = shape === "plugin-live" ? `${INSTANCE}/oauth/mcp/token` : `${INSTANCE}/OAuthToken`;
        return Response.json({ issuer: INSTANCE, token_endpoint: token });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  });
});

afterAll(() => {
  server.stop(true);
});

/** An ops-API stub + a delegating fetch.
 *  - `disablePush` makes the capability probe fail.
 *  - `otherIssuer` answers the discovery path for any host that is NOT `INSTANCE`
 *    with a live MCP document advertising that other issuer — the "a live AS
 *    elsewhere" shape blocker 2 describes.
 *  - `discovery(url)` answers the discovery path first when it returns a Response.
 *  - `restartWithoutEffect` acknowledges a restart but never changes the PID, so
 *    the restart verification must fail.
 *
 *  The ops fake advances the Harper PID ONLY when a `restart` was actually
 *  requested: a run that never restarts (or restarts ineffectively) sees an
 *  unchanged PID, so the verification cannot pass on a no-op. */
function opsFetch(
  opts: { disablePush?: boolean; otherIssuer?: string; discovery?: (url: URL) => Response | undefined; restartWithoutEffect?: boolean } = {},
) {
  const sent: any[] = [];
  let restarts = 0;
  const impl = (async (input: any, init: any) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    // The discovery read is answered by `discovery`, `otherIssuer`, or the REAL
    // server; everything else is the ops stub.
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      const custom = opts.discovery?.(url);
      if (custom) return custom;
      if (opts.otherIssuer && url.hostname !== new URL(INSTANCE).hostname) {
        return Response.json({ issuer: opts.otherIssuer, token_endpoint: `${opts.otherIssuer}/oauth/mcp/token` });
      }
      return fetch(`http://127.0.0.1:${server.port}/.well-known/oauth-authorization-server`);
    }
    const body = JSON.parse(init.body);
    sent.push(body);
    const op = body.operation;
    if (op === "get_secrets_public_key") {
      return opts.disablePush
        ? Response.json({ error: "Operation 'get_secrets_public_key' not found" }, { status: 400 })
        : Response.json({ public_key: PUB });
    }
    if (op === "search_by_value") return Response.json([{ name: body.search_value, processEnv: true }]);
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
    // The sealed value genuinely decrypts to "true" — the one value both readers accept.
    expect(decryptEnvelope(String(setCall.envelope))).toBe("true");
    // It restarted and self-verified.
    expect(sent.some((b) => b.operation === "restart")).toBe(true);
    expect(result.steps.find((s) => s.step === "self-verify")?.ok).toBe(true);
    expect(result.secretsPath).toBe(base().secretsStagingPath);
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
  });

  // flair#2283 blocker 2: --refresh-flag must BIND the verification to the target,
  // as the enable path does. Reading --issuer alone let a live AS elsewhere make a
  // broken target report ok. Here the target at INSTANCE still serves flair's own
  // AS while a DIFFERENT live MCP AS answers at OTHER; --issuer OTHER must be refused.
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
  });

  test("a target that cannot take a pushed secret leaves the staged file and names it", async () => {
    shape = "plugin-live";
    const { impl } = opsFetch({ disablePush: true });
    const stagedPath = base().secretsStagingPath;
    rmSync(stagedPath, { force: true });
    const result = await refreshMcpOAuthFlag(base(), { fetchImpl: impl, ...FAST });
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("secrets-provisioning");
    expect(result.steps.find((s) => s.step === "secrets-provisioning")?.detail).toContain(stagedPath);
    // The fallback file is not merely NAMED in the message: it is really on disk,
    // unreadable-by-others (0600), and carries exactly the one value the reader
    // accepts. Naming a path that was never written would still satisfy the old
    // assertion; this one reads the file back and checks its permission bits.
    expect(readFileSync(stagedPath, "utf8")).toBe("FLAIR_MCP_OAUTH=true\n");
    expect(statSync(stagedPath).mode & 0o777).toBe(0o600);
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
  });

  // flair#2283 item 2: the ops fake advances the PID only on a real restart, so an
  // acknowledged-but-ineffective restart must fail the PID check rather than pass.
  test("an acknowledged but ineffective restart fails the PID check", async () => {
    shape = "plugin-live";
    const { impl } = opsFetch({ restartWithoutEffect: true });
    const result = await refreshMcpOAuthFlag(base(), { fetchImpl: impl, ...FAST });
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("verify-restart");
    expect(result.steps.find((s) => s.step === "verify-restart")?.ok).not.toBe(true);
  });
});
