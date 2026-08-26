import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import nacl from "tweetnacl";
import { signBody, verifyBodySignature } from "../../resources/federation-crypto.js";
import {
  classifyRecord,
  reconstructRecordVerifyBody,
  checkPrincipalEntitlement,
  recordSignatureVersion,
  PRINCIPAL_OWNING_TABLES,
  FEDERATION_TABLE_POLICY,
  FEDERATION_SYNC_TABLES,
  type SkipReason,
  type SyncRecord,
} from "../../resources/federation-classify.js";

/**
 * flair#1416 — federation principalId (completes slice 3a).
 *
 * Phase 1 tests below construct TODAY's wire shape by hand (sign v:1, omit
 * `v` from the record, optionally attach unsigned principalId). They do
 * not call runFederationSyncOnce. That is the criterion that catches the
 * v-not-on-the-wire trap: get reconstruction wrong and Phase 1 is a
 * fleet-wide outage rather than a no-op. The sender (Phase 2) is covered
 * separately in federation-sync-push-signing.test.ts.
 */

const knownTables = new Set(FEDERATION_SYNC_TABLES);
const NOW = new Date("2026-08-26T00:00:00Z");

function kp() {
  const pair = nacl.sign.keyPair();
  return {
    secretKey: pair.secretKey,
    publicKey: Buffer.from(pair.publicKey).toString("base64url"),
  };
}

/** Today's sender: sign {v:1, table, id, data, updatedAt, originatorInstanceId}, send WITHOUT v. */
function todaysWireRecord(
  fields: {
    table: string;
    id: string;
    data: Record<string, any>;
    updatedAt: string;
    originatorInstanceId: string;
    principalId?: string;
  },
  secretKey: Uint8Array,
): SyncRecord {
  const signature = signBody(
    {
      v: 1,
      table: fields.table,
      id: fields.id,
      data: fields.data,
      updatedAt: fields.updatedAt,
      originatorInstanceId: fields.originatorInstanceId,
    },
    secretKey,
  );
  const record: SyncRecord = {
    table: fields.table,
    id: fields.id,
    data: fields.data,
    updatedAt: fields.updatedAt,
    originatorInstanceId: fields.originatorInstanceId,
    signature,
  };
  if (fields.principalId) record.principalId = fields.principalId;
  return record;
}

function v2WireRecord(
  fields: {
    table: string;
    id: string;
    data: Record<string, any>;
    updatedAt: string;
    originatorInstanceId: string;
    principalId?: string;
  },
  secretKey: Uint8Array,
): SyncRecord {
  const signed: Record<string, any> = {
    v: 2,
    table: fields.table,
    id: fields.id,
    data: fields.data,
    updatedAt: fields.updatedAt,
    originatorInstanceId: fields.originatorInstanceId,
  };
  if (fields.principalId) signed.principalId = fields.principalId;
  const signature = signBody(signed, secretKey);
  const record: SyncRecord = {
    v: 2,
    table: fields.table,
    id: fields.id,
    data: fields.data,
    updatedAt: fields.updatedAt,
    originatorInstanceId: fields.originatorInstanceId,
    signature,
  };
  if (fields.principalId) record.principalId = fields.principalId;
  return record;
}

/**
 * Apply-path simulation matching FederationSync.post's order:
 * classify → verify signature → checkPrincipalEntitlement.
 * No Harper, no Agent.get.
 */
function applyRecord(
  record: SyncRecord,
  opts: {
    peerRole?: string;
    receiverInstanceId?: string;
    originatorPublicKey: string;
    enforceV1Principal?: boolean;
    local?: Record<string, any> | null;
  },
): { action: "merge"; originator: string } | { action: "skip"; reason: SkipReason } {
  const peerRole = opts.peerRole ?? "spoke";
  const receiverInstanceId = opts.receiverInstanceId ?? record.originatorInstanceId;
  const decision = classifyRecord(
    record,
    peerRole,
    receiverInstanceId,
    opts.local ?? null,
    knownTables,
    NOW,
  );
  if (decision.action === "skip") return decision;

  if (record.signature) {
    const ok = verifyBodySignature(
      reconstructRecordVerifyBody(record, decision.originator),
      opts.originatorPublicKey,
    );
    if (!ok) return { action: "skip", reason: "invalid_signature" };
  }

  const principalSkip = checkPrincipalEntitlement(record, {
    enforceV1Principal: opts.enforceV1Principal,
  });
  if (principalSkip) return { action: "skip", reason: principalSkip };
  return { action: "merge", originator: decision.originator };
}

