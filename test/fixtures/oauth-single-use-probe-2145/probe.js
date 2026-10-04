// oauth-single-use-probe-2145 — TEST-ONLY resource for flair#2145's two-worker test.
//
// test/helpers/component-with-replay-probe.ts copies this file into a PRIVATE
// composed copy of the built component as
// dist/resources/zz-oauth-single-use-probe-2145.js. Nothing under resources/
// references it and it is never packed or shipped.
//
// Harper loads it on every thread. On each HTTP worker it registers a handler
// on Harper's thread mesh; worker 0 then serves a test IdP's JWKS on an
// ephemeral loopback port, registers that IdP, drives a fixed scenario (each
// step sent to a chosen worker) and writes the results to
// <ROOTPATH>/oauth-single-use-probe-2145/result.json for the test to assert on.
// The authorization-code and refresh-token step calls OAuthToken.post
// (resources/OAuth.ts), the method the /OAuthToken grant calls; the long-`jti`
// step calls handleJwtBearerGrant (resources/XAA.ts).
import { databases, server } from "harper";
import { isMainThread, threadId } from "node:worker_threads";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { handleJwtBearerGrant, jwtBearerBaseUrl } from "./XAA.js";
import { OAuthToken } from "./OAuth.js";

const threads = globalThis.threads;
const ROOT = process.env.ROOTPATH;
const OUT = ROOT ? join(ROOT, "oauth-single-use-probe-2145") : null;
const idx = server.workerIndex;
const cnt = server.workerCount;
const OP_TIMEOUT_MS = 60_000;
const REDIRECT = "https://claude.com/api/mcp/auth_callback";
const CLIENT_ID = "flair_cl_probe2145";
const PRINCIPAL = "agent-probe-2145";
const SCOPE = "memory:read";
const RACE_ROUNDS = Number(process.env.OAUTH_PROBE_ROUNDS || 20);
const RACE_PER_WORKER = Number(process.env.OAUTH_PROBE_PER_WORKER || 4);
// Longer than the store's key limit, so the record's write fails.
const LONG_JTI = Number(process.env.OAUTH_PROBE_LONG_JTI || 4096);
const ISSUER = "https://idp.oauth-probe-2145.invalid";
const IDP_ID = "idp-oauth-probe-2145";
// Ports this probe must never reach: a production Flair's HTTP and ops API.
const FORBIDDEN_PORTS = new Set([9925, 9926]);

const log = (...a) => console.log(`[oauth-single-use-probe-2145 w${idx}/${cnt} t${threadId}]`, ...a);
const write = (name, obj) => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, name), JSON.stringify(obj, null, 1));
};

const sha256 = (input) => createHash("sha256").update(input).digest("hex");
const codeKey = (code) => `c:${sha256(code)}`;
const refreshKey = (raw) => `r:${sha256(raw)}`;

function singleUseTable() {
  return databases.flair.OAuthSingleUse;
}
function entryOf(table, key) {
  table.primaryStore.resetReadTxn?.();
  const e = table.primaryStore.getEntry(key);
  return { present: e != null, expiresAt: e?.expiresAt ?? null };
}

async function redeem(body) {
  const r = await new OAuthToken().post(body);
  if (r instanceof Response) {
    let parsed = null;
    try {
      parsed = await r.json();
    } catch {
      parsed = null;
    }
    return { ok: false, status: r.status, error: parsed?.error ?? null, description: parsed?.error_description ?? null };
  }
  return { ok: typeof r?.access_token === "string", status: 200, error: null, description: null };
}

// ── barrier over a SharedArrayBuffer (ia[0]=arrived, ia[1]=generation, ia[8+i]=threadId of worker i)
let ia;
let f64;
async function barrier(n) {
  const gen = Atomics.load(ia, 1);
  if (Atomics.add(ia, 0, 1) === n - 1) {
    Atomics.store(ia, 0, 0);
    f64[2] = performance.timeOrigin + performance.now() + 2;
    Atomics.add(ia, 1, 1);
    Atomics.notify(ia, 1);
  } else {
    while (Atomics.load(ia, 1) === gen) {
      const r = Atomics.waitAsync(ia, 1, gen, 10_000);
      if (r.async) await r.value;
    }
  }
  const at = f64[2];
  while (performance.timeOrigin + performance.now() < at) {} // spin to one shared instant
}

