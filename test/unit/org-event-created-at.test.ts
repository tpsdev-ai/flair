/**
 * org-event-created-at.test.ts — the pure createdAt decision behind every
 * OrgEvent write (resources/org-event-created-at.ts): an OrgEvent's createdAt
 * is assigned by the server on create and cannot be changed.
 *
 * The resource wiring (which verbs call it, for which callers, and which row
 * they read) is covered in test/unit/coordination-write-auth.test.ts and, over
 * real HTTP, in test/integration/orgevent-created-at-server-time.test.ts.
 */
import { describe, expect, it } from "bun:test";
import {
  applyServerCreatedAt,
  CREATED_AT_IMMUTABLE_ERROR,
  isReadableEventId,
} from "../../resources/org-event-created-at";

const NOW = new Date("2026-10-13T12:00:00.000Z");
const STORED_AT = "2026-10-01T09:30:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";
const PAST = "2001-01-01T00:00:00.000Z";

const stored = () => ({ id: "e1", authorId: "a", kind: "status", summary: "s", createdAt: STORED_AT });

async function refusalBody(res: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await res.text());
}

describe("applyServerCreatedAt — create", () => {
  for (const [label, body] of [
    ["a future createdAt", { createdAt: FUTURE }],
    ["a past createdAt", { createdAt: PAST }],
    ["no createdAt", {}],
    ["a non-string createdAt", { createdAt: 12345 }],
  ] as const) {
    for (const mode of ["replace", "merge"] as const) {
      it(`assigns the server time on create (${mode}, body with ${label})`, () => {
        const content: Record<string, unknown> = { id: "e1", ...body };
        expect(applyServerCreatedAt(content, null, mode, NOW)).toBeNull();
        expect(content.createdAt).toBe(NOW.toISOString());
      });
    }
  }

  it("assigns the server time when the stored row carries no createdAt", () => {
    const content: Record<string, unknown> = { id: "e1", createdAt: PAST };
    const row = { ...stored(), createdAt: undefined };
    expect(applyServerCreatedAt(content, row, "replace", NOW)).toBeNull();
    expect(content.createdAt).toBe(NOW.toISOString());
  });
});

describe("applyServerCreatedAt — update", () => {
  it("replace: a body without createdAt keeps the stored value", () => {
    const content: Record<string, unknown> = { id: "e1", summary: "new" };
    expect(applyServerCreatedAt(content, stored(), "replace", NOW)).toBeNull();
    expect(content.createdAt).toBe(STORED_AT);
  });

  it("replace: a body restating the stored createdAt is accepted unchanged", () => {
    const content: Record<string, unknown> = { id: "e1", createdAt: STORED_AT };
    expect(applyServerCreatedAt(content, stored(), "replace", NOW)).toBeNull();
    expect(content.createdAt).toBe(STORED_AT);
  });

  it("merge: a body without createdAt leaves it out, so the stored value stays", () => {
    const content: Record<string, unknown> = { summary: "new" };
    expect(applyServerCreatedAt(content, stored(), "merge", NOW)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(content, "createdAt")).toBe(false);
  });

  for (const mode of ["replace", "merge"] as const) {
    for (const [label, value] of [
      ["a future", FUTURE],
      ["a past", PAST],
      ["a null", null],
      ["an equivalent but differently written", "2026-10-01T09:30:00Z"],
    ] as const) {
      it(`${mode}: refuses ${label} createdAt that differs from the stored one with a named 409 that echoes nothing`, async () => {
        const content: Record<string, unknown> = { id: "e1", createdAt: value };
        const res = applyServerCreatedAt(content, stored(), mode, NOW);
        expect(res).toBeInstanceOf(Response);
        expect(res!.status).toBe(409);
        const text = await res!.clone().text();
        expect(text).not.toContain(STORED_AT);
        if (typeof value === "string") expect(text).not.toContain(value);
        expect((await refusalBody(res!)).error).toBe(CREATED_AT_IMMUTABLE_ERROR);
        // The refused content is not rewritten.
        expect(content.createdAt).toBe(value);
      });
    }
  }
});

describe("isReadableEventId", () => {
  it("accepts a string id and an array of strings (composite key)", () => {
    expect(isReadableEventId("e1")).toBe(true);
    expect(isReadableEventId(["x", "y"])).toBe(true);
  });

  it("rejects every other shape", () => {
    for (const id of [undefined, null, "", 42, true, {}, { a: 1 }, [], ["x", 1]]) {
      expect(isReadableEventId(id)).toBe(false);
    }
  });
});
