/**
 * credential-lifecycle-contention-2333.test.ts — REAL Harper (flair#2333 slice 2).
 *
 * A credential's lifecycle writes must not undo a revocation that committed
 * first:
 *
 *   - OAuth refresh vs revoke (resources/OAuth.ts). A rotation reads the
 *     refresh token, then — under a per-token lock it shares with a revoke of
 *     that token — takes its single-use claim, re-reads the committed row,
 *     writes the old row and issues a new pair. A revoke of the same token
 *     takes that same lock before it records `revokedAt`, so the two are
 *     serialized within one Harper process:
 *       - `oauth-refresh-pre-claim` holds the rotation between its read and
 *         its claim while a revoke commits. The rotation then takes the lock,
 *         finds the token's claim already recorded, is REFUSED, and issues no
 *         pair.
 *       - `oauth-refresh-mid-claim` holds the rotation between its claim and
 *         its committed-row re-read while a write of `revokedAt` that takes
 *         neither the token lock nor the claim commits (the claim is already
 *         recorded, so it cannot be what refuses the rotation). The re-read
 *         finds the row revoked and REFUSES the rotation: a committed revoke
 *         is not outrun.
 *       - `oauth-refresh-post-claim` holds the rotation after its claim and
 *         committed-row re-read, between that re-read and its issuance, while a
 *         revoke tries to commit. The revoke cannot take the lock the rotation
 *         holds, so the rotation — the lock holder — issues its pair and the
 *         revoke returns 503 with `temporarily_unavailable` and
 *         `token_lifecycle_in_progress`.
 *       - `oauth-refresh-claim-done` holds the rotation after its token lock has
 *         released (its writes committed) but before this request's own
 *         transaction commits, while a second request looks at the token. The
 *         committed revocation is visible; a write left in the request
 *         transaction would not be.
 *     A control rotation with no competing revoke still succeeds.
 *
 *   - XAA credential touch vs revoke/delete (resources/XAA.ts). A jwt-bearer
 *     grant reads the matched IdP credential and touches its `lastUsedAt`. A
 *     matched credential whose status is not "active" is refused by name and
 *     nothing is written. Each contended case holds the touch between its read
 *     and its write (the test-only pause point `xaa-credential-touch`) while the
 *     credential is revoked (status -> "revoked"), deleted, or re-pointed at a
 *     different principal, then releases it: the committed-row confirmation
 *     refuses the grant and aborts the touch, so the credential keeps the
 *     committed revoke / delete / re-point and the case asserts the stored row
 *     and that no token was issued.
 *
 * The pause points are resources/txn-pause-point.ts, armed through
 * FLAIR_ENABLE_TEST_FAULT_INJECTION / FLAIR_TEST_PAUSE_DIR, set for this file's
 * Harper only. The control cases exercise the ordinary, uncontended path: a
 * rotation still exchanges, and an active credential still records `lastUsedAt`.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";

// A production Flair's HTTP and ops API ports: this test must never target them.
const FORBIDDEN_PORTS = new Set([9925, 9926]);
const IDP_ISSUER = "https://idp.cred-lifecycle-2333.invalid";
const IDP_ID = "idp-cred-lifecycle-2333";
const IDP_CLIENT = "cred-lifecycle-2333-client";

let harper: HarperInstance;
let pauseDir: string;
let jwksServer: Server;
let signingKey: any;
let kid: string;
let audience: string;

function assertOwnInstance(h: HarperInstance): void {
  const http = new URL(h.httpURL);
  const ops = new URL(h.opsURL);
  for (const u of [http, ops]) {
    const port = Number(u.port);
    if (u.hostname !== "127.0.0.1" || !(port > 0) || FORBIDDEN_PORTS.has(port)) {
      throw new Error(`refusing to run against ${u.href}: not this test's ephemeral instance`);
    }
  }
  if (http.port === ops.port || !h.process?.pid || !h.installDir.startsWith(tmpdir())) {
    throw new Error(`refusing to run: ${h.httpURL} / ${h.opsURL} is not an instance this test started`);
  }
}

async function ops(op: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`) },
    body: JSON.stringify(op),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  expect(res.status, `${op.operation} on ${op.table}: ${text.slice(0, 300)}`).toBe(200);
  return text.length > 0 ? JSON.parse(text) : undefined;
}

async function readRow(table: string, id: string): Promise<any> {
  const rows = await ops({
    operation: "search_by_value", database: "flair", table,
    search_attribute: "id", search_type: "equals", search_value: id, get_attributes: ["*"],
  });
  return Array.isArray(rows) ? (rows[0] ?? null) : null;
}

async function readTokenByHash(tokenHash: string): Promise<any> {
  const rows = await ops({
    operation: "search_by_value", database: "flair", table: "OAuthToken",
    search_attribute: "tokenHash", search_type: "equals", search_value: tokenHash, get_attributes: ["*"],
  });
  return Array.isArray(rows) ? (rows[0] ?? null) : null;
}

/** Every OAuthToken row issued to `principalId` (an empty array when none was). */
async function readTokensForPrincipal(principalId: string): Promise<any[]> {
  const rows = await ops({
    operation: "search_by_value", database: "flair", table: "OAuthToken",
    search_attribute: "principalId", search_type: "equals", search_value: principalId, get_attributes: ["id"],
  });
  return Array.isArray(rows) ? rows : [];
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${harper.httpURL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
}

function pointsFor(point: string) {
  return {
    arm: join(pauseDir, `arm.${point}`),
    paused: join(pauseDir, `paused.${point}`),
    released: join(pauseDir, `released.${point}`),
    go: join(pauseDir, `go.${point}`),
  };
}

async function waitFor(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/**
 * Arm `point`, start `trigger`, once it is paused at that point run `compete`,
 * then release it and await the trigger. Returns the trigger's response and
 * whether the pause actually armed (so a case cannot pass vacuously).
 */
async function withPaused<T>(point: string, trigger: () => Promise<Response>, compete: () => Promise<T>) {
  const p = pointsFor(point);
  for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${point}`), { force: true });
  writeFileSync(p.arm, "");
  const pending = trigger();
  const paused = await waitFor(p.paused, 15_000);
  let competed: T | undefined;
  try {
    if (paused) competed = await compete();
  } finally {
    writeFileSync(p.go, "");
  }
  const response = await pending;
  const released = paused ? readFileSync(p.released, "utf8") : "never paused";
  return { response, competed, released };
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function futureISO(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

/** A refresh token row, with a raw token whose SHA-256 is stored (never the token). */
async function seedRefreshToken(clientId: string, principalId: string): Promise<string> {
  const raw = `flair_rt_${randomBytes(24).toString("base64url")}`;
  await ops({
    operation: "insert", database: "flair", table: "OAuthToken",
    records: [{
      id: `rt_${randomBytes(8).toString("hex")}`,
      tokenHash: sha256Hex(raw),
      tokenType: "refresh",
      clientId, principalId, scope: "memory:read",
      expiresAt: futureISO(7 * 86400_000),
      createdAt: new Date().toISOString(),
    }],
  });
  return raw;
}

async function jwtBearerAssertion(subject: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ scope: "memory:read" })
    .setProtectedHeader({ alg: "ES256", kid })
    .setIssuer(IDP_ISSUER)
    .setSubject(subject)
    .setAudience(audience)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(signingKey);
}

function grantJwtBearer(assertion: string): Promise<Response> {
  return postJson("/OAuthToken", { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion });
}

beforeAll(async () => {
  pauseDir = mkdtempSync(join(tmpdir(), "flair-cred-2333-pause-"));
  const saved = {
    FLAIR_ENABLE_TEST_FAULT_INJECTION: process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION,
    FLAIR_TEST_PAUSE_DIR: process.env.FLAIR_TEST_PAUSE_DIR,
  };
  process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION = "1";
  process.env.FLAIR_TEST_PAUSE_DIR = pauseDir;
  try {
    harper = await startHarper();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assertOwnInstance(harper);

  // A test IdP: an ephemeral loopback JWKS server, and an IdpConfig row that
  // points at it. The audience is the address the grant validates against.
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  signingKey = privateKey;
  kid = `k-${randomUUID()}`;
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: "ES256", use: "sig" };
  const body = JSON.stringify({ keys: [jwk] });
  jwksServer = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    jwksServer.once("error", reject);
    jwksServer.listen(0, "127.0.0.1", () => resolve());
  });
  jwksServer.unref();
  const addr = jwksServer.address();
  if (addr === null || typeof addr === "string" || addr.address !== "127.0.0.1" || FORBIDDEN_PORTS.has(addr.port)) {
    throw new Error(`JWKS server bound ${JSON.stringify(addr)}, not an ephemeral loopback port`);
  }
  audience = harper.httpURL;
  if (FORBIDDEN_PORTS.has(Number(new URL(audience).port))) throw new Error(`audience ${audience} names a production port`);

  await ops({
    operation: "insert", database: "flair", table: "IdpConfig",
    records: [{
      id: IDP_ID, name: "cred-lifecycle-2333", issuer: IDP_ISSUER,
      jwksUri: `http://127.0.0.1:${addr.port}/jwks`, clientId: IDP_CLIENT,
      jitProvision: true, defaultTrustTier: "unverified", enabled: true,
      createdAt: new Date().toISOString(),
    }],
  });
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (jwksServer) jwksServer.close();
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
});

