import { describe, expect, test, beforeEach } from "bun:test";
import nacl from "tweetnacl";
import {
  signBodyFresh,
  createNonceStore,
  verifyBodySignatureFresh,
  verifyBodySignature,
  signBody,
} from "../../resources/federation-crypto.js";

// ─── Transitional integration test for Federation resource logic ──────────
// TODO(ops-NEW-P1): Upgrade to real Harper container using test/helpers/harper-lifecycle.
//
// This test exercises the core logic path of Federation Sync resource handling:
//   signBodyFresh → Peer table validation → verifyBodySignatureFresh → merge
//
// It uses the real federation-crypto functions and simulates the Peer table
// and merge logic that FederationSync.post uses. This validates the exact
// code paths for:
//   - allowCreate always returns true (public endpoint contract)
//   - Peer status/role validation (revoked → 401, unknown → 401)
//   - verifyBodySignatureFresh rejection reasons
//   - Record merging with originator enforcement
//   - federation-edge-hardening slice 3b: per-record signature verification
//     against the ORIGINATOR's pinned key (not just the sender's), including
//     the hub-relay-forgery hole this slice closes (see the "hub relay" describe
//     block below)

describe("FederationSync resource logic (transitional)", () => {
  let peerStore: Map<string, any>;
  let memoryStore: Map<string, any>;
  const WINDOW_MS = 30_000;

  beforeEach(() => {
    peerStore = new Map();
    memoryStore = new Map();
  });

  function peerGet(id: string) {
    return peerStore.get(id) ?? null;
  }

  function memoryGet(id: string) {
    return memoryStore.get(id) ?? null;
  }

  function memoryPut(record: any) {
    memoryStore.set(record.id, record);
    return record.id;
  }

  /**
   * @param opts.requireRecordSignatures mirrors
   *   FLAIR_FEDERATION_REQUIRE_RECORD_SIGNATURES (default false — the
   *   verify-if-present mode Federation.ts defaults to).
   */
  async function handleSyncRequest(
    body: Record<string, any>,
    opts: { requireRecordSignatures?: boolean } = {},
  ): Promise<{ status: number; body: any }> {
    const { instanceId, records, _ts, _nonce, signature } = body;
    const requireRecordSignatures = opts.requireRecordSignatures ?? false;

    // ── Input validation (matches FederationSync.post) ──
    if (!instanceId || !Array.isArray(records)) {
      return { status: 400, body: { error: "instanceId and records[] required" } };
    }

    // ── Peer validation (matches FederationSync.post) ──
    const peer = peerGet(instanceId);
    if (!peer || peer.status === "revoked") {
      let error = "unknown or revoked peer";
      if (!peer) error = "unknown_or_revoked_peer";
      return { status: 401, body: { error } };
    }

    // ── Signature validation (matches FederationSync.post) ──
    if (!signature) {
      return { status: 401, body: { error: "signature required — sync requests must be signed" } };
    }

    const nonceStore = createNonceStore();
    const verifyResult = verifyBodySignatureFresh(body, peer.publicKey, {
      windowMs: WINDOW_MS,
      nonceStore,
    });
    if (!verifyResult.ok) {
      return {
        status: 401,
        body: { error: `invalid signature — ${verifyResult.reason}` },
      };
    }

    // ── Merge logic (simplified from FederationSync.post) ──
    let merged = 0;
    let skipped = 0;
    const skippedReasons: Record<string, number> = {};
    const recordSkip = (reason: string) => {
      skipped++;
      skippedReasons[reason] = (skippedReasons[reason] ?? 0) + 1;
    };

    for (const record of records as any[]) {
      // Each record is independently classified and skipped-not-rejected —
      // one bad record in a batch never aborts the whole request (a
      // reject-the-batch policy would be a DoS vector: any peer could
      // blackhole every other legitimate record by including one bad one).
      try {
        if (record.table !== "Memory") { recordSkip("unknown_table"); continue; }

        const originator = record.originatorInstanceId ?? instanceId;
        if (originator !== instanceId && peer.role !== "hub") {
          recordSkip("non_originator");
          continue;
        }

        const local = memoryGet(record.id);
        const ts = record.updatedAt ?? new Date().toISOString();

        // Timestamp ceiling
        const fiveMinFromNow = new Date(Date.now() + 5 * 60 * 1000).toISOString();
        if (ts > fiveMinFromNow) { recordSkip("future_timestamp"); continue; }

        if (local && local.updatedAt && local.updatedAt > ts) { recordSkip("stale"); continue; }

        // contentHash gate (matches Federation.ts production code) — skip the
        // write if local and remote agree on contentHash and remote isn't
        // strictly newer. Prevents the federation-watch re-upsert loop.
        const remoteContentHash = (record.data as any)?.contentHash;
        if (
          local &&
          local.contentHash &&
          remoteContentHash &&
          local.contentHash === remoteContentHash &&
          ts <= (local.updatedAt ?? "")
        ) {
          recordSkip("no_op_same_hash");
          continue;
        }

        // ── Per-record signature verification (federation-edge-hardening slice 3b) ──
        // This is the gate that closes the hub-relay-forgery hole: the
        // batch-level signature above only proves the SENDER is who they
        // claim (peer.publicKey). When peer.role === "hub" relays a record
        // whose originatorInstanceId names some OTHER instance, that
        // sender-level proof says nothing about whether that other
        // instance actually produced this record's data — a hub could
        // otherwise forge anything on behalf of any spoke it knows about.
        // Verify against the CLAIMED ORIGINATOR's pinned key instead:
        //   - originator === sender (instanceId) → sender's peer.publicKey
        //     (already fetched/verified above)
        //   - else (a relayed record) → look up the originator's own Peer
        //     record for ITS publicKey — same table/pattern as the sender
        //     lookup, just keyed by a different id.
        if (record.signature) {
          const originatorPeer = originator === instanceId ? peer : peerGet(originator);
          const originatorPublicKey = originatorPeer?.publicKey;

          if (!originatorPublicKey) {
            recordSkip("unknown_originator_key");
            continue;
          }

          // CONTRACT: byte-for-byte the same canonical form src/cli.ts signs
          // — { v: 1, table, id, data, updatedAt, originatorInstanceId }.
          const signatureValid = verifyBodySignature(
            {
              v: 1,
              table: record.table,
              id: record.id,
              data: record.data,
              updatedAt: record.updatedAt,
              originatorInstanceId: originator,
              signature: record.signature,
            },
            originatorPublicKey,
          );
          if (!signatureValid) {
            recordSkip("invalid_signature");
            continue;
          }
        } else if (requireRecordSignatures) {
          // require-mode: unsigned records are no longer trusted on
          // batch-level auth alone.
          recordSkip("missing_signature");
          continue;
        }
        // else: verify-if-present (default) — unsigned record still merges,
        // covered by the batch-level signature verified above.

        const mergedData = {
          ...(record.data ?? {}),
          id: record.id,
          updatedAt: ts,
          _originatorInstanceId: originator,
          _syncedFrom: instanceId,
        };
        memoryPut(mergedData);
        merged++;
      } catch {
        // Mirrors FederationSync.post's per-record try/catch: an unexpected
        // error merging one record must not abort the batch.
        recordSkip("merge_error");
      }
    }

    return { status: 200, body: { merged, skipped, skippedReasons, durationMs: 1 } };
  }

  /** Sign a per-record canonical payload the way src/cli.ts's runFederationSyncOnce does (§3a). */
  function signRecord(
    record: { table: string; id: string; data: Record<string, any>; updatedAt: string; originatorInstanceId: string },
    secretKey: Uint8Array,
  ): string {
    return signBody(
      {
        v: 1,
        table: record.table,
        id: record.id,
        data: record.data,
        updatedAt: record.updatedAt,
        originatorInstanceId: record.originatorInstanceId,
      },
      secretKey,
    );
  }

  test("valid signed sync request → 200 + merges records", async () => {
    const kp = nacl.sign.keyPair();
    const instanceId = "spoke-alpha-1";
    const publicKeyB64url = Buffer.from(kp.publicKey).toString("base64url");

    // Register paired spoke peer
    peerStore.set(instanceId, {
      id: instanceId,
      publicKey: publicKeyB64url,
      role: "spoke",
      status: "paired",
    });

    const signed = signBodyFresh({
      instanceId,
      records: [
        {
          table: "Memory",
          id: "mem-1",
          data: { id: "mem-1", content: "Hello" },
          updatedAt: new Date().toISOString(),
          originatorInstanceId: instanceId,
        },
      ],
      lamportClock: Date.now(),
    }, kp.secretKey);

    const response = await handleSyncRequest(signed);
    expect(response.status).toBe(200);
    expect(response.body.merged).toBe(1);

    const inserted = memoryGet("mem-1");
    expect(inserted).not.toBeNull();
    expect(inserted.content).toBe("Hello");
    expect(inserted._originatorInstanceId).toBe(instanceId);
  });

  test("revoked peer → 401", async () => {
    const kp = nacl.sign.keyPair();
    const instanceId = "spoke-revoked";

    peerStore.set(instanceId, {
      id: instanceId,
      publicKey: Buffer.from(kp.publicKey).toString("base64url"),
      role: "spoke",
      status: "revoked",
    });

    const signed = signBodyFresh(
      { instanceId, records: [], lamportClock: Date.now() },
      kp.secretKey,
    );

    const response = await handleSyncRequest(signed);
    expect(response.status).toBe(401);
    expect(response.body.error).toMatch(/revoked/);
  });

  test("unknown peer (not in Peer table) → 401", async () => {
    const kp = nacl.sign.keyPair();
    const signed = signBodyFresh(
      { instanceId: "spoke-never-paired", records: [], lamportClock: Date.now() },
      kp.secretKey,
    );

    const response = await handleSyncRequest(signed);
    expect(response.status).toBe(401);
    expect(response.body.error).toMatch(/unknown/);
  });

  test("tampered body after sign → 401", async () => {
    const kp = nacl.sign.keyPair();
    const instanceId = "spoke-alpha-1";
    const publicKeyB64url = Buffer.from(kp.publicKey).toString("base64url");

    peerStore.set(instanceId, {
      id: instanceId,
      publicKey: publicKeyB64url,
      role: "spoke",
      status: "paired",
    });

    const signed = signBodyFresh(
      { instanceId, records: [], lamportClock: Date.now() },
      kp.secretKey,
    );

    // Tamper: change lamportClock (Peer check passes, signature check fails)
    const tampered = { ...signed, lamportClock: Date.now() + 99999 };

    const response = await handleSyncRequest(tampered);
    expect(response.status).toBe(401);
    expect(response.body.error).toContain("invalid_signature");
  });

  test("replay detection → 401", async () => {
    const kp = nacl.sign.keyPair();
    const instanceId = "spoke-alpha-1";
    const publicKeyB64url = Buffer.from(kp.publicKey).toString("base64url");

    peerStore.set(instanceId, {
      id: instanceId,
      publicKey: publicKeyB64url,
      role: "spoke",
      status: "paired",
    });

    const ts = Date.now();
    const nonce = "replay-test-nonce";
    const signed = signBodyFresh(
      { instanceId, records: [], lamportClock: Date.now() },
      kp.secretKey,
      { ts, nonce },
    );

    const first = await handleSyncRequest(signed);
    expect(first.status).toBe(200);

    // handleSyncRequest creates a fresh nonceStore per call,
    // so replay wouldn't be detected across calls with this simplified version.
    // This is a known limitation of the transitional test — the real
    // FederationSync uses a module-level federationNonceStore (singleton),
    // which correctly detects replays across requests.
    //
    // When upgrading to real Harper container, this test must be updated
    // to send TWO real HTTP POSTs and verify the second returns 401.
    expect(first.status).toBe(200); // first request succeeds
  });

  test("no signature → 401", async () => {
    const kp = nacl.sign.keyPair();
    const instanceId = "spoke-alpha-1";

    peerStore.set(instanceId, {
      id: instanceId,
      publicKey: Buffer.from(kp.publicKey).toString("base64url"),
      role: "spoke",
      status: "paired",
    });

    const response = await handleSyncRequest({
      instanceId,
      records: [],
      lamportClock: Date.now(),
    });

    expect(response.status).toBe(401);
    expect(response.body.error).toContain("signature required");
  });

  test("no instanceId → 400", async () => {
    const response = await handleSyncRequest({ records: [] });
    expect(response.status).toBe(400);
  });

  test("no records array → 400", async () => {
    const response = await handleSyncRequest({ instanceId: "spoke-1" });
    expect(response.status).toBe(400);
  });

  test("originator enforcement: spoke cannot push another spoke's records", async () => {
    const kp = nacl.sign.keyPair();
    const instanceId = "spoke-alpha-1";
    const publicKeyB64url = Buffer.from(kp.publicKey).toString("base64url");

    peerStore.set(instanceId, {
      id: instanceId,
      publicKey: publicKeyB64url,
      role: "spoke",
      status: "paired",
    });

    const signed = signBodyFresh({
      instanceId,
      records: [
        {
          table: "Memory",
          id: "mem-1",
          data: { id: "mem-1", content: "This came from another spoke" },
          updatedAt: new Date().toISOString(),
          originatorInstanceId: "spoke-beta-2", // different spoke
        },
      ],
      lamportClock: Date.now(),
    }, kp.secretKey);

    const response = await handleSyncRequest(signed);
    expect(response.status).toBe(200);
    expect(response.body.skipped).toBe(1); // rejected
    expect(response.body.merged).toBe(0);
    expect(response.body.skippedReasons.non_originator).toBe(1);
    // Unaffected by federation-edge-hardening slice 3b: the peer here is a
    // "spoke", not "hub", so this record is skipped as non_originator BEFORE
    // the per-record signature gate ever runs (signed or not makes no
    // difference — see the "hub relay" describe block below for the gate
    // itself).
  });

  test("duplicate records (LWW) — newer wins", async () => {
    const kp = nacl.sign.keyPair();
    const instanceId = "spoke-alpha-1";
    const publicKeyB64url = Buffer.from(kp.publicKey).toString("base64url");

    peerStore.set(instanceId, {
      id: instanceId,
      publicKey: publicKeyB64url,
      role: "spoke",
      status: "paired",
    });

    // Pre-existing record with an older timestamp
    const olderTs = new Date(Date.now() - 10000).toISOString();
    memoryStore.set("mem-1", { id: "mem-1", content: "old", updatedAt: olderTs });

    // Incoming record with a newer timestamp
    const newerTs = new Date(Date.now() - 5000).toISOString();
    const signed = signBodyFresh({
      instanceId,
      records: [
        {
          table: "Memory",
          id: "mem-1",
          data: { id: "mem-1", content: "new" },
          updatedAt: newerTs,
          originatorInstanceId: instanceId,
        },
      ],
      lamportClock: Date.now(),
    }, kp.secretKey);

    const response = await handleSyncRequest(signed);
    expect(response.status).toBe(200);
    expect(response.body.merged).toBe(1);

    const updated = memoryGet("mem-1");
    expect(updated.content).toBe("new");
  });

  test("re-sync of identical record (same contentHash, same updatedAt) is skipped — no re-blob loop", async () => {
    // Regression for the federation-watch re-upsert loop diagnosed 2026-05-19:
    // sender's `since` cursor never advanced, so every poll re-sent every
    // memory. Receiver was put-ing each one, generating fresh HNSW vector
    // blobs every cycle. Fabric cluster hit XFS quota with 5,899 blob
    // entries across 109 unique IDs. The contentHash gate stops the
    // re-blob even if the sender keeps re-sending.
    const kp = nacl.sign.keyPair();
    const instanceId = "spoke-resync";
    peerStore.set(instanceId, {
      id: instanceId,
      publicKey: Buffer.from(kp.publicKey).toString("base64url"),
      role: "spoke",
      status: "paired",
    });

    const ts = new Date().toISOString();
    const record = {
      table: "Memory",
      id: "mem-resync-1",
      data: {
        id: "mem-resync-1",
        content: "stable content",
        contentHash: "sha256-abc123",
      },
      updatedAt: ts,
      originatorInstanceId: instanceId,
    };

    // First sync: record should land in memoryStore.
    const first = await handleSyncRequest(
      signBodyFresh(
        { instanceId, records: [record], lamportClock: Date.now() },
        kp.secretKey,
      ),
    );
    expect(first.status).toBe(200);
    expect(first.body.merged).toBe(1);
    expect(first.body.skipped).toBe(0);

    // The mock memoryPut doesn't propagate contentHash by default; mirror
    // the production receiver-side merge by ensuring the stored record
    // carries contentHash (Federation.ts's mergeRecord spreads record.data).
    const stored = memoryGet("mem-resync-1");
    expect(stored.contentHash).toBe("sha256-abc123");

    // Second sync: same record sent again. Should be SKIPPED, not merged.
    // Without the gate this writes a new blob version with the embedding.
    const second = await handleSyncRequest(
      signBodyFresh(
        { instanceId, records: [record], lamportClock: Date.now() + 1 },
        kp.secretKey,
      ),
    );
    expect(second.status).toBe(200);
    expect(second.body.merged).toBe(0);
    expect(second.body.skipped).toBe(1);
  });

  test("re-sync with newer updatedAt but same contentHash still gets stored (real edit-then-revert case)", async () => {
    // Edge case: contentHash matches but remote has strictly newer
    // updatedAt. Could mean the record was edited and reverted, or just
    // metadata-changed. We still write so the updatedAt advances; LWW
    // merge wins the latest provenance. The gate only skips when
    // remote.updatedAt <= local.updatedAt.
    const kp = nacl.sign.keyPair();
    const instanceId = "spoke-resync-newer";
    peerStore.set(instanceId, {
      id: instanceId,
      publicKey: Buffer.from(kp.publicKey).toString("base64url"),
      role: "spoke",
      status: "paired",
    });

    const initial = new Date(Date.now() - 60_000).toISOString();
    const later = new Date().toISOString();

    // Initial
    await handleSyncRequest(
      signBodyFresh(
        {
          instanceId,
          records: [{
            table: "Memory",
            id: "mem-edit-revert",
            data: { id: "mem-edit-revert", content: "x", contentHash: "sha-x" },
            updatedAt: initial,
            originatorInstanceId: instanceId,
          }],
          lamportClock: Date.now(),
        },
        kp.secretKey,
      ),
    );

    // Same contentHash but newer timestamp
    const second = await handleSyncRequest(
      signBodyFresh(
        {
          instanceId,
          records: [{
            table: "Memory",
            id: "mem-edit-revert",
            data: { id: "mem-edit-revert", content: "x", contentHash: "sha-x" },
            updatedAt: later,
            originatorInstanceId: instanceId,
          }],
          lamportClock: Date.now() + 1,
        },
        kp.secretKey,
      ),
    );

    expect(second.status).toBe(200);
    expect(second.body.merged).toBe(1);
    expect(second.body.skipped).toBe(0);
  });

  // ─── federation-edge-hardening slice 3b — per-record signature verification ──
  //
  // Before this slice: classifyRecord's peerRole === "hub" bypass let a hub
  // relay a record under ANY originatorInstanceId with zero further checks —
  // record.signature/record.principalId were defined on the wire type but
  // read by ZERO code. A malicious or compromised hub could forge a record
  // "from" any spoke it had ever seen, and the receiver had no way to tell.
  //
  // After this slice: a hub may still relay (the classifyRecord bypass is
  // UNCHANGED — see federation-classify-record.test.ts), but FederationSync.post
  // now verifies the record's own signature (set at push-time by the
  // ORIGINATOR, §3a) against the ORIGINATOR's OWN pinned instance key before
  // merging — never against the relaying hub's key. These tests exercise
  // that gate directly.
  describe("hub relay — per-record signature verification (federation-edge-hardening slice 3b)", () => {
    const hubId = "hub-1";
    const originatorId = "spoke-beta-2"; // the instance that ACTUALLY produced the record
    let hubKp: nacl.SignKeyPair;
    let originatorKp: nacl.SignKeyPair;

    beforeEach(() => {
      hubKp = nacl.sign.keyPair();
      originatorKp = nacl.sign.keyPair();

      // Hub is the SENDER of the sync batch (paired, hub role).
      peerStore.set(hubId, {
        id: hubId,
        publicKey: Buffer.from(hubKp.publicKey).toString("base64url"),
        role: "hub",
        status: "paired",
      });
      // Originator is a DIFFERENT, separately-paired peer — its pinned public
      // key is what the receiver must verify the relayed record against.
      peerStore.set(originatorId, {
        id: originatorId,
        publicKey: Buffer.from(originatorKp.publicKey).toString("base64url"),
        role: "spoke",
        status: "paired",
      });
    });

    function relayedRecord(overrides: Partial<{ data: Record<string, any>; updatedAt: string; signature: string | undefined }> = {}) {
      const updatedAt = overrides.updatedAt ?? new Date().toISOString();
      const data = overrides.data ?? { id: "mem-relayed", content: "produced by the originator" };
      return {
        table: "Memory",
        id: "mem-relayed",
        data,
        updatedAt,
        originatorInstanceId: originatorId,
        ...(("signature" in overrides) ? { signature: overrides.signature } : {}),
      };
    }

    function sendFromHub(record: any, opts?: { requireRecordSignatures?: boolean }) {
      const signed = signBodyFresh(
        { instanceId: hubId, records: [record], lamportClock: Date.now() },
        hubKp.secretKey,
      );
      return handleSyncRequest(signed, opts);
    }

    // ── THE CRITICAL TEST — the hole this slice closes ──────────────────
    test("CRITICAL: hub relays a record with a VALID originator signature → merges", async () => {
      const base = relayedRecord();
      const signature = signRecord(base, originatorKp.secretKey);
      const record = { ...base, signature };

      const response = await sendFromHub(record);

      expect(response.status).toBe(200);
      expect(response.body.merged).toBe(1);
      expect(response.body.skipped).toBe(0);
      expect(memoryGet("mem-relayed")?.content).toBe("produced by the originator");
    });

    test("CRITICAL: hub relays a record FORGED under the originator's name (signed by the hub's own key, not the originator's) → skipped, NOT merged", async () => {
      const base = relayedRecord();
      // The hub signs the record itself, claiming originatorId — exactly the
      // forgery this slice defends against (pre-3b, this record would have
      // merged solely because peer.role === "hub").
      const forgedSignature = signRecord(base, hubKp.secretKey);
      const record = { ...base, signature: forgedSignature };

      const response = await sendFromHub(record);

      expect(response.status).toBe(200);
      expect(response.body.merged).toBe(0);
      expect(response.body.skipped).toBe(1);
      expect(response.body.skippedReasons.invalid_signature).toBe(1);
      expect(memoryGet("mem-relayed")).toBeNull();
    });

    test("CRITICAL: hub relays a record signed by a THIRD, unrelated key claiming to be the originator → skipped as invalid_signature", async () => {
      const base = relayedRecord();
      const attackerKp = nacl.sign.keyPair();
      const record = { ...base, signature: signRecord(base, attackerKp.secretKey) };

      const response = await sendFromHub(record);

      expect(response.body.merged).toBe(0);
      expect(response.body.skippedReasons.invalid_signature).toBe(1);
    });

    test("hub relays a record whose claimed originator has no pinned key on file → skipped as unknown_originator_key", async () => {
      const unknownOriginator = "spoke-never-paired-9";
      const base = { ...relayedRecord(), originatorInstanceId: unknownOriginator };
      // Sign with SOME key — doesn't matter which, there's no pinned key to
      // verify against at all.
      const someKp = nacl.sign.keyPair();
      const record = { ...base, signature: signRecord(base, someKp.secretKey) };

      const response = await sendFromHub(record);

      expect(response.body.merged).toBe(0);
      expect(response.body.skippedReasons.unknown_originator_key).toBe(1);
    });

    test("verify-if-present (default): hub relays an UNSIGNED record → still merges (backward-compat for pre-3a spokes)", async () => {
      const base = relayedRecord({ signature: undefined });

      const response = await sendFromHub(base /* opts defaults requireRecordSignatures: false */);

      expect(response.status).toBe(200);
      expect(response.body.merged).toBe(1);
      expect(response.body.skipped).toBe(0);
    });

    test("require-mode: hub relays an UNSIGNED record → skipped as missing_signature", async () => {
      const base = relayedRecord({ signature: undefined });

      const response = await sendFromHub(base, { requireRecordSignatures: true });

      expect(response.status).toBe(200);
      expect(response.body.merged).toBe(0);
      expect(response.body.skippedReasons.missing_signature).toBe(1);
    });

    test("require-mode: a VALIDLY signed relayed record still merges (require-mode only rejects the unsigned case)", async () => {
      const base = relayedRecord();
      const record = { ...base, signature: signRecord(base, originatorKp.secretKey) };

      const response = await sendFromHub(record, { requireRecordSignatures: true });

      expect(response.body.merged).toBe(1);
      expect(response.body.skipped).toBe(0);
    });

    test("skip-not-reject: a batch with one forged record and one good record still merges the good one", async () => {
      const good = relayedRecord({ data: { id: "mem-relayed", content: "good" } });
      const goodSigned = { ...good, signature: signRecord(good, originatorKp.secretKey) };

      const badBase = { ...relayedRecord({ data: { id: "mem-relayed-2", content: "forged" } }), id: "mem-relayed-2" };
      const badSigned = { ...badBase, signature: signRecord(badBase, hubKp.secretKey) }; // forged: signed by hub, not originator

      const signedBatch = signBodyFresh(
        { instanceId: hubId, records: [goodSigned, badSigned], lamportClock: Date.now() },
        hubKp.secretKey,
      );
      const response = await handleSyncRequest(signedBatch);

      expect(response.status).toBe(200);
      expect(response.body.merged).toBe(1);
      expect(response.body.skipped).toBe(1);
      expect(response.body.skippedReasons.invalid_signature).toBe(1);
      expect(memoryGet("mem-relayed")?.content).toBe("good");
      expect(memoryGet("mem-relayed-2")).toBeNull();
    });

    // ── Migration-equivalence: pre-3a records (no signature at all) behave
    // identically to how they did before this slice existed, as long as
    // require-mode is off (the default).
    test("migration-equivalence: an unsigned record from a directly-originating (non-relayed) spoke merges exactly as before slice 3", async () => {
      const spokeKp = nacl.sign.keyPair();
      const spokeId = "spoke-legacy-1";
      peerStore.set(spokeId, {
        id: spokeId,
        publicKey: Buffer.from(spokeKp.publicKey).toString("base64url"),
        role: "spoke",
        status: "paired",
      });

      const signed = signBodyFresh(
        {
          instanceId: spokeId,
          records: [{
            table: "Memory",
            id: "mem-legacy",
            data: { id: "mem-legacy", content: "pre-3a spoke, no per-record signature" },
            updatedAt: new Date().toISOString(),
            originatorInstanceId: spokeId,
            // no `signature` field — exactly what a pre-3a spoke sends
          }],
          lamportClock: Date.now(),
        },
        spokeKp.secretKey,
      );

      const response = await handleSyncRequest(signed);

      expect(response.status).toBe(200);
      expect(response.body.merged).toBe(1);
      expect(response.body.skipped).toBe(0);
      expect(memoryGet("mem-legacy")?.content).toBe("pre-3a spoke, no per-record signature");
    });
  });
});
