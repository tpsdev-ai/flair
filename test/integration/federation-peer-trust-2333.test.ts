// federation-peer-trust-2333.test.ts — flair#2333 slice 1, the federation
// peer-trust writes, driven against real Harper with the shared transaction
// pause points:
//   H1 `POST /FederationPair` pairing-token consume: one token, two pairings.
//   H2 `POST /FederationSync` peer status: a revoke that commits during the sync.
//   H3 `POST /FederationPair` re-pair: a peer revoked before, or during, the re-pair.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import { signBodyFresh } from "../../resources/federation-crypto.js";
import { ensureFlairPairInitiatorRole } from "../../src/cli";
import { startHarper, stopHarper, type HarperInstance } from "../helpers/harper-lifecycle";
import { componentWithFailingRepairPeerWrite, type FailingComponent } from "../helpers/host-pointer-failing-component";

const sfx = Date.now().toString(36);
const now = () => new Date().toISOString();
const later = (ms: number) => new Date(Date.now() + ms).toISOString();
const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

let harper: HarperInstance;
let component: FailingComponent;
let pauseDir: string;

/** Refuse any target that is not the ephemeral instance this file started. */
function assertOwnInstance(h: HarperInstance): void {
  for (const url of [h.httpURL, h.opsURL]) {
    const u = new URL(url);
    expect(["127.0.0.1", "localhost"], url).toContain(u.hostname);
    expect(["9925", "9926"], `${url} must be this test's own Harper`).not.toContain(u.port);
  }
  if (!h.installDir.startsWith(tmpdir())) throw new Error(`refusing to run: ${h.installDir} is not a temp tree`);
}

function opsAuth(): string {
  return "Basic " + btoa(`${harper.admin.username}:${harper.admin.password}`);
}

async function ops(operation: Record<string, unknown>): Promise<any> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: opsAuth() },
    body: JSON.stringify(operation),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  expect(res.status, `${operation.operation}: ${text.slice(0, 300)}`).toBe(200);
  return text.length > 0 ? JSON.parse(text) : undefined;
}

async function seedPeer(id: string, publicKey: string, status = "paired"): Promise<void> {
  await ops({
    operation: "insert", database: "flair", table: "Peer",
    records: [{ id, publicKey, role: "spoke", status, createdAt: now() }],
  });
}

async function readPeer(id: string): Promise<any> {
  const rows = await ops({
    operation: "search_by_hash", database: "flair", table: "Peer",
    hash_values: [id], get_attributes: ["*"],
  });
  return (rows as any[])[0] ?? null;
}

