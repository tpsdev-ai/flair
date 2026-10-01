// xaa-jti-probe-2073 — TEST-ONLY resource for flair#2073's two-worker test.
//
// test/helpers/component-with-replay-probe.ts copies this file into a PRIVATE
// composed copy of the built component as dist/resources/zz-xaa-jti-probe-2073.js.
// Nothing under resources/ references it and it is never packed or shipped.
//
// Harper loads it on every thread. On each HTTP worker it registers a handler
// on Harper's thread mesh; worker 0 then serves a test IdP's JWKS on an
// ephemeral loopback port, registers that IdP, drives a fixed scenario (each
// step sent to a chosen worker) and writes the results to
// <ROOTPATH>/xaa-jti-probe-2073/result.json for the test to assert on. Every
// grant calls handleJwtBearerGrant (resources/XAA.ts), the function the
// /OAuthToken jwt-bearer grant calls.
import { databases, server } from "harper";
import { isMainThread, threadId } from "node:worker_threads";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { handleJwtBearerGrant, jwtBearerBaseUrl } from "./XAA.js";

const threads = globalThis.threads;
const ROOT = process.env.ROOTPATH;
const OUT = ROOT ? join(ROOT, "xaa-jti-probe-2073") : null;
const idx = server.workerIndex;
const cnt = server.workerCount;
const OP_TIMEOUT_MS = 60_000;
const ISSUER = "https://idp.xaa-probe-2073.invalid";
const IDP_ID = "idp-xaa-probe-2073";
const RACE_ROUNDS = Number(process.env.XAA_PROBE_ROUNDS || 50);
const RACE_PER_WORKER = Number(process.env.XAA_PROBE_PER_WORKER || 8);
// Ports this probe must never reach: a production Flair's HTTP and ops API.
const FORBIDDEN_PORTS = new Set([9925, 9926]);

const log = (...a) => console.log(`[xaa-jti-probe-2073 w${idx}/${cnt} t${threadId}]`, ...a);
const write = (name, obj) => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, name), JSON.stringify(obj, null, 1));
};

function replayTable() {
  return databases.flair.IdJagReplay;
}

function storeEntry(key) {
  const t = replayTable();
  t.primaryStore.resetReadTxn?.();
  const e = t.primaryStore.getEntry(key);
  return { present: e != null, expiresAt: e?.expiresAt ?? null };
}

async function grant(assertion) {
  const r = await handleJwtBearerGrant({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion });
  if (r instanceof Response) {
    let body = null;
    try {
      body = await r.json();
    } catch {
      body = null;
    }
    return { ok: false, status: r.status, error: body?.error ?? null, description: body?.error_description ?? null };
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

// ── operations any worker runs on request ───────────────────────────────────
const ops = {
  async grant({ assertion }) {
    return grant(assertion);
  },
  async storeEntry({ key }) {
    return storeEntry(key);
  },
  async tableInfo() {
    const t = replayTable();
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
  // Every worker fires RACE_PER_WORKER grants of the SAME assertion at one
  // instant (barrier), once per round.
  async raceAll({ rounds }) {
    const accepted = [];
    for (const assertion of rounds) {
      await barrier(cnt);
      const results = await Promise.all(Array.from({ length: RACE_PER_WORKER }, () => grant(assertion)));
      accepted.push(results.filter((r) => r.ok).length);
    }
    return { accepted };
  },
  // THIS worker alone fires RACE_PER_WORKER grants of the same assertion at once.
  async raceHere({ rounds }) {
    const accepted = [];
    for (const assertion of rounds) {
      const results = await Promise.all(Array.from({ length: RACE_PER_WORKER }, () => grant(assertion)));
      accepted.push(results.filter((r) => r.ok).length);
    }
    return { accepted };
  },
  async failingStore({ assertion }) {
    // A store error on THIS worker: the table's write throws for one grant.
    const t = replayTable();
    const original = t.put;
    t.put = () => {
      throw new Error("xaa-jti-probe-2073: simulated store write failure");
    };
    try {
      return await grant(assertion);
    } finally {
      t.put = original;
    }
  },
  async putExpiring({ key, expiresInMs }) {
    // A control row whose expiry is set per record, to show the scan runs.
    const t = replayTable();
    await globalThis.transaction({ expiresAt: Date.now() + expiresInMs }, () => t.put({ id: key, seenAt: Date.now() }));
    return storeEntry(key);
  },
  async fastScan() {
    // Re-arm Harper's expiration scan every second with the table's own expiration.
    const t = replayTable();
    t.setTTLExpiration({ expiration: t.expirationMS / 1000, scanInterval: 1 });
    return { expirationMS: t.expirationMS };
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
    if (!threads.sendToThread(tidOf(i), { type: "xj2073-op", rid: id, from: threadId, op, args })) {
      clearTimeout(timer);
      pending.delete(id);
      reject(new Error(`worker ${i} unreachable`));
    }
  });
}
const all = (op, argsFor) => Promise.all(Array.from({ length: cnt }, (_, i) => call(i, op, argsFor ? argsFor(i) : {})));

// ── the test IdP (worker 0) ─────────────────────────────────────────────────
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
    name: "xaa-jti-probe-2073",
    issuer: ISSUER,
    jwksUri: `http://127.0.0.1:${port}/jwks`,
    clientId: "xaa-probe-client",
    jitProvision: true,
    defaultTrustTier: "unverified",
    enabled: true,
    createdAt: new Date().toISOString(),
  });
  return { jwksPort: port, audience };
}