describe("flair#1416 — Phase 1 receiver reconstructs today's records unchanged", () => {
  it("recordSignatureVersion defaults absent v to 1 — the load-bearing default", () => {
    expect(recordSignatureVersion({})).toBe(1);
    expect(recordSignatureVersion({ v: undefined })).toBe(1);
    expect(recordSignatureVersion({ v: 2 })).toBe(2);
  });

  it("today's wire (no v, no principalId) verifies under reconstructRecordVerifyBody", () => {
    const keys = kp();
    const record = todaysWireRecord(
      {
        table: "Memory",
        id: "mem-legacy",
        data: { id: "mem-legacy", content: "pre-1416", agentId: "agt_a" },
        updatedAt: "2026-08-01T00:00:00.000Z",
        originatorInstanceId: "spoke-1",
      },
      keys.secretKey,
    );
    expect("v" in record).toBe(false);
    const body = reconstructRecordVerifyBody(record, "spoke-1");
    expect(body.v).toBe(1);
    expect("principalId" in body).toBe(false);
    expect(verifyBodySignature(body, keys.publicKey)).toBe(true);
  });

  it("today's wire WITH unsigned principalId still verifies — spreading it would 401 the fleet", () => {
    const keys = kp();
    const record = todaysWireRecord(
      {
        table: "Memory",
        id: "mem-prov",
        data: { id: "mem-prov", content: "has stamp", agentId: "agt_a" },
        updatedAt: "2026-08-01T00:00:00.000Z",
        originatorInstanceId: "spoke-1",
        principalId: "agt_a",
      },
      keys.secretKey,
    );
    expect(record.principalId).toBe("agt_a");
    expect("v" in record).toBe(false);

    const body = reconstructRecordVerifyBody(record, "spoke-1");
    expect(body.v).toBe(1);
    expect("principalId" in body).toBe(false);
    expect(verifyBodySignature(body, keys.publicKey)).toBe(true);

    // The naive spread the issue warns against: include principalId in a
    // v:1 verify body. Must fail closed — this is why reconstruct strips it.
    const naive = {
      v: 1,
      table: record.table,
      id: record.id,
      data: record.data,
      updatedAt: record.updatedAt,
      originatorInstanceId: "spoke-1",
      principalId: record.principalId,
      signature: record.signature,
    };
    expect(verifyBodySignature(naive, keys.publicKey)).toBe(false);
  });

  it("naive reconstruct without `v ?? 1` fails every existing record (the trap)", () => {
    const keys = kp();
    const record = todaysWireRecord(
      {
        table: "Memory",
        id: "mem-nov",
        data: { id: "mem-nov", content: "no v on wire" },
        updatedAt: "2026-08-01T00:00:00.000Z",
        originatorInstanceId: "spoke-1",
      },
      keys.secretKey,
    );
    const { signature, ...payload } = record;
    // `{ v, ...payload }` with v defaulted is what we ship. Spreading first
    // without a default drops v (it was never on the record).
    const droppedV = { ...payload, originatorInstanceId: "spoke-1", signature };
    expect("v" in droppedV).toBe(false);
    expect(verifyBodySignature(droppedV, keys.publicKey)).toBe(false);
    expect(
      verifyBodySignature(reconstructRecordVerifyBody(record, "spoke-1"), keys.publicKey),
    ).toBe(true);
  });

  it("Phase 1 apply path merges today's Memory records (signed, no v) unchanged", () => {
    const keys = kp();
    const record = todaysWireRecord(
      {
        table: "Memory",
        id: "mem-apply",
        data: { id: "mem-apply", content: "hello", agentId: "agt_a" },
        updatedAt: "2026-08-01T00:00:00.000Z",
        originatorInstanceId: "spoke-1",
        principalId: "agt_a",
      },
      keys.secretKey,
    );
    expect(applyRecord(record, { originatorPublicKey: keys.publicKey })).toEqual({
      action: "merge",
      originator: "spoke-1",
    });
  });
});

