/**
 * oauth-single-use-2145.test.ts — the single-use record behind the
 * authorization-code and refresh-token grants (flair#2145).
 *
 * OAuthToken (resources/OAuth.ts) claims a redeemed authorization code
 * (`c:<sha256(code)>`) and a rotated refresh token (`r:<sha256(token)>`)
 * through claimOAuthSingleUse (resources/replay-store.ts) — the same
 * lock-then-insert as the agent-auth, federation and XAA jti records
 * (recordOnce) — in flair.OAuthSingleUse. These tests drive the token endpoint's
 * two grants against in-memory OAuth tables and an OAuthSingleUse with the
 * store's contract (test/helpers/fake-replay-store.ts), and pin:
 *   - a code, and a refresh token, is redeemed once: the first request is
 *     accepted, and N simultaneous ones of the same value give exactly one
 *     acceptance and one token pair;
 *   - a store error or a missing store primitive refuses with 503 and issues
 *     nothing;
 *   - the row is written only after the request has validated;
 *   - the key is a SHA-256 in its own lock namespace, the code's row is still
 *     flagged used, and the schema's expiration is the retention the store
 *     needs, which outlives both token lifetimes.
 *
 * Isolated lane: this file stubs `harper` for `databases`, so it must run
 * one-process-per-file (flair#1817). The two-worker proof on a real Harper is
 * test/integration/oauth-single-use-two-workers-2145.test.ts.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createFakeReplayNonceTable,
  ensureGlobalHarperTransaction,
  type FakeReplayNonceTable,
} from "../helpers/fake-replay-store.ts";

// ─── harper mock: the tables the token endpoint touches ─────────────────────

const ALLOWED_REDIRECT_URI = "https://claude.com/api/mcp/auth_callback";

class NoopBase { constructor(_id?: any, _ctx?: any) {} }

function createAuthCodeTable() {
  const rows = new Map<string, any>();
  return {
    rows,
    async get(id: string) {
      const row = rows.get(id);
      return row ? { ...row } : null;
    },
    async put(row: any) {
      rows.set(row.id, { ...row });
    },
  };
}

function createTokenTable() {
  const rows = new Map<string, any>();
  return {
    rows,
    async put(row: any) {
      rows.set(row.id, { ...row });
    },
    async *search({ conditions }: any) {
      for (const row of rows.values()) {
        if (conditions.every((c: any) => row[c.attribute] === c.value)) yield row;
      }
    },
  };
}

const authCodes = createAuthCodeTable();
const tokens = createTokenTable();
let singleUse: FakeReplayNonceTable;

// Every unknown `databases.flair.*` model is a no-op class (XAA.ts extends
// `databases.flair.IdpConfig` at load time); the three tables below answer.
const flairStub: any = new Proxy(
  { OAuthAuthCode: authCodes, OAuthToken: tokens },
  { get: (target: any, prop) => (prop in target ? target[prop] : NoopBase) },
);
mock.module("harper", () => ({
  server: { http: () => {}, getUser: async () => null },
  Resource: NoopBase,
  databases: { flair: flairStub },
}));

const restoreTransaction = ensureGlobalHarperTransaction();

const oauth = await import("../../resources/OAuth.ts");
const rs = await import("../../resources/replay-store.ts");

const REPO = join(import.meta.dir, "..", "..");
const AUTH_CODE_GRANT = "authorization_code";
const REFRESH_GRANT = "refresh_token";
const CLIENT_ID = "flair_cl_2145";
const PRINCIPAL = "agent-2145";
const SCOPE = "memory:read";

// ─── fixtures ──────────────────────────────────────────────────────────────

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

let codeSeq = 0;
let verifier: string;
let codeChallenge: string;

beforeEach(() => {
  authCodes.rows.clear();
  tokens.rows.clear();
  singleUse = createFakeReplayNonceTable();
  singleUse.expirationMS = oauth.OAUTH_SINGLE_USE_RETENTION_S * 1000;
  (flairStub as any).OAuthSingleUse = singleUse;
  verifier = `verifier-${++codeSeq}-${"v".repeat(20)}`;
  codeChallenge = createHash("sha256").update(verifier).digest("base64url");
});

afterAll(() => {
  restoreTransaction();
});

/** Put an authorization code row and return the code. */
function mintCode(over: Record<string, any> = {}): string {
  const code = `code-${++codeSeq}`;
  authCodes.rows.set(code, {
    id: code,
    clientId: CLIENT_ID,
    principalId: PRINCIPAL,
    redirectUri: ALLOWED_REDIRECT_URI,
    scope: SCOPE,
    codeChallenge,
    codeChallengeMethod: "S256",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    used: false,
    createdAt: new Date().toISOString(),
    ...over,
  });
  return code;
}

