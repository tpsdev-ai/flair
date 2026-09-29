/**
 * replay-store.test.ts — the instance-wide replay store (flair#2061).
 *
 * resources/replay-store.ts is the ONE check-and-record for agent auth and for
 * federation body signatures. These tests pin, against an in-memory table with
 * the same contract (test/helpers/fake-replay-store.ts):
 *   - one claim per key is "recorded", every other is refused, including N
 *     concurrent claims of the same key;
 *   - a claim that misses the key's lock is refused but not remembered, so the
 *     key is accepted once the lock holder's failed write leaves it unrecorded;
 *   - the lock key is namespaced and always released;
 *   - a store error, or a missing store primitive, refuses (never accepts);
 *   - memory only short-circuits a HIT — a miss always consults the store;
 *   - a signature failure records nothing (agent auth and federation);
 *   - the retention outlives twice every replay window, and matches the schema;
 * and, against the INSTALLED Harper, that the primary-store methods the claim
 * relies on exist and behave as a non-re-entrant per-key lock.
 *
 * Isolated lane: this file replaces the process-global `harper` module.
 * The cross-worker proof on a real two-worker Harper is
 * test/integration/replay-store-two-workers-2061.test.ts.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { createRequire } from "node:module";
import { generateKeyPairSync, randomUUID, sign as edSign } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import nacl from "tweetnacl";
import {
  createFakeReplayNonceTable,
  ensureGlobalHarperTransaction,
  fakeHarperTransaction,
  type FakeReplayNonceTable,
} from "../helpers/fake-replay-store.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const agents = new Map<string, any>();
const presenceRows = new Map<string, any>();
class BasePresence {
  static async get(id: string) {
    return presenceRows.get(id) ?? null;
  }
  static async put(rec: any) {
    presenceRows.set(rec.agentId, rec);
    return rec;
  }
  static search() {
    return (async function* () {})();
  }
}
let middleware: any;
const harperMock: any = {
  databases: {
    flair: {
      Agent: {
        get: async (id: string) => agents.get(id) ?? null,
        search: async function* () {},
      },
      Presence: BasePresence,
    },
  },
  server: {
    getUser: async () => null,
    http: (fn: any) => {
      middleware = fn;
    },
  },
  Resource: class {},
  RequestTarget: class {},
};
mock.module("harper", () => harperMock);

const restoreTransaction = ensureGlobalHarperTransaction();
afterAll(() => restoreTransaction());

const rs = await import("../../resources/replay-store.ts");
const { verifyAgentRequest } = await import("../../resources/agent-auth.ts");
await import("../../resources/auth-middleware.ts"); // registers its handler via server.http
const { Presence } = await import("../../resources/Presence.ts");
const { WINDOW_MS } = await import("../../resources/ed25519-auth.ts");
const { FEDERATION_WINDOW_MS, signBodyFresh } = await import("../../resources/federation-crypto.ts");

const REPO = join(import.meta.dir, "..", "..");

let table: FakeReplayNonceTable;
const deps = () => ({ table, transaction: fakeHarperTransaction });

beforeEach(() => {
  table = createFakeReplayNonceTable();
  harperMock.databases.flair.ReplayNonce = table;
  rs.agentReplayGuard.resetCacheForTest();
  rs.federationReplayGuard.resetCacheForTest();
  agents.clear();
  presenceRows.clear();
});

// ─── Signed-request fixtures ───────────────────────────────────────────────

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC_B64 = Buffer.from((publicKey.export({ format: "jwk" }) as any).x, "base64url").toString("base64");
const AGENT = "agent-2061";

function signedRequest(opts: { nonce?: string; badSignature?: boolean; url?: string; method?: string } = {}): any {
  const url = opts.url ?? "/Memory?limit=1";
  const method = opts.method ?? "GET";
  const u = new URL(url, "http://localhost");
  const ts = Date.now().toString();
  const nonce = opts.nonce ?? randomUUID();
  const payload = `${AGENT}:${ts}:${nonce}:${method}:${u.pathname}${u.search}`;
  let sig = edSign(null, Buffer.from(payload), privateKey);
  if (opts.badSignature) sig = edSign(null, Buffer.from(payload + "x"), privateKey);
  const headers = new Map<string, string>([
    ["authorization", `TPS-Ed25519 ${AGENT}:${ts}:${nonce}:${sig.toString("base64")}`],
    ["host", "localhost"],
  ]);
  return {
    url,
    method,
    headers: {
      get: (n: string) => headers.get(n.toLowerCase()) ?? null,
      set: (n: string, v: string) => {
        headers.set(n.toLowerCase(), v);
      },
      asObject: {},
    },
  };
}

function presencePost(req: any): Promise<any> {
  const p: any = new (Presence as any)();
  p.getContext = () => ({ request: req });
  return p.post({ activity: "idle" });
}

const nextLayer = () => new Response("ok", { status: 200 });

function seedAgent(): void {
  agents.set(AGENT, { id: AGENT, publicKey: PUBLIC_B64, status: "active", role: "agent" });
}

const fedKeys = nacl.sign.keyPair();
const FED_PUB = Buffer.from(fedKeys.publicKey).toString("base64url");

/**
 * Holds the table's next write open until `release()`, then fails it. The claim
 * making that write holds the key's lock meanwhile, so a second claim of the
 * key misses the lock. Later writes use the table's own `put`.
 */
