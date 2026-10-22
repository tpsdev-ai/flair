// federation-peer-trust-2333.test.ts — flair#2333 slice 1, the federation
// peer-trust writes, driven against real Harper with the shared transaction
// pause points:
//   H1 `POST /FederationPair` pairing-token consume: one token, two pairings.
//   H2 `POST /FederationSync` peer status: a revoke that commits during the sync.
//   H3 `POST /FederationPair` re-pair: a peer revoked before, or during, the re-pair;
//      a pinned key changed, or a row deleted, during the re-pair.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import nacl from "tweetnacl";
import { signBodyFresh } from "../../resources/federation-crypto.js";
import { ensureFlairPairInitiatorRole } from "../../src/cli";
import { startHarper, stopHarper, type HarperInstance, HARPER_STOP_BUDGET_MS } from "../helpers/harper-lifecycle";
import { componentWithFailingRepairPeerWrite, FAILING_REPAIR_PEER_WRITE_MODULE_REL, type FailingComponent } from "../helpers/host-pointer-failing-component";

const sfx = Date.now().toString(36);
const now = () => new Date().toISOString();
const later = (ms: number) => new Date(Date.now() + ms).toISOString();
const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

let harper: HarperInstance;
let component: FailingComponent;
let pauseDir: string;

/** Require loopback hostnames, exclude ports 9925/9926, and check the installDir temp-path prefix. */
function assertOwnInstance(h: HarperInstance): void {
  for (const url of [h.httpURL, h.opsURL]) {
    const u = new URL(url);
    expect(["127.0.0.1", "localhost"], url).toContain(u.hostname);
    expect(["9925", "9926"], `${url} must exclude ports 9925/9926`).not.toContain(u.port);
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

/** The competing delete's HTTP status and the subsequent Peer read. */
async function deletePeer(id: string): Promise<{ status: number; row: any }> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: opsAuth() },
    body: JSON.stringify({ operation: "delete", database: "flair", table: "Peer", ids: [id] }),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: res.status, row: await readPeer(id) };
}