/** The competing operation's own RESULT — its HTTP status AND the peer row it left. */
async function revokePeer(id: string): Promise<{ status: number; row: any }> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: opsAuth() },
    body: JSON.stringify({
      operation: "update", database: "flair", table: "Peer",
      records: [{ id, status: "revoked", updatedAt: now() }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: res.status, row: await readPeer(id) };
}

async function seedToken(token: string): Promise<void> {
  await ops({
    operation: "insert", database: "flair", table: "PairingToken",
    records: [{ id: token, createdBy: "admin", expiresAt: later(3_600_000), createdAt: now() }],
  });
}

async function readToken(token: string): Promise<any> {
  const rows = await ops({
    operation: "search_by_hash", database: "flair", table: "PairingToken",
    hash_values: [token], get_attributes: ["*"],
  });
  return (rows as any[])[0] ?? null;
}

function pairBody(instanceId: string, publicKey: string, secretKey: Uint8Array, pairingToken?: string) {
  return signBodyFresh(
    { instanceId, publicKey, role: "spoke", endpoint: null, ...(pairingToken ? { pairingToken } : {}) },
    secretKey,
  );
}

function pairRequest(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${harper.httpURL}/FederationPair`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
}

/** A pairing request carrying a Basic credential (the token's bootstrap user). */
function pairRequestBasic(body: Record<string, unknown>, user: string, pass: string): Promise<Response> {
  return fetch(`${harper.httpURL}/FederationPair`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Basic " + btoa(`${user}:${pass}`) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
}

function syncRequest(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${harper.httpURL}/FederationSync`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
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
 * Arm `point`, start `trigger`, run `compete` once the trigger is paused inside
 * that point, release, and await the trigger.
 */
async function withPaused<T>(point: string, trigger: () => Promise<Response>, compete: () => Promise<T>) {
  for (const marker of ["claimed", "paused", "go", "released"]) rmSync(join(pauseDir, `${marker}.${point}`), { force: true });
  writeFileSync(join(pauseDir, `arm.${point}`), "");
  const pending = trigger();
  const paused = await waitFor(join(pauseDir, `paused.${point}`), 20_000);
  let competed: T | undefined;
  try {
    if (paused) competed = await compete();
  } finally {
    writeFileSync(join(pauseDir, `go.${point}`), "");
  }
  const response = await pending;
  const released = paused ? readFileSync(join(pauseDir, `released.${point}`), "utf8") : "never paused";
  return { response, competed, released, paused };
}

beforeAll(async () => {
  pauseDir = mkdtempSync(join(tmpdir(), "flair-2333-pause-"));
  const saved = {
    FLAIR_ENABLE_TEST_FAULT_INJECTION: process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION,
    FLAIR_TEST_PAUSE_DIR: process.env.FLAIR_TEST_PAUSE_DIR,
  };
  process.env.FLAIR_ENABLE_TEST_FAULT_INJECTION = "1";
  process.env.FLAIR_TEST_PAUSE_DIR = pauseDir;
  try {
    // The whole file runs against a composed copy of the built component that
    // adds the failing re-pair Peer-write module (test/helpers/
    // host-pointer-failing-component.ts). The module is inert until a test arms
    // its marker file, so every other case runs production code paths.
    component = componentWithFailingRepairPeerWrite();
    harper = await startHarper({ cwd: component.dir });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assertOwnInstance(harper);
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (component) component.cleanup();
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
});

describe("flair#2333 — a pairing token pairs at most one peer (real Harper)", () => {
  it("two concurrent pairings with the same token: one consumes it, the other is refused", async () => {
    const token = `pt-h1-${sfx}`;
    const a = nacl.sign.keyPair();
    const b = nacl.sign.keyPair();
    const peerA = `h1-peer-a-${sfx}`;
    const peerB = `h1-peer-b-${sfx}`;
    await seedToken(token);
    const { response, competed, released, paused } = await withPaused(
      "federation-pair-token",
      () => pairRequest(pairBody(peerA, b64url(a.publicKey), a.secretKey, token)),
      () => pairRequest(pairBody(peerB, b64url(b.publicKey), b.secretKey, token)),
    );
    expect(paused, "the pairing's token claim was not paused").toBe(true);
    expect(released, "the pairing's token claim was not released by this test").toBe("go");
    const aBody = await response.json() as any;
    const bBody = await (competed as Response).json() as any;
    const paired = [aBody, bBody].filter((x) => x?.paired === true).length;
    console.log("H1 pair bodies:", JSON.stringify({ a: aBody, b: bBody }));
    // One pairing consumes the token; the other is refused.
    expect(paired, `one pairing consumes the token, got A=${JSON.stringify(aBody)} B=${JSON.stringify(bBody)}`).toBe(1);
    const rowA = await readPeer(peerA);
    const rowB = await readPeer(peerB);
    expect([rowA, rowB].filter(Boolean).length, "exactly one peer row is written").toBe(1);
    expect((await readToken(token))?.consumedBy, "the token records the peer that consumed it").toBeTruthy();
  }, 90_000);

  it("CONTROL: one pairing with a fresh token pairs the peer", async () => {
    const token = `pt-h1-ok-${sfx}`;
    const k = nacl.sign.keyPair();
    const peer = `h1-peer-ok-${sfx}`;
    await seedToken(token);
    const res = await pairRequest(pairBody(peer, b64url(k.publicKey), k.secretKey, token));
    const body = await res.json() as any;
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.paired).toBe(true);
    expect((await readPeer(peer))?.status).toBe("paired");
    expect((await readToken(token))?.consumedBy).toBe(peer);
  }, 60_000);
});

describe("flair#2333 — an otherwise valid, non-revoked re-pair consumes its supplied token (real Harper)", () => {
  // An otherwise valid, non-revoked re-pair validates and consumes its supplied
  // token as the first-pair path does, under this node's token lock.
  it("an otherwise valid, non-revoked re-pair consumes its supplied token, preventing later reuse on this node", async () => {
    const k = nacl.sign.keyPair();
    const peer = `h1b-peer-${sfx}`;
    const pub = b64url(k.publicKey);
    await seedPeer(peer, pub); // peer exists → the re-pair path
    const token = `pt-h1b-${sfx}`;
    await seedToken(token);

    const res = await pairRequest(pairBody(peer, pub, k.secretKey, token));
    const body = await res.json() as any;
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.paired).toBe(true);
    // RED on 5dc7c7d4, where the re-pair ignored the token and left it unconsumed.
    expect((await readToken(token))?.consumedBy, "the re-pair consumed the supplied token").toBe(peer);

    // The spent token cannot pair a NEW peer on this node: both paths consume it.
    const k2 = nacl.sign.keyPair();
    const peer2 = `h1b-peer-new-${sfx}`;
    const res2 = await pairRequest(pairBody(peer2, b64url(k2.publicKey), k2.secretKey, token));
    const body2 = await res2.json() as any;
    console.log("h1b spent-token new-pair body:", JSON.stringify(body2));
    expect(res2.status, JSON.stringify(body2)).toBe(401);
    expect(body2.error).toBe("invalid_or_expired_pairing_token");
    expect(await readPeer(peer2), "a spent token pairs no new peer").toBeNull();
  }, 60_000);

  it("CONTROL: an otherwise valid, non-revoked re-pair with NO token succeeds", async () => {
    const k = nacl.sign.keyPair();
    const peer = `h1b-peer-notok-${sfx}`;
    const pub = b64url(k.publicKey);
    await seedPeer(peer, pub);
    const res = await pairRequest(pairBody(peer, pub, k.secretKey));
    const body = await res.json() as any;
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.paired).toBe(true);
    expect((await readPeer(peer))?.status).toBe("paired");
  }, 60_000);
});