function holdFailingWrite(): { reached(claim: Promise<unknown>): Promise<void>; release(): void } {
  let release!: () => void;
  let entered!: () => void;
  const released = new Promise<void>((r) => (release = r));
  const inside = new Promise<void>((r) => (entered = r));
  const put = table.put;
  table.put = async () => {
    table.put = put;
    entered();
    await released;
    throw new Error("fake store: write failure");
  };
  return {
    // Resolves once `claim` is inside the held write; rejects if it ends first.
    reached: (claim) =>
      Promise.race([
        inside,
        claim.then(() => {
          throw new Error("the claim finished before it reached the held write");
        }),
      ]),
    release,
  };
}

// ─── The check-and-record ──────────────────────────────────────────────────

describe("recordOnce — atomic check-and-record", () => {
  it("records the first claim of a key and answers replay for the next", async () => {
    expect(await rs.recordOnce("a:x:n1", 1, deps())).toBe("recorded"); // assertion: first use recorded
    expect(await rs.recordOnce("a:x:n1", 2, deps())).toBe("replay"); // assertion: second use refused
    expect(table.rows.get("a:x:n1")?.seenAt).toBe(1); // assertion: the row is the first claim's
  });

  it("locks a NAMESPACED key and always releases it", async () => {
    await rs.recordOnce("f:n2", 1, deps());
    await rs.recordOnce("f:n2", 2, deps());
    expect(table.lockKeys).toEqual([
      [rs.REPLAY_LOCK_NAMESPACE, "f:n2"],
      [rs.REPLAY_LOCK_NAMESPACE, "f:n2"],
    ]); // assertion: never a bare key in the database-wide lock space
    expect(table.locks.size).toBe(0); // assertion: nothing left locked
  });

  it("holds the lock while the write commits", async () => {
    let lockedDuringPut: boolean | undefined;
    const put = table.put.bind(table);
    table.put = async (rec) => {
      lockedDuringPut = !table.primaryStore.tryLock([rs.REPLAY_LOCK_NAMESPACE, rec.id]);
      return put(rec);
    };
    expect(await rs.recordOnce("a:x:n3", 1, deps())).toBe("recorded");
    expect(lockedDuringPut).toBe(true); // assertion: a second claimant is shut out until the commit
  });

  it("a lock miss is \"contended\", not \"replay\": the key's row is not in the store", async () => {
    const lockKey = [rs.REPLAY_LOCK_NAMESPACE, "a:x:n4"];
    expect(table.primaryStore.tryLock(lockKey)).toBe(true); // another claim of the key holds its lock
    expect(await rs.recordOnce("a:x:n4", 1, deps())).toBe("contended"); // assertion: told apart from a stored row
    expect(table.rows.size).toBe(0);
    table.primaryStore.unlock(lockKey);
    expect(await rs.recordOnce("a:x:n4", 2, deps())).toBe("recorded");
  });

  it("N concurrent claims of one key yield exactly one recorded", async () => {
    for (let round = 0; round < 20; round++) {
      const key = `a:x:race-${round}`;
      const verdicts = await Promise.all(Array.from({ length: 16 }, () => rs.recordOnce(key, round, deps())));
      expect(verdicts.filter((v) => v === "recorded").length).toBe(1); // assertion: exactly one winner per round
    }
  });
});

