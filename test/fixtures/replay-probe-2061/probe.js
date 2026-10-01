// replay-probe-2061 — TEST-ONLY resource for flair#2061's two-worker test.
//
// test/helpers/component-with-replay-probe.ts copies this file into a PRIVATE
// composed copy of the built component as dist/resources/zz-replay-probe-2061.js.
// Nothing under resources/ references it and it is never packed or shipped.
//
// Harper loads it on every thread. On each HTTP worker it registers a handler
// on Harper's thread mesh; worker 0 then drives a fixed scenario, sending each
// step to a chosen worker and collecting the answers, and writes the results to
// <ROOTPATH>/replay-probe-2061/result.json for the test to assert on. Every
// step calls the SAME functions the server's request paths call:
//   - agent auth: verifyAgentRequest (resources/agent-auth.ts)
//   - federation: verifyFederationRequestBody (resources/replay-store.ts), or,
//     on a build without that module, verifyBodySignatureFresh with the nonce
//     store that build's Federation.ts passes it.
import { databases, server } from "harper";
import { isMainThread, threadId } from "node:worker_threads";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateKeyPairSync, sign as edSign, randomUUID } from "node:crypto";
import nacl from "tweetnacl";
import { verifyAgentRequest } from "./agent-auth.js";
import * as federationCrypto from "./federation-crypto.js";

const threads = globalThis.threads;
const ROOT = process.env.ROOTPATH;
const OUT = ROOT ? join(ROOT, "replay-probe-2061") : null;
const idx = server.workerIndex;
const cnt = server.workerCount;
const AGENT = "replay-probe-2061";
const OP_TIMEOUT_MS = 60_000;
const RACE_ROUNDS = Number(process.env.REPLAY_PROBE_ROUNDS || 200);
const RACE_PER_WORKER = Number(process.env.REPLAY_PROBE_PER_WORKER || 4);
const LATENCY_CALLS = Number(process.env.REPLAY_PROBE_LATENCY_CALLS || 2000);

const log = (...a) => console.log(`[replay-probe-2061 w${idx}/${cnt} t${threadId}]`, ...a);
const write = (name, obj) => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, name), JSON.stringify(obj, null, 1));
};

// ── version-appropriate entry points ────────────────────────────────────────
let replayStore = null; // resources/replay-store.js when this build has it
let legacyFedStore = null; // the nonce store of a build without replay-store.js
async function loadApis() {
  try {
    replayStore = await import("./replay-store.js");
  } catch {
    replayStore = null;
  }
  if (!replayStore) {
    try {
      const legacy = await import("./federation-nonce-store.js");
      legacyFedStore = legacy.createPersistentNonceStore();
    } catch {
      legacyFedStore = federationCrypto.createNonceStore();
    }
  }
}

function fakeRequest({ header, url, method }) {
  return {
    url,
    method,
    headers: { get: (n) => (String(n).toLowerCase() === "authorization" ? header : null), asObject: { authorization: header } },
  };
}

async function agentAttempt(args) {
  const auth = await verifyAgentRequest(fakeRequest(args));
  return !!auth;
}

async function fedAttempt({ body, pub }) {
  if (replayStore) {
    const r = await replayStore.verifyFederationRequestBody(body, pub);
    return { ok: r.ok, reason: r.reason ?? null };
  }
  const r = federationCrypto.verifyBodySignatureFresh(body, pub, { windowMs: 30_000, nonceStore: legacyFedStore });
  return { ok: r.ok, reason: r.reason ?? null };
}

