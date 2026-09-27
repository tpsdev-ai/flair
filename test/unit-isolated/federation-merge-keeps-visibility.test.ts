/**
 * Federation's record-level merge preserves the local visibility unless the
 * incoming record explicitly sets one. Isolated: owns the harper mock for Federation.ts.
 */
import { describe, expect, test, mock } from "bun:test";

mock.module("harper", () => ({
  databases: { flair: {} },
  Resource: class {},
  server: { http: () => {}, getUser: async () => null },
  logger: { warn: () => {}, info: () => {}, error: () => {} },
}));

const { mergeRecord, payloadIdMismatch } = await import("../../resources/Federation.ts");
import { readFileSync } from "node:fs";

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

describe("the sync loop applies a record only when its payload id is the envelope id", () => {
  test("payloadIdMismatch detects a payload naming a different row", () => {
    expect(payloadIdMismatch({ id: "m1", data: { id: "m2" } })).toBe(true);
    expect(payloadIdMismatch({ id: "m1", data: { id: "m1" } })).toBe(false);
    expect(payloadIdMismatch({ id: "m1", data: { content: "no id" } })).toBe(false);
  });

  test("the sync loop checks it before reading or writing the row", () => {
    const src = readFileSync(new URL("../../resources/Federation.ts", import.meta.url), "utf8");
    const check = src.indexOf("if (payloadIdMismatch(record))");
    const read = src.indexOf("await table.get(record.id)");
    expect(check).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(check);
  });
});
