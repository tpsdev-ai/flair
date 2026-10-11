/**
 * mcp-refresh-flag-2283.test.ts — flair#2283 item 2.
 *
 * `flair mcp enable --refresh-flag` is the one-shot migration for an instance
 * enabled before 0.46.0 that still holds `FLAIR_MCP_OAUTH=1` — a value the
 * `@harperfast/oauth` component deletes, leaving its authorization server
 * unmounted. The flag sets that ONE variable to `true` in the target's process
 * environment (the env-secrets primitive), restarts, and confirms the MCP
 * authorization server answers, without re-running the IdP credentials or the
 * identity mapping.
 *
 * These drive `refreshMcpOAuthFlag` with an injected fetch: ops calls go to a
 * stub (a real RSA public key, so the value is sealed through the real
 * `pushSecrets` path), and the discovery read is delegated to a REAL HTTP
 * server that answers each document shape on the wire.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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

/** An ops-API stub + a delegating fetch. `disablePush` makes the capability probe fail. */
function opsFetch(opts: { disablePush?: boolean } = {}) {
  const sent: any[] = [];
  let pid = 100;
  const impl = (async (input: any, init: any) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    // The discovery read goes to the REAL server; everything else is the ops stub.
    if (url.pathname === "/.well-known/oauth-authorization-server") {
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
    if (op === "system_information") return Response.json({ harperdb_processes: { core: [{ pid: pid++ }] } });
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
  test("pushes FLAIR_MCP_OAUTH=true, restarts, and confirms the MCP AS is live", async () => {
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

  test("refuses a success claim when the AS still does not answer", async () => {
    shape = "plugin-absent";
    const { impl } = opsFetch();
    const result = await refreshMcpOAuthFlag(base(), { fetchImpl: impl, ...FAST });
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("self-verify");
    expect(result.steps.find((s) => s.step === "self-verify")?.detail).toContain("FLAIR_MCP_OAUTH is set but the MCP authorization server is absent");
  });

  test("a target that cannot take a pushed secret leaves the staged file and names it", async () => {
    shape = "plugin-live";
    const { impl } = opsFetch({ disablePush: true });
    const result = await refreshMcpOAuthFlag(base(), { fetchImpl: impl, ...FAST });
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("secrets-provisioning");
    expect(result.steps.find((s) => s.step === "secrets-provisioning")?.detail).toContain(base().secretsStagingPath);
  });

  test("--dry-run makes no remote call", async () => {
    const { impl, sent } = opsFetch();
    const result = await refreshMcpOAuthFlag({ ...base(), dryRun: true }, { fetchImpl: impl, ...FAST });
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(sent).toEqual([]);
  });
});