// ─── Fail closed ───────────────────────────────────────────────────────────

describe("a store error refuses the request", () => {
  for (const which of ["put", "getEntry", "tryLock"] as const) {
    it(`a ${which} failure is "unavailable", and the agent-auth claim refuses with 503`, async () => {
      table.fail[which] = true;
      expect(await rs.agentReplayGuard.claim(`${AGENT}:${which}-1`)).toBe("unavailable"); // assertion: never "recorded"
      const claim = await rs.claimAgentNonce(AGENT, `${which}-2`);
      expect(claim).toEqual({ ok: false, error: "replay_store_unavailable", status: 503 }); // assertion: refused, named
      expect(table.locks.size).toBe(0); // assertion: a failed claim leaves no lock behind
    });
  }

  it("a failed write records nothing, and the key is claimable once the store recovers", async () => {
    table.fail.put = true;
    expect(await rs.federationReplayGuard.claim("n-recover")).toBe("unavailable");
    expect(table.rows.size).toBe(0); // assertion: no row from the failed write
    table.fail.put = false;
    expect(await rs.federationReplayGuard.claim("n-recover")).toBe("recorded"); // assertion: lock was released
  });

  it("a signed agent request is refused when the store write fails", async () => {
    seedAgent();
    table.fail.put = true;
    expect(await verifyAgentRequest(signedRequest())).toBeNull(); // assertion: fail closed, not accepted
  });

  it("a signed federation body is refused with replay_store_unavailable when the store write fails", async () => {
    table.fail.put = true;
    const body = signBodyFresh({ instanceId: "spoke-1", records: [] }, fedKeys.secretKey);
    expect(await rs.verifyFederationRequestBody(body, FED_PUB)).toEqual({ ok: false, reason: "replay_store_unavailable" });
  });
});

describe("a missing store primitive is a named refusal state", () => {
  it("names the missing primary-store method, and every claim refuses", async () => {
    const broken: any = createFakeReplayNonceTable();
    delete broken.primaryStore.tryLock;
    const d = { table: broken, transaction: fakeHarperTransaction };
    expect(rs.replayStoreContractGap(d)).toBe("flair.ReplayNonce.primaryStore.tryLock is not a function");
    await expect(rs.recordOnce("a:x:y", 1, d)).rejects.toBeInstanceOf(rs.ReplayStoreUnavailable);
    harperMock.databases.flair.ReplayNonce = broken;
    expect(await rs.claimAgentNonce(AGENT, "n")).toEqual({ ok: false, error: "replay_store_unavailable", status: 503 });
    expect(rs.replayStoreBootGaps()).toEqual([
      "agent auth: flair.ReplayNonce.primaryStore.tryLock is not a function",
      "federation: flair.ReplayNonce.primaryStore.tryLock is not a function",
    ]); // assertion: the boot report names the gap for both guards
  });

  it("names a missing table, unlock, getEntry, put and transaction", () => {
    expect(rs.replayStoreContractGap({ table: undefined, transaction: fakeHarperTransaction })).toBe("table flair.ReplayNonce is not defined");
    for (const m of ["unlock", "getEntry"] as const) {
      const t: any = createFakeReplayNonceTable();
      delete t.primaryStore[m];
      expect(rs.replayStoreContractGap({ table: t, transaction: fakeHarperTransaction })).toBe(`flair.ReplayNonce.primaryStore.${m} is not a function`);
    }
    const noPut: any = createFakeReplayNonceTable();
    delete noPut.put;
    expect(rs.replayStoreContractGap({ table: noPut, transaction: fakeHarperTransaction })).toBe("flair.ReplayNonce.put is not a function");
    expect(rs.replayStoreContractGap({ table: createFakeReplayNonceTable(), transaction: undefined })).toBe("Harper's transaction() is not available");
  });

  it("reports no gap for a complete store", () => {
    expect(rs.replayStoreBootGaps()).toEqual([]);
  });
});

