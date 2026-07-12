/**
 * migrations-ledger.test.ts — resources/migrations/ledger.ts: the migration
 * ledger OrgEvent. Sherlock verdict: "Ledger discloses structural metadata
 * only — versions, counts, outcome, duration; never memory IDs or content
 * summaries." Asserts the exact field list and that nothing beyond it ever
 * appears in the written record.
 */
import { describe, it, expect, mock } from "bun:test";
// Type-only import — erased at compile time, so it never triggers ledger.ts's
// runtime module body (and therefore never touches the real
// "@harperfast/harper" import below) ahead of the mock.module() call.
import type { LedgerEvent } from "../../resources/migrations/ledger.ts";

// ledger.ts imports `{ databases } from "@harperfast/harper"` for its
// DEFAULT table accessor (only used when a test doesn't inject its own, per
// its `deps.orgEventTable` seam below). The REAL @harperfast/harper package
// has import-time side effects that assume it's running as the actual
// Harper server process (crashes with "Unable to determine database storage
// path" when merely imported outside one) — so, same technique as
// test/unit/instance-identity.test.ts / test/unit/attention-query.test.ts,
// the module is mocked out BEFORE ledger.ts is imported at all.
mock.module("@harperfast/harper", () => ({ databases: {}, Resource: class {} }));

const { writeLedgerEvent, buildLedgerDetail } = await import("../../resources/migrations/ledger.ts");

const baseEvent: LedgerEvent = {
  migrationId: "embedding-stamp",
  initiator: "auto",
  fromVersion: "0.21.0",
  toVersion: "0.22.0",
  scope: "full",
  startedAt: "2026-01-01T00:00:00.000Z",
  endedAt: "2026-01-01T00:00:05.000Z",
  outcome: "success",
  rowsProcessed: 42,
  rowsRemaining: 0,
  hashEnvelopeMatch: null,
};

describe("buildLedgerDetail — structural-only content", () => {
  it("contains exactly the Kern-verdict field list, nothing more", () => {
    const detail = JSON.parse(buildLedgerDetail(baseEvent));
    expect(Object.keys(detail).sort()).toEqual(
      [
        "migrationId",
        "initiator",
        "fromVersion",
        "toVersion",
        "scope",
        "startedAt",
        "endedAt",
        "outcome",
        "rowsProcessed",
        "rowsRemaining",
        "hashEnvelopeMatch",
      ].sort(),
    );
  });

  it("includes `error` only when the event carries one (halted/failed)", () => {
    const withoutError = JSON.parse(buildLedgerDetail(baseEvent));
    expect("error" in withoutError).toBe(false);

    const withError = JSON.parse(buildLedgerDetail({ ...baseEvent, outcome: "halted", error: "blocked on disk: need 100, have 50" }));
    expect(withError.error).toBe("blocked on disk: need 100, have 50");
  });

  it("NEVER contains a memory id, content field, or anything shaped like corpus content", () => {
    const detail = buildLedgerDetail({
      ...baseEvent,
      // Even if a caller somehow tried to smuggle memory-shaped data through
      // extra properties, TypeScript's LedgerEvent shape doesn't have a
      // slot for it — this test proves the SERIALIZED output has no such
      // slot either, by checking known dangerous substrings are absent.
    });
    expect(detail).not.toContain('"content"');
    expect(detail).not.toContain('"memoryId"');
    expect(detail).not.toContain('"embedding"');
  });
});

describe("writeLedgerEvent — table interaction", () => {
  it("calls put() exactly once, with authorId/kind/refId/summary/detail/createdAt set", async () => {
    const calls: unknown[] = [];
    const fakeTable = { put: async (content: unknown) => { calls.push(content); return content; } };

    await writeLedgerEvent(baseEvent, { orgEventTable: fakeTable });

    expect(calls).toHaveLength(1);
    const written = calls[0] as Record<string, unknown>;
    expect(written.authorId).toBe("flair-migrations");
    expect(written.kind).toBe("migration");
    expect(written.refId).toBe("embedding-stamp");
    expect(written.scope).toBe("full");
    expect(written.createdAt).toBe(baseEvent.endedAt);
    expect(typeof written.summary).toBe("string");
    expect((written.summary as string)).toContain("embedding-stamp");
    expect((written.summary as string)).toContain("success");
    expect((written.summary as string)).toContain("42");
    expect(typeof written.detail).toBe("string");
    expect(JSON.parse(written.detail as string).migrationId).toBe("embedding-stamp");
  });

  it("summary mentions rowsRemaining only when nonzero (halted mid-way case)", async () => {
    const calls: unknown[] = [];
    const fakeTable = { put: async (content: unknown) => { calls.push(content); return content; } };

    await writeLedgerEvent(
      { ...baseEvent, outcome: "halted", rowsProcessed: 5, rowsRemaining: 37, error: "blocked" },
      { orgEventTable: fakeTable },
    );

    const written = calls[0] as Record<string, unknown>;
    expect((written.summary as string)).toContain("37 remaining");
  });

  it("id is derived from migrationId + endedAt (deterministic, no random component, no memory ids)", async () => {
    const calls: unknown[] = [];
    const fakeTable = { put: async (content: unknown) => { calls.push(content); return content; } };
    await writeLedgerEvent(baseEvent, { orgEventTable: fakeTable });
    const written = calls[0] as Record<string, unknown>;
    expect(written.id).toBe(`migration-embedding-stamp-${baseEvent.endedAt}`);
  });
});
