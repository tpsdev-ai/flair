/**
 * persistLocalPeerLastSyncAt — flair#1146 + flair#1835 (PR-B).
 *
 * Callers stamp lastSyncAt only after confirmed FederationSync contact — a
 * successful batch OR the successful no-change liveness ping. lastSyncAt is the
 * spoke's OUTBOUND sync CURSOR (`federation sync` sends from it) and the
 * contact stamp behind HealthDetail's `connected`.
 *
 * flair#1146 shipped a read-then-full-upsert "hardening" write. On a legacy
 * pairing the local hub Peer row carries `publicKey: ""`, so the read's
 * `isCompletePeerRow` gate refused on every poll and the cursor froze (re-send
 * from the frozen point forever, and status went stale).
 *
 * flair#1835 PR-B replaces it with a FIELD-ONLY update — `{id, lastSyncAt,
 * updatedAt}` — that never reads the row, never carries `publicKey`/`status`,
 * and refuses when the update matched no row (deleted/missing), never inserting.
 *
 * The mock below models a real Harper: `update` MERGES the payload fields into
 * an existing row and inserts nothing on a miss; `upsert` REPLACES the whole
 * row (the destructive write PR-B removes); `search_by_value` serves a captured
 * snapshot (so a read-then-upsert reverts a concurrent change). `update`
 * responds with Harper's real shape: `{message, update_hashes, skipped_hashes}`.
 */

import { describe, expect, test, mock, afterEach, beforeEach, spyOn } from "bun:test";
import nacl from "tweetnacl";
import { persistLocalPeerLastSyncAt } from "../../src/commands/federation.ts";
import { classifyPeerLiveness } from "../../resources/federation-peer-liveness.ts";
import { classifyMissingAfterWindow } from "../../src/federation-verify.ts";
import { signBodyFresh, verifyBodySignatureFresh } from "../../resources/federation-crypto.ts";

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

const STAMP = "2026-09-23T06:00:00.000Z";

function resp(status: number, obj: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  } as Response;
}

/**
 * A stateful fake Harper ops endpoint.
 *   db        — the live table (what the row actually is NOW).
 *   snapshot  — what a `search_by_value` read returns (a possibly-stale view of
 *               a row that existed when the read happened).
 * Returns the list of request bodies for call-shape assertions.
 */
function makeOpsMock(opts: { db: Map<string, any>; snapshot?: any | null }) {
  const calls: any[] = [];
  globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push(body);
    if (body?.operation === "search_by_value") {
      return resp(200, opts.snapshot ? [opts.snapshot] : []);
    }
    if (body?.operation === "upsert") {
      // Full-row replace (the destructive write PR-B removes): recreates on a miss.
      for (const r of body.records ?? []) opts.db.set(r.id, { ...r });
      return resp(200, { message: `upserted ${body.records?.length ?? 0} of ${body.records?.length ?? 0} records`, upserted_hashes: (body.records ?? []).map((r: any) => r.id) });
    }
    if (body?.operation === "update") {
      const hits: string[] = [];
      const skipped: string[] = [];
      for (const r of body.records ?? []) {
        const row = opts.db.get(r.id);
        if (!row) { skipped.push(r.id); continue; }
        opts.db.set(r.id, { ...row, ...r }); // field-only merge, never inserts
        hits.push(r.id);
      }
      return resp(200, { message: `updated ${hits.length} of ${body.records?.length ?? 0} records`, update_hashes: hits, skipped_hashes: skipped });
    }
    throw new Error(`unexpected op ${body?.operation}`);
  }) as any;
  return calls;
}