async function assertion({ expInSec = 300, jti = randomUUID(), sub } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ scope: "memory:read" })
    .setProtectedHeader({ alg: "ES256", kid })
    .setIssuer(ISSUER)
    .setSubject(sub ?? `probe-user-${++subjectSeq}`)
    .setAudience(audience)
    .setJti(jti)
    .setIssuedAt(now)
    .setExpirationTime(now + expInSec)
    .sign(signingKey);
  return { token, jti, exp: now + expInSec };
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

async function scenario(idp) {
  const res = { workerCount: cnt, idp, workers: [] };
  for (let i = 0; i < cnt; i++) res.workers.push({ idx: i, threadId: tidOf(i) });
  res.tableInfo = await all("tableInfo");

  // 1. accepted on one worker → refused on every other, and again on the first
  res.crossWorker = await section(async () => {
    const steps = [];
    for (let a = 0; a < cnt; a++) {
      for (let b = 0; b < cnt; b++) {
        if (a === b) continue;
        const { token } = await assertion();
        const first = await call(a, "grant", { assertion: token });
        const other = await call(b, "grant", { assertion: token });
        const again = await call(a, "grant", { assertion: token });
        steps.push({ acceptedOn: a, retriedOn: b, first, other, again });
      }
    }
    return steps;
  });

  // 2. one worker fires RACE_PER_WORKER grants of one assertion at once
  res.raceHere = await section(async () => {
    const per = [];
    for (let w = 0; w < cnt; w++) {
      const rounds = [];
      for (let r = 0; r < RACE_ROUNDS; r++) rounds.push((await assertion()).token);
      const { accepted } = await call(w, "raceHere", { rounds });
      per.push({ worker: w, attemptsPerRound: RACE_PER_WORKER, accepted });
    }
    return per;
  });

  // 3. every worker fires RACE_PER_WORKER grants of one assertion at one instant
  res.raceAll = await section(async () => {
    const rounds = [];
    for (let r = 0; r < RACE_ROUNDS; r++) rounds.push((await assertion()).token);
    const per = await all("raceAll", () => ({ rounds }));
    return {
      rounds: RACE_ROUNDS,
      attemptsPerRound: cnt * RACE_PER_WORKER,
      acceptedPerRound: Array.from({ length: RACE_ROUNDS }, (_, r) => per.reduce((s, w) => s + w.accepted[r], 0)),
    };
  });

  // 4. a store error refuses the grant and records nothing; the store recovers
  res.storeError = await section(async () => {
    const failing = cnt - 1;
    const a = await assertion();
    const during = await call(failing, "failingStore", { assertion: a.token });
    return {
      worker: failing,
      during,
      entryWhileFailing: await call(0, "storeEntry", { key: a.jti }),
      sameAssertionAfterRecovery: await call(0, "grant", { assertion: a.token }),
    };
  });

  // 5. retention: an assertion that expires 24 h ahead is recorded with an
  //    expiry after its validity ends, and the record survives Harper's
  //    expiration scan (table's own expiration, scan re-armed to run every second)
  res.retention = await section(async () => {
    const armed = await all("fastScan");
    const longest = await assertion({ expInSec: 24 * 3600 });
    const accepted = await call(0, "grant", { assertion: longest.token });
    const controlKey = `probe:expired:${randomUUID()}`;
    const controlBefore = await call(cnt - 1, "putExpiring", { key: controlKey, expiresInMs: -1000 });
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 3500));
    return {
      armed,
      accepted,
      exp: longest.exp,
      waitedMs: Date.now() - t0,
      controlBefore,
      controlAfterScans: await call(0, "storeEntry", { key: controlKey }),
      entryAfterScans: await call(cnt - 1, "storeEntry", { key: longest.jti }),
      replayOnLastWorker: await call(cnt - 1, "grant", { assertion: longest.token }),
    };
  });

  return res;
}

// ── wiring ─────────────────────────────────────────────────────────────────
if (!isMainThread && OUT && typeof idx === "number" && typeof cnt === "number" && idx < cnt && threads) {
  threads.onMessageByType("xj2073-go", (msg) => {
    ia = new Int32Array(msg.sab);
    f64 = new Float64Array(msg.sab);
    Atomics.store(ia, 8 + idx, threadId);
  });
  threads.onMessageByType("xj2073-op", async (msg) => {
    let result;
    let error;
    try {
      result = await ops[msg.op](msg.args);
    } catch (e) {
      error = String(e?.stack || e);
    }
    threads.sendToThread(msg.from, { type: "xj2073-res", rid: msg.rid, result, error });
  });
  threads.onMessageByType("xj2073-res", (msg) => {
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
        for (const p of peers) threads.sendToThread(p.threadId, { type: "xj2073-go", sab });
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