// ─── Memory only short-circuits a hit ──────────────────────────────────────

describe("memory short-circuits a HIT only; the store decides a miss", () => {
  it("a second guard (another worker) with empty memory still refuses a recorded key", async () => {
    const workerA = rs.createReplayGuard({ scope: "a", windowMs: WINDOW_MS, deps });
    const workerB = rs.createReplayGuard({ scope: "a", windowMs: WINDOW_MS, deps });
    expect(await workerA.claim("agent:n1")).toBe("recorded");
    expect(workerA.knownReplay("agent:n1")).toBe(true); // assertion: A may refuse early now
    expect(workerB.knownReplay("agent:n1")).toBe(false); // assertion: B's memory knows nothing...
    expect(await workerB.claim("agent:n1")).toBe("replay"); // assertion: ...and B's store claim refuses it
    expect(workerB.knownReplay("agent:n1")).toBe(true);
  });

  it("clearing memory never re-opens a key: the claim still goes to the store", async () => {
    expect(await rs.agentReplayGuard.claim("agent:n2")).toBe("recorded");
    rs.agentReplayGuard.resetCacheForTest();
    expect(await rs.agentReplayGuard.claim("agent:n2")).toBe("replay");
  });

  it("a claim always consults the store, even after a memory hit", async () => {
    const g = rs.createReplayGuard({ scope: "f", windowMs: FEDERATION_WINDOW_MS, deps });
    await g.claim("n3");
    const before = table.calls.getEntry;
    await g.claim("n3");
    expect(table.calls.getEntry).toBe(before + 1); // assertion: no memory-only answer on the claim path
  });

  it("scopes keep agent-auth and federation keys apart", async () => {
    expect(await rs.agentReplayGuard.claim("same")).toBe("recorded");
    expect(await rs.federationReplayGuard.claim("same")).toBe("recorded");
    expect([...table.rows.keys()].sort()).toEqual(["a:same", "f:same"]);
  });
});

// ─── A lock miss refuses the request but is not remembered ─────────────────

describe("a claim that misses the key's lock is refused, and not remembered", () => {
  it("the guard: after the lock holder's write fails, the key is recorded on the next claim", async () => {
    const g = rs.createReplayGuard({ scope: "a", windowMs: WINDOW_MS, deps });
    const held = holdFailingWrite();
    const holder = g.claim("agent:lm1");
    await held.reached(holder);
    expect(await g.claim("agent:lm1")).toBe("replay"); // assertion: the lock miss refuses this request
    expect(g.knownReplay("agent:lm1")).toBe(false); // assertion: ...and is not remembered
    held.release();
    expect(await holder).toBe("unavailable"); // the holder's write failed
    expect(table.rows.size).toBe(0);
    expect(g.knownReplay("agent:lm1")).toBe(false);
    expect(await g.claim("agent:lm1")).toBe("recorded"); // assertion: the store decides the retry
    expect(g.knownReplay("agent:lm1")).toBe(true); // a confirmed record is remembered
  });

  it("auth gate (auth-middleware.ts): the lock miss answers 401; once the holder's write fails, the same nonce is accepted", async () => {
    seedAgent();
    const nonce = randomUUID();
    const held = holdFailingWrite();
    const holder: Promise<Response> = middleware(signedRequest({ nonce }), nextLayer);
    await held.reached(holder);
    const contended: Response = await middleware(signedRequest({ nonce }), nextLayer);
    expect(contended.status).toBe(401);
    expect(await contended.json()).toEqual({ error: "nonce_replay_detected" }); // assertion: the lock miss refuses this request
    held.release();
    expect((await holder).status).toBe(503); // the holder's write failed
    expect(table.rows.size).toBe(0);
    const retry: Response = await middleware(signedRequest({ nonce }), nextLayer);
    expect(retry.status).toBe(200); // assertion: not refused from this thread's memory
    expect([...table.rows.keys()]).toEqual([`a:${AGENT}:${nonce}`]);
    const replay: Response = await middleware(signedRequest({ nonce }), nextLayer);
    expect(replay.status).toBe(401);
  });

  it("federation: the lock miss is a replay; once the holder's write fails, the same body is accepted", async () => {
    const body = signBodyFresh({ instanceId: "spoke-1", records: [] }, fedKeys.secretKey);
    const held = holdFailingWrite();
    const holder = rs.verifyFederationRequestBody(body, FED_PUB);
    await held.reached(holder);
    expect(await rs.verifyFederationRequestBody(body, FED_PUB)).toEqual({ ok: false, reason: "replay" }); // assertion: refused
    held.release();
    expect(await holder).toEqual({ ok: false, reason: "replay_store_unavailable" });
    expect(table.rows.size).toBe(0);
    expect(await rs.verifyFederationRequestBody(body, FED_PUB)).toEqual({ ok: true }); // assertion: not refused from memory
    expect(await rs.verifyFederationRequestBody(body, FED_PUB)).toEqual({ ok: false, reason: "replay" });
  });
});