function completeRow(extra: Record<string, any> = {}) {
  return {
    id: "hub-1",
    publicKey: "hub-public-key",
    role: "hub",
    status: "paired",
    endpoint: "https://hub.example",
    lastSyncAt: "2026-01-01T00:00:00.000Z",
    relayOnly: false,
    pairedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}

const AUTH = "Basic dGVzdA==";

function call(peerId = "hub-1") {
  return persistLocalPeerLastSyncAt({ opsEndpoint: "http://127.0.0.1:19925", auth: AUTH, peerId, lastSyncAt: STAMP });
}

// ── T7 — complete row: both timestamps stamped, every other field preserved ─
// GREEN CONTROL: the behavioural property holds on the base commit (the full
// upsert also preserves the row) and after the field-only change. Do NOT assert
// the call shape here — the shape (field-only `update`) is proven by T5 below.

describe("T7 — a complete row: both timestamps stamped, other fields preserved", () => {
  test("lastSyncAt/updatedAt = queriedAt; every other field preserved", async () => {
    const db = new Map<string, any>([["hub-1", completeRow()]]);
    makeOpsMock({ db, snapshot: completeRow() });

    const result = await call();
    expect(result.ok).toBe(true);
    const row = db.get("hub-1");
    expect(row.lastSyncAt).toBe(STAMP);
    expect(row.updatedAt).toBe(STAMP);
    expect(row.publicKey).toBe("hub-public-key");
    expect(row.status).toBe("paired");
    expect(row.role).toBe("hub");
    expect(row.endpoint).toBe("https://hub.example");
    expect(row.pairedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(row.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });
});

// ── T5 — a legacy keyless row advances (batch AND ping) ─────────────────────

describe("T5 — a legacy row with publicKey '' advances on batch and on ping", () => {
  test("batch: lastSyncAt/updatedAt = queriedAt, publicKey stays '', no warning", async () => {
    const db = new Map<string, any>([["hub-1", completeRow({ publicKey: "", lastSyncAt: "" })]]);
    const calls = makeOpsMock({ db });
    const warn = spyOn(console, "warn").mockImplementation(() => {});

    const result = await call();
    expect(result.ok).toBe(true); // ok:true is the documented no-warning condition
    // The write is FIELD-ONLY: {id, lastSyncAt, updatedAt} and nothing else —
    // so it cannot carry (and therefore cannot wipe) publicKey/status.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.operation).toBe("update");
    expect(calls[0]?.database).toBe("flair");
    expect(calls[0]?.table).toBe("Peer");
    expect(Object.keys(calls[0]?.records?.[0] ?? {}).sort()).toEqual(["id", "lastSyncAt", "updatedAt"]);
    const row = db.get("hub-1");
    expect(row.lastSyncAt).toBe(STAMP);
    expect(row.updatedAt).toBe(STAMP);
    expect(row.publicKey).toBe("");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test("no-change ping: same writer, same field-only result", async () => {
    const db = new Map<string, any>([["hub-1", completeRow({ publicKey: "", lastSyncAt: "" })]]);
    makeOpsMock({ db });
    const result = await call();
    expect(result.ok).toBe(true);
    expect(db.get("hub-1").lastSyncAt).toBe(STAMP);
    expect(db.get("hub-1").publicKey).toBe("");
  });
});

// ── T6 — a missing row is refused, and the refusal names the remedy ─────────

describe("T6 — a missing row is refused (no insert), naming the remedy", () => {
  test("update matched no row → refusal naming re-pair / the key repair", async () => {
    const db = new Map<string, any>(); // no row
    const calls = makeOpsMock({ db, snapshot: null });

    const result = await call();
    expect(result.ok).toBe(false);
    expect(result.error ?? "").toMatch(/re-?pair|#1837|repair/i);
    // No insert of any kind.
    expect(db.size).toBe(0);
    expect(calls.some((c) => c.operation === "upsert")).toBe(false);
    expect(calls.filter((c) => c.operation === "update").length).toBe(1);
  });
});

// ── T13/T14/T15 — the race the read-then-upsert lost ────────────────────────

describe("T13/T14/T15 — the field-only update cannot revert a concurrent change", () => {
  test("T13: a key repair between the read and the stamp is NOT reverted", async () => {
    // The row was repaired to a NEW key; a stale READ still holds the old key.
    const db = new Map<string, any>([["hub-1", completeRow({ publicKey: "new-key" })]]);
    makeOpsMock({ db, snapshot: completeRow({ publicKey: "old-key" }) });

    const result = await call();
    expect(result.ok).toBe(true);
    expect(db.get("hub-1").publicKey).toBe("new-key");
  });

  test("T14: a concurrent revocation between the read and the stamp is NOT reverted", async () => {
    const db = new Map<string, any>([["hub-1", completeRow({ status: "revoked" })]]);
    makeOpsMock({ db, snapshot: completeRow({ status: "paired" }) });

    const result = await call();
    expect(db.get("hub-1").status).toBe("revoked");
    expect(result.ok).toBe(true);
  });

  test("T15: a row deleted between the read and the stamp is NOT recreated", async () => {
    const db = new Map<string, any>(); // deleted
    makeOpsMock({ db, snapshot: completeRow() }); // the read saw it

    const result = await call();
    expect(db.size).toBe(0); // never recreated
    expect(result.ok).toBe(false); // refusal
  });
});

// ── T16 — acceptance: connected is contact; identity is verified elsewhere ──

describe("T16 — connected means recent contact, not a verified identity", () => {
  test("a fresh keyless row reads connected", () => {
    const now = Date.parse("2026-09-23T06:00:00.000Z");
    expect(classifyPeerLiveness({ status: "paired", lastSyncAt: STAMP }, now)).toBe("connected");
    // publicKey is not an input to liveness at all — a keyless row is contact.
    expect(classifyPeerLiveness({ status: "paired", lastSyncAt: "" }, now)).toBe("unknown");
  });

  test("signature verification rejects a keyless peer and accepts the pinned key", () => {
    // Sign a REAL request: an unsigned body returns invalid_signature at field
    // presence, so it never reaches the key check — a check that cannot fire.
    const kp = nacl.sign.keyPair();
    const pinnedKey = Buffer.from(kp.publicKey).toString("base64url");
    const signed = signBodyFresh({ instanceId: "peer-x", records: [], lamportClock: 1 }, kp.secretKey);
    // Known-absent: an EMPTY pinned key must NOT verify a correctly-signed request.
    expect(verifyBodySignatureFresh(signed, "", { windowMs: 30_000 }).ok).toBe(false);
    // Known-present: the CORRECT pinned key accepts the same request.
    expect(verifyBodySignatureFresh(signed, pinnedKey, { windowMs: 30_000 }).ok).toBe(true);
  });

  test("a canary with fresh contact but a failed injection stays unverifiable", () => {
    const now = Date.parse("2026-09-23T06:00:00.000Z");
    const verdict = classifyMissingAfterWindow({
      pushed: false,
      lastSyncAt: STAMP,
      nowMs: now,
      freshnessMs: 24 * 3600 * 1000,
      waitSeconds: 5,
    });
    expect(verdict.status).toBe("unverifiable");
  });
});
