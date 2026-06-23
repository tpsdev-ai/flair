// Unit tests for the memory consolidation candidate logic (Flair #502).
//
// The bug: `rem light` flagged brand-new, never-retrieved memories for archive
// because idle age keyed off `lastRetrieved` (null → Infinity) with no fallback
// to `createdAt`. A minutes-old memory read as "Not retrieved in Infinity days"
// and became an archive candidate.
//
// These tests exercise the real shipped `evaluate` from the Harper-free lib
// (importing MemoryConsolidate.ts directly pulls in the Harper runtime).

import { describe, test, expect } from "bun:test";
import { evaluate, parseDuration } from "../../resources/memory-consolidate-lib.ts";

const DAY = 86400_000;
const NOW = Date.parse("2026-06-23T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const THIRTY_D = 30 * DAY;

describe("parseDuration", () => {
  test("parses days / hours / minutes", () => {
    expect(parseDuration("7d")).toBe(7 * DAY);
    expect(parseDuration("12h")).toBe(12 * 3600_000);
    expect(parseDuration("90m")).toBe(90 * 60_000);
  });
  test("defaults to 30d on garbage input", () => {
    expect(parseDuration("nonsense")).toBe(THIRTY_D);
    expect(parseDuration("")).toBe(THIRTY_D);
  });
});

describe("evaluate — Flair #502: brand-new memory must not be archived", () => {
  test("a freshly-created, never-retrieved memory is NOT an archive candidate", () => {
    // The exact repro: persistent memory written minutes ago, never read.
    const record = {
      id: "krais-1750000000000",
      agentId: "krais",
      durability: "persistent",
      content: "a brand-new insight",
      createdAt: ago(2 * 60_000), // 2 minutes ago
      lastRetrieved: null,
      retrievalCount: 0,
    };
    const c = evaluate(record, NOW, THIRTY_D);
    expect(c.suggestion).toBe("keep");
    expect(c.suggestion).not.toBe("archive");
  });

  test("the reason for a new memory never says 'Infinity days'", () => {
    const record = {
      id: "krais-x",
      agentId: "krais",
      durability: "persistent",
      createdAt: ago(5 * 60_000),
      lastRetrieved: null,
      retrievalCount: 0,
    };
    const c = evaluate(record, NOW, THIRTY_D);
    expect(c.reason).not.toContain("Infinity");
  });

  test("a never-retrieved memory just under the grace window is kept", () => {
    const record = {
      id: "krais-y",
      agentId: "krais",
      durability: "persistent",
      createdAt: ago(THIRTY_D - DAY), // 29 days old — still in grace
      lastRetrieved: null,
      retrievalCount: 0,
    };
    expect(evaluate(record, NOW, THIRTY_D).suggestion).toBe("keep");
  });

  test("a standard never-retrieved memory inside grace is kept (count=0)", () => {
    const record = {
      id: "krais-z",
      agentId: "krais",
      durability: "standard",
      createdAt: ago(3 * DAY),
      lastRetrieved: null,
      retrievalCount: 0,
    };
    const c = evaluate(record, NOW, THIRTY_D);
    expect(c.suggestion).toBe("keep");
    expect(c.reason).not.toContain("Infinity");
  });
});

describe("evaluate — legitimately-old memories still archive (no regression)", () => {
  test("never-retrieved memory older than the grace window IS archived", () => {
    const record = {
      id: "old-1",
      agentId: "krais",
      durability: "persistent",
      createdAt: ago(90 * DAY),
      lastRetrieved: null,
      retrievalCount: 0,
    };
    const c = evaluate(record, NOW, THIRTY_D);
    expect(c.suggestion).toBe("archive");
    expect(c.reason).toContain("Never retrieved");
    expect(c.reason).not.toContain("Infinity");
  });

  test("memory last retrieved >60 days ago with few retrievals IS archived", () => {
    const record = {
      id: "old-2",
      agentId: "krais",
      durability: "persistent",
      createdAt: ago(100 * DAY),
      lastRetrieved: ago(70 * DAY),
      retrievalCount: 1,
    };
    const c = evaluate(record, NOW, THIRTY_D);
    expect(c.suggestion).toBe("archive");
    expect(c.reason).toContain("70 days");
  });
});

describe("evaluate — promotion paths preserved", () => {
  test("persistent memory retrieved >=5 times is a promote candidate", () => {
    const record = {
      id: "hot-1",
      agentId: "krais",
      durability: "persistent",
      createdAt: ago(40 * DAY),
      lastRetrieved: ago(DAY),
      retrievalCount: 7,
    };
    expect(evaluate(record, NOW, THIRTY_D).suggestion).toBe("promote");
  });

  test("standard memory retrieved >=3 times over >7d is a promote candidate", () => {
    const record = {
      id: "hot-2",
      agentId: "krais",
      durability: "standard",
      createdAt: ago(10 * DAY),
      lastRetrieved: ago(DAY),
      retrievalCount: 3,
    };
    expect(evaluate(record, NOW, THIRTY_D).suggestion).toBe("promote");
  });
});
