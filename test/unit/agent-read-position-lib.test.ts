/**
 * Pure watermark helpers — position total-order, paging, init (flair#931).
 */
import { describe, expect, test } from "bun:test";
import {
  comparePosition,
  createdAtFloorFromPosition,
  DEFAULT_CATCHUP_BACKFILL_MS,
  initialPosition,
  laterTimestamp,
  pageAfter,
  parseBackfillMs,
  parsePageSize,
  positionAfterTimestamp,
  readPositionId,
  recordPosition,
} from "../../resources/agent-read-position-lib.ts";
import {
  catchupSeekTimestamp,
  eventTargetsParticipant,
  isCatchupEligible,
} from "../../resources/org-event-catchup-lib.ts";

describe("recordPosition — total order, not wall-clock since", () => {
  test("same-ms events are ordered by id (tie-break, not a drop)", () => {
    const ts = "2026-09-10T12:00:00.000Z";
    const a = recordPosition({ createdAt: ts, id: "a" });
    const b = recordPosition({ createdAt: ts, id: "b" });
    expect(comparePosition(a, b)).toBeLessThan(0);
    expect(comparePosition(b, a)).toBeGreaterThan(0);
    expect(comparePosition(a, a)).toBe(0);
  });

  test("later createdAt is a later position even when ids would sort the other way", () => {
    const early = recordPosition({ createdAt: "2026-01-01T00:00:00.000Z", id: "zzz" });
    const late = recordPosition({ createdAt: "2026-06-01T00:00:00.000Z", id: "aaa" });
    expect(comparePosition(early, late)).toBeLessThan(0);
  });

  test("positionAfterTimestamp is strictly before any record at that timestamp", () => {
    const ts = "2026-09-10T12:00:00.000Z";
    const cursor = positionAfterTimestamp(ts);
    const event = recordPosition({ createdAt: ts, id: "any" });
    expect(comparePosition(cursor, event)).toBeLessThan(0);
  });

  test("createdAtFloorFromPosition and laterTimestamp", () => {
    expect(createdAtFloorFromPosition(recordPosition({ createdAt: "2026-01-01T00:00:00.000Z", id: "x" })))
      .toBe("2026-01-01T00:00:00.000Z");
    expect(laterTimestamp("2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z"))
      .toBe("2026-02-01T00:00:00.000Z");
    expect(catchupSeekTimestamp(positionAfterTimestamp("2026-01-01T00:00:00.000Z"), "2026-06-01T00:00:00.000Z"))
      .toBe("2026-06-01T00:00:00.000Z");
  });

  test("readPositionId is per-agent and per-stream", () => {
    expect(readPositionId("krais", "org-event")).toBe("krais:org-event");
    expect(readPositionId("krais", "org-event")).not.toBe(readPositionId("rivet", "org-event"));
  });
});

describe("pageAfter — never silent truncation", () => {
  const rows = ["a", "b", "c", "d", "e"].map((id, i) => ({
    id,
    position: recordPosition({ createdAt: `2026-01-01T00:00:0${i}.000Z`, id }),
  }));

  test("page size 2 drains in three calls with hasMore then false", () => {
    const p1 = pageAfter(rows, "", 2);
    expect(p1.page.map((r) => r.id)).toEqual(["a", "b"]);
    expect(p1.hasMore).toBe(true);
    const p2 = pageAfter(rows, p1.nextAfter, 2);
    expect(p2.page.map((r) => r.id)).toEqual(["c", "d"]);
    expect(p2.hasMore).toBe(true);
    const p3 = pageAfter(rows, p2.nextAfter, 2);
    expect(p3.page.map((r) => r.id)).toEqual(["e"]);
    expect(p3.hasMore).toBe(false);
    const p4 = pageAfter(rows, p3.nextAfter, 2);
    expect(p4.page).toEqual([]);
    expect(p4.hasMore).toBe(false);
  });
});

describe("initialPosition / backfill", () => {
  test("unset env is the 24h bounded backfill", () => {
    expect(parseBackfillMs(undefined)).toBe(DEFAULT_CATCHUP_BACKFILL_MS);
    const now = Date.parse("2026-09-10T12:00:00.000Z");
    expect(initialPosition(now, DEFAULT_CATCHUP_BACKFILL_MS))
      .toBe(positionAfterTimestamp("2026-09-09T12:00:00.000Z"));
  });

  test("FLAIR_CATCHUP_BACKFILL_MS=0 is Flint's now", () => {
    expect(parseBackfillMs("0")).toBe(0);
    const now = Date.parse("2026-09-10T12:00:00.000Z");
    expect(initialPosition(now, 0)).toBe(positionAfterTimestamp("2026-09-10T12:00:00.000Z"));
  });
});

describe("parsePageSize", () => {
  test("clamps to [1, max]", () => {
    expect(parsePageSize(undefined)).toBe(50);
    expect(parsePageSize("10")).toBe(10);
    expect(parsePageSize(0)).toBe(1);
    expect(parsePageSize(9999)).toBe(500);
  });
});

describe("catch-up eligibility", () => {
  test("empty/null targetIds is a broadcast", () => {
    expect(eventTargetsParticipant({ targetIds: [] }, "krais")).toBe(true);
    expect(eventTargetsParticipant({ targetIds: null }, "krais")).toBe(true);
    expect(eventTargetsParticipant({}, "krais")).toBe(true);
    expect(eventTargetsParticipant({ targetIds: ["krais"] }, "rivet")).toBe(false);
  });

  test("event older than a 24h window but newer than watermark is eligible", () => {
    const watermark = positionAfterTimestamp("2026-09-01T00:00:00.000Z");
    const event = {
      id: "handoff",
      createdAt: "2026-09-08T00:00:00.000Z",
      targetIds: ["krais"],
    };
    const now = new Date("2026-09-10T12:00:00.000Z");
    const windowStart = "2026-09-09T12:00:00.000Z"; // old 24h floor
    expect(event.createdAt < windowStart).toBe(true);
    expect(isCatchupEligible(event, { participantId: "krais", after: watermark, now })).toBe(true);
    expect(isCatchupEligible(event, { participantId: "rivet", after: watermark, now })).toBe(false);
  });
});