/** Mint one value of `kind` on THIS worker and return what a redemption needs. */
async function mint(kind, seq) {
  if (kind === "code") {
    const code = `probe-code-${seq}-${idx}-${randomBytes(8).toString("hex")}`;
    const verifier = `${randomBytes(24).toString("base64url")}-verifier`;
    await databases.flair.OAuthAuthCode.put({
      id: code,
      clientId: CLIENT_ID,
      principalId: PRINCIPAL,
      redirectUri: REDIRECT,
      scope: SCOPE,
      codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
      codeChallengeMethod: "S256",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      used: false,
      createdAt: new Date().toISOString(),
    });
    return { kind, code, verifier };
  }
  const raw = `flair_rt_probe_${seq}_${idx}_${randomBytes(8).toString("hex")}`;
  await databases.flair.OAuthToken.put({
    id: `rt_probe_${seq}_${idx}_${randomBytes(4).toString("hex")}`,
    tokenHash: sha256(raw),
    tokenType: "refresh",
    clientId: CLIENT_ID,
    principalId: PRINCIPAL,
    scope: SCOPE,
    expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
    createdAt: new Date().toISOString(),
  });
  return { kind, raw };
}

const redemptionBody = (value) =>
  value.kind === "code"
    ? { grant_type: "authorization_code", code: value.code, client_id: CLIENT_ID, redirect_uri: REDIRECT, code_verifier: value.verifier }
    : { grant_type: "refresh_token", refresh_token: value.raw, client_id: CLIENT_ID };

const valueEntry = (value) => entryOf(singleUseTable(), value.kind === "code" ? codeKey(value.code) : refreshKey(value.raw));

// ── operations any worker runs on request ───────────────────────────────────
const ops = {
  async tableInfo() {
    const t = singleUseTable();
    if (!t) return { present: false };
    const s = t.primaryStore;
    return {
      present: true,
      replicate: t.replicate ?? null,
      expirationMS: t.expirationMS ?? null,
      tryLock: typeof s?.tryLock,
      unlock: typeof s?.unlock,
      getEntry: typeof s?.getEntry,
    };
  },
  async mint({ kind, seq }) {
    return mint(kind, seq);
  },
  async redeem({ value }) {
    return redeem(redemptionBody(value));
  },
  async storeEntry({ value, jti }) {
    if (jti !== undefined) return entryOf(databases.flair.IdJagReplay, jti);
    return valueEntry(value);
  },
  // Every worker fires RACE_PER_WORKER redemptions of the SAME value at one
  // instant (barrier), once per round.
  async raceAll({ values }) {
    const accepted = [];
    for (const value of values) {
      await barrier(cnt);
      const results = await Promise.all(Array.from({ length: RACE_PER_WORKER }, () => redeem(redemptionBody(value))));
      accepted.push({ kind: value.kind, accepted: results.filter((r) => r.ok).length, statuses: results.map((r) => r.status) });
    }
    return { accepted };
  },
  // THIS worker alone fires RACE_PER_WORKER redemptions of the same value at once.
  async raceHere({ values }) {
    const accepted = [];
    for (const value of values) {
      const results = await Promise.all(Array.from({ length: RACE_PER_WORKER }, () => redeem(redemptionBody(value))));
      accepted.push({ kind: value.kind, accepted: results.filter((r) => r.ok).length, statuses: results.map((r) => r.status) });
    }
    return { accepted };
  },
  async failingStore({ value }) {
    // A store error on THIS worker: the record table's write throws for one redemption.
    const t = singleUseTable();
    const original = t.put;
    t.put = () => {
      throw new Error("oauth-single-use-probe-2145: simulated store write failure");
    };
    try {
      return await redeem(redemptionBody(value));
    } finally {
      t.put = original;
    }
  },
};

// ── request/reply over Harper's thread mesh ────────────────────────────────
let rid = 0;
const pending = new Map();
const tidOf = (i) => Atomics.load(ia, 8 + i);
function call(i, op, args = {}) {
  if (i === idx) return ops[op](args);
  return new Promise((resolve, reject) => {
    const id = ++rid;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`op ${op} on worker ${i} timed out`));
    }, OP_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    if (!threads.sendToThread(tidOf(i), { type: "oj2145-op", rid: id, from: threadId, op, args })) {
      clearTimeout(timer);
      pending.delete(id);
      reject(new Error(`worker ${i} unreachable`));
    }
  });
}
const all = (op, argsFor) => Promise.all(Array.from({ length: cnt }, (_, i) => call(i, op, argsFor ? argsFor(i) : {})));

