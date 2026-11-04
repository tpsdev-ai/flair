/**
 * object-body-guard.test.ts — the shared write-body shape check
 * (resources/object-body-guard.ts). Arrays of records are admitted when
 * `allowArrayObjects` is enabled.
 */
import { describe, expect, test } from "bun:test";
import { BODY_MUST_BE_OBJECT_ERROR, bodyMustBeObject, guardObjectBody } from "../../resources/object-body-guard";

/** The refusal's `error` field, read from its JSON body. */
async function errorOf(res: Response): Promise<string> {
  return (JSON.parse(await res.text()) as { error: string }).error;
}

describe("guardObjectBody — a plain object proceeds", () => {
  test("an object body is admitted", async () => {
    expect(guardObjectBody({ id: "e1", kind: "status" })).toBeNull();
    expect(guardObjectBody({}, { allowArrayObjects: true })).toBeNull();
  });
});

describe("guardObjectBody — a body that is not a JSON object is refused with the named 400", () => {
  for (const [label, value] of [
    ["a string", "abc"],
    ["a number", 42],
    ["a boolean", true],
    ["null", null],
    ["undefined", undefined],
    ["an array of primitives", ["abc", 1]],
    ["an array of objects without allowArrayObjects", [{ id: "e1" }]],
  ] as const) {
    test(`${label} is refused with ${BODY_MUST_BE_OBJECT_ERROR}`, async () => {
      const res = guardObjectBody(value);
      expect(res).not.toBeNull();
      expect(res!.status).toBe(400);
      expect(res!.headers.get("Content-Type")).toContain("application/json");
      const body = (await res!.clone().json()) as { error: string; message: string };
      expect(body.error).toBe(BODY_MUST_BE_OBJECT_ERROR);
      expect(typeof body.message).toBe("string");
      // The refusal names the rule and echoes no value from the request.
      expect(Object.keys(body).sort()).toEqual(["error", "message"]);
    });
  }
});

describe("guardObjectBody — arrays of records are admitted when allowArrayObjects is enabled", () => {
  test("an array of objects is admitted with allowArrayObjects", () => {
    expect(guardObjectBody([{ id: "a" }, { id: "b" }], { allowArrayObjects: true })).toBeNull();
  });

  test("an empty array is admitted with allowArrayObjects", () => {
    expect(guardObjectBody([], { allowArrayObjects: true })).toBeNull();
  });

  test("an array holding a non-object element is refused even with allowArrayObjects", () => {
    expect(guardObjectBody([{ id: "a" }, "b"], { allowArrayObjects: true })!.status).toBe(400);
    expect(guardObjectBody([null], { allowArrayObjects: true })!.status).toBe(400);
    expect(guardObjectBody([["nested"]], { allowArrayObjects: true })!.status).toBe(400);
  });
});

describe("bodyMustBeObject — the response shape", () => {
  test("is a 400 whose error field names the rule", async () => {
    const res = bodyMustBeObject();
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe(BODY_MUST_BE_OBJECT_ERROR);
  });
});

describe("bodyMustBeObject — the message follows allowArrayObjects", () => {
  const STRICT = "the write body must be a JSON object";
  const COLLECTION = "the write body must be a JSON object, or an array of them for a collection write";

  test("without the flag it names a single JSON object only", async () => {
    const body = (await bodyMustBeObject().json()) as { error: string; message: string };
    expect(body.error).toBe(BODY_MUST_BE_OBJECT_ERROR);
    expect(body.message).toBe(STRICT);
    expect((await bodyMustBeObject(false).json() as { message: string }).message).toBe(STRICT);
  });

  test("with the flag it admits an array for a collection write", async () => {
    const body = (await bodyMustBeObject(true).json()) as { error: string; message: string };
    expect(body.error).toBe(BODY_MUST_BE_OBJECT_ERROR);
    expect(body.message).toBe(COLLECTION);
  });

  test("guardObjectBody carries the caller's allowArrayObjects into the message", async () => {
    const strict = (await guardObjectBody("abc")!.json()) as { message: string };
    expect(strict.message).toBe(STRICT);
    const collection = (await guardObjectBody([{ id: "a" }, "b"], { allowArrayObjects: true })!.json()) as { message: string };
    expect(collection.message).toBe(COLLECTION);
  });
});