/** Put a refresh token row and return the raw token. */
function mintRefresh(over: Record<string, any> = {}): string {
  const raw = `flair_rt_${++codeSeq}-${"r".repeat(20)}`;
  tokens.rows.set(`rt_${codeSeq}`, {
    id: `rt_${codeSeq}`,
    tokenHash: sha256(raw),
    tokenType: "refresh",
    clientId: CLIENT_ID,
    principalId: PRINCIPAL,
    scope: SCOPE,
    expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
    createdAt: new Date().toISOString(),
    ...over,
  });
  return raw;
}

function postToken(body: Record<string, any>): Promise<{ status: number; body: any }> {
  const inst: any = new (oauth.OAuthToken as any)();
  return inst.post(body).then(async (r: any) =>
    r instanceof Response ? { status: r.status, body: await r.json() } : { status: 200, body: r },
  );
}

function redeemCode(code: string, over: Record<string, any> = {}) {
  return postToken({
    grant_type: AUTH_CODE_GRANT,
    code,
    client_id: CLIENT_ID,
    redirect_uri: ALLOWED_REDIRECT_URI,
    code_verifier: verifier,
    ...over,
  });
}

function redeemRefresh(raw: string, over: Record<string, any> = {}) {
  return postToken({ grant_type: REFRESH_GRANT, refresh_token: raw, client_id: CLIENT_ID, ...over });
}

const CODE_USED = { status: 400, body: { error: "invalid_grant", error_description: "code already used" } };
const TOKEN_REVOKED = { status: 400, body: { error: "invalid_grant", error_description: "token revoked" } };
const UNAVAILABLE = { status: 503, body: { error: "temporarily_unavailable", error_description: "replay_store_unavailable" } };

/** How many token rows the OAuthToken table holds. */
const tokenRows = () => tokens.rows.size;
/** The single-use record's key for a code / for a refresh token. */
const codeKey = (code: string) => `c:${sha256(code)}`;
const refreshKey = (raw: string) => `r:${sha256(raw)}`;

// ─── one redemption per code ───────────────────────────────────────────────

describe("an authorization code is redeemed once", () => {
  it("the first redemption is accepted, records the code, and flags it used; the next is refused", async () => {
    const code = mintCode();
    const first = await redeemCode(code);
    expect(first.status).toBe(200);
    expect(typeof first.body.access_token).toBe("string");
    expect(typeof first.body.refresh_token).toBe("string");
    expect([...singleUse.rows.keys()]).toEqual([codeKey(code)]); // assertion: the row is keyed by the code's hash
    expect(authCodes.rows.get(code).used).toBe(true); // assertion: the code's own flag is kept
    expect(tokenRows()).toBe(2); // one access + one refresh token
    expect(await redeemCode(code)).toEqual(CODE_USED); // assertion: second redemption refused
    expect(tokenRows()).toBe(2); // assertion: the refused redemption issued nothing
  });

  it("N simultaneous redemptions of one code: exactly one is accepted, and only it issues tokens", async () => {
    for (let round = 0; round < 10; round++) {
      tokens.rows.clear();
      singleUse.rows.clear();
      const code = mintCode();
      const results = await Promise.all(Array.from({ length: 16 }, () => redeemCode(code)));
      expect(results.filter((r) => r.status === 200).length).toBe(1); // assertion: exactly one acceptance
      expect(results.filter((r) => r.status === 400 && r.body.error_description === "code already used").length).toBe(15);
      expect(tokenRows()).toBe(2); // assertion: the refused redemptions issued nothing
    }
  });
});

// ─── one rotation per refresh token ────────────────────────────────────────

