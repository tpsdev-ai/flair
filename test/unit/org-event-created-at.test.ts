/**
 * org-event-created-at.test.ts — the pure createdAt decision behind the
 * OrgEvent createdAt check (resources/org-event-created-at.ts): with no stored
 * row the server assigns createdAt; with one, the stored value is
 * authoritative whatever it is (an empty string included); and the ids the
 * check reads.
 *
 * The resource wiring (which verbs call it, for which callers, and which row
 * they read) is covered in test/unit/coordination-write-auth.test.ts and, over
 * real HTTP, in test/integration/orgevent-created-at-server-time.test.ts.
 */
import { describe, expect, it } from "bun:test";
import {
  applyServerCreatedAt,
  collectionElementIdRefusal,
  CREATED_AT_IMMUTABLE_ERROR,
  INVALID_EVENT_ID_ERROR,
  invalidEventId,
  isReadableEventId,
  unreadableEventIdRefusal,
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

});

describe("applyServerCreatedAt — a stored row's createdAt is authoritative whatever its value", () => {
  for (const [label, storedAt] of [["an empty", ""], ["an absent", undefined]] as const) {
    for (const mode of ["replace", "merge"] as const) {
      it(`${mode}: a body naming a createdAt for a stored row with ${label} createdAt is refused with 409`, async () => {
        const content: Record<string, unknown> = { id: "e1", createdAt: NOW.toISOString() };
        const res = applyServerCreatedAt(content, { ...stored(), createdAt: storedAt }, mode, NOW);
        expect(res?.status).toBe(409);
        expect((await refusalBody(res!)).error).toBe(CREATED_AT_IMMUTABLE_ERROR);
      });
    }

    it(`replace: a body without createdAt keeps ${label} stored createdAt`, () => {
      const content: Record<string, unknown> = { id: "e1", summary: "new" };
      expect(applyServerCreatedAt(content, { ...stored(), createdAt: storedAt }, "replace", NOW)).toBeNull();
      expect(content.createdAt).toBe(storedAt);
    });
  }

  it("a body restating an empty stored createdAt is accepted unchanged", () => {
    const content: Record<string, unknown> = { id: "e1", createdAt: "" };
    expect(applyServerCreatedAt(content, { ...stored(), createdAt: "" }, "replace", NOW)).toBeNull();
    expect(content.createdAt).toBe("");
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
  it("accepts a non-empty string id and a non-empty array of strings (composite key)", () => {
    expect(isReadableEventId("e1")).toBe(true);
    expect(isReadableEventId(["x", "y"])).toBe(true);
    expect(isReadableEventId(["x", ""])).toBe(true);
  });

  it("declines every other shape, the empty string included", () => {
    for (const id of [undefined, null, "", 42, true, {}, { a: 1 }, [], ["x", 1]]) {
      expect(isReadableEventId(id)).toBe(false);
    }
  });
});

describe("invalidEventId", () => {
  it("is a named 400 that echoes nothing", async () => {
    const res = invalidEventId();
    expect(res.status).toBe(400);
    const body = JSON.parse(await res.text());
    expect(body.error).toBe(INVALID_EVENT_ID_ERROR);
    expect(Object.keys(body).sort()).toEqual(["error", "message"]);
  });
});

describe("unreadableEventIdRefusal", () => {
  it("reads a non-empty string id and a non-empty array of strings, and refuses every other shape", async () => {
    for (const id of ["e1", ["x", "y"], ["x", ""]] as unknown[]) {
      expect(unreadableEventIdRefusal(id), `refused ${JSON.stringify(id)}`).toBeNull();
    }
    for (const id of [undefined, null, "", 0, 42, true, false, {}, { a: 1 }, [], ["x", 1]] as unknown[]) {
      const res = unreadableEventIdRefusal(id);
      expect(res, `admitted ${JSON.stringify(id)}`).toBeInstanceOf(Response);
      expect(res!.status).toBe(400);
      expect((await refusalBody(res!)).error).toBe(INVALID_EVENT_ID_ERROR);
    }
  });

  it("is a named 400 that echoes no submitted value", async () => {
    const res = unreadableEventIdRefusal(["SUBMITTED", 1]);
    expect(res).toBeInstanceOf(Response);
    const text = await res!.text();
    expect(text).not.toContain("SUBMITTED");
    expect(JSON.parse(text).error).toBe(INVALID_EVENT_ID_ERROR);
  });
});

describe("collectionElementIdRefusal — the same rule over a collection PUT array", () => {
  it("refuses the first record element whose id the rule does not read, in array order", async () => {
    const res = collectionElementIdRefusal([{ id: "ok" }, { id: [] }, { id: "later" }]);
    expect(res).toBeInstanceOf(Response);
    expect(res!.status).toBe(400);
    expect((await refusalBody(res!)).error).toBe(INVALID_EVENT_ID_ERROR);
  });

  it("admits an array of records with readable ids, an empty array and a non-array body", () => {
    expect(collectionElementIdRefusal([{ id: "a" }, { id: ["x", "y"] }])).toBeNull();
    expect(collectionElementIdRefusal([])).toBeNull();
    expect(collectionElementIdRefusal({ id: "a" })).toBeNull();
    expect(collectionElementIdRefusal(undefined)).toBeNull();
  });

  it("the scan skips non-record elements", () => {
    expect(collectionElementIdRefusal(["abc"])).toBeNull();
    expect(collectionElementIdRefusal([null])).toBeNull();
    expect(collectionElementIdRefusal([["abc", 1]])).toBeNull();
  });
});
