// record-owner-guard-coverage.test.ts — the test that protects the next person.
//
// The record-ownership rule lives in ONE place (resources/record-owner-guard.ts,
// applied by resources/auth-middleware.ts), driven by a static OWNER_FIELDS map.
// A static map rots: someone adds a table with an `agentId` column six months
// from now, never hears about any of this, and their resource is unprotected on
// every verb its put() does not implement.
//
// So scope is not a list anyone maintains — it is DERIVED from
// `schemas/*.graphql`. Any table declaring an owner-shaped column is in scope
// automatically, and this test fails when such a table is neither guarded nor
// exempted with a stated reason. Adding the column is what enrols you.
//
// This is the guard equivalent of enumerating CLI options to catch collisions:
// the value is not in checking today's list, it is in the list checking itself
// from now on.
import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  OWNER_FIELDS,
  OWNER_GUARD_EXEMPT,
  MUTATING_METHODS,
  isForbiddenOwnerMutation,
  isMutatingMethod,
  resolveGuardedRecord,
} from "../../resources/record-owner-guard.js";

const SCHEMA_DIR = join(import.meta.dir, "..", "..", "schemas");
const RESOURCES_DIR = join(import.meta.dir, "..", "..", "resources");

/**
 * Columns that name the principal a row belongs to. Deliberately a SHAPE, not a
 * list of known tables — a new table using one of these conventional names is
 * caught without anyone updating this file.
 */
const OWNER_COLUMN_NAMES = ["agentId", "authorId", "ownerId", "principalId"];

/** Parse `type X @table(...) { ... }` blocks out of the GraphQL schemas. */
function tablesWithOwnerColumn(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".graphql"))) {
    const src = readFileSync(join(SCHEMA_DIR, file), "utf8");
    const blocks = src.matchAll(/type\s+(\w+)\s+@table\b[^{]*\{([\s\S]*?)\n\}/g);
    for (const [, table, body] of blocks) {
      const cols = OWNER_COLUMN_NAMES.filter((c) => new RegExp(`^\\s*${c}\\s*:`, "m").test(body));
      if (cols.length > 0) found.set(table, cols);
    }
  }
  return found;
}

describe("every owner-scoped table is covered by the shared guard", () => {
  it("the schema parse finds tables — a silent zero would make this whole file vacuous", () => {
    const tables = tablesWithOwnerColumn();
    // Positive control for the PARSER. If the regex breaks, every assertion
    // below passes trivially and the guard could be gutted unnoticed.
    expect(tables.size).toBeGreaterThan(5);
    // Two we know declare one, spelled differently, in different files.
    expect(tables.has("Memory")).toBe(true);
    expect(tables.get("OrgEvent")).toContain("authorId");
  });

  it("no table declares an owner column without being guarded or explicitly exempted", () => {
    const tables = tablesWithOwnerColumn();
    const unaccounted: string[] = [];
    for (const table of tables.keys()) {
      if (table in OWNER_FIELDS) continue;
      if (table in OWNER_GUARD_EXEMPT) continue;
      unaccounted.push(table);
    }
    expect(
      unaccounted,
      `These tables declare an owner column but are neither in OWNER_FIELDS nor OWNER_GUARD_EXEMPT: ` +
      `${unaccounted.join(", ")}. Add the table to OWNER_FIELDS in resources/record-owner-guard.ts ` +
      `so a non-owner cannot mutate its rows, or add it to OWNER_GUARD_EXEMPT with the reason.`,
    ).toEqual([]);
  });

  it("every guarded table names a column the schema actually declares", () => {
    // The other direction: a typo'd owner field silently guards nothing, because
    // `record[ownerField]` would be undefined and the check would pass.
    const tables = tablesWithOwnerColumn();
    for (const [table, ownerField] of Object.entries(OWNER_FIELDS)) {
      const declared = tables.get(table);
      expect(declared, `OWNER_FIELDS names table ${table}, which declares no owner column`).toBeDefined();
      expect(declared, `OWNER_FIELDS maps ${table} to "${ownerField}", not declared in the schema`)
        .toContain(ownerField);
    }
  });

  it("every exemption carries a reason", () => {
    for (const [table, reason] of Object.entries(OWNER_GUARD_EXEMPT)) {
      expect(typeof reason === "string" && reason.trim().length > 20,
        `exemption for ${table} needs a real stated reason, got: ${JSON.stringify(reason)}`).toBe(true);
    }
  });

  it("a table is never both guarded and exempt", () => {
    const both = Object.keys(OWNER_FIELDS).filter((t) => t in OWNER_GUARD_EXEMPT);
    expect(both, `listed in both OWNER_FIELDS and OWNER_GUARD_EXEMPT: ${both.join(", ")}`).toEqual([]);
  });
});