/** The competing operation's own RESULT — its HTTP status AND the peer row it left. */
async function updatePeer(id: string, fields: Record<string, unknown>): Promise<{ status: number; row: any }> {
  const res = await fetch(harper.opsURL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: opsAuth() },
    body: JSON.stringify({
      operation: "update", database: "flair", table: "Peer",
      records: [{ id, ...fields, updatedAt: now() }],
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

/** A pairing request carrying a Basic credential for `user`, under a chosen scheme spelling. */
function pairRequestBasic(body: Record<string, unknown>, user: string, pass: string, scheme = "Basic"): Promise<Response> {
  return fetch(`${harper.httpURL}/FederationPair`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `${scheme} ` + btoa(`${user}:${pass}`) },
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
  // The whole file runs against a composed copy of the built component that
  // adds the failing re-pair Peer-write module (test/helpers/
  // host-pointer-failing-component.ts). It throws only for an armed peer ID.
  component = componentWithFailingRepairPeerWrite();
  appendFileSync(join(component.dir, FAILING_REPAIR_PEER_WRITE_MODULE_REL), `
const peerGet = Peer.get;
Peer.get = function (id, ...rest) {
  const dir = process.env.FLAIR_TEST_PAUSE_DIR;
  if (dir && typeof id === "string") {
  const arm = join(dir, "arm.converted-peer-read-fail." + id);
  if (existsSync(arm)) {
    unlinkSync(arm);
    throw new Error("test component: forced converted first-pair read-back failure");
  }
  }
  return peerGet.call(this, id, ...rest);
};
`);
  harper = await startHarper({ serverEnv: { FLAIR_ENABLE_TEST_FAULT_INJECTION: "1", FLAIR_TEST_PAUSE_DIR: pauseDir }, cwd: component.dir });
  assertOwnInstance(harper);
}, 240_000);

afterAll(async () => {
  if (harper) await stopHarper(harper);
  if (component) component.cleanup();
  if (pauseDir) rmSync(pauseDir, { recursive: true, force: true });
}, HARPER_STOP_BUDGET_MS);

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

describe("flair#2333 — authenticated bootstrap Basic callers supplying valid tokens (real Harper)", () => {
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

  it("a mismatched bootstrap user is refused under a lower/mixed-case Basic scheme too — the binding is not skipped by scheme case", async () => {
    await ensureFlairPairInitiatorRole(harper.opsURL, harper.admin.username, harper.admin.password);
    const otherUser = "pair-bootstrap-case-guard";
    const otherPass = "bind-pass-case";
    await ops({ operation: "add_user", username: otherUser, password: otherPass, role: "flair_pair_initiator", active: true });
    // Scheme names are case-insensitive (RFC 9110). Each spelling must reach the
    // Basic branch (annotating tpsAgent) so the token consume path applies the
    // bootstrap-user binding and refuses the mismatch — never consuming the token.
    for (const scheme of ["basic", "BASIC", "BaSiC"]) {
      const token = `pt-bind-case-${scheme}-${sfx}`;
      const k = nacl.sign.keyPair();
      const peer = `bind-peer-case-${scheme}-${sfx}`;
      await seedToken(token);
      const res = await pairRequestBasic(pairBody(peer, b64url(k.publicKey), k.secretKey, token), otherUser, otherPass, scheme);
      const body = await res.json() as any;
      console.log(`bind ${scheme}-scheme mismatched-user body:`, JSON.stringify(body));
      expect(res.status, `${scheme}: ${JSON.stringify(body)}`).toBe(401);
      expect(body.error).toBe("bootstrap_user_token_mismatch");
      expect(await readPeer(peer), `${scheme}: a mismatched bootstrap user writes no peer`).toBeNull();
      expect((await readToken(token))?.consumedBy, `${scheme}: a mismatched bootstrap user consumes no token`).toBeFalsy();
    }
  }, 90_000);
});

describe("flair#2333 — revokes at the sync's memory-merge pauses (real Harper)", () => {
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

describe("flair#2333 — re-pair revocation and deletion interleavings (real Harper)", () => {
  // Guard: the revoke is committed after the re-pair's read of the peer row,
  // while the re_pair is paused. The re_pair must not leave the row paired.
  it("a re-pair of a concurrently revoked peer is refused 403 peer_revoked and leaves it revoked (federation-pair-repair-pre)", async () => {
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
    const resBody = await response.json() as any;
    console.log("federation-pair-repair-pre re-pair body:", JSON.stringify(resBody));
    // The no-token re-pair re-reads the row inside its owned transaction and refuses
    // the now-revoked row by name — it does not report success over a stale row.
    expect(response.status, JSON.stringify(resBody)).toBe(403);
    expect(resBody.error).toBe("peer_revoked");
    expect((await readPeer(peer))?.status, "the concurrent revoke is kept").toBe("revoked");
  }, 60_000);

  it("a no-token re-pair of a peer deleted during the pause is refused and does not re-create the row (federation-pair-repair-pre)", async () => {
    const k = nacl.sign.keyPair();
    const peer = `h3-peer-repair-gone-${sfx}`;
    const pub = b64url(k.publicKey);
    await seedPeer(peer, pub);
    const { response, competed, released, paused } = await withPaused(
      "federation-pair-repair-pre",
      () => pairRequest(pairBody(peer, pub, k.secretKey)),
      () => deletePeer(peer),
    );
    expect(paused, "the re-pair was not paused").toBe(true);
    expect(released, "the re-pair was not released by this test").toBe("go");
    expect(competed?.status, "the competing delete was not applied").toBe(200);
    expect(competed?.row, "the competing delete removed the row").toBeNull();
    const resBody = await response.json() as any;
    console.log("federation-pair-repair-pre deleted re-pair body:", JSON.stringify(resBody));
    // The row is gone, so this is no longer a re-pair: it is refused like a
    // first-time pair (a token is required) and the deleted row is not re-created.
    expect(response.status, JSON.stringify(resBody)).toBe(401);
    expect(resBody.error).toBe("pairingToken required in body for first-time pair");
    expect(await readPeer(peer), "the deleted row is not re-created").toBeNull();
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

// ─── A successful token claim commits BEFORE the lock releases (flair#2333) ───
//
// Harper wraps POST /FederationPair in a REQUEST transaction that commits only
// after the handler returns (harper server/REST.ts), so a token consume that
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

describe("flair#2333 — a successful claim commits before lock release: first-pair path (real Harper)", () => {
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

describe("flair#2333 — a successful claim commits before lock release: re-pair path (real Harper)", () => {
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

describe("flair#2333 — a token-supplying re-pair's Peer.put rejection inside the callback (real Harper)", () => {
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
// With a valid supplied token and matching pinned key, a revoke committed before
// the owned transaction's first read (its token read)
// is seen by the Peer re-read and refused with 403 peer_revoked; a revoke committed
// after that read is not covered by this re-read. Refusing aborts the transaction
// and rolls the staged consume back. Mutation — drop the in-transaction re-read —
// makes the re-pair resurrect the revoked row and turns this case red.

describe("flair#2333 — a re-pair with a valid token re-reads the Peer row inside its owned transaction (real Harper)", () => {
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

// ─── A re-pair rechecks the pinned key inside its owned transaction (flair#2333) ─
//
// The request's signature is verified against the key it SUBMITS, and the key
// comparison first runs on the pre-transaction Peer read. Both re-pair paths
// re-read the row inside their owned transaction before writing; that re-read
// must compare the row's CURRENT pinned key with the submitted key too, so a key
// changed between the two reads is refused (409, the initial key-mismatch refusal)
// and no Peer row is written. On the token path the refusal aborts the owned
// transaction, so the staged consume rolls back and the token stays unconsumed.
// Mutation — drop the current-key comparison on a path — turns that path's case red.

describe("flair#2333 — a re-pair rechecks the pinned key inside its owned transaction (real Harper)", () => {
  const KEY_MISMATCH = "public key mismatch — peer already paired with different key";

  it("no token: a pinned key changed during the pause is refused 409, the row is left as the change wrote it (federation-pair-repair-pre)", async () => {
    const k = nacl.sign.keyPair();
    const other = nacl.sign.keyPair();
    const peer = `key-notok-${sfx}`;
    const pub = b64url(k.publicKey);
    await seedPeer(peer, pub);
    const { response, competed, released, paused } = await withPaused(
      "federation-pair-repair-pre",
      () => pairRequest(pairBody(peer, pub, k.secretKey)),
      () => updatePeer(peer, { publicKey: b64url(other.publicKey) }),
    );
    expect(paused, "the re-pair was not paused").toBe(true);
    expect(released, "the re-pair was not released by this test").toBe("go");
    expect(competed?.status, "the competing key change was not applied").toBe(200);
    expect(competed?.row?.publicKey, "the competing change's own row pins the other key").toBe(b64url(other.publicKey));
    const resBody = await response.json() as any;
    console.log("key-change no-token re-pair body:", JSON.stringify(resBody));
    expect(response.status, JSON.stringify(resBody)).toBe(409);
    expect(resBody.error).toBe(KEY_MISMATCH);
    expect(await readPeer(peer), "the full Peer row is the one the key change left").toEqual(competed?.row);
  }, 60_000);

  it("with a token: a pinned key changed during the pause is refused 409, the row is left as the change wrote it, the token unconsumed (federation-pair-repair-token-pre)", async () => {
    const k = nacl.sign.keyPair();
    const other = nacl.sign.keyPair();
    const peer = `key-tok-${sfx}`;
    const pub = b64url(k.publicKey);
    await seedPeer(peer, pub);
    const token = `pt-key-tok-${sfx}`;
    await seedToken(token);
    const tokenBefore = await readToken(token);
    expect(tokenBefore?.consumedBy, "the pairing token starts unconsumed").toBeFalsy();
    const { response, competed, released, paused } = await withPaused(
      "federation-pair-repair-token-pre",
      () => pairRequest(pairBody(peer, pub, k.secretKey, token)),
      () => updatePeer(peer, { publicKey: b64url(other.publicKey) }),
    );
    expect(paused, "the re-pair was not paused before its owned transaction").toBe(true);
    expect(released, "the re-pair was not released by this test").toBe("go");
    expect(competed?.status, "the competing key change was not applied").toBe(200);
    expect(competed?.row?.publicKey, "the competing change's own row pins the other key").toBe(b64url(other.publicKey));
    const resBody = await response.json() as any;
    console.log("key-change token re-pair body:", JSON.stringify(resBody));
    expect(response.status, JSON.stringify(resBody)).toBe(409);
    expect(resBody.error).toBe(KEY_MISMATCH);
    expect(await readPeer(peer), "the full Peer row is the one the key change left").toEqual(competed?.row);
    expect(await readToken(token), "the full PairingToken row is unchanged (unconsumed)").toEqual(tokenBefore);
  }, 60_000);

  it("CONTROL, no token: a same-key change during the pause does not refuse; the re-pair writes from the current row (federation-pair-repair-pre)", async () => {
    const k = nacl.sign.keyPair();
    const peer = `key-same-notok-${sfx}`;
    const pub = b64url(k.publicKey);
    await seedPeer(peer, pub);
    const moved = "https://moved.example/flair";
    const { response, competed, paused } = await withPaused(
      "federation-pair-repair-pre",
      () => pairRequest(pairBody(peer, pub, k.secretKey)),
      () => updatePeer(peer, { endpoint: moved }),
    );
    expect(paused, "the re-pair was not paused").toBe(true);
    expect(competed?.row?.endpoint, "the competing change was applied").toBe(moved);
    const resBody = await response.json() as any;
    expect(response.status, JSON.stringify(resBody)).toBe(200);
    expect(resBody.paired).toBe(true);
    const row = await readPeer(peer);
    expect(row?.status).toBe("paired");
    expect(row?.publicKey).toBe(pub);
    expect(row?.endpoint, "the write is built from the current row").toBe(moved);
  }, 60_000);

  it("CONTROL, with a token: a same-key change during the pause does not refuse; the token is consumed (federation-pair-repair-token-pre)", async () => {
    const k = nacl.sign.keyPair();
    const peer = `key-same-tok-${sfx}`;
    const pub = b64url(k.publicKey);
    await seedPeer(peer, pub);
    const token = `pt-key-same-${sfx}`;
    await seedToken(token);
    const moved = "https://moved.example/flair";
    const { response, competed, paused } = await withPaused(
      "federation-pair-repair-token-pre",
      () => pairRequest(pairBody(peer, pub, k.secretKey, token)),
      () => updatePeer(peer, { endpoint: moved }),
    );
    expect(paused, "the re-pair was not paused before its owned transaction").toBe(true);
    expect(competed?.row?.endpoint, "the competing change was applied").toBe(moved);
    const resBody = await response.json() as any;
    expect(response.status, JSON.stringify(resBody)).toBe(200);
    expect(resBody.paired).toBe(true);
    const row = await readPeer(peer);
    expect(row?.status).toBe("paired");
    expect(row?.publicKey).toBe(pub);
    expect(row?.endpoint, "the write is built from the current row").toBe(moved);
    expect((await readToken(token))?.consumedBy, "the re-pair consumed the token").toBe(peer);
  }, 60_000);
});

// ─── A token re-pair whose row was deleted pairs as a first pair (flair#2333) ───
//
// When the Peer row is gone by the time the token path's owned transaction
// re-reads it, the request is no longer a re-pair: with a valid token it is paired
// exactly as a first-time pair with that token — the row is built from the
// verified request the way the first-pair path builds it (no field of the deleted
// row survives). Bootstrap-user cleanup is attempted. Mutation — write the
// deleted row's pre-transaction fields back — turns this case red.

describe("flair#2333 — a token re-pair whose Peer row was deleted pairs as a first-time pair (real Harper)", () => {
  /** Every non-identity, non-timestamp Peer field (schemas/federation.graphql), absent read as null. */
  const SHAPE_FIELDS = ["role", "endpoint", "status", "relayOnly", "lastSyncAt", "lastMergeAt", "lastSyncCursor"];
  function firstPairShape(row: any) {
    return Object.fromEntries(SHAPE_FIELDS.map((k) => [k, row?.[k] ?? null]));
  }
  /** The row's fields that hold a value, Harper's own `__` attributes aside. */
  function setFields(row: any): string[] {
    return Object.keys(row ?? {}).filter((k) => !k.startsWith("__") && row[k] != null).sort();
  }

  it("a delete committed during the pause: the token pairs the peer with a fresh first-pair row and drops its bootstrap user (federation-pair-repair-token-pre)", async () => {
    await ensureFlairPairInitiatorRole(harper.opsURL, harper.admin.username, harper.admin.password);
    const k = nacl.sign.keyPair();
    const peer = `del-tok-${sfx}`;
    const pub = b64url(k.publicKey);
    const stale = "2020-01-01T00:00:00.000Z";
    // A row with fields a first pair never writes, so any survivor is visible.
    await ops({
      operation: "insert", database: "flair", table: "Peer",
      records: [{
        id: peer, publicKey: pub, role: "hub", endpoint: "https://stale.example/flair", status: "connected",
        relayOnly: true, lastSyncAt: stale, lastMergeAt: stale, lastSyncCursor: "42",
        pairedAt: stale, createdAt: stale, updatedAt: stale,
      }],
    });
    const token = `ptdelrow-${sfx}`;
    await seedToken(token);
    const bootstrapUser = `pair-bootstrap-${token.slice(0, 8)}`;
    await ops({ operation: "add_user", username: bootstrapUser, password: "del-row-pass", role: "flair_pair_initiator", active: true });
    const startedAt = Date.now();

    const { response, competed, released, paused } = await withPaused(
      "federation-pair-repair-token-pre",
      () => pairRequest(pairBody(peer, pub, k.secretKey, token)),
      () => deletePeer(peer),
    );
    expect(paused, "the re-pair was not paused before its owned transaction").toBe(true);
    expect(released, "the re-pair was not released by this test").toBe("go");
    expect(competed?.status, "the competing delete was not applied").toBe(200);
    expect(competed?.row, "the competing delete removed the row").toBeNull();
    const resBody = await response.json() as any;
    console.log("deleted-row token re-pair body:", JSON.stringify(resBody));
    expect(response.status, JSON.stringify(resBody)).toBe(200);
    expect(resBody.paired).toBe(true);
    expect((await readToken(token))?.consumedBy, "the token records the peer it paired").toBe(peer);

    // The row is the one a first pair builds from this request — nothing of the deleted row.
    const row = await readPeer(peer);
    expect(row?.id).toBe(peer);
    expect(row?.publicKey).toBe(pub);
    expect(row?.pairAttemptWriteId).toBeTruthy();
    expect((await readToken(token))?.pairAttemptWriteId).toBe(row?.pairAttemptWriteId);
    expect(firstPairShape(row)).toEqual({
      role: "spoke", endpoint: null, status: "paired", relayOnly: false,
      lastSyncAt: null, lastMergeAt: null, lastSyncCursor: null,
    });
    expect(row?.pairedAt).toBe(row?.createdAt);
    expect(row?.updatedAt).toBe(row?.createdAt);
    expect(Date.parse(row?.createdAt), "createdAt is this pairing's, not the deleted row's").toBeGreaterThanOrEqual(startedAt - 1_000);

    // The same shape a plain first pair writes (control, same Harper).
    const k2 = nacl.sign.keyPair();
    const peer2 = `del-tok-first-${sfx}`;
    const token2 = `pt-del-first-${sfx}`;
    await seedToken(token2);
    const first = await pairRequest(pairBody(peer2, b64url(k2.publicKey), k2.secretKey, token2));
    expect(first.status, JSON.stringify(await first.clone().json())).toBe(200);
    const firstRow = await readPeer(peer2);
    expect(firstPairShape(row), "the row matches a plain first pair's").toEqual(firstPairShape(firstRow));
    expect(setFields(row), "the row sets exactly the fields a plain first pair sets").toEqual(setFields(firstRow));

    // Assert that the best-effort bootstrap-user cleanup succeeded in this case.
    const users = await ops({ operation: "list_users" }) as any[];
    expect(users.map((u) => u.username), "the token's bootstrap user is dropped").not.toContain(bootstrapUser);
  }, 90_000);

  for (const fault of ["dropped-write", "unreadable-read-back"] as const) {
    it(`a converted first pair with ${fault} does not report paired`, async () => {
      const k = nacl.sign.keyPair();
      const pub = b64url(k.publicKey);
      const peer = `converted-${fault}-${sfx}`;
      const token = `pt-converted-${fault}-${sfx}`;
      await seedPeer(peer, pub);
      await seedToken(token);
      const readFault = join(pauseDir, `arm.converted-peer-read-fail.${peer}`);
      try {
        const { response, paused, released, competed } = await withPaused(
          "federation-pair-first-commit",
          async () => {
            const converted = await withPaused(
              "federation-pair-repair-token-pre",
              () => pairRequest(pairBody(peer, pub, k.secretKey, token)),
              () => deletePeer(peer),
            );
            expect(converted.paused).toBe(true);
            expect(converted.released).toBe("go");
            expect(converted.competed?.status).toBe(200);
            expect(converted.competed?.row).toBeNull();
            return converted.response;
          },
          async () => {
            if (fault === "dropped-write") {
              await seedPeer(peer, pub);
              return readPeer(peer);
            }
            writeFileSync(readFault, "");
            return undefined;
          },
        );
        expect(paused).toBe(true);
        expect(released).toBe("go");
        const body = await response.json() as any;
        expect(response.status, JSON.stringify(body)).toBe(fault === "dropped-write" ? 409 : 503);
        expect(body.error).toBe(fault === "dropped-write" ? "peer_pair_unconfirmed" : "peer_read_back_unconfirmed");
        expect(body.outcome).toBe("unconfirmed");
        expect(body.paired).toBeUndefined();
        if (fault === "dropped-write") {
          expect(await readPeer(peer)).toEqual(competed);
          expect((await readPeer(peer))?.pairAttemptWriteId).toBeUndefined();
        } else {
          expect(existsSync(readFault), "the read-back consumed the fault").toBe(false);
          const row = await readPeer(peer);
          expect(row?.pairAttemptWriteId).toBeTruthy();
          expect((await readToken(token))?.pairAttemptWriteId).toBe(row?.pairAttemptWriteId);
        }
      } finally {
        rmSync(readFault, { force: true });
      }
    }, 90_000);
  }
});

// ─── A first-time pair confirms its Peer row is still absent in committed state (#2512) ───
//
// The first-pair branch decided from a Peer read taken OUTSIDE the token
// transaction and wrote the paired row without confirming that read: a pair or
// revoke committed for the instance after it did not stop the request from
// answering `paired` and consuming the token. The write is now staged with the
// token consume in one owned transaction and then confirmed against COMMITTED
// state (confirmCommittedRow, a fresh-context read): a row there is refused by
// name, the transaction aborts, the request writes no Peer row and the token
// stays unconsumed. Two windows are driven: before the owned transaction
// (federation-pair-first-pre) and after its token read (federation-pair-token),
// when that transaction's own read snapshot is already pinned. A change committed
// after the confirm read and before the commit is not covered: Harper has no
// compare-and-set on a table write.
//
// Mutation: drop only the confirm (the `confirmCommittedRow(... Peer ...)` call).
// All four interleavings then answer `200 paired` with the token consumed, and
// the assertions below fail. Measured on Harper 5.3.1 under that mutation: before
// the owned transaction, the stored row carried the request's key in place of the
// competing one; after the token read, the competing row stayed and the request
// answered `paired` for a row it did not store.

describe("flair#2512 — a first-time pair confirms its Peer row is still absent in committed state (real Harper)", () => {
  it("a pair committed before the owned transaction: refused, the committed row and key unchanged, the token unconsumed (federation-pair-first-pre)", async () => {
    const token = `pt-2512-pair-${sfx}`;
    const a = nacl.sign.keyPair();
    const b = nacl.sign.keyPair();
    const peer = `f2512-peer-${sfx}`;
    await seedToken(token);
    const tokenBefore = await readToken(token);
    expect(tokenBefore?.consumedBy, "the pairing token starts unconsumed").toBeFalsy();
    const { response, competed, released, paused } = await withPaused(
      "federation-pair-first-pre",
      () => pairRequest(pairBody(peer, b64url(a.publicKey), a.secretKey, token)),
      async () => { await seedPeer(peer, b64url(b.publicKey)); return readPeer(peer); },
    );
    expect(paused, "the first pairing was not paused before its owned transaction").toBe(true);
    expect(released, "the first pairing was not released by this test").toBe("go");
    expect(competed?.publicKey, "the competing direct write committed its own key").toBe(b64url(b.publicKey));
    const resBody = await response.json() as any;
    const rowAfter = await readPeer(peer);
    const tokenAfter = await readToken(token);
    console.log("f2512 pre pair body/row/token:", JSON.stringify({ status: response.status, body: resBody, keyIsCompetitor: rowAfter?.publicKey === b64url(b.publicKey), rowUnchanged: JSON.stringify(rowAfter) === JSON.stringify(competed), consumedBy: tokenAfter?.consumedBy ?? null }));
    expect(response.status, JSON.stringify(resBody)).toBe(409);
    expect(resBody.error).toBe("peer_row_appeared");
    expect(resBody.paired, "this request wrote no Peer row, so it does not report paired").toBeUndefined();
    expect(rowAfter, "the committed row is unchanged").toEqual(competed);
    expect(tokenAfter, "the refused first pair consumed no token").toEqual(tokenBefore);
  }, 60_000);

  it("a revoke committed before the owned transaction: refused, the committed revoked row and key unchanged, the token unconsumed (federation-pair-first-pre)", async () => {
    const token = `pt-2512-revoke-${sfx}`;
    const a = nacl.sign.keyPair();
    const b = nacl.sign.keyPair();
    const peer = `f2512-peer-rev-${sfx}`;
    await seedToken(token);
    const tokenBefore = await readToken(token);
    expect(tokenBefore?.consumedBy, "the pairing token starts unconsumed").toBeFalsy();
    // A pair then a revoke for the instance, both committed before the owned transaction.
    const { response, competed, released, paused } = await withPaused(
      "federation-pair-first-pre",
      () => pairRequest(pairBody(peer, b64url(a.publicKey), a.secretKey, token)),
      async () => {
        await seedPeer(peer, b64url(b.publicKey));
        return (await updatePeer(peer, { status: "revoked" })).row;
      },
    );
    expect(paused, "the first pairing was not paused before its owned transaction").toBe(true);
    expect(released, "the first pairing was not released by this test").toBe("go");
    expect(competed?.status, "the competing revoke committed its own revoked row").toBe("revoked");
    const resBody = await response.json() as any;
    const rowAfter = await readPeer(peer);
    const tokenAfter = await readToken(token);
    console.log("f2512 pre revoke body/row/token:", JSON.stringify({ status: response.status, body: resBody, keyIsCompetitor: rowAfter?.publicKey === b64url(b.publicKey), rowStatus: rowAfter?.status ?? null, rowUnchanged: JSON.stringify(rowAfter) === JSON.stringify(competed), consumedBy: tokenAfter?.consumedBy ?? null }));
    expect(response.status, JSON.stringify(resBody)).toBe(409);
    expect(resBody.error).toBe("peer_row_appeared");
    expect(resBody.paired, "this request wrote no Peer row, so it does not report paired").toBeUndefined();
    expect(rowAfter, "the committed revoked row is unchanged").toEqual(competed);
    expect(rowAfter, "the committed key is unchanged").toHaveProperty("publicKey", b64url(b.publicKey));
    expect(tokenAfter, "the refused first pair consumed no token").toEqual(tokenBefore);
  }, 60_000);

  it("a pair committed after the token read: refused, the committed row and key unchanged, the token unconsumed (federation-pair-token)", async () => {
    const token = `pt-2512-late-pair-${sfx}`;
    const a = nacl.sign.keyPair();
    const b = nacl.sign.keyPair();
    const peer = `f2512-late-peer-${sfx}`;
    await seedToken(token);
    const tokenBefore = await readToken(token);
    expect(tokenBefore?.consumedBy, "the pairing token starts unconsumed").toBeFalsy();
    const { response, competed, released, paused } = await withPaused(
      "federation-pair-token",
      () => pairRequest(pairBody(peer, b64url(a.publicKey), a.secretKey, token)),
      async () => { await seedPeer(peer, b64url(b.publicKey)); return readPeer(peer); },
    );
    expect(paused, "the first pairing was not paused after its token read").toBe(true);
    expect(released, "the first pairing was not released by this test").toBe("go");
    expect(competed?.publicKey, "the competing direct write committed its own key").toBe(b64url(b.publicKey));
    const resBody = await response.json() as any;
    const rowAfter = await readPeer(peer);
    const tokenAfter = await readToken(token);
    console.log("f2512 late pair body/row/token:", JSON.stringify({ status: response.status, body: resBody, keyIsCompetitor: rowAfter?.publicKey === b64url(b.publicKey), rowUnchanged: JSON.stringify(rowAfter) === JSON.stringify(competed), consumedBy: tokenAfter?.consumedBy ?? null }));
    expect(response.status, JSON.stringify(resBody)).toBe(409);
    expect(resBody.error).toBe("peer_row_appeared");
    expect(resBody.paired, "this request wrote no Peer row, so it does not report paired").toBeUndefined();
    expect(rowAfter, "the committed row is unchanged").toEqual(competed);
    expect(tokenAfter, "the refused first pair consumed no token").toEqual(tokenBefore);
  }, 60_000);

  it("a revoke committed after the token read: refused, the committed revoked row and key unchanged, the token unconsumed (federation-pair-token)", async () => {
    const token = `pt-2512-late-revoke-${sfx}`;
    const a = nacl.sign.keyPair();
    const b = nacl.sign.keyPair();
    const peer = `f2512-late-peer-rev-${sfx}`;
    await seedToken(token);
    const tokenBefore = await readToken(token);
    expect(tokenBefore?.consumedBy, "the pairing token starts unconsumed").toBeFalsy();
    // A pair then a revoke for the instance, both committed after the token read.
    const { response, competed, released, paused } = await withPaused(
      "federation-pair-token",
      () => pairRequest(pairBody(peer, b64url(a.publicKey), a.secretKey, token)),
      async () => {
        await seedPeer(peer, b64url(b.publicKey));
        return (await updatePeer(peer, { status: "revoked" })).row;
      },
    );
    expect(paused, "the first pairing was not paused after its token read").toBe(true);
    expect(released, "the first pairing was not released by this test").toBe("go");
    expect(competed?.status, "the competing revoke committed its own revoked row").toBe("revoked");
    const resBody = await response.json() as any;
    const rowAfter = await readPeer(peer);
    const tokenAfter = await readToken(token);
    console.log("f2512 late revoke body/row/token:", JSON.stringify({ status: response.status, body: resBody, keyIsCompetitor: rowAfter?.publicKey === b64url(b.publicKey), rowStatus: rowAfter?.status ?? null, rowUnchanged: JSON.stringify(rowAfter) === JSON.stringify(competed), consumedBy: tokenAfter?.consumedBy ?? null }));
    expect(response.status, JSON.stringify(resBody)).toBe(409);
    expect(resBody.error).toBe("peer_row_appeared");
    expect(resBody.paired, "this request wrote no Peer row, so it does not report paired").toBeUndefined();
    expect(rowAfter, "the committed revoked row is unchanged").toEqual(competed);
    expect(rowAfter, "the committed key is unchanged").toHaveProperty("publicKey", b64url(b.publicKey));
    expect(tokenAfter, "the refused first pair consumed no token").toEqual(tokenBefore);
  }, 60_000);

  it("CONTROL: with no competitor the first pair stores the row and consumes the token", async () => {
    const token = `pt-2512-ok-${sfx}`;
    const k = nacl.sign.keyPair();
    const peer = `f2512-peer-ok-${sfx}`;
    await seedToken(token);
    const res = await pairRequest(pairBody(peer, b64url(k.publicKey), k.secretKey, token));
    const body = await res.json() as any;
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.paired).toBe(true);
    const row = await readPeer(peer);
    expect(row?.status).toBe("paired");
    expect(row?.publicKey).toBe(b64url(k.publicKey));
    expect((await readToken(token))?.consumedBy, "the first pair consumed the token").toBe(peer);
  }, 60_000);
});

describe("flair#2656 — a first-time pair confirms the committed row after its commit (real Harper)", () => {
  it("a direct write committed in the confirmation-to-commit gap is refused, and the committed row is the competitor's", async () => {
    const token = `pt-2656-gap-${sfx}`;
    const a = nacl.sign.keyPair();
    const b = nacl.sign.keyPair();
    const peer = `f2656-peer-${sfx}`;
    await seedToken(token);
    const { response, competed, released, paused } = await withPaused(
      "federation-pair-first-commit",
      () => pairRequest(pairBody(peer, b64url(a.publicKey), a.secretKey, token)),
      async () => {
        // The first pair has staged its row but not committed. A competing direct
        // write for the same instance commits in the gap.
        await seedPeer(peer, b64url(b.publicKey));
        return readPeer(peer);
      },
    );
    expect(paused, "the first pair was not paused at its commit gap").toBe(true);
    expect(released, "the first pair was not released by this test").toBe("go");
    expect(competed?.publicKey, "the competing direct write committed its own key").toBe(b64url(b.publicKey));
    const body = await response.json() as any;
    expect(response.status, JSON.stringify(body)).toBe(409);
    expect(body.error).toBe("peer_pair_unconfirmed");
    expect(body.outcome).toBe("unconfirmed");
    expect(body.paired, "this request did not store its row, so it does not report paired").toBeUndefined();
    expect((await readPeer(peer))?.publicKey, "the committed row is the competitor's").toBe(b64url(b.publicKey));
  }, 60_000);

  for (const converted of [false, true]) {
    it(`a ${converted ? "converted" : "plain"} first pair with consumedBy cleared after commit does not report paired`, async () => {
      const token = `pt-2656-cleared-${converted}-${sfx}`;
      const k = nacl.sign.keyPair();
      const peer = `f2656-cleared-${converted}-${sfx}`;
      const pub = b64url(k.publicKey);
      await seedToken(token);
      if (converted) await seedPeer(peer, pub);
      const { response, competed, released, paused } = await withPaused(
        "federation-pair-first-read-back",
        async () => {
          if (!converted) return pairRequest(pairBody(peer, pub, k.secretKey, token));
          const repair = await withPaused(
            "federation-pair-repair-token-pre",
            () => pairRequest(pairBody(peer, pub, k.secretKey, token)),
            () => deletePeer(peer),
          );
          expect(repair.paused).toBe(true);
          expect(repair.released).toBe("go");
          expect(repair.competed?.status).toBe(200);
          expect(repair.competed?.row).toBeNull();
          return repair.response;
        },
        async () => {
          const before = await readToken(token);
          expect(before?.consumedBy).toBe(peer);
          expect(before?.consumedAt).toBeTruthy();
          expect(before?.pairAttemptWriteId).toBeTruthy();
          expect((await readPeer(peer))?.pairAttemptWriteId).toBe(before.pairAttemptWriteId);
          await ops({
            operation: "update", database: "flair", table: "PairingToken",
            records: [{ id: token, expiresAt: before.expiresAt, createdAt: before.createdAt, consumedBy: null }],
          });
          const after = await readToken(token);
          expect(after?.consumedBy).toBeNull();
          expect(after?.consumedAt).toBe(before.consumedAt);
          expect(after?.pairAttemptWriteId).toBe(before.pairAttemptWriteId);
          return after;
        },
      );
      expect(paused).toBe(true);
      expect(released).toBe("go");
      const body = await response.json() as any;
      expect(response.status, JSON.stringify(body)).toBe(409);
      expect(body.error).toBe("peer_pair_unconfirmed");
      expect(body.outcome).toBe("unconfirmed");
      expect(body.paired).toBeUndefined();
      expect(await readToken(token)).toEqual(competed);
    }, 90_000);
  }

  it("a competing direct write at the same consumedAt: an uncommitted marker does not report success", async () => {
    // A frozen child clock gives the pair and competing direct write the same `consumedAt`.
    const clockPreload = fileURLToPath(new URL("../helpers/harper-freeze-clock.cjs", import.meta.url));
    const frozenAt = Date.now();
    const frozenISO = new Date(frozenAt).toISOString();
    const outer = harper;
    let frozen: HarperInstance | undefined;
    try {
      frozen = await startHarper({
        cwd: component.dir,
        env: {
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${clockPreload}`.trim(),
        },
        serverEnv: {
          FLAIR_ENABLE_TEST_FAULT_INJECTION: "1",
          FLAIR_TEST_PAUSE_DIR: pauseDir,
          FLAIR_TEST_FROZEN_NOW: String(frozenAt),
        },
      });
      assertOwnInstance(frozen);
      harper = frozen;

      const token = `pt-2656-same-ms-${sfx}`;
      const a = nacl.sign.keyPair();
      const peer = `f2656-same-ms-${sfx}`;
      const publicKey = b64url(a.publicKey);
      await seedToken(token);
      const { response, released, paused } = await withPaused(
        "federation-pair-first-commit",
        () => pairRequest(pairBody(peer, publicKey, a.secretKey, token)),
        async () => {
          // A competing direct write at the SAME frozen instant stores value-equal
          // Peer and token rows with its own marker. This attempt's write is
          // the one the commit drops.
          await ops({
            operation: "insert", database: "flair", table: "Peer",
            records: [{
              id: peer, publicKey, role: "spoke", endpoint: null, status: "paired",
              relayOnly: false, pairedAt: frozenISO, createdAt: frozenISO, updatedAt: frozenISO,
              pairAttemptWriteId: "competitor-marker",
            }],
          });
          await ops({
            operation: "update", database: "flair", table: "PairingToken",
            records: [{ id: token, consumedBy: peer, consumedAt: frozenISO, pairAttemptWriteId: "competitor-marker" }],
          });
        },
      );
      expect(paused, "the first pair was not paused at its commit gap").toBe(true);
      expect(released, "the first pair was not released by this test").toBe("go");
      const body = await response.json() as any;
      expect(response.status, JSON.stringify(body)).toBe(409);
      expect(body.error).toBe("peer_pair_unconfirmed");
      expect(body.outcome).toBe("unconfirmed");
      expect(body.paired, "this request's own marker did not commit, so it does not report paired").toBeUndefined();
      expect((await readPeer(peer))?.publicKey, "the committed Peer row carries this attempt's staged values").toBe(publicKey);
      const tokenRow = await readToken(token);
      expect(tokenRow?.consumedBy, "the committed consume names this attempt's instance").toBe(peer);
      expect(tokenRow?.consumedAt, "the committed consume shares this attempt's consumedAt").toBe(frozenISO);
    } finally {
      harper = outer;
      if (frozen) await stopHarper(frozen);
    }
  }, 300_000);

  it("the ordinary success path confirms this attempt's marker on both committed rows", async () => {
    const token = `pt-2656-ok-marker-${sfx}`;
    const k = nacl.sign.keyPair();
    const peer = `f2656-ok-marker-${sfx}`;
    await seedToken(token);
    const res = await pairRequest(pairBody(peer, b64url(k.publicKey), k.secretKey, token));
    const body = await res.json() as any;
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.paired).toBe(true);
    const row = await readPeer(peer);
    const tokenRow = await readToken(token);
    expect(row?.publicKey).toBe(b64url(k.publicKey));
    expect(row?.pairAttemptWriteId, "the committed Peer row carries this attempt's marker").toBeTruthy();
    expect(tokenRow?.pairAttemptWriteId, "the committed token consume carries the same marker").toBe(row?.pairAttemptWriteId);
  }, 60_000);
});

describe("flair#2656 — re-pair post-commit confirmation (real Harper)", () => {
  for (const withToken of [true, false]) {
    for (const evidence of withToken ? ["Peer", "PairingToken", "unreadable"] : ["Peer", "unreadable"]) {
      it(`${withToken ? "token" : "no-token"} re-pair refuses unconfirmed evidence (${evidence})`, async () => {
        const token = `pt-2656-repair-${withToken}-${evidence}-${sfx}`;
        const k = nacl.sign.keyPair();
        const peer = `f2656-repair-${withToken}-${evidence}-${sfx}`;
        await seedPeer(peer, b64url(k.publicKey));
        if (withToken) await seedToken(token);
        const { response, competed, released, paused } = await withPaused(
          withToken ? "federation-pair-repair-token-commit" : "federation-pair-repair-commit",
          () => pairRequest(pairBody(peer, b64url(k.publicKey), k.secretKey, withToken ? token : undefined)),
          async () => {
            const peerRow = await readPeer(peer);
            expect(peerRow?.pairAttemptWriteId).toBeTruthy();
            if (withToken) {
              const tokenRow = await readToken(token);
              expect(tokenRow?.pairAttemptWriteId).toBe(peerRow.pairAttemptWriteId);
              expect(tokenRow?.consumedBy).toBe(peer);
              expect(tokenRow?.consumedAt).toBeTruthy();
            }
            if (evidence === "unreadable") {
              writeFileSync(join(pauseDir, `arm.converted-peer-read-fail.${peer}`), "");
              return peerRow;
            }
            const table = evidence;
            const row = table === "Peer" ? peerRow : await readToken(token);
            await ops({
              operation: "update", database: "flair", table,
              records: [{ ...row, pairAttemptWriteId: "other-attempt" }],
            });
            const committed = table === "Peer" ? await readPeer(peer) : await readToken(token);
            expect(committed?.pairAttemptWriteId).toBe("other-attempt");
            return committed;
          },
        );
        expect(paused).toBe(true);
        expect(released).toBe("go");
        const body = await response.json() as any;
        expect(response.status, JSON.stringify(body)).toBe(withToken ? 409 : 503);
        expect(body.error).toBe(withToken ? "peer_pair_unconfirmed" : "write_outcome_unknown");
        expect(body.outcome).toBe("unconfirmed");
        expect(body.paired).toBeUndefined();
        expect(evidence === "PairingToken" ? await readToken(token) : await readPeer(peer)).toEqual(competed);
      }, 90_000);
    }
  }
});

describe("flair#2691 — a re-pair write dropped in the confirmation-to-commit window (real Harper)", () => {
  for (const withToken of [true, false]) {
    it(`${withToken ? "token" : "no-token"} re-pair refuses a Peer write dropped before its commit`, async () => {
      const token = `pt-2691-${withToken}-${sfx}`;
      const k = nacl.sign.keyPair();
      const competitor = nacl.sign.keyPair();
      const peer = `f2691-${withToken}-${sfx}`;
      const pub = b64url(k.publicKey);
      const competitorKey = b64url(competitor.publicKey);
      await seedPeer(peer, pub);
      if (withToken) await seedToken(token);
      const seededPeer = await readPeer(peer);
      const { response, competed, released, paused } = await withPaused(
        withToken ? "federation-pair-repair-token-before-commit" : "federation-pair-repair-before-commit",
        () => pairRequest(pairBody(peer, pub, k.secretKey, withToken ? token : undefined)),
        async () => {
          // While the pause holds, the re-pair's own transaction has not
          // committed: the Peer read still returns the seeded row, with none of
          // this attempt's staged values.
          const inPause = await readPeer(peer);
          expect(inPause?.publicKey, "the committed Peer still holds the seeded key while the re-pair is paused").toBe(pub);
          expect(inPause, "the committed Peer carries none of this attempt's staged values while the re-pair is paused").toEqual(seededPeer);
          if (withToken) {
            const tokenInPause = await readToken(token);
            expect(tokenInPause?.consumedBy, "the pairing token is still unconsumed while the re-pair is paused").toBeUndefined();
            expect(tokenInPause?.pairAttemptWriteId, "no consume staged by this attempt is committed while the re-pair is paused").toBeUndefined();
          }
          // The re-pair's row is staged but not committed. A competing direct
          // write for the same Peer commits here.
          return updatePeer(peer, { publicKey: competitorKey });
        },
      );
      expect(paused, "the re-pair was not paused before its owned transaction committed").toBe(true);
      expect(released, "the re-pair was not released by this test").toBe("go");
      expect(competed?.status, "the competing write committed").toBe(200);
      expect(competed?.row?.publicKey, "the competing write holds its own key").toBe(competitorKey);
      const body = await response.json() as any;
      expect(response.status, JSON.stringify(body)).toBe(withToken ? 409 : 503);
      expect(body.error).toBe(withToken ? "peer_pair_unconfirmed" : "write_outcome_unknown");
      expect(body.outcome).toBe("unconfirmed");
      expect(body.paired, "this request's write did not commit, so it does not report paired").toBeUndefined();
      expect((await readPeer(peer))?.publicKey, "the committed row is the competitor's").toBe(competitorKey);
    }, 90_000);
  }
});
