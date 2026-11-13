// flair#2997 — the server-built-row pre-validation classifies its failures:
// a refused row is a server error, and a table handle with no validator is a
// DISTINCT error (the entry point disappeared — a Harper change), never a
// silent pass.
import { expect, test } from "bun:test";
import {
  ServerRowValidationError,
  ServerRowValidatorMissingError,
  validateServerRow,
} from "../../resources/server-row-validation.ts";

test("a table handle with no validator fails closed with the distinct missing-validator error", () => {
  const table = { name: "Widget", async put() {} };
  let thrown: unknown;
  try {
    validateServerRow(table, { id: "w1" });
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(ServerRowValidatorMissingError);
  expect(thrown).not.toBeInstanceOf(ServerRowValidationError);
  expect((thrown as Error).name).toBe("ServerRowValidatorMissingError");
  expect((thrown as Error).message).toContain("Widget");
});

test("a validator that refuses the row raises the invalid-row error with the cause", () => {
  const cause = new Error("field 'count' must be Int");
  const table = {
    name: "Widget",
    validate(record: Record<string, unknown>) {
      if (typeof record.count !== "number") throw cause;
    },
  };
  let thrown: unknown;
  try {
    validateServerRow(table, { id: "w1", count: "not-an-int" });
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(ServerRowValidationError);
  expect((thrown as ServerRowValidationError).cause).toBe(cause);
});

test("a prototype validator runs with the record and the commit's patch flag", () => {
  const calls: Array<{ record: Record<string, unknown>; patch: boolean }> = [];
  class WidgetTable {
    validate(record: Record<string, unknown>, patch: boolean) {
      calls.push({ record, patch });
    }
  }
  const record = { id: "w1" };
  validateServerRow(WidgetTable, record);
  expect(calls).toEqual([{ record, patch: false }]);
});

test("the prototype validator is preferred over a static one, as Harper's table instance resolves it", () => {
  const seen: string[] = [];
  class WidgetTable {
    static validate() { seen.push("static"); }
    validate() { seen.push("prototype"); }
  }
  validateServerRow(WidgetTable, { id: "w1" });
  expect(seen).toEqual(["prototype"]);
});