describe("resources whose rule is STRICTER than ownership still cover every verb", () => {
  // The shared guard permits an agent to modify a row it owns. A resource whose
  // invariant is stricter than that — an append-only ledger, say — cannot rely
  // on the guard alone and must implement the verb itself. This catches the
  // specific regression of such a resource growing a put() rule without patch().
  const STRICTER_THAN_OWNERSHIP = ["MemoryUsage"];

  for (const name of STRICTER_THAN_OWNERSHIP) {
    it(`${name} implements patch() as well as put()`, () => {
      const src = readFileSync(join(RESOURCES_DIR, `${name}.ts`), "utf8");
      expect(/\basync\s+put\s*\(/.test(src), `${name} has no put() — update this list`).toBe(true);
      expect(
        /\basync\s+patch\s*\(/.test(src),
        `${name}'s rule is stricter than ownership, so the shared guard does not cover it. ` +
        `It implements put() but not patch(), and Harper routes PATCH to patch() only — ` +
        `so the rule is unenforced on PATCH.`,
      ).toBe(true);
    });
  }
});

describe("resolveGuardedRecord", () => {
  it("matches a single-record route and resolves its owner field", () => {
    expect(resolveGuardedRecord("/Credential/cred-1"))
      .toEqual({ table: "Credential", ownerField: "principalId", id: "cred-1" });
    expect(resolveGuardedRecord("/MemoryGrant/g1"))
      .toEqual({ table: "MemoryGrant", ownerField: "ownerId", id: "g1" });
  });

  it("does NOT match a collection route — creation is deliberately untouched", () => {
    expect(resolveGuardedRecord("/Credential")).toBeNull();
    expect(resolveGuardedRecord("/Presence")).toBeNull();
  });

  it("matches the table segment EXACTLY, so a sibling route is never mistaken for it", () => {
    // `/SoulFeed/x`.startsWith("/Soul") is true — the trap the old guards used.
    expect(resolveGuardedRecord("/SoulFeed/x")).toBeNull();
    expect(resolveGuardedRecord("/MemoryFeed/x")).toBeNull();
    expect(resolveGuardedRecord("/AgentCard/x")).toBeNull();
  });

  it("decodes a percent-encoded id (Soul ids embed a colon)", () => {
    expect(resolveGuardedRecord("/Soul/alice%3Amission"))
      .toEqual({ table: "Soul", ownerField: "agentId", id: "alice:mission" });
  });

  it("returns null for unguarded tables and malformed paths", () => {
    expect(resolveGuardedRecord("/NotATable/x")).toBeNull();
    expect(resolveGuardedRecord("/")).toBeNull();
    expect(resolveGuardedRecord("")).toBeNull();
    expect(resolveGuardedRecord("/Soul/%E0%A4%A")).toBeNull(); // bad encoding
  });
});

describe("isForbiddenOwnerMutation", () => {
  it("refuses a caller who is not the stored owner", () => {
    expect(isForbiddenOwnerMutation({ agentId: "alice" }, "agentId", "bob")).toBe(true);
  });

  it("permits the owner", () => {
    expect(isForbiddenOwnerMutation({ agentId: "alice" }, "agentId", "alice")).toBe(false);
  });

  it("permits when there is no record — creation is not this rule's business", () => {
    expect(isForbiddenOwnerMutation(null, "agentId", "bob")).toBe(false);
    expect(isForbiddenOwnerMutation(undefined, "agentId", "bob")).toBe(false);
  });

  it("permits a row with no owner value — there is nothing to own", () => {
    expect(isForbiddenOwnerMutation({}, "agentId", "bob")).toBe(false);
    expect(isForbiddenOwnerMutation({ agentId: null }, "agentId", "bob")).toBe(false);
    expect(isForbiddenOwnerMutation({ agentId: "" }, "agentId", "bob")).toBe(false);
  });

  it("refuses an unidentified caller against an owned row", () => {
    // A verified-but-unresolved caller must not inherit someone's record.
    expect(isForbiddenOwnerMutation({ agentId: "alice" }, "agentId", null)).toBe(true);
    expect(isForbiddenOwnerMutation({ agentId: "alice" }, "agentId", undefined)).toBe(true);
  });

  it("reads the field it was told to, not a hardcoded one", () => {
    expect(isForbiddenOwnerMutation({ ownerId: "alice", agentId: "bob" }, "ownerId", "bob")).toBe(true);
    expect(isForbiddenOwnerMutation({ ownerId: "alice", agentId: "bob" }, "ownerId", "alice")).toBe(false);
  });
});

describe("mutating-verb coverage", () => {
  it("covers every verb that can change a stored record", () => {
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) expect(isMutatingMethod(m)).toBe(true);
    for (const m of ["GET", "HEAD", "OPTIONS"]) expect(isMutatingMethod(m)).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isMutatingMethod("patch")).toBe(true);
  });

  it("includes PATCH — the verb the whole class of bugs was hiding behind", () => {
    expect(MUTATING_METHODS).toContain("PATCH");
    expect(MUTATING_METHODS).toContain("DELETE");
  });
});