function storeEntry(key) {
  const t = databases.flair.ReplayNonce;
  if (!t) return { present: null, reason: "no ReplayNonce table in this build" };
  t.primaryStore.resetReadTxn?.();
  return { present: t.primaryStore.getEntry(key) != null };
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

function pct(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
function stats(lat) {
  return { n: lat.length, p50: pct(lat, 50), p90: pct(lat, 90), p99: pct(lat, 99), max: pct(lat, 100) };
}

// ── operations any worker runs on request ───────────────────────────────────
const ops = {
  async agent(args) {
    return { accepted: await agentAttempt(args) };
  },
  async fed(args) {
    return await fedAttempt(args);
  },
  async storeEntry({ key }) {
    return storeEntry(key);
  },
  async race({ kind, rounds }) {
    const accepted = [];
    for (const round of rounds) {
      await barrier(cnt);
      const attempts = Array.from({ length: RACE_PER_WORKER }, () =>
        kind === "agent" ? agentAttempt(round) : fedAttempt(round).then((r) => r.ok),
      );
      const results = await Promise.all(attempts);
      accepted.push(results.filter(Boolean).length);
    }
    return { accepted };
  },
  async heldFailingWrite({ args }) {
    // THIS worker's next write to the table waits until the driver releases it
    // (ia[7]), then fails. Meanwhile the claim making it holds the key's lock;
    // ia[6] tells the driver that it is inside the write.
    const t = databases.flair.ReplayNonce;
    if (!t) return { skipped: "no ReplayNonce table in this build" };
    const original = t.put;
    t.put = async () => {
      t.put = original;
      Atomics.store(ia, 6, 1);
      Atomics.notify(ia, 6);
      while (Atomics.load(ia, 7) === 0) {
        const r = Atomics.waitAsync(ia, 7, 0, 10_000);
        if (r.async) await r.value;
      }
      throw new Error("replay-probe-2061: simulated store write failure (held)");
    };
    try {
      return { accepted: await agentAttempt(args) };
    } finally {
      t.put = original;
    }
  },
  async failingStore({ args }) {
    // A store error on THIS worker: the table's write throws for one request.
    const t = databases.flair.ReplayNonce;
    if (!t) return { skipped: "no ReplayNonce table in this build" };
    const original = t.put;
    t.put = () => {
      throw new Error("replay-probe-2061: simulated store write failure");
    };
    try {
      return { accepted: await agentAttempt(args) };
    } finally {
      t.put = original;
    }
  },
  async tableInfo() {
    const t = databases.flair.ReplayNonce;
    if (!t) return { present: false };
    const s = t.primaryStore;
    return {
      present: true,
      replicate: t.replicate ?? null,
      audit: t.audit ?? null,
      expirationMS: t.expirationMS ?? null,
      primaryStoreClass: s?.constructor?.name ?? null,
      tryLock: typeof s?.tryLock,
      unlock: typeof s?.unlock,
      getEntry: typeof s?.getEntry,
      bootGaps: replayStore ? replayStore.replayStoreBootGaps() : null,
    };
  },
  async putExpiring({ key, expiresInMs }) {
    // A control row whose expiry is set per record, to show the scan runs.
    const t = databases.flair.ReplayNonce;
    if (!t) return { skipped: true };
    await globalThis.transaction({ expiresAt: Date.now() + expiresInMs }, () => t.put({ id: key, seenAt: Date.now() }));
    return storeEntry(key);
  },
  async fastScan() {
    // Re-arm Harper's expiration scan every second with the PRODUCTION expiration.
    const t = databases.flair.ReplayNonce;
    if (!t) return { skipped: true };
    t.setTTLExpiration({ expiration: t.expirationMS / 1000, scanInterval: 1 });
    return { expirationMS: t.expirationMS };
  },
  async latency({ concurrent }) {
    if (!replayStore) return { skipped: "legacy build" };
    const g = replayStore.federationReplayGuard;
    const keysA = Array.from({ length: LATENCY_CALLS }, () => `lat:${randomUUID()}`);
    const map = new Map();
    const base = [];
    for (const k of keysA) {
      const t0 = performance.now();
      if (!map.has(k)) map.set(k, Date.now());
      base.push(performance.now() - t0);
    }
    if (concurrent) await barrier(cnt);
    const lat = [];
    const verdicts = {};
    for (const k of keysA) {
      const t0 = performance.now();
      const v = await g.claim(k);
      lat.push(performance.now() - t0);
      verdicts[v] = (verdicts[v] || 0) + 1;
    }
    return { map: stats(base), claim: stats(lat), verdicts };
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
    if (!threads.sendToThread(tidOf(i), { type: "rp2061-op", rid: id, from: threadId, op, args })) {
      clearTimeout(timer);
      pending.delete(id);
      reject(new Error(`worker ${i} unreachable`));
    }
  });
}
const all = (op, argsFor) => Promise.all(Array.from({ length: cnt }, (_, i) => call(i, op, argsFor ? argsFor(i) : {})));

// ── signed inputs (built on worker 0) ───────────────────────────────────────
const agentKeys = generateKeyPairSync("ed25519");
const AGENT_PUB_HEX = Buffer.from(agentKeys.publicKey.export({ format: "jwk" }).x, "base64url").toString("hex");
function agentHeader({ nonce = randomUUID(), bad = false, url = "/Memory?limit=1", method = "GET" } = {}) {
  const u = new URL(url, "http://localhost");
  const ts = Date.now().toString();
  const payload = `${AGENT}:${ts}:${nonce}:${method}:${u.pathname}${u.search}`;
  const sig = edSign(null, Buffer.from(bad ? payload + "x" : payload), agentKeys.privateKey).toString("base64");
  return { header: `TPS-Ed25519 ${AGENT}:${ts}:${nonce}:${sig}`, url, method, nonce };
}
const fedKeys = nacl.sign.keyPair();
const FED_PUB = Buffer.from(fedKeys.publicKey).toString("base64url");
function fedBody() {
  return { body: federationCrypto.signBodyFresh({ instanceId: "probe-spoke", records: [] }, fedKeys.secretKey), pub: FED_PUB };
}

async function scenario() {
  const res = { workerCount: cnt, api: replayStore ? "replay-store" : "legacy", workers: [] };
  for (let i = 0; i < cnt; i++) res.workers.push({ idx: i, threadId: tidOf(i) });

  await databases.flair.Agent.put({
    id: AGENT,
    name: AGENT,
    publicKey: AGENT_PUB_HEX,
    status: "active",
    kind: "agent",
    createdAt: new Date().toISOString(),
  });

  res.tableInfo = await all("tableInfo");

  // 1. accepted on one worker → refused on every other (and again on the first)
  res.crossWorker = { agent: [], federation: [] };
  for (let a = 0; a < cnt; a++) {
    for (let b = 0; b < cnt; b++) {
      if (a === b) continue;
      const h = agentHeader();
      const first = (await call(a, "agent", h)).accepted;
      const other = (await call(b, "agent", h)).accepted;
      const again = (await call(a, "agent", h)).accepted;
      res.crossWorker.agent.push({ acceptedOn: a, retriedOn: b, first, other, again });
      const f = fedBody();
      const ff = await call(a, "fed", f);
      const fo = await call(b, "fed", f);
      res.crossWorker.federation.push({ acceptedOn: a, retriedOn: b, first: ff, other: fo });
    }
  }

  // 2. every worker fires RACE_PER_WORKER attempts with the SAME input at one instant
  const agentRounds = Array.from({ length: RACE_ROUNDS }, () => agentHeader());
  const fedRounds = Array.from({ length: RACE_ROUNDS }, () => fedBody());
  const ra = await all("race", () => ({ kind: "agent", rounds: agentRounds }));
  const rf = await all("race", () => ({ kind: "fed", rounds: fedRounds }));
  const sumRounds = (per) => Array.from({ length: RACE_ROUNDS }, (_, r) => per.reduce((s, w) => s + w.accepted[r], 0));
  res.race = {
    rounds: RACE_ROUNDS,
    attemptsPerRound: cnt * RACE_PER_WORKER,
    agentAcceptedPerRound: sumRounds(ra),
    federationAcceptedPerRound: sumRounds(rf),
  };

  // 3. a signature failure records nothing: the valid request with that nonce is accepted
  {
    const nonce = randomUUID();
    const bad = agentHeader({ nonce, bad: true });
    const good = agentHeader({ nonce });
    const other = cnt > 1 ? 1 : 0;
    res.sigFail = {
      badAccepted: (await call(0, "agent", bad)).accepted,
      entryAfterBad: await call(other, "storeEntry", { key: `a:${AGENT}:${nonce}` }),
      goodAcceptedOnOther: (await call(other, "agent", good)).accepted,
      goodRetriedOnFirst: (await call(0, "agent", good)).accepted,
    };
  }

  // 4. a store error refuses the request; the store recovers afterwards
  {
    const failing = cnt - 1;
    const h = agentHeader();
    const during = await call(failing, "failingStore", { args: h });
    res.storeError = {
      worker: failing,
      acceptedWhileFailing: during.accepted ?? null,
      skipped: during.skipped ?? null,
      entryWhileFailing: await call(0, "storeEntry", { key: `a:${AGENT}:${h.nonce}` }),
      sameNonceAfterRecovery: (await call(0, "agent", agentHeader({ nonce: h.nonce }))).accepted,
    };
  }

  // 4b. a request that misses the key's lock is refused but not remembered: the
  //     last worker holds the lock while its write fails, then the same nonce is
  //     accepted on worker 0, the worker that missed the lock.
  {
    const holderWorker = cnt - 1;
    const h = agentHeader();
    Atomics.store(ia, 6, 0);
    Atomics.store(ia, 7, 0);
    let holderSettled = false;
    const holderDone = call(holderWorker, "heldFailingWrite", { args: h }).finally(() => {
      holderSettled = true;
    });
    const deadline = Date.now() + 30_000;
    while (Atomics.load(ia, 6) === 0 && !holderSettled) {
      if (Date.now() > deadline) throw new Error(`worker ${holderWorker} never reached its held write`);
      await new Promise((r) => setTimeout(r, 10));
    }
    const reachedWrite = Atomics.load(ia, 6) === 1;
    const contendedAccepted = (await call(0, "agent", agentHeader({ nonce: h.nonce }))).accepted;
    Atomics.store(ia, 7, 1);
    Atomics.notify(ia, 7);
    const holder = await holderDone;
    res.lockMiss = {
      holderWorker,
      skipped: holder.skipped ?? null,
      reachedWrite,
      contendedAccepted,
      holderAccepted: holder.accepted ?? null,
      entryAfterFailedWrite: await call(0, "storeEntry", { key: `a:${AGENT}:${h.nonce}` }),
      retryAccepted: (await call(0, "agent", agentHeader({ nonce: h.nonce }))).accepted,
      replayAfterRetry: (await call(holderWorker, "agent", agentHeader({ nonce: h.nonce }))).accepted,
    };
  }

  // 5. an in-window entry survives Harper's expiration scan (production expiration,
  //    scan re-armed to run every second on the last worker)
  {
    const armed = await all("fastScan");
    const h = agentHeader();
    const accepted = (await call(0, "agent", h)).accepted;
    const controlKey = `probe:expired:${randomUUID()}`;
    const controlBefore = await call(cnt - 1, "putExpiring", { key: controlKey, expiresInMs: -1000 });
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 3500));
    res.eviction = {
      armed,
      accepted,
      waitedMs: Date.now() - t0,
      controlBefore,
      controlAfterScans: await call(0, "storeEntry", { key: controlKey }),
      entryAfterScans: await call(cnt - 1, "storeEntry", { key: `a:${AGENT}:${h.nonce}` }),
      replayOnLastWorker: (await call(cnt - 1, "agent", h)).accepted,
    };
  }

  // 6. added latency of the store claim (RocksDB), one worker then all at once
  res.latency = {
    single: await call(0, "latency", { concurrent: false }),
    concurrent: await all("latency", () => ({ concurrent: true })),
  };

  return res;
}

