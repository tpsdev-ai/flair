import { describe, expect, test } from "bun:test";
import { jsonSchemaToZodShape } from "../src/json-schema-zod.ts";

describe("jsonSchemaToZodShape", () => {
  test("required string + optional coerced number", () => {
    const shape = jsonSchemaToZodShape({
      type: "object",
      properties: {
        query: { type: "string", description: "q" },
        limit: { type: "number", description: "n" },
      },
      required: ["query"],
    });
    expect(shape.query.parse("hi")).toBe("hi");
    expect(shape.limit.parse("5")).toBe(5);
    expect(shape.limit.parse(undefined)).toBeUndefined();
  });

  test("enum + string array", () => {
    const shape = jsonSchemaToZodShape({
      type: "object",
      properties: {
        type: { type: "string", enum: ["session", "fact"] },
        tags: { type: "array", items: { type: "string" } },
      },
    });
    expect(shape.type.parse("session")).toBe("session");
    expect(shape.tags.parse(["a", "b"])).toEqual(["a", "b"]);
  });
});