describe("flair#2333 — a signed Basic-auth pairing binds the bootstrap user to the token (real Harper)", () => {
  // The binding (PR-4) used to have only a unit test that DUPLICATED the
  // validator. This drives it through the real path: a signed pairing request
  // carrying Basic credentials. The token's own bootstrap user pairs; a
  // different, non-admin bootstrap user is refused without changing the Peer
  // row or a pairing token; the signed request records its replay nonce.
  it("the token's own bootstrap user pairs; a different bootstrap user is refused", async () => {
    await ensureFlairPairInitiatorRole(harper.opsURL, harper.admin.username, harper.admin.password);

    // (a) matching bootstrap user → pairs, consumes the token, records the peer.
    const token = `pt-bind-ok-${sfx}`;
    const k = nacl.sign.keyPair();
    const peer = `bind-peer-ok-${sfx}`;
    await seedToken(token);
    const user = `pair-bootstrap-${token.slice(0, 8)}`;
    const pass = "bind-pass-ok";
    await ops({ operation: "add_user", username: user, password: pass, role: "flair_pair_initiator", active: true });
    const res = await pairRequestBasic(pairBody(peer, b64url(k.publicKey), k.secretKey, token), user, pass);
    const body = await res.json() as any;
    console.log("bind matching-user body:", JSON.stringify(body));
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.paired).toBe(true);
    expect((await readPeer(peer))?.status).toBe("paired");
    expect((await readToken(token))?.consumedBy).toBe(peer);

    // (b) a DIFFERENT (valid, non-admin) bootstrap user carrying this token → 401.
    const token2 = `pt-bind-bad-${sfx}`;
    const k2 = nacl.sign.keyPair();
    const peer2 = `bind-peer-bad-${sfx}`;
    await seedToken(token2);
    const otherUser = "pair-bootstrap-mismatch0";
    const otherPass = "bind-pass-bad";
    await ops({ operation: "add_user", username: otherUser, password: otherPass, role: "flair_pair_initiator", active: true });
    const res2 = await pairRequestBasic(
      pairBody(peer2, b64url(k2.publicKey), k2.secretKey, token2), otherUser, otherPass,
    );
    const body2 = await res2.json() as any;
    console.log("bind mismatched-user body:", JSON.stringify(body2));
    expect(res2.status, JSON.stringify(body2)).toBe(401);
    expect(body2.error).toBe("bootstrap_user_token_mismatch");
    expect(await readPeer(peer2), "a mismatched bootstrap user writes no peer").toBeNull();
    expect((await readToken(token2))?.consumedBy, "a mismatched bootstrap user consumes no token").toBeFalsy();
  }, 90_000);
});