// ── the test IdP (worker 0), for the long-jti step ─────────────────────────
let signingKey;
let kid;
let audience;
let subjectSeq = 0;
async function startIdp() {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  signingKey = privateKey;
  kid = `k-${randomUUID()}`;
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: "ES256", use: "sig" };
  const body = JSON.stringify({ keys: [jwk] });
  const srv = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body);
  });
  await new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", resolve);
  });
  srv.unref();
  const { address, port } = srv.address();
  if (address !== "127.0.0.1" || FORBIDDEN_PORTS.has(port)) throw new Error(`JWKS server bound ${address}:${port}, not an ephemeral loopback port`);
  audience = jwtBearerBaseUrl();
  const audPort = Number(new URL(audience).port);
  if (FORBIDDEN_PORTS.has(audPort)) throw new Error(`audience ${audience} names a production port`);
  await databases.flair.IdpConfig.put({
    id: IDP_ID,
    name: "oauth-single-use-probe-2145",
    issuer: ISSUER,
    jwksUri: `http://127.0.0.1:${port}/jwks`,
    clientId: "probe-client-2145",
    jitProvision: true,
    defaultTrustTier: "unverified",
    enabled: true,
    createdAt: new Date().toISOString(),
  });
  return { jwksPort: port, audience };
}

async function assertion({ jti, expInSec = 300 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ scope: "memory:read" })
    .setProtectedHeader({ alg: "ES256", kid })
    .setIssuer(ISSUER)
    .setSubject(`probe-user-${++subjectSeq}`)
    .setAudience(audience)
    .setJti(jti ?? randomUUID())
    .setIssuedAt(now)
    .setExpirationTime(now + expInSec)
    .sign(signingKey);
  return token;
}

/** Drive the jwt-bearer grant (resources/XAA.ts), the function /OAuthToken calls. */
async function jwtBearer(token) {
  const r = await handleJwtBearerGrant({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: token });
  if (r instanceof Response) {
    let parsed = null;
    try {
      parsed = await r.json();
    } catch {
      parsed = null;
    }
    return { ok: false, status: r.status, error: parsed?.error ?? null, description: parsed?.error_description ?? null };
  }
  return { ok: typeof r?.access_token === "string", status: 200, error: null, description: null };
}

// A section that throws records its error and the scenario carries on, so one
// failing step shows up as that step's failed assertions.
async function section(fn) {
  try {
    return await fn();
  } catch (e) {
    return { error: String(e?.stack || e) };
  }
}

let seq = 0;