// ─── The nonce is recorded only after the signature verifies ───────────────

describe("a signature failure does not record the nonce", () => {
  it("agent auth: a bad signature records nothing, and the valid request with that nonce is accepted once", async () => {
    seedAgent();
    const nonce = randomUUID();
    expect(await verifyAgentRequest(signedRequest({ nonce, badSignature: true }))).toBeNull();
    expect(table.rows.size).toBe(0); // assertion: the refused request wrote no row
    expect(table.calls.tryLock).toBe(0); // assertion: the store was not touched before verification
    expect(await verifyAgentRequest(signedRequest({ nonce }))).toEqual({ agentId: AGENT, isAdmin: false }); // assertion: not burned
    expect([...table.rows.keys()]).toEqual([`a:${AGENT}:${nonce}`]);
    expect(await verifyAgentRequest(signedRequest({ nonce }))).toBeNull(); // assertion: a replay is refused
  });

  it("auth gate (auth-middleware.ts): a bad signature records nothing; the valid request is accepted once", async () => {
    seedAgent();
    const nonce = randomUUID();
    const bad: Response = await middleware(signedRequest({ nonce, badSignature: true }), nextLayer);
    expect(bad.status).toBe(401);
    expect(table.calls.tryLock).toBe(0); // assertion: the store was not touched before verification
    const good: Response = await middleware(signedRequest({ nonce }), nextLayer);
    expect(good.status).toBe(200); // assertion: not burned
    expect([...table.rows.keys()]).toEqual([`a:${AGENT}:${nonce}`]);
    rs.agentReplayGuard.resetCacheForTest(); // prove the STORE refuses, not this thread's memory
    const replay: Response = await middleware(signedRequest({ nonce }), nextLayer);
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ error: "nonce_replay_detected" });
  });

  it("auth gate (auth-middleware.ts): a store error answers 503 replay_store_unavailable and never reaches the next layer", async () => {
    seedAgent();
    table.fail.put = true;
    let reached = false;
    const res: Response = await middleware(signedRequest(), () => {
      reached = true;
      return new Response("ok");
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "replay_store_unavailable" });
    expect(reached).toBe(false); // assertion: refused before the request has any effect
  });

  it("Presence heartbeat (Presence.ts): a bad signature records nothing; the valid heartbeat is accepted once", async () => {
    seedAgent();
    const nonce = randomUUID();
    const bad = await presencePost(signedRequest({ nonce, badSignature: true, url: "/Presence", method: "POST" }));
    expect(bad.status).toBe(401);
    expect(table.calls.tryLock).toBe(0); // assertion: the store was not touched before verification
    const good = await presencePost(signedRequest({ nonce, url: "/Presence", method: "POST" }));
    expect(good).toMatchObject({ ok: true, agentId: AGENT }); // assertion: not burned
    expect(presenceRows.has(AGENT)).toBe(true);
    rs.agentReplayGuard.resetCacheForTest();
    presenceRows.clear();
    const replay = await presencePost(signedRequest({ nonce, url: "/Presence", method: "POST" }));
    expect(replay.status).toBe(401);
    expect(presenceRows.has(AGENT)).toBe(false); // assertion: the replay wrote nothing
  });

  it("Presence heartbeat (Presence.ts): a store error answers 503 and writes no heartbeat", async () => {
    seedAgent();
    table.fail.put = true;
    const res = await presencePost(signedRequest({ url: "/Presence", method: "POST" }));
    expect(res.status).toBe(503);
    expect(presenceRows.size).toBe(0);
  });

  it("agent auth: an unknown agent records nothing", async () => {
    expect(await verifyAgentRequest(signedRequest())).toBeNull();
    expect(table.calls.tryLock).toBe(0);
  });

  it("federation: a bad signature records nothing, and the valid body is accepted once", async () => {
    const body = signBodyFresh({ instanceId: "spoke-1", records: [] }, fedKeys.secretKey);
    const other = nacl.sign.keyPair();
    const forged = { ...body, signature: signBodyFresh({ instanceId: "spoke-1", records: [] }, other.secretKey, { ts: body._ts, nonce: body._nonce }).signature };
    expect(await rs.verifyFederationRequestBody(forged, FED_PUB)).toEqual({ ok: false, reason: "invalid_signature" });
    expect(table.rows.size).toBe(0); // assertion: nothing recorded for the refused body
    expect(await rs.verifyFederationRequestBody(body, FED_PUB)).toEqual({ ok: true });
    expect([...table.rows.keys()]).toEqual([`f:${body._nonce}`]);
    expect(await rs.verifyFederationRequestBody(body, FED_PUB)).toEqual({ ok: false, reason: "replay" });
  });

  it("federation: a stale or future body records nothing", async () => {
    const stale = signBodyFresh({ a: 1 }, fedKeys.secretKey, { ts: Date.now() - FEDERATION_WINDOW_MS - 5_000 });
    const future = signBodyFresh({ a: 1 }, fedKeys.secretKey, { ts: Date.now() + FEDERATION_WINDOW_MS + 5_000 });
    expect((await rs.verifyFederationRequestBody(stale, FED_PUB)).reason).toBe("stale");
    expect((await rs.verifyFederationRequestBody(future, FED_PUB)).reason).toBe("future");
    expect(table.calls.tryLock).toBe(0);
  });
});

