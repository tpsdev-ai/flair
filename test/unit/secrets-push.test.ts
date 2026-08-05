// flair#1094 — the capability probe that replaced hostname sniffing.
//
// The rule being tested: a target's ABILITY decides the mechanism, never its
// name and never its version. Both of the old shortcuts were wrong on the day
// this was written:
//
//   tps.dtrt.harperfabric.com  Harper 5.1.26, no secrets operations, and it was
//                              selected for the AUTOMATED path by hostname
//   self-hosted Harper 5.2     fully capable, sent down the MANUAL path because
//                              its hostname did not end in .harperfabric.com
//
// Measured, not hypothesised: `set_secret` on tps.dtrt answers "Operation
// 'set_secret' not found" — byte-identical to the answer for an operation that
// was invented for the control.
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, privateDecrypt, createDecipheriv, constants } from "node:crypto";
import { probeSecretsCapability, pushSecrets, PROCESS_ENV_TIER } from "../../src/lib/secrets-push.js";
import { ENV_ENCRYPTED_PREFIX } from "../../src/lib/secret-envelope.js";

const { publicKey: PUB, privateKey: PRIV } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

/** A fetch stand-in that answers per-operation and records what it was sent. */
function opsStub(handler: (op: string, body: any) => { status?: number; json: any }) {
  const sent: any[] = [];
  const impl = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    sent.push(body);
    const { status = 200, json } = handler(body.operation, body);
    return new Response(JSON.stringify(json), { status });
  }) as unknown as typeof fetch;
  return { impl, sent };
}

describe("probeSecretsCapability — asks the target, never its hostname", () => {
  test("available when the target returns a usable public key", async () => {
    const { impl } = opsStub(() => ({ json: { public_key: PUB } }));
    const cap = await probeSecretsCapability("https://x/", "Basic y", { fetchImpl: impl });
    expect(cap.available).toBe(true);
    expect(cap.publicKeyPem).toContain("BEGIN PUBLIC KEY");
  });

  test("unavailable, and says WHY, on the real 5.1.26 answer", async () => {
    // Verbatim from tps.dtrt.harperfabric.com:9925 on 2026-08-04.
    const { impl } = opsStub(() => ({ status: 400, json: { error: "Operation 'get_secrets_public_key' not found" } }));
    const cap = await probeSecretsCapability("https://x/", "Basic y", { fetchImpl: impl });
    expect(cap.available).toBe(false);
    expect(cap.reason).toMatch(/5\.2 or newer/);
    expect(cap.reason).toMatch(/staged-file/);
  });

  test("a .harperfabric.com hostname does not make it available", async () => {
    // The regression that motivated this whole module: the old selector would
    // have chosen the automated mechanism here purely on the name.
    const { impl } = opsStub(() => ({ status: 400, json: { error: "Operation 'get_secrets_public_key' not found" } }));
    const cap = await probeSecretsCapability("https://tps.dtrt.harperfabric.com:9925/", "Basic y", { fetchImpl: impl });
    expect(cap.available).toBe(false);
  });

  test("a non-Fabric hostname does not make it unavailable", async () => {
    // The other direction, equally wrong under the old selector.
    const { impl } = opsStub(() => ({ json: { public_key: PUB } }));
    const cap = await probeSecretsCapability("https://harper.internal.example:9925/", "Basic y", { fetchImpl: impl });
    expect(cap.available).toBe(true);
  });

  test("an unreachable target falls back rather than throwing", async () => {
    const impl = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const cap = await probeSecretsCapability("https://x/", "Basic y", { fetchImpl: impl });
    expect(cap.available).toBe(false);
    expect(cap.reason).toMatch(/ECONNREFUSED/);
  });

  test("an answer without a key is treated as unavailable, not as success", async () => {
    // Undeterminable and unavailable get the same treatment on purpose: the
    // fallback costs a paste, a wrong push costs a silent flag-OFF boot.
    const { impl } = opsStub(() => ({ json: { ok: true } }));
    const cap = await probeSecretsCapability("https://x/", "Basic y", { fetchImpl: impl });
    expect(cap.available).toBe(false);
    expect(cap.reason).toMatch(/without a usable public key/);
  });

  test("a 403 falls back and reports the status", async () => {
    const { impl } = opsStub(() => ({ status: 403, json: { error: "forbidden" } }));
    const cap = await probeSecretsCapability("https://x/", "Basic y", { fetchImpl: impl });
    expect(cap.available).toBe(false);
    expect(cap.reason).toMatch(/403/);
  });
});