async function scenario(idp) {
  const res = { workerCount: cnt, idp, workers: [] };
  for (let i = 0; i < cnt; i++) res.workers.push({ idx: i, threadId: tidOf(i) });
  res.tableInfo = await all("tableInfo");

  // 1. a code redeemed on one worker is refused on the other, and again on the first
  res.codeCrossWorker = await section(async () => {
    const steps = [];
    for (let a = 0; a < cnt; a++) {
      for (let b = 0; b < cnt; b++) {
        if (a === b) continue;
        const value = await call(0, "mint", { kind: "code", seq: ++seq });
        const first = await call(a, "redeem", { value });
        const other = await call(b, "redeem", { value });
        const again = await call(a, "redeem", { value });
        const entry = await call(0, "storeEntry", { value });
        steps.push({ acceptedOn: a, retriedOn: b, first, other, again, key: value.kind === "code" ? codeKey(value.code) : null, entry });
      }
    }
    return steps;
  });

  // 2. a refresh token rotated on one worker is refused on the other
  res.refreshCrossWorker = await section(async () => {
    const steps = [];
    for (let a = 0; a < cnt; a++) {
      for (let b = 0; b < cnt; b++) {
        if (a === b) continue;
        const value = await call(0, "mint", { kind: "refresh", seq: ++seq });
        const first = await call(a, "redeem", { value });
        const other = await call(b, "redeem", { value });
        const again = await call(a, "redeem", { value });
        const entry = await call(0, "storeEntry", { value });
        steps.push({ rotatedOn: a, retriedOn: b, first, other, again, key: refreshKey(value.raw), entry });
      }
    }
    return steps;
  });

  // 3. one worker fires RACE_PER_WORKER redemptions of one value at once
  res.raceHere = await section(async () => {
    const per = [];
    for (const kind of ["code", "refresh"]) {
      for (let w = 0; w < cnt; w++) {
        const values = [];
        for (let r = 0; r < RACE_ROUNDS; r++) values.push(await call(0, "mint", { kind, seq: ++seq }));
        const { accepted } = await call(w, "raceHere", { values });
        per.push({ kind, worker: w, attemptsPerRound: RACE_PER_WORKER, accepted: accepted.map((a) => a.accepted), statuses: accepted[0].statuses });
      }
    }
    return per;
  });

  // 4. every worker fires RACE_PER_WORKER redemptions of one value at one instant
  res.raceAll = await section(async () => {
    const out = [];
    for (const kind of ["code", "refresh"]) {
      const values = [];
      for (let r = 0; r < RACE_ROUNDS; r++) values.push(await call(0, "mint", { kind, seq: ++seq }));
      const per = await all("raceAll", () => ({ values }));
      out.push({
        kind,
        rounds: RACE_ROUNDS,
        attemptsPerRound: cnt * RACE_PER_WORKER,
        acceptedPerRound: Array.from({ length: RACE_ROUNDS }, (_, r) => per.reduce((s, w) => s + w.accepted[r].accepted, 0)),
      });
    }
    return out;
  });

  // 5. a store error refuses the redemption and records nothing; the store recovers
  res.storeError = await section(async () => {
    const worker = cnt - 1;
    const out = {};
    for (const kind of ["code", "refresh"]) {
      const value = await call(0, "mint", { kind, seq: ++seq });
      const during = await call(worker, "failingStore", { value });
      out[kind] = {
        worker,
        during,
        entryWhileFailing: await call(0, "storeEntry", { value }),
        sameValueAfterRecovery: await call(0, "redeem", { value }),
      };
    }
    return out;
  });

  // 6. a very long jti: the record's key exceeds what the store can encode, so
  //    the store call fails and the grant refuses with 503
  res.longJti = await section(async () => {
    const jti = "j".repeat(LONG_JTI);
    const accepted = await jwtBearer(await assertion({ jti }));
    let entry;
    try {
      entry = await call(0, "storeEntry", { jti }); // the store cannot even read a key this long
    } catch (e) {
      entry = { error: String(e?.message ?? e) };
    }
    return {
      length: LONG_JTI,
      accepted,
      entry,
      normalJtiAccepted: await jwtBearer(await assertion()),
    };
  });

  return res;
}

// ── wiring ─────────────────────────────────────────────────────────────────
if (!isMainThread && OUT && typeof idx === "number" && typeof cnt === "number" && idx < cnt && threads) {
  threads.onMessageByType("oj2145-go", (msg) => {
    ia = new Int32Array(msg.sab);
    f64 = new Float64Array(msg.sab);
    Atomics.store(ia, 8 + idx, threadId);
  });
  threads.onMessageByType("oj2145-op", async (msg) => {
    let result;
    let error;
    try {
      result = await ops[msg.op](msg.args);
    } catch (e) {
      error = String(e?.stack || e);
    }
    threads.sendToThread(msg.from, { type: "oj2145-res", rid: msg.rid, result, error });
  });
  threads.onMessageByType("oj2145-res", (msg) => {
    const p = pending.get(msg.rid);
    if (!p) return;
    pending.delete(msg.rid);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
  });
  if (idx === 0) {
    const started = Date.now();
    const iv = setInterval(async () => {
      const peers = threads.filter((p) => p.threadId && p.threadId !== 0 && !p.isJobWorker);
      if (peers.length < cnt - 1 && Date.now() - started < 90_000) return;
      clearInterval(iv);
      try {
        const sab = new SharedArrayBuffer(8 * 64);
        ia = new Int32Array(sab);
        f64 = new Float64Array(sab);
        Atomics.store(ia, 8, threadId);
        for (const p of peers) threads.sendToThread(p.threadId, { type: "oj2145-go", sab });
        const deadline = Date.now() + 30_000;
        while ([...Array(cnt).keys()].some((i) => !Atomics.load(ia, 8 + i))) {
          if (Date.now() > deadline) throw new Error(`only some workers joined: ${[...Array(cnt).keys()].map((i) => Atomics.load(ia, 8 + i))}`);
          await new Promise((r) => setTimeout(r, 50));
        }
        const idp = await startIdp();
        const result = await scenario(idp);
        write("result.json", result);
        write("done.json", { ok: true, at: new Date().toISOString() });
        log("done");
      } catch (e) {
        log("FATAL", e?.stack || e);
        write("fatal.json", { error: String(e?.stack || e) });
      }
    }, 250);
  }
}