// ─── Eviction never removes an in-window entry ─────────────────────────────

describe("retention outlives every replay window", () => {
  it("the schema's expiration equals REPLAY_RETENTION_S, and the table is local", () => {
    const schema = readFileSync(join(REPO, "schemas", "replay.graphql"), "utf8");
    const decl = schema.match(/type\s+ReplayNonce\s+@table\(([^)]*)\)/);
    expect(decl).not.toBeNull();
    const args = decl![1];
    expect(Number(args.match(/expiration:\s*(\d+)/)?.[1])).toBe(rs.REPLAY_RETENTION_S);
    expect(args).toMatch(/replicate:\s*false/);
    expect(args).toMatch(/database:\s*"flair"/);
    const code = schema.replace(/#.*$/gm, ""); // declarations only, not comments
    expect(code).toMatch(/seenAt:\s*Long!/);
    expect(code).not.toMatch(/@export/); // assertion: no REST surface
  });

  it("the retired Nonce table is no longer declared", () => {
    const fed = readFileSync(join(REPO, "schemas", "federation.graphql"), "utf8");
    expect(fed).not.toMatch(/type\s+Nonce\s+@table/);
  });

  it("retention is longer than twice both windows (a key is acceptable for at most 2 × window)", () => {
    expect(rs.REPLAY_RETENTION_MS).toBeGreaterThan(2 * WINDOW_MS);
    expect(rs.REPLAY_RETENTION_MS).toBeGreaterThan(2 * FEDERATION_WINDOW_MS);
    expect(rs.replayWindowGap(WINDOW_MS)).toBeNull();
    expect(rs.replayWindowGap(FEDERATION_WINDOW_MS)).toBeNull();
  });

  it("a window that does not fit the retention makes its guard refuse, naming the setting", async () => {
    expect(rs.replayWindowGap(rs.REPLAY_RETENTION_MS / 2, "FLAIR_AGENT_AUTH_WINDOW_MS")).toBe(
      "replay window 60000 ms (FLAIR_AGENT_AUTH_WINDOW_MS) must be below 60000 ms: flair.ReplayNonce keeps a nonce 120000 ms, and that must exceed twice the window",
    );
    expect(rs.agentReplayGuard.windowSource).toBe("FLAIR_AGENT_AUTH_WINDOW_MS");
    const wide = rs.createReplayGuard({ scope: "a", windowMs: rs.REPLAY_RETENTION_MS / 2, deps });
    expect(await wide.claim("k")).toBe("unavailable"); // assertion: refuses even with a healthy store
    expect(table.calls.tryLock).toBe(0);
  });

  it("a live table that keeps rows too briefly for the window is a gap", () => {
    table.expirationMS = 2 * WINDOW_MS;
    expect(rs.replayStoreContractGap({ table, transaction: fakeHarperTransaction }, WINDOW_MS)).toMatch(/not longer than twice/);
    table.expirationMS = rs.REPLAY_RETENTION_MS;
    expect(rs.replayStoreContractGap({ table, transaction: fakeHarperTransaction }, WINDOW_MS)).toBeNull();
  });
});