describe("flair#2333 — a federation sync does not leave a revoked peer connected (real Harper)", () => {
  // Guard, driven through the EXISTING memory-merge pause point, so it runs as
  // written against the unmodified code too: the revoke is committed while the
  // sync is merging, and the peer row must not be left connected afterwards.
  for (const point of ["federation-merge-pre", "federation-merge"]) {
    it(`a revoke during the sync leaves the peer revoked (${point})`, async () => {
      const k = nacl.sign.keyPair();
      const peer = `h2-peer-${point}-${sfx}`;
      await seedPeer(peer, b64url(k.publicKey));
      const id = `h2-mem-${point}-${sfx}`;
      const body = signBodyFresh({
        instanceId: peer,
        records: [{
          table: "Memory", id,
          data: { id, content: "federated", agentId: `h2-agent-${sfx}`, visibility: "shared", createdAt: now() },
          updatedAt: now(), originatorInstanceId: peer,
        }],
        lamportClock: Date.now(),
      }, k.secretKey);
      const { response, competed, released, paused } = await withPaused(point, () => syncRequest(body), () => revokePeer(peer));
      expect(paused, "the sync's memory merge was not paused").toBe(true);
      expect(released, "the sync's memory merge was not released by this test").toBe("go");
      expect(competed?.status, "the competing revoke was not applied").toBe(200);
      expect(competed?.row?.status, "the competing revoke's own row state is revoked").toBe("revoked");
      const resBody = await response.json() as any;
      console.log(`${point} sync body:`, JSON.stringify(resBody));
      expect((await readPeer(peer))?.status, "the concurrent revoke is kept").toBe("revoked");
    }, 60_000);
  }

  it("CONTROL: with no competitor the sync keeps the peer and reports connected", async () => {
    const k = nacl.sign.keyPair();
    const peer = `h2-peer-ok-${sfx}`;
    await seedPeer(peer, b64url(k.publicKey));
    const body = signBodyFresh({ instanceId: peer, records: [], lamportClock: Date.now() }, k.secretKey);
    const res = await syncRequest(body);
    const resBody = await res.json() as any;
    expect(res.status, JSON.stringify(resBody)).toBe(200);
    const row = await readPeer(peer);
    expect(row?.status).toBe("connected");
    expect(row?.lastSyncAt, "the liveness stamp landed").toBeTruthy();
  }, 60_000);
});

