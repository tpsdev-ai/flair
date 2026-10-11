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
 *     serialized:
 *       - `oauth-refresh-pre-claim` holds the rotation between its read and
 *         its claim while a revoke commits. The rotation then takes the lock,
 *         finds the token's claim already recorded, is REFUSED, and issues no
 *         pair.
 *       - `oauth-refresh-post-claim` holds the rotation after its claim and
 *         committed-row re-read, between that re-read and its issuance, while a
 *         revoke tries to commit. The revoke cannot take the lock the rotation
 *         holds, so the rotation — the lock holder — issues its pair and the
 *         revoke is refused: a committed revoke and an issued pair do not both
 *         hold.
 *     A control rotation with no competing revoke still succeeds.
 *
 *   - XAA credential touch vs revoke/delete (resources/XAA.ts). A successful
 *     jwt-bearer grant touches the matched IdP credential's `lastUsedAt`. Each
 *     case holds the touch between its read and its write (the test-only pause
 *     point `xaa-credential-touch`) while the credential is revoked (status ->
 *     "revoked") or deleted, then releases it: the credential stays revoked /
 *     stays deleted, and the case asserts the stored row. The grant still issues
 *     its tokens. (Measured: the touch's write does not overwrite the committed
 *     revoke/delete, so the stored row is what the competing write left.)
 *
 * The pause points are resources/txn-pause-point.ts, armed through
 * FLAIR_ENABLE_TEST_FAULT_INJECTION / FLAIR_TEST_PAUSE_DIR, set for this file's
 * Harper only. Unchanged rows are the control cases (the ordinary path is
 * unchanged).
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

describe("flair#2333 slice 2 — a later credential lifecycle write does not undo a committed revoke (real Harper)", () => {
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

  it("a revoke running while the rotation is between its re-read and its issuance does not outrun it", async () => {
    const raw = await seedRefreshToken("flair_cl_2333_post", "agent-2333-post");
    const { response, competed, released } = await withPaused(
      "oauth-refresh-post-claim",
      () => postJson("/OAuthToken", { grant_type: "refresh_token", refresh_token: raw, client_id: "flair_cl_2333_post" }),
      () => postJson("/OAuthRevoke", { token: raw }).then((r) => r.status),
    );
    const text = await response.text();
    expect(released, "the rotation was not paused and released by this test").toBe("go");
    const body = response.status === 200 ? JSON.parse(text) : undefined;
    const rotationIssuedPair = typeof body?.access_token === "string";
    const revokeCommitted = competed === 200;
    // The rotation holds the token lock between its committed-row re-read and
    // its issuance, so a revoke cannot commit there. Its two interleavings are:
    // the revoke is refused and the rotation issues, or the rotation is refused,
    // and never both a committed revoke and a usable pair. (Removing the lock
    // from the rotation and the revoke, and keeping this pause point, makes the
    // revoke commit here and the rotation issue anyway — this case fails.)
    expect(
      revokeCommitted && rotationIssuedPair,
      `a usable pair was issued after a committed revoke (revoke ${competed}, rotation ${response.status}): the revoke was outrun`,
    ).toBe(false);
    if (rotationIssuedPair) {
      const old = await readTokenByHash(sha256Hex(raw));
      expect(old?.revokedAt, "the rotation issued a pair but left the presented token unrevoked").toBeTruthy();
    }
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

  it("a revoked credential stays revoked", async () => {
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
    expect(response.status, `grant returned ${response.status}: ${text.slice(0, 300)}`).toBe(200);
    const row = await readRow("Credential", credentialId);
    expect(row, "the revoked credential survived").not.toBeNull();
    expect(row.status, "the stored credential is not the committed revoke").toBe("revoked");
  }, 60_000);

  it("a deleted credential stays deleted", async () => {
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
    expect(response.status, `grant returned ${response.status}: ${text.slice(0, 300)}`).toBe(200);
    const row = await readRow("Credential", credentialId);
    expect(row, "the stored row is not the committed delete").toBeNull();
  }, 60_000);
});