describe("flair#1416 — v:2 verifies; v:1 body under the new field set fails closed", () => {
  it("v:2 signature with principalId verifies end-to-end", () => {
    const keys = kp();
    const record = v2WireRecord(
      {
        table: "Memory",
        id: "mem-v2",
        data: { id: "mem-v2", content: "v2", agentId: "agt_a" },
        updatedAt: "2026-08-01T00:00:00.000Z",
        originatorInstanceId: "spoke-1",
        principalId: "agt_a",
      },
      keys.secretKey,
    );
    expect(record.v).toBe(2);
    const body = reconstructRecordVerifyBody(record, "spoke-1");
    expect(body.v).toBe(2);
    expect(body.principalId).toBe("agt_a");
    expect(verifyBodySignature(body, keys.publicKey)).toBe(true);
    expect(applyRecord(record, { originatorPublicKey: keys.publicKey })).toEqual({
      action: "merge",
      originator: "spoke-1",
    });
  });

  it("a v:1 body under the v:2 field set (principalId included) fails closed", () => {
    const keys = kp();
    const v1 = todaysWireRecord(
      {
        table: "Memory",
        id: "mem-fail-closed",
        data: { id: "mem-fail-closed", content: "v1", agentId: "agt_a" },
        updatedAt: "2026-08-01T00:00:00.000Z",
        originatorInstanceId: "spoke-1",
        principalId: "agt_a",
      },
      keys.secretKey,
    );
    // Force the receiver to treat this as v:2 — new field set, old signature.
    const asV2 = { ...v1, v: 2 };
    expect(
      verifyBodySignature(reconstructRecordVerifyBody(asV2, "spoke-1"), keys.publicKey),
    ).toBe(false);
    expect(applyRecord(asV2, { originatorPublicKey: keys.publicKey })).toEqual({
      action: "skip",
      reason: "invalid_signature",
    });
  });

  it("a v:2 signature does not verify when reconstructed as v:1", () => {
    const keys = kp();
    const v2 = v2WireRecord(
      {
        table: "Memory",
        id: "mem-v2-as-v1",
        data: { id: "mem-v2-as-v1", content: "v2", agentId: "agt_a" },
        updatedAt: "2026-08-01T00:00:00.000Z",
        originatorInstanceId: "spoke-1",
        principalId: "agt_a",
      },
      keys.secretKey,
    );
    const asV1 = { ...v2, v: undefined };
    delete (asV1 as { v?: number }).v;
    // Reconstruct defaults v→1 and strips principalId — different field set.
    const body = reconstructRecordVerifyBody(asV1, "spoke-1");
    expect(body.v).toBe(1);
    expect("principalId" in body).toBe(false);
    expect(verifyBodySignature(body, keys.publicKey)).toBe(false);
  });
});

describe("flair#1416 — Phase 1 receiver verifies v:1 and v:2 in the same batch", () => {
  it("mixed batch: today's record and a v:2 Memory both merge; one skip does not blackhole the batch", () => {
    const keys = kp();
    const v1 = todaysWireRecord(
      {
        table: "Memory",
        id: "mem-v1-mixed",
        data: { id: "mem-v1-mixed", content: "old", agentId: "agt_a" },
        updatedAt: "2026-08-01T00:00:00.000Z",
        originatorInstanceId: "spoke-1",
      },
      keys.secretKey,
    );
    const v2 = v2WireRecord(
      {
        table: "Memory",
        id: "mem-v2-mixed",
        data: { id: "mem-v2-mixed", content: "new", agentId: "agt_a" },
        updatedAt: "2026-08-01T00:00:00.000Z",
        originatorInstanceId: "spoke-1",
        principalId: "agt_a",
      },
      keys.secretKey,
    );
    const bad = v2WireRecord(
      {
        table: "Memory",
        id: "mem-bad-mixed",
        data: { id: "mem-bad-mixed", content: "no principal", agentId: "agt_a" },
        updatedAt: "2026-08-01T00:00:00.000Z",
        originatorInstanceId: "spoke-1",
        // principalId omitted — Memory + v:2 → skip
      },
      keys.secretKey,
    );

    const skippedReasons: Partial<Record<SkipReason, number>> = {};
    const merged: string[] = [];
    for (const record of [v1, v2, bad]) {
      const result = applyRecord(record, { originatorPublicKey: keys.publicKey });
      if (result.action === "merge") merged.push(record.id);
      else skippedReasons[result.reason] = (skippedReasons[result.reason] ?? 0) + 1;
    }
    expect(merged).toEqual(["mem-v1-mixed", "mem-v2-mixed"]);
    expect(skippedReasons.principal_mismatch).toBe(1);
  });
});