// ── wiring ─────────────────────────────────────────────────────────────────
if (!isMainThread && OUT && typeof idx === "number" && typeof cnt === "number" && idx < cnt && threads) {
  const ready = loadApis();
  threads.onMessageByType("rp2061-go", (msg) => {
    ia = new Int32Array(msg.sab);
    f64 = new Float64Array(msg.sab);
    Atomics.store(ia, 8 + idx, threadId);
  });
  threads.onMessageByType("rp2061-op", async (msg) => {
    let result;
    let error;
    try {
      await ready;
      result = await ops[msg.op](msg.args);
    } catch (e) {
      error = String(e?.stack || e);
    }
    threads.sendToThread(msg.from, { type: "rp2061-res", rid: msg.rid, result, error });
  });
  threads.onMessageByType("rp2061-res", (msg) => {
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
        await ready;
        const sab = new SharedArrayBuffer(8 * 64);
        ia = new Int32Array(sab);
        f64 = new Float64Array(sab);
        Atomics.store(ia, 8, threadId);
        for (const p of peers) threads.sendToThread(p.threadId, { type: "rp2061-go", sab });
        // wait until every worker has written its threadId into the SAB
        const deadline = Date.now() + 30_000;
        while ([...Array(cnt).keys()].some((i) => !Atomics.load(ia, 8 + i))) {
          if (Date.now() > deadline) throw new Error(`only some workers joined: ${[...Array(cnt).keys()].map((i) => Atomics.load(ia, 8 + i))}`);
          await new Promise((r) => setTimeout(r, 50));
        }
        const result = await scenario();
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
