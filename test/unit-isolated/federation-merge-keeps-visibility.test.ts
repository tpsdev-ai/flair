/**
 * Federation's record-level merge: an incoming null or missing visibility never
 * replaces the local value. Isolated: owns the harper mock for Federation.ts.
 */
import { describe, expect, test, mock } from "bun:test";

mock.module("harper", () => ({
  databases: { flair: {} },
  Resource: class {},
  server: { http: () => {}, getUser: async () => null },
  logger: { warn: () => {}, info: () => {}, error: () => {} },
}));

const { mergeRecord } = await import("../../resources/Federation.ts");

const local = { id: "m1", content: "old", visibility: "private", updatedAt: "2026-09-01T00:00:00.000Z" };

describe("mergeRecord preserves stored visibility", () => {
  test("an incoming null visibility does not replace the local value", () => {
    const merged = mergeRecord(local, { data: { id: "m1", content: "new", visibility: null }, updatedAt: "2026-09-02T00:00:00.000Z" } as any);
    expect(merged.content).toBe("new");
    expect(merged.visibility).toBe("private");
  });

  test("an incoming explicit visibility still applies", () => {
    const merged = mergeRecord(local, { data: { id: "m1", content: "new", visibility: "shared" }, updatedAt: "2026-09-02T00:00:00.000Z" } as any);
    expect(merged.visibility).toBe("shared");
  });
});
