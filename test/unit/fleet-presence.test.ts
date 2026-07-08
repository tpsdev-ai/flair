/**
 * fleet-presence.test.ts — Unit tests for the pure fleet-version staleness
 * classification behind `flair doctor`'s "Fleet presence" section (flair#639).
 *
 * No Harper, no network — newestVersionSeen()/markStale()/sortOldestVersionFirst()
 * are pure functions over an already-fetched /Presence roster shape.
 */

import { describe, test, expect } from "bun:test";
import {
  newestVersionSeen,
  markStale,
  sortOldestVersionFirst,
  type FleetPresenceRow,
} from "../../src/fleet-presence.ts";

function row(id: string, flairVersion: string | null | undefined, lastHeartbeatAt = 1_700_000_000_000): FleetPresenceRow {
  return { id, flairVersion, lastHeartbeatAt };
}

describe("newestVersionSeen", () => {
  test("single instance with a version → that version is newest", () => {
    expect(newestVersionSeen([row("a", "0.20.0")])).toBe("0.20.0");
  });

  test("single instance with NO version → null (nothing to compare)", () => {
    expect(newestVersionSeen([row("a", null)])).toBeNull();
  });

  test("empty roster → null", () => {
    expect(newestVersionSeen([])).toBeNull();
  });

  test("all instances report the SAME version → that version is newest", () => {
    const rows = [row("a", "0.21.0"), row("b", "0.21.0"), row("c", "0.21.0")];
    expect(newestVersionSeen(rows)).toBe("0.21.0");
  });

  test("mixed versions → the highest wins regardless of roster order", () => {
    const rows = [row("a", "0.19.0"), row("b", "0.21.0"), row("c", "0.20.5")];
    expect(newestVersionSeen(rows)).toBe("0.21.0");
  });

  test("versionless entries are excluded from the computation", () => {
    const rows = [row("a", null), row("b", "0.18.0"), row("c", undefined)];
    expect(newestVersionSeen(rows)).toBe("0.18.0");
  });

  test("all versionless → null", () => {
    const rows = [row("a", null), row("b", undefined)];
    expect(newestVersionSeen(rows)).toBeNull();
  });

  test("unparseable version strings are treated as absent", () => {
    const rows = [row("a", "not-a-version"), row("b", "0.5.0")];
    expect(newestVersionSeen(rows)).toBe("0.5.0");
  });

  test("major version differences resolved correctly", () => {
    const rows = [row("a", "0.99.0"), row("b", "1.0.0")];
    expect(newestVersionSeen(rows)).toBe("1.0.0");
  });

  test("pre-release/build suffixes ignored (numeric core only, per semverGte)", () => {
    const rows = [row("a", "0.21.0-beta.1"), row("b", "0.21.0")];
    // Equal numeric cores — either is an acceptable "newest"; must not throw
    // and must resolve to the shared 0.21.0 core.
    const newest = newestVersionSeen(rows);
    expect(newest === "0.21.0-beta.1" || newest === "0.21.0").toBe(true);
  });
});

describe("markStale", () => {
  test("single instance with a version → not stale", () => {
    const [a] = markStale([row("a", "0.20.0")]);
    expect(a.stale).toBe(false);
    expect(a.newestVersion).toBe("0.20.0");
  });

  test("single instance with NO version → not stale (nothing to compare against)", () => {
    const [a] = markStale([row("a", null)]);
    expect(a.stale).toBe(false);
    expect(a.newestVersion).toBeNull();
  });

  test("all instances on the identical version → none flagged stale", () => {
    const rows = markStale([row("a", "0.21.0"), row("b", "0.21.0"), row("c", "0.21.0")]);
    for (const r of rows) expect(r.stale).toBe(false);
  });

  test("mixed versions → older ones stale, the newest is not", () => {
    const [a, b, c] = markStale([row("a", "0.19.0"), row("b", "0.21.0"), row("c", "0.20.0")]);
    expect(a.stale).toBe(true);
    expect(b.stale).toBe(false);
    expect(c.stale).toBe(true);
    expect(a.newestVersion).toBe("0.21.0");
  });

  test("a versionless row is stale whenever ANY other row reports a version", () => {
    const [a, b] = markStale([row("a", null), row("b", "0.10.0")]);
    expect(a.stale).toBe(true); // no version at all — loudest skew signal
    expect(b.stale).toBe(false);
  });

  test("all rows versionless → none stale (no fleet-relative signal exists yet)", () => {
    const rows = markStale([row("a", null), row("b", undefined)]);
    for (const r of rows) expect(r.stale).toBe(false);
  });

  test("every row carries the same newestVersion value", () => {
    const rows = markStale([row("a", "0.18.0"), row("b", "0.21.0"), row("c", null)]);
    expect(rows.every((r) => r.newestVersion === "0.21.0")).toBe(true);
  });

  test("unparseable version is treated the same as absent (stale, like versionless)", () => {
    const [a, b] = markStale([row("a", "garbage"), row("b", "0.5.0")]);
    expect(a.stale).toBe(true);
    expect(b.stale).toBe(false);
  });

  test("does not mutate the input rows", () => {
    const input = [row("a", "0.1.0"), row("b", "0.2.0")];
    const snapshot = JSON.parse(JSON.stringify(input));
    markStale(input);
    expect(input).toEqual(snapshot);
  });
});

describe("sortOldestVersionFirst", () => {
  test("ascending version order", () => {
    const rows = [row("c", "0.20.0"), row("a", "0.5.0"), row("b", "0.10.0")];
    const sorted = sortOldestVersionFirst(rows).map((r) => r.id);
    expect(sorted).toEqual(["a", "b", "c"]);
  });

  test("versionless rows sort FIRST — biggest unknown, not a middling one", () => {
    const rows = [row("a", "0.5.0"), row("b", null), row("c", "0.1.0")];
    const sorted = sortOldestVersionFirst(rows).map((r) => r.id);
    expect(sorted[0]).toBe("b");
  });

  test("multiple versionless rows all sort ahead of every versioned row", () => {
    const rows = [row("a", "0.5.0"), row("b", null), row("c", undefined), row("d", "0.1.0")];
    const sorted = sortOldestVersionFirst(rows).map((r) => r.id);
    expect(sorted.slice(0, 2).sort()).toEqual(["b", "c"]);
    expect(sorted.slice(2)).toEqual(["d", "a"]);
  });

  test("single-instance roster is trivially sorted", () => {
    const rows = [row("solo", "0.9.9")];
    expect(sortOldestVersionFirst(rows).map((r) => r.id)).toEqual(["solo"]);
  });

  test("does not mutate the input array", () => {
    const input = [row("b", "0.2.0"), row("a", "0.1.0")];
    const result = sortOldestVersionFirst(input);
    expect(input.map((r) => r.id)).toEqual(["b", "a"]); // original order preserved
    expect(result.map((r) => r.id)).toEqual(["a", "b"]);
  });

  test("composes with markStale: problems top the list", () => {
    const rows = markStale([row("newest", "0.21.0"), row("oldest", "0.1.0"), row("mid", "0.10.0")]);
    const sorted = sortOldestVersionFirst(rows);
    expect(sorted.map((r) => r.id)).toEqual(["oldest", "mid", "newest"]);
    expect(sorted[0].stale).toBe(true);
    expect(sorted[sorted.length - 1].stale).toBe(false);
  });
});