describe("flair#1416 — principal entitlement is table-scoped, never field-presence", () => {
  it("PRINCIPAL_OWNING_TABLES is exactly Memory — Soul/Agent/Relationship are not in the set", () => {
    expect([...PRINCIPAL_OWNING_TABLES].sort()).toEqual(["Memory"]);
    expect(FEDERATION_TABLE_POLICY.Memory.principalOwning).toBe(true);
    expect(FEDERATION_TABLE_POLICY.Soul.principalOwning).toBe(false);
    expect(FEDERATION_TABLE_POLICY.Agent.principalOwning).toBe(false);
    expect(FEDERATION_TABLE_POLICY.Relationship.principalOwning).toBe(false);
    expect(FEDERATION_SYNC_TABLES.sort()).toEqual(["Agent", "Memory", "Relationship", "Soul"]);
  });

  it("SkipReason union includes principal_mismatch (closed vocabulary)", () => {
    const reason: SkipReason = "principal_mismatch";
    expect(reason).toBe("principal_mismatch");
    // The apply path records this on SyncLog.skippedReasons via recordSkip().
    const keys = kp();
    const record = v2WireRecord(
      {
        table: "Memory",
        id: "mem-skip-fires",
        data: { id: "mem-skip-fires", content: "x", agentId: "agt_a" },
        updatedAt: "2026-08-01T00:00:00.000Z",
        originatorInstanceId: "spoke-1",
      },
      keys.secretKey,
    );
    const skippedReasons: Record<string, number> = {};
    const result = applyRecord(record, { originatorPublicKey: keys.publicKey });
    expect(result).toEqual({ action: "skip", reason: "principal_mismatch" });
    if (result.action === "skip") {
      skippedReasons[result.reason] = (skippedReasons[result.reason] ?? 0) + 1;
    }
    expect(skippedReasons.principal_mismatch).toBe(1);
  });

  it("Memory with principalId omitted is SKIPPED, not accepted — even when data.agentId is present", () => {
    const keys = kp();
    const record = v2WireRecord(
      {
        table: "Memory",
        id: "mem-omit",
        data: { id: "mem-omit", content: "has agentId", agentId: "agt_a" },
        updatedAt: "2026-08-01T00:00:00.000Z",
        originatorInstanceId: "spoke-1",
      },
      keys.secretKey,
    );
    expect("principalId" in record).toBe(false);
    expect(record.data.agentId).toBe("agt_a");
    expect(checkPrincipalEntitlement(record)).toBe("principal_mismatch");
    expect(applyRecord(record, { originatorPublicKey: keys.publicKey })).toEqual({
      action: "skip",
      reason: "principal_mismatch",
    });
  });

  it("Memory with principalId that does not equal data.agentId is skipped", () => {
    const keys = kp();
    const record = v2WireRecord(
      {
        table: "Memory",
        id: "mem-mismatch",
        data: { id: "mem-mismatch", content: "x", agentId: "agt_a" },
        updatedAt: "2026-08-01T00:00:00.000Z",
        originatorInstanceId: "spoke-1",
        principalId: "agt_other",
      },
      keys.secretKey,
    );
    expect(checkPrincipalEntitlement(record)).toBe("principal_mismatch");
    expect(applyRecord(record, { originatorPublicKey: keys.publicKey })).toEqual({
      action: "skip",
      reason: "principal_mismatch",
    });
  });

  it("Soul / Agent / Relationship with no principalId still merge (apply / pull direction)", () => {
    const keys = kp();
    for (const table of ["Soul", "Agent", "Relationship"] as const) {
      const record = v2WireRecord(
        {
          table,
          id: `${table.toLowerCase()}-1`,
          data: { id: `${table.toLowerCase()}-1`, name: table },
          updatedAt: "2026-08-01T00:00:00.000Z",
          originatorInstanceId: "spoke-1",
        },
        keys.secretKey,
      );
      expect("principalId" in record).toBe(false);
      expect(checkPrincipalEntitlement(record)).toBeNull();
      expect(applyRecord(record, { originatorPublicKey: keys.publicKey })).toEqual({
        action: "merge",
        originator: "spoke-1",
      });
    }
  });

  it("Soul / Agent / Relationship still merge when a hub relays them (other direction)", () => {
    const keys = kp();
    for (const table of ["Soul", "Agent", "Relationship"] as const) {
      const record = v2WireRecord(
        {
          table,
          id: `${table.toLowerCase()}-relay`,
          data: { id: `${table.toLowerCase()}-relay`, name: table },
          updatedAt: "2026-08-01T00:00:00.000Z",
          originatorInstanceId: "spoke-originator",
        },
        keys.secretKey,
      );
      expect(
        applyRecord(record, {
          originatorPublicKey: keys.publicKey,
          peerRole: "hub",
          receiverInstanceId: "hub-1",
        }),
      ).toEqual({ action: "merge", originator: "spoke-originator" });
    }
  });

  it("Phase 3 flag: v:1 Memory lacking principalId is skipped only when enforceV1Principal is on", () => {
    const keys = kp();
    const record = todaysWireRecord(
      {
        table: "Memory",
        id: "mem-phase3",
        data: { id: "mem-phase3", content: "legacy", agentId: "agt_a" },
        updatedAt: "2026-08-01T00:00:00.000Z",
        originatorInstanceId: "spoke-1",
      },
      keys.secretKey,
    );
    expect(applyRecord(record, { originatorPublicKey: keys.publicKey })).toEqual({
      action: "merge",
      originator: "spoke-1",
    });
    expect(
      applyRecord(record, {
        originatorPublicKey: keys.publicKey,
        enforceV1Principal: true,
      }),
    ).toEqual({ action: "skip", reason: "principal_mismatch" });
  });

  it("Phase 3 flag does not consult principalId on Soul/Agent/Relationship", () => {
    const keys = kp();
    const record = todaysWireRecord(
      {
        table: "Soul",
        id: "soul-phase3",
        data: { id: "soul-phase3" },
        updatedAt: "2026-08-01T00:00:00.000Z",
        originatorInstanceId: "spoke-1",
      },
      keys.secretKey,
    );
    expect(
      applyRecord(record, {
        originatorPublicKey: keys.publicKey,
        enforceV1Principal: true,
      }),
    ).toEqual({ action: "merge", originator: "spoke-1" });
  });
});