describe("flair#2333 — a peer revoked during a re-pair is not brought back (real Harper)", () => {
  // Guard: the revoke is committed after the re-pair's read of the peer row,
  // while the re_pair is paused. The re_pair must not leave the row paired.
  it("a re-pair of a concurrently revoked peer leaves it revoked (federation-pair-repair-pre)", async () => {
    const k = nacl.sign.keyPair();
    const peer = `h3-peer-repair-pre-${sfx}`;
    const pub = b64url(k.publicKey);
    await seedPeer(peer, pub);
    const { response, competed, released, paused } = await withPaused(
      "federation-pair-repair-pre",
      () => pairRequest(pairBody(peer, pub, k.secretKey)),
      () => revokePeer(peer),
    );
    expect(paused, "the re-pair was not paused").toBe(true);
    expect(released, "the re-pair was not released by this test").toBe("go");
    expect(competed?.status, "the competing revoke was not applied").toBe(200);
    expect(competed?.row?.status, "the competing revoke's own row state is revoked").toBe("revoked");
    console.log("federation-pair-repair-pre re-pair body:", JSON.stringify(await response.clone().json()));
    expect((await readPeer(peer))?.status, "the concurrent revoke is kept").toBe("revoked");
  }, 60_000);

  it("a re-pair of a peer revoked before the request is refused, changing neither the peer row nor a token", async () => {
    const k = nacl.sign.keyPair();
    const peer = `h3-peer-static-${sfx}`;
    const pub = b64url(k.publicKey);
    const token = `pt-h3-static-${sfx}`;
    await seedPeer(peer, pub, "revoked");
    await seedToken(token);
    // Neither the Peer row nor the supplied pairing token changes; the signed
    // request records its replay nonce before refusal. Capture both full rows.
    const before = await readPeer(peer);
    const tokenBefore = await readToken(token);
    expect(tokenBefore).not.toBeNull();
    expect(tokenBefore.consumedBy).toBeFalsy();
    const res = await pairRequest(pairBody(peer, pub, k.secretKey, token));
    const resBody = await res.json() as any;
    console.log("H3 static re-pair body:", JSON.stringify(resBody));
    expect(res.status, JSON.stringify(resBody)).toBe(403);
    expect(resBody.error).toBe("peer_revoked");
    expect(await readPeer(peer), "the Peer row is unchanged").toEqual(before);
    expect(await readToken(token), "the full pairing token row is unchanged").toEqual(tokenBefore);
  }, 60_000);

  it("CONTROL: a re-pair of a paired peer succeeds and keeps it paired", async () => {
    const k = nacl.sign.keyPair();
    const peer = `h3-peer-ok-${sfx}`;
    const pub = b64url(k.publicKey);
    await seedPeer(peer, pub);
    const res = await pairRequest(pairBody(peer, pub, k.secretKey));
    const resBody = await res.json() as any;
    expect(res.status, JSON.stringify(resBody)).toBe(200);
    expect(resBody.paired).toBe(true);
    expect((await readPeer(peer))?.status).toBe("paired");
  }, 60_000);
});

// ─── The token lock releases only AFTER the consume commits (flair#2333) ──────
//
// Harper wraps POST /FederationPair in a REQUEST transaction that commits only
// after the handler returns (harper server/REST.ts ~284), so a token consume that
// JOINED that request transaction is still invisible when the token's per-key
// lock releases. A second pairing that takes the just-freed lock then reads the
// token UNCONSUMED and pairs a second peer. The fix runs the consume (re-read of
// the token) and the Peer write in a FRESH OWNED transaction (withOwnedTransaction,
// resources/request-transaction.ts) that commits BEFORE the lock releases.
//
// On the heads, exactly: the RE-PAIR case is RED on pristine b0fed5fa, where the
// re-pair's consume joins the request transaction and the competing new-peer
// pairing returns 200 paired. The FIRST-PAIR case's pause point
// (`federation-pair-claim-done`) does not exist on b0fed5fa, so it is RED only
// under the mutation that writes back in the request transaction (its pause point
// present, the write reverted); it is not a pristine-head red.

describe("flair#2333 — the token lock releases only after the consume commits: first-pair path (real Harper)", () => {
  it("a pairing that takes the lock right after the first releases it is refused; one peer (federation-pair-claim-done)", async () => {
    const token = `pt-h1c-${sfx}`;
    const a = nacl.sign.keyPair();
    const b = nacl.sign.keyPair();
    const peerA = `h1c-peer-a-${sfx}`;
    const peerB = `h1c-peer-b-${sfx}`;
    await seedToken(token);
    // The pause sits AFTER the first pairing released the token lock (and, with
    // the fix, after its owned transaction committed the consume) but BEFORE this
    // request's own transaction commits (Harper commits it when the handler
    // returns). The competitor is free to grab the lock here.
    const { response, competed, released, paused } = await withPaused(
      "federation-pair-claim-done",
      () => pairRequest(pairBody(peerA, b64url(a.publicKey), a.secretKey, token)),
      () => pairRequest(pairBody(peerB, b64url(b.publicKey), b.secretKey, token)),
    );
    expect(paused, "the first pairing was not paused after releasing the token lock").toBe(true);
    expect(released, "the first pairing was not released by this test").toBe("go");
    const aBody = await response.json() as any;
    const bBody = await (competed as Response).json() as any;
    console.log("H1c pair bodies:", JSON.stringify({ a: aBody, b: bBody }));
    expect(aBody?.paired, `the first pairing paired its peer: ${JSON.stringify(aBody)}`).toBe(true);
    expect((competed as Response).status, `the second pairing is refused after the first commits: ${JSON.stringify(bBody)}`).toBe(401);
    expect(bBody?.error).toBe("invalid_or_expired_pairing_token");
    const rows = [await readPeer(peerA), await readPeer(peerB)].filter(Boolean);
    expect(rows.length, "exactly one peer row is written").toBe(1);
    expect((await readToken(token))?.consumedBy, "the token records the one peer that consumed it").toBe(peerA);
  }, 90_000);
});