describe("a refresh token is rotated once", () => {
  it("the first refresh is accepted, revokes the old token, and issues one pair; the next is refused", async () => {
    const raw = mintRefresh();
    const first = await redeemRefresh(raw);
    expect(first.status).toBe(200);
    expect(typeof first.body.refresh_token).toBe("string");
    expect(first.body.refresh_token).not.toBe(raw); // assertion: a new refresh token
    expect([...singleUse.rows.keys()]).toEqual([refreshKey(raw)]); // assertion: the row is keyed by the token's hash
    expect(typeof [...tokens.rows.values()].find((t) => t.tokenHash === sha256(raw))?.revokedAt).toBe("string"); // assertion: the old token is revoked
    expect(tokenRows()).toBe(3); // the old row + the new access + refresh pair
    expect(await redeemRefresh(raw)).toEqual(TOKEN_REVOKED); // assertion: second use refused
    expect(tokenRows()).toBe(3); // assertion: the refused rotation issued nothing
  });

  it("N simultaneous refreshes of one token: exactly one is accepted, and only it issues a pair", async () => {
    for (let round = 0; round < 10; round++) {
      tokens.rows.clear();
      singleUse.rows.clear();
      const raw = mintRefresh();
      const results = await Promise.all(Array.from({ length: 16 }, () => redeemRefresh(raw)));
      expect(results.filter((r) => r.status === 200).length).toBe(1); // assertion: exactly one acceptance
      expect(results.filter((r) => r.status === 400 && r.body.error_description === "token revoked").length).toBe(15);
      expect(tokenRows()).toBe(3); // assertion: the refused rotations issued nothing
    }
  });
});

// ─── fail closed ───────────────────────────────────────────────────────────

describe("a store error refuses with 503 and issues nothing", () => {
  for (const which of ["put", "getEntry", "tryLock"] as const) {
    it(`a code: a ${which} failure refuses; nothing is recorded or issued; the code is redeemable once the store recovers`, async () => {
      const code = mintCode();
      singleUse.fail[which] = true;
      expect(await redeemCode(code)).toEqual(UNAVAILABLE); // assertion: fail closed
      expect(singleUse.rows.size).toBe(0);
      expect(singleUse.locks.size).toBe(0); // assertion: a failed claim leaves no lock behind
      expect(authCodes.rows.get(code).used).toBe(false); // assertion: the code is untouched
      expect(tokenRows()).toBe(0); // assertion: no token issued
      singleUse.fail[which] = false;
      expect((await redeemCode(code)).status).toBe(200); // assertion: nothing was recorded by the failed claim
    });

    it(`a refresh token: a ${which} failure refuses; nothing is recorded or issued; the token is redeemable once the store recovers`, async () => {
      const raw = mintRefresh();
      singleUse.fail[which] = true;
      expect(await redeemRefresh(raw)).toEqual(UNAVAILABLE); // assertion: fail closed
      expect(singleUse.rows.size).toBe(0);
      expect(tokenRows()).toBe(1); // assertion: no pair issued, the old row not revoked
      expect(typeof [...tokens.rows.values()][0].revokedAt).toBe("undefined");
      singleUse.fail[which] = false;
      expect((await redeemRefresh(raw)).status).toBe(200); // assertion: nothing was recorded by the failed claim
    });
  }

  it("a missing table or store primitive refuses, naming it in the log", async () => {
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => errors.push(a.join(" "));
    try {
      (flairStub as any).OAuthSingleUse = undefined;
      expect(await redeemCode(mintCode())).toEqual(UNAVAILABLE);
      const broken: any = createFakeReplayNonceTable();
      delete broken.primaryStore.tryLock;
      (flairStub as any).OAuthSingleUse = broken;
      expect(await redeemCode(mintCode())).toEqual(UNAVAILABLE);
      expect(await redeemRefresh(mintRefresh())).toEqual(UNAVAILABLE);
    } finally {
      console.error = orig;
    }
    expect(errors.some((l) => l.includes("table flair.OAuthSingleUse is not defined"))).toBe(true);
    expect(errors.some((l) => l.includes("flair.OAuthSingleUse.primaryStore.tryLock is not a function"))).toBe(true);
  });

  it("a table whose rows do not outlive the code's or the refresh token's remaining life refuses with 503", async () => {
    singleUse.expirationMS = oauth.OAUTH_SINGLE_USE_MIN_RETENTION_MS; // exactly as long as the longest presentation: still a gap
    expect(await redeemRefresh(mintRefresh())).toEqual(UNAVAILABLE);
    singleUse.expirationMS = 1; // shorter than either presentation window
    expect(await redeemCode(mintCode())).toEqual(UNAVAILABLE);
    expect(singleUse.calls.tryLock).toBe(0); // assertion: the store is not touched
    expect(tokenRows()).toBe(1); // assertion: no pair issued (the refresh token's own minted row only)
  });
});

// ─── recorded only after the request validates ─────────────────────────────

