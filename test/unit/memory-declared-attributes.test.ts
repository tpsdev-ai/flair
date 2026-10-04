/**
 * memory-declared-attributes.test.ts — flair#1940 slice 1 (A1' item 1).
 *
 * The "declared attributes only" guard, plus a drift tripwire proving the
 * whitelist matches the Memory schema exactly. The reason the guard exists is
 * pinned by the probe at test/repro/harper-undeclared-attr-probe.ts: against
 * the pinned harper, an attribute the Memory schema does NOT declare
 * (`undeclaredProbe`) was inserted via the ops-API and READ BACK unchanged —
 * Harper stores undeclared attributes, so removing a field from the schema does
 * not stop a raw writer. The whitelist applied on the way in is the stop.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DECLARED_MEMORY_ATTRIBUTES,
  SERVER_STAMPED_MEMORY_FIELDS,
  isDeclaredMemoryAttribute,
  stripUndeclaredMemoryAttributes,
} from "../../resources/memory-declared-attributes.ts";

/** Parse the declared field names out of `type Memory` in the schema. */
function schemaMemoryFields(): string[] {
  const schema = readFileSync(join(import.meta.dir, "../../schemas/memory.graphql"), "utf8");
  const lines = schema.split("\n");
  const start = lines.findIndex((l) => /^type Memory @table/.test(l));
  expect(start).toBeGreaterThan(-1); // assertion: the Memory type is present
  const fields: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\}/.test(line)) break;
    const m = /^  ([A-Za-z_][A-Za-z0-9_]*):/.exec(line);
    if (m) fields.push(m[1]);
  }
  return fields;
}

describe("A1' — declared attributes only", () => {
  test("the whitelist EXACTLY matches the Memory schema's declared fields (drift tripwire)", () => {
    const schema = schemaMemoryFields();
    expect(schema.length).toBeGreaterThan(20); // assertion: a real parse
    expect(schema as string[]).toEqual([...DECLARED_MEMORY_ATTRIBUTES]); // assertion: no drift
  });

  test("stripUndeclaredMemoryAttributes drops an undeclared attribute, keeps declared ones", () => {
    const body: Record<string, unknown> = {
      id: "m1",
      agentId: "agent-a",
      content: "x",
      hostSource: { v: 1 },
      hostSourceScope: "record",
      undeclaredProbe: "SENTINEL",
      meta: { seq: 1, hook: "Stop" },
    };
    const removed = stripUndeclaredMemoryAttributes(body);
    expect(removed.sort()).toEqual(["hostSource", "hostSourceScope", "undeclaredProbe"]); // assertion: all undeclared removed
    expect(body.id).toBe("m1"); // assertion: declared kept
    expect(body.content).toBe("x"); // assertion: declared kept
    expect("hostSource" in body).toBe(false); // assertion: the pointer input is gone
    expect((body.meta as any).seq).toBe(1); // assertion: the pre-existing UNDECLARED_ALLOWED `meta` survives (flair#1257)
  });

  test("isDeclaredMemoryAttribute knows the boundary; a non-object body is untouched", () => {
    expect(isDeclaredMemoryAttribute("content")).toBe(true); // assertion
    expect(isDeclaredMemoryAttribute("hostSource")).toBe(false); // assertion
    expect(stripUndeclaredMemoryAttributes(null)).toEqual([]); // assertion: no throw
    expect(stripUndeclaredMemoryAttributes("nope")).toEqual([]); // assertion: no throw
  });
});


test("the server-stamped Memory field list includes skillSubjectId", () => {
  expect([...SERVER_STAMPED_MEMORY_FIELDS]).toEqual(["instanceToken", "provenance", "skillSubjectId"]);
});