describe("flair#2333 — the token lock releases only after the consume commits: re-pair path (real Harper)", () => {
  it("a new-peer pairing that takes the lock as the re-pair releases it is refused (federation-pair-repair-pre)", async () => {
    const k = nacl.sign.keyPair();
    const peer = `h1d-peer-${sfx}`;
    const pub = b64url(k.publicKey);
    await seedPeer(peer, pub); // peer exists → the re-pair path
    const token = `pt-h1d-${sfx}`;
    await seedToken(token);
    const k2 = nacl.sign.keyPair();
    const peer2 = `h1d-peer-new-${sfx}`;
    // The existing re-pair pause sits after the token lock released and before
    // this request's own commit; the competitor pairs a NEW peer with the token
    // the re-pair just claimed. On b0fed5fa the re-pair's consume is uncommitted
    // here, so the new peer is written; with the fix it is refused.
    const { response, competed, released, paused } = await withPaused(
      "federation-pair-repair-pre",
      () => pairRequest(pairBody(peer, pub, k.secretKey, token)),
      () => pairRequest(pairBody(peer2, b64url(k2.publicKey), k2.secretKey, token)),
    );
    expect(paused, "the re-pair was not paused after releasing the token lock").toBe(true);
    expect(released, "the re-pair was not released by this test").toBe("go");
    const repairBody = await response.json() as any;
    const newBody = await (competed as Response).json() as any;
    console.log("H1d pair bodies:", JSON.stringify({ repair: repairBody, newPeer: newBody }));
    expect(repairBody?.paired, `the re-pair paired: ${JSON.stringify(repairBody)}`).toBe(true);
    expect((competed as Response).status, `the new-peer pairing is refused: ${JSON.stringify(newBody)}`).toBe(401);
    expect(newBody?.error).toBe("invalid_or_expired_pairing_token");
    expect(await readPeer(peer2), "the token spent on the re-pair pairs no new peer").toBeNull();
    expect((await readToken(token))?.consumedBy, "the token records the re-paired peer").toBe(peer);
  }, 90_000);
});

// ─── A re-pair's token consume and Peer write commit TOGETHER (flair#2333) ─────
//
// The consume AND the Peer write run in one OWNED transaction that commits before
// the token lock releases. This drives a REAL Peer-write failure there through the
// composed test-only component (a zz-test module that fails one Peer.put when the
// test arms a marker file) — the unit-isolated Map model in
// test/unit-isolated/federation-pair-repair-atomic-2333.test.ts is not enough. The
// failing write lands AFTER the token consume is STAGED, so "the token is left
// unconsumed" only holds when the consume rolls back WITH it. Mutation — move the
// Peer write out of the owned transaction (into the request transaction) — makes
// the consume commit alone and turns this case red.