describe("flair#1416 — no Agent.get on the apply path", () => {
  it("checkPrincipalEntitlement is a pure function of the record — 1 required arg, not async", () => {
    expect(checkPrincipalEntitlement.length).toBe(1);
    expect(checkPrincipalEntitlement.constructor.name).toBe("Function");
  });

  it("FederationSync.post does not call Agent.get (the originatorInstanceId shortcut)", () => {
    const src = readFileSync(join(import.meta.dir, "../../resources/Federation.ts"), "utf8");
    const start = src.indexOf("export class FederationSync");
    const end = src.indexOf("export class FederationPeers");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const postClass = src.slice(start, end);
    expect(postClass).not.toMatch(/Agent\.get\s*\(/);
    // The apply path must use the extracted helpers, not a field-presence check.
    expect(postClass).toContain("reconstructRecordVerifyBody(");
    expect(postClass).toContain("checkPrincipalEntitlement(");
  });

  it("Federation.ts tableMap is typed against FEDERATION_TABLE_POLICY (exhaustiveness)", () => {
    const src = readFileSync(join(import.meta.dir, "../../resources/Federation.ts"), "utf8");
    expect(src).toContain("Record<FederationSyncTable,");
    expect(src).toContain("checkPrincipalEntitlement(");
  });

  it("cli.ts push table list matches FEDERATION_SYNC_TABLES — no silent extra table", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/cli.ts"), "utf8");
    const match = src.match(/const tables = \[([^\]]+)\]/);
    expect(match).toBeTruthy();
    const listed = match![1]
      .split(",")
      .map((s) => s.replace(/["'\s]/g, ""))
      .filter(Boolean);
    expect(listed.sort()).toEqual([...FEDERATION_SYNC_TABLES].sort());
  });
});