// ─── The pinned Harper's store primitives (contract) ───────────────────────

describe("the installed Harper's primary stores provide the lock the claim relies on", () => {
  const harperDir = realpathSync(join(REPO, "node_modules", "harper"));
  const harperRequire = createRequire(join(harperDir, "package.json"));

  it("PrimaryRocksDatabase (Harper 5.x tables) has tryLock, unlock and getEntry", async () => {
    const mod: any = await import(join(harperDir, "dist", "resources", "PrimaryRocksDatabase.js"));
    for (const m of ["tryLock", "unlock", "getEntry"]) {
      expect(typeof mod.PrimaryRocksDatabase.prototype[m], m).toBe("function");
    }
  });

  it("RocksDB: a namespaced key locks once per holder (not re-entrant), and unlock releases it", async () => {
    const rocks: any = await import(harperRequire.resolve("@harperfast/rocksdb-js"));
    const db = rocks.RocksDatabase.open(join(tempDir("flair-replay-rocks-"), "db"));
    try {
      const k = [rs.REPLAY_LOCK_NAMESPACE, "a:agent:nonce"];
      expect(db.tryLock(k)).toBe(true);
      expect(db.tryLock(k)).toBe(false); // assertion: the same thread cannot take it twice
      expect(db.tryLock([rs.REPLAY_LOCK_NAMESPACE, "a:agent:other"])).toBe(true); // assertion: per key
      expect(db.tryLock("a:agent:nonce")).toBe(true); // assertion: the namespace separates it from a bare key
      db.unlock(k);
      expect(db.tryLock(k)).toBe(true); // assertion: released
      for (const x of [k, [rs.REPLAY_LOCK_NAMESPACE, "a:agent:other"], "a:agent:nonce"]) db.unlock(x);
    } finally {
      db.close();
    }
  });

  it("LMDB (legacy stores): the same lock contract, plus getEntry and resetReadTxn", async () => {
    const lmdb: any = await import(harperRequire.resolve("lmdb"));
    const db = lmdb.open({ path: join(tempDir("flair-replay-lmdb-"), "db") });
    try {
      for (const m of ["tryLock", "unlock", "getEntry", "resetReadTxn"]) expect(typeof db[m], m).toBe("function");
      const k = [rs.REPLAY_LOCK_NAMESPACE, "f:nonce"];
      expect(db.tryLock(k)).toBe(true);
      expect(db.tryLock(k)).toBe(false);
      db.unlock(k);
      expect(db.tryLock(k)).toBe(true);
      db.unlock(k);
    } finally {
      await db.close();
    }
  });
});