describe("flair#2333 — a failed re-pair Peer write leaves the token unconsumed (real Harper)", () => {
  it("Peer.put rejecting after the consume is staged → 503 peer_write_failed, both rows unchanged, then the retry with the same token pairs once", async () => {
    const k = nacl.sign.keyPair();
    const peer = `repair-fail-${sfx}`;
    const pub = b64url(k.publicKey);
    await seedPeer(peer, pub); // peer exists → the re-pair path
    const token = `pt-repair-fail-${sfx}`;
    await seedToken(token);
    const peerBefore = await readPeer(peer);
    const tokenBefore = await readToken(token);
    expect(tokenBefore, "the pairing token was seeded").not.toBeNull();
    expect(tokenBefore.consumedBy, "the pairing token starts unconsumed").toBeFalsy();

    // Arm the composed seam: the NEXT Peer.put for this peer fails, inside the
    // owned transaction, after the token consume has been staged.
    writeFileSync(join(pauseDir, `arm.repair-peer-write-fail.${peer}`), "");

    const res = await pairRequest(pairBody(peer, pub, k.secretKey, token));
    const body = await res.json() as any;
    console.log("re-pair failed-write body:", JSON.stringify(body));
    // Refused by name — not a bare 500.
    expect(res.status, JSON.stringify(body)).toBe(503);
    expect(body.error).toBe("peer_write_failed");
    // The consume rolled back WITH the failed write: BOTH full rows are unchanged.
    expect(await readPeer(peer), "the full Peer row is unchanged").toEqual(peerBefore);
    expect(await readToken(token), "the full PairingToken row is unchanged (unconsumed)").toEqual(tokenBefore);

    // A retry with the SAME token, still valid, pairs once (the one-shot seam is spent).
    const retry = await pairRequest(pairBody(peer, pub, k.secretKey, token));
    const retryBody = await retry.json() as any;
    console.log("re-pair retry body:", JSON.stringify(retryBody));
    expect(retry.status, JSON.stringify(retryBody)).toBe(200);
    expect(retryBody.paired).toBe(true);
    expect((await readPeer(peer))?.status).toBe("paired");
    expect((await readToken(token))?.consumedBy, "the retry consumed the token").toBe(peer);
  }, 90_000);

  it("CONTROL: a re-pair with the seam unarmed pairs normally and consumes the token (real Harper)", async () => {
    const k = nacl.sign.keyPair();
    const peer = `repair-ok-${sfx}`;
    const pub = b64url(k.publicKey);
    await seedPeer(peer, pub);
    const token = `pt-repair-ok-${sfx}`;
    await seedToken(token);
    const res = await pairRequest(pairBody(peer, pub, k.secretKey, token));
    const body = await res.json() as any;
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.paired).toBe(true);
    expect((await readPeer(peer))?.status).toBe("paired");
    expect((await readToken(token))?.consumedBy).toBe(peer);
  }, 60_000);
});

// ─── A re-pair re-reads the Peer row INSIDE its owned transaction (flair#2333) ─
//
// A revoke committed before the owned transaction's first read (its token read)
// is seen by the Peer re-read and refused with 403 peer_revoked; a revoke committed
// after that read is not covered by this re-read. Refusing aborts the transaction
// and rolls the staged consume back. Mutation — drop the in-transaction re-read —
// makes the re-pair resurrect the revoked row and turns this case red.

describe("flair#2333 — a re-pair re-reads the Peer row inside its owned transaction (real Harper)", () => {
  it("a revoke committed after the pre-transaction Peer read and before the owned transaction is refused 403 peer_revoked (federation-pair-repair-token-pre)", async () => {
    const k = nacl.sign.keyPair();
    const peer = `h3b-peer-${sfx}`;
    const pub = b64url(k.publicKey);
    await seedPeer(peer, pub); // peer exists → the re-pair path
    const token = `pt-h3b-${sfx}`;
    await seedToken(token);
    // The pause sits AFTER the re-pair's pre-transaction read of the Peer row and
    // BEFORE its owned transaction; the competitor's revoke commits here.
    const { response, competed, released, paused } = await withPaused(
      "federation-pair-repair-token-pre",
      () => pairRequest(pairBody(peer, pub, k.secretKey, token)),
      () => revokePeer(peer),
    );
    expect(paused, "the re-pair was not paused before its owned transaction").toBe(true);
    expect(released, "the re-pair was not released by this test").toBe("go");
    expect(competed?.status, "the competing revoke was not applied").toBe(200);
    expect(competed?.row?.status, "the competing revoke's own row state is revoked").toBe("revoked");
    const resBody = await response.json() as any;
    console.log("federation-pair-repair-token-pre re-pair body:", JSON.stringify(resBody));
    expect(response.status, JSON.stringify(resBody)).toBe(403);
    expect(resBody.error).toBe("peer_revoked");
    expect((await readPeer(peer))?.status, "the concurrent revoke is kept").toBe("revoked");
    expect((await readToken(token))?.consumedBy, "the refused re-pair consumed no token").toBeFalsy();
  }, 60_000);
});
