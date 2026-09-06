import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { AUTHORITY_FIELDS, guardAuthorityFields } from "../../resources/authority-field-guard";

describe("workflow authority guard", () => {
  test("each verdict field rejects creation, replacement and clearing", async () => {
    for (const field of AUTHORITY_FIELDS.Memory) {
      for (const value of ["forged", null, ""]) {
        expect((await guardAuthorityFields(() => undefined, { [field]: value }, "Memory"))?.status).toBe(403);
        expect((await guardAuthorityFields(() => ({ [field]: "stored" }), { [field]: value }, "Memory"))?.status).toBe(403);
      }
    }
  });
  test("full-row echoes are unchanged; omitted stamps survive replacement writes", async () => {
    const stored = { promotionStatus: "approved", promotedAt: "2026-09-01", promotedBy: "reviewer" };
    const edit: Record<string, unknown> = { content: "edited", durability: "standard", archived: true };
    expect(await guardAuthorityFields(() => stored, edit, "Memory")).toBeNull();
    expect(edit).toMatchObject(stored);
    expect(await guardAuthorityFields(() => stored, { ...stored }, "Memory")).toBeNull();
  });
  test("a failed stored-state read cannot authorize a write", async () => {
    await expect(guardAuthorityFields(() => { throw new Error("unavailable"); }, {}, "Memory")).rejects.toThrow("unavailable");
  });
  test("every registered authority column exists and all write verbs delegate", () => {
    const schema = readFileSync("schemas/memory.graphql", "utf8");
    for (const [table, fields] of Object.entries(AUTHORITY_FIELDS)) {
      const body = schema.match(new RegExp(`type ${table}\\s[^]*?\\{([^]*?)\\n\\}`))?.[1] ?? "";
      for (const field of fields) expect(body).toContain(`${field}:`);
      const source = readFileSync(`resources/${table}.ts`, "utf8");
      for (const verb of ["post", "put", "patch"]) {
        const method = source.match(new RegExp(`async ${verb}\\([^]*?(?=\\n  (?:async |//)|$)`))?.[0] ?? "";
        expect(method).toContain("guardAuthorityFields");
      }
    }
  });
});
