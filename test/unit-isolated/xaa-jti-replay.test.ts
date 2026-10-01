/**
 * xaa-jti-replay.test.ts — the XAA ID-JAG `jti` single-use record (flair#2073).
 *
 * validateIdJag (resources/XAA.ts) records an assertion's `jti` through
 * claimIdJagJti (resources/replay-store.ts), the same lock-then-insert as the
 * agent-auth and federation nonces (recordOnce), in flair.IdJagReplay. These
 * tests drive the jwt-bearer grant (handleJwtBearerGrant) with real signed
 * assertions, a real JWKS served on an ephemeral loopback port, and an
 * in-memory table with the store's contract (test/helpers/fake-replay-store.ts),
 * and pin:
 *   - an assertion with a UUID `jti` is accepted once, and N simultaneous
 *     presentations of one give one acceptance and one token pair;
 *   - a `jti` claim that is present but not a nonempty string is refused with
 *     400 before the store is touched;
 *   - the lock key is in its own namespace; recordOnce attempts unlock in
 *     `finally`, and the recorded, replay and store-error cases leave no lock;
 *     a lock miss refuses without recording;
 *   - with a UUID `jti`, a store error or a missing store primitive refuses
 *     with 503 and issues nothing;
 *   - the jti is recorded only after the assertion validates;
 *   - the row's retention outlives the longest an accepted assertion whose jti
 *     was recorded stays valid, and an assertion with a jti must carry an `exp`
 *     inside that bound.
 *
 * Isolated lane: this file replaces the process-global `harper` module. The
 * cross-worker proof on a real two-worker Harper is
 * test/integration/xaa-jti-two-workers-2073.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import {
  createFakeReplayNonceTable,
  ensureGlobalHarperTransaction,
  type FakeReplayNonceTable,
} from "../helpers/fake-replay-store.ts";

// ─── harper mock: the tables the jwt-bearer grant touches ───────────────────

const idpRows: any[] = [];
const credentials = new Map<string, any>();
const agentRows = new Map<string, any>();
const tokenRows = new Map<string, any>();

function matches(row: any, conditions: any[]): boolean {
  return conditions.every((c) => row[c.attribute] === c.value);
}
async function* rowsOf(rows: any[]) {
  for (const r of rows) yield r;
}
class IdpConfigTable {
  static search({ conditions }: any) {
    return rowsOf(idpRows.filter((r) => matches(r, conditions)));
  }
}
const harperMock: any = {
  databases: {
    flair: {
      IdpConfig: IdpConfigTable,
      Credential: {
        search: ({ conditions }: any) => rowsOf([...credentials.values()].filter((r) => matches(r, conditions))),
        put: async (r: any) => {
          credentials.set(r.id, { ...r });
        },
      },
      Agent: {
        get: async (id: string) => agentRows.get(id) ?? null,
        put: async (r: any) => {
          agentRows.set(r.id, { ...r });
        },
        search: () => rowsOf([]),
      },
      OAuthToken: {
        put: async (r: any) => {
          tokenRows.set(r.id, { ...r });
        },
      },
    },
  },
  server: { getUser: async () => null, http: () => {} },
  Resource: class {},
  RequestTarget: class {},
};
mock.module("harper", () => harperMock);

const restoreTransaction = ensureGlobalHarperTransaction();

const xaa = await import("../../resources/XAA.ts");
const rs = await import("../../resources/replay-store.ts");

const REPO = join(import.meta.dir, "..", "..");
const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const ISSUER = "https://idp.xaa-2073.invalid";
const DOMAIN_ISSUER = "https://idp-domain.xaa-2073.invalid";
// A production Flair's HTTP and ops API ports: nothing here may target them.
const FORBIDDEN_PORTS = new Set([9925, 9926]);

// ─── the test IdP: an ES256 key, its JWKS on an ephemeral loopback port ─────

let jwks: Server;
let signingKey: CryptoKey;
let kid: string;
let otherKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair("ES256");
  signingKey = pair.privateKey as CryptoKey;
  otherKey = (await generateKeyPair("ES256")).privateKey as CryptoKey;
  kid = `k-${randomUUID()}`;
  const body = JSON.stringify({ keys: [{ ...(await exportJWK(pair.publicKey)), kid, alg: "ES256", use: "sig" }] });
  jwks = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    jwks.once("error", reject);
    jwks.listen(0, "127.0.0.1", () => resolve());
  });
  const { address, port } = jwks.address() as AddressInfo;
  expect(address).toBe("127.0.0.1"); // assertion: our own loopback listener
  expect(FORBIDDEN_PORTS.has(port)).toBe(false);
  expect(FORBIDDEN_PORTS.has(Number(new URL(xaa.jwtBearerBaseUrl()).port))).toBe(false); // the audience is never a served origin
  const jwksUri = `http://127.0.0.1:${port}/jwks`;
  idpRows.push(
    { id: "idp-2073", name: "xaa-2073", issuer: ISSUER, jwksUri, clientId: "c-2073", enabled: true, jitProvision: true },
    { id: "idp-2073-domain", name: "xaa-2073-domain", issuer: DOMAIN_ISSUER, jwksUri, clientId: "c-2073", enabled: true, jitProvision: true, requiredDomain: "example.com" },
  );
});

afterAll(async () => {
  restoreTransaction();
  await new Promise<void>((resolve) => jwks.close(() => resolve()));
});

let table: FakeReplayNonceTable;

beforeEach(() => {
  table = createFakeReplayNonceTable();
  table.expirationMS = xaa.ID_JAG_REPLAY_RETENTION_S * 1000;
  harperMock.databases.flair.IdJagReplay = table;
  credentials.clear();
  agentRows.clear();
  tokenRows.clear();
});

interface AssertionOpts {
  jti?: unknown;
  expInSec?: number | null;
  aud?: string;
  iss?: string;
  key?: CryptoKey;
  claims?: Record<string, unknown>;
}

async function assertion(opts: AssertionOpts = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = { scope: "memory:read", ...opts.claims };
  if (opts.jti !== undefined) payload.jti = opts.jti;
  const jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: "ES256", kid })
    .setIssuer(opts.iss ?? ISSUER)
    .setSubject(`user-${randomUUID()}`)
    .setAudience(opts.aud ?? xaa.jwtBearerBaseUrl())
    .setIssuedAt(now);
  if (opts.expInSec !== null) jwt.setExpirationTime(now + (opts.expInSec ?? 300));
  return jwt.sign(opts.key ?? signingKey);
}

async function grant(token: string): Promise<{ status: number; body: any }> {
  const r: any = await xaa.handleJwtBearerGrant({ grant_type: JWT_BEARER, assertion: token });
  if (r instanceof Response) return { status: r.status, body: await r.json() };
  return { status: 200, body: r };
}

const REPLAY = { status: 400, body: { error: "invalid_grant", error_description: "token replay detected" } };
const UNAVAILABLE = { status: 503, body: { error: "temporarily_unavailable", error_description: "replay_store_unavailable" } };

// ─── one acceptance per jti ────────────────────────────────────────────────

describe("a UUID jti is accepted once", () => {
  it("the first presentation is accepted and records the jti; the next is refused", async () => {
    const jti = randomUUID();
    const token = await assertion({ jti });
    const first = await grant(token);
    expect(first.status).toBe(200);
    expect(typeof first.body.access_token).toBe("string");
    expect([...table.rows.keys()]).toEqual([jti]); // assertion: the row is keyed by the jti
    expect(await grant(token)).toEqual(REPLAY); // assertion: second use refused
    expect(tokenRows.size).toBe(2); // one access + one refresh token, from the first grant only
  });

  it("N simultaneous presentations of one assertion: exactly one is accepted, and only it issues tokens", async () => {
    for (let round = 0; round < 10; round++) {
      tokenRows.clear();
      agentRows.clear();
      const token = await assertion({ jti: randomUUID() });
      const results = await Promise.all(Array.from({ length: 16 }, () => grant(token)));
      expect(results.filter((r) => r.status === 200).length).toBe(1); // assertion: exactly one acceptance
      expect(results.filter((r) => r.status === 400 && r.body.error_description === "token replay detected").length).toBe(15);
      expect(tokenRows.size).toBe(2); // assertion: the refused presentations issued nothing
      expect(agentRows.size).toBe(1); // ...and provisioned nothing
    }
  });

  it("locks the jti in its own namespace, apart from the nonce keys, and releases it", async () => {
    const jti = randomUUID();
    const token = await assertion({ jti });
    await grant(token);
    await grant(token);
    expect(rs.ID_JAG_LOCK_NAMESPACE).not.toBe(rs.REPLAY_LOCK_NAMESPACE);
    expect(table.lockKeys).toEqual([
      [rs.ID_JAG_LOCK_NAMESPACE, jti],
      [rs.ID_JAG_LOCK_NAMESPACE, jti],
    ]);
    expect(table.locks.size).toBe(0); // assertion: nothing left locked
  });

  it("a presentation that misses the jti's lock is refused and records nothing; the assertion is accepted once the lock is free", async () => {
    const jti = randomUUID();
    const token = await assertion({ jti });
    const lockKey = [rs.ID_JAG_LOCK_NAMESPACE, jti];
    expect(table.primaryStore.tryLock(lockKey)).toBe(true); // another presentation is recording this jti
    expect(await grant(token)).toEqual(REPLAY); // assertion: the lock miss refuses
    expect(table.rows.size).toBe(0);
    expect(tokenRows.size).toBe(0);
    table.primaryStore.unlock(lockKey);
    expect((await grant(token)).status).toBe(200); // assertion: the store decides the next presentation
  });

  it("a row the previous release wrote for a jti (same table, same key) refuses that assertion", async () => {
    const jti = randomUUID();
    table.rows.set(jti, { id: jti, expiresAt: new Date().toISOString(), createdAt: new Date().toISOString() } as any);
    expect(await grant(await assertion({ jti }))).toEqual(REPLAY);
    expect(tokenRows.size).toBe(0);
  });
});

// ─── fail closed ───────────────────────────────────────────────────────────

describe("with a UUID jti, a store error refuses the grant with 503 and issues nothing", () => {
  for (const which of ["put", "getEntry", "tryLock"] as const) {
    it(`a ${which} failure refuses; nothing is recorded or issued; the assertion is accepted once the store recovers`, async () => {
      const token = await assertion({ jti: randomUUID() });
      table.fail[which] = true;
      expect(await grant(token)).toEqual(UNAVAILABLE); // assertion: fail closed
      expect(table.rows.size).toBe(0);
      expect(table.locks.size).toBe(0); // assertion: a failed claim leaves no lock behind
      expect(tokenRows.size).toBe(0); // assertion: no token issued
      expect(agentRows.size).toBe(0); // ...and no principal provisioned
      table.fail[which] = false;
      expect((await grant(token)).status).toBe(200); // assertion: nothing was recorded by the failed claim
    });
  }

  it("a missing table or store primitive refuses, naming it in the log", async () => {
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => errors.push(a.join(" "));
    try {
      harperMock.databases.flair.IdJagReplay = undefined;
      expect(await grant(await assertion({ jti: randomUUID() }))).toEqual(UNAVAILABLE);
      const broken: any = createFakeReplayNonceTable();
      delete broken.primaryStore.tryLock;
      harperMock.databases.flair.IdJagReplay = broken;
      expect(await grant(await assertion({ jti: randomUUID() }))).toEqual(UNAVAILABLE);
    } finally {
      console.error = orig;
    }
    expect(tokenRows.size).toBe(0);
    expect(errors.some((l) => l.includes("table flair.IdJagReplay is not defined"))).toBe(true);
    expect(errors.some((l) => l.includes("flair.IdJagReplay.primaryStore.tryLock is not a function"))).toBe(true);
  });
});

// ─── recorded only after the assertion validates ───────────────────────────

describe("the jti is recorded only after the assertion validates", () => {
  const cases: Array<[string, () => Promise<string>]> = [
    ["a signature from another key", () => assertion({ jti: randomUUID(), key: otherKey })],
    ["another audience", () => assertion({ jti: randomUUID(), aud: "https://not-this-flair.invalid" })],
    ["an expired assertion", () => assertion({ jti: randomUUID(), expInSec: -3600 })],
    ["a domain mismatch", () => assertion({ jti: randomUUID(), iss: DOMAIN_ISSUER, claims: { hd: "other.example" } })],
  ];
  for (const [name, make] of cases) {
    it(`${name}: refused with 400, and the store is not touched`, async () => {
      const r = await grant(await make());
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("invalid_grant");
      expect(table.calls.tryLock).toBe(0); // assertion: no claim before validation
      expect(table.rows.size).toBe(0);
    });
  }
});

// ─── retention outlives every accepted assertion whose jti was recorded ─────

describe("the record outlives the assertion's validity", () => {
  it("the schema's expiration equals ID_JAG_REPLAY_RETENTION_S; the table is not opted out of replication and has no REST surface", () => {
    const schema = readFileSync(join(REPO, "schemas", "oauth.graphql"), "utf8");
    const decl = schema.match(/type\s+IdJagReplay\s+@table\(([^)]*)\)\s*\{([^}]*)\}/);
    expect(decl).not.toBeNull();
    const args = decl![1];
    expect(Number(args.match(/expiration:\s*(\d+)/)?.[1])).toBe(xaa.ID_JAG_REPLAY_RETENTION_S);
    expect(args).not.toMatch(/replicate:/);
    const body = decl![2].replace(/#.*$/gm, "");
    expect(body).toMatch(/seenAt:\s*Long!/);
    expect(decl![0]).not.toMatch(/@export/);
  });

  it("the retention is longer than the longest an accepted assertion stays acceptable after its jti is recorded", () => {
    // jose compares exp with the current whole second, so it accepts only before
    // exp + CLOCK_SKEW_MS + 1 s; an assertion with a jti is accepted only while
    // exp ≤ now + ID_JAG_MAX_VALIDITY_MS + CLOCK_SKEW_MS.
    expect(xaa.ID_JAG_LONGEST_ACCEPTANCE_MS).toBe(xaa.ID_JAG_MAX_VALIDITY_MS + 2 * xaa.CLOCK_SKEW_MS + 1000);
    expect(xaa.ID_JAG_REPLAY_RETENTION_S * 1000).toBeGreaterThan(xaa.ID_JAG_LONGEST_ACCEPTANCE_MS);
  });

  it("an assertion that expires ID_JAG_MAX_VALIDITY_MS ahead is accepted", async () => {
    const token = await assertion({ jti: randomUUID(), expInSec: xaa.ID_JAG_MAX_VALIDITY_MS / 1000 });
    expect((await grant(token)).status).toBe(200);
  });

  it("an assertion with a jti and an exp beyond the bound is refused, and the store is not touched", async () => {
    const tooLong = (xaa.ID_JAG_MAX_VALIDITY_MS + xaa.CLOCK_SKEW_MS) / 1000 + 5;
    const r = await grant(await assertion({ jti: randomUUID(), expInSec: tooLong }));
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_grant");
    expect(table.calls.tryLock).toBe(0);
  });

  it("an assertion with a jti and no exp is refused, and the store is not touched", async () => {
    const r = await grant(await assertion({ jti: randomUUID(), expInSec: null }));
    expect(r.status).toBe(400);
    expect(table.calls.tryLock).toBe(0);
  });

  it("an assertion whose jti is not a string is refused, and the store is not touched", async () => {
    const r = await grant(await assertion({ jti: { k: 1 } }));
    expect(r.status).toBe(400);
    expect(table.calls.tryLock).toBe(0);
  });

  it("a live table that keeps rows too briefly refuses with 503", async () => {
    table.expirationMS = xaa.ID_JAG_LONGEST_ACCEPTANCE_MS;
    expect(await grant(await assertion({ jti: randomUUID() }))).toEqual(UNAVAILABLE);
    expect(table.calls.tryLock).toBe(0);
  });

  it("a fractional exp: a live table that keeps rows longer than 24 h + 60 s but not 24 h + 61 s refuses with 503", async () => {
    table.expirationMS = xaa.ID_JAG_MAX_VALIDITY_MS + 2 * xaa.CLOCK_SKEW_MS + 500;
    expect(await grant(await assertion({ jti: randomUUID(), expInSec: 300.5 }))).toEqual(UNAVAILABLE);
    expect(table.calls.tryLock).toBe(0);
    expect(tokenRows.size).toBe(0);
  });
});

// ─── a jti claim, when present, must be a nonempty string ──────────────────

describe("a jti claim, when present, must be a nonempty string", () => {
  const values: Array<[string, unknown]> = [
    ['""', ""],
    ["null", null],
    ["0", 0],
    ["false", false],
  ];
  const variants: Array<[string, AssertionOpts, () => void]> = [
    ["", {}, () => {}],
    [" and no exp", { expInSec: null }, () => {}],
    [
      " while the store is unavailable",
      {},
      () => {
        table.fail.tryLock = true;
        table.fail.getEntry = true;
        table.fail.put = true;
      },
    ],
  ];
  for (const [label, jti] of values) {
    for (const [variant, opts, setup] of variants) {
      it(`jti ${label}${variant}: refused with 400, nothing issued, and the store is not touched`, async () => {
        setup();
        const r = await grant(await assertion({ ...opts, jti }));
        expect(r.status).toBe(400); // assertion: refused
        expect(r.body.error).toBe("invalid_grant");
        expect(tokenRows.size).toBe(0); // assertion: no token issued
        expect(agentRows.size).toBe(0);
        expect(table.calls.tryLock).toBe(0);
      });
    }
  }
});