describe("flair#2333 slice 2 — credential lifecycle writes preserve committed revocations within one Harper process (real Harper)", () => {
  // ── OAuth refresh vs revoke ────────────────────────────────────────────────

  it("CONTROL: an uncontended rotation still exchanges", async () => {
    const raw = await seedRefreshToken("flair_cl_2333_ctl", "agent-2333-ctl");
    const res = await postJson("/OAuthToken", { grant_type: "refresh_token", refresh_token: raw, client_id: "flair_cl_2333_ctl" });
    const text = await res.text();
    expect(res.status, `control refresh returned ${res.status}: ${text.slice(0, 300)}`).toBe(200);
    const body = JSON.parse(text);
    expect(typeof body.access_token).toBe("string");
    expect(typeof body.refresh_token).toBe("string");
  }, 60_000);

  it("a revoked refresh token cannot be rotated", async () => {
    const raw = await seedRefreshToken("flair_cl_2333_rev", "agent-2333-rev");
    const { response, competed, released } = await withPaused(
      "oauth-refresh-pre-claim",
      () => postJson("/OAuthToken", { grant_type: "refresh_token", refresh_token: raw, client_id: "flair_cl_2333_rev" }),
      () => postJson("/OAuthRevoke", { token: raw }).then((r) => r.status),
    );
    expect(released, "the rotation was not paused and released by this test").toBe("go");
    expect(competed, "the competing revoke did not return 200").toBe(200);
    const text = await response.text();
    expect(response.status, `rotation after a committed revoke returned ${response.status}: ${text.slice(0, 300)}`).toBe(400);
    const body = JSON.parse(text);
    expect(body.error).toBe("invalid_grant");
    expect(body.access_token).toBeUndefined();
  }, 60_000);

  it("within one Harper process, a rotation holding the lock issues a pair and the competing revoke returns 503", async () => {
    const raw = await seedRefreshToken("flair_cl_2333_post", "agent-2333-post");
    const { response, competed, released } = await withPaused(
      "oauth-refresh-post-claim",
      () => postJson("/OAuthToken", { grant_type: "refresh_token", refresh_token: raw, client_id: "flair_cl_2333_post" }),
      async () => {
        const res = await postJson("/OAuthRevoke", { token: raw });
        return { status: res.status, body: await res.json() };
      },
    );
    const text = await response.text();
    expect(released, "the rotation was not paused and released by this test").toBe("go");
    expect(response.status, `rotation returned ${response.status}: ${text.slice(0, 300)}`).toBe(200);
    const body = JSON.parse(text);
    expect(typeof body.access_token).toBe("string");
    expect(typeof body.refresh_token).toBe("string");
    expect(competed).toEqual({
      status: 503,
      body: {
        error: "temporarily_unavailable",
        error_description: "token_lifecycle_in_progress",
      },
    });
    const old = await readTokenByHash(sha256Hex(raw));
    expect(old?.revokedAt, "the rotation issued a pair but left the presented token unrevoked").toBeTruthy();
  }, 60_000);

  it("a revoke that commits between the rotation's claim and its committed-row re-read refuses the rotation", async () => {
    const raw = await seedRefreshToken("flair_cl_2333_mid", "agent-2333-mid");
    const row = await readTokenByHash(sha256Hex(raw));
    expect(row, "the seeded refresh token is readable").not.toBeNull();
    const { response, competed, released } = await withPaused(
      "oauth-refresh-mid-claim",
      () => postJson("/OAuthToken", { grant_type: "refresh_token", refresh_token: raw, client_id: "flair_cl_2333_mid" }),
      // A revoke that writes `revokedAt` on the row directly — it takes neither
      // the token lock nor the single-use claim, so the claim the rotation has
      // already recorded cannot be what refuses it. Only the committed-row
      // re-read can. Commit it, and wait until the row is observably revoked
      // before releasing the rotation.
      async () => {
        await ops({
          operation: "update", database: "flair", table: "OAuthToken",
          records: [{ id: row.id, revokedAt: new Date().toISOString() }],
        });
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          if ((await readTokenByHash(sha256Hex(raw)))?.revokedAt) return 200;
          await new Promise((r) => setTimeout(r, 25));
        }
        throw new Error("the direct revoke's revokedAt did not commit");
      },
    );
    expect(released, "the rotation was not paused and released by this test").toBe("go");
    expect(competed, "the competing revoke did not commit").toBe(200);
    const text = await response.text();
    expect(
      response.status,
      `rotation after a revoke committed between its claim and its re-read returned ${response.status}: ${text.slice(0, 300)}`,
    ).toBe(400);
    const body = JSON.parse(text);
    expect(body.error).toBe("invalid_grant");
    expect(body.access_token).toBeUndefined();
    const old = await readTokenByHash(sha256Hex(raw));
    expect(old?.revokedAt, "the committed revoke is recorded").toBeTruthy();
  }, 60_000);

  it("the rotation's writes commit before its lock releases: a look at the token right after release sees it revoked", async () => {
    const raw = await seedRefreshToken("flair_cl_2333_done", "agent-2333-done");
    const { response, competed, released } = await withPaused(
      "oauth-refresh-claim-done",
      () => postJson("/OAuthToken", { grant_type: "refresh_token", refresh_token: raw, client_id: "flair_cl_2333_done" }),
      // A second request looks at the token while the rotation has released its
      // lock but before this request's own transaction commits (Harper commits
      // it when the handler returns). With the rotation's writes committed under
      // the lock it reads the row revoked; a write left in the request
      // transaction would still be invisible here.
      async () => ((await readTokenByHash(sha256Hex(raw)))?.revokedAt ? 200 : 500),
    );
    expect(released, "the rotation was not paused and released by this test").toBe("go");
    const text = await response.text();
    const body = response.status === 200 ? JSON.parse(text) : undefined;
    expect(response.status, `the rotation returned ${response.status}: ${text.slice(0, 300)}`).toBe(200);
    expect(typeof body?.refresh_token).toBe("string");
    expect(competed, "the token was not revoked when the rotation released its lock: its writes had not committed").toBe(200);
  }, 60_000);

  // ── XAA credential touch vs revoke / delete ────────────────────────────────

  it("CONTROL: an uncontended credential touch still records lastUsedAt", async () => {
    const subject = `user-ctl-${randomUUID()}`;
    const principalId = `agent-2333-ctl-${randomUUID().slice(0, 8)}`;
    const credentialId = `cred_idp_ctl_${randomUUID().slice(0, 8)}`;
    await ops({
      operation: "insert", database: "flair", table: "Credential",
      records: [{ id: credentialId, principalId, kind: "idp", label: "ctrl", status: "active", idpProvider: IDP_ID, idpSubject: subject, createdAt: new Date().toISOString() }],
    });
    const res = await grantJwtBearer(await jwtBearerAssertion(subject));
    const text = await res.text();
    expect(res.status, `control grant returned ${res.status}: ${text.slice(0, 300)}`).toBe(200);
    const row = await readRow("Credential", credentialId);
    expect(row, "the touched credential survived").not.toBeNull();
    expect(typeof row.lastUsedAt, "the control touch recorded lastUsedAt").toBe("string");
  }, 60_000);

  it("an already-revoked credential is refused by name, issues no token, and its lastUsedAt is untouched", async () => {
    const subject = `user-already-${randomUUID()}`;
    const principalId = `agent-2333-already-${randomUUID().slice(0, 8)}`;
    const credentialId = `cred_idp_already_${randomUUID().slice(0, 8)}`;
    const lastUsedAt = "2020-01-02T03:04:05.000Z";
    await ops({
      operation: "insert", database: "flair", table: "Credential",
      records: [{ id: credentialId, principalId, kind: "idp", label: "already", status: "revoked", idpProvider: IDP_ID, idpSubject: subject, createdAt: new Date().toISOString(), lastUsedAt }],
    });
    const res = await grantJwtBearer(await jwtBearerAssertion(subject));
    const text = await res.text();
    expect(res.status, `grant returned ${res.status}: ${text.slice(0, 300)}`).toBe(400);
    const body = JSON.parse(text);
    expect(body.error).toBe("invalid_grant");
    expect(body.error_description, "the refusal does not name the credential's non-active status").toContain('"revoked"');
    expect(body.access_token).toBeUndefined();
    expect(await readTokensForPrincipal(principalId), "the refused grant issued a token").toEqual([]);
    const row = await readRow("Credential", credentialId);
    expect(row?.status, "the stored status changed").toBe("revoked");
    expect(row?.lastUsedAt, "the refused grant touched lastUsedAt").toBe(lastUsedAt);
  }, 60_000);

  it("a credential re-pointed at another principal while the touch is held refuses the grant", async () => {
    const subject = `user-repl-${randomUUID()}`;
    const principalId = `agent-2333-repl-${randomUUID().slice(0, 8)}`;
    const otherPrincipalId = `agent-2333-other-${randomUUID().slice(0, 8)}`;
    const credentialId = `cred_idp_repl_${randomUUID().slice(0, 8)}`;
    await ops({
      operation: "insert", database: "flair", table: "Credential",
      records: [{ id: credentialId, principalId, kind: "idp", label: "repl", status: "active", idpProvider: IDP_ID, idpSubject: subject, createdAt: new Date().toISOString() }],
    });
    const assertion = await jwtBearerAssertion(subject);
    const { response, competed, released } = await withPaused(
      "xaa-credential-touch",
      () => grantJwtBearer(assertion),
      () => ops({ operation: "update", database: "flair", table: "Credential", records: [{ id: credentialId, principalId: otherPrincipalId }] }).then(() => 200),
    );
    expect(released, "the credential touch was not paused and released by this test").toBe("go");
    expect(competed, "the competing re-point did not return 200").toBe(200);
    const text = await response.text();
    expect(response.status, `grant returned ${response.status}: ${text.slice(0, 300)}`).toBe(400);
    const body = JSON.parse(text);
    expect(body.error).toBe("invalid_grant");
    expect(body.access_token).toBeUndefined();
    expect(await readTokensForPrincipal(principalId), "the refused grant issued a token").toEqual([]);
    expect(await readTokensForPrincipal(otherPrincipalId), "the refused grant issued a token").toEqual([]);
    const row = await readRow("Credential", credentialId);
    expect(row?.principalId, "the stored row is not the committed re-point").toBe(otherPrincipalId);
  }, 60_000);

  it("a revoke committed while the credential touch is held refuses the grant", async () => {
    const subject = `user-rev-${randomUUID()}`;
    const principalId = `agent-2333-rev-${randomUUID().slice(0, 8)}`;
    const credentialId = `cred_idp_rev_${randomUUID().slice(0, 8)}`;
    await ops({
      operation: "insert", database: "flair", table: "Credential",
      records: [{ id: credentialId, principalId, kind: "idp", label: "rev", status: "active", idpProvider: IDP_ID, idpSubject: subject, createdAt: new Date().toISOString() }],
    });
    const assertion = await jwtBearerAssertion(subject);
    const { response, competed, released } = await withPaused(
      "xaa-credential-touch",
      () => grantJwtBearer(assertion),
      () => ops({ operation: "update", database: "flair", table: "Credential", records: [{ id: credentialId, status: "revoked" }] }).then(() => 200),
    );
    expect(released, "the credential touch was not paused and released by this test").toBe("go");
    expect(competed, "the competing revoke did not return 200").toBe(200);
    const text = await response.text();
    expect(response.status, `grant returned ${response.status}: ${text.slice(0, 300)}`).toBe(400);
    const body = JSON.parse(text);
    expect(body.error).toBe("invalid_grant");
    expect(body.access_token).toBeUndefined();
    expect(await readTokensForPrincipal(principalId), "the refused grant issued a token").toEqual([]);
    const row = await readRow("Credential", credentialId);
    expect(row, "the revoked credential survived").not.toBeNull();
    expect(row.status, "the stored credential is not the committed revoke").toBe("revoked");
  }, 60_000);

  it("a delete committed while the credential touch is held refuses the grant", async () => {
    const subject = `user-del-${randomUUID()}`;
    const principalId = `agent-2333-del-${randomUUID().slice(0, 8)}`;
    const credentialId = `cred_idp_del_${randomUUID().slice(0, 8)}`;
    await ops({
      operation: "insert", database: "flair", table: "Credential",
      records: [{ id: credentialId, principalId, kind: "idp", label: "del", status: "active", idpProvider: IDP_ID, idpSubject: subject, createdAt: new Date().toISOString() }],
    });
    const assertion = await jwtBearerAssertion(subject);
    const { response, competed, released } = await withPaused(
      "xaa-credential-touch",
      () => grantJwtBearer(assertion),
      () => ops({ operation: "delete", database: "flair", table: "Credential", ids: [credentialId] }).then(() => 200),
    );
    expect(released, "the credential touch was not paused and released by this test").toBe("go");
    expect(competed, "the competing delete did not return 200").toBe(200);
    const text = await response.text();
    expect(response.status, `grant returned ${response.status}: ${text.slice(0, 300)}`).toBe(400);
    const body = JSON.parse(text);
    expect(body.error).toBe("invalid_grant");
    expect(body.access_token).toBeUndefined();
    expect(await readTokensForPrincipal(principalId), "the refused grant issued a token").toEqual([]);
    const row = await readRow("Credential", credentialId);
    expect(row, "the stored row is not the committed delete").toBeNull();
  }, 60_000);
});