describe("pushSecrets — plaintext never leaves this process", () => {
  test("each var is sent sealed, at the processEnv tier, and decrypts to its value", async () => {
    const { impl, sent } = opsStub(() => ({ json: { ok: true } }));
    const vars = { FLAIR_MCP_OAUTH: "1", FLAIR_MCP_SIGNING_KEY: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----" };
    const out = await pushSecrets("https://x/", "Basic y", vars, PUB, { fetchImpl: impl });
    expect(out.allOk).toBe(true);
    expect(sent.length).toBe(2);

    for (const req of sent) {
      expect(req.operation).toBe("set_secret");
      expect(req.tier).toBe(PROCESS_ENV_TIER);
      // The value must NOT be present in plaintext anywhere in the request.
      expect(JSON.stringify(req)).not.toContain("BEGIN PRIVATE KEY");
      expect(req.value).toBeUndefined();
      expect(String(req.envelope).startsWith(ENV_ENCRYPTED_PREFIX)).toBe(true);

      // And it must genuinely decrypt back — sealed-but-wrong is the failure
      // that would otherwise pass every assertion above.
      const env = JSON.parse(Buffer.from(String(req.envelope).slice(ENV_ENCRYPTED_PREFIX.length), "base64url").toString("utf8"));
      const aes = privateDecrypt({ key: PRIV, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(env.k, "base64"));
      const d = createDecipheriv("aes-256-gcm", aes, Buffer.from(env.iv, "base64"));
      d.setAuthTag(Buffer.from(env.tag, "base64"));
      const plain = Buffer.concat([d.update(Buffer.from(env.ct, "base64")), d.final()]).toString("utf8");
      expect(Object.values(vars)).toContain(plain);
    }
  });

  test("a per-secret failure is reported by NAME without leaking the value", async () => {
    const { impl } = opsStub((_op, body) => body.name === "BAD"
      ? { status: 500, json: { error: "boom" } }
      : { json: { ok: true } });
    const out = await pushSecrets("https://x/", "Basic y", { GOOD: "g", BAD: "sensitive-value" }, PUB, { fetchImpl: impl });
    expect(out.allOk).toBe(false);
    const bad = out.results.find((r) => r.name === "BAD")!;
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(out.results)).not.toContain("sensitive-value");
  });

  test("a thrown request is captured per-secret rather than aborting the rest", async () => {
    let n = 0;
    const impl = (async () => { if (++n === 1) throw new Error("socket hang up"); return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
    const out = await pushSecrets("https://x/", "Basic y", { A: "1", B: "2" }, PUB, { fetchImpl: impl });
    expect(out.results.length).toBe(2);
    expect(out.allOk).toBe(false);
  });
});

// ─── The guarantee the secrets push leans on ────────────────────────────────
//
// probeSecretsCapability establishes that a target ACCEPTS secrets. It cannot
// establish that they are DECRYPTED — nothing read-only can, since a secret only
// proves it was decrypted by being present in the process.
//
// So the push's safety argument is: a secret that lands in `hdb_secret` and is
// never decrypted fails at SELF-VERIFY rather than passing quietly.
//
// I originally justified that with "the OAuth metadata is only served once
// FLAIR_MCP_OAUTH is live." THAT IS FALSE, and checking it is how this test
// exists. `makeWellKnownHandler` serves flair's OWN discovery document when the
// flag is off — the endpoint answers either way. What actually catches it is a
// DISCRIMINATOR: self-verify compares `token_endpoint` against
// `<issuer>/OAuthToken`, which is exactly what flair's fallback advertises.
//
// That relationship spans two files and nothing compared them:
//
//   resources/oauth-discovery.ts   token_endpoint: `${baseUrl}/OAuthToken`
//   src/lib/mcp-enable.ts          if (body.token_endpoint === `${issuer}/OAuthToken`)
//
// Change either and self-verify silently stops recognising a flag-off instance —
// and the secrets push loses the only thing standing between "stored" and
// "working". This pins them together behaviourally.
import { selfVerifyMcpMetadata } from "../../src/lib/mcp-enable.js";
import { buildAuthorizationServerMetadata } from "../../resources/oauth-discovery.js";

describe("self-verify recognises a flag-OFF instance — the secrets push depends on it", () => {
  const ISSUER = "https://flair.example.com";

  function servingDoc(doc: unknown): typeof fetch {
    return (async () => new Response(JSON.stringify(doc), {
      status: 200, headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
  }

  test("flair's OWN fallback document is detected, not accepted", async () => {
    // The real builder, not a hand-written imitation — an imitation would keep
    // passing after the real one drifted, which is the failure being prevented.
    const fallback = buildAuthorizationServerMetadata(ISSUER);
    const res = await selfVerifyMcpMetadata(ISSUER, { fetchImpl: servingDoc(fallback) });
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/FLAIR_MCP_OAUTH/);
  });

  test("the discriminator value is what the fallback actually advertises", () => {
    // If this drifts, the test above starts passing for the wrong reason.
    const fallback = buildAuthorizationServerMetadata(ISSUER) as any;
    expect(fallback.token_endpoint).toBe(`${ISSUER}/OAuthToken`);
  });

  test("a genuine MCP document is accepted (positive control)", async () => {
    // Without this, a self-verify that rejected EVERYTHING would satisfy the
    // test above while breaking every successful enable.
    const mcpDoc = {
      issuer: ISSUER,
      registration_endpoint: `${ISSUER}/oauth/mcp/register`,
      token_endpoint: `${ISSUER}/oauth/mcp/token`,
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
    };
    const res = await selfVerifyMcpMetadata(ISSUER, { fetchImpl: servingDoc(mcpDoc) });
    expect(res.detail ?? "").not.toMatch(/flair's OWN OAuth/);
  });
});