describe("the row is written only after the request has validated", () => {
  const cases: Array<[string, () => Promise<{ status: number; body: any }>]> = [
    ["a code that does not exist", () => redeemCode("no-such-code")],
    ["another client", () => redeemCode(mintCode(), { client_id: "flair_cl_other" })],
    ["an expired code", () => redeemCode(mintCode({ expiresAt: new Date(Date.now() - 1000).toISOString() }))],
    ["another redirect_uri", () => redeemCode(mintCode(), { redirect_uri: "https://claude.com/api/mcp/other" })],
    ["a wrong PKCE verifier", () => redeemCode(mintCode(), { code_verifier: "not-the-verifier" })],
    ["a refresh token that does not exist", () => redeemRefresh("flair_rt_nothing")],
    ["an expired refresh token", () => redeemRefresh(mintRefresh({ expiresAt: new Date(Date.now() - 1000).toISOString() }))],
    ["a refresh token of another client", () => redeemRefresh(mintRefresh(), { client_id: "flair_cl_other" })],
  ];
  for (const [name, run] of cases) {
    it(`${name}: refused with 400, and the store is not touched`, async () => {
      const r = await run();
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("invalid_grant");
      expect(singleUse.calls.tryLock).toBe(0); // assertion: no claim before validation
      expect(singleUse.rows.size).toBe(0);
      expect(tokenRows()).toBeLessThanOrEqual(1); // assertion: nothing issued
    });
  }
});

// ─── the key and the retention ─────────────────────────────────────────────

describe("the single-use key and the table", () => {
  it("locks in its own namespace, apart from the nonce and jti keys, and releases each lock", async () => {
    const code = mintCode();
    await redeemCode(code);
    await redeemCode(code);
    const raw = mintRefresh();
    await redeemRefresh(raw);
    expect(rs.OAUTH_SINGLE_USE_LOCK_NAMESPACE).not.toBe(rs.REPLAY_LOCK_NAMESPACE);
    expect(rs.OAUTH_SINGLE_USE_LOCK_NAMESPACE).not.toBe(rs.ID_JAG_LOCK_NAMESPACE);
    expect(singleUse.lockKeys).toEqual([
      [rs.OAUTH_SINGLE_USE_LOCK_NAMESPACE, codeKey(code)],
      [rs.OAUTH_SINGLE_USE_LOCK_NAMESPACE, refreshKey(raw)],
    ]); // the second redemption of the code is refused by the code's own flag, before the store
    expect(singleUse.locks.size).toBe(0); // assertion: nothing left locked
  });

  it("records a hash, never the code or the token, and keeps the code and refresh key spaces apart", async () => {
    const code = mintCode();
    await redeemCode(code);
    const raw = mintRefresh();
    await redeemRefresh(raw);
    const keys = [...singleUse.rows.keys()];
    expect(keys).toContain(codeKey(code));
    expect(keys).toContain(refreshKey(raw));
    expect(keys.join(" ")).not.toContain(code); // assertion: the raw code is not a key
    expect(keys.join(" ")).not.toContain(raw); // assertion: the raw refresh token is not a key
    expect(codeKey(code).startsWith("c:")).toBe(true);
    expect(refreshKey(raw).startsWith("r:")).toBe(true);
  });

  it("the schema's expiration equals OAUTH_SINGLE_USE_RETENTION_S, the table is not opted out of replication and has no REST surface", () => {
    const schema = readFileSync(join(REPO, "schemas", "oauth.graphql"), "utf8");
    const decl = schema.match(/type\s+OAuthSingleUse\s+@table\(([^)]*)\)\s*\{([^}]*)\}/);
    expect(decl).not.toBeNull();
    const args = decl![1];
    expect(Number(args.match(/expiration:\s*(\d+)/)?.[1])).toBe(oauth.OAUTH_SINGLE_USE_RETENTION_S);
    expect(args).not.toMatch(/replicate:/);
    const body = decl![2].replace(/#.*$/gm, "");
    expect(body).toMatch(/seenAt:\s*Long!/);
    expect(decl![0]).not.toMatch(/@export/);
  });

  it("the retention outlives both token lifetimes, so a recorded key outlives its token", () => {
    expect(oauth.OAUTH_SINGLE_USE_RETENTION_S * 1000).toBeGreaterThan(oauth.OAUTH_SINGLE_USE_MIN_RETENTION_MS);
    expect(oauth.OAUTH_SINGLE_USE_MIN_RETENTION_MS).toBeGreaterThanOrEqual(7 * 86400_000); // the refresh token's 7 days
  });

  it("a seeded record row for a code (same table, same key) refuses that code", async () => {
    const code = mintCode();
    singleUse.rows.set(codeKey(code), { id: codeKey(code), seenAt: Date.now() } as any);
    expect(await redeemCode(code)).toEqual(CODE_USED);
    expect(tokenRows()).toBe(0);
  });
});
